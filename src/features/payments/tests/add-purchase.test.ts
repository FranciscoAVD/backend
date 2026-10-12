import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
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
      { durationDays: plan.durationDays },
      new Date(),
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

    const first = await addPurchase(
      { userId },
      purchaseData,
      { durationDays: plan.durationDays },
      new Date(),
    );
    const second = await addPurchase(
      { userId },
      purchaseData,
      { durationDays: plan.durationDays },
      new Date(),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("leaves expiresAt null when the plan has no durationDays", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: null });

    const res = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_perpetual",
        stripePaymentIntentId: "pi_test_perpetual",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );

    expect(res?.expiresAt).toBeNull();
  });

  test("sets expiresAt durationDays out from the given purchasedAt, not from insert time", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });
    const purchasedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    const res = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_expiring",
        stripePaymentIntentId: "pi_test_expiring",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      purchasedAt,
    );

    expect(res?.createdAt.getTime()).toBe(purchasedAt.getTime());
    // 30 days from 10 days ago = 20 days from now, not 30 - a late (e.g. reconciler) insert
    // must not grant bonus access past what the real purchase moment would have given
    const expected = purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(res?.expiresAt?.getTime()).toBe(expected);
  });

  test("two purchases of the same plan each get their own, independent expiresAt", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30, repeatable: true });

    const first = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_overlap_1",
        stripePaymentIntentId: "pi_test_overlap_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    const second = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_overlap_2",
        stripePaymentIntentId: "pi_test_overlap_2",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );

    expect(first?.expiresAt).not.toBeNull();
    expect(second?.expiresAt).not.toBeNull();
    // both windows run independently from their own purchase time, not chained off each other
    expect(
      Math.abs((first?.expiresAt?.getTime() ?? 0) - (second?.expiresAt?.getTime() ?? 0)),
    ).toBeLessThan(5000);
  });

  test("inserts with userId: null when the user no longer exists", async () => {
    const plan = await seedPlan();

    const res = await addPurchase(
      { userId: "does-not-exist" },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_test_deleted_user",
        stripePaymentIntentId: "pi_test_deleted_user",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );

    expect(res).not.toBeNull();
    expect(res?.userId).toBeNull();

    const [row] = await db
      .select()
      .from(purchaseTable)
      .where(eq(purchaseTable.stripeCheckoutSessionId, "cs_test_deleted_user"));
    expect(row?.userId).toBeNull();
    expect(row?.amountTotal).toBe(plan.amount);
  });
});
