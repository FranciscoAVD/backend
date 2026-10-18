import { describe, expect, test, beforeEach, mock } from "bun:test";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

let sessionCreateCalls: Record<string, unknown>[] = [];

mock.module("@f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          sessionCreateCalls.push(args);
          return {
            id: "cs_test_fake",
            url: "https://checkout.stripe.com/fake",
          };
        },
      },
    },
  }),
}));

// extension point under test - a plain module the test re-mocks per case, same mock.module
// pattern as Stripe above; default export matches checkout-extensions.ts's own no-op
let extensionParams: Record<string, unknown> | undefined;
mock.module("@f/payments/lib/checkout-extensions", () => ({
  getCheckoutSessionParams: async () => extensionParams,
}));

import { createCheckout, status as getCheckoutStatus } from "@f/payments/services/checkout";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { paymentsRepo } from "@f/payments/repo";
import {
  RESERVATION_TTL_SEC,
  CHECKOUT_SESSION_EXPIRY_MARGIN_SEC,
} from "@f/payments/lib/constants";
import type { Payment } from "@f/payments/lib/types";
import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import { eq } from "drizzle-orm";

let userId: string;

/** Claims the slot the way `start` does, then creates the session on it. */
async function createFor(plan: Payment.Plan, customerId = "cus_abc") {
  const claimed = await paymentsRepo.checkout.claim(
    { userId },
    { planId: plan.id, expiresAt: new Date(Date.now() + RESERVATION_TTL_SEC * 1000) },
  );
  return await createCheckout({ userId, stripeCustomerId: customerId }, plan, claimed!);
}

// The session's metadata and the payment intent's, from the last Stripe call. Asserted
// separately with toEqual, not through one toMatchObject on the whole call: Bun's toMatchObject
// only compares an object the first time it meets it, so when the code passes the *same* object
// as both, a wrong payment-intent half passes unchecked.
type CreateCall = {
  metadata: Record<string, string>;
  payment_intent_data: { metadata: Record<string, string> } & Record<string, unknown>;
};
const lastMetadata = () => {
  const call = sessionCreateCalls.at(-1) as CreateCall;
  return { session: call.metadata, intent: call.payment_intent_data.metadata };
};

describe("createCheckout", () => {
  beforeEach(async () => {
    await resetDb();
    userId = await seedUser();
    sessionCreateCalls = [];
    extensionParams = undefined;
  });

  test("creates a Stripe checkout session and opens the checkout row for it", async () => {
    const plan = await seedPlan({ stripePriceId: "price_abc" });

    const res = await createFor(plan);

    expect(res).toEqual({
      sessionId: "cs_test_fake",
      url: "https://checkout.stripe.com/fake",
    });

    const pending = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(pending).toMatchObject({
      userId,
      planId: plan.id,
      status: "open",
      slot: 1,
      url: "https://checkout.stripe.com/fake",
    });
  });

  test("releases the slot for a repeatable plan, so the next purchase isn't blocked", async () => {
    const plan = await seedPlan({ repeatable: true });

    await createFor(plan);

    const pending = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(pending).toMatchObject({ status: "open", slot: null });
  });

  test("uses the user's Stripe customer id", async () => {
    const plan = await seedPlan();
    await createFor(plan);

    expect(sessionCreateCalls[0]).toMatchObject({ customer: "cus_abc" });
  });

  test("snapshots the plan's durationDays and overlapping onto both metadata objects", async () => {
    const plan = await seedPlan({ durationDays: 30, overlapping: false });
    await createFor(plan);

    const metadata = {
      source: "backend-payments",
      userId,
      planId: String(plan.id),
      durationDays: "30",
      overlapping: "false",
    };
    expect(lastMetadata()).toEqual({ session: metadata, intent: metadata });
  });

  test("snapshots a never-expiring plan as an explicit marker, not a missing key", async () => {
    const plan = await seedPlan({ durationDays: null });
    await createFor(plan);

    expect(sessionCreateCalls[0]).toMatchObject({ metadata: { durationDays: "none" } });
  });

  test("getCheckoutSessionParams's additional params reach Stripe", async () => {
    extensionParams = { allow_promotion_codes: true, automatic_tax: { enabled: true } };
    const plan = await seedPlan();

    await createFor(plan);

    expect(sessionCreateCalls[0]).toMatchObject({
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
    });
  });

  test("a line_items override replaces the default line item", async () => {
    extensionParams = { line_items: [{ price: "price_other", quantity: 3 }] };
    const plan = await seedPlan({ stripePriceId: "price_abc" });

    await createFor(plan);

    expect(sessionCreateCalls[0]).toMatchObject({
      line_items: [{ price: "price_other", quantity: 3 }],
    });
  });

  test("the extension can't override source/userId/planId/durationDays/overlapping in metadata, but can add its own keys", async () => {
    extensionParams = {
      metadata: {
        source: "someone-else",
        userId: "someone-else",
        overlapping: "false",
        campaign: "spring-sale",
      },
      payment_intent_data: { metadata: { planId: "999999" } },
    };
    const plan = await seedPlan({ durationDays: 30 });

    await createFor(plan);

    const metadata = {
      campaign: "spring-sale",
      source: "backend-payments",
      userId,
      planId: String(plan.id),
      durationDays: "30",
      overlapping: "true",
    };
    expect(lastMetadata()).toEqual({ session: metadata, intent: metadata });
  });

  test("keys set only on payment_intent_data.metadata reach the payment intent, alongside the session's", async () => {
    extensionParams = {
      metadata: { campaign: "spring-sale" },
      payment_intent_data: {
        metadata: { ledgerRef: "L-42", userId: "someone-else" },
        statement_descriptor_suffix: "SPRING",
      },
    };
    const plan = await seedPlan({ durationDays: 30 });

    await createFor(plan);

    const core = {
      source: "backend-payments",
      userId,
      planId: String(plan.id),
      durationDays: "30",
      overlapping: "true",
    };
    expect(lastMetadata()).toEqual({
      // the intent-only key stays off the session itself
      session: { campaign: "spring-sale", ...core },
      intent: { ledgerRef: "L-42", campaign: "spring-sale", ...core },
    });
    // other payment_intent_data params pass through
    expect((sessionCreateCalls[0] as CreateCall).payment_intent_data.statement_descriptor_suffix).toBe(
      "SPRING",
    );
  });

  test("the extension can't override mode, customer or expires_at", async () => {
    extensionParams = {
      mode: "subscription",
      customer: "cus_wrong",
      expires_at: 1,
    };
    const plan = await seedPlan();

    await createFor(plan, "cus_abc");

    expect(sessionCreateCalls[0]).toMatchObject({ mode: "payment", customer: "cus_abc" });
    expect(sessionCreateCalls[0]?.expires_at).toBeGreaterThan(1);
  });

  test("expires_at leaves a margin before the checkout row's own deadline, and stays above Stripe's minimum", async () => {
    const plan = await seedPlan();
    const before = Math.floor(Date.now() / 1000);

    await createFor(plan);

    const expiresAt = sessionCreateCalls[0]?.expires_at as number;
    const STRIPE_MIN_EXPIRY_SEC = 30 * 60;
    expect(expiresAt).toBeLessThanOrEqual(before + 24 * 60 * 60 - 10 * 60);
    expect(expiresAt).toBeGreaterThanOrEqual(before + STRIPE_MIN_EXPIRY_SEC);
  });
});

describe("getCheckoutStatus", () => {
  beforeEach(async () => {
    await resetDb();
    userId = await seedUser();
  });

  test("returns the DB purchase status once confirmed", async () => {
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

    const res = await getCheckoutStatus({
      userId,
      stripeCheckoutSessionId: "cs_1",
    });
    expect(res).toBe("paid");
  });

  test("falls back to the checkout row when no purchase row exists yet", async () => {
    const plan = await seedPlan();
    await createFor(plan);

    const res = await getCheckoutStatus({
      userId,
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBe("open");
  });

  test("reports an open row past its own deadline as expired, not still open", async () => {
    const plan = await seedPlan();
    await createFor(plan);
    // nothing has swept it yet - Stripe's expiry webhook hasn't landed and no one has
    // re-claimed the slot - but the session is no longer payable
    await db
      .update(checkoutTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(checkoutTable.stripeCheckoutSessionId, "cs_test_fake"));

    const res = await getCheckoutStatus({
      userId,
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBe("expired");
  });

  test("reports an open row as expired once its Stripe session has, before the row's own deadline", async () => {
    const plan = await seedPlan();
    await createFor(plan);
    const setRowDeadline = (secondsFromNow: number) =>
      db
        .update(checkoutTable)
        .set({ expiresAt: new Date(Date.now() + secondsFromNow * 1000) })
        .where(eq(checkoutTable.stripeCheckoutSessionId, "cs_test_fake"));
    const check = () => getCheckoutStatus({ userId, stripeCheckoutSessionId: "cs_test_fake" });

    // the session dies CHECKOUT_SESSION_EXPIRY_MARGIN_SEC before the row: a minute past that, the
    // row still has minutes to run but Stripe no longer accepts the session
    await setRowDeadline(CHECKOUT_SESSION_EXPIRY_MARGIN_SEC - 60);
    expect(await check()).toBe("expired");

    await setRowDeadline(CHECKOUT_SESSION_EXPIRY_MARGIN_SEC + 60);
    expect(await check()).toBe("open");
  });

  test("returns null when the checkout row belongs to a different user", async () => {
    const plan = await seedPlan();
    await createFor(plan);

    const res = await getCheckoutStatus({
      userId: "someone-else",
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(res).toBeNull();
  });

  test("returns null when there's neither a purchase nor a checkout row", async () => {
    const res = await getCheckoutStatus({
      userId,
      stripeCheckoutSessionId: "cs_nonexistent",
    });
    expect(res).toBeNull();
  });
});
