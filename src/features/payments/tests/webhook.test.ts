import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

let retrievedIntentMetadata: Record<string, string> = {};

mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    paymentIntents: {
      retrieve: async (id: string) => ({
        id,
        metadata: retrievedIntentMetadata,
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
    metadata: null,
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const event = (
  type: Stripe.Event.Type,
  object: unknown,
): Stripe.Event =>
  ({
    id: "evt_1",
    type,
    data: { object },
  }) as unknown as Stripe.Event;

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  retrievedIntentMetadata = {};
});

describe("confirmCheckout", () => {
  test("resolves the owner from the pending Redis entry and records the purchase", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userID, planID: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await confirmCheckout(session({ id: "cs_1" }));

    const [purchase] = await getAllPurchases({ userID });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_1");
    expect(purchase?.planID).toBe(plan.id);

    // the pending entry is cleaned up once the purchase is recorded
    expect(await getPendingCheckout("cs_1")).toBeNull();
  });

  test("falls back to session metadata when there's no pending Redis entry", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();

    await confirmCheckout(
      session({
        id: "cs_2",
        metadata: { userID, planID: String(plan.id) },
      }),
    );

    const [purchase] = await getAllPurchases({ userID });
    expect(purchase?.stripeCheckoutSessionId).toBe("cs_2");
  });

  test("records nothing when the owner can't be resolved at all", async () => {
    const userID = await seedUser();

    await confirmCheckout(session({ id: "cs_3", metadata: null }));

    expect(await getAllPurchases({ userID })).toEqual([]);
  });
});

describe("handleStripeEvent", () => {
  test("ignores an event type outside ALLOWED_EVENTS", async () => {
    const userID = await seedUser();
    await handleStripeEvent(event("customer.created", {}));
    expect(await getAllPurchases({ userID })).toEqual([]);
  });

  test("checkout.session.completed with mode payment and paid status confirms the checkout", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userID, planID: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event("checkout.session.completed", session({ payment_status: "paid" })),
    );

    const [purchase] = await getAllPurchases({ userID });
    expect(purchase).not.toBeUndefined();
  });

  test("checkout.session.completed with an unpaid status marks it processing instead", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userID, planID: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event(
        "checkout.session.completed",
        session({ payment_status: "unpaid" }),
      ),
    );

    expect(await getAllPurchases({ userID })).toEqual([]);
    expect((await getPendingCheckout("cs_1"))?.status).toBe("processing");
  });

  test("checkout.session.completed in subscription mode is ignored entirely", async () => {
    const userID = await seedUser();
    await handleStripeEvent(
      event("checkout.session.completed", session({ mode: "subscription" })),
    );
    expect(await getAllPurchases({ userID })).toEqual([]);
  });

  test("checkout.session.async_payment_failed removes the pending entry", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userID, planID: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(
      event("checkout.session.async_payment_failed", session()),
    );

    expect(await getPendingCheckout("cs_1")).toBeNull();
  });

  test("checkout.session.expired removes the pending entry", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await savePendingCheckout(
      "cs_1",
      { userID, planID: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await handleStripeEvent(event("checkout.session.expired", session()));

    expect(await getPendingCheckout("cs_1")).toBeNull();
  });

  test("charge.refunded updates an existing purchase's refund state", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userID },
      {
        planID: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    await handleStripeEvent(
      event("charge.refunded", {
        payment_intent: "pi_1",
        amount_refunded: plan.amount,
        refunded: true,
      }),
    );

    const [purchase] = await getAllPurchases({ userID });
    expect(purchase?.status).toBe("refunded");
    expect(purchase?.amountRefunded).toBe(plan.amount);
  });

  test("charge.refunded with no matching purchase, but ours (has metadata.planID), throws so Stripe retries", async () => {
    retrievedIntentMetadata = { planID: "1" };

    await expect(
      handleStripeEvent(
        event("charge.refunded", {
          payment_intent: "pi_dangling",
          amount_refunded: 500,
          refunded: false,
        }),
      ),
    ).rejects.toThrow();
  });

  test("charge.refunded with no matching purchase and no planID metadata is ignored (e.g. a subscription invoice)", async () => {
    retrievedIntentMetadata = {};

    await expect(
      handleStripeEvent(
        event("charge.refunded", {
          payment_intent: "pi_subscription_invoice",
          amount_refunded: 500,
          refunded: false,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("charge.dispute.created updates the purchase status via purchaseStatusFromDispute", async () => {
    const userID = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userID },
      {
        planID: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
    );

    await handleStripeEvent(
      event("charge.dispute.created", {
        payment_intent: "pi_1",
        status: "needs_response",
      }),
    );

    const [purchase] = await getAllPurchases({ userID });
    expect(purchase?.status).toBe("disputed");
  });
});
