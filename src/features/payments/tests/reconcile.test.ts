import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { db } from "@d/connection";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import { eq } from "drizzle-orm";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let fakeSessions: Partial<Stripe.Checkout.Session>[] = [];
let fakeSubscriptionsById: Record<string, Partial<Stripe.Subscription>> = {};
let subscriptionRetrieveCalls: string[] = [];

// no free local "real Stripe" to run against — the SDK surface run()/reconcile() actually call
// is faked here via bun:test's mock.module
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    checkout: { sessions: { list: () => fakeSessions } },
    disputes: { list: async () => ({ data: [] }) },
    subscriptions: {
      retrieve: async (id: string) => {
        subscriptionRetrieveCalls.push(id);
        const sub = fakeSubscriptionsById[id];
        if (!sub) throw new Error(`no fake subscription for ${id}`);
        return sub;
      },
    },
  }),
}));

import { run, runSubscriptions } from "@f/payments/lib/reconcile";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import { addPurchase } from "@f/payments/use-cases/add-purchase";

const fakeSubscription = (
  overrides: Partial<Stripe.Subscription> & {
    items?: { data: [{ current_period_start: number; current_period_end: number }] };
  } = {},
): Stripe.Subscription =>
  ({
    status: "active",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    items: { data: [{ current_period_start: 0, current_period_end: 0 }] },
    ...overrides,
  }) as unknown as Stripe.Subscription;

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
  fakeSubscriptionsById = {};
  subscriptionRetrieveCalls = [];
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

describe("runSubscriptions", () => {
  test("corrects a row whose stored status disagrees with Stripe", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "Pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    const canceledAt = new Date("2026-01-01T00:00:00Z");
    fakeSubscriptionsById["sub_1"] = fakeSubscription({
      status: "canceled",
      canceled_at: Math.floor(canceledAt.getTime() / 1000),
    });

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.status).toBe("canceled");
    expect(row?.canceledAt?.getTime()).toBe(canceledAt.getTime());
  });

  test("leaves a row untouched when nothing differs from Stripe", async () => {
    const userId = await seedUser();
    // periodStart/periodEnd match the fake's own epoch-0 default below - this test is
    // specifically about an exact match producing no update, not about period values
    await seedSubscription({
      referenceId: userId,
      plan: "Pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: new Date(0),
      periodEnd: new Date(0),
    });
    fakeSubscriptionsById["sub_1"] = fakeSubscription({ status: "active" });

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 0 });
  });

  test("never calls Stripe for a row already in a terminal status", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "Pro",
      stripeSubscriptionId: "sub_canceled",
      status: "canceled",
    });

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 0, updated: 0, failed: 0 });
    expect(subscriptionRetrieveCalls).toEqual([]);
  });

  test("a retrieve failure counts as failed, not updated", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "Pro",
      stripeSubscriptionId: "sub_missing",
      status: "active",
    });
    // no fakeSubscriptionsById entry - the fake throws, mirroring a real Stripe error

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 1 });
  });

  test("dry-run never writes to the DB", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "Pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    fakeSubscriptionsById["sub_1"] = fakeSubscription({ status: "canceled" });

    const summary = await runSubscriptions(true);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.status).toBe("active");
  });
});
