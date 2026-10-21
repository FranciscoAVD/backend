import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@backend/d/connection";
import { purchase as purchaseTable } from "@backend/d/schemas/payment-schema";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@backend/test-helpers/db";
import { getActivePlans } from "@backend/f/payments/use-cases/get-active-plans";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
import type { Payment } from "@backend/f/payments/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

let sessionCounter = 0;
async function buy(userId: string, plan: Payment.Plan, purchasedAt: Date) {
  const id = ++sessionCounter;
  return addPurchase(
    { userId },
    {
      planId: plan.id,
      stripeCheckoutSessionId: `cs_${id}`,
      stripePaymentIntentId: `pi_${id}`,
      amountTotal: plan.amount,
      currency: plan.currency,
    },
    { durationDays: plan.durationDays },
    purchasedAt,
  );
}

const names = (plans: Payment.Plan[]) => plans.map((p) => p.name);

describe("getActivePlans", () => {
  beforeEach(resetDb);

  test("combines one-time purchases and subscriptions, with each plan's limits", async () => {
    const userId = await seedUser();
    const pass = await seedPlan({ name: "Pass", durationDays: 30, limits: { exports: 10 } });
    const pro = await seedPlan({
      name: "Pro",
      type: "recurring",
      interval: "month",
      limits: { seats: 5 },
    });
    await buy(userId, pass, daysAgo(1));
    await seedSubscription({ referenceId: userId, plan: "pro", status: "active" });

    const res = await getActivePlans({ userId });

    expect(res.map((p) => [p.id, p.limits])).toEqual([
      [pass.id, { exports: 10 }],
      [pro.id, { seats: 5 }],
    ]);
  });

  test("leaves out expired, refunded and disputed purchases", async () => {
    const userId = await seedUser();
    const expired = await seedPlan({ name: "Expired", durationDays: 7 });
    const refunded = await seedPlan({ name: "Refunded" });
    const disputed = await seedPlan({ name: "Disputed" });
    await buy(userId, expired, daysAgo(10));
    const r = await buy(userId, refunded, daysAgo(1));
    const d = await buy(userId, disputed, daysAgo(1));
    await db.update(purchaseTable).set({ status: "refunded" }).where(eq(purchaseTable.id, r!.id));
    await db.update(purchaseTable).set({ status: "disputed" }).where(eq(purchaseTable.id, d!.id));

    expect(await getActivePlans({ userId })).toEqual([]);
  });

  test("leaves out subscriptions that don't grant access", async () => {
    const userId = await seedUser();
    for (const [name, status] of [
      ["Canceled", "canceled"],
      ["PastDue", "past_due"],
      ["Incomplete", "incomplete"],
    ] as const) {
      await seedPlan({ name, type: "recurring", interval: "month" });
      await seedSubscription({ referenceId: userId, plan: name.toLowerCase(), status });
    }
    await seedPlan({ name: "Trial", type: "recurring", interval: "month" });
    await seedSubscription({ referenceId: userId, plan: "trial", status: "trialing" });

    expect(names(await getActivePlans({ userId }))).toEqual(["Trial"]);
  });

  test("chains non-overlapping purchases, like hasActivePurchase", async () => {
    const userId = await seedUser();
    // two 30-day passes bought 40 and 35 days ago: unchained, both have lapsed; chained, the
    // second runs from day -10 to day +20, so access is still active
    const plan = await seedPlan({ durationDays: 30, repeatable: true, overlapping: false });
    await buy(userId, plan, daysAgo(40));
    await buy(userId, plan, daysAgo(35));

    expect(names(await getActivePlans({ userId }))).toEqual([plan.name]);
  });

  test("a retired plan still counts for someone who holds it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ name: "Retired", durationDays: 30, active: false });
    await buy(userId, plan, daysAgo(1));

    expect(names(await getActivePlans({ userId }))).toEqual(["Retired"]);
  });

  test("lists each plan once however many purchases grant it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ repeatable: true });
    await buy(userId, plan, daysAgo(3));
    await buy(userId, plan, daysAgo(2));

    expect(await getActivePlans({ userId })).toHaveLength(1);
  });

  test("only ever returns the given user's plans", async () => {
    const userId = await seedUser();
    const otherId = await seedUser();
    const plan = await seedPlan();
    await seedPlan({ name: "Sub", type: "recurring", interval: "month" });
    await buy(otherId, plan, daysAgo(1));
    await seedSubscription({ referenceId: otherId, plan: "sub" });

    expect(await getActivePlans({ userId })).toEqual([]);
  });
});
