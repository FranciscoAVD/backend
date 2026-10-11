import type Stripe from "stripe";

/**
 * Stripe events `handleStripeEvent` acts on; anything else is ignored. Every
 * one of these is specific to the one-time-purchase flow — subscriptions are
 * handled entirely by @better-auth/stripe's own internal logic (a separate
 * event switch, writing to its own `subscription` table), independent of
 * this list. Trimming this list down does not affect subscriptions at all.
 *
 * - checkout.session.completed: confirms a paid one-time checkout (or marks
 *   it "processing" if payment is still settling, e.g. a bank debit)
 * - checkout.session.async_payment_succeeded: confirms a delayed-payment-
 *   method checkout once it finally clears
 * - checkout.session.async_payment_failed: clears the pending Redis entry
 * - checkout.session.expired: clears the pending Redis entry
 * - charge.refunded: syncs a purchase's refund state
 * - charge.dispute.created / charge.dispute.closed: syncs a purchase's
 *   dispute state
 *
 * See README.md's Payments section if you want to drop the one-time-purchase
 * flow entirely rather than just trimming this list — emptying it alone
 * leaves `POST /payments/checkout` live with no webhook ever confirming the
 * payment, which is not a safe way to turn the flow off.
 */
export const ALLOWED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const satisfies readonly Stripe.Event.Type[];

/** Stripe prefixes every Checkout Session ID with this. */
export const CHECKOUT_SESSION_ID_PREFIX = "cs_";
