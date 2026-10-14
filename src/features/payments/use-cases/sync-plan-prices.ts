import type { Payment } from "@f/payments/lib/types";
import { getPaymentProcessor } from "@f/payments/payment";

/**
 * @description Mirrors a plan's `active` flag onto its Stripe price(s): retiring a plan archives
 * them, reactivating restores them. The app's own checkout and `/subscription/upgrade` already
 * refuse a retired plan, but Stripe has other ways in that never touch this app - a Customer Portal
 * configured to allow plan switching, a Payment Link, the Dashboard. An archived price can't start a
 * new purchase or be switched to, while subscriptions already on it keep billing as before, which is
 * exactly what retiring means. Idempotent, so a failed sync is retried by repeating the same edit.
 * Operation must be wrapped in try-catch
 * @param plan object of the plan's (already updated) `active` flag and its Stripe price ids
 */
export async function syncPlanPricesActive(
  plan: Pick<Payment.Plan, "active" | "stripePriceId" | "annualDiscountPriceId">,
): Promise<void> {
  const stripe = getPaymentProcessor();
  for (const priceId of [plan.stripePriceId, plan.annualDiscountPriceId]) {
    if (priceId) await stripe.prices.update(priceId, { active: plan.active });
  }
}
