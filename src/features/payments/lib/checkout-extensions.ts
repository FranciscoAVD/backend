/**
 * @description Extension point for adding Stripe Checkout Session params the one-time flow
 * doesn't set itself - promo codes (`discounts`/`allow_promotion_codes`), tax
 * (`automatic_tax`/`tax_id_collection`), different line items, or most other params
 * `stripe.checkout.sessions.create` accepts. A few can't be combined with what this flow always
 * sets, and Stripe rejects the session if you try: `customer_email` and `customer_creation`
 * (this flow always passes `customer`), and `ui_mode: "embedded"` (which takes `return_url`, not
 * the `success_url`/`cancel_url` this flow sets). Mirrors `@better-auth/stripe`'s own
 * `subscription.getCheckoutSessionParams` option for the subscription flow - same idea, for
 * `createCheckout` (`services/checkout.ts`). The default here does nothing; an app wanting any
 * of this implements the function directly - same "change it here, not where it's read"
 * convention `access-policy.ts` already established.
 *
 * What always wins over whatever this returns, and why (see `createCheckout` for where):
 * - `mode`, `customer`, `client_reference_id`, `success_url`, `cancel_url` - this flow's own
 *   identity, not something an extension has a reason to change.
 * - `expires_at` - set from `CHECKOUT_SESSION_EXPIRY_SEC`, deliberately shorter than the checkout
 *   row's own deadline (`PENDING_CHECKOUT_TTL_SEC`) by a margin, so the row always outlives the
 *   Stripe session rather than matching it: `checkout.session.expired`'s webhook can lag, and
 *   without the margin a session Stripe has already expired but whose webhook hasn't landed yet
 *   would still read `open`.
 * - the `userId`/`planId`/`durationDays`/`overlapping` keys of `metadata` and `payment_intent_data.metadata` -
 *   `confirmCheckout` and the reconciler depend on these to resolve a session back to a purchase
 *   at all. Additional keys *are* merged in, so an app can still tag a session with its own data
 *   (e.g. a campaign id) alongside them. The payment intent gets the session's `metadata` too,
 *   plus any keys set only on `payment_intent_data.metadata`.
 *
 * `line_items` is deliberately **not** protected, unlike the subscription plugin (which has its
 * own seat/multi-item logic to guard) - a returned `line_items` fully replaces the default
 * `[{ price, quantity: 1 }]`, e.g. to charge a different price or add items. It does **not**
 * change what the buyer gets: one completed checkout records one purchase of the plan, with one
 * access window, whatever the quantity. Selling "3 months" as quantity 3 of a 30-day plan would
 * charge 3x and grant 30 days - for that, make a 90-day plan, or a repeatable plan bought 3 times.
 */
import type Stripe from "stripe";
import type { Payment } from "@f/payments/lib/types";

export type CheckoutSessionParamsContext = {
  user: { userId: string; stripeCustomerId: string };
  plan: Payment.Plan;
};

export async function getCheckoutSessionParams(
  _context: CheckoutSessionParamsContext,
): Promise<Partial<Stripe.Checkout.SessionCreateParams> | undefined> {
  return undefined;
}
