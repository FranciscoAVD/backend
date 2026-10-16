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
// SDK surface services/plan.ts's create actually calls is faked here via bun:test's mock.module
mock.module("@f/payments/lib/stripe/client", () => ({
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

import { create } from "@f/payments/services/plan";
import { addPlan } from "@f/payments/use-cases/add-plan";

describe("services/plan.ts create", () => {
  beforeEach(async () => {
    await resetDb();
    productsCreateCalls = [];
    pricesCreateCalls = [];
    productsUpdateCalls = [];
    failPricesCreate = false;
  });

  test("creates a Stripe product + price and inserts the plan", async () => {
    const res = await create(onePlan({ name: "Pro" }));

    if (res.kind !== "created") throw new Error(`expected created, got ${res.kind}`);
    expect(res.plan.name).toBe("Pro");
    expect(res.plan.stripeProductId).toBe("prod_1");
    expect(res.plan.stripePriceId).toBe("price_1");
    expect(res.plan.annualDiscountPriceId).toBeNull();
    expect(pricesCreateCalls).toHaveLength(1);
  });

  test("creates a second, annual price when annualAmount is given", async () => {
    const res = await create(
      onePlan({
        name: "Pro Annual",
        type: "recurring",
        interval: "month",
        annualAmount: 10000,
      }),
    );

    if (res.kind !== "created") throw new Error(`expected created, got ${res.kind}`);
    expect(pricesCreateCalls).toHaveLength(2);
    expect(res.plan.stripePriceId).toBe("price_1");
    expect(res.plan.annualDiscountPriceId).toBe("price_2");
  });

  test("archives the Stripe product and rethrows when price creation fails", async () => {
    failPricesCreate = true;

    await expect(create(onePlan({ name: "Broken" }))).rejects.toThrow(
      "stripe price creation failed",
    );

    expect(productsUpdateCalls).toEqual([{ id: "prod_1", active: false }]);
  });

  test("reports duplicate_name (after archiving the Stripe product) when the name is already taken", async () => {
    await create(onePlan({ name: "Duplicate" }));
    productsUpdateCalls = [];

    const res = await create(onePlan({ name: "Duplicate" }));

    expect(res).toEqual({ kind: "duplicate_name" });
    // the pre-check already catches this case before touching Stripe at all
    expect(productsUpdateCalls).toEqual([]);
  });
});

describe("plan names are unique regardless of case", () => {
  beforeEach(async () => {
    await resetDb();
    productsCreateCalls = [];
    pricesCreateCalls = [];
    productsUpdateCalls = [];
    failPricesCreate = false;
  });

  test("the pre-check itself is case-insensitive - a differently-cased duplicate never reaches Stripe", async () => {
    await create(onePlan({ name: "Pro" }));

    const res = await create(onePlan({ name: "PRO" }));

    expect(res).toEqual({ kind: "duplicate_name" });
    expect(productsCreateCalls).toHaveLength(1);
  });

  test("a same-name plan landing between the pre-check and the insert is still refused, and its product archived", async () => {
    const { paymentsRepo } = await import("@f/payments/repo");
    const realGetByName = paymentsRepo.plan.get.byName;
    let injected = false;
    paymentsRepo.plan.get.byName = async (...args) => {
      const res = await realGetByName(...args);
      if (!injected) {
        injected = true;
        await create(onePlan({ name: "Pro" }));
      }
      return res;
    };
    try {
      const res = await create(onePlan({ name: "PRO" }));
      expect(res).toEqual({ kind: "duplicate_name" });
      expect(productsUpdateCalls).toEqual([{ id: "prod_2", active: false }]);
    } finally {
      paymentsRepo.plan.get.byName = realGetByName;
    }
  });
});

describe("addPlan (use-cases/add-plan.ts, DB-only)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("inserts a plan row given pre-made Stripe ids", async () => {
    const res = await addPlan({
      ...onePlan({ name: "Pro" }),
      stripeProductId: "prod_x",
      stripePriceId: "price_x",
      annualDiscountPriceId: null,
    });

    expect(res?.name).toBe("Pro");
    expect(res?.stripeProductId).toBe("prod_x");
    expect(res?.stripePriceId).toBe("price_x");
  });
});
