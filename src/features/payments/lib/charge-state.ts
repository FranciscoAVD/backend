import type Stripe from "stripe";
import { getPaymentProcessor } from "@f/payments/payment";
import { purchaseUpdateFromCharge, purchaseStatusFromDispute } from "@f/payments/lib/utils";
import type { Payment } from "@f/payments/lib/types";

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
    if (dispute) target.status = purchaseStatusFromDispute(dispute);
  }
  return target;
}
