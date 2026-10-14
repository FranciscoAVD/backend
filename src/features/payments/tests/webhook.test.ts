import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { paymentAuditLog as paymentAuditLogTable } from "@d/schemas/payment-schema";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let retrievedIntentMetadata: Record<string, string> = {};
let fakeLatestCharge: Record<string, unknown> | null = null;
let fakeDispute: Record<string, unknown> | null = null;

// no free local "real Stripe" to run against, unlike Postgres/Redis — so the SDK surface
// updateByCharge/resolveChargeState actually calls is faked here via bun:test's mock.module.
// Since updateByCharge now always re-fetches live state (never trusts a webhook event's own
// embedded payload - see charge-state.ts), these fakes, not the fired event's payload, are
// what actually determines the resulting purchase state in every test below.
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    paymentIntents: {
      retrieve: async (id: string, options?: { expand?: string[] }) => ({
        id,
        metadata: retrievedIntentMetadata,
        latest_charge: options?.expand?.includes("latest_charge")
          ? fakeLatestCharge
          : undefined,
      }),
    },
    disputes: {
      list: async (_args: { payment_intent: string; limit: number }) => ({
        data: fakeDispute ? [fakeDispute] : [],
      }),
    },
  }),
}));

import { confirmCheckout, handleStripeEvent } from "@f/payments/lib/webhook";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import {
  savePendingCheckout,
  getPendingCheckout,
  PENDING_CHECKOUT_TTL_SEC,
} from "@f/payments/lib/pending-checkout";

const session = (
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session =>
  ({
    id: "cs_1",
    mode: "payment",
    payment_status: "paid",
    amount_total: 1000,
    currency: "usd",
    payment_intent: "pi_1",
    created: Math.floor(Date.now() / 1000),
    metadata: null,
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const event = (
  type: Stripe.Event.Type,
  object: unknown,
  created = Math.floor(Date.now() / 1000),
): Stripe.Event =>
  ({
    id: "evt_1",
    type,
    created,
    data: { object },
  }) as unknown as Stripe.Event;

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  retrievedIntentMetadata = {};
  fakeLatestCharge = null;
  fakeDispute = null;
});

describe("confirmCheckout", () => {
  test("resolves the owner from the pending Redis entry and records the purchase", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await confirmCheckout(session({ id: "cs_1" }));

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_1");
    expect(purchase?.planId).toBe(plan.id);

    // the pending entry is cleaned up once the purchase is recorded
    expect(await getPendingCheckout("cs_1")).toBeNull();
  });

  test("falls back to session metadata when there's no pending Redis entry", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    await confirmCheckout(
      session({
        id: "cs_2",
        metadata: { userId, planId: String(plan.id) },
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_2");
  });

  test("without a paidAt, falls back to the session's own created timestamp, not insert time", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });
    const createdAgo = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60; // 5 days ago

    await confirmCheckout(
      session({
        id: "cs_backdated",
        metadata: { userId, planId: String(plan.id) },
        created: createdAgo,
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(createdAgo * 1000);
    expect(purchase?.expiresAt?.getTime()).toBe(
      createdAgo * 1000 + 30 * 24 * 60 * 60 * 1000,
    );
  });

  test("throws when there's a planId in metadata but no owner can be resolved - no silent drop", async () => {
    const userId = await seedUser();

    // has planId metadata (so it's recognizably ours) but no userId - still unresolvable
    await expect(
      confirmCheckout(session({ id: "cs_3", metadata: { planId: "1" } })),
    ).rejects.toThrow();

    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("a payment-mode session this app never created (no planId metadata) is ignored, not thrown", async () => {
    // e.g. a Payment Link, a Dashboard-created session, or another integration on the
    // same Stripe account - genuinely not ours, so this must not be treated as a drop
    await expect(
      confirmCheckout(session({ id: "cs_payment_link", metadata: null })),
    ).resolves.toBe(false);
  });

  test("reports whether it inserted the purchase: true the first time, false on a redelivery", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    const s = session({ id: "cs_once", metadata: { userId, planId: String(plan.id) } });

    expect(await confirmCheckout(s)).toBe(true);
    expect(await confirmCheckout(s)).toBe(false);
  });

  test("reports false for a session that isn't one of ours", async () => {
    expect(await confirmCheckout(session({ id: "cs_foreign", metadata: {} }))).toBe(false);
  });

  test("uses the durationDays snapshotted at checkout time, not the plan's current setting", async () => {
    const userId = await seedUser();
    // the plan was edited from 30 to 90 days while the payment was still settling
    const plan = await seedPlan({ durationDays: 90 });
    const created = Math.floor(Date.now() / 1000);

    await confirmCheckout(
      session({
        id: "cs_snapshot",
        created,
        metadata: { userId, planId: String(plan.id), durationDays: "30" },
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.durationDays).toBe(30);
    expect(purchase?.expiresAt?.getTime()).toBe(created * 1000 + 30 * 24 * 60 * 60 * 1000);
  });

  test("a 'never expires' snapshot stays perpetual even if the plan later gained a duration", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 7 });

    await confirmCheckout(
      session({
        id: "cs_perpetual",
        metadata: { userId, planId: String(plan.id), durationDays: "none" },
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.durationDays).toBeNull();
    expect(purchase?.expiresAt).toBeNull();
  });

  test("falls back to the plan's current durationDays for a session created before the snapshot existed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 14 });

    await confirmCheckout(
      session({ id: "cs_legacy", metadata: { userId, planId: String(plan.id) } }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.durationDays).toBe(14);
  });

  test("redelivering the same confirmed session doesn't log a false duplicate_purchase_confirmed", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ repeatable: false });
    const s = session({
      id: "cs_redelivered",
      metadata: { userId, planId: String(plan.id) },
    });

    await confirmCheckout(s);
    await confirmCheckout(s); // Stripe's at-least-once redelivery of the same event

    const purchases = await getAllPurchases({ userId });
    expect(purchases).toHaveLength(1);

    const audits = await db
      .select()
      .from(paymentAuditLogTable)
      .where(eq(paymentAuditLogTable.userId, userId));
    expect(audits).toEqual([]);
  });

  test("throws when the purchased plan no longer exists - no silent drop", async () => {
    const userId = await seedUser();

    await expect(
      confirmCheckout(
        session({ id: "cs_4", metadata: { userId, planId: "999999" } }),
      ),
    ).rejects.toThrow();

    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("still records a duplicate payment for an already-owned non-repeatable plan, and audits it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ repeatable: false });
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

    await savePendingCheckout(
      "cs_dup",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    // the money's already taken for this second session - must not throw or drop it
    await confirmCheckout(
      session({ id: "cs_dup", payment_intent: "pi_dup" }),
    );

    const purchases = await getAllPurchases({ userId });
    expect(purchases).toHaveLength(2);
    expect(purchases.map((p) => p.stripeCheckoutSessionId).sort()).toEqual([
      "cs_dup",
      "cs_existing",
    ]);

    const [audit] = await db
      .select()
      .from(paymentAuditLogTable)
      .where(eq(paymentAuditLogTable.userId, userId));
    expect(audit?.type).toBe("duplicate_purchase_confirmed");
    expect(audit?.planId).toBe(plan.id);
    expect(audit?.stripeCheckoutSessionId).toBe("cs_dup");
  });
});

describe("a $0 checkout (e.g. a 100% coupon)", () => {
  test("completes as no_payment_required and is recorded with no payment intent", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({
          id: "cs_free",
          payment_status: "no_payment_required",
          payment_intent: null,
          amount_total: 0,
          metadata: { userId, planId: String(plan.id) },
        }),
      ),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase).toMatchObject({
      stripeCheckoutSessionId: "cs_free",
      stripePaymentIntentId: null,
      amountTotal: 0,
      status: "paid",
    });
  });
});

describe("handleStripeEvent", () => {
  test("ignores an event type outside ALLOWED_EVENTS", async () => {
    const userId = await seedUser();
    await handleStripeEvent(event("customer.created", {}));
    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("checkout.session.completed with mode payment and paid status confirms the checkout", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event("checkout.session.completed", session({ payment_status: "paid" })),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase).not.toBeUndefined();
  });

  test("a delayed payment's access window starts when it settled, not when checkout began", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 7 });
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - 8 * 24 * 60 * 60; // bank debit started 8 days ago...
    const settledAt = now - 60; // ...and settled a minute ago

    await handleStripeEvent(
      event(
        "checkout.session.async_payment_succeeded",
        session({
          id: "cs_bank_debit",
          created: startedAt,
          metadata: { userId, planId: String(plan.id), durationDays: "7" },
        }),
        settledAt,
      ),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(settledAt * 1000);
    expect(purchase?.expiresAt?.getTime()).toBe((settledAt + 7 * 24 * 60 * 60) * 1000);
    // with session.created as the clock, this 7-day plan would already have lapsed
    const { hasActivePurchase } = await import("@f/payments/use-cases/get-purchases");
    expect(
      await hasActivePurchase({ userId, planId: plan.id }, { overlapping: plan.overlapping }),
    ).toBe(true);
  });

  test("a redelivered success event keeps its original timestamp, so a late delivery adds no days", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30 });
    const paidAt = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60; // paid 3 days ago, delivered now

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({ id: "cs_late", metadata: { userId, planId: String(plan.id) } }),
        paidAt,
      ),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.createdAt.getTime()).toBe(paidAt * 1000);
  });

  test("checkout.session.completed with an unpaid status marks it processing instead", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({ payment_status: "unpaid" }),
      ),
    );

    expect(await getAllPurchases({ userId })).toEqual([]);
    expect((await getPendingCheckout("cs_1"))?.status).toBe("processing");
  });

  test("checkout.session.completed in subscription mode is ignored entirely", async () => {
    const userId = await seedUser();
    await handleStripeEvent(
      event("checkout.session.completed", session({ mode: "subscription" })),
    );
    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("checkout.session.async_payment_failed marks the pending entry failed, not gone", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event("checkout.session.async_payment_failed", session()),
    );

    expect((await getPendingCheckout("cs_1"))?.status).toBe("failed");
  });

  test("checkout.session.expired marks the pending entry expired, not gone", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(event("checkout.session.expired", session()));

    expect((await getPendingCheckout("cs_1"))?.status).toBe("expired");
  });

  test("charge.refunded updates an existing purchase's refund state from the live charge", async () => {
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
    fakeLatestCharge = { amount_refunded: plan.amount, refunded: true, disputed: false };

    await handleStripeEvent(
      event("charge.refunded", { payment_intent: "pi_1" }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.amountRefunded).toBe(plan.amount);
  });

  test("charge.refunded re-fetches the live charge instead of trusting a stale event payload", async () => {
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
    // the live charge says a full refund...
    fakeLatestCharge = { amount_refunded: plan.amount, refunded: true, disputed: false };

    // ...but the delivered (possibly retried/out-of-order) event's own payload disagrees
    await handleStripeEvent(
      event("charge.refunded", {
        payment_intent: "pi_1",
        amount_refunded: 1,
        refunded: false,
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.amountRefunded).toBe(plan.amount);
  });

  test("charge.refunded with no matching purchase, but ours (has metadata.planId), throws so Stripe retries", async () => {
    retrievedIntentMetadata = { planId: "1" };
    fakeLatestCharge = { amount_refunded: 500, refunded: false, disputed: false };

    await expect(
      handleStripeEvent(
        event("charge.refunded", { payment_intent: "pi_dangling" }),
      ),
    ).rejects.toThrow();
  });

  test("charge.refunded with no matching purchase and no planId metadata is ignored (e.g. a subscription invoice)", async () => {
    retrievedIntentMetadata = {};
    fakeLatestCharge = { amount_refunded: 500, refunded: false, disputed: false };

    await expect(
      handleStripeEvent(
        event("charge.refunded", { payment_intent: "pi_subscription_invoice" }),
      ),
    ).resolves.toBeUndefined();
  });

  test("charge.dispute.created updates the purchase status from the live dispute", async () => {
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
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "needs_response" };

    await handleStripeEvent(
      event("charge.dispute.created", { payment_intent: "pi_1" }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("disputed");
  });

  test("a stale charge.dispute.created delivered after the dispute closed as won doesn't regress the purchase", async () => {
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
    // the dispute has already closed won in Stripe's live records...
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "won" };

    // ...but this retried/out-of-order event's own payload still claims it's unresolved
    await handleStripeEvent(
      event("charge.dispute.created", {
        payment_intent: "pi_1",
        status: "needs_response",
      }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("paid");
  });

  test("a lost dispute updates status and amountRefunded together", async () => {
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
    fakeLatestCharge = {
      amount_refunded: plan.amount,
      refunded: true,
      disputed: true,
    };
    fakeDispute = { status: "lost" };

    await handleStripeEvent(
      event("charge.dispute.closed", { payment_intent: "pi_1" }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.amountRefunded).toBe(plan.amount);
  });
});
