import { describe, expect, test, beforeEach } from "bun:test";
import {
  savePendingCheckout,
  getPendingCheckout,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
  hasActivePendingCheckout,
  reservePendingCheckout,
  releaseReservation,
  getResumableCheckout,
  PENDING_CHECKOUT_TTL_SEC,
  PROCESSING_TTL_SEC,
  RESERVATION_TTL_SEC,
} from "@f/payments/lib/state/pending-checkout";
import { redis } from "@/lib/redis";
import { resetRedis } from "@/test-helpers/redis";

describe("savePendingCheckout / getPendingCheckout", () => {
  beforeEach(resetRedis);

  test("round-trips a pending checkout", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    const res = await getPendingCheckout("cs_1");
    expect(res).toEqual({ userId: "u1", planId: 1, status: "open" });
  });

  test("returns null for a session with no pending entry", async () => {
    const res = await getPendingCheckout("cs_nonexistent");
    expect(res).toBeNull();
  });
});

describe("markProcessing", () => {
  beforeEach(resetRedis);

  test("flips status to processing and keeps the rest of the data", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    const ok = await markProcessing("cs_1");
    expect(ok).toBe(true);

    const res = await getPendingCheckout("cs_1");
    expect(res).toEqual({ userId: "u1", planId: 1, status: "processing" });
  });

  test("returns false when there's no pending entry to update", async () => {
    const ok = await markProcessing("cs_nonexistent");
    expect(ok).toBe(false);
  });
});

describe("markFailed / markExpired", () => {
  beforeEach(resetRedis);

  test("markFailed flips status to failed and keeps the rest of the data", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    const ok = await markFailed("cs_1");
    expect(ok).toBe(true);
    expect(await getPendingCheckout("cs_1")).toEqual({
      userId: "u1",
      planId: 1,
      status: "failed",
    });
  });

  test("markExpired flips status to expired and keeps the rest of the data", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    const ok = await markExpired("cs_1");
    expect(ok).toBe(true);
    expect(await getPendingCheckout("cs_1")).toEqual({
      userId: "u1",
      planId: 1,
      status: "expired",
    });
  });

  test("markFailed/markExpired return false when there's no pending entry to update", async () => {
    expect(await markFailed("cs_nonexistent")).toBe(false);
    expect(await markExpired("cs_nonexistent")).toBe(false);
  });

  test("markFailed immediately frees the (user, plan) slot, not just after the TTL", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);

    await markFailed("cs_1");

    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);
  });

  test("markExpired immediately frees the (user, plan) slot, not just after the TTL", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);

    await markExpired("cs_1");

    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);
  });
});

describe("forward-only status transitions", () => {
  beforeEach(resetRedis);

  test("a retried/out-of-order markProcessing after markFailed doesn't resurrect the checkout", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await markFailed("cs_1");

    const ok = await markProcessing("cs_1");

    expect(ok).toBe(false);
    expect((await getPendingCheckout("cs_1"))?.status).toBe("failed");
    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);
  });

  test("a retried markFailed for an old session doesn't erase a newer session's pointer", async () => {
    await savePendingCheckout(
      "cs_A",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await markFailed("cs_A");

    // user starts a new checkout for the same (user, plan) after A failed
    await savePendingCheckout(
      "cs_B",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    // Stripe retries A's already-processed async_payment_failed event
    await markFailed("cs_A");

    expect((await getPendingCheckout("cs_B"))?.status).toBe("open");
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
  });
});

describe("removePendingCheckout", () => {
  beforeEach(resetRedis);

  test("deletes the entry", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await removePendingCheckout("cs_1");

    const res = await getPendingCheckout("cs_1");
    expect(res).toBeNull();
  });

  test("is a no-op when there's no entry", async () => {
    const result = await removePendingCheckout("cs_nonexistent");
    expect(result).toBeUndefined();
  });
});

describe("hasActivePendingCheckout", () => {
  beforeEach(resetRedis);

  test("true for an open checkout, false once there's none", async () => {
    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);

    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);

    await removePendingCheckout("cs_1");
    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);
  });

  test("stays true once the checkout moves to processing", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await markProcessing("cs_1");

    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
  });

  test("a second checkout for a different plan doesn't block the first plan's slot", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    expect(await hasActivePendingCheckout("u1", 2)).toBe(false);
  });

  test("removing an older, already-superseded session doesn't clear a newer pointer", async () => {
    await savePendingCheckout(
      "cs_old",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    // a second checkout for the same (user, plan) started later, overwriting the pointer
    await savePendingCheckout(
      "cs_new",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    // the older session's own cleanup must not clobber the pointer now pointing at the newer one
    await removePendingCheckout("cs_old");

    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
  });
});

describe("markProcessing keeps the (user, plan) slot held", () => {
  beforeEach(resetRedis);

  test("extends the pointer's TTL to match the processing entry, not just the entry's own", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await markProcessing("cs_1");

    // both keys must outlive the original 24h, or the guard stops seeing a checkout
    // that can still settle for up to 14 days
    expect(await redis.ttl("checkout:cs_1")).toBeGreaterThan(PENDING_CHECKOUT_TTL_SEC);
    expect(await redis.ttl("checkout:active:u1:1")).toBeGreaterThan(PENDING_CHECKOUT_TTL_SEC);
    expect(await redis.ttl("checkout:active:u1:1")).toBeLessThanOrEqual(PROCESSING_TTL_SEC);
  });

  test("restores the pointer if it was already gone, since the session still holds the slot", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await redis.del("checkout:active:u1:1");

    await markProcessing("cs_1");

    expect(await redis.get("checkout:active:u1:1")).toBe("cs_1");
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
  });

  test("doesn't take the pointer back from a newer session that holds it", async () => {
    await savePendingCheckout(
      "cs_old",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await savePendingCheckout(
      "cs_new",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await markProcessing("cs_old");

    expect(await redis.get("checkout:active:u1:1")).toBe("cs_new");
    expect(await redis.ttl("checkout:active:u1:1")).toBeLessThanOrEqual(PENDING_CHECKOUT_TTL_SEC);
  });
});

describe("reservePendingCheckout / releaseReservation", () => {
  beforeEach(resetRedis);

  test("claims a free slot, and the claim blocks the guard while it's held", async () => {
    const token = await reservePendingCheckout("u1", 1);

    expect(token).not.toBeNull();
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
    expect(await redis.ttl("checkout:active:u1:1")).toBeLessThanOrEqual(RESERVATION_TTL_SEC);
  });

  test("only one of many concurrent reservations for the same slot succeeds", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => reservePendingCheckout("u1", 1)),
    );

    expect(tokens.filter((t) => t !== null)).toHaveLength(1);
  });

  test("reservations for different plans or users don't block each other", async () => {
    expect(await reservePendingCheckout("u1", 1)).not.toBeNull();
    expect(await reservePendingCheckout("u1", 2)).not.toBeNull();
    expect(await reservePendingCheckout("u2", 1)).not.toBeNull();
  });

  test("is refused while an open checkout holds the slot", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    expect(await reservePendingCheckout("u1", 1)).toBeNull();
  });

  test("clears a stale pointer (its session's key already expired) and claims the slot", async () => {
    await savePendingCheckout(
      "cs_gone",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await redis.del("checkout:cs_gone");

    expect(await reservePendingCheckout("u1", 1)).not.toBeNull();
  });

  test("claims the slot once the previous checkout failed", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await markFailed("cs_1");

    expect(await reservePendingCheckout("u1", 1)).not.toBeNull();
  });

  test("saving the session replaces the reservation with the real session id", async () => {
    await reservePendingCheckout("u1", 1);
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    expect(await redis.get("checkout:active:u1:1")).toBe("cs_1");
    expect(await hasActivePendingCheckout("u1", 1)).toBe(true);
  });

  test("releasing frees the slot for the next attempt", async () => {
    const token = (await reservePendingCheckout("u1", 1))!;

    await releaseReservation("u1", 1, token);

    expect(await hasActivePendingCheckout("u1", 1)).toBe(false);
    expect(await reservePendingCheckout("u1", 1)).not.toBeNull();
  });

  test("releasing a reservation that's since been replaced leaves the newer pointer alone", async () => {
    const token = (await reservePendingCheckout("u1", 1))!;
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );

    await releaseReservation("u1", 1, token);

    expect(await redis.get("checkout:active:u1:1")).toBe("cs_1");
  });
});

describe("transition atomicity", () => {
  beforeEach(resetRedis);

  test("concurrent events for one session never move its status backward", async () => {
    // markFailed (rank 2) racing markProcessing (rank 1): whichever lands first, the result
    // must be failed - as a separate read then write, both could read `open` and processing
    // could write last
    for (let i = 0; i < 50; i++) {
      const sessionId = `cs_race_${i}`;
      await savePendingCheckout(
        sessionId,
        { userId: "u1", planId: i, status: "open" },
        PENDING_CHECKOUT_TTL_SEC,
      );

      await Promise.all([markFailed(sessionId), markProcessing(sessionId)]);

      expect((await getPendingCheckout(sessionId))?.status).toBe("failed");
    }
  });
});

describe("getResumableCheckout", () => {
  beforeEach(resetRedis);

  const url = "https://checkout.stripe.com/c/cs_1";

  test("returns the open session holding the (user, plan) slot", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open", url },
      PENDING_CHECKOUT_TTL_SEC,
    );

    expect(await getResumableCheckout("u1", 1)).toEqual({ sessionId: "cs_1", url });
  });

  test("nothing to resume when the slot is free, or held by another plan's checkout", async () => {
    expect(await getResumableCheckout("u1", 1)).toBeNull();

    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 2, status: "open", url },
      PENDING_CHECKOUT_TTL_SEC,
    );
    expect(await getResumableCheckout("u1", 1)).toBeNull();
  });

  test("not resumable once processing (already paid), and the url survives the transition", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open", url },
      PENDING_CHECKOUT_TTL_SEC,
    );
    await markProcessing("cs_1");

    expect(await getResumableCheckout("u1", 1)).toBeNull();
    expect((await getPendingCheckout("cs_1"))?.url).toBe(url);
  });

  test("not resumable while a reservation (no session yet) holds the slot", async () => {
    expect(await reservePendingCheckout("u1", 1)).not.toBeNull();
    expect(await getResumableCheckout("u1", 1)).toBeNull();
  });

  test("not resumable for an entry written before urls were stored", async () => {
    await savePendingCheckout(
      "cs_1",
      { userId: "u1", planId: 1, status: "open" },
      PENDING_CHECKOUT_TTL_SEC,
    );
    expect(await getResumableCheckout("u1", 1)).toBeNull();
  });
});

describe("savePendingCheckout with a reservation", () => {
  beforeEach(resetRedis);
  const pointer = "checkout:active:u1:1";
  const data = { userId: "u1", planId: 1, status: "open" as const };

  test("replaces the reservation it still holds with the session", async () => {
    const token = await reservePendingCheckout("u1", 1);

    expect(await savePendingCheckout("cs_1", data, PENDING_CHECKOUT_TTL_SEC, token!)).toBe(true);
    expect(await redis.get(pointer)).toBe("cs_1");
    expect(await getPendingCheckout("cs_1")).toEqual(data);
  });

  test("writes nothing once the reservation lapsed and someone else took the slot", async () => {
    const token = await reservePendingCheckout("u1", 1);
    await redis.del(pointer);
    const other = await reservePendingCheckout("u1", 1);

    expect(await savePendingCheckout("cs_1", data, PENDING_CHECKOUT_TTL_SEC, token!)).toBe(false);
    expect(await redis.get(pointer)).toBe(other!);
    expect(await getPendingCheckout("cs_1")).toBeNull();
  });

  test("writes nothing once the reservation lapsed, even with the slot left free", async () => {
    const token = await reservePendingCheckout("u1", 1);
    await redis.del(pointer);

    expect(await savePendingCheckout("cs_1", data, PENDING_CHECKOUT_TTL_SEC, token!)).toBe(false);
    expect(await redis.get(pointer)).toBeNull();
  });

  test("outlasts two Stripe calls at the client's worst case", async () => {
    const { STRIPE_TIMEOUT_MS, STRIPE_MAX_NETWORK_RETRIES } = await import(
      "@f/payments/lib/constants"
    );
    const worstCaseMs = 2 * STRIPE_TIMEOUT_MS * (1 + STRIPE_MAX_NETWORK_RETRIES);
    expect(RESERVATION_TTL_SEC * 1000).toBeGreaterThan(worstCaseMs);
  });
});
