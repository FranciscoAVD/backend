import { env } from "@/env";
import Stripe from "stripe";

export const payment = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-09-30.endive",
});
