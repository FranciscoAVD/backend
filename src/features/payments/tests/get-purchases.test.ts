import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import {
  getAllPurchases,
  getPurchaseBySession,
  getPaidPurchaseByPlan,
  hasActivePurchase,
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
      { durationDays: plan.durationDays },
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
      { durationDays: plan.durationDays },
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
      { durationDays: plan.durationDays },
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
      { durationDays: plan.durationDays },
    );

    const res = await getPurchaseBySession({
      userId: otherUserId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBeNull();
  });
});

describe("getPaidPurchaseByPlan", () => {
  beforeEach(resetDb);

  test("returns the user's paid purchase of that plan", async () => {
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
    );

    const res = await getPaidPurchaseByPlan({ userId, planId: plan.id });
    expect(res?.stripeCheckoutSessionId).toBe("cs_1");
  });

  test("returns null when the user's purchase of that plan was refunded", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    const purchase = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
    );
    await db
      .update(purchaseTable)
      .set({ status: "refunded" })
      .where(eq(purchaseTable.id, purchase!.id));

    const res = await getPaidPurchaseByPlan({ userId, planId: plan.id });
    expect(res).toBeNull();
  });

  test("returns null when the user has no purchase of that plan at all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    const res = await getPaidPurchaseByPlan({ userId, planId: plan.id });
    expect(res).toBeNull();
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

// inserted directly (bypassing addPurchase) so createdAt/expiresAt can be backdated,
// instead of always being computed relative to the real current time
async function insertPaidPurchase(purchase: {
  userId: string;
  planId: number;
  createdAt: Date;
  expiresAt: Date | null;
}) {
  await db.insert(purchaseTable).values({
    ...purchase,
    stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
    amountTotal: 1000,
    currency: "usd",
    status: "paid",
  });
}

describe("hasActivePurchase", () => {
  beforeEach(resetDb);

  test("overlapping: true - active when any one purchase's window still covers now", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-10),
      expiresAt: daysFromNow(-5), // already expired
    });
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-1),
      expiresAt: daysFromNow(29), // still active
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: true },
    );
    expect(res).toBe(true);
  });

  test("overlapping: true - false once every purchase has expired", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-10),
      expiresAt: daysFromNow(-5),
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: true },
    );
    expect(res).toBe(false);
  });

  test("overlapping: false - a later purchase chains on after an earlier one expires", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    // 30-day window, already lapsed on its own
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-40),
      expiresAt: daysFromNow(-10),
    });
    // bought before the first one lapsed, so its own 30-day window (naively
    // -5 to +25) should instead chain onto the first purchase's end (-10)
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-5),
      expiresAt: daysFromNow(25),
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: false },
    );
    expect(res).toBe(true);
  });

  test("overlapping: false - a gap before the next purchase isn't backfilled", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-40),
      expiresAt: daysFromNow(-30), // expired long ago
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: false },
    );
    expect(res).toBe(false);
  });

  test("a purchase with no expiry is active from its createdAt onward either way", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-5),
      expiresAt: null,
    });

    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: true }),
    ).toBe(true);
    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: false }),
    ).toBe(true);
  });

  test("returns false when the user has no paid purchase of the plan at all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: true }),
    ).toBe(false);
  });
});
