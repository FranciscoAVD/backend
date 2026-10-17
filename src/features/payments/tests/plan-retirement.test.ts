import { describe, expect, test, beforeEach } from "bun:test";
import { resetDb, seedPlan } from "@/test-helpers/db";
import { rejectRetiredPlanUpgrade } from "@f/payments/lib/plan-retirement";

const upgrade = (plan: string) => ({ path: "/subscription/upgrade", body: { plan } });

describe("rejectRetiredPlanUpgrade", () => {
  beforeEach(resetDb);

  test("blocks a retired plan by name, case-insensitively", async () => {
    await seedPlan({ name: "Pack", type: "recurring", interval: "month", active: false });
    expect(rejectRetiredPlanUpgrade(upgrade("pack"))).rejects.toThrow();
  });

  // the plugin matches with JS's toLowerCase, under which the Kelvin sign folds to "k" -
  // a Postgres lower() under a C collation leaves it alone, so matching that way would let
  // this name slip past the check
  test("blocks a name that only JS's case folding maps onto the retired plan", async () => {
    await seedPlan({ name: "Pack", type: "recurring", interval: "month", active: false });
    expect(rejectRetiredPlanUpgrade(upgrade("PACK"))).rejects.toThrow();
  });

  test("lets an active plan through", async () => {
    await seedPlan({ name: "Pack", type: "recurring", interval: "month" });
    expect(await rejectRetiredPlanUpgrade(upgrade("pack"))).toBeUndefined();
  });

  test("ignores a retired one-time plan of the same name (the plugin never sees those)", async () => {
    await seedPlan({ name: "Pack", active: false });
    expect(await rejectRetiredPlanUpgrade(upgrade("pack"))).toBeUndefined();
  });
});
