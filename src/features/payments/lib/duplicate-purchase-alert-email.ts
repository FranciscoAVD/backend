import { sendEmail } from "@f/email/send";
import { duplicatePurchaseAlertEmail } from "@f/email/templates/duplicate-purchase-alert";
import { paymentsRepo } from "@f/payments/repo";
import { logger } from "@/lib/logger";

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
  const [admins, buyer] = await Promise.all([
    paymentsRepo.user.getAdminContacts(),
    paymentsRepo.user.getContact({ userId: data.buyerUserId }),
  ]);
  if (admins.length === 0) {
    logger.error(
      { session: data.stripeCheckoutSessionId },
      "payments.duplicate_alert.no_admins",
    );
    return;
  }

  const { subject, html, text } = await duplicatePurchaseAlertEmail({
    ...data,
    buyerEmail: buyer?.email ?? null,
  });
  await Promise.all(admins.map((admin) => sendEmail({ to: admin.email, subject, html, text })));
}
