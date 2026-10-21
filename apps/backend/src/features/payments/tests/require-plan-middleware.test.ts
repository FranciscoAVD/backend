import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { requestId } from "hono/request-id";
import { pinoLogger } from "hono-pino";
import pino from "pino";
import { resetDb, seedUser, seedPlan, seedSubscription } from "@backend/test-helpers/db";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
import {
  requireActivePlansMiddleware,
  requirePlanMiddleware,
} from "@backend/f/payments/middleware";
import type { Payment } from "@backend/f/payments/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

let sessionCounter = 0;
async function buy(userId: string, plan: Payment.Plan, purchasedAt = new Date()) {
  const id = ++sessionCounter;
  return addPurchase(
    { userId },
    {
      planId: plan.id,
      stripeCheckoutSessionId: `cs_guard_${id}`,
      stripePaymentIntentId: `pi_guard_${id}`,
      amountTotal: plan.amount,
      currency: plan.currency,
    },
    { durationDays: plan.durationDays },
    purchasedAt,
  );
}

// the signed-in user for the next request; null means no session at all
let currentUserId: string | null = null;
// every log line the guard writes, parsed
let logs: { level: number; msg: string; [key: string]: unknown }[] = [];

const fakeSession = createMiddleware<{ Variables: { session: unknown } }>(async (c, next) => {
  c.set("session", currentUserId ? { user: { id: currentUserId } } : null);
  await next();
});

const seatsAtLeast = (n: number) =>
  requireActivePlansMiddleware((plans) =>
    plans.some((plan) => typeof plan.limits?.seats === "number" && plan.limits.seats >= n),
  );

const app = new Hono()
  .use(requestId())
  .use(
    pinoLogger({
      pino: pino({ level: "debug" }, { write: (line: string) => void logs.push(JSON.parse(line)) }),
    }),
  )
  .use(fakeSession)
  .get("/pro", requirePlanMiddleware("PRO"), (c) =>
    c.json({ plans: c.get("activePlans").map((plan) => plan.name) }),
  )
  .get("/pro-or-pass", requirePlanMiddleware("Pro", "Pass"), (c) => c.json({ ok: true }))
  .get("/typo", requirePlanMiddleware("Por"), (c) => c.json({ ok: true }))
  .get("/team", seatsAtLeast(3), (c) => c.json({ ok: true }))
  .get(
    "/throws",
    requireActivePlansMiddleware(() => {
      throw new Error("check blew up");
    }),
    (c) => c.json({ ok: true }),
  )
  .get(
    "/truthy",
    // a check that returns something truthy but not `true` (e.g. a forgotten comparison) is a
    // bug in the check - the guard must deny rather than let it through
    requireActivePlansMiddleware((plans) => plans.length as unknown as boolean),
    (c) => c.json({ ok: true }),
  );

const get = (path: string) => app.request(path);
const logged = (msg: string) => logs.filter((line) => line.msg === msg);

describe("requirePlanMiddleware", () => {
  beforeEach(async () => {
    await resetDb();
    currentUserId = null;
    logs = [];
  });

  test("lets a subscriber through, matching the plan name case-insensitively", async () => {
    currentUserId = await seedUser();
    await seedPlan({ name: "Pro", type: "recurring", interval: "month" });
    await seedSubscription({ referenceId: currentUserId, plan: "pro", status: "active" });

    const res = await get("/pro");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plans: ["Pro"] });
  });

  test("lets a one-time buyer through while the purchase's window covers now", async () => {
    currentUserId = await seedUser();
    const pass = await seedPlan({ name: "Pass", durationDays: 30 });
    await buy(currentUserId, pass, daysAgo(1));

    expect((await get("/pro-or-pass")).status).toBe(200);
  });

  test("denies with PLAN_REQUIRED when the user has no matching plan", async () => {
    currentUserId = await seedUser();
    await seedPlan({ name: "Pro", type: "recurring", interval: "month" });
    const pass = await seedPlan({ name: "Pass" });
    await buy(currentUserId, pass);

    const res = await get("/pro");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "An active plan is required.",
      code: "PLAN_REQUIRED",
    });
    expect(logged("payments.require_plan.unknown_plan")).toEqual([]);
  });

  test("denies once the purchase has expired, or the subscription has ended", async () => {
    currentUserId = await seedUser();
    const pass = await seedPlan({ name: "Pass", durationDays: 7 });
    await buy(currentUserId, pass, daysAgo(10));
    await seedPlan({ name: "Pro", type: "recurring", interval: "month" });
    await seedSubscription({ referenceId: currentUserId, plan: "Pro", status: "canceled" });

    expect((await get("/pro-or-pass")).status).toBe(403);
  });

  test("logs an error when a required plan doesn't exist, and still denies", async () => {
    currentUserId = await seedUser();
    await seedPlan({ name: "Pro", type: "recurring", interval: "month" });
    await seedSubscription({ referenceId: currentUserId, plan: "Pro", status: "active" });

    const res = await get("/typo");

    expect(res.status).toBe(403);
    expect(logged("payments.require_plan.unknown_plan").map((line) => line.plans)).toEqual([
      ["Por"],
    ]);
  });

  test("answers 401 if no session reached it", async () => {
    expect((await get("/pro")).status).toBe(401);
  });
});

describe("requireActivePlansMiddleware", () => {
  beforeEach(async () => {
    await resetDb();
    currentUserId = null;
    logs = [];
  });

  test("gates on the plans' limits", async () => {
    const small = await seedPlan({ name: "Small", limits: { seats: 2 } });
    const team = await seedPlan({ name: "Team", limits: { seats: 5 } });

    currentUserId = await seedUser();
    await buy(currentUserId, small);
    expect((await get("/team")).status).toBe(403);

    await buy(currentUserId, team);
    expect((await get("/team")).status).toBe(200);
  });

  test("fails closed with a 500 and a log line when the check throws", async () => {
    currentUserId = await seedUser();

    const res = await get("/throws");

    expect(res.status).toBe(500);
    expect(logged("payments.require_plan")).toHaveLength(1);
  });

  test("denies when the check returns something truthy that isn't true", async () => {
    currentUserId = await seedUser();
    await buy(currentUserId, await seedPlan({ name: "Pass" }));

    expect((await get("/truthy")).status).toBe(403);
  });
});
