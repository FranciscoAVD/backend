import { describe, expect, test, beforeEach } from "bun:test";
import {
  savePendingCheckout,
  getPendingCheckout,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
  hasActivePendingCheckout,
  PENDING_CHECKOUT_TTL_SEC,
} from "@f/payments/lib/pending-checkout";
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
