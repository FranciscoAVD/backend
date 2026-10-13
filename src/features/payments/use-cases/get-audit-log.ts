import { db } from "@d/connection";
import { paymentAuditLog as paymentAuditLogTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq, desc } from "drizzle-orm";

/**
 * @description Select query for all audit entries for a given user, most recent first.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @returns Array of AuditLog entries.
 */
export async function getAuditLogByUser(
  target: { userId: string },
): Promise<Payment.AuditLog[]> {
  const res = await db
    .select()
    .from(paymentAuditLogTable)
    .where(eq(paymentAuditLogTable.userId, target.userId))
    .orderBy(desc(paymentAuditLogTable.createdAt));
  return res;
}

/**
 * @description Select query for every audit entry, most recent first - for an admin
 * reviewing the trail across all customers, not one in particular. Assumes validation.
 * Operation must be wrapped in try-catch
 * @returns Array of AuditLog entries.
 */
export async function getAllAuditLog(): Promise<Payment.AuditLog[]> {
  const res = await db
    .select()
    .from(paymentAuditLogTable)
    .orderBy(desc(paymentAuditLogTable.createdAt));
  return res;
}
