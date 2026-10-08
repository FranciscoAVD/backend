import type Stripe from "stripe";
import {
  ALLOWED_EVENTS,
  CHECKOUT_SESSION_ID_PREFIX,
} from "@f/payments/lib/constants";

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
