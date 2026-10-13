/**
 * @description Extension point for adding Stripe Checkout Session params the one-time flow
 * doesn't set itself - promo codes (`discounts`/`allow_promotion_codes`), tax
 * (`automatic_tax`/`tax_id_collection`), a different line-item quantity, or anything else
 * `stripe.checkout.sessions.create` accepts. Mirrors `@better-auth/stripe`'s own
 * `subscription.getCheckoutSessionParams` option for the subscription flow - same idea, for
 * `createCheckout` (`use-cases/checkout.ts`). The default here does nothing; an app wanting any
 * of this implements the function directly - same "change it here, not where it's read"
 * convention `access-policy.ts` already established.
 *
 * What always wins over whatever this returns, and why (see `createCheckout` for where):
 * - `mode`, `customer`, `client_reference_id`, `success_url`, `cancel_url` - this flow's own
 *   identity, not something an extension has a reason to change.
 * - `expires_at` - kept in lockstep with `PENDING_CHECKOUT_TTL_SEC` (the Redis entry's own TTL);
 *   letting it drift would open a window where Stripe still accepts the session but Redis has
 *   already forgotten it.
 * - the `userId`/`planId`/`durationDays` keys of `metadata` and `payment_intent_data.metadata` -
 *   `confirmCheckout` and the reconciler depend on these to resolve a session back to a purchase
 *   at all. Additional keys *are* merged in, so an app can still tag a session with its own data
 *   (e.g. a campaign id) alongside them.
 *
 * `line_items` is deliberately **not** protected, unlike the subscription plugin (which has its
 * own seat/multi-item logic to guard) - this flow's default is just `[{ price, quantity: 1 }]`
 * with nothing else depending on it, so a returned `line_items` fully replaces it. That's the
 * mechanism for a different quantity (or anything else line-item-shaped).
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
