import { describe, expect, test, beforeEach } from "bun:test";
import {
  getPlan,
  getPlanByName,
  getPlans,
  getSubscriptionPlans,
} from "@f/payments/use-cases/get-plans";
import { resetDb, seedPlan } from "@/test-helpers/db";

describe("getPlan", () => {
  beforeEach(resetDb);

  test("returns the plan by id", async () => {
    const plan = await seedPlan({ name: "Pro" });
    const res = await getPlan({ id: plan.id });
    expect(res?.name).toBe("Pro");
  });

  test("returns null for a nonexistent id", async () => {
    const res = await getPlan({ id: 999999 });
    expect(res).toBeNull();
  });
});

describe("getPlanByName", () => {
  beforeEach(resetDb);

  test("matches case-insensitively", async () => {
    await seedPlan({ name: "Pro Plan" });
    const res = await getPlanByName({ name: "pro plan" });
    expect(res?.name).toBe("Pro Plan");
  });

  test("returns null when no plan has that name", async () => {
    const res = await getPlanByName({ name: "Nonexistent" });
    expect(res).toBeNull();
  });
});

describe("getPlans", () => {
  beforeEach(resetDb);

  test("returns only active plans", async () => {
    await seedPlan({ name: "Active", active: true });
    await seedPlan({ name: "Inactive", active: false });

    const res = await getPlans();
    expect(res).toHaveLength(1);
    expect(res[0]?.name).toBe("Active");
  });
});

describe("getSubscriptionPlans", () => {
  beforeEach(resetDb);

  test("returns only active recurring plans, mapped to the stripe plugin's shape", async () => {
    await seedPlan({
      name: "Monthly",
      type: "recurring",
      interval: "month",
      active: true,
      trialDays: 14,
    });
    await seedPlan({ name: "One Time", type: "one_time", active: true });
    await seedPlan({
      name: "Inactive Recurring",
      type: "recurring",
      interval: "month",
      active: false,
    });

    const res = await getSubscriptionPlans();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: "Monthly",
      freeTrial: { days: 14 },
    });
  });
});
