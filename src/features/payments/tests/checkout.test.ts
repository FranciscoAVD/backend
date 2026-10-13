import { describe, expect, test, beforeEach, mock } from "bun:test";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let sessionCreateCalls: Record<string, unknown>[] = [];

mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          sessionCreateCalls.push(args);
          return {
            id: "cs_test_fake",
            url: "https://checkout.stripe.com/fake",
          };
        },
      },
    },
  }),
}));

// extension point under test - a plain module the test re-mocks per case, same mock.module
// pattern as Stripe above; default export matches checkout-extensions.ts's own no-op
let extensionParams: Record<string, unknown> | undefined;
mock.module("@f/payments/lib/checkout-extensions", () => ({
  getCheckoutSessionParams: async () => extensionParams,
}));

import {
  createCheckout,
  getCheckoutStatus,
} from "@f/payments/use-cases/checkout";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getPendingCheckout } from "@f/payments/lib/pending-checkout";

// The session's metadata and the payment intent's, from the last Stripe call. Asserted
// separately with toEqual, not through one toMatchObject on the whole call: Bun's toMatchObject
// only compares an object the first time it meets it, so when the code passes the *same* object
// as both, a wrong payment-intent half passes unchecked.
type CreateCall = {
  metadata: Record<string, string>;
  payment_intent_data: { metadata: Record<string, string> } & Record<string, unknown>;
};
const lastMetadata = () => {
  const call = sessionCreateCalls.at(-1) as CreateCall;
  return { session: call.metadata, intent: call.payment_intent_data.metadata };
};

describe("createCheckout", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    sessionCreateCalls = [];
    extensionParams = undefined;
  });

  test("creates a Stripe checkout session and tracks it as pending in Redis", async () => {
    const plan = await seedPlan({ stripePriceId: "price_abc" });

    const res = await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    expect(res).toEqual({
      sessionId: "cs_test_fake",
      url: "https://checkout.stripe.com/fake",
    });

    const pending = await getPendingCheckout("cs_test_fake");
    expect(pending).toEqual({ userId: "u1", planId: plan.id, status: "open" });
  });

  test("uses the user's Stripe customer id", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    expect(sessionCreateCalls[0]).toMatchObject({ customer: "cus_abc" });
  });

  test("snapshots the plan's durationDays onto both metadata objects", async () => {
    const plan = await seedPlan({ durationDays: 30 });
    await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    const metadata = { userId: "u1", planId: String(plan.id), durationDays: "30" };
    expect(lastMetadata()).toEqual({ session: metadata, intent: metadata });
  });

  test("snapshots a never-expiring plan as an explicit marker, not a missing key", async () => {
    const plan = await seedPlan({ durationDays: null });
    await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    expect(sessionCreateCalls[0]).toMatchObject({ metadata: { durationDays: "none" } });
  });

  test("getCheckoutSessionParams's additional params reach Stripe", async () => {
    extensionParams = { allow_promotion_codes: true, automatic_tax: { enabled: true } };
    const plan = await seedPlan();

    await createCheckout({ userId: "u1", stripeCustomerId: "cus_abc" }, plan);

    expect(sessionCreateCalls[0]).toMatchObject({
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
    });
  });

  test("a line_items override replaces the default line item", async () => {
    extensionParams = { line_items: [{ price: "price_other", quantity: 3 }] };
    const plan = await seedPlan({ stripePriceId: "price_abc" });

    await createCheckout({ userId: "u1", stripeCustomerId: "cus_abc" }, plan);

    expect(sessionCreateCalls[0]).toMatchObject({
      line_items: [{ price: "price_other", quantity: 3 }],
    });
  });

  test("the extension can't override userId/planId/durationDays in metadata, but can add its own keys", async () => {
    extensionParams = {
      metadata: { userId: "someone-else", campaign: "spring-sale" },
      payment_intent_data: { metadata: { planId: "999999" } },
    };
    const plan = await seedPlan({ durationDays: 30 });

    await createCheckout({ userId: "u1", stripeCustomerId: "cus_abc" }, plan);

    const metadata = {
      campaign: "spring-sale",
      userId: "u1",
      planId: String(plan.id),
      durationDays: "30",
    };
    expect(lastMetadata()).toEqual({ session: metadata, intent: metadata });
  });

  test("keys set only on payment_intent_data.metadata reach the payment intent, alongside the session's", async () => {
    extensionParams = {
      metadata: { campaign: "spring-sale" },
      payment_intent_data: {
        metadata: { ledgerRef: "L-42", userId: "someone-else" },
        statement_descriptor_suffix: "SPRING",
      },
    };
    const plan = await seedPlan({ durationDays: 30 });

    await createCheckout({ userId: "u1", stripeCustomerId: "cus_abc" }, plan);

    const core = { userId: "u1", planId: String(plan.id), durationDays: "30" };
    expect(lastMetadata()).toEqual({
      // the intent-only key stays off the session itself
      session: { campaign: "spring-sale", ...core },
      intent: { ledgerRef: "L-42", campaign: "spring-sale", ...core },
    });
    // other payment_intent_data params pass through
    expect((sessionCreateCalls[0] as CreateCall).payment_intent_data.statement_descriptor_suffix).toBe(
      "SPRING",
    );
  });

  test("the extension can't override mode, customer or expires_at", async () => {
    extensionParams = {
      mode: "subscription",
      customer: "cus_wrong",
      expires_at: 1,
    };
    const plan = await seedPlan();

    await createCheckout({ userId: "u1", stripeCustomerId: "cus_abc" }, plan);

    expect(sessionCreateCalls[0]).toMatchObject({ mode: "payment", customer: "cus_abc" });
    expect(sessionCreateCalls[0]?.expires_at).toBeGreaterThan(1);
  });
});

describe("getCheckoutStatus", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("returns the DB purchase status once confirmed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );

    const res = await getCheckoutStatus({
      userId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBe("paid");
  });

  test("falls back to the pending Redis entry when no purchase row exists yet", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    const res = await getCheckoutStatus({
      userId: "u1",
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBe("open");
  });

  test("returns null when the pending entry belongs to a different user", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userId: "u1", stripeCustomerId: "cus_abc" },
      plan,
    );

    const res = await getCheckoutStatus({
      userId: "someone-else",
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBeNull();
  });

  test("returns null when there's neither a purchase nor a pending entry", async () => {
    const res = await getCheckoutStatus({
      userId: "u1",
      stripeCheckoutSessionId: "cs_nonexistent",
    });
    expect(res).toBeNull();
  });
});
