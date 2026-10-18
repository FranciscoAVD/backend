import { sendEmail } from "@f/email/send";
import { paymentsRepo } from "@f/payments/repo";
import { logger } from "@/lib/logger";

/**
 * @description Sends one already-rendered alert to every admin (`paymentsRepo.user.getAdminContacts`:
 * every non-banned user whose role list includes `admin`) - for payment events a person has to act
 * on, which an audit row or a log line nobody is watching wouldn't get acted on. Logs and returns,
 * rather than throwing, if there's no admin to tell; `sendEmail` itself never throws either, so an
 * alert can never be the reason a webhook response or a reconciler run fails.
 * @param message the rendered email
 * @param context logged alongside a missing-admins error, to say what went unannounced
 * @param scope the dot-scoped log name for that error, e.g. "payments.duplicate_alert"
 */
export async function sendAdminAlert(
  message: { subject: string; html: string; text: string },
  scope: string,
  context: Record<string, unknown>,
): Promise<void> {
  const admins = await paymentsRepo.user.getAdminContacts();
  if (admins.length === 0) {
    logger.error(context, `${scope}.no_admins`);
    return;
  }
  await Promise.all(admins.map((admin) => sendEmail({ to: admin.email, ...message })));
}
