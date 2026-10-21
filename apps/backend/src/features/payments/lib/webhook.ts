import type Stripe from "stripe";
import { logger } from "@backend/lib/logger";
import { paymentsServices } from "@backend/f/payments/services";
import { isAllowedEvent } from "@backend/f/payments/lib/utils";

/**
 * @description When Stripe recorded the payment's success: the event's own `created`, which stays
 * the same across every redelivery of it.
 */
const paidAtOf = (event: Stripe.Event) => new Date(event.created * 1000);

/**
 * @description `onEvent` hook for better-auth's stripe plugin. Handles one-time payments:
 * in-flight checkouts live in the `checkout` table and a `purchase` row is only written once Stripe
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
          await paymentsServices.checkout.markProcessing(session.id);
          return;
        }
        await paymentsServices.fulfillment.confirm(session, paidAtOf(event));
        return;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        if (session.mode === "payment")
          await paymentsServices.fulfillment.confirm(session, paidAtOf(event));
        return;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object;
        if (session.mode !== "payment") return;
        logger.warn({ session: session.id }, "payments.webhook.async_failed");
        await paymentsServices.checkout.markFailed(session.id);
        return;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        if (session.mode === "payment")
          await paymentsServices.checkout.markExpired(session.id);
        return;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        await paymentsServices.fulfillment.syncCharge(charge.payment_intent);
        return;
      }
      case "charge.refund.updated": {
        const refund = event.data.object;
        await paymentsServices.fulfillment.syncCharge(refund.payment_intent);
        return;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object;
        await paymentsServices.fulfillment.syncCharge(dispute.payment_intent);
        return;
      }
      case "charge.dispute.closed": {
        const dispute = event.data.object;
        await paymentsServices.fulfillment.syncCharge(dispute.payment_intent);
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
