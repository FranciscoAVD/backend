import { env } from "@/env";
import type { Payment } from "@f/payments/lib/types";
import { getPaymentProcessor } from "@f/payments/payment";
import {
  PENDING_CHECKOUT_TTL_SEC,
  getPendingCheckout,
  savePendingCheckout,
} from "@f/payments/lib/pending-checkout";
import { encodeDurationDays } from "@f/payments/lib/utils";
import { getCheckoutSessionParams } from "@f/payments/lib/checkout-extensions";
import { getPurchaseBySession } from "@f/payments/use-cases/get-purchases";

// userId here is always the live, authenticated caller's id, unlike a purchase
// row's own (nullable) userId once that user is deleted
type CheckoutUser = {
  userId: string;
  stripeCustomerId: string;
};

/**
 * @description Creates a one-time Stripe Checkout Session and tracks it in Redis until Stripe
 * confirms the payment. The plan's `durationDays` is snapshotted onto the session's metadata here,
 * at checkout time, so an admin edit made while the payment is still settling (up to 14 days for
 * bank debits, or later via the reconciler) can't change what this buyer gets.
 *
 * `getCheckoutSessionParams` (`lib/checkout-extensions.ts`) can add further Stripe params (promo
 * codes, tax, a different `line_items` quantity, ...) - see that file for exactly what always
 * wins over its return value and why.
 *
 * Assumes the plan was checked to be active and one-time. Operation must be wrapped in try-catch
 * @param user object of user ID and Stripe customer ID
 * @param plan the full plan row - passed whole (not narrowed to just the fields this function
 * itself reads) since `getCheckoutSessionParams` may need to inspect any of it
 * @returns Object containing the session ID and the Stripe-hosted checkout URL.
 */
export async function createCheckout(
  user: CheckoutUser,
  plan: Payment.Plan,
): Promise<{ sessionId: string; url: string | null }> {
  const extra = (await getCheckoutSessionParams({ user, plan })) ?? {};
  const { metadata: extraMetadata, payment_intent_data: extraPID, line_items: extraLineItems, ...rest } = extra;

  // also kept on the session so a confirmed payment can still be recorded if the Redis entry is gone
  const metadata = {
    ...extraMetadata,
    userId: user.userId,
    planId: String(plan.id),
    durationDays: encodeDurationDays(plan.durationDays),
  };

  const session = await getPaymentProcessor().checkout.sessions.create({
    ...rest,
    mode: "payment",
    customer: user.stripeCustomerId,
    line_items: extraLineItems ?? [{ price: plan.stripePriceId, quantity: 1 }],
    client_reference_id: user.userId,
    metadata,
    // the payment intent carries the session's metadata plus any keys the extension set only on
    // the intent; the core keys still win on both
    payment_intent_data: { ...extraPID, metadata: { ...extraPID?.metadata, ...metadata } },
    success_url: `${env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/checkout/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + PENDING_CHECKOUT_TTL_SEC,
  });

  await savePendingCheckout(
    session.id,
    { userId: user.userId, planId: plan.id, status: "open" },
    PENDING_CHECKOUT_TTL_SEC,
  );

  return { sessionId: session.id, url: session.url };
}

/**
 * @description Resolves a checkout's status: the DB purchase once confirmed, otherwise the
 * pending Redis entry. Both are scoped to the user. Operation must be wrapped in try-catch
 * @param checkout object of the caller's own (always real, live) user ID and checkout session ID
 * @returns The checkout status, or null if the user has no checkout with that ID.
 */
export async function getCheckoutStatus(
  checkout: { userId: string } & Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<
  Payment.Purchase["status"] | "open" | "processing" | "failed" | "expired" | null
> {
  const purchase = await getPurchaseBySession(checkout);
  if (purchase) return purchase.status;

  const pending = await getPendingCheckout(checkout.stripeCheckoutSessionId);
  if (pending && pending.userId === checkout.userId) return pending.status;

  return null;
}

// re-exported so the webhook handler (not a use-case itself, but a consumer of this feature's
// checkout flow like route.ts is) can reach these through paymentsRepo too, instead of importing
// lib/pending-checkout.ts directly
export {
  getPendingCheckout,
  reservePendingCheckout,
  releaseReservation,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
} from "@f/payments/lib/pending-checkout";
