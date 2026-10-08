import { env } from "@/env";
import Stripe from "stripe";

let client: Stripe | undefined;

export function getPaymentProcessor(): Stripe {
  if (!client) {
    if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-09-30.endive",
    });
  }
  return client;
}
