import { describe, expect, test, beforeEach } from "bun:test";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

describe("addPurchase", () => {
  beforeEach(resetDb);

  test("inserts a purchase for the given user", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    const res = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_1",
        stripePaymentIntentId: "pi_test_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    expect(res).not.toBeNull();
    expect(res?.userId).toBe(userId);
    expect(res?.status).toBe("paid");
  });

  test("a retried insert for the same checkout session is a no-op", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    const purchaseData = {
      planId: plan.id,
      stripeCheckoutSessionId: "cs_test_dup",
      stripePaymentIntentId: "pi_test_dup",
      amountTotal: plan.amount,
      currency: plan.currency,
    };

    const first = await addPurchase({ userId }, purchaseData);
    const second = await addPurchase({ userId }, purchaseData);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
