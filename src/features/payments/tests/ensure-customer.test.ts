import { describe, expect, test, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { resetDb, seedUser } from "@/test-helpers/db";

let customersCreateCalls: Record<string, unknown>[] = [];

// no free local "real Stripe" to run against, unlike Postgres — so the SDK
// surface ensureStripeCustomer actually calls is faked here via bun:test's mock.module
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    customers: {
      create: async (args: Record<string, unknown>) => {
        customersCreateCalls.push(args);
        return { id: `cus_${customersCreateCalls.length}` };
      },
    },
  }),
}));

import { ensureStripeCustomer } from "@f/payments/use-cases/ensure-customer";

describe("ensureStripeCustomer", () => {
  beforeEach(async () => {
    await resetDb();
    customersCreateCalls = [];
  });

  test("returns the existing Stripe customer id without calling Stripe", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_existing" });
    const res = await ensureStripeCustomer({
      id: userId,
      name: "Test User",
      email: "test@example.test",
      stripeCustomerId: "cus_existing",
    });

    expect(res).toBe("cus_existing");
    expect(customersCreateCalls).toHaveLength(0);
  });

  test("creates a Stripe customer and persists it when the user has none", async () => {
    const userId = await seedUser({ stripeCustomerId: null });
    const res = await ensureStripeCustomer({
      id: userId,
      name: "Test User",
      email: "test@example.test",
      stripeCustomerId: null,
    });

    expect(res).toBe("cus_1");
    expect(customersCreateCalls).toEqual([
      {
        email: "test@example.test",
        name: "Test User",
        metadata: { userId, customerType: "user" },
      },
    ]);

    const [row] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId));
    expect(row?.stripeCustomerId).toBe("cus_1");
  });
});
