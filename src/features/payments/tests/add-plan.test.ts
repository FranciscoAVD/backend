import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { Payment } from "@f/payments/lib/types";
import { resetDb } from "@/test-helpers/db";

const onePlan = (
  overrides: Partial<Payment.Plan.Insert> = {},
): Payment.Plan.Insert => ({
  name: "Pro",
  type: "one_time",
  amount: 1000,
  currency: "usd",
  annualAmount: null,
  trialDays: null,
  durationDays: null,
  ...overrides,
});

let productsCreateCalls: { name: string }[] = [];
let pricesCreateCalls: Record<string, unknown>[] = [];
let productsUpdateCalls: { id: string; active: boolean }[] = [];
let failPricesCreate = false;

// no free local "real Stripe" to run against, unlike Postgres/Redis — so the
// SDK surface addPlan actually calls is faked here via bun:test's mock.module
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    products: {
      create: async (args: { name: string }) => {
        productsCreateCalls.push(args);
        return { id: `prod_${productsCreateCalls.length}` };
      },
      update: async (id: string, args: { active: boolean }) => {
        productsUpdateCalls.push({ id, ...args });
        return { id };
      },
    },
    prices: {
      create: async (args: Record<string, unknown>) => {
        if (failPricesCreate) throw new Error("stripe price creation failed");
        pricesCreateCalls.push(args);
        return { id: `price_${pricesCreateCalls.length}` };
      },
    },
  }),
}));

import { addPlan } from "@f/payments/use-cases/add-plan";

describe("addPlan", () => {
  beforeEach(async () => {
    await resetDb();
    productsCreateCalls = [];
    pricesCreateCalls = [];
    productsUpdateCalls = [];
    failPricesCreate = false;
  });

  test("creates a Stripe product + price and inserts the plan", async () => {
    const res = await addPlan(onePlan({ name: "Pro" }));

    expect(res?.name).toBe("Pro");
    expect(res?.stripeProductId).toBe("prod_1");
    expect(res?.stripePriceId).toBe("price_1");
    expect(res?.annualDiscountPriceId).toBeNull();
    expect(pricesCreateCalls).toHaveLength(1);
  });

  test("creates a second, annual price when annualAmount is given", async () => {
    const res = await addPlan(
      onePlan({
        name: "Pro Annual",
        type: "recurring",
        interval: "month",
        annualAmount: 10000,
      }),
    );

    expect(pricesCreateCalls).toHaveLength(2);
    expect(res?.stripePriceId).toBe("price_1");
    expect(res?.annualDiscountPriceId).toBe("price_2");
  });

  test("archives the Stripe product and rethrows when price creation fails", async () => {
    failPricesCreate = true;

    await expect(addPlan(onePlan({ name: "Broken" }))).rejects.toThrow(
      "stripe price creation failed",
    );

    expect(productsUpdateCalls).toEqual([{ id: "prod_1", active: false }]);
  });

  test("archives the Stripe product and rethrows when the DB insert fails", async () => {
    await addPlan(onePlan({ name: "Duplicate" }));
    productsUpdateCalls = [];

    // same name again -> unique constraint violation on the DB insert
    await expect(addPlan(onePlan({ name: "Duplicate" }))).rejects.toThrow();

    expect(productsUpdateCalls).toEqual([{ id: "prod_2", active: false }]);
  });
});
