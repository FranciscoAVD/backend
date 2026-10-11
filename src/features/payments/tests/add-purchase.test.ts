import { describe, expect, test, beforeEach } from "bun:test";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

describe("addPurchase", () => {
  beforeEach(resetDb);

  test("inserts a purchase for the given user", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();

    const res = await addPurchase(
      { userID },
      {
        planID: plan.id,
        stripeCheckoutSessionId: "cs_test_1",
        stripePaymentIntentId: "pi_test_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    expect(res).not.toBeNull();
    expect(res?.userID).toBe(userID);
    expect(res?.status).toBe("paid");
  });

  test("a retried insert for the same checkout session is a no-op", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    const purchaseData = {
      planID: plan.id,
      stripeCheckoutSessionId: "cs_test_dup",
      stripePaymentIntentId: "pi_test_dup",
      amountTotal: plan.amount,
      currency: plan.currency,
    };

    const first = await addPurchase({ userID }, purchaseData);
    const second = await addPurchase({ userID }, purchaseData);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
