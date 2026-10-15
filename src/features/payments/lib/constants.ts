import type Stripe from "stripe";

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
