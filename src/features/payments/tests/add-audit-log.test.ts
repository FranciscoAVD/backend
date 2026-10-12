import { describe, expect, test, beforeEach } from "bun:test";
import { addAuditLog } from "@f/payments/use-cases/add-audit-log";
import { getAuditLogByUser } from "@f/payments/use-cases/get-audit-log";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";

describe("addAuditLog / getAuditLogByUser", () => {
  beforeEach(resetDb);

  test("inserts an entry and reads it back for the user", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    const res = await addAuditLog({
      type: "checkout_blocked_existing_purchase",
      userId,
      planId: plan.id,
      existingPurchaseId: null,
      stripeCheckoutSessionId: null,
      details: null,
    });

    expect(res).not.toBeNull();
    expect(res?.type).toBe("checkout_blocked_existing_purchase");

    const entries = await getAuditLogByUser({ userId });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.planId).toBe(plan.id);
  });

  test("getAuditLogByUser returns entries most recent first", async () => {
    const userId = await seedUser();
    const plan = await seedPlan();

    await addAuditLog({
      type: "checkout_blocked_existing_purchase",
      userId,
      planId: plan.id,
      existingPurchaseId: null,
      stripeCheckoutSessionId: null,
      details: null,
    });
    await addAuditLog({
      type: "checkout_blocked_pending_checkout",
      userId,
      planId: plan.id,
      existingPurchaseId: null,
      stripeCheckoutSessionId: null,
      details: null,
    });

    const entries = await getAuditLogByUser({ userId });
    expect(entries.map((e) => e.type)).toEqual([
      "checkout_blocked_pending_checkout",
      "checkout_blocked_existing_purchase",
    ]);
  });

  test("returns an empty array for a user with no audit entries", async () => {
    const userId = await seedUser();
    expect(await getAuditLogByUser({ userId })).toEqual([]);
  });
});
