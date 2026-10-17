import { sendEmail } from "@f/email/send";
import { purchaseConfirmationEmail } from "@f/email/templates/purchase-confirmation";
import { paymentsRepo } from "@f/payments/repo";
import { logger } from "@/lib/logger";

// Set once a public (not localhost) URL for the logo exists - email clients fetch images
// remotely, so this can't just point at this server. Until then, the template renders with no
// logo rather than a broken image icon.
const LOGO_URL: string | undefined = undefined;

/**
 * @description Sends the purchase-confirmation (receipt) email, called from
 * `services/fulfillment.ts`'s `confirm()` only on a purchase's first insert - a webhook
 * redelivery of an already-recorded session must never re-send this. Looks the buyer's contact
 * up from the DB rather than trusting the Stripe session's own (nullable) `customer_details`.
 * Logs and returns, rather than throwing, if the contact lookup comes back null - shouldn't be
 * possible in practice, but must never be the reason a webhook response fails.
 */
export async function sendPurchaseConfirmationEmail(data: {
  userId: string;
  planName: string;
  amountTotal: number;
  currency: string;
}): Promise<void> {
  const contact = await paymentsRepo.user.getContact({ userId: data.userId });
  if (!contact) {
    logger.warn({ user: data.userId }, "payments.purchase_confirmation_email.user_missing");
    return;
  }

  const { subject, html, text } = await purchaseConfirmationEmail({
    name: contact.name,
    planName: data.planName,
    amountTotal: data.amountTotal,
    currency: data.currency,
    logoUrl: LOGO_URL,
  });
  await sendEmail({ to: contact.email, subject, html, text });
}
