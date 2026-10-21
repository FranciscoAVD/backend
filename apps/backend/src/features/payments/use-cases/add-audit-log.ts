import { db } from "@backend/d/connection";
import { paymentAuditLog as paymentAuditLogTable } from "@backend/d/schemas/payment-schema";
import type { Payment } from "@backend/f/payments/lib/types";

/**
 * @description Insert query for one payment audit entry (see `payment-schema.ts`'s
 * `paymentAuditType` for the scenarios this covers). Best-effort by design - callers wrap this in
 * `tryCatch` and log a warning on failure rather than letting it block the response it's attached
 * to. Assumes validation. Operation must be wrapped in try-catch
 * @param entry object of insert fields enforced by Payment.AuditLog.Insert
 * @returns AuditLog object or null. If null, the insert didn't return a row.
 */
export async function addAuditLog(
  entry: Payment.AuditLog.Insert,
): Promise<Payment.AuditLog | null> {
  const res = await db.insert(paymentAuditLogTable).values(entry).returning();
  return res[0] ?? null;
}
