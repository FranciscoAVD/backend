import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import { paymentsRepo } from "@f/payments/repo";
import { getPendingCheckout, removePendingCheckout } from "@f/payments/lib/state/pending-checkout";
import { decodeDurationDays, decodeOverlapping } from "@f/payments/lib/utils";
import { resolveChargeState } from "@f/payments/lib/stripe/charge-state";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";

const idOf = (ref: string | { id: string } | null) =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

/**
 * @description Who bought what: Stripe's own session metadata, set once at checkout time -
 * the source of truth, since it's what Stripe itself guarantees for this session. The pending
 * Redis entry is still read, but only to cross-check: if it exists and disagrees with the
 * metadata on `userId` or `planId`, that's suspicious enough to refuse rather than silently pick
 * one (see `confirm`). Redis is never used to supply or override the owner - a session with no
 * resolvable metadata returns null regardless of whether a pending entry exists.
 */
async function resolveOwner(
  session: Stripe.Checkout.Session,
): Promise<{ userId: string; planId: number } | null> {
  const userId = session.metadata?.userId;
  const planId = Number(session.metadata?.planId);
  const fromMetadata = userId && Number.isInteger(planId) ? { userId, planId } : null;

  const [pending, error] = await tryCatch(getPendingCheckout(session.id));
  if (!pending && error)
    logger.warn({ err: error, session: session.id }, "payments.webhook.pending_lookup_failed");

  if (
    pending &&
    fromMetadata &&
    (pending.userId !== fromMetadata.userId || pending.planId !== fromMetadata.planId)
  ) {
    logger.error(
      {
        session: session.id,
        metadataOwner: fromMetadata,
        pendingOwner: { userId: pending.userId, planId: pending.planId },
      },
      "payments.webhook.owner_mismatch",
    );
    throw new Error(
      "Checkout session owner mismatch between Stripe metadata and the pending Redis entry",
    );
  }

  return fromMetadata;
}

/**
 * @description Records a confirmed payment. Both drop cases below throw rather than return, so
 * the caller (the webhook dispatcher, or the reconciler) sees the failure instead of a
 * silently-swallowed success.
 * @param session the paid Checkout Session
 * @param paidAt when the payment actually succeeded - the access window starts here. Defaults to
 * the session's own creation time, only for a caller with nothing better.
 * @returns true if this call inserted the purchase row; false if it was already recorded or the
 * session isn't one of ours.
 */
export async function confirm(
  session: Stripe.Checkout.Session,
  paidAt: Date = new Date(session.created * 1000),
): Promise<boolean> {
  const owner = await resolveOwner(session);
  if (!owner) {
    if (!session.metadata?.planId) {
      logger.warn({ session: session.id }, "payments.webhook.not_ours");
      return false;
    }
    logger.error(
      { err: new Error("Paid checkout has no pending entry or metadata"), session: session.id },
      "payments.webhook.metadata",
    );
    throw new Error("Paid checkout has no pending entry or metadata");
  }

  const plan = await paymentsRepo.plan.get.one({ id: owner.planId });
  if (!plan) {
    logger.error(
      { err: new Error("Purchased plan no longer exists"), session: session.id, plan: owner.planId },
      "payments.webhook.plan_missing",
    );
    throw new Error("Purchased plan no longer exists");
  }

  const snapshot = decodeDurationDays(session.metadata?.durationDays);
  if (!snapshot)
    logger.warn(
      { session: session.id, plan: owner.planId },
      "payments.webhook.duration_snapshot_missing",
    );

  const inserted = await paymentsRepo.purchase.add(
    { userId: owner.userId },
    {
      planId: owner.planId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: idOf(session.payment_intent),
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? "",
    },
    {
      ...(snapshot ?? { durationDays: plan.durationDays }),
      overlapping:
        decodeOverlapping(session.metadata?.overlapping)?.overlapping ?? plan.overlapping,
    },
    paidAt,
  );

  const blocking =
    inserted && !plan.repeatable && inserted.userId !== null
      ? await paymentsRepo.purchase.getBlocking(
          { userId: owner.userId, planId: owner.planId },
          { stripeCheckoutSessionId: session.id },
        )
      : null;

  if (blocking && inserted) {
    logger.error(
      {
        err: new Error("Paid checkout for an already-owned non-repeatable plan"),
        session: session.id,
        user: owner.userId,
        plan: owner.planId,
        existingPurchase: blocking.id,
      },
      "payments.webhook.duplicate_purchase",
    );
    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "duplicate_purchase_confirmed",
        userId: owner.userId,
        planId: owner.planId,
        existingPurchaseId: blocking.id,
        stripeCheckoutSessionId: session.id,
        details: {
          stripePaymentIntentId: idOf(session.payment_intent),
          amountTotal: session.amount_total ?? 0,
        },
      }),
    );
    if (auditError)
      logger.warn({ err: auditError, session: session.id }, "payments.audit.write_failed");
  }

  const [, error] = await tryCatch(removePendingCheckout(session.id));
  if (error) logger.warn({ err: error, session: session.id }, "payments.webhook.cleanup");

  return inserted !== null;
}

/**
 * @description Syncs a purchase's refund/dispute state from a `charge.*` webhook event, or throws
 * so Stripe retries if the purchase isn't recorded yet. Operation must be wrapped in try-catch
 */
export async function syncCharge(
  paymentIntent: string | { id: string } | null,
): Promise<void> {
  const stripePaymentIntentId = idOf(paymentIntent);
  if (!stripePaymentIntentId) return;

  const synced = await paymentsRepo.purchase.syncCharge({ stripePaymentIntentId }, () =>
    resolveChargeState(stripePaymentIntentId),
  );
  if (synced.found) return;

  const intent = await getPaymentProcessor().paymentIntents.retrieve(stripePaymentIntentId);
  if (intent.metadata.planId)
    throw new Error("Purchase not recorded yet for this payment intent");
}
