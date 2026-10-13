import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import type { PendingCheckout } from "@f/payments/lib/pending-checkout";
import { paymentsRepo } from "@f/payments/repo";
import { isAllowedEvent, decodeDurationDays } from "@f/payments/lib/utils";
import { resolveChargeState } from "@f/payments/lib/charge-state";
import { getPaymentProcessor } from "@f/payments/payment";

const idOf = (ref: string | { id: string } | null) =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

/**
 * @description Who bought what: the pending Redis entry, falling back to the session
 * metadata set in `createCheckout` so a confirmed payment is never dropped.
 */
async function resolveOwner(
  session: Stripe.Checkout.Session,
): Promise<Pick<PendingCheckout, "userId" | "planId"> | null> {
  const [pending, error] = await tryCatch(
    paymentsRepo.checkout.getPending(session.id),
  );
  if (pending) return { userId: pending.userId, planId: pending.planId };

  logger.warn(
    { err: error ?? undefined, session: session.id },
    "payments.webhook.pending_missing",
  );
  const userId = session.metadata?.userId;
  const planId = Number(session.metadata?.planId);
  return userId && Number.isInteger(planId) ? { userId, planId } : null;
}

/**
 * @description Records a confirmed payment. Both drop cases below throw rather than return, so
 * the plugin answers non-2xx and Stripe retries/eventually flags the endpoint as failing in its
 * dashboard - a silently-swallowed 200 would mean a payment with no trace of ever going wrong.
 * @returns true if this call inserted the purchase row; false if it was already recorded (a
 * redelivery, or the webhook and the reconciler racing) or the session isn't one of ours. Lets
 * the reconciler count only inserts that actually happened.
 */
export async function confirmCheckout(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  const owner = await resolveOwner(session);
  if (!owner) {
    // no pending entry and no planId metadata at all - not one of ours (e.g. a Payment
    // Link, a Dashboard-created session, another integration on the same Stripe account),
    // not a dropped payment. Same ownership test updateByCharge/reconcile.ts already use.
    if (!session.metadata?.planId) {
      logger.warn({ session: session.id }, "payments.webhook.not_ours");
      return false;
    }
    logger.error(
      {
        err: new Error("Paid checkout has no pending entry or metadata"),
        session: session.id,
      },
      "payments.webhook.metadata",
    );
    throw new Error("Paid checkout has no pending entry or metadata");
  }

  const plan = await paymentsRepo.plan.get({ id: owner.planId });
  if (!plan) {
    logger.error(
      {
        err: new Error("Purchased plan no longer exists"),
        session: session.id,
        plan: owner.planId,
      },
      "payments.webhook.plan_missing",
    );
    throw new Error("Purchased plan no longer exists");
  }

  // the realistic "two tabs" race is already blocked before a Checkout Session is even created
  // (see paymentsRepo.checkout.hasPending in route.ts); this re-check catches the narrower one it can't -
  // two webhook deliveries confirming two separately-started sessions for the same plan. The
  // money is already taken either way, so the purchase is still recorded (never silently dropped,
  // same reasoning as the FK-violation case in addPurchase) - this just flags it for review.
  if (!plan.repeatable) {
    const blocking = await paymentsRepo.purchase.getBlockingByPlan(
      { userId: owner.userId, planId: owner.planId },
      { stripeCheckoutSessionId: session.id },
    );
    if (blocking) {
      logger.error(
        {
          err: new Error(
            "Paid checkout for an already-owned non-repeatable plan",
          ),
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
        logger.warn(
          { err: auditError, session: session.id },
          "payments.audit.write_failed",
        );
      // fall through: the purchase row is still recorded below
    }
  }

  // the duration snapshotted at checkout time, so an admin edit made while this payment was
  // settling doesn't change what the buyer gets; sessions created before the snapshot existed
  // fall back to the plan's current setting (the old behavior)
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
    snapshot ?? { durationDays: plan.durationDays },
    new Date(session.created * 1000),
  );

  // the purchase is already stored; a leftover key just expires with its TTL
  const [, error] = await tryCatch(paymentsRepo.checkout.removePending(session.id));
  if (error)
    logger.warn(
      { err: error, session: session.id },
      "payments.webhook.cleanup",
    );

  return inserted !== null;
}

async function updateByCharge(
  paymentIntent: string | { id: string } | null,
): Promise<void> {
  const stripePaymentIntentId = idOf(paymentIntent);
  if (!stripePaymentIntentId) return;

  const target = await resolveChargeState(stripePaymentIntentId);
  if (!target) return;

  const updated = await paymentsRepo.purchase.updateByPaymentIntent(
    { stripePaymentIntentId },
    target,
  );
  if (updated) return;

  // one of our checkouts whose purchase isn't recorded yet (its completed event is still
  // being retried): fail so Stripe retries this one too instead of dropping it. Other
  // charges without a purchase (e.g. subscription invoices) are ignored.
  const intent = await getPaymentProcessor().paymentIntents.retrieve(
    stripePaymentIntentId,
  );
  if (intent.metadata.planId)
    throw new Error("Purchase not recorded yet for this payment intent");
}

/**
 * @description `onEvent` hook for better-auth's stripe plugin. Handles one-time payments:
 * in-flight checkouts live in Redis and a `purchase` row is only written once Stripe
 * confirms the payment. Errors are rethrown so the plugin answers 400 and Stripe retries.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  if (!isAllowedEvent(event)) return;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "payment") return;
        if (session.payment_status === "unpaid") {
          await paymentsRepo.checkout.markProcessing(session.id);
          return;
        }
        await confirmCheckout(session);
        return;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        if (session.mode === "payment") await confirmCheckout(session);
        return;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object;
        if (session.mode !== "payment") return;
        logger.warn({ session: session.id }, "payments.webhook.async_failed");
        await paymentsRepo.checkout.markFailed(session.id);
        return;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        if (session.mode === "payment")
          await paymentsRepo.checkout.markExpired(session.id);
        return;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        await updateByCharge(charge.payment_intent);
        return;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object;
        await updateByCharge(dispute.payment_intent);
        return;
      }
      case "charge.dispute.closed": {
        const dispute = event.data.object;
        await updateByCharge(dispute.payment_intent);
        return;
      }
      default:
        // compile error if an ALLOWED_EVENTS entry has no case above
        event satisfies never;
    }
  } catch (error) {
    logger.error(
      { err: error, event: event.id, type: event.type },
      "payments.webhook",
    );
    throw error;
  }
}
