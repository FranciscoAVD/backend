import { env } from "@/env";
import type { Payment } from "@f/payments/lib/types";
import { paymentsRepo } from "@f/payments/repo";
import { ensureCustomer } from "@f/payments/services/account";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import {
  PENDING_CHECKOUT_TTL_SEC,
  CHECKOUT_SESSION_EXPIRY_SEC,
  getPendingCheckout,
  savePendingCheckout,
  removePendingCheckout,
  getResumableCheckout,
  reservePendingCheckout,
  releaseReservation,
  acquireCreateLock,
  releaseCreateLock,
  markProcessing as markCheckoutProcessing,
  markFailed as markCheckoutFailed,
  markExpired as markCheckoutExpired,
  CheckoutSlotLostError,
} from "@f/payments/lib/state/pending-checkout";
import { isUserDeleting } from "@f/payments/lib/state/deletion-guard";
import { encodeDurationDays, encodeOverlapping } from "@f/payments/lib/utils";
import { getCheckoutSessionParams } from "@f/payments/lib/checkout-extensions";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

type CheckoutUser = { userId: string; name: string; email: string };

export type CheckoutResult =
  | { kind: "created"; sessionId: string; url: string | null }
  | { kind: "resumed"; sessionId: string; url: string }
  | { kind: "owned"; existingPurchaseId: number }
  | { kind: "slot_taken" }
  | { kind: "deleting" }
  | { kind: "not_found" }
  | { kind: "wrong_type" };

/**
 * @description Creates a one-time Stripe Checkout Session and tracks it in Redis until Stripe
 * confirms the payment. The plan's `durationDays` and `overlapping` are snapshotted onto the
 * session's metadata here, at checkout time, so an admin edit made while the payment is still
 * settling can't change what this buyer gets. Exported (not barrel-listed) so its Stripe-param
 * details stay independently testable from `start`'s full orchestration. Not wrapped in try-catch
 * itself - a thrown error (anything other than `CheckoutSlotLostError`, which `start` handles)
 * propagates to the caller.
 */
export async function createCheckout(
  user: { userId: string; stripeCustomerId: string },
  plan: Payment.Plan,
  options: { reservation?: string } = {},
): Promise<{ sessionId: string; url: string | null }> {
  const extra = (await getCheckoutSessionParams({ user, plan })) ?? {};
  const { metadata: extraMetadata, payment_intent_data: extraPID, line_items: extraLineItems, ...rest } = extra;

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
    payment_intent_data: { ...extraPID, metadata: { ...extraPID?.metadata, ...metadata } },
    success_url: `${env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/checkout/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_EXPIRY_SEC,
  });

  const saved = await savePendingCheckout(
    session.id,
    { userId: user.userId, planId: plan.id, status: "open", url: session.url ?? undefined },
    PENDING_CHECKOUT_TTL_SEC,
    options.reservation,
  );

  if (!saved) {
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
 * @description The full `POST /checkout` flow: checks the plan, blocks a deleting account, then
 * either resumes an open session, reserves the (user, plan) slot (non-repeatable plans) or a
 * creation lock (repeatable plans), creates the Stripe Checkout Session, and re-checks the
 * deletion flag once more before handing back a payable session. Returns a structured `kind`
 * instead of an HTTP response - `route.ts` owns every status code and message.
 */
export async function start(
  user: CheckoutUser,
  input: { planId: number },
): Promise<CheckoutResult> {
  const plan = await paymentsRepo.plan.get.one({ id: input.planId });
  if (!plan || !plan.active) return { kind: "not_found" };
  if (plan.type !== "one_time") return { kind: "wrong_type" };

  if (await isUserDeleting(user.userId)) return { kind: "deleting" };

  let reservation: string | null = null;
  let createLock: string | null = null;
  const release = async () => {
    const [, releaseError] = await tryCatch(
      (async () => {
        if (reservation) await releaseReservation(user.userId, plan.id, reservation);
        if (createLock) await releaseCreateLock(user.userId, plan.id, createLock);
      })(),
    );
    if (releaseError)
      logger.warn(
        { err: releaseError, user: user.userId, plan: plan.id },
        "payments.checkout.release_reservation",
      );
  };

  const resume = async (): Promise<CheckoutResult | null> => {
    const [resumable, resumeError] = await tryCatch(getResumableCheckout(user.userId, plan.id));
    if (resumeError)
      logger.warn(
        { err: resumeError, user: user.userId, plan: plan.id },
        "payments.checkout.resume",
      );
    return resumable ? { kind: "resumed", sessionId: resumable.sessionId, url: resumable.url } : null;
  };

  const blockIfOwned = async (): Promise<CheckoutResult | null> => {
    const existing = await paymentsRepo.purchase.getBlocking({ userId: user.userId, planId: plan.id });
    if (!existing) return null;

    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "checkout_blocked_existing_purchase",
        userId: user.userId,
        planId: plan.id,
        existingPurchaseId: existing.id,
      }),
    );
    if (auditError)
      logger.warn(
        { err: auditError, user: user.userId, plan: plan.id },
        "payments.audit.write_failed",
      );
    return { kind: "owned", existingPurchaseId: existing.id };
  };

  if (!plan.repeatable) {
    const blocked = await blockIfOwned();
    if (blocked) return blocked;

    const token = await reservePendingCheckout(user.userId, plan.id);
    if (!token) {
      const resumed = await resume();
      if (resumed) return resumed;

      const [, auditError] = await tryCatch(
        paymentsRepo.audit.add({
          type: "checkout_blocked_pending_checkout",
          userId: user.userId,
          planId: plan.id,
        }),
      );
      if (auditError)
        logger.warn(
          { err: auditError, user: user.userId, plan: plan.id },
          "payments.audit.write_failed",
        );
      return { kind: "slot_taken" };
    }
    reservation = token;
  } else {
    const resumed = await resume();
    if (resumed) return resumed;

    const token = await acquireCreateLock(user.userId, plan.id);
    if (!token) return { kind: "slot_taken" };
    createLock = token;
  }

  // everything below holds the reservation/create-lock, which must always be released - on a
  // thrown error (a DB/Stripe call failing) just as much as on a normal return, or the slot sits
  // locked until RESERVATION_TTL_SEC expires it
  try {
    if (!plan.repeatable) {
      const blockedAfterReserve = await blockIfOwned();
      if (blockedAfterReserve) return blockedAfterReserve;
    }

    const stripeCustomerId = await ensureCustomer({
      id: user.userId,
      name: user.name,
      email: user.email,
    });

    const [res, error] = await tryCatch(
      createCheckout(
        { userId: user.userId, stripeCustomerId },
        plan,
        { reservation: reservation ?? undefined },
      ),
    );

    if (error) {
      if (error instanceof CheckoutSlotLostError) {
        logger.warn({ user: user.userId, plan: plan.id }, "payments.checkout.slot_lost");
        return { kind: "slot_taken" };
      }
      throw error;
    }

    // the deletion flag again, now the session exists: a deletion that started after the check
    // above may have listed the user's open sessions before this one existed
    const [deletingNow, recheckError] = await tryCatch(isUserDeleting(user.userId));
    if (recheckError)
      logger.warn({ err: recheckError, user: user.userId }, "payments.checkout.deletion_guard");
    if (deletingNow) {
      const [, expireError] = await tryCatch(expire(res.sessionId));
      if (expireError)
        logger.error(
          { err: expireError, user: user.userId, session: res.sessionId },
          "payments.checkout.deletion_guard.expire",
        );
      return { kind: "deleting" };
    }

    return { kind: "created", sessionId: res.sessionId, url: res.url };
  } finally {
    await release();
  }
}

/**
 * @description Resolves a checkout's status: the DB purchase once confirmed, otherwise the
 * pending Redis entry. Both are scoped to the user. Operation must be wrapped in try-catch
 */
export async function status(
  checkout: { userId: string } & Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<Payment.Purchase["status"] | "open" | "processing" | "failed" | "expired" | null> {
  const purchase = await paymentsRepo.purchase.get.bySession(checkout);
  if (purchase) return purchase.status;

  const pending = await getPendingCheckout(checkout.stripeCheckoutSessionId);
  if (pending && pending.userId === checkout.userId) return pending.status;

  return null;
}

/**
 * @description Expires a one-time Checkout Session this app created and drops its pending entry.
 * Operation must be wrapped in try-catch
 */
export async function expire(sessionId: string): Promise<void> {
  await getPaymentProcessor().checkout.sessions.expire(sessionId);
  await removePendingCheckout(sessionId);
}

export const markProcessing = markCheckoutProcessing;
export const markFailed = markCheckoutFailed;
export const markExpired = markCheckoutExpired;
