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

/**
 * The metadata entry every Checkout Session (and its payment intent) this app creates is tagged
 * with, so the webhook, the reconciler and plan retirement only ever act on this app's own
 * sessions. Without it, "ours" meant "has `planId`/`userId` metadata" - true of a Payment Link, a
 * Dashboard-made session or another app on the same Stripe account, any of which could then be
 * recorded as a purchase here, or have its checkout expired by a plan edit. Change the value if
 * several deployments of this app share one Stripe account (e.g. staging and production in the
 * same live account), so each only claims its own.
 */
export const CHECKOUT_SOURCE_METADATA_KEY = "source";
export const CHECKOUT_SOURCE_METADATA_VALUE = "backend-payments";

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

/** How long an `open` checkout row stays valid. */
export const PENDING_CHECKOUT_TTL_SEC = 60 * 60 * 24;
/**
 * The Stripe Checkout Session's own `expires_at`, kept 10 minutes shorter than
 * `PENDING_CHECKOUT_TTL_SEC` so the checkout row always outlives the Stripe session, never the
 * other way around: the row is what holds the (user, plan) slot, and if it lapsed first a second
 * checkout could open while the first session was still payable. Still comfortably above
 * Stripe's own 30-minute minimum for `expires_at`.
 *
 * The flip side is a stretch at the end of an `open` row's life where Stripe no longer accepts
 * its session - if `checkout.session.expired`'s webhook is late, nothing else marks it. So the
 * row's *session* is treated as dead from `expiresAt - CHECKOUT_SESSION_EXPIRY_MARGIN_SEC` on
 * (see the constants below): it's no longer resumed or reported `open`, and its slot is freed.
 */
export const CHECKOUT_SESSION_EXPIRY_SEC = PENDING_CHECKOUT_TTL_SEC - 60 * 10;
/**
 * How much earlier than its `open` checkout row a session expires. The row's `expiresAt` is set
 * after `checkout.sessions.create` returns, from a later clock reading than the session's own
 * `expires_at`, so `expiresAt - this` is always at or after the moment Stripe expires the session.
 */
export const CHECKOUT_SESSION_EXPIRY_MARGIN_SEC =
  PENDING_CHECKOUT_TTL_SEC - CHECKOUT_SESSION_EXPIRY_SEC;
/**
 * The least time a session must have left to be handed back by `POST /checkout`'s resume path -
 * resuming one about to expire would just send the buyer to a page that dies while they type. One
 * with less left is expired at Stripe and replaced with a fresh session instead.
 */
export const CHECKOUT_RESUME_MIN_REMAINING_SEC = 60 * 5;
/**
 * Slack for the clocks involved (this app's, Postgres's `now()`, Stripe's) when freeing the slot
 * of an `open` row whose session should have expired: it's only swept this long *after* that
 * moment, so a session Stripe still considers payable never loses its slot to a second checkout.
 */
export const CHECKOUT_EXPIRY_CLOCK_SKEW_SEC = 60;
/**
 * How long a paid-but-unsettled (`processing`) checkout holds its slot. Delayed payment methods
 * can take a long time to settle - SEPA Direct Debit up to 14 *business* days, which is ~20
 * calendar days and more over bank holidays. A shorter hold let the slot be swept while the
 * payment was still settling, so a second checkout for a non-repeatable plan could be paid too.
 * Also how far back the reconciler scans by default and the user-deletion guard looks for
 * settling payments.
 */
export const PROCESSING_TTL_SEC = 60 * 60 * 24 * 28;
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
