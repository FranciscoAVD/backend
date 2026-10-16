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
 * @description Content for the email-verification email. Kept separate from `send.ts` (how to
 * send) and from `features/auth/lib/verification-email.ts` (the better-auth hook that adapts this
 * to that plugin's callback shape) - this file only knows how to build the message, not who it's
 * for or when it's sent.
 */
type VerificationEmailProps = {
  name: string;
  url: string;
  /** A public (not localhost) URL - email clients fetch images remotely, never a local path. */
  logoUrl?: string;
};

function VerificationEmail({ name, url, logoUrl }: VerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Verify your email</Preview>
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
          <Heading>Verify your email</Heading>
          <Text>{`Hi ${name},`}</Text>
          <Text>Confirm your email address to finish setting up your account.</Text>
          <Button href={url}>Verify email</Button>
          <Text>If you didn't create an account, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function verificationEmail(
  data: VerificationEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <VerificationEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: "Verify your email", html, text };
}
