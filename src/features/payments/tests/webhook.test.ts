import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { paymentAuditLog as paymentAuditLogTable } from "@d/schemas/payment-schema";
import { resetDb, seedUser, seedPlan, seedCheckout } from "@/test-helpers/db";

let retrievedIntentMetadata: Record<string, string> = {};
let fakeLatestCharge: Record<string, unknown> | null = null;
let fakeDispute: Record<string, unknown> | null = null;
let purchaseConfirmationEmailCalls: Record<string, unknown>[] = [];
let purchaseConfirmationEmailFails = false;

// mocks @f/email/lib/client, not @f/email/send - see CLAUDE.md's testing section for why.
// Without this, confirmCheckout's best-effort email send would hit the real (sandboxed) Resend
// API on every test that reaches it - still harmless (errors are swallowed), but not the fully
// offline, deterministic suite this mirrors every other Stripe-dependent test's approach for.
mock.module("@f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: {
      send: async (payload: Record<string, unknown>) => {
        if (purchaseConfirmationEmailFails) throw new Error("Resend is down");
        purchaseConfirmationEmailCalls.push(payload);
        return { data: { id: "email_1" }, error: null };
      },
    },
  }),
}));

// no free local "real Stripe" to run against, unlike Postgres/Redis — so the SDK surface
// updateByCharge/resolveChargeState actually calls is faked here via bun:test's mock.module.
// Since updateByCharge now always re-fetches live state (never trusts a webhook event's own
// embedded payload - see charge-state.ts), these fakes, not the fired event's payload, are
// what actually determines the resulting purchase state in every test below.
mock.module("@f/payments/lib/stripe/client", () => ({
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

import { confirm as confirmCheckout } from "@f/payments/services/fulfillment";
import { handleStripeEvent } from "@f/payments/lib/webhook";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import { paymentsRepo } from "@f/payments/repo";

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
  retrievedIntentMetadata = {};
  fakeLatestCharge = null;
  fakeDispute = null;
  purchaseConfirmationEmailCalls = [];
  purchaseConfirmationEmailFails = false;
});

describe("confirmCheckout", () => {
  test("a matching checkout row still records the purchase", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_1",
    });

    // a real session always carries metadata too (set at checkout time) - this is what
    // confirmCheckout actually resolves the owner from; the checkout row just cross-checks it
    await confirmCheckout(
      session({ id: "cs_1", metadata: { userId, planId: String(plan.id) } }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_1");
    expect(purchase?.planId).toBe(plan.id);

    // the checkout row is marked completed once the purchase is recorded, freeing the slot
    expect(
      (await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_1" }))?.status,
    ).toBe("completed");
  });

  test("falls back to session metadata when there's no checkout row", async () => {
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

    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_dup",
    });

    // the money's already taken for this second session - must not throw or drop it
    await confirmCheckout(
      session({
        id: "cs_dup",
        payment_intent: "pi_dup",
        metadata: { userId, planId: String(plan.id) },
      }),
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

  test("a mismatched userId between the checkout row and the metadata throws and inserts nothing", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const plan = await seedPlan();
    await seedCheckout({
      userId: userA,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_mismatch_user",
    });

    await expect(
      confirmCheckout(
        session({
          id: "cs_mismatch_user",
          metadata: { userId: userB, planId: String(plan.id) },
        }),
      ),
    ).rejects.toThrow();

    expect(await getAllPurchases({ userId: userA })).toEqual([]);
    expect(await getAllPurchases({ userId: userB })).toEqual([]);
  });

  test("a mismatched planId between the checkout row and the metadata throws and inserts nothing", async () => {
    const userId = await seedUser();
    const planA = await seedPlan();
    const planB = await seedPlan();
    await seedCheckout({
      userId: userId,
      planId: planA.id,
      stripeCheckoutSessionId: "cs_mismatch_plan",
    });

    await expect(
      confirmCheckout(
        session({
          id: "cs_mismatch_plan",
          metadata: { userId, planId: String(planB.id) },
        }),
      ),
    ).rejects.toThrow();

    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("a new purchase sends exactly one confirmation email, to the buyer's own address", async () => {
    const userId = await seedUser({ email: "buyer@example.test", name: "Ada" });
    const plan = await seedPlan({ name: "Pro" });

    await confirmCheckout(
      session({
        id: "cs_confirmation_email",
        metadata: { userId, planId: String(plan.id) },
      }),
    );

    expect(purchaseConfirmationEmailCalls).toHaveLength(1);
    expect(purchaseConfirmationEmailCalls[0]?.to).toBe("buyer@example.test");
    expect(purchaseConfirmationEmailCalls[0]?.html).toContain("Hi Ada,");
  });

  test("redelivering an already-recorded session sends no additional email", async () => {
    const userId = await seedUser({ email: "buyer@example.test" });
    const plan = await seedPlan();
    const theSession = session({
      id: "cs_redelivered_email",
      metadata: { userId, planId: String(plan.id) },
    });

    await confirmCheckout(theSession);
    expect(purchaseConfirmationEmailCalls).toHaveLength(1);

    // the same webhook delivered again - onConflictDoNothing means `inserted` is null this time
    await confirmCheckout(theSession);
    expect(purchaseConfirmationEmailCalls).toHaveLength(1);
  });

  test("a failing confirmation email doesn't fail the purchase confirmation itself", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    purchaseConfirmationEmailFails = true;

    await expect(
      confirmCheckout(
        session({
          id: "cs_email_fails",
          metadata: { userId, planId: String(plan.id) },
        }),
      ),
    ).resolves.toBe(true);

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_email_fails");
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
    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_1",
    });

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({ payment_status: "paid", metadata: { userId, planId: String(plan.id) } }),
      ),
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

  test("each purchase keeps the overlapping rule it was sold under after the plan changes", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ durationDays: 30, repeatable: true, overlapping: false });
    const now = Math.floor(Date.now() / 1000);
    const buy = (id: string, paidDaysAgo: number) =>
      confirmCheckout(
        session({
          id,
          payment_intent: `pi_${id}`,
          metadata: {
            userId,
            planId: String(plan.id),
            durationDays: "30",
            overlapping: "false",
          },
        }),
        new Date((now - paidDaysAgo * 24 * 60 * 60) * 1000),
      );
    // bought 40 and 35 days ago as a chained pair: -40..-10, then -10..+20
    await buy("cs_a", 40);
    await buy("cs_b", 35);

    const purchases = await getAllPurchases({ userId });
    expect(purchases.map((p) => p.overlapping)).toEqual([false, false]);

    // the admin later flips the plan - read with the plan's new flag, both windows lapsed
    const { db } = await import("@d/connection");
    const { plan: planTable } = await import("@d/schemas/payment-schema");
    const { eq } = await import("drizzle-orm");
    await db.update(planTable).set({ overlapping: true }).where(eq(planTable.id, plan.id));

    const { hasActivePurchase } = await import("@f/payments/use-cases/get-purchases");
    expect(await hasActivePurchase({ userId, planId: plan.id }, { overlapping: true })).toBe(true);
  });

  test("a session from before the overlapping snapshot falls back to the plan's setting", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ overlapping: false });

    await confirmCheckout(
      session({ id: "cs_old", metadata: { userId, planId: String(plan.id) } }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.overlapping).toBe(false);
  });

  test("checkout.session.completed with an unpaid status marks it processing instead", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_1",
    });

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({ payment_status: "unpaid" }),
      ),
    );

    expect(await getAllPurchases({ userId })).toEqual([]);
    expect((await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_1" }))?.status).toBe("processing");
  });

  test("checkout.session.completed in subscription mode is ignored entirely", async () => {
    const userId = await seedUser();
    await handleStripeEvent(
      event("checkout.session.completed", session({ mode: "subscription" })),
    );
    expect(await getAllPurchases({ userId })).toEqual([]);
  });

  test("checkout.session.async_payment_failed marks the checkout row failed, not gone", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_1",
    });

    await handleStripeEvent(
      event("checkout.session.async_payment_failed", session()),
    );

    expect((await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_1" }))?.status).toBe("failed");
  });

  test("checkout.session.expired marks the checkout row expired, not gone", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await seedCheckout({
      userId: userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_1",
    });

    await handleStripeEvent(event("checkout.session.expired", session()));

    expect((await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_1" }))?.status).toBe("expired");
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

  test("charge.refunded sends exactly one refund-confirmation email", async () => {
    const userId = await seedUser({ email: "buyer@example.test", name: "Ada" });
    const plan = await seedPlan({ name: "Pro" });
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_refund_email",
        stripePaymentIntentId: "pi_refund_email",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    fakeLatestCharge = { amount_refunded: plan.amount, refunded: true, disputed: false };

    await handleStripeEvent(event("charge.refunded", { payment_intent: "pi_refund_email" }));

    expect(purchaseConfirmationEmailCalls).toHaveLength(1);
    expect(purchaseConfirmationEmailCalls[0]?.to).toBe("buyer@example.test");
    expect(purchaseConfirmationEmailCalls[0]?.subject).toBe("Your refund has been processed");

    // redelivering the same already-synced charge sends no additional email
    await handleStripeEvent(event("charge.refunded", { payment_intent: "pi_refund_email" }));
    expect(purchaseConfirmationEmailCalls).toHaveLength(1);
  });

  test("a dispute merely opening sends no refund-confirmation email", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_dispute_open",
        stripePaymentIntentId: "pi_dispute_open",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    // open dispute: status moves to "disputed", but no money has moved yet
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "needs_response", amount: plan.amount };

    await handleStripeEvent(event("charge.dispute.created", { payment_intent: "pi_dispute_open" }));

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("disputed");
    expect(purchaseConfirmationEmailCalls).toHaveLength(0);
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

describe("duplicate_purchase_confirmed is written once per duplicate charge", () => {
  beforeEach(async () => {
    await resetDb();
    });

  test("redeliveries of an already-recorded duplicate add no further entries", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ repeatable: false });
    const paid = (id: string) =>
      session({
        id,
        payment_intent: `pi_${id}`,
        metadata: { userId, planId: String(plan.id) },
      });

    await confirmCheckout(paid("cs_first"));
    // the duplicate, then Stripe redelivering it twice (e.g. a lost 200), plus the reconciler
    await confirmCheckout(paid("cs_dup"));
    await confirmCheckout(paid("cs_dup"));
    await confirmCheckout(paid("cs_dup"));

    const rows = await db.select().from(paymentAuditLogTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "duplicate_purchase_confirmed",
      stripeCheckoutSessionId: "cs_dup",
    });
    expect(await getAllPurchases({ userId })).toHaveLength(2);
  });
});

describe("duplicate charges confirmed concurrently", () => {
  beforeEach(async () => {
    await resetDb();
    });

  const paidSession = (id: string, userId: string, planId: number) =>
    ({
      id,
      mode: "payment",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      amount_total: 1000,
      currency: "usd",
      payment_intent: `pi_${id}`,
      metadata: { userId, planId: String(planId), durationDays: "none", overlapping: "true" },
    }) as unknown as Stripe.Checkout.Session;

  // confirm checks for an existing blocking purchase only after its own insert, not before - a
  // check before the insert would let two concurrent confirmations each see nothing blocking and
  // both record the duplicate purchase, unflagged
  test("two sessions for a non-repeatable plan confirmed at once always leave an audit entry", async () => {
    for (let i = 0; i < 20; i++) {
      await resetDb();
      const userId = await seedUser();
      const plan = await seedPlan({ repeatable: false });

      await Promise.all([
        confirmCheckout(paidSession(`cs_a${i}`, userId, plan.id)),
        confirmCheckout(paidSession(`cs_b${i}`, userId, plan.id)),
      ]);

      expect(await getAllPurchases({ userId })).toHaveLength(2);
      const audits = await db
        .select()
        .from(paymentAuditLogTable)
        .where(eq(paymentAuditLogTable.type, "duplicate_purchase_confirmed"));
      expect(audits.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("charge.refund.updated", () => {
  beforeEach(async () => {
    await resetDb();
    });

  // a failed refund lowers amount_refunded again without another charge.refunded
  test("a refund that later failed hands access back", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_refund_failed",
        stripePaymentIntentId: "pi_refund_failed",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    fakeLatestCharge = { amount_refunded: plan.amount, refunded: true, disputed: false };
    await handleStripeEvent(event("charge.refunded", { payment_intent: "pi_refund_failed" }));
    expect((await getAllPurchases({ userId }))[0]?.status).toBe("refunded");

    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: false };
    await handleStripeEvent(
      event("charge.refund.updated", { payment_intent: "pi_refund_failed", status: "failed" }),
    );

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase?.status).toBe("paid");
    expect(purchase?.amountRefunded).toBe(0);
  });
});
