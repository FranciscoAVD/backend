import { sendEmail } from "@backend/f/email/send";
import { resetPasswordEmail } from "@backend/f/email/templates/reset-password";

// Set once a public (not localhost) URL for the logo exists - email clients fetch images
// remotely, so this can't just point at this server. Until then, the template renders with no
// logo rather than a broken image icon.
const LOGO_URL: string | undefined = undefined;

/**
 * @description better-auth's `emailAndPassword.sendResetPassword` hook, wired in `auth.ts`. Sent
 * whenever `/request-password-reset` is called. `url` is better-auth's own link (this app's
 * `/reset-password`, token included) - nothing to build here; the message content itself lives
 * in `features/email/templates/reset-password.tsx`.
 */
export async function sendResetPasswordEmail(data: {
  user: { email: string; name: string };
  url: string;
  token: string;
}): Promise<void> {
  const { subject, html, text } = await resetPasswordEmail({
    name: data.user.name,
    url: data.url,
    logoUrl: LOGO_URL,
  });
  await sendEmail({ to: data.user.email, subject, html, text });
}
