import { env } from "@backend/env";
import Stripe from "stripe";
import { STRIPE_MAX_NETWORK_RETRIES, STRIPE_TIMEOUT_MS } from "@backend/f/payments/lib/constants";

let client: Stripe | undefined;

export function getPaymentProcessor(): Stripe {
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-09-30.endive",
      timeout: STRIPE_TIMEOUT_MS,
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    });
  }
  return client;
}

/**
 * @description A proxy around the Stripe client, for the better-auth stripe plugin's
 * `stripeClient` option only. Its checkout.session.completed handler always calls
 * subscriptions.retrieve(checkoutSession.subscription) for a completed checkout, even a one-time
 * (mode: "payment") one, which has no subscription - checkoutSession.subscription is then null, so
 * this would be a real, wasted GET /v1/subscriptions/null round-trip that 404s every time.
 * Short-circuiting it here (rather than patching the plugin) returns a shape that makes the
 * plugin's own resolvePlanItem() find no match and log one benign warning line instead - the same
 * outcome a `mode !== "payment"` guard in the plugin itself would have produced. Confirmed safe
 * against the plugin's actual source (resolvePlanItem returns early on an empty items array, no
 * crash) - every other method, and subscriptions.retrieve with a real id, passes through untouched.
 */
export function wrapForAuthPlugin(client: Stripe): Stripe {
  const subscriptions = Object.create(client.subscriptions) as typeof client.subscriptions;
  subscriptions.retrieve = ((id?: string, ...rest: unknown[]) =>
    id
      ? client.subscriptions.retrieve(id, ...(rest as []))
      : Promise.resolve({
          id: "one_time_payment_no_subscription",
          items: { data: [] },
        } as unknown as Stripe.Subscription)) as typeof client.subscriptions.retrieve;
  return Object.assign(Object.create(client), { subscriptions });
}

export function getPaymentProcessorForAuthPlugin(): Stripe {
  return wrapForAuthPlugin(getPaymentProcessor());
}
