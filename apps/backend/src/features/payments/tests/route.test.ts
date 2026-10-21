import { describe, expect, test, beforeEach, mock } from "bun:test";
import Stripe from "stripe";
import { Hono } from "hono";
import { pinoLogger, type Env as PinoLoggerEnv } from "hono-pino";
import { requestId } from "hono/request-id";
import { logger, httpLoggerOptions } from "@backend/lib/logger";
import {
  resetDb,
  seedUser,
  seedPlan,
  seedSubscription,
  seedCheckout,
} from "@backend/test-helpers/db";
import { resetRedis } from "@backend/test-helpers/redis";
import { redis } from "@backend/lib/redis";

type FakeUser = { id: string; name: string; email: string };
let fakeSession: { user: FakeUser } | null = null;
let fakePermissions: Record<string, string[]> = {};

function setSession(user: FakeUser | null, permissions: Record<string, string[]> = {}) {
  fakeSession = user ? { user } : null;
  fakePermissions = permissions;
}

// Fakes the real session/permission plumbing (better-auth + its admin plugin) so route
// handlers can be exercised over real HTTP without a live cookie/session - the same idea
// as how checkout.test.ts fakes Stripe, applied to @backend/f/auth/middleware instead.
mock.module("@backend/f/auth/middleware", () => ({
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

// Fakes Stripe for POST /checkout's happy path (checkout.sessions.create, and - for the handful
// of tests below that don't seed a stripeCustomerId - customers.create via ensureCustomer, per
// services/account.ts). Mirrors the fake checkout.test.ts already uses for the same Stripe call.
// Unlike the auth mock above, this one needs no dynamic-import treatment: every caller of
// getPaymentProcessor() calls it fresh at request time, not eagerly at module-evaluation time.
let sessionCreateCalls: Record<string, unknown>[] = [];
// knobs for POST /checkout's concurrency/failure tests: a delay widens the window between the
// guard and the Stripe call, as a real network round-trip would; a failure exercises cleanup
let sessionCreateDelayMs = 0;
let sessionCreateFails = false;
// ensureCustomer's own customers.create, for a user with no stripeCustomerId yet - most of
// POST /checkout's tests avoid this branch entirely by seeding one, see the comment above
let customerCreateCalls = 0;
let customerCreateFails = false;
// runs inside checkout.sessions.create, to interleave another request's work with this one's
let onSessionCreate: (() => Promise<void>) | null = null;
// PATCH /plans/:id's retire/reactivate mirroring onto the plan's Stripe prices
let priceUpdateCalls: { id: string; active: boolean }[] = [];
let priceUpdateFails = false;
// open Checkout Sessions on the account, for PATCH /plans/:id's retirement expiry
let openSessions: { id: string; status: string; metadata: Record<string, string> }[] = [];
let expiredSessions: string[] = [];
let expireFails = false;
let productsCreated = 0;
// POST /purchases/:id/refund
type FakeCharge = { amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
let refundCalls: { paymentIntent: string; amount?: number; reason?: string }[] = [];
let refundFails = false;
// lets a test have refunds.create reject with a specific Stripe error, to exercise the known
// disputed-charge / amount-exceeds-refundable translations in fulfillment.ts's refund()
let refundRejectError: Error | null = null;
// payment-intent id -> fake charge state, so paymentIntents.retrieve's latest_charge reflects
// what refunds.create just did (resolveChargeState pulls this back after issuing a refund)
let fakeCharges: Record<string, FakeCharge> = {};
// idempotency key -> the Refund already created for it (and the params it was created with), so a
// retry with the same key returns the cached result - flagged with the same `Idempotent-Replayed`
// header real Stripe sends - instead of refunding a second time, and a reused key with different
// params is rejected, the same guarantees the real Stripe API gives
type FakeRefund = { id: string; status: string; failure_reason: string | null };
let refundsByIdempotencyKey: Record<string, { refund: FakeRefund; params: string }> = {};
// refund id -> its live state, for refunds.retrieve; a test flips a status here to simulate a
// refund that failed after Stripe accepted it
let refundsById: Record<string, FakeRefund> = {};
// the status a newly created refund starts in
let newRefundStatus = "succeeded";
// makes paymentIntents.retrieve throw, simulating refund()'s post-refund sync step failing after
// the Stripe refund itself already succeeded
let syncFails = false;
const fakeStripeClient = () => ({
  customers: {
    create: async () => {
      if (customerCreateFails) throw new Error("Stripe is down");
      customerCreateCalls++;
      return { id: "cus_route_fake" };
    },
  },
  products: {
    create: async () => ({ id: `prod_route_${++productsCreated}` }),
    update: async (id: string) => ({ id }),
  },
  prices: {
    create: async () => ({ id: `price_route_${crypto.randomUUID()}` }),
    update: async (id: string, params: { active: boolean }) => {
      if (priceUpdateFails) throw new Error("Stripe is down");
      priceUpdateCalls.push({ id, active: params.active });
      return { id, active: params.active };
    },
  },
  checkout: {
    sessions: {
      list: (params: { status?: string }) =>
        openSessions.filter((s) => !params.status || s.status === params.status),
      expire: async (id: string) => {
        if (expireFails) throw new Error("Stripe is down");
        expiredSessions.push(id);
        return { id, status: "expired" };
      },
      create: async (args: Record<string, unknown>) => {
        sessionCreateCalls.push(args);
        if (sessionCreateDelayMs) await Bun.sleep(sessionCreateDelayMs);
        if (sessionCreateFails) throw new Error("Stripe is down");
        await onSessionCreate?.();
        return { id: "cs_test_fake", url: "https://checkout.stripe.com/fake" };
      },
    },
  },
  refunds: {
    create: async (
      params: { payment_intent: string; amount?: number; reason?: string },
      options: { idempotencyKey: string },
    ) => {
      const cached = refundsByIdempotencyKey[options.idempotencyKey];
      if (cached) {
        if (cached.params !== JSON.stringify(params))
          throw new Stripe.errors.StripeIdempotencyError({
            message: "Keys for idempotent requests can only be used with the same parameters.",
          });
        return {
          ...cached.refund,
          lastResponse: { headers: { "idempotent-replayed": "true" } },
        };
      }

      if (refundRejectError) throw refundRejectError;
      if (refundFails) throw new Error("Stripe is down");
      refundCalls.push({
        paymentIntent: params.payment_intent,
        amount: params.amount,
        reason: params.reason,
      });
      const charge = fakeCharges[params.payment_intent];
      if (charge) {
        charge.amount_refunded = Math.min(
          charge.amount,
          charge.amount_refunded + (params.amount ?? charge.amount),
        );
        charge.refunded = charge.amount_refunded >= charge.amount;
      }
      const refund: FakeRefund = {
        id: `re_${crypto.randomUUID()}`,
        status: newRefundStatus,
        failure_reason: newRefundStatus === "failed" ? "expired_or_canceled_card" : null,
      };
      refundsByIdempotencyKey[options.idempotencyKey] = {
        refund: { ...refund },
        params: JSON.stringify(params),
      };
      refundsById[refund.id] = refund;
      return { ...refund, lastResponse: { headers: {} } };
    },
    retrieve: async (id: string) => ({ ...refundsById[id]! }),
  },
  paymentIntents: {
    retrieve: async (id: string) => {
      if (syncFails) throw new Error("Stripe is down");
      return { id, latest_charge: fakeCharges[id] ?? null };
    },
  },
  disputes: { list: () => ({ data: [] }) },
});

mock.module("@backend/f/payments/lib/stripe/client", () => ({
  getPaymentProcessor: fakeStripeClient,
  // ensureCustomer dynamically imports @backend/f/auth/auth, which hands this to the stripe plugin at
  // module-evaluation time - exercised only by the handful of tests below that don't seed a
  // stripeCustomerId already (see the comment above). None of this file's tests reach the
  // plugin's own checkout.session.completed subscription lookup, so the same fake client is
  // enough; getPaymentProcessorForAuthPlugin's own short-circuit behavior is covered directly
  // against the real implementation in stripe-client.test.ts
  getPaymentProcessorForAuthPlugin: fakeStripeClient,
}));

// mocks @backend/f/email/lib/client, not @backend/f/email/send - see CLAUDE.md's testing section for why.
// POST /purchases/:id/refund now sends a best-effort confirmation email on a successful refund.
let refundConfirmationEmailCalls: Record<string, unknown>[] = [];
let refundConfirmationEmailFails = false;
mock.module("@backend/f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: {
      send: async (payload: Record<string, unknown>) => {
        if (refundConfirmationEmailFails) throw new Error("Resend is down");
        refundConfirmationEmailCalls.push(payload);
        return { data: { id: "email_1" }, error: null };
      },
    },
  }),
}));

import { db } from "@backend/d/connection";
import {
  paymentAuditLog,
  checkout as checkoutTable,
} from "@backend/d/schemas/payment-schema";
import { eq } from "drizzle-orm";
import { paymentsRepo } from "@backend/f/payments/repo";
import { RESERVATION_TTL_SEC } from "@backend/f/payments/lib/constants";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
import { markUserDeleting } from "@backend/f/payments/lib/state/deletion-guard";
import {
  CHECKOUT_SOURCE_METADATA_KEY,
  CHECKOUT_SOURCE_METADATA_VALUE,
  CHECKOUT_SESSION_EXPIRY_MARGIN_SEC,
} from "@backend/f/payments/lib/constants";

// how every Checkout Session this app creates is tagged (see CHECKOUT_SOURCE_METADATA_KEY) - the
// sessions below stand in for ones it created, so they carry it too
const OURS = { [CHECKOUT_SOURCE_METADATA_KEY]: CHECKOUT_SOURCE_METADATA_VALUE };

// dynamic, not static - route.ts calls .use(sessionMiddleware) at module-evaluation
// time, capturing the function by value into Hono's middleware chain immediately.
// A static import is hoisted above the mock.module call above regardless of its
// textual position, so route.ts would still capture the real middleware; only a
// genuine runtime import, evaluated at this exact point, sees the faked module.
const { default: paymentsApp } = await import("@backend/f/payments/route");

// route.ts's own app never mounts pinoLogger itself - it relies on being mounted under
// src/index.ts's root app, which does. Re-wire the same thing here so c.var.logger exists.
const app = new Hono<PinoLoggerEnv>()
  .use(requestId())
  .use(pinoLogger({ pino: logger, http: httpLoggerOptions }))
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

  test("403s on POST /purchases/:id/refund without purchase:refund", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin });

    const res = await app.request("/purchases/1/refund", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
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

  test("403s without plan:read:active, like GET /plans/:id", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    setSession({ id: userId, ...regularUser });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(403);
  });

  test("404s for a nonexistent plan", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

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
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("one_time: not active without a purchase", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time" });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: false } });
  });

  test("recurring: active with an active subscription", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    await seedSubscription({ referenceId: userId, plan: plan.name, status: "active" });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("recurring: not active without a subscription", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "recurring", interval: "month", durationDays: null });
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

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
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

    const res = await app.request(`/plans/${plan.id}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { active: true } });
  });

  test("anyone else gets a 404, as if it never existed", async () => {
    const userId = await seedUser();
    const plan = await retiredPlanBoughtBy(null);
    setSession({ id: userId, ...regularUser }, { plan: ["read:active"] });

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

  test("409s, not 500s, when a same-name plan lands between the check and the insert", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["create"] });
    // the concurrent create lands right after this request's own name check
    const realGetByName = paymentsRepo.plan.get.byName;
    paymentsRepo.plan.get.byName = async (...args) => {
      const res = await realGetByName(...args);
      await seedPlan({ name: "Pro" });
      return res;
    };
    try {
      const res = await app.request("/plans", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "pro", type: "one_time", amount: 1000, currency: "usd" }),
      });
      expect(res.status).toBe(409);
    } finally {
      paymentsRepo.plan.get.byName = realGetByName;
    }
  });
});

describe("PATCH /plans/:id", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    priceUpdateCalls = [];
    priceUpdateFails = false;
    openSessions = [];
    expiredSessions = [];
    expireFails = false;
  });

  test("retiring a one-time plan expires checkouts still open for it, and only those", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    const other = await seedPlan();
    // created before the source tag existed: untagged, but its checkout row says it's ours
    await seedCheckout({ userId, planId: plan.id, stripeCheckoutSessionId: "cs_pre_tag" });
    openSessions = [
      { id: "cs_this_plan", status: "open", metadata: { ...OURS, planId: String(plan.id) } },
      { id: "cs_other_plan", status: "open", metadata: { ...OURS, planId: String(other.id) } },
      { id: "cs_done", status: "complete", metadata: { ...OURS, planId: String(plan.id) } },
      { id: "cs_foreign", status: "open", metadata: {} },
      { id: "cs_pre_tag", status: "open", metadata: { planId: String(plan.id) } },
      // a Payment Link or another app on the same Stripe account using the same metadata key
      { id: "cs_not_ours", status: "open", metadata: { planId: String(plan.id) } },
    ];
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { active: false })).status).toBe(204);
    expect(expiredSessions).toEqual(["cs_this_plan", "cs_pre_tag"]);
  });

  test("retiring a recurring plan expires the stripe plugin's open checkouts for it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ name: "Pro", type: "recurring", interval: "month", durationDays: null });
    // the plugin's pending row for a subscription checkout, and one for another plan
    await seedSubscription({ id: "subrow_pro", referenceId: userId, plan: "pro", status: "incomplete" });
    await seedSubscription({ id: "subrow_basic", referenceId: userId, plan: "basic", status: "incomplete" });
    openSessions = [
      { id: "cs_sub_pro", status: "open", metadata: { subscriptionId: "subrow_pro", userId } },
      { id: "cs_sub_basic", status: "open", metadata: { subscriptionId: "subrow_basic", userId } },
    ];
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { active: false })).status).toBe(204);
    expect(expiredSessions).toEqual(["cs_sub_pro"]);
  });

  test("reactivating a plan expires nothing", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ active: false });
    openSessions = [{ id: "cs_x", status: "open", metadata: { ...OURS, planId: String(plan.id) } }];
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expect((await patch(plan.id, { active: true })).status).toBe(204);
    expect(expiredSessions).toEqual([]);
  });

  test("a failed expiry 500s, and repeating the retirement completes it", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();
    openSessions = [{ id: "cs_open", status: "open", metadata: { ...OURS, planId: String(plan.id) } }];
    setSession({ id: userId, ...admin }, { plan: ["update"] });

    expireFails = true;
    expect((await patch(plan.id, { active: false })).status).toBe(500);
    expireFails = false;
    expect((await patch(plan.id, { active: false })).status).toBe(204);
    expect(expiredSessions).toEqual(["cs_open"]);
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
    onSessionCreate = null;
    expiredSessions = [];
    expireFails = false;
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
    await seedCheckout({
      userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_pending",
      url: null,
    });
    setSession({ id: userId, ...regularUser });

    const res = await app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId: plan.id }),
    });
    expect(res.status).toBe(409);
    expect(sessionCreateCalls).toHaveLength(0);
  });

  // a session expires CHECKOUT_SESSION_EXPIRY_MARGIN_SEC before its row: this row's session has
  // 3 minutes left, too few to hand back to a buyer
  const shortSessionDeadline = () =>
    new Date(Date.now() + (CHECKOUT_SESSION_EXPIRY_MARGIN_SEC + 180) * 1000);

  for (const repeatable of [false, true])
    test(`replaces an open checkout about to expire with a fresh one (repeatable: ${repeatable})`, async () => {
      const userId = await seedUser({ stripeCustomerId: "cus_test" });
      const plan = await seedPlan({ type: "one_time", repeatable });
      await seedCheckout({
        userId,
        planId: plan.id,
        stripeCheckoutSessionId: "cs_short",
        url: "https://checkout.stripe.com/c/short",
        slot: repeatable ? null : 1,
        expiresAt: shortSessionDeadline(),
      });
      setSession({ id: userId, ...regularUser });

      const res = await app.request("/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ planId: plan.id }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        data: { sessionId: "cs_test_fake" },
        message: "Checkout created",
      });
      // the short session was expired at Stripe and its row closed, not left payable alongside
      expect(expiredSessions).toEqual(["cs_short"]);
      const [old] = await db
        .select()
        .from(checkoutTable)
        .where(eq(checkoutTable.stripeCheckoutSessionId, "cs_short"));
      expect(old?.status).toBe("expired");
      expect(sessionCreateCalls).toHaveLength(1);
    });

  test("409s if the session about to expire can't be expired (e.g. it was just paid)", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    await seedCheckout({
      userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_short",
      url: "https://checkout.stripe.com/c/short",
      expiresAt: shortSessionDeadline(),
    });
    setSession({ id: userId, ...regularUser });
    expireFails = true;

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
    await seedCheckout({
      userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_open",
      url: "https://checkout.stripe.com/c/open",
    });
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
    await seedCheckout({
      userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_processing",
      status: "processing",
      url: "https://checkout.stripe.com/c/processing",
    });
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
    const realGetBlocking = paymentsRepo.purchase.getBlocking;
    let calls = 0;
    paymentsRepo.purchase.getBlocking = async (...args) => {
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
      paymentsRepo.purchase.getBlocking = realGetBlocking;
    }

    // no second checkout for an already-owned plan, and the slot isn't left held
    expect(sessionCreateCalls).toHaveLength(0);
    expect(await paymentsRepo.checkout.get.resumable({ userId, planId: plan.id })).toBeNull();
    expect(
      await paymentsRepo.checkout.claim(
        { userId },
        { planId: plan.id, expiresAt: new Date(Date.now() + RESERVATION_TTL_SEC * 1000) },
      ),
    ).not.toBeNull();
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

    const pending = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_test_fake",
    });
    expect(pending).toMatchObject({ userId, planId: plan.id, status: "open", slot: 1 });
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

describe("POST /checkout: reservations, deletion and repeatable plans", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    sessionCreateCalls = [];
    sessionCreateDelayMs = 0;
    sessionCreateFails = false;
    onSessionCreate = null;
    expiredSessions = [];
    expireFails = false;
    customerCreateCalls = 0;
    customerCreateFails = false;
  });

  const checkout = (planId: number) =>
    app.request("/checkout", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ planId }),
    });

  test("a reservation that lapsed while Stripe answered doesn't clobber the slot's new holder", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    let otherClaim: { id: number } | null = null;
    // this request's reservation lapses mid-call; another request sweeps it and claims the slot
    onSessionCreate = async () => {
      await db
        .update(checkoutTable)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(checkoutTable.userId, userId));
      otherClaim = await paymentsRepo.checkout.claim(
        { userId },
        { planId: plan.id, expiresAt: new Date(Date.now() + RESERVATION_TTL_SEC * 1000) },
      );
    };

    const res = await checkout(plan.id);

    expect(res.status).toBe(409);
    expect(otherClaim).not.toBeNull();
    // the other request still holds the slot, and this request's session was withheld and expired
    const [held] = await db
      .select()
      .from(checkoutTable)
      .where(eq(checkoutTable.id, otherClaim!.id));
    expect(held!.status).toBe("reserving");
    expect(
      await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_test_fake" }),
    ).toBeNull();
    expect(expiredSessions).toEqual(["cs_test_fake"]);
  });

  test("refuses a checkout once the user's deletion has started, before reaching Stripe", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    setSession({ id: userId, ...regularUser });
    await markUserDeleting(userId);

    const res = await checkout(plan.id);

    expect(res.status).toBe(409);
    expect(sessionCreateCalls).toHaveLength(0);
  });

  test("a deletion that starts while the session is being created expires it", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    onSessionCreate = async () => markUserDeleting(userId);

    const res = await checkout(plan.id);

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("checkout.stripe.com");
    expect(expiredSessions).toEqual(["cs_test_fake"]);
    expect(
      (await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_test_fake" }))
        ?.status,
    ).toBe("expired");
  });

  test("a deletion flag that can't be read after the session exists fails closed", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    // the pre-check reads the flag fine; by the re-check, reading it errors (a hash where a string
    // is expected makes GET fail with WRONGTYPE - a stand-in for any Redis failure)
    onSessionCreate = async () => {
      await redis.send("HSET", [`payments:deleting:${userId}`, "f", "1"]);
    };

    const res = await checkout(plan.id);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("checkout.stripe.com");
    expect(expiredSessions).toEqual(["cs_test_fake"]);
    expect(
      (await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_test_fake" }))
        ?.status,
    ).toBe("expired");
  });

  test("repeatable plan: a second request reuses the open session instead of creating another", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    setSession({ id: userId, ...regularUser });

    const first = await checkout(plan.id);
    const second = await checkout(plan.id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      data: { sessionId: "cs_test_fake" },
      message: "Checkout resumed",
    });
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("repeatable plan: concurrent requests reach Stripe once", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    setSession({ id: userId, ...regularUser });
    sessionCreateDelayMs = 50;

    const statuses = await Promise.all(
      Array.from({ length: 5 }, async () => (await checkout(plan.id)).status),
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(4);
    expect(sessionCreateCalls).toHaveLength(1);
    // and the lock is freed: the next request resumes the session
    expect((await checkout(plan.id)).status).toBe(200);
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("repeatable plan: a settling (processing) purchase doesn't block buying it again", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    await seedCheckout({
      userId,
      planId: plan.id,
      stripeCheckoutSessionId: "cs_settling",
      status: "processing",
      // a repeatable plan's session released the slot when it opened
      slot: null,
      url: "https://checkout.stripe.com/s",
    });
    setSession({ id: userId, ...regularUser });

    const res = await checkout(plan.id);

    expect(res.status).toBe(200);
    expect(sessionCreateCalls).toHaveLength(1);
  });

  test("repeatable plan: a failed Stripe call frees the lock for a retry", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_test" });
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    setSession({ id: userId, ...regularUser });
    sessionCreateFails = true;

    expect((await checkout(plan.id)).status).toBe(500);
    sessionCreateFails = false;
    expect((await checkout(plan.id)).status).toBe(200);
  });

  test("non-repeatable plan: a failed customer lookup frees the reservation for a retry", async () => {
    // no stripeCustomerId, so ensureCustomer reaches customers.create
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time", repeatable: false });
    setSession({ id: userId, ...regularUser });
    customerCreateFails = true;

    expect((await checkout(plan.id)).status).toBe(500);
    customerCreateFails = false;
    expect((await checkout(plan.id)).status).toBe(200);
  });

  test("repeatable plan: a failed customer lookup frees the create-lock for a retry", async () => {
    const userId = await seedUser();
    const plan = await seedPlan({ type: "one_time", repeatable: true });
    setSession({ id: userId, ...regularUser });
    customerCreateFails = true;

    expect((await checkout(plan.id)).status).toBe(500);
    customerCreateFails = false;
    expect((await checkout(plan.id)).status).toBe(200);
  });
});

describe("plan day counts are capped", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  const create = (body: Record<string, unknown>) =>
    app.request("/plans", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ type: "one_time", amount: 1000, currency: "usd", ...body }),
    });

  test("POST /plans refuses a durationDays past the cap, and accepts the cap itself", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["create"] });
    const { MAX_DURATION_DAYS } = await import("@backend/f/payments/lib/constants");

    expect((await create({ name: "Huge", durationDays: 2_000_000_000 })).status).toBe(422);
    expect((await create({ name: "Over", durationDays: MAX_DURATION_DAYS + 1 })).status).toBe(422);
    expect((await create({ name: "Max", durationDays: MAX_DURATION_DAYS })).status).toBe(201);
  });

  test("POST /plans refuses a trialDays past Stripe's limit", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["create"] });
    const { MAX_TRIAL_DAYS } = await import("@backend/f/payments/lib/constants");

    const res = await create({
      name: "Trial",
      type: "recurring",
      interval: "month",
      trialDays: MAX_TRIAL_DAYS + 1,
    });
    expect(res.status).toBe(422);
  });

  test("PATCH /plans/:id applies the same caps", async () => {
    const userId = await seedUser();
    const oneTime = await seedPlan({ type: "one_time" });
    const recurring = await seedPlan({ type: "recurring", interval: "month" });
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const { MAX_DURATION_DAYS, MAX_TRIAL_DAYS } = await import("@backend/f/payments/lib/constants");
    const patch = (id: number, body: Record<string, unknown>) =>
      app.request(`/plans/${id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });

    expect((await patch(oneTime.id, { durationDays: MAX_DURATION_DAYS + 1 })).status).toBe(422);
    expect((await patch(recurring.id, { trialDays: MAX_TRIAL_DAYS + 1 })).status).toBe(422);
    expect((await patch(oneTime.id, { durationDays: MAX_DURATION_DAYS })).status).toBe(204);
  });
});

describe("low-severity fixes", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    openSessions = [];
    expiredSessions = [];
    expireFails = false;
  });

  test("GET /purchases reports the chained access window, not the unchained expiresAt", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });
    const plan = await seedPlan({ repeatable: true, durationDays: 30, overlapping: false });
    const day = 24 * 60 * 60 * 1000;
    const first = new Date(Date.now() - 10 * day);
    const second = new Date(Date.now() - 5 * day);
    for (const [i, at] of [first, second].entries())
      await addPurchase(
        { userId },
        {
          planId: plan.id,
          stripeCheckoutSessionId: `cs_chain_${i}`,
          stripePaymentIntentId: `pi_chain_${i}`,
          amountTotal: plan.amount,
          currency: plan.currency,
        },
        { durationDays: 30, overlapping: false },
        at,
      );

    const res = await app.request("/purchases");
    const { data } = (await res.json()) as {
      data: { expiresAt: string; accessStartsAt: string; accessEndsAt: string }[];
    };

    expect(new Date(data[1]!.expiresAt).getTime()).toBe(second.getTime() + 30 * day);
    expect(new Date(data[1]!.accessStartsAt).getTime()).toBe(first.getTime() + 30 * day);
    expect(new Date(data[1]!.accessEndsAt).getTime()).toBe(first.getTime() + 60 * day);
  });

  test("GET /purchases gives a refunded purchase no access window", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });
    const plan = await seedPlan();
    const row = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: "cs_refunded",
        stripePaymentIntentId: "pi_refunded",
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: null },
      new Date(),
    );
    await paymentsRepo.purchase.syncCharge({ stripePaymentIntentId: "pi_refunded" }, async () => ({
      status: "refunded",
      amountRefunded: row!.amountTotal,
    }));

    const { data } = (await (await app.request("/purchases")).json()) as {
      data: { accessStartsAt: string | null; accessEndsAt: string | null }[];
    };
    expect(data[0]).toMatchObject({ accessStartsAt: null, accessEndsAt: null });
  });

  test("PATCH /plans/:id expires checkouts opened under the old terms", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const plan = await seedPlan({ durationDays: 30 });
    const other = await seedPlan();
    openSessions = [
      { id: "cs_old_terms", status: "open", metadata: { ...OURS, planId: String(plan.id) } },
      { id: "cs_other_plan", status: "open", metadata: { ...OURS, planId: String(other.id) } },
    ];

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ durationDays: 7 }),
    });

    expect(res.status).toBe(204);
    expect(expiredSessions).toEqual(["cs_old_terms"]);
  });

  test("PATCH /plans/:id leaves open checkouts alone when the terms aren't touched", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const plan = await seedPlan();
    openSessions = [{ id: "cs_keep", status: "open", metadata: { ...OURS, planId: String(plan.id) } }];

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ limits: { seats: 3 } }),
    });

    expect(res.status).toBe(204);
    expect(expiredSessions).toEqual([]);
  });

  test("PATCH /plans/:id expires open checkouts when a plan stops being repeatable", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const plan = await seedPlan({ repeatable: true });
    const other = await seedPlan({ name: "Other", repeatable: true });
    // a repeatable plan's open session released its slot, so once the plan is non-repeatable
    // nothing else would stop a buyer who already owns it from paying this one too
    openSessions = [
      { id: "cs_repeat_buy", status: "open", metadata: { ...OURS, planId: String(plan.id) } },
      { id: "cs_other_plan", status: "open", metadata: { ...OURS, planId: String(other.id) } },
    ];

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: false }),
    });

    expect(res.status).toBe(204);
    expect(expiredSessions).toEqual(["cs_repeat_buy"]);
  });

  test("PATCH /plans/:id leaves open checkouts alone when repeatable doesn't actually turn off", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const nonRepeatable = await seedPlan({ repeatable: false });
    const repeatable = await seedPlan({ name: "Repeatable", repeatable: true });
    openSessions = [
      { id: "cs_a", status: "open", metadata: { ...OURS, planId: String(nonRepeatable.id) } },
      { id: "cs_b", status: "open", metadata: { ...OURS, planId: String(repeatable.id) } },
    ];

    // already non-repeatable: nothing changes for anyone mid-checkout
    const noop = await app.request(`/plans/${nonRepeatable.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: false }),
    });
    // turning repeat-buying *on* restricts nothing an open session was sold under
    const opening = await app.request(`/plans/${repeatable.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ repeatable: true }),
    });

    expect(noop.status).toBe(204);
    expect(opening.status).toBe(204);
    expect(expiredSessions).toEqual([]);
  });

  test("PATCH /plans/:id answers 500 if the stale checkouts couldn't be expired", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["update"] });
    const plan = await seedPlan();
    openSessions = [{ id: "cs_stuck", status: "open", metadata: { ...OURS, planId: String(plan.id) } }];
    expireFails = true;

    const res = await app.request(`/plans/${plan.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ overlapping: false }),
    });

    expect(res.status).toBe(500);
  });

  test("POST /plans rejects a name with compatibility characters", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...admin }, { plan: ["create"] });

    const res = await app.request("/plans", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "Pac\u212A",
        type: "one_time",
        amount: 500,
        currency: "usd",
      }),
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("NFKC");
  });

  test("reads are rate limited per user", async () => {
    const userId = await seedUser();
    setSession({ id: userId, ...regularUser });

    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await app.request("/purchases")).status);

    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe("checkouts expired by a plan edit can't be resumed", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    openSessions = [];
    expiredSessions = [];
    expireFails = false;
    sessionCreateCalls = [];
  });

  // Stripe's checkout.session.expired webhook can lag (or be retried for days in an outage); until
  // it lands, the checkout row would still say `open` and resume would hand back a dead URL
  for (const repeatable of [false, true])
    test(`${repeatable ? "repeatable" : "non-repeatable"}: the next POST /checkout creates a new session`, async () => {
      const adminId = await seedUser();
      const userId = await seedUser({ stripeCustomerId: "cus_test" });
      const plan = await seedPlan({ type: "one_time", repeatable, durationDays: 30 });
      await seedCheckout({
        userId,
        planId: plan.id,
        stripeCheckoutSessionId: "cs_old_terms",
        slot: repeatable ? null : 1,
        url: "https://checkout.stripe.com/c/old",
      });
      openSessions = [{ id: "cs_old_terms", status: "open", metadata: { ...OURS, planId: String(plan.id) } }];

      setSession({ id: adminId, ...admin }, { plan: ["update"] });
      const patch = await app.request(`/plans/${plan.id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ durationDays: 7 }),
      });
      expect(patch.status).toBe(204);
      expect(
        (await paymentsRepo.checkout.get.bySession({
          stripeCheckoutSessionId: "cs_old_terms",
        }))?.status,
      ).toBe("expired");
      expect(await paymentsRepo.checkout.get.resumable({ userId, planId: plan.id })).toBeNull();

      setSession({ id: userId, ...regularUser });
      const res = await app.request("/checkout", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ planId: plan.id }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        data: { sessionId: "cs_test_fake" },
        message: "Checkout created",
      });
      expect(sessionCreateCalls).toHaveLength(1);
    });
});

describe("POST /purchases/:id/refund", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    refundCalls = [];
    refundFails = false;
    refundRejectError = null;
    fakeCharges = {};
    refundsByIdempotencyKey = {};
    refundsById = {};
    newRefundStatus = "succeeded";
    syncFails = false;
    refundConfirmationEmailCalls = [];
    refundConfirmationEmailFails = false;
  });

  // one fixed key unless a test passes its own: repeated calls with the defaults are retries of the
  // same refund, the way a client resubmitting one form would send them
  const refundReq = (id: number, body: Record<string, unknown> = {}) =>
    app.request(`/purchases/${id}/refund`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ idempotencyKey: "refund-form-1", ...body }),
    });

  // stripePaymentIntentId: null mirrors a $0 purchase, where Stripe never creates a payment
  // intent at all - everything else is a full-amount, unrefunded purchase on a fresh plan
  async function seedRefundablePurchase(
    stripePaymentIntentId: string | null = "pi_refund_test",
    userOverrides: Partial<{ email: string; name: string }> = {},
  ) {
    const userId = await seedUser({ email: "buyer@example.test", name: "Ada", ...userOverrides });
    const plan = await seedPlan();
    const purchase = await addPurchase(
      { userId },
      {
        planId: plan.id,
        stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
        stripePaymentIntentId,
        amountTotal: plan.amount,
        currency: plan.currency,
      },
      { durationDays: plan.durationDays },
      new Date(),
    );
    if (stripePaymentIntentId)
      fakeCharges[stripePaymentIntentId] = {
        amount: plan.amount,
        amount_refunded: 0,
        refunded: false,
        disputed: false,
      };
    return { plan, purchase: purchase! };
  }

  async function asAdmin() {
    const adminId = await seedUser();
    setSession({ id: adminId, ...admin }, { purchase: ["refund"] });
  }

  test("refunds a purchase in full, syncing status and amountRefunded back from Stripe", async () => {
    const { plan, purchase } = await seedRefundablePurchase();
    await asAdmin();

    const res = await refundReq(purchase.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; amountRefunded: number } };
    expect(body.data.status).toBe("refunded");
    expect(body.data.amountRefunded).toBe(plan.amount);
    expect(refundCalls).toEqual([
      { paymentIntent: "pi_refund_test", amount: undefined, reason: undefined },
    ]);

    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.type).toBe("refund_issued");
    expect(auditRows[0]?.existingPurchaseId).toBe(purchase.id);

    expect(refundConfirmationEmailCalls).toHaveLength(1);
    expect(refundConfirmationEmailCalls[0]?.to).toBe("buyer@example.test");
    expect(refundConfirmationEmailCalls[0]?.html).toContain("Hi Ada,");
  });

  test("supports a partial refund amount and reason", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    const res = await refundReq(purchase.id, { amount: 500, reason: "requested_by_customer" });
    expect(res.status).toBe(200);
    expect(refundCalls).toEqual([
      { paymentIntent: "pi_refund_test", amount: 500, reason: "requested_by_customer" },
    ]);
    const body = (await res.json()) as { data: { amountRefunded: number } };
    expect(body.data.amountRefunded).toBe(500);

    // the email reports the amount of *this* refund, not the (so far identical) running total
    expect(refundConfirmationEmailCalls).toHaveLength(1);
    expect(refundConfirmationEmailCalls[0]?.html).toContain("$5.00");
  });

  test("404s for a nonexistent purchase", async () => {
    await asAdmin();
    expect((await refundReq(999999)).status).toBe(404);
  });

  test("422s a purchase with no payment intent (e.g. a $0 purchase)", async () => {
    const { purchase } = await seedRefundablePurchase(null);
    await asAdmin();

    expect((await refundReq(purchase.id)).status).toBe(422);
  });

  test("409s refunding an already-refunded purchase, sending no additional email", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    expect((await refundReq(purchase.id)).status).toBe(200);
    expect((await refundReq(purchase.id)).status).toBe(409);
    expect(refundConfirmationEmailCalls).toHaveLength(1);
  });

  test("409s refunding a disputed charge, with a clear message and no email", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    refundRejectError = new Stripe.errors.StripeInvalidRequestError({
      message: "The charge you're attempting to refund has been charged back.",
      code: "charge_disputed",
    });

    const res = await refundReq(purchase.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("disputed");
    expect(refundConfirmationEmailCalls).toHaveLength(0);
  });

  test("422s asking to refund more than what's left, with a clear message and no email", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    refundRejectError = new Stripe.errors.StripeInvalidRequestError({
      message: "This value must be less than or equal to 500.",
      code: "amount_too_large",
      param: "amount",
    });

    const res = await refundReq(purchase.id, { amount: 999999 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain("exceeds");
    expect(refundConfirmationEmailCalls).toHaveLength(0);
  });

  test("an unrecognized Stripe error still 500s", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    refundRejectError = new Stripe.errors.StripeInvalidRequestError({
      message: "Something else went wrong.",
      code: "some_other_code",
    });

    expect((await refundReq(purchase.id)).status).toBe(500);
  });

  test("a Stripe failure 500s, and repeating the refund completes it", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    refundFails = true;
    expect((await refundReq(purchase.id)).status).toBe(500);
    refundFails = false;
    expect((await refundReq(purchase.id)).status).toBe(200);
    expect(refundCalls).toHaveLength(1);
    // only the successful retry actually refunded anything - only it emails a confirmation
    expect(refundConfirmationEmailCalls).toHaveLength(1);
  });

  test("a sync failure after a successful refund still 200s with an audit entry, and a retry doesn't refund twice", async () => {
    const { plan, purchase } = await seedRefundablePurchase();
    await asAdmin();

    syncFails = true;
    const res = await refundReq(purchase.id);
    expect(res.status).toBe(200);
    // not synced - still reflects the pre-refund state, since Stripe couldn't be read back
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("paid");

    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.type).toBe("refund_issued");

    syncFails = false;
    // the purchase row is still "paid" (the sync never landed), so the already_refunded guard
    // can't catch this retry on its own - the idempotency key has to stop a second real refund
    const retry = await refundReq(purchase.id);
    expect(retry.status).toBe(200);
    expect(refundCalls).toHaveLength(1);
    expect(fakeCharges["pi_refund_test"]?.amount_refunded).toBe(plan.amount);
    // no email on the first attempt - the sync never confirmed a transition happened at all;
    // the retry's successful sync is what actually earns the one confirmation email
    expect(refundConfirmationEmailCalls).toHaveLength(1);
  });

  test("422s without an idempotency key", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    const res = await app.request(`/purchases/${purchase.id}/refund`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ amount: 100 }),
    });
    expect(res.status).toBe(422);
    expect(refundCalls).toHaveLength(0);
  });

  test("two separate partial refunds of the same amount and reason both go through", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    const body = { amount: 300, reason: "requested_by_customer" };
    const first = await refundReq(purchase.id, { ...body, idempotencyKey: "refund-a-0001" });
    const second = await refundReq(purchase.id, { ...body, idempotencyKey: "refund-b-0002" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(refundCalls).toHaveLength(2);
    expect(fakeCharges["pi_refund_test"]?.amount_refunded).toBe(600);
    const secondBody = (await second.json()) as { data: { amountRefunded: number }; replayed: boolean };
    expect(secondBody.replayed).toBe(false);
    expect(secondBody.data.amountRefunded).toBe(600);

    // one audit row per real refund, each naming its own Stripe refund
    const auditRows = await db.select().from(paymentAuditLog);
    expect(auditRows).toHaveLength(2);
    const refundIds = auditRows.map((r) => (r.details as { stripeRefundId: string }).stripeRefundId);
    expect(new Set(refundIds).size).toBe(2);
    expect(refundConfirmationEmailCalls).toHaveLength(2);
  });

  test("a retry with the same key is reported as a replay and writes no second audit row", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    const first = await refundReq(purchase.id, { amount: 300 });
    const retry = await refundReq(purchase.id, { amount: 300 });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    const firstBody = (await first.json()) as { refundId: string };
    const retryBody = (await retry.json()) as { refundId: string; replayed: boolean };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.refundId).toBe(firstBody.refundId);

    expect(refundCalls).toHaveLength(1);
    expect(await db.select().from(paymentAuditLog)).toHaveLength(1);
    expect(refundConfirmationEmailCalls).toHaveLength(1);
  });

  test("409s reusing a key for a refund with a different amount", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();

    expect((await refundReq(purchase.id, { amount: 300 })).status).toBe(200);
    const res = await refundReq(purchase.id, { amount: 400 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("idempotency key");
    expect(refundCalls).toHaveLength(1);
  });

  test("422s a refund Stripe accepted but that failed, and writes no audit row or email", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();
    newRefundStatus = "failed";

    const res = await refundReq(purchase.id);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { data: { failureReason: string } };
    expect(body.data.failureReason).toBe("expired_or_canceled_card");
    expect(await db.select().from(paymentAuditLog)).toHaveLength(0);
    expect(refundConfirmationEmailCalls).toHaveLength(0);
  });

  test("retrying a refund that has since failed reports the failure, not a cached success", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();
    // Stripe accepts it as pending, so the first response is a success...
    newRefundStatus = "pending";
    const first = await refundReq(purchase.id, { amount: 300 });
    expect(first.status).toBe(200);
    const { refundId } = (await first.json()) as { refundId: string };

    // ...then the refund fails. A replay of the same key would still return the pending refund
    refundsById[refundId]!.status = "failed";
    const retry = await refundReq(purchase.id, { amount: 300 });
    expect(retry.status).toBe(422);

    // a new key is a new refund attempt, and goes through
    newRefundStatus = "succeeded";
    const fresh = await refundReq(purchase.id, { amount: 300, idempotencyKey: "refund-form-2" });
    expect(fresh.status).toBe(200);
    expect(refundCalls).toHaveLength(2);
  });

  test("a failing confirmation email doesn't fail the refund response", async () => {
    const { purchase } = await seedRefundablePurchase();
    await asAdmin();
    refundConfirmationEmailFails = true;

    const res = await refundReq(purchase.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("refunded");
  });
});
