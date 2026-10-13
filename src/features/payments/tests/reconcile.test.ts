import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { db } from "@d/connection";
import { subscription as subscriptionTable, user as userTable } from "@d/schemas/auth-schema";
import { eq } from "drizzle-orm";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let fakeSessions: Partial<Stripe.Checkout.Session>[] = [];
let fakeSubscriptions: Partial<Stripe.Subscription>[] = [];

// no free local "real Stripe" to run against — the SDK surface run()/reconcile() actually call
// is faked here via bun:test's mock.module
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    checkout: { sessions: { list: () => fakeSessions } },
    disputes: { list: async () => ({ data: [] }) },
    subscriptions: { list: () => fakeSubscriptions },
  }),
}));

import { run, runSubscriptions } from "@f/payments/lib/reconcile";
import { getAllPurchases, getPurchaseBySessionAnyUser } from "@f/payments/use-cases/get-purchases";
import { addPurchase } from "@f/payments/use-cases/add-purchase";

const fakeSubscription = (overrides: Record<string, unknown> = {}): Stripe.Subscription =>
  ({
    id: "sub_1",
    status: "active",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    items: { data: [{ current_period_start: 0, current_period_end: 0, price: { id: "price_default" } }] },
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
  fakeSubscriptions = [];
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

  test("a purchase whose user was since deleted isn't re-counted as inserted on every run", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_orphaned",
        stripePaymentIntentId: "pi_orphaned",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    // deleting the user sets the purchase's userId to null, but the Stripe session's
    // metadata still carries the old id
    await db.delete(userTable).where(eq(userTable.id, userId));
    fakeSessions = [
      fakeSession({
        id: "cs_orphaned",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_orphaned",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    expect(await run(7, false)).toEqual({ scanned: 1, inserted: 0, updated: 0, failed: 0 });
    expect(await run(7, false)).toEqual({ scanned: 1, inserted: 0, updated: 0, failed: 0 });
  });

  test("still syncs refund state on a purchase whose user was since deleted", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_orphaned_refund",
        stripePaymentIntentId: "pi_orphaned_refund",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    await db.delete(userTable).where(eq(userTable.id, userId));
    fakeSessions = [
      fakeSession({
        id: "cs_orphaned_refund",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_orphaned_refund",
          latest_charge: { amount_refunded: plan.amount, refunded: true, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    expect(await run(7, false)).toEqual({ scanned: 1, inserted: 0, updated: 1, failed: 0 });
    const purchase = await getPurchaseBySessionAnyUser({
      stripeCheckoutSessionId: "cs_orphaned_refund",
    });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.userId).toBeNull();
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
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    const canceledAt = new Date("2026-01-01T00:00:00Z");
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_1",
        status: "canceled",
        canceled_at: Math.floor(canceledAt.getTime() / 1000),
      }),
    ];

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
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: new Date(0),
      periodEnd: new Date(0),
    });
    fakeSubscriptions = [fakeSubscription({ id: "sub_1", status: "active" })];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 0 });
  });

  test("never acts on a row already in a terminal status, even if the list disagrees", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_canceled",
      status: "canceled",
    });
    // Stripe claims active, contradicting the stored terminal status - still ignored, since
    // Stripe itself guarantees canceled/incomplete_expired never change back
    fakeSubscriptions = [fakeSubscription({ id: "sub_canceled", status: "active" })];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 0, updated: 0, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_canceled"));
    expect(row?.status).toBe("canceled");
  });

  test("a reconcilable row missing from the list counts as failed, not silently skipped", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_missing",
      status: "active",
    });
    // fakeSubscriptions stays empty - Stripe's list never returns this one, e.g. a wrong/
    // orphaned stripeSubscriptionId

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 1 });
  });

  test("dry-run never writes to the DB", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    fakeSubscriptions = [fakeSubscription({ id: "sub_1", status: "canceled" })];

    const summary = await runSubscriptions(true);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.status).toBe("active");
  });

  test("corrects plan when it disagrees with the subscription's current price", async () => {
    const userId = await seedUser();
    await seedPlan({
      type: "recurring",
      interval: "month",
      name: "Basic",
      stripePriceId: "price_basic",
    });
    await seedPlan({
      type: "recurring",
      interval: "month",
      name: "Pro",
      stripePriceId: "price_pro",
    });
    await seedSubscription({
      referenceId: userId,
      plan: "basic",
      stripeSubscriptionId: "sub_1",
      status: "active",
      periodStart: new Date(0),
      periodEnd: new Date(0),
    });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_1",
        status: "active",
        items: { data: [{ current_period_start: 0, current_period_end: 0, price: { id: "price_pro" } }] },
      }),
    ];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.plan).toBe("pro");
  });

  test("a plan-only mismatch still counts as updated even when status/dates match", async () => {
    const userId = await seedUser();
    await seedPlan({
      type: "recurring",
      interval: "month",
      name: "Pro",
      stripePriceId: "price_pro",
    });
    await seedSubscription({
      referenceId: userId,
      plan: "basic", // no "Basic" plan seeded - only plan disagrees, nothing else
      stripeSubscriptionId: "sub_1",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: new Date(0),
      periodEnd: new Date(0),
    });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_1",
        status: "active",
        items: { data: [{ current_period_start: 0, current_period_end: 0, price: { id: "price_pro" } }] },
      }),
    ];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.plan).toBe("pro");
  });

  test("leaves plan untouched when no configured plan matches the current price", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "basic",
      stripeSubscriptionId: "sub_1",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: new Date(0),
      periodEnd: new Date(0),
    });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_1",
        status: "active",
        items: { data: [{ current_period_start: 0, current_period_end: 0, price: { id: "price_unknown" } }] },
      }),
    ];

    const summary = await runSubscriptions(false);

    // nothing else differs, and plan can't be confidently resolved - no update at all
    expect(summary).toEqual({ checked: 1, updated: 0, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.plan).toBe("basic");
  });
});
