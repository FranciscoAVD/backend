import { env } from "@/env";
import { logger } from "@/lib/logger";
import { getEmailClient } from "@f/email/lib/client";

export type Email = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/**
 * @description Sends an email via Resend. Logs and swallows a failure rather than throwing -
 * callers like better-auth's `sendVerificationEmail` hook run inline in a request (sign-up), and
 * Resend being down shouldn't fail that request; the user can always ask for the email again.
 */
export async function sendEmail(message: Email): Promise<void> {
  const { error } = await getEmailClient().emails.send({
    from: env.EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  if (error)
    logger.error(
      { err: error, to: message.to, subject: message.subject },
      "email.send_failed",
    );
}
