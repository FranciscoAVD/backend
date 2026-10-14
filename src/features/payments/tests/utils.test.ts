import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  isCheckoutSessionId,
  isAllowedEvent,
  purchaseUpdateFromCharge,
  purchaseStatusFromDispute,
  encodeOverlapping,
  decodeOverlapping,
  encodeDurationDays,
  decodeDurationDays,
  isPurchaseAccessActive,
} from "@f/payments/lib/utils";

describe("isCheckoutSessionId", () => {
  test("accepts a value with the cs_ prefix", () => {
    expect(isCheckoutSessionId("cs_test_abc123")).toBe(true);
  });

  test("rejects a value without the prefix", () => {
    expect(isCheckoutSessionId("pi_test_abc123")).toBe(false);
  });

  test("rejects the bare prefix with nothing after it", () => {
    expect(isCheckoutSessionId("cs_")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isCheckoutSessionId(123)).toBe(false);
    expect(isCheckoutSessionId(undefined)).toBe(false);
    expect(isCheckoutSessionId(null)).toBe(false);
  });
});

describe("isAllowedEvent", () => {
  test("accepts an event type listed in ALLOWED_EVENTS", () => {
    const event = { type: "checkout.session.completed" } as unknown as Stripe.Event;
    expect(isAllowedEvent(event)).toBe(true);
  });

  test("rejects an event type not listed in ALLOWED_EVENTS", () => {
    const event = { type: "customer.created" } as unknown as Stripe.Event;
    expect(isAllowedEvent(event)).toBe(false);
  });
});

describe("purchaseUpdateFromCharge", () => {
  test("a fully refunded charge maps to status refunded", () => {
    expect(
      purchaseUpdateFromCharge({ amount_refunded: 1000, refunded: true }),
    ).toEqual({ amountRefunded: 1000, status: "refunded" });
  });

  test("a partially refunded charge stays paid", () => {
    expect(
      purchaseUpdateFromCharge({ amount_refunded: 500, refunded: false }),
    ).toEqual({ amountRefunded: 500, status: "paid" });
  });

  test("an unrefunded charge stays paid with 0 refunded", () => {
    expect(
      purchaseUpdateFromCharge({ amount_refunded: 0, refunded: false }),
    ).toEqual({ amountRefunded: 0, status: "paid" });
  });
});

describe("purchaseStatusFromDispute", () => {
  test("a lost dispute returns the money", () => {
    expect(purchaseStatusFromDispute({ status: "lost" })).toBe("refunded");
  });

  test("a dispute won in our favor stays paid", () => {
    expect(purchaseStatusFromDispute({ status: "won" })).toBe("paid");
  });

  test("a warning_closed dispute stays paid", () => {
    expect(purchaseStatusFromDispute({ status: "warning_closed" })).toBe(
      "paid",
    );
  });

  test("a prevented dispute stays paid", () => {
    expect(purchaseStatusFromDispute({ status: "prevented" })).toBe("paid");
  });

  test("an open dispute is disputed", () => {
    expect(purchaseStatusFromDispute({ status: "needs_response" })).toBe(
      "disputed",
    );
  });
});

describe("encodeOverlapping / decodeOverlapping", () => {
  test("round-trips both values", () => {
    expect(decodeOverlapping(encodeOverlapping(true))).toEqual({ overlapping: true });
    expect(decodeOverlapping(encodeOverlapping(false))).toEqual({ overlapping: false });
  });

  test.each([undefined, "", "yes", "1", "TRUE"])(
    "returns undefined with no valid snapshot, so the caller falls back: %p",
    (value) => {
      expect(decodeOverlapping(value)).toBeUndefined();
    },
  );
});

describe("encodeDurationDays / decodeDurationDays", () => {
  test("round-trips a duration", () => {
    expect(decodeDurationDays(encodeDurationDays(30))).toEqual({ durationDays: 30 });
  });

  test("round-trips 'never expires' as an explicit value, not a missing one", () => {
    expect(encodeDurationDays(null)).toBe("none");
    expect(decodeDurationDays(encodeDurationDays(null))).toEqual({ durationDays: null });
  });

  test("returns undefined when there's no snapshot, so the caller falls back", () => {
    expect(decodeDurationDays(undefined)).toBeUndefined();
  });

  test.each(["", "0", "-5", "1.5", "abc", "30days", "007"])(
    "returns undefined for a malformed value: %p",
    (value) => {
      expect(decodeDurationDays(value)).toBeUndefined();
    },
  );
});

describe("isPurchaseAccessActive", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-06-01T00:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  const purchase = (startDays: number, durationDays: number | null) => ({
    createdAt: at(startDays),
    durationDays,
    expiresAt: durationDays == null ? null : at(startDays + durationDays),
  });

  test("overlapping: any purchase still inside its own window grants access", () => {
    expect(isPurchaseAccessActive([purchase(-40, 30), purchase(-5, 30)], { overlapping: true }, now)).toBe(true);
    expect(isPurchaseAccessActive([purchase(-40, 30), purchase(-35, 30)], { overlapping: true }, now)).toBe(false);
  });

  test("non-overlapping: a later purchase extends from where the earlier one ends", () => {
    // -40..-10, then chained -10..+20
    expect(isPurchaseAccessActive([purchase(-40, 30), purchase(-35, 30)], { overlapping: false }, now)).toBe(true);
  });

  test("non-overlapping: a gap between purchases isn't backfilled", () => {
    // -100..-70, gap, then -60..-30: lapsed
    expect(isPurchaseAccessActive([purchase(-100, 30), purchase(-60, 30)], { overlapping: false }, now)).toBe(false);
  });

  test("a never-expiring purchase grants access either way", () => {
    expect(isPurchaseAccessActive([purchase(-400, null)], { overlapping: true }, now)).toBe(true);
    expect(isPurchaseAccessActive([purchase(-400, null)], { overlapping: false }, now)).toBe(true);
  });

  // each purchase follows the rule it was sold under, whatever the plan says now
  const snap = (startDays: number, durationDays: number, overlapping: boolean) => ({
    ...purchase(startDays, durationDays),
    overlapping,
  });

  test("purchases snapshotted as chained keep chaining after the plan flips to overlapping", () => {
    // -40..-10, chained -10..+20 - read as concurrent this would have lapsed at -5
    expect(
      isPurchaseAccessActive([snap(-40, 30, false), snap(-35, 30, false)], { overlapping: true }, now),
    ).toBe(true);
  });

  test("purchases snapshotted as overlapping stay concurrent after the plan flips to chained", () => {
    // both lapsed (-10, -5) - read as chained, the second would wrongly run until +20
    expect(
      isPurchaseAccessActive([snap(-40, 30, true), snap(-35, 30, true)], { overlapping: false }, now),
    ).toBe(false);
  });

  test("a chained purchase chains after an earlier overlapping one's window", () => {
    expect(
      isPurchaseAccessActive([snap(-40, 30, true), snap(-35, 30, false)], { overlapping: true }, now),
    ).toBe(true);
  });

  test("a row without a snapshot follows the plan's current setting", () => {
    expect(
      isPurchaseAccessActive(
        [{ ...purchase(-40, 30), overlapping: null }, { ...purchase(-35, 30), overlapping: null }],
        { overlapping: false },
        now,
      ),
    ).toBe(true);
  });

  test("no purchases, no access", () => {
    expect(isPurchaseAccessActive([], { overlapping: false }, now)).toBe(false);
  });
});
