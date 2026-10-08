# Payments Test Plan

As of 2026-10-01, updated 2026-10-08. Items marked `[x]` were verified against Stripe test mode on 2026-10-08; those test checkouts came from `stripe trigger checkout.session.completed` with `createCheckout`'s metadata (`userID`/`planID` on the session and payment intent) overridden in, not the hosted Checkout page.

## Scope

Covers the `payments` branch (commit `44711d0`, 4 commits ahead of where it diverged from `master`): admin-created plans, better-auth-backed subscriptions, and one-time Stripe Checkout purchases. Needs `PAYMENTS_ENABLED=true`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (test mode), `REDIS_URL`, and the Stripe CLI (`stripe listen --forward-to localhost:$SERVER_PORT/api/auth/stripe/webhook`). The CLI must be logged into, or given `--api-key` for, the same Stripe account as `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` must be the secret that `stripe listen` prints.

## Admin: plan creation (`POST /payments/plans`)

- [ ] Non-admin user gets rejected (403)
- [ ] Admin creates a `recurring` plan → Stripe product + price created, `plan` row written with matching `stripeProductId`/`stripePriceId`
- [ ] Admin creates a `one_time` plan → same, no `interval` required
- [ ] Duplicate plan `name` is rejected (unique constraint)
- [ ] `annualDiscountPriceId` is created when an annual price is supplied alongside a monthly one
- [ ] Plan appears in `GET /plans` only once `active`

## One-time checkout

- [ ] `POST /payments/checkout` with a `one_time` plan returns a Stripe-hosted Checkout URL
- [ ] Pending checkout is tracked in Redis (`pending-checkout.ts`) before payment
- [ ] Completing payment with test card `4242 4242 4242 4242` → `checkout.session.completed` webhook fires → `purchase` row written, Redis entry cleared
- [ ] `GET /checkout/:sessionId` reflects `open` → `paid` across the flow, scoped to the paying user only
- [ ] A user with no `stripeCustomerId` yet (pre-existing account) still completes checkout via `customer_email`
- [ ] Checkout session expires (`checkout.session.expired`) → Redis entry removed, no purchase row
- [ ] Async payment method (e.g. bank debit) → `checkout.session.async_payment_succeeded`/`async_payment_failed` handled correctly
- [x] If the Redis pending entry is lost before confirmation, the webhook still resolves ownership from session metadata (`resolveOwner` fallback)

## Subscriptions (better-auth stripe plugin)

- [ ] Subscribing to a `recurring` plan via the plugin's checkout endpoint creates a Stripe Checkout session in `mode: subscription`
- [ ] `subscription` table row is created with correct `plan`, `referenceId`, `status`
- [ ] Free trial (`trialDays` on the plan) → `trialStart`/`trialEnd` populated, `status: trialing`
- [ ] Upgrade/downgrade between plans updates the existing `subscription` row rather than creating a new one
- [ ] Cancel at period end vs. cancel immediately — both reflected correctly (`cancelAtPeriodEnd`, `canceledAt`, `endedAt`)
- [ ] `createCustomerOnSignUp: true` — new users get a `stripeCustomerId` on sign-up, before ever checking out

## Webhook edge cases

- [x] `charge.refunded` (full) → `purchase.status` becomes `refunded`, `amountRefunded` set
- [ ] `charge.refunded` (partial) → status stays `paid`, `amountRefunded` reflects the partial amount
- [ ] `charge.dispute.created` → status becomes `disputed`
- [ ] `charge.dispute.closed` with `status: lost` → `refunded`; `won` → back to `paid`
- [ ] A charge with no matching purchase whose payment intent has no `metadata.planID` (e.g. a subscription invoice charge) is ignored, not errored (stub-tested only)
- [x] A refund/dispute for a one-time checkout whose purchase isn't recorded yet → 400 ("Purchase not recorded yet"), so Stripe retries; once `checkout.session.completed` lands, the retried event applies (`be122f5`)
- [ ] Webhook signature verification rejects a request signed with the wrong secret
- [x] Handler errors are rethrown so Stripe retries (check `payments.webhook` error logs, confirm Stripe's retry in the CLI/dashboard)

## Reconciliation (`bun run payments:reconcile [--days 7] [--dry-run]`)

- [x] A paid one-time checkout whose webhook never landed is reported by `--dry-run` without writing anything
- [x] A real run inserts the missing purchase; a second run reports no changes
- [x] Partial refund made without a webhook → run syncs `amountRefunded`, status stays `paid`
- [x] Full refund made without a webhook → run sets `refunded`
- [ ] Dispute state is synced (`lost` → `refunded`, `won` → `paid`, open → `disputed`) (stub-tested only)
- [ ] Subscription, unpaid and foreign sessions (no `metadata.planID`) are skipped (stub-tested only)
- [ ] A failing session is logged and the run continues, exiting 1 (stub-tested only)

## Read endpoints

- [ ] `GET /plans` returns only `active` plans, to any signed-in user
- [ ] `GET /purchases` returns only the caller's own purchases, never another user's
- [ ] `GET /checkout/:sessionId` returns `null`/404-equivalent for a session ID that isn't the caller's
- [ ] `GET /checkout/:sessionId` falls back to the Redis pending entry when no `purchase` row exists yet

## Auth/infra side effects

- [ ] `bun run db:push` completes cleanly (fixed in `bacb2b3`; re-check if `src/db/connection.ts` or `drizzle.config.ts` change again)
- [x] `plan`, `purchase`, and `subscription` tables exist after push
- [ ] Verification flows (password reset, email verification) still work even though the DB `verification` table was dropped from `auth-schema.ts` — they should, since `secondaryStorage` (Redis) handles verification records when `verification.storeInDatabase` isn't set (see the comment added in `61d32b1`), but confirm end-to-end rather than trusting the mechanism alone
- [ ] With `PAYMENTS_ENABLED=false` (the default), the app boots without `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, and neither the payments route nor the stripe plugin is registered; with `PAYMENTS_ENABLED=true`, missing keys fail at boot (`c236e60`)
- [x] `compose.yaml`'s `redis`/`postgres` services start with `REDIS_PORT`/`DB_PORT` set, and the app connects to both

## Open issues

| Issue | Status |
| --- | --- |
| `verification` DB table dropped from `auth-schema.ts` during the Stripe schema regen | Documented (`61d32b1`), not restored — still absent after the 2026-10-08 push; decide |
| No publishable key / Stripe.js needed | Confirmed not needed — backend only uses Stripe-hosted Checkout |
| Payments feature gating behind an env var | Implemented in `c236e60` (`PAYMENTS_ENABLED`) |
| Refund/dispute arriving before its purchase was silently dropped | Fixed in `be122f5` |
| Paid checkout lost when Stripe stops retrying its webhook (~3 days) | Mitigated by `payments:reconcile` (`05b1318`); run it after outages or on a schedule |
| Subscription refunds/disputes aren't tracked | Pending resolution — see below |

### Subscription refunds/disputes aren't tracked

As of 2026-10-08.

`charge.refunded` and `charge.dispute.*` fire for both one-time and subscription invoice charges, but only one-time purchases are tracked:

- One-time charges update the `purchase` row matched by payment intent (`updateByCharge` in `src/features/payments/lib/webhook.ts`). If the row doesn't exist yet, the payment intent's `metadata.planID` (set by `createCheckout`) makes the handler throw so Stripe retries.
- Subscription invoice charges match no `purchase` row, and their payment intents carry no `planID` (the better-auth plugin only sets `userId`/`subscriptionId`/`referenceId` on the subscription and its Checkout Session), so they're ignored with a 200. `payments:reconcile` also skips them (`mode: "payment"` only).
- The plugin only handles `customer.subscription.*` events, and a refund or lost dispute doesn't change the subscription in Stripe.

**Impact:** a refunded subscriber, or one who wins a chargeback, keeps their plan active until it's canceled manually or lapses at period end.

**Options to decide between:**

- Accept it and cancel manually when issuing a subscription refund (fine if refunds are rare).
- Cancel the subscription automatically on a lost dispute (`charge.dispute.closed` with `status: lost` on an invoice charge).
- Record invoice refunds/disputes somewhere (e.g. a table keyed by invoice/payment intent) so access checks can account for them.
