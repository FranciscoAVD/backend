import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin } from "better-auth/plugins/admin";
import { db } from "@d/connection";
import * as schema from "@d/schemas/auth-schema";
import { env } from "@/env";
import { createSecondaryStorage } from "@vicstack/secondary-storage";
import { redis, incrementWithTTL } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { ac, user, admin } from "@f/auth/lib/permissions";
import { stripe } from "@better-auth/stripe";
import { getPaymentProcessor } from "@f/payments/payment";
import { paymentsRepo } from "@f/payments/repo";
import { handleStripeEvent } from "@f/payments/lib/webhook";
import {
  cancelSubscriptionsForDeletedUser,
  expireCheckoutsForDeletedUser,
} from "@f/payments/lib/user-deletion";
import { blockRetiredPlanUpgrade } from "@f/payments/lib/plan-retirement";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  trustedOrigins: [env.CLIENT_URL],
  advanced: {
    // lets the rate limiter see the real client through this app's own proxies (see env.ts)
    ipAddress: { trustedProxies: env.TRUSTED_PROXIES },
  },
  // without a `verification.storeInDatabase: true` override, having secondaryStorage
  // set means verification records (email verification, password reset, OAuth state)
  // live only in Redis, never in the DB `verification` table
  secondaryStorage: createSecondaryStorage({
    redis: { client: redis, increment: incrementWithTTL },
    onError: (error, context) => logger.error({ err: error }, context),
  }),
  session: {
    // without this, secondaryStorage becomes the only session store
    storeSessionInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    customRules: {
      // Stripe's webhook deliveries are authenticated by their signature, not throttled by IP:
      // they arrive in bursts from a handful of Stripe IPs, and the limiter runs before the
      // signature check - so without this, a burst (or anyone flooding the path with unsigned
      // junk, if client IPs aren't resolved and every caller shares one bucket) gets real events
      // 429'd. Stripe retries those, but only for 3 days, and a dropped
      // customer.subscription.deleted or charge.dispute.* means access that should have ended
      "/stripe/webhook": false,
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      delete: {
        // every deletion path (admin removeUser, self-service /delete-user) runs this; a throw
        // aborts the deletion, so a user is never removed while Stripe is still billing them -
        // or while a checkout they left open could still be paid. Checkouts first, so none can
        // start a subscription after the cancellation pass has listed them
        before: async (user) => {
          await expireCheckoutsForDeletedUser(user);
          await cancelSubscriptionsForDeletedUser(user);
        },
      },
    },
  },
  hooks: {
    // the stripe plugin is handed retired plans too (so existing subscribers keep resolving);
    // this is what stops anyone starting a new subscription to one
    before: blockRetiredPlanUpgrade,
  },
  plugins: [
    stripe({
      stripeClient: getPaymentProcessor(),
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: paymentsRepo.plan.getSubscriptions,
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
