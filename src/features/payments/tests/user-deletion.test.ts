import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "@d/connection";
import { user } from "@d/schemas/auth-schema";
import { purchase } from "@d/schemas/payment-schema";
import { eq } from "drizzle-orm";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { addPurchase } from "@f/payments/use-cases/add-purchase";

describe("deleting a user", () => {
  beforeEach(resetDb);

  test("doesn't fail, and the purchase survives with userId set to null", async () => {
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

    await db.delete(user).where(eq(user.id, userId));

    const [row] = await db
      .select()
      .from(purchase)
      .where(eq(purchase.stripeCheckoutSessionId, "cs_1"));
    expect(row).not.toBeUndefined();
    expect(row?.userId).toBeNull();
  });
});
