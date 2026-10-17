import type Stripe from "stripe";
import type { checkoutStatus } from "@d/schemas/payment-schema";

type CheckoutStatus = (typeof checkoutStatus.enumValues)[number];

/** Stripe events `handleStripeEvent` acts on; anything else is ignored. */
export const ALLOWED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  // a refund that later fails (or is canceled) lowers the charge's amount_refunded again without a
  // second charge.refunded - only this event says so
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const satisfies readonly Stripe.Event.Type[];

/** Stripe prefixes every Checkout Session ID with this. */
export const CHECKOUT_SESSION_ID_PREFIX = "cs_";

/** GET /audit-log page size when none is asked for, and the most it allows. */
export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_MAX_LIMIT = 100;

/** GET /purchases/all page size when none is asked for, and the most it allows. */
export const PURCHASES_DEFAULT_LIMIT = 50;
export const PURCHASES_MAX_LIMIT = 100;

/**
 * Per-attempt request timeout and retry count for every Stripe call. Explicit rather than the SDK's
 * defaults (80s, 2 retries - up to 240s per call), so a single request's worst case stays bounded:
 * `POST /checkout` makes up to two Stripe calls while it holds a `RESERVATION_TTL_SEC` reservation,
 * and the webhook handler's calls hold up Stripe's own delivery. Stripe answers in well under a
 * second normally; 20s per attempt only cuts off calls that were going to fail anyway.
 */
export const STRIPE_TIMEOUT_MS = 20_000;
export const STRIPE_MAX_NETWORK_RETRIES = 2;

/**
 * Upper bounds for a plan's day counts. `durationDays` past ~100 million days pushes a purchase's
 * `expiresAt` beyond what a Date can hold, and every confirmation of that plan then fails after
 * the buyer has paid - so it's capped well short of that, at 100 years. `trialDays` is capped at
 * Stripe's own limit on a subscription trial, so a value it would reject never gets stored.
 */
export const MAX_DURATION_DAYS = 36_500;
export const MAX_TRIAL_DAYS = 730;

/** How long an `open` checkout row stays valid - no longer matches the Stripe session (see below). */
export const PENDING_CHECKOUT_TTL_SEC = 60 * 60 * 24;
/**
 * The Stripe Checkout Session's own `expires_at`, kept 10 minutes shorter than
 * `PENDING_CHECKOUT_TTL_SEC` so the checkout row always outlives the Stripe session, never the
 * other way around. `checkout.session.expired`'s webhook can lag; without this margin, a session
 * Stripe has already expired but whose webhook hasn't landed yet still reads `open`, and the
 * resume path could hand a buyer back a session Stripe will no longer accept. Still comfortably
 * above Stripe's own 30-minute minimum for `expires_at`.
 */
export const CHECKOUT_SESSION_EXPIRY_SEC = PENDING_CHECKOUT_TTL_SEC - 60 * 10;
/** Delayed payment methods (e.g. bank debits) can take several days to settle. */
export const PROCESSING_TTL_SEC = 60 * 60 * 24 * 14;
/**
 * How long a `POST /checkout` reservation holds the (user, plan) slot before the real session id
 * replaces it. Sized to outlast `ensureCustomer` plus `checkout.sessions.create` at the Stripe
 * client's worst case (`STRIPE_TIMEOUT_MS` x (1 + `STRIPE_MAX_NETWORK_RETRIES`) per call) - but
 * correctness doesn't depend on it: the claimed row's own `id` is the reservation, and opening it
 * only succeeds while that exact row is still `reserving`. If the request dies mid-way, the next
 * claim for the same slot sweeps the row and frees it.
 */
export const RESERVATION_TTL_SEC = 60 * 5;

/**
 * The statuses that hold a (user, plan) slot, and so the predicate of the `checkout_active_slot`
 * partial unique index. Must stay in lockstep with the `where` clause on that index in
 * `db/schemas/payment-schema.ts` - Postgres index predicates can't be built from this value.
 */
export const CHECKOUT_ACTIVE_STATUSES = [
  "reserving",
  "open",
  "processing",
] as const satisfies readonly CheckoutStatus[];

/**
 * Which statuses each transition may move *from*. Stripe's retries and out-of-order delivery mean
 * a later event for the same session can carry an earlier status, and that must never move the
 * status backward or resurrect a row that already reached a terminal one. `failed` and `expired`
 * exclude each other (neither is "later"), and `completed` can't be left at all.
 */
export const CHECKOUT_TRANSITIONS_FROM = {
  processing: ["reserving", "open", "processing"],
  failed: ["reserving", "open", "processing", "failed"],
  expired: ["reserving", "open", "processing", "expired"],
  completed: ["reserving", "open", "processing", "completed"],
} as const satisfies Record<string, readonly CheckoutStatus[]>;
