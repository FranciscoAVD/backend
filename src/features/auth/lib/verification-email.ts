import { sendEmail } from "@/lib/email";

/**
 * @description better-auth's `emailVerification.sendVerificationEmail` hook, wired in `auth.ts`.
 * Sent automatically on sign-up (`sendOnSignUp: true`) and whenever `/send-verification-email`
 * is called again. `url` is better-auth's own link (this app's `/api/auth/verify-email`, token
 * included) - nothing to build here.
 */
export async function sendVerificationEmail(data: {
  user: { email: string; name: string };
  url: string;
}): Promise<void> {
  await sendEmail({
    to: data.user.email,
    subject: "Verify your email",
    html: verificationEmailHtml(data.user.name, data.url),
  });
}

function verificationEmailHtml(name: string, url: string): string {
  return `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Confirm your email address to finish setting up your account.</p>
    <p><a href="${url}">Verify email</a></p>
    <p>If you didn't create an account, you can ignore this email.</p>
  `;
}

// the recipient's own display name, echoed back into an email only they receive - not a
// cross-user injection risk, but cheap to escape so a name containing HTML doesn't break the
// email's own markup
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
