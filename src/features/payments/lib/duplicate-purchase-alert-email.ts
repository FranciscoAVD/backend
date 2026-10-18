import { duplicatePurchaseAlertEmail } from "@f/email/templates/duplicate-purchase-alert";
import { paymentsRepo } from "@f/payments/repo";
import { sendAdminAlert } from "@f/payments/lib/admin-alert";

/**
 * @description Alerts every admin that a buyer was charged for a non-repeatable plan they already
 * own - called from `services/fulfillment.ts`'s `confirm` once, when the duplicate purchase is first
 * recorded (not on a redelivery of the same event). Until this existed, the only trace was a
 * `duplicate_purchase_confirmed` audit row and an error log line, so a double charge sat unnoticed
 * unless someone went looking. Logs and returns, rather than throwing, if there's no admin to tell -
 * must never be the reason a webhook response fails.
 */
export async function sendDuplicatePurchaseAlert(data: {
  planName: string;
  buyerUserId: string;
  existingPurchaseId: number;
  duplicatePurchaseId: number;
  stripeCheckoutSessionId: string;
  amountTotal: number;
  currency: string;
}): Promise<void> {
  const buyer = await paymentsRepo.user.getContact({ userId: data.buyerUserId });
  const message = await duplicatePurchaseAlertEmail({ ...data, buyerEmail: buyer?.email ?? null });
  await sendAdminAlert(message, "payments.duplicate_alert", {
    session: data.stripeCheckoutSessionId,
  });
}
