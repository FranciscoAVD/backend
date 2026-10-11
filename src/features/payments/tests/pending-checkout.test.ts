import { describe, expect, test, beforeEach } from "bun:test";
import {
  savePendingCheckout,
  getPendingCheckout,
  markProcessing,
  removePendingCheckout,
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
