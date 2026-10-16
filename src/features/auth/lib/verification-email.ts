import { sendEmail } from "@f/email/send";
import { verificationEmail } from "@f/email/templates/verification";

/**
 * @description better-auth's `emailVerification.sendVerificationEmail` hook, wired in `auth.ts`.
 * Sent automatically on sign-up (`sendOnSignUp: true`) and whenever `/send-verification-email`
 * is called again. `url` is better-auth's own link (this app's `/api/auth/verify-email`, token
 * included) - nothing to build here; the message content itself lives in
 * `features/email/templates/verification.tsx`.
 */
export async function sendVerificationEmail(data: {
  user: { email: string; name: string };
  url: string;
}): Promise<void> {
  const { subject, html, text } = await verificationEmail({
    name: data.user.name,
    url: data.url,
  });
  await sendEmail({ to: data.user.email, subject, html, text });
}
