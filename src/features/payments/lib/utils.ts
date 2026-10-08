import type Stripe from "stripe";
import {
  ALLOWED_EVENTS,
  CHECKOUT_SESSION_ID_PREFIX,
} from "@f/payments/lib/constants";
import type { Payment } from "@f/payments/lib/types";

export type AllowedEvent = Extract<
  Stripe.Event,
  { type: (typeof ALLOWED_EVENTS)[number] }
>;

/**
 * @description Checks that a value looks like a Stripe Checkout Session ID.
 * Only a shape check — it doesn't confirm the session exists.
 */
export function isCheckoutSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > CHECKOUT_SESSION_ID_PREFIX.length &&
    value.startsWith(CHECKOUT_SESSION_ID_PREFIX)
  );
}

/** @description Narrows a Stripe event to one listed in `ALLOWED_EVENTS`. */
export function isAllowedEvent(event: Stripe.Event): event is AllowedEvent {
  return (ALLOWED_EVENTS as readonly string[]).includes(event.type);
}

/**
 * @description Purchase refund state for a charge. Partial refunds keep the purchase paid.
 * Shared by the webhook and the reconciler so both map Stripe state the same way.
 */
export function purchaseUpdateFromCharge(
  charge: Pick<Stripe.Charge, "amount_refunded" | "refunded">,
): Pick<Payment.Purchase, "amountRefunded" | "status"> {
  return {
    amountRefunded: charge.amount_refunded,
    status: charge.refunded ? "refunded" : "paid",
  };
}

/**
 * @description Purchase status for a dispute: a lost dispute returns the money, a closed
 * one in our favor keeps it paid, and an open one is disputed.
 */
export function purchaseStatusFromDispute(
  dispute: Pick<Stripe.Dispute, "status">,
): Payment.Purchase["status"] {
  switch (dispute.status) {
    case "lost":
      return "refunded";
    case "won":
    case "warning_closed":
    case "prevented":
      return "paid";
    default:
      return "disputed";
  }
}
