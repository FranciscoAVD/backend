import { describe, expect, test, beforeEach } from "bun:test";
import {
  getAllPurchases,
  getPurchaseBySession,
} from "@f/payments/use-cases/get-purchases";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

describe("getAllPurchases", () => {
  beforeEach(resetDb);

  test("returns only the given user's purchases", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_mine",
        stripePaymentIntentId: "pi_mine",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );
    await addPurchase(
      { userId: otherUserId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_other",
        stripePaymentIntentId: "pi_other",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    const res = await getAllPurchases({ userId });
    expect(res).toHaveLength(1);
    expect(res[0]?.stripeCheckoutSessionId).toBe("cs_mine");
  });
});

describe("getPurchaseBySession", () => {
  beforeEach(resetDb);

  test("returns the purchase scoped to the session and user", async () => {
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
    );

    const res = await getPurchaseBySession({
      userId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res?.stripeCheckoutSessionId).toBe("cs_1");
  });

  test("returns null when the session belongs to a different user", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
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
    );

    const res = await getPurchaseBySession({
      userId: otherUserId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBeNull();
  });
});
