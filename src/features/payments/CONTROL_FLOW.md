# Payments control flow

This documents how `src/features/payments` actually behaves at runtime. See the
[README](../../../README.md#payments) for the endpoint table and the two-plan-type summary.

## Overview: where the two plan types diverge

`plan.type` decides which of two entirely separate systems handles the purchase.
`recurring` is better-auth's own stripe plugin (its own tables, its own webhook
handling); `one_time` is this feature's own Checkout + webhook + `purchase` table.
This doc only covers the `one_time` path in detail.

```mermaid
flowchart TD
    A["Client wants to buy a plan"] --> B{"plan.type?"}
    B -- recurring --> C["better-auth /api/auth/subscription/upgrade\n(subscription table, handled entirely by @better-auth/stripe)"]
    B -- one_time --> D["POST /api/payments/checkout\n(this feature's own flow, detailed below)"]
```

## `POST /checkout`: creating a one-time Checkout Session

`route.ts`'s handler, in the order the checks actually run. The two guards under
`plan.repeatable` close the realistic "two tabs" race (a user opening a second
checkout before the first confirms). The second one is an atomic reservation
(`SET NX` on the `checkout:active:userId:planId` pointer), not a check followed by
a later write, so two concurrent requests can't both get past it and both reach
Stripe. They still can't close every race - see `confirmCheckout`'s own re-check
further down for the narrower one that reaches the webhook anyway.

Ownership is checked twice for a non-repeatable plan: once before reserving,
as a fast path, and again once the reservation is held. The second check closes
a gap the first leaves open - the user's earlier checkout confirming in between,
which inserts the purchase and then frees the slot for this request to reserve.
Because `confirmCheckout` writes the purchase *before* it frees the slot, any
request that reserves a freed slot is guaranteed to see the purchase.

When the slot is held by the same user's still-`open` session, the reservation
fails but the request isn't refused: it gets that session's id and URL back
(`getResumableCheckout`, from the url stored on the pending entry). That's the
common case - a buyer who closed the Stripe tab and clicked buy again - and
without it they'd be locked out until the session expired, up to 24h. It's still
one session per (user, plan), so the guard isn't weakened. A `processing`
session (already paid, settling) or an in-flight reservation (no session yet)
still answers 409, as does a pending entry written before urls were stored.

```mermaid
flowchart TD
    Start(["POST /checkout { planId }"]) --> LookupPlan["paymentsRepo.plan.get(planId)"]
    LookupPlan -->|db error| Err500a["500"]
    LookupPlan --> PlanExists{"plan exists\n&& plan.active?"}
    PlanExists -- no --> NotFound["404 Plan not found"]
    PlanExists -- yes --> IsOneTime{"plan.type === one_time?"}
    IsOneTime -- no --> Unprocessable["422 Plan is not a one-time plan"]
    IsOneTime -- yes --> Repeatable{"plan.repeatable?"}

    Repeatable -- yes --> EnsureCustomer
    Repeatable -- no --> CheckOwned["paymentsRepo.purchase.getBlockingByPlan(userId, planId)\n(paid or disputed - only refunded frees the slot)"]
    CheckOwned -->|db error| Err500b["500"]
    CheckOwned --> AlreadyOwns{"a blocking purchase\nalready exists?"}
    AlreadyOwns -- yes --> Audit1["audit log: checkout_blocked_existing_purchase\n(best-effort)"]
    Audit1 --> Conflict["409 You've already purchased this plan"]
    AlreadyOwns -- no --> Reserve["paymentsRepo.checkout.reserve(userId, planId)\n(atomic SET NX of the Redis pointer to a\nreserving:token placeholder, TTL 5 min;\nclears a stale pointer and retries)"]
    Reserve -->|redis error| Err500e["500"]
    Reserve --> Claimed{"slot claimed?\n(no open/processing checkout\nor other live reservation)"}
    Claimed -- no --> Resumable{"paymentsRepo.checkout.getResumable:\nslot held by this user's own\nopen session (with a stored url)?"}
    Resumable -- yes --> Resume200["200 { sessionId, url } of that session\n(Checkout resumed - no new Stripe session,\nno audit entry)"]
    Resumable -- "no (processing, a live reservation,\nor a pre-url entry)" --> Audit2["audit log: checkout_blocked_pending_checkout\n(best-effort)"]
    Audit2 --> Conflict2["409 You already have a checkout\nin progress for this plan"]
    Claimed -- yes --> Recheck["getBlockingByPlan again, now the slot is held\n(the user's earlier checkout may have confirmed\nbetween the first check and the reservation)"]
    Recheck -- "owned" --> Release409["release the reservation,\naudit log + 409 You've already purchased this plan"]
    Recheck -- "not owned" --> EnsureCustomer

    EnsureCustomer["paymentsRepo.customer.ensure(id, name, email)\n(always re-reads the live user row itself -\nnever trusts a caller-supplied id, which can\nbe a stale cached session - see below)"] -->|stripe/db error| Err500c["500\n(releases the reservation)"]
    EnsureCustomer --> CreateSession

    CreateSession["createCheckout:\nstripe.checkout.sessions.create\n(mode: payment, customer: stripeCustomerId,\nmetadata: userId, planId, durationDays snapshot)"] -->|stripe error| Err500d["500\n(releases the reservation)"]
    CreateSession --> SavePending["savePendingCheckout\n(Redis key checkout:sessionId + a\ncheckout:active:userId:planId pointer,\nreplacing the reservation;\nstatus: open, the session url, TTL 24h)"]
    SavePending -->|redis error| Err500f["500\n(harmless - the Stripe session\nstill expires on its own)"]
    SavePending --> Return200["200 { sessionId, url }"]
    Return200 --> Redirect(["client redirects user to\nthe Stripe-hosted url"])
```

`ensureStripeCustomer` re-reads `user.stripeCustomerId` from Postgres on every
call rather than trusting the session object, since better-auth can serve a
Redis-cached `user` blob without querying Postgres at all. When it does create a
customer, it saves the id through better-auth's `internalAdapter.updateUser`
rather than a raw query, so the user's cached sessions are refreshed too. That
matters beyond this flow: the stripe plugin's subscription upgrade reads
`stripeCustomerId` from the session, and a stale `null` there made it create a
second customer and switch the user over to it. It also passes a
`customer-<userId>` Stripe idempotency key, so a retried call can't create a
second customer (though it doesn't fully dedupe two truly simultaneous requests
- Stripe's idempotency semantics don't strictly guarantee that).

### Adding Stripe params: `lib/checkout-extensions.ts`

`createCheckout` calls `getCheckoutSessionParams({ user, plan })` before
building the Stripe request - an extension point for promo codes
(`discounts`/`allow_promotion_codes`), tax (`automatic_tax`/`tax_id_collection`),
different `line_items`, or most other params
`stripe.checkout.sessions.create` accepts that this app doesn't set itself. A
few conflict with what this flow always sets and make Stripe reject the
session: `customer_email`/`customer_creation` (this flow always passes
`customer`) and `ui_mode: "embedded"` (which takes `return_url`, not
`success_url`/`cancel_url`).
Mirrors `@better-auth/stripe`'s own `subscription.getCheckoutSessionParams`
option for the subscription flow (verified in
`node_modules/@better-auth/stripe/dist/index.mjs`) - same idea, for this
flow. The default implementation returns `undefined` (no-op); an app wanting
any of this edits the function directly, the same "change it here, not
where it's read" convention `access-policy.ts` already established.

What always wins over whatever it returns, by object-literal ordering in
`createCheckout` (the explicit fields are listed after the extension's
params are spread first) - `mode`, `customer`, `client_reference_id`,
`success_url`, `cancel_url`, and `expires_at` (kept in lockstep with
`PENDING_CHECKOUT_TTL_SEC`; letting it drift would open a window where
Stripe still accepts the session but Redis has already forgotten it). The
`userId`/`planId`/`durationDays` keys of `metadata` and
`payment_intent_data.metadata` also always win (merged rather than replaced
wholesale, so an app can still tag a session with its own additional keys
alongside them; the payment intent gets the session's `metadata` plus any
keys set only on `payment_intent_data.metadata`) - `confirmCheckout` and the
reconciler depend on those three to resolve a session back to a purchase at
all. `line_items` is
deliberately **not** protected, unlike the subscription plugin (which has
its own seat/multi-item logic to guard) - a returned `line_items` fully
replaces the `[{ price, quantity: 1 }]` default, e.g. to charge a different
price or add items. It doesn't change what's granted: one completed checkout
is one purchase of the plan with one access window, whatever the quantity. A
"3 months" sale as quantity 3 of a 30-day plan would charge 3x and grant 30
days - use a 90-day plan, or a repeatable plan bought three times.

`GET /checkout/:sessionId` (`getCheckoutStatus`) answers the client's polling: it
reads the `purchase` row if one exists yet (`paid`/`refunded`/`disputed`), otherwise
falls back to the pending Redis entry (`open`/`processing`/`failed`/`expired` - the
last two are short-lived terminal states, see `markFailed`/`markExpired` below),
otherwise `null` → 404. 404 is reserved for a session the user never had at all;
`failed`/`expired` both answer with 200 so a polling client can tell "your payment
failed" apart from "this session never existed."

## Stripe webhook dispatch

Every Stripe event - recurring or one-time - lands on the **same** endpoint,
`/api/auth/stripe/webhook`, owned by `@better-auth/stripe`. It verifies the
signature, handles `customer.subscription.*` internally (writing the
`subscription` table directly), then *always* forwards the raw event to the
`onEvent` hook this app wired up to `handleStripeEvent` in `lib/webhook.ts` -
regardless of event type.

The endpoint is exempt from better-auth's IP rate limiter (`rateLimit.customRules`
in `auth.ts`): it's authenticated by Stripe's signature instead, and the limiter
runs *before* that check - so without the exemption, a burst of real events, or
anyone flooding the path with unsigned requests while client IPs go unresolved
(every caller then shares one bucket), would get Stripe's deliveries 429'd.
With no rate limit, a 1 MB body cap (`bodyLimit` in `src/index.ts`, ahead of
better-auth's handler) is what bounds it instead: better-auth reads and HMACs the
whole body before it can reject a forged signature, so without the cap anyone
could stream arbitrarily large junk at it. Real Stripe events are a few KB.

Its own `checkout.session.completed` handler runs for **every** session mode
except `"setup"` - including one-time (`mode: "payment"`) sessions, not just
subscription ones. For a one-time session it calls `subscriptions.retrieve`
with no subscription id, which throws and is caught and logged internally as
`"Stripe webhook failed"` on every single one-time purchase - noisy, but
harmless, and worth knowing about so it isn't mistaken for a real error during
on-call triage (see "known noise" below).

```mermaid
sequenceDiagram
    participant Stripe
    participant Plugin as better-auth stripe plugin<br/>(/api/auth/stripe/webhook)
    participant Handler as handleStripeEvent<br/>(lib/webhook.ts)

    Stripe->>Plugin: POST event (signed)
    Plugin->>Plugin: verify signature, parse event
    alt event.type is subscription-related
        Plugin->>Plugin: update `subscription` table
    else checkout.session.completed, mode: payment
        Plugin->>Plugin: harmlessly errors internally<br/>(logged, not rethrown)
    end
    Plugin->>Handler: onEvent(event)
    Handler->>Handler: isAllowedEvent(event)?
    alt not one of ALLOWED_EVENTS
        Handler-->>Plugin: return (ignored)
    else checkout.session.* or charge.* (one-time only)
        Handler->>Handler: switch (event.type) - see below
        Handler-->>Plugin: resolves, or throws
    end
    alt Handler threw
        Plugin-->>Stripe: 400 (Stripe retries the event)
    else
        Plugin-->>Stripe: 200 { success: true }
    end
```

`ALLOWED_EVENTS` (`lib/constants.ts`): `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `charge.refunded`, `charge.dispute.created`,
`charge.dispute.closed`. Everything else (including every subscription event) is
a no-op for this feature - the plugin already dealt with it above.

### `handleStripeEvent`'s switch

```mermaid
flowchart TD
    E["event.type"] --> CSC{"checkout.session.completed\n(mode: payment only)"}
    CSC -- payment_status: unpaid --> MarkProcessing["paymentsRepo.checkout.markProcessing(session.id)\nRedis TTL extended to 14 days, pointer too\n(delayed payment methods, e.g. bank debits)"]
    CSC -- otherwise paid --> Confirm["confirmCheckout(session)"]

    E --> APS["async_payment_succeeded\n(mode: payment)"] --> Confirm
    E --> APF["async_payment_failed\n(mode: payment)"] --> MarkFailed["paymentsRepo.checkout.markFailed(session.id)\n(short-lived terminal status,\nfrees the (user, plan) slot right away)"]
    E --> Exp["checkout.session.expired\n(mode: payment)"] --> MarkExpired["paymentsRepo.checkout.markExpired(session.id)\n(same, status: expired)"]

    E --> Ref["charge.refunded"] --> UpdByCharge1["updateByCharge(payment_intent)"]
    E --> DispC["charge.dispute.created"] --> UpdByCharge2["updateByCharge(payment_intent)"]
    E --> DispX["charge.dispute.closed"] --> UpdByCharge2
```

`markProcessing`/`markFailed`/`markExpired` all go through `pending-checkout.ts`'s
`transition`, which only moves a status forward (`open` → `processing` →
`failed`/`expired`, ranked in that order) and never backward - a retried or
out-of-order event for a status the session has already passed (e.g. a redelivered
unpaid `completed` arriving after `async_payment_failed`) is a no-op. `transition`
also never repoints the `checkout:active:userId:planId` pointer away from a newer
session: `markFailed`/`markExpired` clear it only if it still points at this
session, and `markProcessing` extends it to the same 14 days as the entry only if
it still points at this session (or is free). The extension matters: without it
the pointer kept its original 24h TTL, so for days 2-14 of a bank debit the guard
stopped seeing the checkout and a second one could be opened. Both pointer
operations are atomic Lua scripts, so a newer session written between the check
and the write is never lost.

### `confirmCheckout`: turning a paid session into a `purchase` row

Both drop branches below **throw** rather than log-and-return: a silently
swallowed 200 would mean a payment with no trace of ever going wrong (Stripe
never retries, and a later reconciler pass that hits the same drop would
otherwise miscount it as a successful insert - see the reconciler section).

```mermaid
flowchart TD
    Start(["confirmCheckout(session)"]) --> ResolveOwner["resolveOwner:\npaymentsRepo.checkout.getPending(session.id)"]
    ResolveOwner --> HasPending{"pending entry\nfound in Redis?"}
    HasPending -- yes --> Owner["{ userId, planId }"]
    HasPending -- no, or Redis error --> Metadata["fall back to\nsession.metadata\n(set on the session at createCheckout time)"]
    Metadata --> HasMetadata{"metadata has\nuserId + planId?"}
    HasMetadata -- yes --> Owner
    HasMetadata -- no --> HasPlanId{"metadata has\na planId at all?"}
    HasPlanId -- no --> NotOurs["log warning: payments.webhook.not_ours,\nreturn (not a drop - a payment-mode session\nthis app never created, e.g. a Payment Link\nor another integration on the same account)"]
    HasPlanId -- yes, but still unresolvable --> Throw1["throw\n(ours, genuinely broken -\nlogged first: payments.webhook.metadata)"]

    Owner --> FetchPlan["paymentsRepo.plan.get(planId)"]
    FetchPlan --> PlanFound{"plan still exists?"}
    PlanFound -- no --> Throw2["throw\n(logged first: payments.webhook.plan_missing)"]
    PlanFound -- yes --> RepeatCheck{"!plan.repeatable?"}

    RepeatCheck -- no --> AddPurchase
    RepeatCheck -- yes --> Blocking["paymentsRepo.purchase.getBlockingByPlan(\n{ userId, planId },\nexclude: { stripeCheckoutSessionId: session.id })"]
    Blocking --> AlreadyOwns{"a blocking purchase\nfor a DIFFERENT session\nalready exists?"}
    AlreadyOwns -- no --> AddPurchase
    AlreadyOwns -- yes --> LogDup["log error: payments.webhook.duplicate_purchase\n+ audit log: duplicate_purchase_confirmed\n(best-effort; the money's already taken,\nso this still falls through to AddPurchase -\nthe financial record must never be dropped)"]
    LogDup --> AddPurchase

    AddPurchase["paymentsRepo.purchase.add:\npurchasedAt = paidAt: when Stripe recorded\nthe payment as succeeded (not session\ncreation, not insert time)\ndurationDays = session.metadata snapshot\n(plan's current value only for older sessions)\nexpiresAt = durationDays ? purchasedAt + durationDays : null\nINSERT ... ON CONFLICT (stripeCheckoutSessionId) DO NOTHING\n(on a user_id FK violation - the user was deleted\nmid-checkout - retries once with userId: null)"]
    AddPurchase --> RemovePending["paymentsRepo.checkout.removePending(session.id)\n(best-effort; a leftover key just expires via its TTL)"]
```

The `exclude` on `getBlockingByPlan` matters for a Stripe redelivery of the *same*
session: without it, the second delivery would find the purchase row the first
delivery just wrote and wrongly flag it as `duplicate_purchase_confirmed` - the
blocking check only looks for a *different* session's purchase.

`addPurchase` is idempotent on `stripeCheckoutSessionId`, so a retried
`checkout.session.completed` (Stripe's at-least-once delivery) is a no-op the
second time. `createdAt`/`expiresAt` start from `paidAt`, when Stripe recorded the
payment as succeeded - the `created` timestamp of the webhook's own
`checkout.session.completed`/`async_payment_succeeded` event, which is the same
on every redelivery. Not insert time, so a purchase recorded late (a delayed
delivery, or the reconciler) doesn't get bonus days of access; and not the
session's own `created`, so a delayed payment method that took days to settle
doesn't lose them - with that clock, a 7-day plan paid by a bank debit that
settled on day 8 granted no access at all. The reconciler recovers the same
timestamp by listing those two event types (Stripe keeps events for 30 days,
longer than the default 14-day scan); failing that, it uses the charge's own
creation time. For the same reason, `durationDays`
comes from the snapshot `createCheckout` writes into the session's metadata
(`"none"` for a never-expiring plan, since Stripe drops empty metadata values),
not the plan's value when the payment confirms - an admin edit while a bank debit
is settling must not change what that buyer gets. Sessions created before the
snapshot existed fall back to the plan's current value
(`payments.webhook.duration_snapshot_missing`). That value is then stored on the
purchase row, independent of any other purchase of the same plan or any later
edit to the plan itself (see "checking active access" below).

`confirmCheckout` returns whether it actually inserted the row (`false` for a
redelivery, a session that isn't ours, or the reconciler losing a race to the
webhook).

### `updateByCharge`: refunds and disputes

Never trusts a webhook event's own embedded payload for the resulting state -
Stripe doesn't guarantee delivery order, so an out-of-order or retried event's
payload can be stale. Always re-fetches the current charge/dispute from Stripe
instead (`resolveChargeState` in `lib/charge-state.ts`), the same function the
reconciler uses.

Status comes from the charge's refund state (`purchaseUpdateFromCharge`), and a
dispute overrides it only while open (`disputed`) or once lost (`refunded`). A
dispute closed in our favor (`won`, `warning_closed`, `prevented`) defers to the
refund state rather than forcing `paid`: `charge.disputed` stays true forever
once a dispute was opened, so a refund made after a won dispute or a closed
inquiry would otherwise be masked and keep granting access.

The write is a compare-and-set (`syncPurchaseCharge`): the purchase row is read,
the live state fetched, and the update only lands if the row still holds what
was read; otherwise it re-reads and re-fetches (up to 3 attempts, then throws so
the webhook gets a 400 and Stripe redelivers). The reconciler syncs through the
same function. Re-fetching live state isn't enough on its own: two syncs of one
purchase running together (a refund and a dispute event, a retry, the
reconciler) could each fetch, and the one that fetched first could write last -
undoing a refund and handing access back. Not a row lock held across the fetch:
that kept a database connection checked out for as long as Stripe took to
answer, so a burst during a Stripe slowdown could exhaust the pool and stall the
whole app.

```mermaid
flowchart TD
    Start(["updateByCharge(paymentIntent)"]) --> HasId{"payment_intent\npresent on the event?"}
    HasId -- no --> NoOp1["return (nothing to update)"]
    HasId -- yes --> Read["syncPurchaseCharge:\nread the purchase for this intent"]
    Read --> Found{"a purchase row?"}
    Found -- yes --> Resolve["resolveChargeState(paymentIntentId):\nstripe.paymentIntents.retrieve(expand: latest_charge)\n+ stripe.disputes.list if charge.disputed"]
    Resolve --> Write["if it differs: UPDATE ... WHERE the row still\nholds what was read (no charge yet: nothing to write)"]
    Write -- "row changed meanwhile" --> Read
    Found -- no --> Retrieve["stripe.paymentIntents.retrieve(id)\n(plain, no expand - just for metadata)"]
    Retrieve --> OursButMissing{"intent.metadata.planId\nset (one of our checkouts)?"}
    OursButMissing -- yes --> Throw["throw\n(confirmCheckout's insert is still\nin flight/retrying - fail so Stripe\nretries this event too)"]
    OursButMissing -- no --> Ignore["ignore\n(e.g. a subscription invoice charge\nwith no purchase row at all)"]
```

## The reconciler: `lib/reconcile.ts` (`bun run payments:reconcile`)

A backstop for webhooks Stripe gave up retrying. Lists recent one-time Checkout
Sessions directly from Stripe and, per session: inserts a `purchase` row via
`confirmCheckout` if none exists yet, then syncs refund/dispute state via the
same `resolveChargeState` the webhook uses. `scripts/reconcile.ts` is just its
CLI wrapper (arg parsing, exit code); the logic importable from `lib/reconcile.ts`
is what `reconcile.test.ts` exercises directly.

Counting is tied to what actually happened, not attempted: `inserted` only
increments when `confirmCheckout` reports it actually inserted the row (or, in
`--dry-run`, would have been attempted) - if it throws (an unresolvable owner, a
deleted plan), that exception propagates out and the session is counted as
`failed` instead, never silently miscounted as a successful insert. The
"already recorded?" lookup (`getBySessionAnyUser`) isn't scoped to the
metadata's `userId`: a purchase whose user was since deleted has `userId: null`,
and a user-scoped lookup would miss it and re-count it as inserted on every run.

The default scan window is 14 days (derived from `PROCESSING_TTL_SEC`), not 7 -
delayed payment methods (e.g. bank debits) can take that long to settle, and a
late settlement whose webhook was lost needs to still fall inside the window.

That window is about *sessions*, though, and refunds and disputes don't keep to
it: chargebacks typically land 30-120 days after the purchase. So after the
session scan, `run` also lists the window's `charge.refunded`,
`charge.dispute.created` and `charge.dispute.closed` events - the same charge
events the webhook acts on - and re-syncs each one's purchase from Stripe's live
state (`resolveChargeState`, as `updateByCharge` does), whatever the purchase's
own age. A payment intent with no purchase row (a subscription invoice, or a
checkout the session scan handles) is skipped; one the session scan already
synced isn't fetched twice. Changes count toward `updated`, errors toward
`failed`. Stripe keeps events for 30 days, so a `--days` beyond that only widens
the session scan.

### `runSubscriptions`: correcting stale subscription rows

A second, independent reconciler pass, triggered by `GET /plans/:id/access`
now reading the `subscription` table directly (see below) - a table the
`@better-auth/stripe` plugin writes straight from each webhook's payload,
with no protection against an out-of-order or retried `customer.subscription.*`
event overwriting a newer status. That used to be harmless (nothing read the
table); now it decides access, so it needs its own backstop.

Deliberately *not* a Stripe call inside `onEvent`: that would mean one API
call per webhook event, and Stripe enforces hard rate limits a real app's
webhook volume can realistically hit. Instead this stays a batched pass, same
shape as the one-time-purchase reconciler above, just scoped differently -
subscriptions have no creation-time window to scan (a status can change long
after creation, unlike a Checkout Session's short confirmation window), so
instead of `days`, it scopes by status: `getReconcilableSubscriptions` skips
any row already `canceled` or `incomplete_expired`, since Stripe guarantees
neither ever changes again.

`runSubscriptions` bulk-lists subscriptions from Stripe
(`stripe.subscriptions.list()`, auto-paginated) in one pass, rather than
retrieving each reconcilable row one by one - call volume scales with
*live subscriptions on the account divided by 100*, not with how many rows
need checking, which stays comfortably within rate-limit budget even as
subscriber count grows. Stripe's default list omits canceled subscriptions,
though, and a row left `active` by a lost `customer.subscription.deleted`
webhook is the most important drift this pass exists to catch - so every
reconcilable row the list didn't return is then retrieved individually
(`subscriptions.retrieve`). Those are only the drifted or broken rows,
normally none, so this costs nothing in the common case, unlike listing with
`status: "all"`, which would page through the account's whole cancellation
history on every run. Each listed subscription is matched
back to a reconcilable row by `stripeSubscriptionId`; unmatched rows are
handled after the loop (see below).

For each matched row, `reconcileSubscription` diffs the listed subscription
against the stored row and - unless it's a dry run - corrects it via
`updateSubscriptionFields`. The same mutable fields `@better-auth/stripe`'s
own webhook handlers write get touched: `status`, `periodStart`,
`periodEnd`, `trialStart`, `trialEnd`, `cancelAtPeriodEnd`, `cancelAt`,
`canceledAt`, `endedAt`, and - **not** an identity field, despite an earlier
version of this doc claiming otherwise - `plan`. The plugin re-resolves
`plan` from the subscription's current price on every
`customer.subscription.updated` (`resolvePlanItem` in its source), so a lost
or out-of-order webhook for a plan *change* (Basic -> Pro) is exactly the
kind of staleness this reconciler exists to catch; `getPlanByPriceId`
mirrors that same price-matching lookup
(`stripePriceId`/`annualDiscountPriceId`), and `plan` is only corrected when
a configured plan actually matches the current price - left untouched
otherwise, mirroring the plugin's own "no match -> no update" behavior,
rather than guessing or nulling it out. `referenceId`, `stripeCustomerId`
and `stripeSubscriptionId` itself remain the only genuine identity fields,
set once at creation and never rewritten here. `periodStart`/`periodEnd` are
read from `sub.items.data[0]`, not the subscription object's own top-level
fields, matching exactly where the plugin itself reads them from (Stripe
moved period fields to the item level) - same simplification applies to the
price lookup (first item only), which only matters for multi-item/seat
subscriptions this app doesn't use.

The correction is a compare-and-set: `updateSubscriptionFields` only writes if
the row still holds exactly the values it was read with. The listed snapshot
can be older than a webhook that lands mid-run - a cancellation, say - and the
plugin writes this table straight from each webhook, with no lock this code
could share, so writing the snapshot blindly could undo that cancellation and
hand access back. A row that changed in the meantime is skipped
(`payments.reconcile.subscription_changed`) and compared again on the next run.

A reconcilable row that even the individual retrieve can't find - a wrong or
orphaned `stripeSubscriptionId`, not a normal occurrence - is counted as `failed`
under its own message (`payments.reconcile.subscription_not_found`), the
same visibility a failed per-row lookup would have given; switching to
bulk-listing must not make a genuinely broken row go silently unnoticed.

Not covered: a subscription that exists in Stripe but has no row at all.
Unlike one-time purchases (which only ever exist once an async webhook
confirms them), the plugin creates the row synchronously as part of its own
checkout/upgrade flow, before any webhook fires - a genuinely missing row is
a much rarer failure mode than a stale one, and isn't what this pass targets.

`scripts/reconcile.ts` runs both passes every invocation and logs them under
separate messages (`payments.reconcile.summary` for the existing one-time
pass, `payments.reconcile.subscriptions_summary` for this one) so neither
affects how the other is parsed; the exit code is 1 if *either* pass failed.

## Checking active access: `GET /plans/:id/access`

The route that answers "does the caller currently have access to this
plan" (404 if the plan doesn't exist). Which of the two feature's two systems
it checks depends on `plan.type`, mirroring the same split as checkout above.
`GET /access` answers the broader question - every plan the caller has access
to - with the same rules (see "Every active plan" below).

A retired (`active: false`) plan is only revealed to someone who still holds
it (when `RETIRED_PLANS_KEEP_ACCESS` is on, the default) or to an admin with
`plan:read:all`; anyone else gets the same 404 as a plan that never existed,
matching `GET /plans/:id`.

```mermaid
flowchart TD
    Start(["GET /plans/:id/access"]) --> LookupPlan["paymentsRepo.plan.get(id)"]
    LookupPlan --> PlanFound{"plan exists?"}
    PlanFound -- no --> NotFound["404 Plan not found"]
    PlanFound -- yes --> Type{"plan.type?"}
    Type -- one_time --> HasActivePurchase["hasActivePurchase(userId, planId, plan.overlapping)"]
    Type -- recurring --> HasActiveSubscription["hasActiveSubscription(userId, plan.name)"]
    HasActivePurchase --> Holds["holds = active &&\n(plan.active || RETIRED_PLANS_KEEP_ACCESS)"]
    HasActiveSubscription --> Holds
    Holds --> Hidden{"plan retired\nand not held?"}
    Hidden -- no --> Return["200 { active: holds }"]
    Hidden -- yes --> Admin{"caller has\nplan:read:all?"}
    Admin -- yes --> Return
    Admin -- no --> NotFound2["404 Plan not found"]
```

### `one_time`: `hasActivePurchase`

Fetches the user's purchases of the plan with an access-granting status
(`PURCHASE_ACCESS_STATUSES`), then hands them to `isPurchaseAccessActive`
(`lib/utils.ts`) - a pure function shared with `GET /access`'s
`getActivePlans`, so the two can never read `overlapping` chaining
differently. Storage is always independent rows - each purchase's own
`durationDays` and `overlapping` are snapshotted at checkout time, never chained
with any other purchase's - so chaining happens only at read time, per each
purchase's own `overlapping` snapshot (the rule it was sold under, so flipping
the plan's flag later never rewrites access already sold): an overlapping
purchase's window starts at its own `createdAt`; a non-overlapping one starts
where the earlier windows end, if that's later, and its end is recomputed as
`(chain-adjusted start) + its own durationDays` rather than trusting its
independently-computed `expiresAt`, so a later purchase bought before an
earlier one lapses correctly extends access instead of shortening it. A row
with no `overlapping` snapshot (written before that column existed) follows the
plan's current setting. A row with no `durationDays` snapshot at all falls back
to its own `expiresAt` instead of being treated as perpetual - that
distinguishes a genuinely never-expiring purchase (`expiresAt` also `null`) from
a pre-migration row that predates this column and was never backfilled.

```mermaid
flowchart TD
    Start(["hasActivePurchase(userId, planId, plan.overlapping)"]) --> Fetch["SELECT access-granting purchases\nfor (userId, planId), ORDER BY createdAt ASC"]
    Fetch --> IsPurchaseAccessActive["isPurchaseAccessActive(purchases, plan, now)"]
    IsPurchaseAccessActive --> Walk["walk purchases in createdAt order"]
    Walk --> Overlap{"this purchase's own overlapping snapshot\n(the plan's current value if it has none)"}
    Overlap -- true --> OwnStart["start = createdAt"]
    Overlap -- false --> Chained["start = max(chainEnd, createdAt)"]
    OwnStart --> PerDuration
    Chained --> PerDuration
    PerDuration{"this purchase's\nown durationDays?"}
    PerDuration -- "null" --> ExpiresNull{"expiresAt also null?\n(no duration snapshot at all - either\ngenuinely perpetual, or a pre-migration\nrow written before this column existed)"}
    ExpiresNull -- yes --> True2["true"]
    ExpiresNull -- no --> EndExp["end = expiresAt"]
    PerDuration -- "set" --> Recompute["end = start + durationDays\n(recomputed from the chain-adjusted start,\nnot the purchase's own stored expiresAt)"]
    EndExp --> InWindow
    Recompute --> InWindow{"start <= now < end?"}
    InWindow -- yes --> True3["true"]
    InWindow -- no --> Advance["chainEnd = max(chainEnd, end),\nmove to next purchase\n(a gap before the next one isn't backfilled)"]
    Advance --> Walk
    Walk -->|no purchases left| False3["false"]
```

### `recurring`: `hasActiveSubscription`

Reads better-auth's own `subscription` table directly (`referenceId` = the
caller's user id - this app never enables the organization plugin, so a
subscription is always keyed by user, never by org) rather than calling the
plugin's `/subscription/list` endpoint: this feature only needs a boolean, not
the limits/priceId enrichment that endpoint adds, and reading the table
avoids reconstructing a session-bearing request just to call it. Matches
`sub.plan` against `plan.name` case-insensitively, the same way the plugin's
own plan lookup does, and treats `SUBSCRIPTION_ACCESS_STATUSES` (`active`/`trialing`) as the active statuses -
mirroring `isActiveOrTrialing`, the check the plugin itself uses to decide
whether a user is already subscribed (e.g. to block a duplicate upgrade) -
rather than also checking `periodEnd`, which the plugin doesn't check either.

A consequence worth being deliberate about: `past_due` isn't in that set, so
access is lost the moment a renewal payment fails, not after Stripe's
multi-day retry schedule for that failed payment runs out. That matches the
plugin's own definition of "subscribed" (reused here for consistency rather
than inventing a second one), but plenty of products choose to grant a grace
period through `past_due` instead. If that's wanted, it's a product decision
to make explicitly - add `"past_due"` to `SUBSCRIPTION_ACCESS_STATUSES` in
`lib/access-policy.ts` - not something that should happen by accident.

```mermaid
flowchart TD
    Start(["hasActiveSubscription(userId, plan.name)"]) --> Fetch["SELECT subscription\nWHERE referenceId = userId\nAND lower(plan) = lower(plan.name)\nAND status IN (active, trialing)"]
    Fetch --> Any{"any row?"}
    Any -- yes --> True["true"]
    Any -- no --> False["false"]
```

## The audit log: `payment_audit_log`

A persistent, queryable trail of the races around `plan.repeatable` that the
two `POST /checkout` guards and `confirmCheckout`'s own re-check write to -
`checkout_blocked_existing_purchase`, `checkout_blocked_pending_checkout`, and
`duplicate_purchase_confirmed` (the one where money was actually taken for an
already-owned non-repeatable plan, and the purchase is still recorded - see
above). All three writes are best-effort: a failure is logged as a warning and
never blocks the response or webhook outcome it's attached to. `GET
/audit-log` (admin, `audit:list`) exposes it - every entry, most recent
first, or one customer's via `?userId=`, backed by
`paymentsRepo.audit.getAll`/`getByUser` respectively. It's paginated by
keyset: `?limit=` (default 50, max 100) and `?before=<id>`, where the response's
`nextCursor` is the `before` for the next, older page (`null` on the last one).
Keyset rather than offset so a page boundary doesn't shift while new entries
keep arriving; ordered by `id`, which is unique and assigned in insertion order.

## Purchases across every user: `GET /purchases/all`

The admin counterpart to `GET /purchases` (which only ever returns the
caller's own, unpaginated - that stays as-is). Same keyset-pagination
mechanism as `GET /audit-log` above, just applied to `purchase` rows instead
of `payment_audit_log` ones - its own `?limit=`/`?before=`/`nextCursor`,
gated by its own permission (`purchase:read:all`, admin-only - there's no
"read:active" tier here the way `plan` has, since "see your own" is already
covered by `GET /purchases` needing no permission at all), and its own page-
size constants (`PURCHASES_DEFAULT_LIMIT`/`MAX_LIMIT` in `lib/constants.ts`)
rather than reusing the audit log's, since the two are different resources
that might reasonably want different limits later. Backed by
`paymentsRepo.purchase.getAllAdmin`/`getByUserAdmin`
(`use-cases/get-purchases.ts`), narrowed to one customer via `?userId=` the
same way the audit log is.

## Every active plan: `GET /access`

`paymentsRepo.access.getActivePlans` returns every plan the user has access to
right now, across both types, each with its `limits` - for an app that gates
features by what a user holds rather than by one specific plan id. It applies
exactly the same rules as the single-plan checks above: one-time plans via
`isPurchaseAccessActive` (the same pure function `hasActivePurchase` uses, so
`overlapping` chaining can't drift between the two), recurring plans via the
`subscription` table matched by name. Two queries total, however many plans the
user holds.

It deliberately stops at listing. Combining several plans' `limits` into one
answer (highest wins? add up? any-true?) depends entirely on what those limits
mean, so that's left to the app.

## Access policy: `lib/access-policy.ts`

Every product decision about who has access lives in this one file as a named,
documented constant, rather than inside the queries that read it:

| Setting | Default | Change it to |
| --- | --- | --- |
| `SUBSCRIPTION_ACCESS_STATUSES` | `active`, `trialing` | add `past_due` for a grace period during Stripe's retries |
| `PURCHASE_ACCESS_STATUSES` | `paid` | add `disputed` to keep access until a dispute is lost |
| `PURCHASE_BLOCKING_STATUSES` | `paid`, `disputed` | what stops a non-repeatable plan being bought again |
| `PARTIAL_REFUND_REVOKES_ACCESS` | `false` | `true` to end access on any refund |
| `RETIRED_PLANS_KEEP_ACCESS` | `true` | `false` to end access when a plan is deactivated |
| `CANCEL_ON_USER_DELETE` | cancel now, no proration | `prorate: true` to credit unused time |

`SUBSCRIPTION_TERMINAL_STATUSES` sits alongside them but isn't a choice - it's
Stripe's own list of statuses that never change again.

## Retiring a plan

Deactivating a plan (`PATCH /plans/:id { active: false }`) stops new purchases
and keeps existing ones working:

- **In Stripe, for both types:** the plan's price(s) are archived
  (`syncPlanPricesActive`), and restored on reactivation. The app's own guards
  below only cover the app's own endpoints; Stripe has other ways in - a
  Customer Portal configured to allow plan switching, a Payment Link, the
  Dashboard - and an archived price can't start a new purchase or be switched
  to, while subscriptions already on it keep billing. If the Stripe call fails,
  the plan is already updated in the database and the PATCH answers 500; the
  sync is idempotent, so repeating the same PATCH completes it. (A plan retired
  before this existed still has active prices - PATCH `{ active: false }` again.)

- **One-time:** `POST /checkout` already 404s an inactive plan. Existing
  purchases keep their access per `RETIRED_PLANS_KEEP_ACCESS`.
- **Recurring:** `getSubscriptionPlans` hands the stripe plugin *every*
  recurring plan, retired ones included, and `blockRetiredPlanUpgrade`
  (`lib/plan-retirement.ts`, wired as better-auth's `hooks.before`) refuses
  `/subscription/upgrade` to a retired plan with the same
  `SUBSCRIPTION_PLAN_NOT_FOUND` answer the plugin gives an unknown plan. The
  plugin uses one plan list for two jobs - what can be subscribed to, and
  which plan an existing subscription is on - and dropping a retired plan from
  it broke the second: its subscribers came back from `/subscription/list`
  with no `limits`, and for a multi-item subscription the plugin's
  `customer.subscription.updated` handler stopped syncing the row at all. The
  hook also blocks switching an existing subscription of a retired plan
  between monthly and annual (same endpoint) - retiring means no new
  commitments. Cancel, restore and the billing portal don't consult the plan
  list and keep working either way.

Changing a price for existing subscribers isn't covered: create a new plan,
retire the old one, and existing subscribers stay on the old price until they
change plan.

## Deleting a user

`cancelSubscriptionsForDeletedUser` (`lib/user-deletion.ts`) is wired to
better-auth's `databaseHooks.user.delete.before`, which every deletion path
goes through - the admin plugin's `removeUser` and the self-service
`/delete-user` alike. Neither `@better-auth/stripe` nor anything else here
cancelled a deleted user's subscriptions before this, so a deleted user kept
being billed (the plugin only has a hook for deleting organizations, which
this app doesn't use).

First, `expireCheckoutsForDeletedUser` (same file, same hook) expires every
Checkout Session the customer still has open - this feature's one-time ones
and the plugin's subscription ones alike. Otherwise a tab left open at deletion
could still be paid: a purchase recorded with no owner, or a subscription
billing a user who no longer exists. It runs first so no new subscription can
appear after the cancellation pass has listed them, and fails closed the same
way (a session the user completed at that very moment fails the expiry, and a
retry then finds it no longer open).

It lists the customer's subscriptions from Stripe rather than reading the
`subscription` table, so a subscription with a missing or stale row is still
caught, and cancels every one not already in a terminal status, on
`CANCEL_ON_USER_DELETE`'s terms. It fails closed: if a cancellation fails, it
throws, better-auth aborts the deletion, and the user stays - never deleted
while still billed. Retrying is safe, since already-cancelled subscriptions
are skipped. The Stripe customer itself is kept, for the same reason `purchase`
rows outlive their user: its payment history is still needed for refunds and
disputes.

## Where `repeatable`, `durationDays` and `overlapping` come from

All three live on `plan` and only matter for `type: one_time` (a `recurring`
plan's lifecycle is governed by its Stripe subscription period instead, and
`insertPlanSchema` rejects `durationDays` on recurring plans):

| Column | Meaning | Read by |
| --- | --- | --- |
| `repeatable` | can the same user buy this plan more than once at all | `POST /checkout`'s and `confirmCheckout`'s `getBlockingByPlan` guards (a `paid` or `disputed` purchase blocks; only `refunded` frees the slot) |
| `durationDays` | days of access one purchase grants from its own `createdAt`; `null` = never expires | `addPurchase`, which snapshots it onto `purchase.durationDays` and derives `purchase.expiresAt` from it |
| `overlapping` | when a user has multiple paid purchases of the plan, can their access windows run concurrently (`true`) or must a later one chain on after an earlier one expires (`false`) | `addPurchase`, which snapshots it onto `purchase.overlapping`; `isPurchaseAccessActive` reads each purchase's own snapshot |

All three (plus `limits`, `active`, `trialDays`) are editable via `PATCH /plans/:id` -
pricing/identity fields (`name`, `type`, `amount`, `interval`, the Stripe ids) aren't,
since they're either baked into an already-created Stripe Price or relied on as a
lookup key elsewhere (`name`, by `getSubscriptionPlans`). An edit to `durationDays`
or `overlapping` only affects checkouts started *after* it - `createCheckout`
snapshots both into the session's metadata, and `addPurchase` stores those
snapshots on the purchase row, so an edit never rewrites history for purchases
already made or still settling. (Rows from before the `overlapping` snapshot
existed have none and follow the plan's current value; backfill them once, before
the next edit, with `UPDATE purchase p SET overlapping = pl.overlapping FROM plan pl
WHERE p.plan_id = pl.id AND p.overlapping IS NULL`.) Flipping `repeatable` from `false` to `true` is rejected
(409) while any user still has a blocking purchase of the plan
(`paymentsRepo.purchase.hasAnyBlocking`) - otherwise it would silently reopen a
once-only/trial plan to every past purchaser, not just whoever's buying it next.
Setting `durationDays` on a plan whose `type` isn't `one_time`, or `trialDays` on
one whose `type` isn't `recurring`, is also rejected (422) - the same type/field
pairing `insertPlanSchema` already enforces at creation time, now enforced on
every edit too (fetched from the DB in the route handler itself, since `type`
isn't a patchable field the update payload could be checked against directly).

## The trial pattern

Two unrelated things both get called "trial" here - don't confuse them:

- **One-time paid trial** (e.g. $1 for 7 days): a `one_time` plan with
  `repeatable: false` and `durationDays` set. This is *this feature's own*
  gating, not a separate mechanism - but the two halves are independent, not
  chained: `getBlockingPurchaseByPlan` blocks a second purchase purely on
  purchase *status* (`paid`/`disputed`), with no regard for `durationDays` or
  `expiresAt` at all, while `hasActivePurchase` (access) and `durationDays`
  (how long one purchase's access lasts) are a separate axis entirely. So a
  non-repeatable trial is "once ever per account, until refunded" - buying it
  does *not* become possible again once the trial's own access window lapses.
  That's the point: a trial is meant to be spent once and not retried
  indefinitely as it keeps expiring.
- **Subscription trial** (e.g. 14 days of Pro, then it bills): `trialDays`
  on a `recurring` plan, handled entirely by `@better-auth/stripe` - it
  grants the trial, auto-bills when it ends, and only grants one per account
  by checking the user's subscription history before creating another. None
  of this feature's code is involved.

A genuinely *free*, one-time (non-subscription) plan can't be created
directly - `insertPlanSchema` requires `amount` to be positive. A $0 checkout
is still possible through `getCheckoutSessionParams`, by applying a 100%
coupon (`discounts`), and the flow handles it: the session completes with
`payment_status: "no_payment_required"` and no payment intent, the webhook
records the purchase (`amountTotal: 0`, `stripePaymentIntentId: null`), and
the reconciler treats it like any other completed session. For a free *trial*
specifically, though, the subscription-trial shape above is usually the right
fit, and better-auth already owns it end-to-end.

## Known noise / tech debt (not fixed here)

- **Spurious plugin log on every one-time purchase** - see "Stripe webhook
  dispatch" above. Vendor behavior (`@better-auth/stripe`'s
  `onCheckoutSessionCompleted` doesn't early-return for `mode: "payment"`); no
  code fix without patching the dependency.
- **Dependency version mismatch** - this repo runs `stripe@23`, but
  `@better-auth/stripe`'s declared peer range stops at `^22` (and separately,
  its peer on `better-auth` itself is `^1.7.7` while this repo runs `1.7.4`).
  Nothing is currently broken; revisit if an actual incompatibility surfaces.
- **`reservePendingCheckout`'s TTL-based lock has a narrow theoretical gap** -
  `RESERVATION_TTL_SEC` (5 min) is generous enough to outlast
  `ensureStripeCustomer` + `checkout.sessions.create` under any normal
  network condition, but it's still a TTL, not a true lock: if the request
  somehow took longer than that, a second request could claim the slot
  before `savePendingCheckout` overwrites the reservation with the real
  session id, and both would reach Stripe. Accepted as effectively
  unreachable in practice rather than engineered around.
