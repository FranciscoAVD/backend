import { describe, expect, test, beforeEach, mock } from "bun:test";
import type Stripe from "stripe";

let retrieveCalls = 0;
let fakeLatestCharge: Record<string, unknown> | null = null;
let fakeDispute: Record<string, unknown> | null = null;

mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    paymentIntents: {
      retrieve: async (id: string, _options?: { expand?: string[] }) => {
        retrieveCalls++;
        return { id, latest_charge: fakeLatestCharge };
      },
    },
    disputes: {
      list: async (_args: { payment_intent: string; limit: number }) => ({
        data: fakeDispute ? [fakeDispute] : [],
      }),
    },
  }),
}));

import { resolveChargeState } from "@f/payments/lib/charge-state";

describe("resolveChargeState", () => {
  beforeEach(() => {
    retrieveCalls = 0;
    fakeLatestCharge = null;
    fakeDispute = null;
  });

  test("returns null when there's no charge on the intent", async () => {
    const res = await resolveChargeState("pi_1");
    expect(res).toBeNull();
  });

  test("derives status/amountRefunded from the charge when not disputed", async () => {
    fakeLatestCharge = { amount_refunded: 500, refunded: false, disputed: false };

    const res = await resolveChargeState("pi_1");
    expect(res).toEqual({ amountRefunded: 500, status: "paid" });
  });

  test("overrides status from the live dispute when the charge is disputed", async () => {
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "lost" };

    const res = await resolveChargeState("pi_1");
    expect(res?.status).toBe("refunded");
  });

  test("a lost dispute counts the charged-back money as refunded, not just the status", async () => {
    fakeLatestCharge = { amount: 1000, amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "lost", amount: 1000 };

    const res = await resolveChargeState("pi_1");
    expect(res).toEqual({ status: "refunded", amountRefunded: 1000 });
  });

  test("a lost dispute after a partial refund adds the two, never past the charge", async () => {
    fakeLatestCharge = { amount: 1000, amount_refunded: 200, refunded: false, disputed: true };
    fakeDispute = { status: "lost", amount: 800 };
    expect(await resolveChargeState("pi_1")).toEqual({ status: "refunded", amountRefunded: 1000 });

    fakeDispute = { status: "lost", amount: 1000 }; // disputed the full amount anyway
    expect(await resolveChargeState("pi_1")).toEqual({ status: "refunded", amountRefunded: 1000 });
  });

  test("an open or won dispute leaves amountRefunded as the charge's own refunds", async () => {
    fakeLatestCharge = { amount: 1000, amount_refunded: 200, refunded: false, disputed: true };
    fakeDispute = { status: "needs_response", amount: 800 };
    expect((await resolveChargeState("pi_1"))?.amountRefunded).toBe(200);

    fakeDispute = { status: "won", amount: 800 };
    expect((await resolveChargeState("pi_1"))?.amountRefunded).toBe(200);
  });

  test("an open dispute marks it disputed", async () => {
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "needs_response" };

    const res = await resolveChargeState("pi_1");
    expect(res?.status).toBe("disputed");
  });

  // `charge.disputed` stays true forever once a dispute was opened - a dispute closed in our
  // favor must not mask a refund made afterwards (e.g. a goodwill refund after an inquiry)
  for (const status of ["won", "warning_closed", "prevented"]) {
    test(`a full refund after a ${status} dispute is still refunded`, async () => {
      fakeLatestCharge = { amount_refunded: 1000, refunded: true, disputed: true };
      fakeDispute = { status };

      const res = await resolveChargeState("pi_1");
      expect(res).toEqual({ amountRefunded: 1000, status: "refunded" });
    });
  }

  test("a won dispute with no refund is back to paid", async () => {
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: true };
    fakeDispute = { status: "won" };

    const res = await resolveChargeState("pi_1");
    expect(res?.status).toBe("paid");
  });

  test("passing a pre-fetched intent skips the retrieve call", async () => {
    const intent = {
      latest_charge: { amount_refunded: 0, refunded: false, disputed: false },
    } as unknown as Stripe.PaymentIntent;

    const res = await resolveChargeState("pi_1", intent);

    expect(res).toEqual({ amountRefunded: 0, status: "paid" });
    expect(retrieveCalls).toBe(0);
  });

  test("fetches fresh when no intent is given", async () => {
    fakeLatestCharge = { amount_refunded: 0, refunded: false, disputed: false };

    await resolveChargeState("pi_1");

    expect(retrieveCalls).toBe(1);
  });
});
