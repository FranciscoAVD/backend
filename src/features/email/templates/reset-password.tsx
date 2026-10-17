import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";

/**
 * @description Content for the password-reset email. Kept separate from `send.ts` (how to send)
 * and from `features/auth/lib/reset-password-email.ts` (the better-auth hook that adapts this to
 * that plugin's callback shape) - this file only knows how to build the message, not who it's
 * for or when it's sent.
 */
type ResetPasswordEmailProps = {
  name: string;
  url: string;
  /** A public (not localhost) URL - email clients fetch images remotely, never a local path. */
  logoUrl?: string;
};

function ResetPasswordEmail({ name, url, logoUrl }: ResetPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your password</Preview>
      <Body>
        <Container>
          {logoUrl && (
            <Img
              src={logoUrl}
              width="200"
              height="69"
              alt="@vicstack/backend"
              style={{ margin: "0 auto" }}
            />
          )}
          <Heading>Reset your password</Heading>
          <Text>{`Hi ${name},`}</Text>
          <Text>We got a request to reset your password. Click below to choose a new one.</Text>
          <Button href={url}>Reset password</Button>
          <Text>If you didn't request this, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function resetPasswordEmail(
  data: ResetPasswordEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <ResetPasswordEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: "Reset your password", html, text };
}
