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
let customerCreateCalls = 0;
// a customer's Checkout Sessions, by status - what checkout.sessions.list filters on
let fakeCheckoutSessions: { id: string; customer: string; status: string }[] = [];
let expireCalls: string[] = [];
let expireFails = false;
let customerCreateFails = false;

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
      create: async () => {
        if (customerCreateFails) throw new Error("Stripe is down");
        customerCreateCalls++;
        return { id: `cus_${crypto.randomUUID()}` };
      },
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
        list: (params: { customer?: string; status?: string }) =>
          listOf(
            fakeCheckoutSessions.filter(
              (s) =>
                (!params.customer || s.customer === params.customer) &&
                (!params.status || s.status === params.status),
            ),
          ),
        expire: async (id: string) => {
          if (expireFails) throw new Error("Stripe is down");
          expireCalls.push(id);
          return { id, status: "expired" };
        },
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
  customerCreateCalls = 0;
  customerCreateFails = false;
  fakeCheckoutSessions = [];
  expireCalls = [];
  expireFails = false;
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

  test("expires the user's open checkouts too, so nothing can be bought after deletion", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_del" });
    fakeCheckoutSessions = [
      { id: "cs_open_one_time", customer: "cus_del", status: "open" },
      { id: "cs_open_subscription", customer: "cus_del", status: "open" },
      { id: "cs_done", customer: "cus_del", status: "complete" },
      { id: "cs_someone_else", customer: "cus_other", status: "open" },
    ];

    await (await auth.$context).internalAdapter.deleteUser(userId);

    expect(expireCalls.sort()).toEqual(["cs_open_one_time", "cs_open_subscription"]);
    expect(await userExists(userId)).toBe(false);
  });

  test("a failed expiry aborts the deletion, same as a failed cancellation", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_del" });
    fakeCheckoutSessions = [{ id: "cs_open", customer: "cus_del", status: "open" }];
    expireFails = true;

    await expect(
      (async () => (await auth.$context).internalAdapter.deleteUser(userId))(),
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

describe("the Stripe webhook isn't throttled by better-auth's rate limiter", () => {
  // no client-IP header, like a deployment without trusted-proxy config: better-auth then puts every
  // caller in one shared bucket per path, so unsigned junk could otherwise use up the budget and
  // get Stripe's real deliveries 429'd
  const flood = (path: string, init: RequestInit = {}) =>
    Promise.all(
      Array.from({ length: 150 }, () =>
        auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, init)),
      ).map(async (res) => (await res).status),
    );

  test("well past the default limit, every webhook request still reaches signature checking", async () => {
    const statuses = await flood("/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=0,v1=forged", "content-type": "application/json" },
      body: "{}",
    });

    expect(statuses.filter((status) => status === 429)).toHaveLength(0);
    // rejected on its forged signature, as it should be
    expect(new Set(statuses)).toEqual(new Set([400]));
  });

  test("other auth endpoints are still rate limited", async () => {
    const statuses = await flood("/ok");
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe("a Stripe customer created at checkout reaches the cached session", () => {
  test("the subscription flow reuses it instead of creating a second customer", async () => {
    await seedPlan({ name: "Current", type: "recurring", interval: "month", active: true });

    // Stripe is down at sign-up, so createCustomerOnSignUp leaves stripeCustomerId unset...
    customerCreateFails = true;
    const email = `u-${crypto.randomUUID()}@example.com`;
    const signUp = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Test" },
      asResponse: true,
    });
    const cookie = signUp.headers.get("set-cookie") ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.stripeCustomerId ?? null).toBeNull();
    customerCreateFails = false;

    // ...then a one-time checkout creates the customer
    const { ensureStripeCustomer } = await import("@f/payments/use-cases/ensure-customer");
    const customerId = await ensureStripeCustomer({ id: session!.user.id, name: "Test", email });
    expect(customerCreateCalls).toBe(1);

    // the session the stripe plugin reads now carries it
    const refreshed = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(refreshed?.user.stripeCustomerId).toBe(customerId);

    // so subscribing doesn't create (and switch the user to) a second customer
    const res = await auth.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/subscription/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: env.CLIENT_URL },
        body: JSON.stringify({
          plan: "current",
          successUrl: `${env.CLIENT_URL}/ok`,
          cancelUrl: `${env.CLIENT_URL}/cancel`,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(customerCreateCalls).toBe(1);
    const [row] = await db.select().from(userTable).where(eq(userTable.id, session!.user.id));
    expect(row?.stripeCustomerId).toBe(customerId);
  });
});
