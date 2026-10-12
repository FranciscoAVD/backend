import { describe, expect, test, beforeEach } from "bun:test";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

describe("updatePurchaseByPaymentIntent", () => {
  beforeEach(resetDb);

  test("updates status and amountRefunded for the matching payment intent", async () => {
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

    const res = await updatePurchaseByPaymentIntent(
      { stripePaymentIntentId: "pi_1" },
      { status: "refunded", amountRefunded: plan.amount },
    );
    expect(res).not.toBeNull();

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.amountRefunded).toBe(plan.amount);
  });

  test("returns null when no purchase matches the payment intent", async () => {
    const res = await updatePurchaseByPaymentIntent(
      { stripePaymentIntentId: "pi_nonexistent" },
      { status: "refunded", amountRefunded: 100 },
    );
    expect(res).toBeNull();
  });
});
