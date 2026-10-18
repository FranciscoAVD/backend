import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { render } from "@react-email/render";
import { formatAmount } from "@f/email/lib/format-amount";

/**
 * @description Content for the internal alert sent to admins when a purchase's refunded amount
 * goes *down* - a refund that Stripe accepted later failed or was canceled, so the money never
 * reached the customer. Kept separate from `send.ts` (how to send) and from
 * `features/payments/lib/refund-reversed-alert-email.ts` (who it goes to, and when) - this file
 * only knows how to build the message.
 */
type RefundReversedAlertEmailProps = {
  planName: string;
  purchaseId: number;
  /** The buyer's email, or null if their account no longer exists. */
  buyerEmail: string | null;
  stripePaymentIntentId: string;
  /** Minor units (e.g. cents) - the purchase's refunded total before and after this change. */
  refundedBefore: number;
  refundedAfter: number;
  /** ISO currency code, case-insensitive. */
  currency: string;
};

function RefundReversedAlertEmail({
  planName,
  purchaseId,
  buyerEmail,
  stripePaymentIntentId,
  refundedBefore,
  refundedAfter,
  currency,
}: RefundReversedAlertEmailProps) {
  const amount = (minor: number) => formatAmount(minor, currency);
  return (
    <Html>
      <Head />
      <Preview>{`A refund on purchase #${purchaseId} didn't go through`}</Preview>
      <Body>
        <Container>
          <Heading>A refund didn't go through</Heading>
          <Text>
            {`A refund on purchase #${purchaseId} (${planName}) failed or was canceled after Stripe accepted it, so ${amount(refundedBefore - refundedAfter)} never reached the customer.`}
          </Text>
          <Text>{`Buyer: ${buyerEmail ?? "(account deleted)"}`}</Text>
          <Text>{`Refunded total: ${amount(refundedBefore)} -> ${amount(refundedAfter)}`}</Text>
          <Text>{`Stripe payment intent: ${stripePaymentIntentId}`}</Text>
          <Text>
            The customer may already have been told the refund was processed. Check the refund in
            Stripe, and issue it again - with a new idempotency key - or contact the customer.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function refundReversedAlertEmail(
  data: RefundReversedAlertEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <RefundReversedAlertEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: `Action needed: refund on purchase #${data.purchaseId} didn't go through`, html, text };
}
