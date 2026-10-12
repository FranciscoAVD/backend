import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let fakeSessions: Partial<Stripe.Checkout.Session>[] = [];

// no free local "real Stripe" to run against — the SDK surface run()/reconcile() actually call
// is faked here via bun:test's mock.module
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    checkout: { sessions: { list: () => fakeSessions } },
    disputes: { list: async () => ({ data: [] }) },
  }),
}));

import { run } from "@f/payments/lib/reconcile";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import { addPurchase } from "@f/payments/use-cases/add-purchase";

const fakeSession = (
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session =>
  ({
    id: "cs_1",
    mode: "payment",
    payment_status: "paid",
    created: Math.floor(Date.now() / 1000),
    metadata: null,
    payment_intent: null,
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  fakeSessions = [];
});

describe("run", () => {
  test("counts a successful confirm as inserted, not failed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      fakeSession({
        id: "cs_ok",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_ok",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    const summary = await run(7, false);

    expect(summary).toEqual({ scanned: 1, inserted: 1, updated: 0, failed: 0 });
    expect(await getAllPurchases({ userId })).toHaveLength(1);
  });

  test("a confirmCheckout failure (e.g. the plan was deleted) counts as failed, not inserted", async () => {
    const userId = await seedUser();
    fakeSessions = [
      fakeSession({
        id: "cs_bad_plan",
        metadata: { userId, planId: "999999" }, // no such plan
        payment_intent: {
          id: "pi_bad_plan",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    const summary = await run(7, false);

    expect(summary).toEqual({ scanned: 1, inserted: 0, updated: 0, failed: 1 });
    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("a status change on an already-recorded purchase counts as updated, not inserted", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_existing",
        stripePaymentIntentId: "pi_existing",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    fakeSessions = [
      fakeSession({
        id: "cs_existing",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_existing",
          latest_charge: {
            amount_refunded: plan.amount,
            refunded: true,
            disputed: false,
          },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    const summary = await run(7, false);

    expect(summary).toEqual({ scanned: 1, inserted: 0, updated: 1, failed: 0 });
    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("refunded");
  });

  test("ignores subscription-mode and still-unpaid sessions", async () => {
    fakeSessions = [
      fakeSession({ id: "cs_sub", mode: "subscription" }),
      fakeSession({ id: "cs_unpaid", payment_status: "unpaid" }),
      fakeSession({ id: "cs_no_plan", metadata: null }),
    ];

    const summary = await run(7, false);

    expect(summary).toEqual({ scanned: 0, inserted: 0, updated: 0, failed: 0 });
  });

  test("dry-run never writes to the DB", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      fakeSession({
        id: "cs_dry",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_dry",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    const summary = await run(7, true);

    expect(summary).toEqual({ scanned: 1, inserted: 1, updated: 0, failed: 0 });
    expect(await getAllPurchases({ userId })).toEqual([]);
  });
});
