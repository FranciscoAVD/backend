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

`route.ts`'s handler, in the order the checks actually run:

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
    Repeatable -- no --> CheckOwned["paymentsRepo.purchase.getPaidByPlan(userId, planId)"]
    CheckOwned -->|db error| Err500b["500"]
    CheckOwned --> AlreadyOwns{"a paid purchase\nalready exists?"}
    AlreadyOwns -- yes --> Conflict["409 You've already purchased this plan"]
    AlreadyOwns -- no --> EnsureCustomer

    EnsureCustomer["paymentsRepo.customer.ensure(user)"] --> HasCustomer{"user.stripeCustomerId\nalready set?"}
    HasCustomer -- yes --> ReturnId["return it as-is"]
    HasCustomer -- no --> CreateCustomer["stripe.customers.create\n+ persist on the user row\n(createCustomerOnSignUp's hook\ncan silently fail - see below)"]
    CreateCustomer --> ReturnId
    ReturnId -->|stripe/db error| Err500c["500"]
    ReturnId --> CreateSession

    CreateSession["createCheckout:\nstripe.checkout.sessions.create\n(mode: payment, customer: stripeCustomerId)"] -->|stripe error| Err500d["500"]
    CreateSession --> SavePending["savePendingCheckout\n(Redis key checkout:sessionId,\nstatus: open, TTL 24h)"]
    SavePending --> Return200["200 { sessionId, url }"]
    Return200 --> Redirect(["client redirects user to\nthe Stripe-hosted url"])
```

`GET /checkout/:sessionId` (`getCheckoutStatus`) answers the client's polling: it
reads the `purchase` row if one exists yet (`paid`/`refunded`/`disputed`), otherwise
falls back to the pending Redis entry (`open`/`processing`), otherwise `null` → 404.

## Stripe webhook dispatch

Every Stripe event - recurring or one-time - lands on the **same** endpoint,
`/api/auth/stripe/webhook`, owned by `@better-auth/stripe`. It verifies the
signature, handles `customer.subscription.*` and subscription-mode
`checkout.session.completed` itself (writing the `subscription` table directly),
then *always* forwards the raw event to the `onEvent` hook this app wired up to
`handleStripeEvent` in `lib/webhook.ts` - regardless of event type.

```mermaid
sequenceDiagram
    participant Stripe
    participant Plugin as better-auth stripe plugin<br/>(/api/auth/stripe/webhook)
    participant Handler as handleStripeEvent<br/>(lib/webhook.ts)

    Stripe->>Plugin: POST event (signed)
    Plugin->>Plugin: verify signature, parse event
    alt event.type is subscription-related
        Plugin->>Plugin: update `subscription` table
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
    CSC -- payment_status: unpaid --> MarkProcessing["markProcessing(session.id)\nRedis TTL extended to 14 days\n(delayed payment methods, e.g. bank debits)"]
    CSC -- otherwise paid --> Confirm["confirmCheckout(session)"]

    E --> APS["async_payment_succeeded\n(mode: payment)"] --> Confirm
    E --> APF["async_payment_failed\n(mode: payment)"] --> RemovePending1["removePendingCheckout(session.id)"]
    E --> Exp["checkout.session.expired\n(mode: payment)"] --> RemovePending2["removePendingCheckout(session.id)"]

    E --> Ref["charge.refunded"] --> UpdByCharge1["updateByCharge(payment_intent,\nstatus+amountRefunded from the charge)"]
    E --> DispC["charge.dispute.created"] --> UpdByCharge2["updateByCharge(payment_intent,\nstatus from dispute.status)"]
    E --> DispX["charge.dispute.closed"] --> UpdByCharge2
```

### `confirmCheckout`: turning a paid session into a `purchase` row

```mermaid
flowchart TD
    Start(["confirmCheckout(session)"]) --> ResolveOwner["resolveOwner:\ngetPendingCheckout(session.id)"]
    ResolveOwner --> HasPending{"pending entry\nfound in Redis?"}
    HasPending -- yes --> Owner["{ userId, planId }"]
    HasPending -- no, or Redis error --> Metadata["fall back to\nsession.metadata\n(set on the session at createCheckout time)"]
    Metadata --> HasMetadata{"metadata has\nuserId + planId?"}
    HasMetadata -- no --> LogDrop["log error payments.webhook.metadata\n(nothing to record)"]
    HasMetadata -- yes --> Owner

    Owner --> FetchPlan["paymentsRepo.plan.get(planId)"]
    FetchPlan --> PlanFound{"plan still exists?"}
    PlanFound -- no --> LogPlanMissing["log error payments.webhook.plan_missing\n(plan was deleted after checkout)"]
    PlanFound -- yes --> AddPurchase

    AddPurchase["paymentsRepo.purchase.add:\nexpiresAt = plan.durationDays\n  ? createdAt + durationDays\n  : null\nINSERT ... ON CONFLICT (stripeCheckoutSessionId) DO NOTHING"]
    AddPurchase --> RemovePending["removePendingCheckout(session.id)\n(best-effort; a leftover key just expires via its TTL)"]
```

`addPurchase` is idempotent on `stripeCheckoutSessionId`, so a retried
`checkout.session.completed` (Stripe's at-least-once delivery) is a no-op the
second time. Each purchase's `expiresAt` is computed from **its own**
`createdAt`, independent of any other purchase of the same plan - storage never
chains purchases together (see "checking active access" below).

### `updateByCharge`: refunds and disputes

```mermaid
flowchart TD
    Start(["updateByCharge(paymentIntent, update)"]) --> HasId{"payment_intent\npresent on the event?"}
    HasId -- no --> NoOp1["return (nothing to update)"]
    HasId -- yes --> TryUpdate["updatePurchaseByPaymentIntent(update)"]
    TryUpdate --> Updated{"a purchase row\nwas updated?"}
    Updated -- yes --> Done["done"]
    Updated -- no --> Retrieve["stripe.paymentIntents.retrieve(id)"]
    Retrieve --> OursButMissing{"intent.metadata.planId\nset (one of our checkouts)?"}
    OursButMissing -- yes --> Throw["throw\n(confirmCheckout's insert is still\nin flight/retrying - fail so Stripe\nretries this event too)"]
    OursButMissing -- no --> Ignore["ignore\n(e.g. a subscription invoice charge\nwith no purchase row at all)"]
```

## Checking active access: `hasActivePurchase`

Nothing calls this yet, but it's the intended way to answer "does this user
currently have access to this plan" once something needs to. Storage is always
independent rows (`expiresAt` per purchase, never chained) - `plan.overlapping`
only changes how they're *read*.

```mermaid
flowchart TD
    Start(["hasActivePurchase(userId, planId, plan.overlapping)"]) --> Fetch["SELECT paid purchases for (userId, planId)\nORDER BY createdAt ASC"]
    Fetch --> Overlap{"plan.overlapping?"}

    Overlap -- true --> AnyActive{"any purchase has\nexpiresAt IS NULL\nor expiresAt > now?"}
    AnyActive -- yes --> True1["true"]
    AnyActive -- no --> False1["false"]

    Overlap -- false --> Walk["walk purchases in order,\nchaining: start = max(chainEnd, createdAt)"]
    Walk --> PerExpiry{"this purchase's\nexpiresAt?"}
    PerExpiry -- "null (perpetual)" --> NowPast{"now >= start?"}
    NowPast -- yes --> True2["true"]
    NowPast -- no --> False2["false"]
    PerExpiry -- "set" --> InWindow{"start <= now < expiresAt?"}
    InWindow -- yes --> True3["true"]
    InWindow -- no --> Advance["chainEnd = expiresAt,\nmove to next purchase\n(a gap before the next one isn't backfilled)"]
    Advance --> Walk
    Walk -->|no purchases left| False3["false"]
```

## Where `repeatable`, `durationDays` and `overlapping` come from

All three live on `plan` and only matter for `type: one_time` (a `recurring`
plan's lifecycle is governed by its Stripe subscription period instead, and
`insertPlanSchema` rejects `durationDays` on recurring plans):

| Column | Meaning | Read by |
| --- | --- | --- |
| `repeatable` | can the same user buy this plan more than once at all | `POST /checkout`'s `getPaidByPlan` guard |
| `durationDays` | days of access one purchase grants from its own `createdAt`; `null` = never expires | `addPurchase` (sets `purchase.expiresAt`) |
| `overlapping` | when a user has multiple paid purchases of the plan, can their access windows run concurrently (`true`) or must a later one chain on after an earlier one expires (`false`) | `hasActivePurchase` |
