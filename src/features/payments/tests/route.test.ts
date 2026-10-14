import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { pinoLogger, type Env as PinoLoggerEnv } from "hono-pino";
import { requestId } from "hono/request-id";
import { logger } from "@/lib/logger";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";

type FakeUser = { id: string; name: string; email: string };
let fakeSession: { user: FakeUser } | null = null;
let fakePermissions: Record<string, string[]> = {};

function setSession(user: FakeUser | null, permissions: Record<string, string[]> = {}) {
  fakeSession = user ? { user } : null;
  fakePermissions = permissions;
}

// Fakes the real session/permission plumbing (better-auth + its admin plugin) so route
// handlers can be exercised over real HTTP without a live cookie/session - the same idea
// as how checkout.test.ts fakes Stripe, applied to @f/auth/middleware instead.
mock.module("@f/auth/middleware", () => ({
  sessionMiddleware: async (c: any, next: any) => {
    c.set("session", fakeSession);
    await next();
  },
  requireSessionMiddleware: async (c: any, next: any) => {
    if (!c.get("session")) return c.json({ message: "Unauthenticated" }, 401);
    await next();
  },
  requirePermissionMiddleware:
    (required: Record<string, string[]>) => async (c: any, next: any) => {
      const ok = Object.entries(required).every(([resource, actions]) =>
        actions.every((action) => fakePermissions[resource]?.includes(action)),
      );
      if (!ok) return c.json({ message: "Unauthorized" }, 403);
      await next();
    },
}));

// Fakes Stripe for POST /checkout's happy path (checkout.sessions.create only - every test
// seeds the user with a stripeCustomerId already set, so ensureStripeCustomer's own
// customers.create branch, per use-cases/ensure-customer.ts, never runs). Mirrors the fake
// checkout.test.ts already uses for the same Stripe call. Unlike the auth mock above, this
// one needs no dynamic-import treatment: every caller of getPaymentProcessor() calls it
// fresh at request time, not eagerly at module-evaluation time.
let sessionCreateCalls: Record<string, unknown>[] = [];
// knobs for POST /checkout's concurrency/failure tests: a delay widens the window between the
// guard and the Stripe call, as a real network round-trip would; a failure exercises cleanup
let sessionCreateDelayMs = 0;
let sessionCreateFails = false;
// PATCH /plans/:id's retire/reactivate mirroring onto the plan's Stripe prices
let priceUpdateCalls: { id: string; active: boolean }[] = [];
let priceUpdateFails = false;
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    prices: {
      update: async (id: string, params: { active: boolean }) => {
        if (priceUpdateFails) throw new Error("Stripe is down");
        priceUpdateCalls.push({ id, active: params.active });
        return { id, active: params.active };
      },
    },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          sessionCreateCalls.push(args);
          if (sessionCreateDelayMs) await Bun.sleep(sessionCreateDelayMs);
          if (sessionCreateFails) throw new Error("Stripe is down");
          return { id: "cs_test_fake", url: "https://checkout.stripe.com/fake" };
        },
      },
    },
  }),
}));

import { db } from "@d/connection";
import { paymentAuditLog } from "@d/schemas/payment-schema";
import {
  savePendingCheckout,
  getPendingCheckout,
  getResumableCheckout,
  PENDING_CHECKOUT_TTL_SEC,
} from "@f/payments/lib/pending-checkout";
import { paymentsRepo } from "@f/payments/repo";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
// dynamic, not static - route.ts calls .use(sessionMiddleware) at module-evaluation
// time, capturing the function by value into Hono's middleware chain immediately.
// A static import is hoisted above the mock.module call above regardless of its
// textual position, so route.ts would still capture the real middleware; only a
// genuine runtime import, evaluated at this exact point, sees the faked module.
const { default: paymentsApp } = await import("@f/payments/route");

// route.ts's own app never mounts pinoLogger itself - it relies on being mounted under
// src/index.ts's root app, which does. Re-wire the same thing here so c.var.logger exists.
const app = new Hono<PinoLoggerEnv>()
  .use(requestId())
  .use(pinoLogger({ pino: logger }))
  .route("/", paymentsApp);

const jsonHeaders = { "Content-Type": "application/json" };
const admin = { name: "Admin", email: "admin@example.test" };
const regularUser = { name: "Test User", email: "user@example.test" };

describe("auth gating", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    setSession(null);
  });

  test("401s without a session", async () => {
    const res = await app.request("/plans");
    expect(res.status).toBe(401);
  });

  test("403s on POST /plans without plan:create", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin });

    const res = await app.request("/plans", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "X", type: "one_time", amount: 1000, currency: "usd" }),
    });
    expect(res.status).toBe(403);
  });

  test("403s on GET /plans without plan:read:active", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/plans");
    expect(res.status).toBe(403);
  });

  test("403s on GET /plans/:id without plan:read:active", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}`);
    expect(res.status).toBe(403);
  });

  test("403s on PATCH /plans/:id without plan:update", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    setSession({ id: userId, ...admin });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(403);
  });

  test("403s on GET /audit-log without audit:list", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin });

    const res = await app.request("/audit-log");
    expect(res.status).toBe(403);
  });
});

describe("GET /audit-log", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  async function seedEntries(userId: string, count: number) {
    const plan = await seedPlan();
    for (let i = 0; i < count; i++)
      await db
        .insert(paymentAuditLog)
        .values({ type: "checkout_blocked_pending_checkout", userId, planId: plan.id });
  }

  type Page = { data: { id: number; userId: string | null }[]; nextCursor: number | null };

  test("pages through every entry newest first, with no gaps or repeats", async () => {
    const userId = await seedUser();
    await seedEntries(userId, 5);
    setSession({ id: userId, ...admin }, { audit: ["list"] });

    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const res = await app.request(`/audit-log?limit=2${cursor ? `&before=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      seen.push(...body.data.map((e) => e.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(5);
  });

  test("no next cursor when everything fits on one page", async () => {
    const userId = await seedUser();
    await seedEntries(userId, 2);
    setSession({ id: userId, ...admin }, { audit: ["list"] });

    const body = (await (await app.request("/audit-log?limit=2")).json()) as Page;
    expect(body.data).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  test("?userId= narrows to one customer", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    await seedEntries(userA, 2);
    await seedEntries(userB, 1);
    setSession({ id: userA, ...admin }, { audit: ["list"] });

    const body = (await (await app.request(`/audit-log?userId=${userB}`)).json()) as Page;
    expect(body.data.map((e) => e.userId)).toEqual([userB]);
  });

  test.each(["limit=0", "limit=101", "limit=abc", "before=-1", "before=1.5"])(
    "400s on an invalid query: %s",
    async (query) => {
      const userId = await seedUser();
      setSession({ id: userId, ...admin }, { audit: ["list"] });

      const res = await app.request(`/audit-log?${query}`);
      expect(res.status).toBe(400);
    },
  );
});

describe("GET /purchases/all", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  let purchaseCounter = 0;
  async function seedPurchases(userId: string, count: number) {
    const plan = await seedPlan();
    for (let i = 0; i < count; i++) {
      const id = ++purchaseCounter;
      await addPurchase(
        { userId },
        {
          planId: plan.id,
          stripeCheckoutSessionId: `cs_all_${id}`,
          stripePaymentIntentId: `pi_all_${id}`,
          amountTotal: plan.amount,
          currency: plan.currency,
        },
        { durationDays: plan.durationDays },
        new Date(),
      );
    }
  }

  type Page = { data: { id: number; userId: string | null }[]; nextCursor: number | null };

  test("pages through every purchase newest first, with no gaps or repeats", async () => {
    const userId = await seedUser();
    await seedPurchases(userId, 5);
    setSession({ id: userId, ...admin }, { purchase: ["read:all"] });

    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const res = await app.request(`/purchases/all?limit=2${cursor ? `&before=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      seen.push(...body.data.map((e) => e.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(5);
  });

  test("no next cursor when everything fits on one page", async () => {
    const userId = await seedUser();
    await seedPurchases(userId, 2);
    setSession({ id: userId, ...admin }, { purchase: ["read:all"] });

    const body = (await (await app.request("/purchases/all?limit=2")).json()) as Page;
    expect(body.data).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  test("?userId= narrows to one customer", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    await seedPurchases(userA, 2);
    await seedPurchases(userB, 1);
    setSession({ id: userA, ...admin }, { purchase: ["read:all"] });

    const body = (await (await app.request(`/purchases/all?userId=${userB}`)).json()) as Page;
    expect(body.data.map((e) => e.userId)).toEqual([userB]);
  });

  test.each(["limit=0", "limit=101", "limit=abc", "before=-1", "before=1.5"])(
    "400s on an invalid query: %s",
    async (query) => {
      const userId = await seedUser();
      setSession({ id: userId, ...admin }, { purchase: ["read:all"] });

      const res = await app.request(`/purchases/all?${query}`);
      expect(res.status).toBe(400);
    },
  );

  test("403s without purchase:read:all", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/purchases/all");
    expect(res.status).toBe(403);
  });
});

describe("GET /plans", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("returns only active plans with just read:active", async () => {
    const userId = await seedUser();
    await seedPlan({ active: true });
    await seedPlan({ active: false });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request("/plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { active: boolean }[] };
    expect(body.data.every((plan) => plan.active)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test("returns active and inactive plans with read:all too", async () => {
    const userId = await seedUser();
    await seedPlan({ active: true });
    await seedPlan({ active: false });
    setSession({ id: userId, ...admin }, { plan: ["read:active", "read:all"] });

    const res = await app.request("/plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { active: boolean }[] };
    expect(body.data).toHaveLength(2);
  });
});

describe("GET /plans/:id", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("an active plan is visible with just read:active", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ active: true });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}`);
    expect(res.status).toBe(200);
  });

  test("an inactive plan 404s without read:all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ active: false });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}`);
    expect(res.status).toBe(404);
  });

  test("an inactive plan is visible with read:all", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ active: false });
    setSession({ id: userId, ...admin }, { plan: ["read:active", "read:all"] });

    const res = await app.request(`/plans/${plan.id}`);
    expect(res.status).toBe(200);
  });

  test("a nonexistent plan 404s regardless of read:all", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["read:active", "read:all"] });

    const res = await app.request("/plans/999999");
    expect(res.status).toBe(404);
  });
});

describe("GET /plans/:id/access", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("404s for a nonexistent plan", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/plans/999999/access");
    expect(res.status).toBe(404);
  });

  test("one_time: active when the user has an unexpired paid purchase", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time", durationDays: 30 });
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("one_time: not active without a purchase", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time" });
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: false } });
  });

  test("recurring: active with an active subscription", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    await seedSubscription({ referenceId: userId, plan: plan.name, status: "active" });
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("recurring: not active without a subscription", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: false } });
  });
});

describe("GET /plans/:id/access on a retired plan", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  async function retiredPlanBoughtBy(userId: string | null) {
    const plan = await seedPlan({ type: "one_time", durationDays: 30, active: false });
    if (userId)
      await addPurchase(
        { userId },
        {
          planId: plan.id,
          stripeCheckoutSessionId: "cs_retired",
          stripePaymentIntentId: "pi_retired",
          amountTotal: plan.amount,
          currency: plan.currency,
        },
        { durationDays: plan.durationDays },
        new Date(),
      );
    return plan;
  }

  test("someone who still holds it keeps access", async () => {
    const userId = await seedUser();
    const plan = await retiredPlanBoughtBy(userId);
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("anyone else gets a 404, as if it never existed", async () => {
    const userId = await seedUser();
    const plan = await retiredPlanBoughtBy(null);
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(404);
  });

  test("an admin (read:all) without it gets a plain answer, not a 404", async () => {
    const userId = await seedUser();
    const plan = await retiredPlanBoughtBy(null);
    setSession({ id: userId, ...admin }, { plan: ["read:active", "read:all"] });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: false } });
  });
});

describe("GET /access", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("lists the caller's active plans across both types", async () => {
    const userId = await seedUser();
    const pass = await seedPlan({ type: "one_time", durationDays: 30 });
    const sub = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    await addPurchase(
      { userId },
      {
        planId: pass.id,
        stripeCheckoutSessionId: "cs_pass",
        stripePaymentIntentId: "pi_pass",
        amountTotal: pass.amount,
        currency: pass.currency,
      },
      { durationDays: pass.durationDays },
      new Date(),
    );
    await seedSubscription({ referenceId: userId, plan: sub.name, status: "active" });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/access");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: number }[] };
    expect(body.data.map((p) => p.id)).toEqual([pass.id, sub.id]);
  });

  test("401s without a session", async () => {
    setSession(null);
    const res = await app.request("/access");
    expect(res.status).toBe(401);
  });
});

describe("POST /plans", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  test("409s on a duplicate name (case-insensitive), without ever reaching Stripe", async () => {
    const userId = await seedUser();
    await seedPlan({ name: "Pro" });
    setSession({ id: userId, ...admin }, { plan: ["create"] });

    const res = await app.request("/plans", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "pro", type: "one_time", amount: 1000, currency: "usd" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /plans/:id", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    priceUpdateCalls = [];
    priceUpdateFails = false;
  });

  const patch = (id: number, body: Record<string, unknown>) =>
    app.request(`/plans/${id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });

  test("retiring a plan archives its Stripe prices, so nothing outside the app can sell it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({
      type: "recurring",
      interval: "month",
      durationDays: null,
      stripePriceId: "price_monthly",
      annualDiscountPriceId: "price_annual",
    });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { active: false })).status).toBe(204);
    expect(priceUpdateCalls).toEqual([
      { id: "price_monthly", active: false },
      { id: "price_annual", active: false },
    ]);
  });

  test("reactivating a plan restores its Stripe prices", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ active: false, stripePriceId: "price_one_time" });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { active: true })).status).toBe(204);
    expect(priceUpdateCalls).toEqual([{ id: "price_one_time", active: true }]);
  });

  test("an edit that doesn't touch active makes no Stripe call", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { limits: { seats: 3 } })).status).toBe(204);
    expect(priceUpdateCalls).toEqual([]);
  });

  test("a Stripe failure 500s, and repeating the same change completes it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ stripePriceId: "price_one_time" });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    priceUpdateFails = true;
    const failed = await patch(plan.id, { active: false });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { message: string }).message).toContain("Retry");

    priceUpdateFails = false;
    expect((await patch(plan.id, { active: false })).status).toBe(204);
    expect(priceUpdateCalls).toEqual([{ id: "price_one_time", active: false }]);
  });

  test("422s setting durationDays on a recurring plan", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ durationDays: 30 }),
    });
    expect(res.status).toBe(422);
  });

  test("422s setting trialDays on a one_time plan", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time" });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ trialDays: 14 }),
    });
    expect(res.status).toBe(422);
  });

  test("409s flipping repeatable false -> true while a blocking purchase exists", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await addPurchase(
      { userId: otherUserId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: true }),
    });
    expect(res.status).toBe(409);
  });

  test("allows flipping repeatable false -> true when no purchase blocks it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: true }),
    });
    expect(res.status).toBe(204);
  });

  test("allows an unrelated field update even with a blocking purchase present", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_1",
        stripePaymentIntentId: "pi_1",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(204);
  });

  test("404s for a nonexistent plan", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    const res = await app.request("/plans/999999", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /checkout", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    sessionCreateCalls = [];
    sessionCreateDelayMs = 0;
    sessionCreateFails = false;
  });

  test("404s for a nonexistent plan", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: 999999 }),
    });
    expect(res.status).toBe(404);
  });

  test("404s for an inactive plan", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", active: false });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(404);
  });

  test("422s for a recurring plan - those go through better-auth's upgrade endpoint", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(422);
    expect(sessionCreateCalls).toHaveLength(0);
  });

  test("409s on a non-repeatable plan already purchased, and writes an audit log entry", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_existing",
        stripePaymentIntentId: "pi_existing",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(409);
    expect(sessionCreateCalls).toHaveLength(0);

    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.type).toBe("checkout_blocked_existing_purchase");
    expect(auditRows[0]?.userId).toBe(userId);
  });

  test("409s on a non-repeatable plan with a pending checkout it can't resume (no stored url)", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await savePendingCheckout(
      "cs_pending",
      { userId, planId: plan.id, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(409);
    expect(sessionCreateCalls).toHaveLength(0);
  });

  test("resumes an open checkout for a non-repeatable plan instead of locking the buyer out", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await savePendingCheckout(
      "cs_open",
      { userId, planId: plan.id, status: "open", url: "https://checkout.stripe.com/c/open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { sessionId: "cs_open", url: "https://checkout.stripe.com/c/open" },
      message: "Checkout resumed",
    });
    // same session, no new one in Stripe, and not a blocked attempt worth auditing
    expect(sessionCreateCalls).toHaveLength(0);
    expect(await db.select().from(paymentAuditLog)).toHaveLength(0);
  });

  test("a buyer who closed the tab gets the same session back on retry", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    const request = () =>
      app.request("/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ planId: plan.id }),
      });

    const first = await request();
    const second = await request();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    type Body = { data: { sessionId: string; url: string | null } };
    const [firstBody, secondBody] = (await Promise.all([first.json(), second.json()])) as Body[];
    expect(secondBody!.data).toEqual(firstBody!.data);
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("still 409s while the pending checkout is processing - it's already paid", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await savePendingCheckout(
      "cs_processing",
      {
        userId,
        planId: plan.id,
        status: "processing",
        url: "https://checkout.stripe.com/c/processing",
      },
      PENDING_CHECKOUT_TTL_SEC,
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(409);
    expect(sessionCreateCalls).toHaveLength(0);
    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows[0]?.type).toBe("checkout_blocked_pending_checkout");
  });

  test("a purchase confirmed between the ownership check and the reservation still 409s", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });

    // the interleaving: the first ownership check runs before the user's earlier checkout is
    // confirmed, and the webhook then inserts the purchase and clears the slot before this
    // request reserves it
    const realGetBlocking = paymentsRepo.purchase.getBlockingByPlan;
    let calls = 0;
    paymentsRepo.purchase.getBlockingByPlan = async (...args) => {
      if (calls++ === 0) {
        const first = await realGetBlocking(...args);
        await addPurchase(
          { userId },
          {
            planId: plan.id,
            stripeCheckoutSessionId: "cs_just_confirmed",
            stripePaymentIntentId: "pi_just_confirmed",
            amountTotal: plan.amount,
            currency: plan.currency,
          },
          { durationDays: plan.durationDays },
          new Date(),
        );
        return first;
      }
      return realGetBlocking(...args);
    };
    try {
      const res = await app.request("/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ planId: plan.id }),
      });
      expect(res.status).toBe(409);
    } finally {
      paymentsRepo.purchase.getBlockingByPlan = realGetBlocking;
    }

    // no second checkout for an already-owned plan, and the slot isn't left held
    expect(sessionCreateCalls).toHaveLength(0);
    expect(await getResumableCheckout(userId, plan.id)).toBeNull();
    const { reservePendingCheckout } = await import("@f/payments/lib/pending-checkout");
    expect(await reservePendingCheckout(userId, plan.id)).not.toBeNull();
    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows.map((row) => row.type)).toEqual(["checkout_blocked_existing_purchase"]);
  });

  test("repeatable plan: happy path bypasses the repeat-purchase guard entirely", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_prior",
        stripePaymentIntentId: "pi_prior",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { sessionId: "cs_test_fake", url: "https://checkout.stripe.com/fake" },
    });
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("non-repeatable plan, no prior purchase or pending checkout: happy path saves it as pending", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(200);
    expect(sessionCreateCalls).toHaveLength(1);

    const pending = await getPendingCheckout("cs_test_fake");
    expect(pending).toMatchObject({ userId, planId: plan.id, status: "open" });
  });

  test("non-repeatable plan: concurrent requests reach Stripe once - the rest 409", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    sessionCreateDelayMs = 50;

    const statuses = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const res = await app.request("/checkout", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ planId: plan.id }),
        });
        return res.status;
      }),
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(4);
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("non-repeatable plan: a Stripe failure frees the slot so the user can retry right away", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    const request = () =>
      app.request("/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ planId: plan.id }),
      });

    sessionCreateFails = true;
    expect((await request()).status).toBe(500);

    sessionCreateFails = false;
    expect((await request()).status).toBe(200);
  });
});
