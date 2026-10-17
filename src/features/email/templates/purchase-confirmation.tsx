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
 * @description Content for the purchase-confirmation (receipt) email. Kept separate from
 * `send.ts` (how to send) and from `features/payments/lib/purchase-confirmation-email.ts` (the
 * fulfillment hook that adapts this to that caller's data) - this file only knows how to build
 * the message, not who it's for or when it's sent.
 */
type PurchaseConfirmationEmailProps = {
  name: string;
  planName: string;
  /** Minor units (e.g. cents), as stored on the purchase row - not the plan's current price. */
  amountTotal: number;
  /** ISO currency code, case-insensitive. */
  currency: string;
  /** A public (not localhost) URL - email clients fetch images remotely, never a local path. */
  logoUrl?: string;
};

function PurchaseConfirmationEmail({
  name,
  planName,
  amountTotal,
  currency,
  logoUrl,
}: PurchaseConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Thanks for your purchase</Preview>
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
          <Heading>Thanks for your purchase</Heading>
          <Text>{`Hi ${name},`}</Text>
          <Text>{`We've received your payment for ${planName}.`}</Text>
          <Text>{`Amount charged: ${formatAmount(amountTotal, currency)}`}</Text>
          <Text>If you have any questions about this purchase, just reply to this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function purchaseConfirmationEmail(
  data: PurchaseConfirmationEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <PurchaseConfirmationEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: "Thanks for your purchase", html, text };
}
