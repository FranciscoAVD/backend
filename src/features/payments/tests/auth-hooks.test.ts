import { describe, expect, test, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";
import { env } from "@/env";
import { isUserDeleting, markUserDeleting } from "@f/payments/lib/state/deletion-guard";

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
let customerUpdateCalls: { id: string; params: unknown }[] = [];
// runs inside checkout.sessions.create, to interleave something with a subscription checkout
let onCheckoutCreate: ((id: string) => Promise<void>) | null = null;

// Stripe's list() result is both awaitable (one page: `{ data }`) and async-iterable (every
// page) - this app iterates it, the stripe plugin awaits it
const listOf = <T>(items: T[]) =>
  Object.assign(Promise.resolve({ data: items, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });

mock.module("@f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: () => ({
    customers: {
      create: async () => {
        if (customerCreateFails) throw new Error("Stripe is down");
        customerCreateCalls++;
        return { id: `cus_${crypto.randomUUID()}` };
      },
      retrieve: async (id: string) => ({ id, email: null, deleted: false }),
      update: async (id: string, params: unknown) => {
        customerUpdateCalls.push({ id, params });
        return {};
      },
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
          for (const s of fakeCheckoutSessions) if (s.id === id) s.status = "expired";
          return { id, status: "expired" };
        },
        create: async (params: { customer?: string }) => {
          checkoutCreateCalls++;
          const id = `cs_sub_${checkoutCreateCalls}`;
          fakeCheckoutSessions.push({ id, customer: params.customer ?? "", status: "open" });
          await onCheckoutCreate?.(id);
          return { id, url: "https://checkout.stripe.com/sub" };
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
  customerUpdateCalls = [];
  onCheckoutCreate = null;
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
    const { ensureCustomer } = await import("@f/payments/services/account");
    const customerId = await ensureCustomer({ id: session!.user.id, name: "Test", email });
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

describe("stripeCustomerId can't be set from a request", () => {
  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: env.CLIENT_URL,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const rowByEmail = async (email: string) =>
    (await db.select().from(userTable).where(eq(userTable.email, email)))[0];

  test("sign-up with it is refused, and no user is created", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const res = await post("/sign-up/email", {
      email,
      password: "correct-horse-battery",
      name: "Test",
      stripeCustomerId: "cus_victim",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FIELD_NOT_ALLOWED" });
    expect(await rowByEmail(email)).toBeUndefined();
  });

  test("update-user with it is refused, leaving the customer and Stripe untouched", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const signUp = await post("/sign-up/email", {
      email,
      password: "correct-horse-battery",
      name: "Test",
    });
    const cookie = signUp.headers.get("set-cookie") ?? "";
    const own = (await rowByEmail(email))?.stripeCustomerId;
    expect(own).toBeString();
    customerUpdateCalls = [];

    const res = await post("/update-user", { stripeCustomerId: "cus_victim" }, cookie);

    expect(res.status).toBe(400);
    expect((await rowByEmail(email))?.stripeCustomerId).toBe(own);
    expect(customerUpdateCalls).toEqual([]);
  });

  test("null or empty is refused too - it would detach the user from their customer", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const signUp = await post("/sign-up/email", {
      email,
      password: "correct-horse-battery",
      name: "Test",
    });
    const cookie = signUp.headers.get("set-cookie") ?? "";

    for (const value of [null, ""]) {
      const res = await post("/update-user", { stripeCustomerId: value }, cookie);
      expect(res.status).toBe(400);
    }
  });

  test("ordinary profile updates still work", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const signUp = await post("/sign-up/email", {
      email,
      password: "correct-horse-battery",
      name: "Test",
    });
    const cookie = signUp.headers.get("set-cookie") ?? "";

    const res = await post("/update-user", { name: "Renamed" }, cookie);

    expect(res.status).toBe(200);
    expect((await rowByEmail(email))?.name).toBe("Renamed");
  });
});

describe("no subscription checkout survives a user's deletion", () => {
  async function signIn() {
    const email = `u-${crypto.randomUUID()}@example.com`;
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Test" },
      asResponse: true,
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return { cookie, userId: session!.user.id };
  }

  const upgrade = (cookie: string) =>
    auth.handler(
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

  beforeEach(async () => {
    await seedPlan({ name: "Current", type: "recurring", interval: "month", active: true });
  });

  test("a deletion already under way refuses a new subscription checkout before Stripe", async () => {
    const { cookie, userId } = await signIn();
    await markUserDeleting(userId);

    const res = await upgrade(cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ACCOUNT_BEING_DELETED" });
    expect(checkoutCreateCalls).toBe(0);
  });

  test("a deletion that starts while the checkout is being created expires it", async () => {
    const { cookie, userId } = await signIn();
    // the deletion hook raises its flag after this request's before-check passed, while
    // Stripe is still creating the session
    onCheckoutCreate = async () => markUserDeleting(userId);

    const res = await upgrade(cookie);

    expect(res.status).toBe(409);
    expect(checkoutCreateCalls).toBe(1);
    expect(expireCalls).toEqual(["cs_sub_1"]);
    expect(fakeCheckoutSessions.filter((s) => s.status === "open")).toEqual([]);
  });

  test("an aborted deletion lowers the flag again; a completed one leaves it up", async () => {
    const aborted = await seedUser({ stripeCustomerId: "cus_abort" });
    fakeSubscriptions = [{ id: "sub_active", status: "active" }];
    cancelFails = true;
    await expect(
      (async () => (await auth.$context).internalAdapter.deleteUser(aborted))(),
    ).rejects.toThrow();
    expect(await isUserDeleting(aborted)).toBe(false);

    cancelFails = false;
    const deleted = await seedUser({ stripeCustomerId: "cus_gone" });
    await (await auth.$context).internalAdapter.deleteUser(deleted);
    expect(await isUserDeleting(deleted)).toBe(true);
  });
});
