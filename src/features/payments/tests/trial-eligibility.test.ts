import { describe, expect, test, beforeEach } from "bun:test";
import { resetDb, seedUser } from "@/test-helpers/db";
import { withholdTrialFromUnverified } from "@f/payments/lib/trial-eligibility";

const trialPlan = { name: "pro", freeTrial: { days: 14 } };

describe("withholdTrialFromUnverified", () => {
  beforeEach(resetDb);

  test("strips the trial for an unverified email", async () => {
    const id = await seedUser({ emailVerified: false });
    const res = await withholdTrialFromUnverified({ user: { id }, plan: trialPlan });
    expect(res.params?.subscription_data).toHaveProperty("trial_period_days", undefined);
  });

  test("leaves the trial alone for a verified email", async () => {
    const id = await seedUser({ emailVerified: true });
    expect(await withholdTrialFromUnverified({ user: { id }, plan: trialPlan })).toEqual({});
  });

  test("reads verification live, not from the caller's (possibly cached) user", async () => {
    const id = await seedUser({ emailVerified: false });
    const res = await withholdTrialFromUnverified({
      user: { id, emailVerified: true } as { id: string },
      plan: trialPlan,
    });
    expect(res.params?.subscription_data).toHaveProperty("trial_period_days", undefined);
  });

  test("does nothing for a plan with no trial", async () => {
    const id = await seedUser({ emailVerified: false });
    expect(await withholdTrialFromUnverified({ user: { id }, plan: { name: "basic" } })).toEqual({});
  });
});
