import { CHECKOUT_SESSION_ID_PREFIX } from "@f/payments/lib/constants";

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
