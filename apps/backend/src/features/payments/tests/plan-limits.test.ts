import { describe, expect, test } from "bun:test";
import { insertPlanSchema, updatePlanSchema } from "@backend/f/payments/lib/schemas";

const basePlan = { name: "Pro", type: "one_time", amount: 1000, currency: "usd" } as const;

describe("plan limits validation", () => {
  test("creating a plan accepts an object, null or no limits", () => {
    expect(insertPlanSchema.safeParse({ ...basePlan, limits: { seats: 5 } }).success).toBe(true);
    expect(insertPlanSchema.safeParse({ ...basePlan, limits: null }).success).toBe(true);
    expect(insertPlanSchema.safeParse(basePlan).success).toBe(true);
  });

  test("creating a plan rejects limits that aren't an object", () => {
    for (const limits of ["seats=5", 5, [1, 2], true])
      expect(insertPlanSchema.safeParse({ ...basePlan, limits }).success).toBe(false);
  });

  test("updating a plan validates limits the same way", () => {
    expect(updatePlanSchema.safeParse({ limits: { seats: 3 } }).success).toBe(true);
    expect(updatePlanSchema.safeParse({ limits: null }).success).toBe(true);
    expect(updatePlanSchema.safeParse({ limits: ["seats"] }).success).toBe(false);
  });
});
