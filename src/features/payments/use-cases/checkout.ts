import { env } from "@/env";
import type { Payment } from "@f/payments/lib/types";
import { getPaymentProcessor } from "@f/payments/payment";
import {
  PENDING_CHECKOUT_TTL_SEC,
  getPendingCheckout,
  savePendingCheckout,
  removePendingCheckout,
  CheckoutSlotLostError,
} from "@f/payments/lib/pending-checkout";
import { encodeDurationDays, encodeOverlapping } from "@f/payments/lib/utils";
import { getCheckoutSessionParams } from "@f/payments/lib/checkout-extensions";
import { getPurchaseBySession } from "@f/payments/use-cases/get-purchases";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

// userId here is always the live, authenticated caller's id, unlike a purchase
// row's own (nullable) userId once that user is deleted
type CheckoutUser = {
  userId: string;
  stripeCustomerId: string;
};

/**
 * @description Creates a one-time Stripe Checkout Session and tracks it in Redis until Stripe
 * confirms the payment. The plan's `durationDays` and `overlapping` are snapshotted onto the session's metadata here,
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
  options: { reservation?: string } = {},
): Promise<{ sessionId: string; url: string | null }> {
  const extra = (await getCheckoutSessionParams({ user, plan })) ?? {};
  const { metadata: extraMetadata, payment_intent_data: extraPID, line_items: extraLineItems, ...rest } = extra;

  // also kept on the session so a confirmed payment can still be recorded if the Redis entry is gone
  const metadata = {
    ...extraMetadata,
    userId: user.userId,
    planId: String(plan.id),
    durationDays: encodeDurationDays(plan.durationDays),
    overlapping: encodeOverlapping(plan.overlapping),
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

  const saved = await savePendingCheckout(
    session.id,
    { userId: user.userId, planId: plan.id, status: "open", url: session.url ?? undefined },
    PENDING_CHECKOUT_TTL_SEC,
    options.reservation,
  );

  if (!saved) {
    // the reservation lapsed while Stripe was answering and another checkout holds the slot now.
    // This session's URL never leaves this function, so nobody can pay it; expiring it is tidiness
    const [, expireError] = await tryCatch(
      getPaymentProcessor().checkout.sessions.expire(session.id),
    );
    if (expireError)
      logger.warn({ err: expireError, session: session.id }, "payments.checkout.expire_lost");
    throw new CheckoutSlotLostError();
  }

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

/**
 * @description Expires a one-time Checkout Session this app created and drops its pending entry,
 * so it can't be paid. For a session the caller is about to withhold (e.g. the user's deletion
 * started while it was being created). Operation must be wrapped in try-catch
 * @param sessionId the Checkout Session to expire
 */
export async function expireCheckout(sessionId: string): Promise<void> {
  await getPaymentProcessor().checkout.sessions.expire(sessionId);
  await removePendingCheckout(sessionId);
}

// re-exported so the webhook handler (not a use-case itself, but a consumer of this feature's
// checkout flow like route.ts is) can reach these through paymentsRepo too, instead of importing
// lib/pending-checkout.ts directly
export { isUserDeleting } from "@f/payments/lib/deletion-guard";
export {
  getPendingCheckout,
  getResumableCheckout,
  reservePendingCheckout,
  releaseReservation,
  acquireCreateLock,
  releaseCreateLock,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
} from "@f/payments/lib/pending-checkout";
