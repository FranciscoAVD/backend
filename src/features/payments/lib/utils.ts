import type Stripe from "stripe";
import { SQL } from "bun";
import {
  ALLOWED_EVENTS,
  CHECKOUT_SESSION_ID_PREFIX,
} from "@f/payments/lib/constants";
import type { Payment } from "@f/payments/lib/types";
import {
  DISPUTE_INQUIRY_REVOKES_ACCESS,
  PARTIAL_REFUND_REVOKES_ACCESS,
} from "@f/payments/lib/access-policy";

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
 * @description Whether an error is a Postgres unique violation (SQLSTATE 23505), unwrapped from
 * Drizzle's `DrizzleQueryError` the same way as `isForeignKeyViolation`.
 */
export function isUniqueViolation(error: unknown): boolean {
  const cause =
    error instanceof SQL.PostgresError
      ? error
      : error instanceof Error && error.cause instanceof SQL.PostgresError
        ? error.cause
        : null;
  return cause !== null && cause.errno === "23505";
}

/**
 * @description Purchase refund state for a charge. Whether a partial refund keeps the purchase
 * `paid` is `PARTIAL_REFUND_REVOKES_ACCESS`'s call (by default it does).
 * Shared by the webhook and the reconciler so both map Stripe state the same way.
 */
export function purchaseUpdateFromCharge(
  charge: Pick<Stripe.Charge, "amount_refunded" | "refunded">,
): Pick<Payment.Purchase, "amountRefunded" | "status"> {
  return {
    amountRefunded: charge.amount_refunded,
    status:
      charge.refunded || (PARTIAL_REFUND_REVOKES_ACCESS && charge.amount_refunded > 0)
        ? "refunded"
        : "paid",
  };
}

/**
 * @description Purchase status for a dispute: a lost dispute returns the money, a closed
 * one in our favor keeps it paid, and an open one is disputed. An open inquiry (not yet a
 * chargeback) counts as disputed or not per `DISPUTE_INQUIRY_REVOKES_ACCESS`.
 * @param inquiryRevokesAccess the policy to apply - defaults to `DISPUTE_INQUIRY_REVOKES_ACCESS`
 */
export function purchaseStatusFromDispute(
  dispute: Pick<Stripe.Dispute, "status">,
  inquiryRevokesAccess: boolean = DISPUTE_INQUIRY_REVOKES_ACCESS,
): Payment.Purchase["status"] {
  switch (dispute.status) {
    case "lost":
      return "refunded";
    case "won":
    case "warning_closed":
    case "prevented":
      return "paid";
    case "warning_needs_response":
    case "warning_under_review":
      return inquiryRevokesAccess ? "disputed" : "paid";
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

/**
 * @description Encodes a plan's `overlapping` for Checkout Session metadata, snapshotted at checkout
 * time alongside `durationDays`.
 */
export function encodeOverlapping(overlapping: Payment.Plan["overlapping"]): string {
  return String(overlapping);
}

/**
 * @description Decodes `encodeOverlapping`'s output from a Checkout Session's metadata.
 * @returns `{ overlapping }` when the session carries a valid snapshot, or undefined when it
 * doesn't (a session created before this snapshot existed, or a malformed value), so the caller
 * falls back to the plan's current setting.
 */
export function decodeOverlapping(
  value: string | undefined,
): { overlapping: boolean } | undefined {
  if (value === "true") return { overlapping: true };
  if (value === "false") return { overlapping: false };
  return undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type ChainablePurchase = Pick<Payment.Purchase, "createdAt" | "expiresAt" | "durationDays"> & {
  overlapping?: boolean | null;
};

/** One purchase's actual access window; `end: null` means it never expires. */
export type PurchaseAccessWindow = { start: Date; end: Date | null };

/**
 * @description The access window each of a user's access-granting purchases of one plan actually
 * grants, in the order given. Storage never chains purchases - each row's expiresAt comes from its
 * own createdAt + its own durationDays snapshot - so chaining happens only here, at read time, per
 * each purchase's own `overlapping` snapshot (the rule it was sold under): an overlapping purchase's
 * window starts at its own createdAt and runs alongside any earlier one; a non-overlapping purchase
 * starts where the earlier ones end, if that's later than its own createdAt (gaps aren't
 * backfilled), and its end is recomputed as `(chain-adjusted start) + its own durationDays` rather
 * than trusting its unchained `expiresAt` - a purchase bought before an earlier one lapses must
 * extend access, not shorten it. A row with no snapshot (written before the column existed) falls
 * back to the plan's current `overlapping`. A perpetual
 * purchase grants access from its own createdAt and doesn't move anything chained after it. Pure,
 * so the access checks and `GET /purchases` share one definition.
 * @param purchases the purchases to evaluate, all of one plan, already filtered to
 * access-granting statuses and sorted by createdAt ascending
 * @param plan object of the plan's current overlapping setting, the fallback for unsnapshotted rows
 * @returns One window per purchase, in the same order.
 */
export function purchaseAccessWindows(
  purchases: ChainablePurchase[],
  plan: Pick<Payment.Plan, "overlapping">,
): PurchaseAccessWindow[] {
  // the latest end of every window so far - what a non-overlapping purchase chains on after
  let chainEnd: Date | null = null;
  return purchases.map((p) => {
    // no duration snapshot and no expiry: a genuinely perpetual purchase
    if (p.durationDays == null && p.expiresAt === null) return { start: p.createdAt, end: null };

    const overlapping = p.overlapping ?? plan.overlapping;
    const start: Date =
      !overlapping && chainEnd && chainEnd > p.createdAt ? chainEnd : p.createdAt;
    // no duration snapshot but an expiry already set: trust the row's own expiresAt rather than
    // treating a null duration as "never expires"
    const end =
      p.durationDays == null
        ? (p.expiresAt as Date)
        : new Date(start.getTime() + p.durationDays * DAY_MS);

    if (!chainEnd || end > chainEnd) chainEnd = end;
    return { start, end };
  });
}

/**
 * @description Whether a user's access-granting purchases of one plan give them access at `now` -
 * whether any of `purchaseAccessWindows` covers it.
 * @param purchases see `purchaseAccessWindows`
 * @param plan see `purchaseAccessWindows`
 * @param now the moment to evaluate access at
 * @returns Whether those purchases grant access at `now`.
 */
export function isPurchaseAccessActive(
  purchases: ChainablePurchase[],
  plan: Pick<Payment.Plan, "overlapping">,
  now: Date,
): boolean {
  return purchaseAccessWindows(purchases, plan).some(
    (w) => now >= w.start && (w.end === null || now < w.end),
  );
}
