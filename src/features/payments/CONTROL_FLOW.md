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
checkout before the first confirms); they can't close every race - see
`confirmCheckout`'s own re-check further down for the narrower one that reaches
the webhook anyway.

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
    AlreadyOwns -- no --> CheckPending["paymentsRepo.checkout.hasPending(userId, planId)\n(Redis pointer, no Stripe call yet)"]
    CheckPending -->|redis error| Err500e["500"]
    CheckPending --> HasPending{"an open/processing\ncheckout already exists?"}
    HasPending -- yes --> Audit2["audit log: checkout_blocked_pending_checkout\n(best-effort)"]
    Audit2 --> Conflict2["409 You already have a checkout\nin progress for this plan"]
    HasPending -- no --> EnsureCustomer

    EnsureCustomer["paymentsRepo.customer.ensure(id, name, email)\n(always re-reads the live user row itself -\nnever trusts a caller-supplied id, which can\nbe a stale cached session - see below)"] -->|stripe/db error| Err500c["500"]
    EnsureCustomer --> CreateSession

    CreateSession["createCheckout:\nstripe.checkout.sessions.create\n(mode: payment, customer: stripeCustomerId)"] -->|stripe error| Err500d["500"]
    CreateSession --> SavePending["savePendingCheckout\n(Redis key checkout:sessionId + a\ncheckout:active:userId:planId pointer,\nstatus: open, TTL 24h)"]
    SavePending -->|redis error| Err500f["500\n(harmless - the Stripe session\nstill expires on its own)"]
    SavePending --> Return200["200 { sessionId, url }"]
    Return200 --> Redirect(["client redirects user to\nthe Stripe-hosted url"])
```

`ensureStripeCustomer` re-reads `user.stripeCustomerId` from Postgres on every
call rather than trusting the session object: better-auth can serve a
Redis-cached `user` blob without querying Postgres at all, and this function's
own raw DB write bypasses the adapter hook that would otherwise refresh that
cache - so a value read from the session can be stale. It also passes a
`customer-<userId>` Stripe idempotency key, so a retried call can't create a
second customer (though it doesn't fully dedupe two truly simultaneous requests
- Stripe's idempotency semantics don't strictly guarantee that).

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
    CSC -- payment_status: unpaid --> MarkProcessing["paymentsRepo.checkout.markProcessing(session.id)\nRedis TTL extended to 14 days\n(delayed payment methods, e.g. bank debits)"]
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
also never repoints the `checkout:active:userId:planId` pointer at the session it's
updating (only ever clears it, and only if it's still the current one) - so a retried
`markFailed` for an old, already-superseded session can't drag the pointer off a
newer session that's since taken over the (user, plan) slot.

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

    AddPurchase["paymentsRepo.purchase.add:\npurchasedAt = session.created (not insert time)\nexpiresAt = plan.durationDays ? purchasedAt + durationDays : null\nINSERT ... ON CONFLICT (stripeCheckoutSessionId) DO NOTHING\n(on a user_id FK violation - the user was deleted\nmid-checkout - retries once with userId: null)"]
    AddPurchase --> RemovePending["paymentsRepo.checkout.removePending(session.id)\n(best-effort; a leftover key just expires via its TTL)"]
```

The `exclude` on `getBlockingByPlan` matters for a Stripe redelivery of the *same*
session: without it, the second delivery would find the purchase row the first
delivery just wrote and wrongly flag it as `duplicate_purchase_confirmed` - the
blocking check only looks for a *different* session's purchase.

`addPurchase` is idempotent on `stripeCheckoutSessionId`, so a retried
`checkout.session.completed` (Stripe's at-least-once delivery) is a no-op the
second time. `createdAt`/`expiresAt` are derived from the Stripe session's own
`created` timestamp, not insert time - so a purchase recorded late (e.g. by the
reconciler) doesn't get bonus days of access. Each purchase's own `durationDays`
is snapshotted onto its row at insert time, independent of any other purchase
of the same plan or any later edit to the plan itself (see "checking active
access" below).

### `updateByCharge`: refunds and disputes

Never trusts a webhook event's own embedded payload for the resulting state -
Stripe doesn't guarantee delivery order, so an out-of-order or retried event's
payload can be stale. Always re-fetches the current charge/dispute from Stripe
instead (`resolveChargeState` in `lib/charge-state.ts`), the same function the
reconciler uses.

```mermaid
flowchart TD
    Start(["updateByCharge(paymentIntent)"]) --> HasId{"payment_intent\npresent on the event?"}
    HasId -- no --> NoOp1["return (nothing to update)"]
    HasId -- yes --> Resolve["resolveChargeState(paymentIntentId):\nstripe.paymentIntents.retrieve(expand: latest_charge)\n+ stripe.disputes.list if charge.disputed"]
    Resolve --> HasCharge{"a charge\nexists on the intent?"}
    HasCharge -- no --> NoOp2["return"]
    HasCharge -- yes --> TryUpdate["updatePurchaseByPaymentIntent(target)"]
    TryUpdate --> Updated{"a purchase row\nwas updated?"}
    Updated -- yes --> Done["done"]
    Updated -- no --> Retrieve["stripe.paymentIntents.retrieve(id)\n(plain, no expand - just for metadata)"]
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
increments once `confirmCheckout` has actually resolved (or, in `--dry-run`,
would have been attempted) - if it throws (an unresolvable owner, a deleted
plan), that exception propagates out and the session is counted as `failed`
instead, never silently miscounted as a successful insert.

The default scan window is 14 days (derived from `PROCESSING_TTL_SEC`), not 7 -
delayed payment methods (e.g. bank debits) can take that long to settle, and a
late settlement whose webhook was lost needs to still fall inside the window.

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
neither ever changes again. Call volume scales with *currently live-ish
subscriber count*, re-checked once per scheduled run (daily, via the `cron`
image) - not with webhook traffic.

For each remaining row, `reconcileSubscription` does one
`stripe.subscriptions.retrieve()`, diffs the result against the stored row,
and - unless it's a dry run - corrects it via `updateSubscriptionFields`.
Only the same mutable fields `@better-auth/stripe`'s own webhook handlers
write get touched (`status`, `periodStart`, `periodEnd`, `trialStart`,
`trialEnd`, `cancelAtPeriodEnd`, `cancelAt`, `canceledAt`, `endedAt`) -
`plan`, `referenceId`, `stripeCustomerId` and `stripeSubscriptionId` itself
are identity fields the plugin sets once at creation; they aren't what
staleness puts at risk, and this reconciler has no business rewriting them.
`periodStart`/`periodEnd` are read from `sub.items.data[0]`, not the
subscription object's own top-level fields, matching exactly where the
plugin itself reads them from (Stripe moved period fields to the item level).

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

The one route that answers "does the caller currently have access to this
plan" (404 if the plan doesn't exist). Which of the two feature's two systems
it checks depends on `plan.type`, mirroring the same split as checkout above:

```mermaid
flowchart TD
    Start(["GET /plans/:id/access"]) --> LookupPlan["paymentsRepo.plan.get(id)"]
    LookupPlan --> PlanFound{"plan exists?"}
    PlanFound -- no --> NotFound["404 Plan not found"]
    PlanFound -- yes --> Type{"plan.type?"}
    Type -- one_time --> HasActivePurchase["hasActivePurchase(userId, planId, plan.overlapping)"]
    Type -- recurring --> HasActiveSubscription["hasActiveSubscription(userId, plan.name)"]
    HasActivePurchase --> Return["200 { active }"]
    HasActiveSubscription --> Return
```

### `one_time`: `hasActivePurchase`

Storage is always independent rows - each purchase's own `durationDays` is
snapshotted at purchase time, never chained with any other purchase's - so
`plan.overlapping` only changes how they're *read*: `overlapping: false`
recomputes each purchase's end as `(chain-adjusted start) + its own
durationDays`, rather than trusting its independently-computed `expiresAt`, so
a later purchase bought before an earlier one lapses correctly extends access
instead of shortening it. A row with no `durationDays` snapshot at all falls
back to its own `expiresAt` instead of being treated as perpetual - that
distinguishes a genuinely never-expiring purchase (`expiresAt` also `null`)
from a pre-migration row that predates this column and was never backfilled.

```mermaid
flowchart TD
    Start(["hasActivePurchase(userId, planId, plan.overlapping)"]) --> Fetch["SELECT paid purchases for (userId, planId)\nORDER BY createdAt ASC"]
    Fetch --> Overlap{"plan.overlapping?"}

    Overlap -- true --> AnyActive{"any purchase has\nexpiresAt IS NULL\nor expiresAt > now?"}
    AnyActive -- yes --> True1["true"]
    AnyActive -- no --> False1["false"]

    Overlap -- false --> Walk["walk purchases in order,\nchaining: start = max(chainEnd, createdAt)"]
    Walk --> PerDuration{"this purchase's\nown durationDays?"}
    PerDuration -- "null" --> ExpiresNull{"expiresAt also null?\n(no duration snapshot at all - either\ngenuinely perpetual, or a pre-migration\nrow written before this column existed)"}
    ExpiresNull -- yes --> True2["true"]
    ExpiresNull -- no --> InExpiresWindow{"start <= now < expiresAt?"}
    InExpiresWindow -- yes --> True2b["true"]
    InExpiresWindow -- no --> Advance2["chainEnd = expiresAt,\nmove to next purchase"]
    Advance2 --> Walk
    PerDuration -- "set" --> Recompute["end = start + durationDays\n(recomputed from the chain-adjusted start,\nnot the purchase's own stored expiresAt)"]
    Recompute --> InWindow{"start <= now < end?"}
    InWindow -- yes --> True3["true"]
    InWindow -- no --> Advance["chainEnd = end,\nmove to next purchase\n(a gap before the next one isn't backfilled)"]
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
own plan lookup does, and treats `active`/`trialing` as the active statuses -
mirroring `isActiveOrTrialing`, the check the plugin itself uses to decide
whether a user is already subscribed (e.g. to block a duplicate upgrade) -
rather than also checking `periodEnd`, which the plugin doesn't check either.

A consequence worth being deliberate about: `past_due` isn't in that set, so
access is lost the moment a renewal payment fails, not after Stripe's
multi-day retry schedule for that failed payment runs out. That matches the
plugin's own definition of "subscribed" (reused here for consistency rather
than inventing a second one), but plenty of products choose to grant a grace
period through `past_due` instead. If that's wanted, it's a product decision
to make explicitly here - add `"past_due"` to the `inArray` status check -
not something that should happen by accident.

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
`paymentsRepo.audit.getAll`/`getByUser` respectively.

## Where `repeatable`, `durationDays` and `overlapping` come from

All three live on `plan` and only matter for `type: one_time` (a `recurring`
plan's lifecycle is governed by its Stripe subscription period instead, and
`insertPlanSchema` rejects `durationDays` on recurring plans):

| Column | Meaning | Read by |
| --- | --- | --- |
| `repeatable` | can the same user buy this plan more than once at all | `POST /checkout`'s and `confirmCheckout`'s `getBlockingByPlan` guards (a `paid` or `disputed` purchase blocks; only `refunded` frees the slot) |
| `durationDays` | days of access one purchase grants from its own `createdAt`; `null` = never expires | `addPurchase`, which snapshots it onto `purchase.durationDays` and derives `purchase.expiresAt` from it |
| `overlapping` | when a user has multiple paid purchases of the plan, can their access windows run concurrently (`true`) or must a later one chain on after an earlier one expires (`false`) | `hasActivePurchase` |

All three (plus `limits`, `active`, `trialDays`) are editable via `PATCH /plans/:id` -
pricing/identity fields (`name`, `type`, `amount`, `interval`, the Stripe ids) aren't,
since they're either baked into an already-created Stripe Price or relied on as a
lookup key elsewhere (`name`, by `getSubscriptionPlans`). An edit to `durationDays`
only affects purchases made *after* it - `addPurchase` snapshots the plan's
`durationDays` onto the purchase row at purchase time, so it never rewrites history
for purchases already made. Flipping `repeatable` from `false` to `true` is rejected
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

A genuinely *free*, one-time (non-subscription) trial isn't supported and
doesn't need to be: `insertPlanSchema` requires `amount` to be positive, and
Stripe Checkout in `payment` mode can't settle a $0 total without a coupon -
every realistic "free trial" need is the subscription-trial shape above,
which better-auth already owns end-to-end.

## Known noise / tech debt (not fixed here)

- **Spurious plugin log on every one-time purchase** - see "Stripe webhook
  dispatch" above. Vendor behavior (`@better-auth/stripe`'s
  `onCheckoutSessionCompleted` doesn't early-return for `mode: "payment"`); no
  code fix without patching the dependency.
- **Dependency version mismatch** - this repo runs `stripe@23`, but
  `@better-auth/stripe`'s declared peer range stops at `^22` (and separately,
  its peer on `better-auth` itself is `^1.7.7` while this repo runs `1.7.4`).
  Nothing is currently broken; revisit if an actual incompatibility surfaces.
