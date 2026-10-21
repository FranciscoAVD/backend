import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@backend/d/connection";
import { purchase as purchaseTable } from "@backend/d/schemas/payment-schema";
import {
  getAllPurchases,
  getPurchaseBySession,
  getBlockingPurchaseByPlan,
  hasAnyBlockingPurchase,
  hasActivePurchase,
} from "@backend/f/payments/use-cases/get-purchases";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
import { resetDb, seedUser, seedPlan } from "@backend/test-helpers/db";

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
      new Date(),
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
      new Date(),
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
      new Date(),
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
      new Date(),
    );

    const res = await getPurchaseBySession({
      userId: otherUserId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBeNull();
  });
});

describe("getBlockingPurchaseByPlan", () => {
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
      new Date(),
    );

    const res = await getBlockingPurchaseByPlan({ userId, planId: plan.id });
    expect(res?.stripeCheckoutSessionId).toBe("cs_1");
  });

  test("returns the user's disputed purchase of that plan - money is still held", async () => {
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
      new Date(),
    );
    await db
      .update(purchaseTable)
      .set({ status: "disputed" })
      .where(eq(purchaseTable.id, purchase!.id));

    const res = await getBlockingPurchaseByPlan({ userId, planId: plan.id });
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
      new Date(),
    );
    await db
      .update(purchaseTable)
      .set({ status: "refunded" })
      .where(eq(purchaseTable.id, purchase!.id));

    const res = await getBlockingPurchaseByPlan({ userId, planId: plan.id });
    expect(res).toBeNull();
  });

  test("returns null when the user has no purchase of that plan at all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    const res = await getBlockingPurchaseByPlan({ userId, planId: plan.id });
    expect(res).toBeNull();
  });
});

describe("hasAnyBlockingPurchase", () => {
  beforeEach(resetDb);

  test("true when any user has a paid purchase of the plan", async () => {
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

    expect(await hasAnyBlockingPurchase({ planId: plan.id })).toBe(true);
  });

  test("true for a disputed purchase held by a different user than the caller would be", async () => {
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
      new Date(),
    );
    await db
      .update(purchaseTable)
      .set({ status: "disputed" })
      .where(eq(purchaseTable.id, purchase!.id));

    expect(await hasAnyBlockingPurchase({ planId: plan.id })).toBe(true);
  });

  test("false once the only purchase of the plan has been refunded", async () => {
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
      new Date(),
    );
    await db
      .update(purchaseTable)
      .set({ status: "refunded" })
      .where(eq(purchaseTable.id, purchase!.id));

    expect(await hasAnyBlockingPurchase({ planId: plan.id })).toBe(false);
  });

  test("false when the plan has no purchases at all", async () => {
    const plan = await seedPlan();

    expect(await hasAnyBlockingPurchase({ planId: plan.id })).toBe(false);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

// inserted directly (bypassing addPurchase) so createdAt/expiresAt/durationDays can be backdated,
// instead of always being computed relative to the real current time
async function insertPaidPurchase(purchase: {
  userId: string;
  planId: number;
  createdAt: Date;
  expiresAt: Date | null;
  durationDays?: number | null;
}) {
  await db.insert(purchaseTable).values({
    durationDays: null,
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
      durationDays: 30,
    });
    // bought before the first one lapsed, so its own 30-day window (naively
    // -5 to +25) should instead chain onto the first purchase's end (-10)
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-5),
      expiresAt: daysFromNow(25),
      durationDays: 30,
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: false },
    );
    expect(res).toBe(true);
  });

  test("overlapping: false - a 30-day plan bought on day 0 and again on day 10 gives access through day 60, not day 40", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    // "day 0"
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-45),
      expiresAt: daysFromNow(-15), // its own naive window, unused once chained
      durationDays: 30,
    });
    // "day 10" - bought 10 days after the first, well before its day-30 lapse
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-35),
      expiresAt: daysFromNow(-5), // its own naive window: day 10 + 30 = day 40
      durationDays: 30,
    });

    // real "now" stands in for "day 45": inside the chained day-30-to-day-60 window.
    // Comparing against each purchase's own precomputed expiresAt instead of recomputing
    // from the chain-adjusted start would incorrectly end access at day 40 and report
    // false here.
    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: false }),
    ).toBe(true);
  });

  test("overlapping: false - access from a day-0/day-10 30-day plan ends by day 65, past the chained day-60 window", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-65), // "day 0", relative to "now" standing in for "day 65"
      expiresAt: daysFromNow(-35),
      durationDays: 30,
    });
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-55), // "day 10"
      expiresAt: daysFromNow(-25),
      durationDays: 30,
    });

    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: false }),
    ).toBe(false);
  });

  test("overlapping: false - a gap before the next purchase isn't backfilled", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-40),
      expiresAt: daysFromNow(-30), // expired long ago
      durationDays: 10,
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

  test("overlapping: false - a row with no durationDays snapshot but expiresAt already past isn't treated as lifetime access", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    // no durationDays snapshot at all, and never backfilled with one
    await insertPaidPurchase({
      userId,
      planId: plan.id,
      createdAt: daysFromNow(-60),
      expiresAt: daysFromNow(-30),
      durationDays: null,
    });

    const res = await hasActivePurchase(
      { userId, planId: plan.id },
      { overlapping: false },
    );
    expect(res).toBe(false);
  });

  test("returns false when the user has no paid purchase of the plan at all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: true }),
    ).toBe(false);
  });
});
