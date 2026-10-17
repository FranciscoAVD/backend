import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import { formatAmount } from "@f/email/lib/format-amount";

/**
 * @description Content for the refund-confirmation email. Kept separate from `send.ts` (how to
 * send) and from `features/payments/lib/refund-confirmation-email.ts` (the fulfillment hook that
 * adapts this to that caller's data) - this file only knows how to build the message, not who
 * it's for or when it's sent.
 */
type RefundConfirmationEmailProps = {
  name: string;
  planName: string;
  /** Minor units (e.g. cents) - the amount of *this* refund, not the purchase's running total. */
  amountRefunded: number;
  /** ISO currency code, case-insensitive. */
  currency: string;
  /** A public (not localhost) URL - email clients fetch images remotely, never a local path. */
  logoUrl?: string;
};

function RefundConfirmationEmail({
  name,
  planName,
  amountRefunded,
  currency,
  logoUrl,
}: RefundConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your refund has been processed</Preview>
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
          <Heading>Your refund has been processed</Heading>
          <Text>{`Hi ${name},`}</Text>
          <Text>{`We've processed a refund for your purchase of ${planName}.`}</Text>
          <Text>{`Amount refunded: ${formatAmount(amountRefunded, currency)}`}</Text>
          <Text>It may take a few business days to appear on your statement.</Text>
          <Text>If you have any questions about this refund, just reply to this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function refundConfirmationEmail(
  data: RefundConfirmationEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <RefundConfirmationEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: "Your refund has been processed", html, text };
}
