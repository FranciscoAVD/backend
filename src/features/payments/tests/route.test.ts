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
mock.module("@f/payments/payment", () => ({
  getPaymentProcessor: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          sessionCreateCalls.push(args);
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
  PENDING_CHECKOUT_TTL_SEC,
} from "@f/payments/lib/pending-checkout";
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

  test("409s on a non-repeatable plan with a checkout already pending", async () => {
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
});
