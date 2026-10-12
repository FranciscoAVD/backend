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
      { durationDays: plan.durationDays },
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

    const first = await addPurchase({ userId }, purchaseData, {
      durationDays: plan.durationDays,
    });
    const second = await addPurchase({ userId }, purchaseData, {
      durationDays: plan.durationDays,
    });

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
    );

    expect(res?.expiresAt).toBeNull();
  });

  test("sets expiresAt durationDays out from now when the plan has one", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });

    const before = Date.now();
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
    );

    const expiresAt = res?.expiresAt?.getTime() ?? 0;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(expiresAt).toBeLessThan(Date.now() + thirtyDaysMs + 5000);
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
    );

    expect(first?.expiresAt).not.toBeNull();
    expect(second?.expiresAt).not.toBeNull();
    // both windows run independently from their own purchase time, not chained off each other
    expect(
      Math.abs((first?.expiresAt?.getTime() ?? 0) - (second?.expiresAt?.getTime() ?? 0)),
    ).toBeLessThan(5000);
  });
});
