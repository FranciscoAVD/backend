import { describe, expect, test, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";
import { env } from "@/env";

// Exercises the payments hooks through better-auth itself (its real internal adapter and HTTP
// handler), not by calling them directly - what matters is that auth.ts actually wires them in.
// Stripe is faked the same way as every other Stripe-dependent test.
type FakeSubscription = { id: string; status: string };
let fakeSubscriptions: FakeSubscription[] = [];
let cancelCalls: { id: string; params: unknown }[] = [];
let cancelFails = false;
let checkoutCreateCalls = 0;

// Stripe's list() result is both awaitable (one page: `{ data }`) and async-iterable (every
// page) - this app iterates it, the stripe plugin awaits it
const listOf = <T>(items: T[]) =>
  Object.assign(Promise.resolve({ data: items, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });

mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    customers: {
      create: async () => ({ id: `cus_${crypto.randomUUID()}` }),
      retrieve: async (id: string) => ({ id, email: null, deleted: false }),
      update: async () => ({}),
      search: async () => ({ data: [] }),
      list: () => listOf([]),
    },
    subscriptions: {
      list: () => listOf(fakeSubscriptions),
      cancel: async (id: string, params: unknown) => {
        if (cancelFails) throw new Error("Stripe is down");
        cancelCalls.push({ id, params });
        return { id, status: "canceled" };
      },
    },
    prices: { retrieve: async (id: string) => ({ id, recurring: { interval: "month" } }) },
    checkout: {
      sessions: {
        create: async () => {
          checkoutCreateCalls++;
          return { id: "cs_sub_fake", url: "https://checkout.stripe.com/sub" };
        },
      },
    },
  }),
}));

const { auth } = await import("@f/auth/auth");

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  fakeSubscriptions = [];
  cancelCalls = [];
  cancelFails = false;
  checkoutCreateCalls = 0;
});

const userExists = async (id: string) =>
  (await db.select().from(userTable).where(eq(userTable.id, id))).length > 0;

describe("deleting a user cancels their subscriptions", () => {
  test("cancels every live subscription with the configured terms, then deletes the user", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_del" });
    fakeSubscriptions = [
      { id: "sub_active", status: "active" },
      { id: "sub_trialing", status: "trialing" },
      { id: "sub_past_due", status: "past_due" },
      { id: "sub_done", status: "canceled" },
      { id: "sub_expired", status: "incomplete_expired" },
    ];

    await (await auth.$context).internalAdapter.deleteUser(userId);

    expect(cancelCalls.map((c) => c.id).sort()).toEqual([
      "sub_active",
      "sub_past_due",
      "sub_trialing",
    ]);
    expect(cancelCalls[0]?.params).toEqual({ prorate: false, invoice_now: false });
    expect(await userExists(userId)).toBe(false);
  });

  test("a failed cancellation aborts the deletion - never deleted while still billed", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_del" });
    fakeSubscriptions = [{ id: "sub_active", status: "active" }];
    cancelFails = true;

    await expect(
      (await auth.$context).internalAdapter.deleteUser(userId),
    ).rejects.toThrow();
    expect(await userExists(userId)).toBe(true);
  });

  test("a user who never became a Stripe customer is deleted without any Stripe call", async () => {
    const userId = await seedUser({ stripeCustomerId: null });

    await (await auth.$context).internalAdapter.deleteUser(userId);

    expect(cancelCalls).toEqual([]);
    expect(await userExists(userId)).toBe(false);
  });
});

describe("retired recurring plans", () => {
  // a real signed-in session, so the request runs through better-auth's full handler,
  // global hooks included
  async function signIn() {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Test" },
      asResponse: true,
    });
    return res.headers.get("set-cookie") ?? "";
  }

  const upgrade = (cookie: string, plan: string) =>
    auth.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/subscription/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: env.CLIENT_URL },
        body: JSON.stringify({
          plan,
          successUrl: `${env.CLIENT_URL}/ok`,
          cancelUrl: `${env.CLIENT_URL}/cancel`,
        }),
      }),
    );

  test("a new subscription to a retired plan is refused like an unknown plan", async () => {
    await seedPlan({ name: "Legacy", type: "recurring", interval: "month", active: false });
    const cookie = await signIn();

    const res = await upgrade(cookie, "legacy");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "SUBSCRIPTION_PLAN_NOT_FOUND" });
    expect(checkoutCreateCalls).toBe(0);
  });

  test("an active plan still reaches Stripe checkout", async () => {
    await seedPlan({ name: "Current", type: "recurring", interval: "month", active: true });
    const cookie = await signIn();

    const res = await upgrade(cookie, "current");

    expect(res.status).toBe(200);
    expect(checkoutCreateCalls).toBe(1);
  });
});
