import { db } from "@backend/d/connection";
import { paymentAuditLog as paymentAuditLogTable } from "@backend/d/schemas/payment-schema";
import type { Payment } from "@backend/f/payments/lib/types";
import { and, eq, desc, lt } from "drizzle-orm";
import { AUDIT_LOG_DEFAULT_LIMIT, AUDIT_LOG_MAX_LIMIT } from "@backend/f/payments/lib/constants";

/**
 * One page of the audit log, newest first. `before` is the id of the last entry on the previous
 * page (keyset pagination: stable while new entries keep arriving, unlike an offset).
 */
export type AuditLogPage = { limit?: number; before?: Payment.AuditLog["id"] };

// ids are generated in insertion order, so ordering by id is ordering by recency - and unlike
// createdAt it's unique, which keyset pagination needs to never skip or repeat an entry
const page = ({ limit = AUDIT_LOG_DEFAULT_LIMIT, before }: AuditLogPage) => ({
  limit: Math.min(Math.max(limit, 1), AUDIT_LOG_MAX_LIMIT + 1),
  before: before === undefined ? undefined : lt(paymentAuditLogTable.id, before),
});

/**
 * @description Select query for one page of audit entries for a given user, most recent first.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @param pageOptions optional page size and cursor, see AuditLogPage (the size is capped at
 * AUDIT_LOG_MAX_LIMIT + 1, so a caller can ask for one extra row to tell whether a next page exists)
 * @returns Array of AuditLog entries.
 */
export async function getAuditLogByUser(
  target: { userId: string },
  pageOptions: AuditLogPage = {},
): Promise<Payment.AuditLog[]> {
  const { limit, before } = page(pageOptions);
  return db
    .select()
    .from(paymentAuditLogTable)
    .where(and(eq(paymentAuditLogTable.userId, target.userId), before))
    .orderBy(desc(paymentAuditLogTable.id))
    .limit(limit);
}

/**
 * @description Select query for one page of every audit entry, most recent first - for an admin
 * reviewing the trail across all customers, not one in particular. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param pageOptions optional page size and cursor, see AuditLogPage and getAuditLogByUser
 * @returns Array of AuditLog entries.
 */
export async function getAllAuditLog(
  pageOptions: AuditLogPage = {},
): Promise<Payment.AuditLog[]> {
  const { limit, before } = page(pageOptions);
  return db
    .select()
    .from(paymentAuditLogTable)
    .where(before)
    .orderBy(desc(paymentAuditLogTable.id))
    .limit(limit);
}
