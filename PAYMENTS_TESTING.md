# Payments Test Plan

As of 2026-10-01.

## Scope

Covers the `payments` branch (commit `44711d0`, 4 commits ahead of where it diverged from `master`): admin-created plans, better-auth-backed subscriptions, and one-time Stripe Checkout purchases. Needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (test mode), `REDIS_URL`, and the Stripe CLI (`stripe listen --forward-to localhost:$SERVER_PORT/api/auth/stripe/webhook`).

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
- [ ] If the Redis pending entry is lost before confirmation, the webhook still resolves ownership from session metadata (`resolveOwner` fallback)

## Subscriptions (better-auth stripe plugin)

- [ ] Subscribing to a `recurring` plan via the plugin's checkout endpoint creates a Stripe Checkout session in `mode: subscription`
- [ ] `subscription` table row is created with correct `plan`, `referenceId`, `status`
- [ ] Free trial (`trialDays` on the plan) → `trialStart`/`trialEnd` populated, `status: trialing`
- [ ] Upgrade/downgrade between plans updates the existing `subscription` row rather than creating a new one
- [ ] Cancel at period end vs. cancel immediately — both reflected correctly (`cancelAtPeriodEnd`, `canceledAt`, `endedAt`)
- [ ] `createCustomerOnSignUp: true` — new users get a `stripeCustomerId` on sign-up, before ever checking out

## Webhook edge cases

- [ ] `charge.refunded` (full) → `purchase.status` becomes `refunded`, `amountRefunded` set
- [ ] `charge.refunded` (partial) → status stays `paid`, `amountRefunded` reflects the partial amount
- [ ] `charge.dispute.created` → status becomes `disputed`
- [ ] `charge.dispute.closed` with `status: lost` → `refunded`; `won` → back to `paid`
- [ ] A charge with no matching `payment_intent`/purchase (e.g. a subscription invoice charge) is ignored, not errored
- [ ] Webhook signature verification rejects a request signed with the wrong secret
- [ ] Handler errors are rethrown so Stripe retries (check `payments.webhook` error logs, confirm Stripe's retry in the CLI/dashboard)

## Read endpoints

- [ ] `GET /plans` returns only `active` plans, to any signed-in user
- [ ] `GET /purchases` returns only the caller's own purchases, never another user's
- [ ] `GET /checkout/:sessionId` returns `null`/404-equivalent for a session ID that isn't the caller's
- [ ] `GET /checkout/:sessionId` falls back to the Redis pending entry when no `purchase` row exists yet

## Auth/infra side effects

- [ ] `bun run db:push` completes cleanly (fixed in `bacb2b3`; re-check if `src/db/connection.ts` or `drizzle.config.ts` change again)
- [ ] `plan`, `purchase`, and `subscription` tables exist after push
- [ ] Verification flows (password reset, email verification) still work even though the DB `verification` table was dropped from `auth-schema.ts` — they should, since `secondaryStorage` (Redis) handles verification records when `verification.storeInDatabase` isn't set (see the comment added in `61d32b1`), but confirm end-to-end rather than trusting the mechanism alone
- [ ] App fails to boot without `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set — confirm this is acceptable for all target environments, or revisit gating the feature behind an env var
- [ ] `compose.yaml`'s `redis`/`postgres` services start with `REDIS_PORT`/`DB_PORT` set, and the app connects to both

## Open issues

| Issue | Status |
| --- | --- |
| `verification` DB table dropped from `auth-schema.ts` during the Stripe schema regen | Documented (`61d32b1`), not restored — decide before merge |
| No publishable key / Stripe.js needed | Confirmed not needed — backend only uses Stripe-hosted Checkout |
| Payments feature gating behind an env var | Discussed, not implemented |
