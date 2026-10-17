import { describe, expect, test, beforeEach } from "bun:test";
import { paymentsRepo } from "@f/payments/repo";
import {
  PENDING_CHECKOUT_TTL_SEC,
  PROCESSING_TTL_SEC,
  RESERVATION_TTL_SEC,
  CHECKOUT_TRANSITIONS_FROM,
} from "@f/payments/lib/constants";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import { eq } from "drizzle-orm";

const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000);

let userId: string;
let otherUserId: string;
let planId: number;
let otherPlanId: number;

beforeEach(async () => {
  await resetDb();
  userId = await seedUser();
  otherUserId = await seedUser();
  planId = (await seedPlan()).id;
  otherPlanId = (await seedPlan()).id;
});

/** A claim exactly as `services.checkout.start` makes one. */
const claim = (user = userId, plan = planId) =>
  paymentsRepo.checkout.claim(
    { userId: user },
    { planId: plan, expiresAt: expiresIn(RESERVATION_TTL_SEC) },
  );

/** Opening a claimed row exactly as `createCheckout` does, per plan repeatability. */
const open = (
  id: number,
  sessionId: string,
  options: { repeatable?: boolean; url?: string | null } = {},
) =>
  paymentsRepo.checkout.open(
    { id },
    {
      stripeCheckoutSessionId: sessionId,
      url: "url" in options ? options.url : `https://checkout.stripe.com/c/${sessionId}`,
      slot: options.repeatable ? null : 1,
      expiresAt: expiresIn(PENDING_CHECKOUT_TTL_SEC),
    },
  );

const transition = (
  sessionId: string,
  status: keyof typeof CHECKOUT_TRANSITIONS_FROM,
  expiresAt?: Date,
) =>
  paymentsRepo.checkout.transition({ stripeCheckoutSessionId: sessionId }, status, {
    from: CHECKOUT_TRANSITIONS_FROM[status],
    expiresAt,
  });

const statusOf = async (sessionId: string) =>
  (await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: sessionId }))
    ?.status ?? null;

/** Backdates a row's deadline, standing in for a request that died or a webhook that never came. */
const backdate = (id: number) =>
  db
    .update(checkoutTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(checkoutTable.id, id));

describe("claimCheckoutSlot", () => {
  test("claims a free slot as a reserving row with no session yet", async () => {
    const claimed = await claim();

    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({
      userId,
      planId,
      status: "reserving",
      slot: 1,
      stripeCheckoutSessionId: null,
      url: null,
    });
  });

  test("is refused while another claim holds the slot", async () => {
    expect(await claim()).not.toBeNull();
    expect(await claim()).toBeNull();
  });

  test("is refused while an open checkout holds the slot", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");

    expect(await claim()).toBeNull();
  });

  test("is refused while a processing checkout holds the slot", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");
    await transition("cs_1", "processing", expiresIn(PROCESSING_TTL_SEC));

    expect(await claim()).toBeNull();
  });

  test("only one of many concurrent claims for the same slot succeeds", async () => {
    const claims = await Promise.all(Array.from({ length: 20 }, () => claim()));

    expect(claims.filter((c) => c !== null)).toHaveLength(1);
  });

  test("claims for different plans or users don't block each other", async () => {
    expect(await claim(userId, planId)).not.toBeNull();
    expect(await claim(userId, otherPlanId)).not.toBeNull();
    expect(await claim(otherUserId, planId)).not.toBeNull();
  });

  test("sweeps a reservation left behind by a dead request and claims the slot", async () => {
    const stale = await claim();
    await backdate(stale!.id);

    const claimed = await claim();

    expect(claimed).not.toBeNull();
    expect(claimed!.id).not.toBe(stale!.id);
    const [row] = await db
      .select()
      .from(checkoutTable)
      .where(eq(checkoutTable.id, stale!.id));
    expect(row!.status).toBe("expired");
  });

  test("sweeps an open checkout whose expiry webhook never landed", async () => {
    const stale = await claim();
    await open(stale!.id, "cs_1");
    await backdate(stale!.id);

    expect(await claim()).not.toBeNull();
    expect(await statusOf("cs_1")).toBe("expired");
  });

  test("claims the slot once the previous checkout reached a terminal status", async () => {
    for (const status of ["failed", "expired", "completed"] as const) {
      const claimed = await claim();
      await open(claimed!.id, `cs_${status}`);
      await transition(`cs_${status}`, status);

      expect(await claim()).not.toBeNull();
      // leave the slot free for the next round
      await db.delete(checkoutTable).where(eq(checkoutTable.status, "reserving"));
    }
  });
});

describe("openCheckout", () => {
  test("stores the session and url, and keeps the slot for a non-repeatable plan", async () => {
    const claimed = await claim();

    expect(await open(claimed!.id, "cs_1")).toEqual({ id: claimed!.id });

    const row = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    });
    expect(row).toMatchObject({
      status: "open",
      slot: 1,
      url: "https://checkout.stripe.com/c/cs_1",
    });
    expect(row!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + (PENDING_CHECKOUT_TTL_SEC - 60) * 1000,
    );
  });

  test("releases the slot for a repeatable plan, so the next purchase isn't blocked", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1", { repeatable: true });

    const row = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    });
    expect(row).toMatchObject({ status: "open", slot: null });
    expect(await claim()).not.toBeNull();
  });

  test("writes nothing once the reservation was swept and the slot reclaimed", async () => {
    const lapsed = await claim();
    await backdate(lapsed!.id);
    const other = await claim();

    expect(await open(lapsed!.id, "cs_lost")).toBeNull();
    expect(await statusOf("cs_lost")).toBeNull();
    const [row] = await db
      .select()
      .from(checkoutTable)
      .where(eq(checkoutTable.id, other!.id));
    expect(row!.status).toBe("reserving");
  });

  test("outlasts two Stripe calls at the client's worst case", async () => {
    const { STRIPE_TIMEOUT_MS, STRIPE_MAX_NETWORK_RETRIES } = await import(
      "@f/payments/lib/constants"
    );
    const worstCaseMs = 2 * STRIPE_TIMEOUT_MS * (1 + STRIPE_MAX_NETWORK_RETRIES);
    expect(RESERVATION_TTL_SEC * 1000).toBeGreaterThan(worstCaseMs);
  });
});

describe("releaseCheckoutReservation", () => {
  test("frees the slot for the next attempt", async () => {
    const claimed = await claim();

    expect(await paymentsRepo.checkout.release(claimed!)).toEqual({ id: claimed!.id });
    expect(await claim()).not.toBeNull();
  });

  test("leaves an already-opened row alone - the happy path's release is a no-op", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");

    expect(await paymentsRepo.checkout.release(claimed!)).toBeNull();
    expect(await statusOf("cs_1")).toBe("open");
  });
});

describe("transitionCheckout", () => {
  test("returns null when there's no checkout for the session", async () => {
    expect(await transition("cs_nonexistent", "processing")).toBeNull();
    expect(await transition("cs_nonexistent", "failed")).toBeNull();
    expect(await transition("cs_nonexistent", "expired")).toBeNull();
  });

  test("processing holds the slot and extends the deadline past the open window", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");

    expect(await transition("cs_1", "processing", expiresIn(PROCESSING_TTL_SEC))).toEqual({
      id: claimed!.id,
    });

    const row = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    });
    expect(row!.status).toBe("processing");
    // must outlive the original 24h, or the slot stops blocking a checkout that can
    // still settle for up to 14 days
    expect(row!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + PENDING_CHECKOUT_TTL_SEC * 1000,
    );
  });

  test("each terminal status frees the slot immediately, not just at the deadline", async () => {
    for (const status of ["failed", "expired", "completed"] as const) {
      await resetDb();
      userId = await seedUser();
      planId = (await seedPlan()).id;

      const claimed = await claim();
      await open(claimed!.id, "cs_1");
      expect(await claim()).toBeNull();

      expect(await transition("cs_1", status)).toEqual({ id: claimed!.id });
      expect(await claim()).not.toBeNull();
    }
  });

  test("a terminal transition keeps the row's existing deadline", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");
    const before = (await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    }))!.expiresAt;

    await transition("cs_1", "failed");

    const after = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    });
    expect(after!.expiresAt).toEqual(before);
  });
});

describe("forward-only status transitions", () => {
  const openOne = async (sessionId: string) => {
    const claimed = await claim();
    await open(claimed!.id, sessionId);
  };

  test("a retried/out-of-order processing after failed doesn't resurrect the checkout", async () => {
    await openOne("cs_1");
    await transition("cs_1", "failed");

    expect(await transition("cs_1", "processing")).toBeNull();
    expect(await statusOf("cs_1")).toBe("failed");
  });

  test("failed and expired can't flip into each other", async () => {
    await openOne("cs_failed");
    await transition("cs_failed", "failed");
    expect(await transition("cs_failed", "expired")).toBeNull();
    expect(await statusOf("cs_failed")).toBe("failed");

    await openOne("cs_expired");
    await transition("cs_expired", "expired");
    expect(await transition("cs_expired", "failed")).toBeNull();
    expect(await statusOf("cs_expired")).toBe("expired");
  });

  test("a completed checkout can't be moved anywhere", async () => {
    await openOne("cs_1");
    await transition("cs_1", "completed");

    expect(await transition("cs_1", "processing")).toBeNull();
    expect(await transition("cs_1", "failed")).toBeNull();
    expect(await transition("cs_1", "expired")).toBeNull();
    expect(await statusOf("cs_1")).toBe("completed");
  });

  test("a retried transition for an old session leaves a newer one alone", async () => {
    await openOne("cs_A");
    await transition("cs_A", "failed");
    // the user starts a new checkout for the same (user, plan) once A failed
    await openOne("cs_B");

    // Stripe retries A's already-processed async_payment_failed event
    await transition("cs_A", "failed");

    expect(await statusOf("cs_B")).toBe("open");
    expect(await claim()).toBeNull();
  });

  test("concurrent events for one session never move its status backward", async () => {
    // failed racing processing: whichever lands first, the result must be failed - as a separate
    // read then write, both could read `open` and processing could write last
    for (let i = 0; i < 50; i++) {
      const sessionId = `cs_race_${i}`;
      const claimed = await claim(userId, i % 2 === 0 ? planId : otherPlanId);
      await open(claimed!.id, sessionId);

      await Promise.all([transition(sessionId, "failed"), transition(sessionId, "processing")]);

      expect(await statusOf(sessionId)).toBe("failed");
      await db.delete(checkoutTable).where(eq(checkoutTable.id, claimed!.id));
    }
  });
});

describe("getResumableCheckout", () => {
  test("returns the user's own open session for the plan", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toEqual({
      stripeCheckoutSessionId: "cs_1",
      url: "https://checkout.stripe.com/c/cs_1",
    });
  });

  test("nothing to resume when the slot is free, or held for another plan or user", async () => {
    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();

    const claimed = await claim(userId, otherPlanId);
    await open(claimed!.id, "cs_1");

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();
    expect(
      await paymentsRepo.checkout.get.resumable({ userId: otherUserId, planId: otherPlanId }),
    ).toBeNull();
  });

  test("not resumable while only reserved - there's no session yet", async () => {
    await claim();

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();
  });

  test("not resumable once processing (already paid), and the url survives the transition", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");
    await transition("cs_1", "processing", expiresIn(PROCESSING_TTL_SEC));

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();
    const row = await paymentsRepo.checkout.get.bySession({
      stripeCheckoutSessionId: "cs_1",
    });
    expect(row!.url).toBe("https://checkout.stripe.com/c/cs_1");
  });

  test("not resumable once the session's own deadline has passed", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1");
    await backdate(claimed!.id);

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();
  });

  test("not resumable with no url stored", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1", { url: null });

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toBeNull();
  });

  test("a repeatable plan's open session is still resumable after releasing the slot", async () => {
    const claimed = await claim();
    await open(claimed!.id, "cs_1", { repeatable: true });

    expect(await paymentsRepo.checkout.get.resumable({ userId, planId })).toEqual({
      stripeCheckoutSessionId: "cs_1",
      url: "https://checkout.stripe.com/c/cs_1",
    });
  });
});

describe("getCheckoutBySession", () => {
  test("returns null for a session no checkout was ever recorded for", async () => {
    expect(
      await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: "cs_nope" }),
    ).toBeNull();
  });
});
