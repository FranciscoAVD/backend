import type Stripe from "stripe";
import { SQL } from "bun";
import {
  ALLOWED_EVENTS,
  CHECKOUT_SESSION_ID_PREFIX,
} from "@f/payments/lib/constants";
import type { Payment } from "@f/payments/lib/types";

export type AllowedEvent = Extract<
  Stripe.Event,
  { type: (typeof ALLOWED_EVENTS)[number] }
>;

/**
 * @description Checks that a value looks like a Stripe Checkout Session ID.
 * Only a shape check — it doesn't confirm the session exists.
 */
export function isCheckoutSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > CHECKOUT_SESSION_ID_PREFIX.length &&
    value.startsWith(CHECKOUT_SESSION_ID_PREFIX)
  );
}

/** @description Narrows a Stripe event to one listed in `ALLOWED_EVENTS`. */
export function isAllowedEvent(event: Stripe.Event): event is AllowedEvent {
  return (ALLOWED_EVENTS as readonly string[]).includes(event.type);
}

/**
 * @description Whether an error is a Postgres foreign-key violation on the given column. The
 * SQLSTATE lives in `.errno` (not `.code`, which is Bun's own generic error code), and there's no
 * usable per-column field - `.column`/`.line` are the JS source location the error was
 * constructed at, not anything about the SQL. The reliable signal is the column name Postgres
 * embeds in `.detail` (`Key (<column>)=... is not present in table ...`), which comes from
 * Postgres itself and doesn't depend on Drizzle's auto-generated constraint name staying stable
 * across a future `drizzle-kit push` regeneration. Drizzle wraps the real `SQL.PostgresError` in
 * its own `DrizzleQueryError`, with the original attached as `.cause`, so both are checked.
 */
export function isForeignKeyViolation(error: unknown, column: string): boolean {
  const cause =
    error instanceof SQL.PostgresError
      ? error
      : error instanceof Error && error.cause instanceof SQL.PostgresError
        ? error.cause
        : null;
  return (
    cause !== null &&
    cause.errno === "23503" &&
    typeof cause.detail === "string" &&
    cause.detail.includes(`(${column})=`)
  );
}

/**
 * @description Purchase refund state for a charge. Partial refunds keep the purchase paid.
 * Shared by the webhook and the reconciler so both map Stripe state the same way.
 */
export function purchaseUpdateFromCharge(
  charge: Pick<Stripe.Charge, "amount_refunded" | "refunded">,
): Pick<Payment.Purchase, "amountRefunded" | "status"> {
  return {
    amountRefunded: charge.amount_refunded,
    status: charge.refunded ? "refunded" : "paid",
  };
}

/**
 * @description Purchase status for a dispute: a lost dispute returns the money, a closed
 * one in our favor keeps it paid, and an open one is disputed.
 */
export function purchaseStatusFromDispute(
  dispute: Pick<Stripe.Dispute, "status">,
): Payment.Purchase["status"] {
  switch (dispute.status) {
    case "lost":
      return "refunded";
    case "won":
    case "warning_closed":
    case "prevented":
      return "paid";
    default:
      return "disputed";
  }
}

// Stripe drops a metadata key whose value is "", so "never expires" needs its own marker to
// stay distinguishable from "this session predates the snapshot" (key absent)
const NO_EXPIRY = "none";

/**
 * @description Encodes a plan's `durationDays` for Checkout Session metadata, snapshotted at
 * checkout time. `null` (never expires) is stored as an explicit marker, not left out.
 */
export function encodeDurationDays(
  durationDays: Payment.Plan["durationDays"],
): string {
  return durationDays == null ? NO_EXPIRY : String(durationDays);
}

/**
 * @description Decodes `encodeDurationDays`'s output from a Checkout Session's metadata.
 * @returns `{ durationDays }` (a positive integer, or null for "never expires") when the session
 * carries a valid snapshot, or undefined when it doesn't - a session created before snapshotting
 * was added, or a malformed value - so the caller falls back to the plan's current setting.
 */
export function decodeDurationDays(
  value: string | undefined,
): { durationDays: Payment.Plan["durationDays"] } | undefined {
  if (value === NO_EXPIRY) return { durationDays: null };
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  return { durationDays: Number(value) };
}
