import { describe, expect, test, beforeEach, mock } from "bun:test";

let fakeSessions: Record<string, unknown>[] = [];
let listParams: Record<string, unknown> | undefined;
const intentStatuses: Record<string, string> = {};

mock.module("@f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    checkout: {
      sessions: {
        list: (params: Record<string, unknown>) => {
          listParams = params;
          return fakeSessions;
        },
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, status: intentStatuses[id] ?? "succeeded" }),
    },
  }),
}));

import { assertNoSettlingPayments } from "@f/payments/services/account";

const user = { id: "user_1", stripeCustomerId: "cus_1" };

describe("assertNoSettlingPayments", () => {
  beforeEach(() => {
    fakeSessions = [];
    listParams = undefined;
  });

  test("refuses with 409 while a one-time payment is still processing", async () => {
    fakeSessions = [
      { id: "cs_1", mode: "payment", payment_intent: { id: "pi_1", status: "processing" } },
    ];
    const error = await assertNoSettlingPayments(user).catch((e) => e);
    expect(error?.body?.code).toBe("PAYMENT_SETTLING");
    expect(error?.statusCode).toBe(409);
    expect(listParams).toMatchObject({ customer: "cus_1", status: "complete" });
  });

  test("retrieves an unexpanded payment intent before deciding", async () => {
    intentStatuses["pi_2"] = "processing";
    fakeSessions = [{ id: "cs_2", mode: "payment", payment_intent: "pi_2" }];
    expect(assertNoSettlingPayments(user)).rejects.toThrow();
  });

  test("lets settled, failed, and subscription checkouts through", async () => {
    fakeSessions = [
      { id: "cs_3", mode: "payment", payment_intent: { id: "pi_3", status: "succeeded" } },
      { id: "cs_4", mode: "payment", payment_intent: { id: "pi_4", status: "requires_payment_method" } },
      { id: "cs_5", mode: "subscription", payment_intent: null },
      { id: "cs_6", mode: "payment", payment_intent: null },
    ];
    expect(await assertNoSettlingPayments(user)).toBeUndefined();
  });

  test("a user with no Stripe customer has nothing to check", async () => {
    fakeSessions = [
      { id: "cs_7", mode: "payment", payment_intent: { id: "pi_7", status: "processing" } },
    ];
    expect(await assertNoSettlingPayments({ id: "user_2", stripeCustomerId: null })).toBeUndefined();
    expect(listParams).toBeUndefined();
  });
});
