import { describe, expect, test, beforeEach } from "bun:test";
import { updatePlan } from "@f/payments/use-cases/update-plan";
import { resetDb, seedPlan } from "@/test-helpers/db";

describe("updatePlan", () => {
  beforeEach(resetDb);

  test("updates a single field and leaves the rest untouched", async () => {
    const plan = await seedPlan({ active: true, limits: { seats: 5 } });

    const res = await updatePlan({ id: plan.id }, { active: false });

    expect(res?.active).toBe(false);
    expect(res?.limits).toEqual({ seats: 5 });
    expect(res?.name).toBe(plan.name);
  });

  test("updates multiple fields at once", async () => {
    const plan = await seedPlan({
      repeatable: false,
      durationDays: null,
      overlapping: true,
    });

    const res = await updatePlan(
      { id: plan.id },
      { repeatable: true, durationDays: 30, overlapping: false },
    );

    expect(res?.repeatable).toBe(true);
    expect(res?.durationDays).toBe(30);
    expect(res?.overlapping).toBe(false);
  });

  test("returns null for a nonexistent plan id", async () => {
    const res = await updatePlan({ id: 999999 }, { active: false });
    expect(res).toBeNull();
  });
});
