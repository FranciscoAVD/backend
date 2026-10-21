import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import { formatAmount } from "@backend/f/email/lib/format-amount";

/**
 * @description Content for the internal alert sent to admins when a buyer was charged for a
 * non-repeatable plan they already own. Kept separate from `send.ts` (how to send) and from
 * `features/payments/lib/duplicate-purchase-alert-email.ts` (who it goes to, and when) - this file
 * only knows how to build the message.
 */
type DuplicatePurchaseAlertEmailProps = {
  planName: string;
  /** The buyer's email, or null if their account no longer exists. */
  buyerEmail: string | null;
  buyerUserId: string;
  existingPurchaseId: number;
  duplicatePurchaseId: number;
  stripeCheckoutSessionId: string;
  /** Minor units (e.g. cents) - what the duplicate charge took. */
  amountTotal: number;
  /** ISO currency code, case-insensitive. */
  currency: string;
};

function DuplicatePurchaseAlertEmail({
  planName,
  buyerEmail,
  buyerUserId,
  existingPurchaseId,
  duplicatePurchaseId,
  stripeCheckoutSessionId,
  amountTotal,
  currency,
}: DuplicatePurchaseAlertEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`A buyer was charged twice for ${planName}`}</Preview>
      <Body>
        <Container>
          <Heading>Duplicate purchase needs review</Heading>
          <Text>
            {`A buyer paid for ${planName}, a plan that can only be bought once, while they already own it. The payment was recorded, but they were charged twice and likely need a refund.`}
          </Text>
          <Text>{`Buyer: ${buyerEmail ?? "(account deleted)"} - user ${buyerUserId}`}</Text>
          <Text>{`Amount charged: ${formatAmount(amountTotal, currency)}`}</Text>
          <Text>{`Purchase they already had: #${existingPurchaseId}`}</Text>
          <Text>{`Duplicate purchase: #${duplicatePurchaseId} (Stripe session ${stripeCheckoutSessionId})`}</Text>
          <Text>
            {`To refund it, issue a refund for purchase #${duplicatePurchaseId}. It's also in the payments audit log as duplicate_purchase_confirmed.`}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function duplicatePurchaseAlertEmail(
  data: DuplicatePurchaseAlertEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
  const element = <DuplicatePurchaseAlertEmail {...data} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: `Action needed: duplicate purchase of ${data.planName}`, html, text };
}
