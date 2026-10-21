import type Stripe from "stripe";
import { getPaymentProcessor } from "@backend/f/payments/lib/stripe/client";
import { purchaseUpdateFromCharge, purchaseStatusFromDispute } from "@backend/f/payments/lib/utils";
import type { Payment } from "@backend/f/payments/lib/types";

export type PurchaseState = Pick<Payment.Purchase, "amountRefunded" | "status">;

/**
 * @description What a purchase should look like right now per Stripe's own current records -
 * never trusted from a webhook event's embedded snapshot, since Stripe doesn't guarantee delivery
 * order and an out-of-order or retried event's payload can be stale. Shared by the webhook and the
 * reconciler so both converge on the same live truth instead of two different stale ones.
 * @param paymentIntentId the Stripe payment intent to resolve state for
 * @param intent an already-expanded payment intent (e.g. the reconciler's own batch `list` call),
 * to skip a redundant `retrieve` - omit to always fetch fresh (e.g. from a webhook, which only
 * ever has an identifier)
 * @returns The current refund/dispute state, or null if there's no charge on this intent yet.
 */
export async function resolveChargeState(
  paymentIntentId: string,
  intent?: Stripe.PaymentIntent,
): Promise<PurchaseState | null> {
  const resolved =
    intent ??
    (await getPaymentProcessor().paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    }));
  const charge = resolved.latest_charge as Stripe.Charge | null | undefined;
  if (!charge) return null;

  const target = purchaseUpdateFromCharge(charge);
  if (charge.disputed) {
    const disputes = await getPaymentProcessor().disputes.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    const dispute = disputes.data[0];
    // only an open or lost dispute overrides the refund-derived status: `charge.disputed` stays
    // true forever once a dispute was opened, so one closed in our favor ("paid") must defer to
    // the charge's own refund state - a refund made after it (e.g. a goodwill refund following an
    // inquiry) would otherwise be masked, and the purchase would keep granting access
    const fromDispute = dispute ? purchaseStatusFromDispute(dispute) : "paid";
    if (fromDispute !== "paid") target.status = fromDispute;
    // a lost chargeback returns the disputed amount to the customer just as surely as a refund
    // does, but Stripe doesn't count it in amount_refunded - so `refunded` with
    // amountRefunded 0 would misstate revenue. Added to any earlier refunds, never past the charge
    if (dispute && fromDispute === "refunded")
      target.amountRefunded = Math.min(
        charge.amount ?? Number.POSITIVE_INFINITY,
        charge.amount_refunded + (dispute.amount ?? 0),
      );
  }
  return target;
}
