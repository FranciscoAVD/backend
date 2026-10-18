import { refundReversedAlertEmail } from "@f/email/templates/refund-reversed-alert";
import { paymentsRepo } from "@f/payments/repo";
import { sendAdminAlert } from "@f/payments/lib/admin-alert";

/**
 * @description Alerts every admin that a purchase's refunded amount went down - a refund Stripe
 * accepted (as pending) later failed or was canceled. By then the buyer has usually had the
 * refund-confirmation email and the audit log says `refund_issued`, so without this nobody learns
 * the money never moved. Called from `services/fulfillment.ts`'s `alertIfRefundReversed`, once per
 * sync that actually lowered the amount. Never throws for want of an admin (see `sendAdminAlert`).
 */
export async function sendRefundReversedAlert(data: {
  purchaseId: number;
  planName: string;
  buyerUserId: string | null;
  stripePaymentIntentId: string;
  refundedBefore: number;
  refundedAfter: number;
  currency: string;
}): Promise<void> {
  const buyer = data.buyerUserId
    ? await paymentsRepo.user.getContact({ userId: data.buyerUserId })
    : null;
  const message = await refundReversedAlertEmail({ ...data, buyerEmail: buyer?.email ?? null });
  await sendAdminAlert(message, "payments.refund_reversed_alert", {
    purchase: data.purchaseId,
  });
}
