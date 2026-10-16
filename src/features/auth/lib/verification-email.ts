import { sendEmail } from "@f/email/send";
import { verificationEmail } from "@f/email/templates/verification";

// Set once a public (not localhost) URL for the logo exists - email clients fetch images
// remotely, so this can't just point at this server. Until then, the template renders with no
// logo rather than a broken image icon.
const LOGO_URL: string | undefined = undefined;

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
    logoUrl: LOGO_URL,
  });
  await sendEmail({ to: data.user.email, subject, html, text });
}
