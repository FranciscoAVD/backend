import { describe, expect, test, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { resetDb, seedUser } from "@/test-helpers/db";

let customersCreateCalls: { args: Record<string, unknown>; options: unknown }[] = [];

// no free local "real Stripe" to run against, unlike Postgres — so the SDK
// surface ensureCustomer actually calls is faked here via bun:test's mock.module
mock.module("@f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    customers: {
      create: async (args: Record<string, unknown>, options: unknown) => {
        customersCreateCalls.push({ args, options });
        return { id: `cus_${customersCreateCalls.length}` };
      },
    },
  }),
}));

import {
  ensureCustomer,
  customerIdempotencyKey,
} from "@f/payments/services/account";

describe("ensureCustomer", () => {
  beforeEach(async () => {
    await resetDb();
    customersCreateCalls = [];
  });

  test("returns the existing Stripe customer id without calling Stripe, even when the caller doesn't know it", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_existing" });
    // simulates a stale cached session that never learned about the customer id -
    // ensureCustomer must re-read the live row itself, not trust the caller
    const res = await ensureCustomer({
      id: userId,
      name: "Test User",
      email: "test@example.test",
    });

    expect(res).toBe("cus_existing");
    expect(customersCreateCalls).toHaveLength(0);
  });

  test("creates a Stripe customer and persists it when the user has none", async () => {
    const userId = await seedUser({ stripeCustomerId: null });
    const res = await ensureCustomer({
      id: userId,
      name: "Test User",
      email: "test@example.test",
    });

    expect(res).toBe("cus_1");
    expect(customersCreateCalls[0]?.args).toEqual({
      email: "test@example.test",
      name: "Test User",
      metadata: { userId, customerType: "user" },
    });

    const [row] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId));
    expect(row?.stripeCustomerId).toBe("cus_1");
  });

  test("passes a deterministic idempotency key scoped to the user", async () => {
    const userId = await seedUser({ stripeCustomerId: null });
    await ensureCustomer({
      id: userId,
      name: "Test User",
      email: "test@example.test",
    });

    expect(customersCreateCalls[0]?.options).toEqual({
      idempotencyKey: customerIdempotencyKey({
        id: userId,
        name: "Test User",
        email: "test@example.test",
      }),
    });
  });

  test("the key changes with the details sent, so Stripe never sees one key with two payloads", () => {
    const base = { id: "u1", name: "Ana", email: "ana@example.test" };
    const key = customerIdempotencyKey(base);

    expect(key).toStartWith("customer-u1-");
    expect(customerIdempotencyKey({ ...base })).toBe(key);
    expect(customerIdempotencyKey({ ...base, name: "Ana B" })).not.toBe(key);
    expect(customerIdempotencyKey({ ...base, email: "ana2@example.test" })).not.toBe(key);
    // not confusable by moving text between fields
    expect(customerIdempotencyKey({ id: "u1", name: "a", email: "bc" })).not.toBe(
      customerIdempotencyKey({ id: "u1", name: "ab", email: "c" }),
    );
  });
});
