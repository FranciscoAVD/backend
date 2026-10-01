import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin } from "better-auth/plugins/admin";
import { db } from "@d/connection";
import * as schema from "@d/schemas/auth-schema";
import { env } from "@/env";
import { authSecondaryStorage } from "@f/auth/lib/secondary-storage";
import { ac, user, admin } from "@f/auth/lib/permissions";
import { stripe } from "@better-auth/stripe";
import { payment } from "@f/payments/payment";
import { getSubscriptionPlans } from "@f/payments/use-cases/get-plans";
import { handleStripeEvent } from "@f/payments/lib/webhook";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  trustedOrigins: [env.CLIENT_URL],
  // without a `verification.storeInDatabase: true` override, having secondaryStorage
  // set means verification records (email verification, password reset, OAuth state)
  // live only in Redis, never in the DB `verification` table
  secondaryStorage: authSecondaryStorage,
  session: {
    // without this, secondaryStorage becomes the only session store
    storeSessionInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    stripe({
      stripeClient: payment,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: getSubscriptionPlans,
      },
      onEvent: handleStripeEvent,
    }),
    adminPlugin({
      ac,
      roles: {
        user,
        admin,
      },
    }),
  ],
});
