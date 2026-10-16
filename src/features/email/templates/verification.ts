/**
 * @description Content for the email-verification email. Kept separate from `send.ts` (how to
 * send) and from `features/auth/lib/verification-email.ts` (the better-auth hook that adapts this
 * to that plugin's callback shape) - this file only knows how to build the message, not who it's
 * for or when it's sent.
 */
export function verificationEmail(data: { name: string; url: string }): {
  subject: string;
  html: string;
} {
  return {
    subject: "Verify your email",
    html: `
      <p>Hi ${escapeHtml(data.name)},</p>
      <p>Confirm your email address to finish setting up your account.</p>
      <p><a href="${data.url}">Verify email</a></p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `,
  };
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
