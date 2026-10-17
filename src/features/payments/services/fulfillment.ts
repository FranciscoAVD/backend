import Stripe from "stripe";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import { paymentsRepo } from "@f/payments/repo";
import { getPendingCheckout, removePendingCheckout } from "@f/payments/lib/state/pending-checkout";
import { decodeDurationDays, decodeOverlapping } from "@f/payments/lib/utils";
import { resolveChargeState } from "@f/payments/lib/stripe/charge-state";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import { sendPurchaseConfirmationEmail } from "@f/payments/lib/purchase-confirmation-email";
import type { Payment } from "@f/payments/lib/types";

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

  if (inserted) {
    const [, emailError] = await tryCatch(
      sendPurchaseConfirmationEmail({
        userId: inserted.userId ?? owner.userId,
        planName: plan.name,
        amountTotal: inserted.amountTotal,
        currency: inserted.currency,
      }),
    );
    if (emailError)
      logger.warn(
        { err: emailError, session: session.id },
        "payments.purchase_confirmation_email.send_failed",
      );
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

export type RefundResult =
  | { kind: "not_found" }
  | { kind: "no_payment_intent" } // a $0 purchase - nothing was ever charged
  | { kind: "already_refunded" }
  | { kind: "charge_disputed" }
  | { kind: "amount_exceeds_refundable" }
  | { kind: "refunded"; purchase: Payment.Purchase };

/**
 * @description Issues a refund through Stripe for a purchase, then pulls the resulting
 * refund/dispute state back the same way the webhook does (`syncCharge`/`resolveChargeState`),
 * rather than recomputing the amount/status math here and risking it drifting from that logic.
 *
 * The Stripe call carries an idempotency key derived from (purchase, amount, reason): a retry of
 * the exact same request - whether the admin resubmits after seeing a stale error, or anything
 * else - lands on Stripe's side as the same refund, not a second one. This is what actually
 * prevents a double refund; a partial refund alone doesn't flip `status` to "refunded", so the
 * already-refunded guard above can't catch a retry on its own. (Trade-off: two genuinely separate
 * refunds of the same purchase with the same amount and reason, within Stripe's idempotency key
 * window, would collide too - indistinguishable from a retry; vary the amount or reason to avoid
 * it.)
 *
 * The audit entry is written right after the Stripe call succeeds, before the sync below, so a
 * record exists regardless of what happens next - and a failed sync (a slow/down Stripe read, or
 * `syncPurchaseCharge` giving up) is logged as a warning, not thrown: the money already moved, so
 * that's not a failure to report, and the `charge.refunded`/`charge.refund.updated` webhook will
 * converge the row once it arrives.
 *
 * Two known Stripe failure modes get their own result instead of bubbling up as a generic
 * failure: refunding a disputed charge (`charge_disputed`), and asking for more than what's left
 * to refund (`amount_too_large`, or any error naming `amount` as the bad param). Anything else
 * still throws, for the route's catch-all to turn into a 500. Operation must be wrapped in
 * try-catch
 */
export async function refund(
  target: Pick<Payment.Purchase, "id">,
  admin: { id: string },
  options: { amount?: number; reason?: Stripe.RefundCreateParams.Reason } = {},
): Promise<RefundResult> {
  const purchase = await paymentsRepo.purchase.get.byId(target);
  if (!purchase) return { kind: "not_found" };
  if (!purchase.stripePaymentIntentId) return { kind: "no_payment_intent" };
  if (purchase.status === "refunded") return { kind: "already_refunded" };

  const stripe = getPaymentProcessor();
  const idempotencyKey = `refund:${purchase.id}:${options.amount ?? "full"}:${options.reason ?? "none"}`;
  try {
    await stripe.refunds.create(
      {
        payment_intent: purchase.stripePaymentIntentId,
        ...(options.amount != null ? { amount: options.amount } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof Stripe.errors.StripeInvalidRequestError) {
      if (e.code === "charge_disputed") return { kind: "charge_disputed" };
      if (e.code === "amount_too_large" || e.param === "amount")
        return { kind: "amount_exceeds_refundable" };
    }
    throw e;
  }

  const [, auditError] = await tryCatch(
    paymentsRepo.audit.add({
      type: "refund_issued",
      userId: purchase.userId,
      planId: purchase.planId,
      existingPurchaseId: purchase.id,
      stripeCheckoutSessionId: purchase.stripeCheckoutSessionId,
      details: { issuedBy: admin.id, amount: options.amount ?? null, reason: options.reason ?? null },
    }),
  );
  if (auditError)
    logger.warn({ err: auditError, purchase: purchase.id }, "payments.audit.write_failed");

  const [synced, syncError] = await tryCatch(
    paymentsRepo.purchase.syncCharge({ stripePaymentIntentId: purchase.stripePaymentIntentId }, () =>
      resolveChargeState(purchase.stripePaymentIntentId!),
    ),
  );
  if (syncError) {
    logger.warn({ err: syncError, purchase: purchase.id }, "payments.purchase.refund_sync_failed");
    return { kind: "refunded", purchase };
  }

  return {
    kind: "refunded",
    purchase: synced.found && synced.to ? { ...purchase, ...synced.to } : purchase,
  };
}
