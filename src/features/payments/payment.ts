import { env } from "@/env";
import Stripe from "stripe";
import { STRIPE_MAX_NETWORK_RETRIES, STRIPE_TIMEOUT_MS } from "@f/payments/lib/constants";

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
