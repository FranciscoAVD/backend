import { env } from "@/env";
import type { Payment } from "@f/payments/lib/types";
import { getPaymentProcessor } from "@f/payments/payment";
import {
  PENDING_CHECKOUT_TTL_SEC,
  getPendingCheckout,
  savePendingCheckout,
} from "@f/payments/lib/pending-checkout";
import { getPurchaseBySession } from "@f/payments/use-cases/get-purchases";

type CheckoutUser = Pick<Payment.Purchase, "userID"> & {
  email: string;
  stripeCustomerId?: string | null;
};

/**
 * @description Creates a one-time Stripe Checkout Session and tracks it in Redis until Stripe
 * confirms the payment. Assumes the plan was checked to be active and one-time. Operation must be wrapped in try-catch
 * @param user object of user ID, email and Stripe customer ID
 * @param plan object of plan ID and Stripe price ID enforced by Pick<Payment.Plan, "id" | "stripePriceId">
 * @returns Object containing the session ID and the Stripe-hosted checkout URL.
 */
export async function createCheckout(
  user: CheckoutUser,
  plan: Pick<Payment.Plan, "id" | "stripePriceId">,
): Promise<{ sessionId: string; url: string | null }> {
  // also kept on the session so a confirmed payment can still be recorded if the Redis entry is gone
  const metadata = { userID: user.userID, planID: String(plan.id) };

  const session = await getPaymentProcessor().checkout.sessions.create({
    mode: "payment",
    // users created before the stripe plugin was added have no customer yet
    ...(user.stripeCustomerId
      ? { customer: user.stripeCustomerId }
      : { customer_email: user.email, customer_creation: "always" as const }),
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    client_reference_id: user.userID,
    metadata,
    payment_intent_data: { metadata },
    success_url: `${env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/checkout/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + PENDING_CHECKOUT_TTL_SEC,
  });

  await savePendingCheckout(
    session.id,
    { userID: user.userID, planID: plan.id, status: "open" },
    PENDING_CHECKOUT_TTL_SEC,
  );

  return { sessionId: session.id, url: session.url };
}

/**
 * @description Resolves a checkout's status: the DB purchase once confirmed, otherwise the
 * pending Redis entry. Both are scoped to the user. Operation must be wrapped in try-catch
 * @param checkout object of user ID and checkout session ID
 * @returns The checkout status, or null if the user has no checkout with that ID.
 */
export async function getCheckoutStatus(
  checkout: Pick<Payment.Purchase, "userID" | "stripeCheckoutSessionId">,
): Promise<Payment.Purchase["status"] | "open" | "processing" | null> {
  const purchase = await getPurchaseBySession(checkout);
  if (purchase) return purchase.status;

  const pending = await getPendingCheckout(checkout.stripeCheckoutSessionId);
  if (pending && pending.userID === checkout.userID) return pending.status;

  return null;
}
