import type Stripe from "stripe";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";
import type { PendingCheckout } from "@f/payments/lib/pending-checkout";
import {
  getPendingCheckout,
  markProcessing,
  removePendingCheckout,
} from "@f/payments/lib/pending-checkout";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import {
  isAllowedEvent,
  purchaseStatusFromDispute,
  purchaseUpdateFromCharge,
} from "@f/payments/lib/utils";
import { getPaymentProcessor } from "@f/payments/payment";

const idOf = (ref: string | { id: string } | null) =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

/**
 * @description Who bought what: the pending Redis entry, falling back to the session
 * metadata set in `createCheckout` so a confirmed payment is never dropped.
 */
async function resolveOwner(
  session: Stripe.Checkout.Session,
): Promise<Pick<PendingCheckout, "userID" | "planID"> | null> {
  const [pending, error] = await tryCatch(getPendingCheckout(session.id));
  if (pending) return { userID: pending.userID, planID: pending.planID };

  logger.warn(
    { err: error ?? undefined, session: session.id },
    "payments.webhook.pending_missing",
  );
  const userID = session.metadata?.userID;
  const planID = Number(session.metadata?.planID);
  return userID && Number.isInteger(planID) ? { userID, planID } : null;
}

export async function confirmCheckout(session: Stripe.Checkout.Session) {
  const owner = await resolveOwner(session);
  if (!owner) {
    logger.error(
      {
        err: new Error("Paid checkout has no pending entry or metadata"),
        session: session.id,
      },
      "payments.webhook.metadata",
    );
    return;
  }

  await addPurchase(
    { userID: owner.userID },
    {
      planID: owner.planID,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: idOf(session.payment_intent),
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? "",
    },
  );

  // the purchase is already stored; a leftover key just expires with its TTL
  const [, error] = await tryCatch(removePendingCheckout(session.id));
  if (error)
    logger.warn({ err: error, session: session.id }, "payments.webhook.cleanup");
}

async function updateByCharge(
  paymentIntent: string | { id: string } | null,
  update: Parameters<typeof updatePurchaseByPaymentIntent>[1],
) {
  const stripePaymentIntentId = idOf(paymentIntent);
  if (!stripePaymentIntentId) return;

  const updated = await updatePurchaseByPaymentIntent(
    { stripePaymentIntentId },
    update,
  );
  if (updated) return;

  // one of our checkouts whose purchase isn't recorded yet (its completed event is still
  // being retried): fail so Stripe retries this one too instead of dropping it. Other
  // charges without a purchase (e.g. subscription invoices) are ignored.
  const intent = await getPaymentProcessor().paymentIntents.retrieve(
    stripePaymentIntentId,
  );
  if (intent.metadata.planID)
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
          await markProcessing(session.id);
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
        await removePendingCheckout(session.id);
        return;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        if (session.mode === "payment") await removePendingCheckout(session.id);
        return;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        await updateByCharge(
          charge.payment_intent,
          purchaseUpdateFromCharge(charge),
        );
        return;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object;
        await updateByCharge(dispute.payment_intent, {
          status: purchaseStatusFromDispute(dispute),
        });
        return;
      }
      case "charge.dispute.closed": {
        const dispute = event.data.object;
        await updateByCharge(dispute.payment_intent, {
          status: purchaseStatusFromDispute(dispute),
        });
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
