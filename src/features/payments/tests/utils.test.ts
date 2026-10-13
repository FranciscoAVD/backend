import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  isCheckoutSessionId,
  isAllowedEvent,
  purchaseUpdateFromCharge,
  purchaseStatusFromDispute,
  encodeDurationDays,
  decodeDurationDays,
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
