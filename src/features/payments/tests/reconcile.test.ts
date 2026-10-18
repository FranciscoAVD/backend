import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { db } from "@d/connection";
import { subscription as subscriptionTable, user as userTable } from "@d/schemas/auth-schema";
import { eq } from "drizzle-orm";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let fakeSessions: Partial<Stripe.Checkout.Session>[] = [];
let fakeEvents: Partial<Stripe.Event>[] = [];
// e.g. a restricted API key without event read access
let eventsFail = false;
// live charge state per payment intent, for resolveChargeState's fresh retrieve
let fakeCharges: Record<string, Record<string, unknown>> = {};
let fakeDisputeStatus: string | null = null;
let intentRetrieves: string[] = [];
let fakeSubscriptions: Partial<Stripe.Subscription>[] = [];
// ids runSubscriptions fell back to retrieving individually, because the list didn't return them
let retrieved: string[] = [];

// no free local "real Stripe" to run against — the SDK surface run()/reconcile() actually call
// is faked here via bun:test's mock.module
mock.module("@f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    checkout: { sessions: { list: () => fakeSessions } },
    events: {
      list: (params: Stripe.EventListParams) =>
        eventsFail
          ? {
              // like the SDK's auto-paginating list, the request fails once iterated
              async *[Symbol.asyncIterator]() {
                throw new Error("This API key does not have the rak_event_read permission");
              },
            }
          : fakeEvents.filter((e) => params.types?.includes(e.type as string) ?? true),
    },
    disputes: {
      list: async () => ({ data: fakeDisputeStatus ? [{ status: fakeDisputeStatus }] : [] }),
    },
    paymentIntents: {
      retrieve: async (id: string) => {
        intentRetrieves.push(id);
        // live state: an explicit override, else the charge the listed session itself carries
        const listed = fakeSessions.find(
          (s) => (s.payment_intent as { id?: string } | null)?.id === id,
        )?.payment_intent as { latest_charge?: unknown } | undefined;
        return { id, latest_charge: fakeCharges[id] ?? listed?.latest_charge ?? null };
      },
    },
    subscriptions: {
      // mirrors Stripe's real default: without a `status`, the list leaves out canceled
      // subscriptions - a fake that ignored this is what let runSubscriptions miss them
      list: (params: Stripe.SubscriptionListParams = {}) =>
        params.status === "all"
          ? fakeSubscriptions
          : fakeSubscriptions.filter((sub) => sub.status !== "canceled"),
      retrieve: async (id: string) => {
        retrieved.push(id);
        const sub = fakeSubscriptions.find((s) => s.id === id);
        if (!sub)
          throw Object.assign(new Error(`No such subscription: '${id}'`), {
            code: "resource_missing",
          });
        return sub;
      },
    },
  }),
}));

import { purchases as run, subscriptions as runSubscriptions } from "@f/payments/services/reconcile";
import { getAllPurchases, getPurchaseBySessionAnyUser } from "@f/payments/use-cases/get-purchases";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import {
  CHECKOUT_SOURCE_METADATA_KEY,
  CHECKOUT_SOURCE_METADATA_VALUE,
} from "@f/payments/lib/constants";

// how every Checkout Session this app creates is tagged (see CHECKOUT_SOURCE_METADATA_KEY) - the
// sessions below stand in for ones it created, so they carry it too
const OURS = { [CHECKOUT_SOURCE_METADATA_KEY]: CHECKOUT_SOURCE_METADATA_VALUE };


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

const DAY_SEC = 24 * 60 * 60;

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
  fakeEvents = [];
  eventsFail = false;
  fakeCharges = {};
  fakeDisputeStatus = null;
  intentRetrieves = [];
  fakeSubscriptions = [];
  retrieved = [];
});

describe("run", () => {
  test("counts a successful confirm as inserted, not failed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      fakeSession({
        id: "cs_ok",
        metadata: { ...OURS, userId, planId: String(plan.id) },
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

  test("skips another integration's paid session on the same Stripe account - not inserted, not failed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      // e.g. a Payment Link that happens to use the same metadata keys: untagged, no checkout row
      fakeSession({
        id: "cs_payment_link",
        metadata: { userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_payment_link",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
      // one with only `planId` - which used to count as failed on every run, for lacking `userId`
      fakeSession({
        id: "cs_other_app",
        metadata: { planId: "7" },
        payment_intent: null,
      }),
    ];

    const summary = await run(7, false);

    expect(summary).toEqual({ scanned: 0, inserted: 0, updated: 0, failed: 0 });
    expect(await getAllPurchases({ userId })).toHaveLength(0);
  });

  test("a late insert starts access when Stripe says it was paid, not when checkout began or now", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - 10 * DAY_SEC;
    const settledAt = now - 2 * DAY_SEC;
    const s = fakeSession({
      id: "cs_settled",
      created: startedAt,
      payment_status: "paid",
      metadata: { ...OURS, userId, planId: String(plan.id) },
      payment_intent: {
        id: "pi_settled",
        latest_charge: { created: startedAt, amount_refunded: 0, refunded: false, disputed: false },
      } as unknown as Stripe.PaymentIntent,
    });
    fakeSessions = [s];
    fakeEvents = [
      // the delayed method's completed-but-unpaid event isn't the success
      {
        type: "checkout.session.completed",
        created: startedAt,
        data: { object: { ...s, payment_status: "unpaid" } },
      } as Partial<Stripe.Event>,
      {
        type: "checkout.session.async_payment_succeeded",
        created: settledAt,
        data: { object: s },
      } as Partial<Stripe.Event>,
    ];

    await run(14, false);

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(settledAt * 1000);
  });

  test("with no success event to go by, a late insert falls back to the charge's own time", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });
    const chargedAt = Math.floor(Date.now() / 1000) - 3 * DAY_SEC;
    fakeSessions = [
      fakeSession({
        id: "cs_no_event",
        created: chargedAt - 600,
        metadata: { ...OURS, userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_no_event",
          latest_charge: { created: chargedAt, amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];

    await run(14, false);

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(chargedAt * 1000);
  });

  test("without the Events API, the session scan still runs; only the charge-event pass is lost", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    const chargedAt = Math.floor(Date.now() / 1000) - 3 * DAY_SEC;
    fakeSessions = [
      fakeSession({
        id: "cs_ok",
        metadata: { ...OURS, userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_ok",
          latest_charge: { created: chargedAt, amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];
    eventsFail = true;

    const summary = await run(14, false);

    // the insert still happens, dated by the charge instead of the success event; the skipped
    // charge-event pass counts as one failure, so the run still exits non-zero and gets noticed
    expect(summary).toEqual({ scanned: 1, inserted: 1, updated: 0, failed: 1 });
    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(chargedAt * 1000);
  });

  test("a confirmCheckout failure (e.g. the plan was deleted) counts as failed, not inserted", async () => {
    const userId = await seedUser();
    fakeSessions = [
      fakeSession({
        id: "cs_bad_plan",
        metadata: { ...OURS, userId, planId: "999999" }, // no such plan
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
        metadata: { ...OURS, userId, planId: String(plan.id) },
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
        metadata: { ...OURS, userId, planId: String(plan.id) },
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
        metadata: { ...OURS, userId, planId: String(plan.id) },
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

  test("a $0 session (no_payment_required, no payment intent) is inserted like any other", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      fakeSession({
        id: "cs_free",
        payment_status: "no_payment_required",
        payment_intent: null,
        metadata: { ...OURS, userId, planId: String(plan.id) },
      }),
    ];

    expect(await run(7, false)).toEqual({ scanned: 1, inserted: 1, updated: 0, failed: 0 });
    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.stripePaymentIntentId).toBeNull();
    // and a second run leaves it alone
    expect(await run(7, false)).toEqual({ scanned: 1, inserted: 0, updated: 0, failed: 0 });
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
        metadata: { ...OURS, userId, planId: String(plan.id) },
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

describe("run: refunds and disputes on older purchases", () => {
  // a purchase made long before the session scan's window, so only the charge-event pass sees it
  const oldPurchase = async (userId: string, intentId: string) => {
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: `cs_${intentId}`,
        stripePaymentIntentId: intentId,
        amountTotal: 1000,
        currency: "usd",
      },
      { durationDays: null },
      new Date(Date.now() - 60 * DAY_SEC * 1000),
    );
  };
  const chargeEvent = (type: string, intentId: string) =>
    ({ type, created: Math.floor(Date.now() / 1000), data: { object: { payment_intent: intentId } } }) as Partial<Stripe.Event>;

  test("a lost dispute webhook on a 60-day-old purchase is still caught", async () => {
    const userId = await seedUser();
    await oldPurchase(userId, "pi_old");
    fakeEvents = [chargeEvent("charge.dispute.created", "pi_old")];
    fakeCharges = { pi_old: { amount_refunded: 0, refunded: false, disputed: true } };
    fakeDisputeStatus = "needs_response";

    const summary = await run(14, false);

    expect(summary).toEqual({ scanned: 0, inserted: 0, updated: 1, failed: 0 });
    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("disputed");
  });

  test("a lost refund webhook on an older purchase is still caught", async () => {
    const userId = await seedUser();
    await oldPurchase(userId, "pi_old");
    fakeEvents = [chargeEvent("charge.refunded", "pi_old")];
    fakeCharges = { pi_old: { amount_refunded: 1000, refunded: true, disputed: false } };

    await run(14, false);

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("an event whose state already matches changes nothing", async () => {
    const userId = await seedUser();
    await oldPurchase(userId, "pi_old");
    fakeEvents = [chargeEvent("charge.dispute.closed", "pi_old")];
    fakeCharges = { pi_old: { amount_refunded: 0, refunded: false, disputed: true } };
    fakeDisputeStatus = "won";

    expect(await run(14, false)).toEqual({ scanned: 0, inserted: 0, updated: 0, failed: 0 });
  });

  test("a payment intent with no purchase (e.g. a subscription invoice) is skipped, not failed", async () => {
    fakeEvents = [chargeEvent("charge.refunded", "pi_invoice")];

    expect(await run(14, false)).toEqual({ scanned: 0, inserted: 0, updated: 0, failed: 0 });
    expect(intentRetrieves).toEqual([]);
  });

  test("a dry run reports the change without writing it", async () => {
    const userId = await seedUser();
    await oldPurchase(userId, "pi_old");
    fakeEvents = [chargeEvent("charge.refunded", "pi_old")];
    fakeCharges = { pi_old: { amount_refunded: 1000, refunded: true, disputed: false } };

    expect((await run(14, true)).updated).toBe(1);
    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("paid");
  });

  test("an intent the session scan already synced isn't fetched again", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    fakeSessions = [
      fakeSession({
        id: "cs_recent",
        metadata: { ...OURS, userId, planId: String(plan.id) },
        payment_intent: {
          id: "pi_recent",
          latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
        } as unknown as Stripe.PaymentIntent,
      }),
    ];
    fakeEvents = [chargeEvent("charge.refunded", "pi_recent")];

    await run(14, false);

    expect(intentRetrieves).toEqual([]);
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

  test("revokes access when the cancellation webhook was lost", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
    });
    fakeSubscriptions = [
      fakeSubscription({ id: "sub_1", status: "canceled", ended_at: 1_767_225_600 }),
    ];

    const { hasActiveSubscription } = await import("@f/payments/use-cases/get-subscription");
    expect(await hasActiveSubscription({ userId }, { name: "pro" })).toBe(true);

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(retrieved).toEqual(["sub_1"]);
    expect(await hasActiveSubscription({ userId }, { name: "pro" })).toBe(false);
  });

  test("only falls back to a per-row retrieve for rows the list didn't return", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_live",
      status: "active",
    });
    fakeSubscriptions = [fakeSubscription({ id: "sub_live", status: "past_due" })];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(retrieved).toEqual([]);
  });

  test("still corrects a row whose timestamps are all set (the compare-and-set matches them exactly)", async () => {
    const userId = await seedUser();
    const at = (iso: string) => new Date(iso);
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
      periodStart: at("2026-09-01T10:11:12.345Z"),
      periodEnd: at("2026-10-01T10:11:12.345Z"),
      trialStart: at("2026-08-01T00:00:00.001Z"),
      trialEnd: at("2026-08-15T00:00:00.999Z"),
      cancelAt: at("2026-10-01T10:11:12.345Z"),
      canceledAt: at("2026-09-20T05:06:07.890Z"),
      cancelAtPeriodEnd: true,
    });
    fakeSubscriptions = [fakeSubscription({ id: "sub_1", status: "past_due" })];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.status).toBe("past_due");
  });

  test("never writes an older listed snapshot over a webhook that landed mid-run", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_1",
      status: "active",
      periodEnd: new Date(0),
    });
    // listed before the cancellation: still active, with a renewed period (so it differs)
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_1",
        status: "active",
        items: { data: [{ current_period_start: 0, current_period_end: 1_800_000_000, price: { id: "price_default" } }] },
      }),
    ];

    // the customer.subscription.deleted webhook lands after the reconciler has read the row
    const { paymentsRepo } = await import("@f/payments/repo");
    const realGetReconcilable = paymentsRepo.subscription.getReconcilable;
    paymentsRepo.subscription.getReconcilable = async () => {
      const rows = await realGetReconcilable();
      await db
        .update(subscriptionTable)
        .set({ status: "canceled", endedAt: new Date() })
        .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
      return rows;
    };
    try {
      const summary = await runSubscriptions(false);
      expect(summary).toMatchObject({ checked: 1, updated: 0, failed: 0 });
    } finally {
      paymentsRepo.subscription.getReconcilable = realGetReconcilable;
    }

    const [row] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, "sub_1"));
    expect(row?.status).toBe("canceled");
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

  test("a reconcilable row missing from Stripe entirely counts as failed, not silently skipped", async () => {
    const userId = await seedUser();
    await seedSubscription({
      referenceId: userId,
      plan: "pro",
      stripeSubscriptionId: "sub_missing",
      status: "active",
    });
    // fakeSubscriptions stays empty - neither the list nor a retrieve finds this one, e.g. a
    // wrong/orphaned stripeSubscriptionId

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 1 });
    expect(retrieved).toEqual(["sub_missing"]);
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

describe("runSubscriptions: rows never linked to their Stripe subscription", () => {
  // the plugin's own checkout.session.completed handler swallows its errors, so a transient
  // failure leaves the row `incomplete` with no stripeSubscriptionId while Stripe bills the user
  test("links the row via the plugin's metadata and corrects its status", async () => {
    const userId = await seedUser();
    const row = await seedSubscription({
      referenceId: userId,
      plan: "pro",
      status: "incomplete",
      stripeCustomerId: "cus_1",
    });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_live",
        customer: "cus_1",
        metadata: { subscriptionId: row.id, referenceId: userId, userId },
      }),
    ];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [after] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.id, row.id));
    expect(after?.stripeSubscriptionId).toBe("sub_live");
    expect(after?.status).toBe("active");
  });

  test("refuses to link when the subscription belongs to someone else", async () => {
    const userId = await seedUser();
    const otherId = await seedUser();
    const row = await seedSubscription({ referenceId: userId, plan: "pro", status: "incomplete" });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_live",
        metadata: { subscriptionId: row.id, referenceId: otherId, userId: otherId },
      }),
    ];

    const summary = await runSubscriptions(false);

    expect(summary).toEqual({ checked: 1, updated: 0, failed: 1 });
    const [after] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.id, row.id));
    expect(after?.stripeSubscriptionId).toBeNull();
    expect(after?.status).toBe("incomplete");
  });

  test("a dry run reports the link without writing it", async () => {
    const userId = await seedUser();
    const row = await seedSubscription({ referenceId: userId, plan: "pro", status: "incomplete" });
    fakeSubscriptions = [
      fakeSubscription({
        id: "sub_live",
        metadata: { subscriptionId: row.id, referenceId: userId },
      }),
    ];

    expect(await runSubscriptions(true)).toEqual({ checked: 1, updated: 1, failed: 0 });
    const [after] = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.id, row.id));
    expect(after?.stripeSubscriptionId).toBeNull();
  });
});
