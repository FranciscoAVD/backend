import { sendEmail } from "@f/email/send";
import { refundConfirmationEmail } from "@f/email/templates/refund-confirmation";
import { paymentsRepo } from "@f/payments/repo";
import { logger } from "@/lib/logger";

// Set once a public (not localhost) URL for the logo exists - email clients fetch images
// remotely, so this can't just point at this server. Until then, the template renders with no
// logo rather than a broken image icon.
const LOGO_URL: string | undefined = undefined;

/**
 * @description Sends the refund-confirmation email, called from `services/fulfillment.ts` only
 * on a genuine transition into "refunded" (not a redelivered webhook re-confirming one). Looks
 * the buyer's contact up from the DB rather than trusting a Stripe object's own (nullable) data.
 * Logs and returns, rather than throwing, if the contact lookup comes back null - shouldn't be
 * possible in practice, but must never be the reason a webhook response or refund request fails.
 */
export async function sendRefundConfirmationEmail(data: {
  userId: string;
  planName: string;
  amountRefunded: number;
  currency: string;
}): Promise<void> {
  const contact = await paymentsRepo.user.getContact({ userId: data.userId });
  if (!contact) {
    logger.warn({ user: data.userId }, "payments.refund_confirmation_email.user_missing");
    return;
  }

  const { subject, html, text } = await refundConfirmationEmail({
    name: contact.name,
    planName: data.planName,
    amountRefunded: data.amountRefunded,
    currency: data.currency,
    logoUrl: LOGO_URL,
  });
  await sendEmail({ to: contact.email, subject, html, text });
}
