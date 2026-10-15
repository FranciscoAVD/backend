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
  assertNoSettlingPayments,
  cancelSubscriptionsForDeletedUser,
  expireCheckoutsForDeletedUser,
} from "@f/payments/lib/user-deletion";
import { paymentsBeforeHook, paymentsAfterHook } from "@f/payments/lib/auth-hooks";
import { markUserDeleting, clearUserDeleting } from "@f/payments/lib/deletion-guard";
import { withholdTrialFromUnverified } from "@f/payments/lib/trial-eligibility";
import tryCatch from "@vicstack/try-catch";

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
        // start a subscription after the cancellation pass has listed them. The deleting flag goes
        // up before either pass, so a checkout started while this runs is expired too (see
        // payments/lib/deletion-guard.ts); it comes down again only if the deletion is aborted
        before: async (user) => {
          await markUserDeleting(user.id);
          try {
            await expireCheckoutsForDeletedUser(user);
            // after the expiry pass, so a checkout completed while it ran is caught here
            await assertNoSettlingPayments(user);
            await cancelSubscriptionsForDeletedUser(user);
          } catch (error) {
            const [, clearError] = await tryCatch(clearUserDeleting(user.id));
            if (clearError)
              logger.warn({ err: clearError, user: user.id }, "payments.deletion_guard.clear");
            throw error;
          }
        },
      },
    },
  },
  hooks: {
    // rejects server-only user fields (stripeCustomerId) on sign-up/update-user, stops new
    // subscriptions to retired plans (the stripe plugin is handed those too, so existing
    // subscribers keep resolving), and blocks subscription checkouts during account deletion
    before: paymentsBeforeHook,
    // re-checks the deletion flag once a subscription checkout exists (see deletion-guard.ts)
    after: paymentsAfterHook,
  },
  plugins: [
    stripe({
      stripeClient: getPaymentProcessor(),
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: paymentsRepo.plan.getSubscriptions,
        // free trials only for verified emails, so throwaway accounts can't farm them
        getCheckoutSessionParams: withholdTrialFromUnverified,
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
