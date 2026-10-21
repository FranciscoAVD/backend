import { describe, expect, test, beforeEach, mock } from "bun:test";
import { resetDb, seedUser, seedPlan } from "@backend/test-helpers/db";
import { resetRedis } from "@backend/test-helpers/redis";

// Stripe's live state as seen by each successive retrieve: the first caller's fetch is slow and
// returns what was true *before* a refund; every later fetch sees the refund. The interleaving two
// near-simultaneous events (e.g. charge.refunded and charge.dispute.closed for one charge) produce.
let retrieveCalls = 0;
mock.module("@backend/f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    paymentIntents: {
      retrieve: async (id: string) => {
        const call = ++retrieveCalls;
        if (call === 1) {
          await Bun.sleep(150);
          return {
            id,
            metadata: {},
            latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
          };
        }
        return {
          id,
          metadata: {},
          latest_charge: { amount_refunded: 1000, refunded: true, disputed: false },
        };
      },
    },
    disputes: { list: async () => ({ data: [] }) },
  }),
}));

// mocks @backend/f/email/lib/client, not @backend/f/email/send - see CLAUDE.md's testing section for why. The
// refund here now triggers a best-effort confirmation email (fulfillment.ts's syncCharge); this
// keeps the test fully offline rather than hitting the real (sandboxed) Resend API, same reason
// every other Stripe-dependent test mocks its own non-Postgres I/O.
mock.module("@backend/f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: { send: async () => ({ data: { id: "email_1" }, error: null }) },
  }),
}));

import type Stripe from "stripe";
import { handleStripeEvent } from "@backend/f/payments/lib/webhook";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@backend/f/payments/use-cases/get-purchases";

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  retrieveCalls = 0;
});

const chargeEvent = (type: string) =>
  ({
    id: `evt_${crypto.randomUUID()}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { payment_intent: "pi_race" } },
  }) as unknown as Stripe.Event;

describe("concurrent refund/dispute syncs for one purchase", () => {
  test("the stale fetch can't land last and undo the newer state", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_race",
        stripePaymentIntentId: "pi_race",
        amountTotal: 1000,
        currency: "usd",
      },
      { durationDays: null },
      new Date(),
    );

    // the first sync starts its (slow, stale) fetch; the second arrives while it's in flight
    const first = handleStripeEvent(chargeEvent("charge.dispute.closed"));
    await Bun.sleep(20);
    const second = handleStripeEvent(chargeEvent("charge.refunded"));
    await Promise.all([first, second]);

    const [purchase] = await getAllPurchases({ userId });
    expect(purchase).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });
});
