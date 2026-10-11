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
          return { id: "cs_test_fake", url: "https://checkout.stripe.com/fake" };
        },
      },
    },
  }),
}));

import { createCheckout, getCheckoutStatus } from "@f/payments/use-cases/checkout";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getPendingCheckout } from "@f/payments/lib/pending-checkout";

describe("createCheckout", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    sessionCreateCalls = [];
  });

  test("creates a Stripe checkout session and tracks it as pending in Redis", async () => {
    const plan = await seedPlan({ stripePriceId: "price_abc" });

    const res = await createCheckout(
      { userID: "u1", email: "u1@example.test" },
      { id: plan.id, stripePriceId: plan.stripePriceId },
    );

    expect(res).toEqual({
      sessionId: "cs_test_fake",
      url: "https://checkout.stripe.com/fake",
    });

    const pending = await getPendingCheckout("cs_test_fake");
    expect(pending).toEqual({ userID: "u1", planID: plan.id, status: "open" });
  });

  test("uses customer_email when the user has no Stripe customer id yet", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userID: "u1", email: "u1@example.test" },
      { id: plan.id, stripePriceId: plan.stripePriceId },
    );

    expect(sessionCreateCalls[0]).toMatchObject({
      customer_email: "u1@example.test",
      customer_creation: "always",
    });
    expect(sessionCreateCalls[0]).not.toHaveProperty("customer");
  });

  test("uses the existing Stripe customer id when the user has one", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userID: "u1", email: "u1@example.test", stripeCustomerId: "cus_abc" },
      { id: plan.id, stripePriceId: plan.stripePriceId },
    );

    expect(sessionCreateCalls[0]).toMatchObject({ customer: "cus_abc" });
  });
});

describe("getCheckoutStatus", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("returns the DB purchase status once confirmed", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userID },
      {
        planID: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    const res = await getCheckoutStatus({
      userID,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBe("paid");
  });

  test("falls back to the pending Redis entry when no purchase row exists yet", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userID: "u1", email: "u1@example.test" },
      { id: plan.id, stripePriceId: plan.stripePriceId },
    );

    const res = await getCheckoutStatus({
      userID: "u1",
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBe("open");
  });

  test("returns null when the pending entry belongs to a different user", async () => {
    const plan = await seedPlan();
    await createCheckout(
      { userID: "u1", email: "u1@example.test" },
      { id: plan.id, stripePriceId: plan.stripePriceId },
    );

    const res = await getCheckoutStatus({
      userID: "someone-else",
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBeNull();
  });

  test("returns null when there's neither a purchase nor a pending entry", async () => {
    const res = await getCheckoutStatus({
      userID: "u1",
      stripeCheckoutSessionId: "cs_nonexistent",
    });
    expect(res).toBeNull();
  });
});
