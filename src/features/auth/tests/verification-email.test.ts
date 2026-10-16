import { describe, expect, test, beforeEach, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createSecondaryStorage } from "@vicstack/secondary-storage";
import { db } from "@d/connection";
import * as schema from "@d/schemas/auth-schema";
import { redis, incrementWithTTL } from "@/lib/redis";
import { resetDb } from "@/test-helpers/db";
import { resetRedis } from "@/test-helpers/redis";
import { env } from "@/env";

let sendCalls: { to: string; subject: string; html: string }[] = [];

// isolates "did the hook wire into a real better-auth sign-up flow correctly" from "does
// sendEmail call Resend correctly" (covered separately by lib/tests/email.test.ts).
mock.module("@/lib/email", () => ({
  sendEmail: async (message: { to: string; subject: string; html: string }) => {
    sendCalls.push(message);
  },
}));

// dynamic, not static - verification-email.ts imports sendEmail from @/lib/email at its own
// module top; a static import here would be hoisted above the mock.module call regardless of
// where it's written, and would still capture the real sendEmail.
const { sendVerificationEmail } = await import("@f/auth/lib/verification-email");

// a standalone betterAuth instance, not the shared @f/auth/auth singleton: that module is
// dynamically imported by other test files too (see payments/tests/auth-hooks.test.ts), and since
// a given module specifier is only ever evaluated once per bun test process, whichever file's
// import happens to run first bakes its own Stripe fake (or lack of one) into the shared stripe
// plugin for every other file for the rest of the run - a real, flaky cross-file risk, not a
// hypothetical one (reproduced while writing this test). Exercising the hook against a minimal
// instance built the same way, with no Stripe/admin plugins in the mix, sidesteps that entirely.
const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // matches auth.ts's own setup: without this, better-auth's drizzle adapter expects a
  // `verification` table in Postgres to store the token in - this schema has none, since the real
  // app keeps verification records in Redis only
  secondaryStorage: createSecondaryStorage({ redis: { client: redis, increment: incrementWithTTL } }),
  emailAndPassword: { enabled: true },
  emailVerification: { sendVerificationEmail, sendOnSignUp: true },
});

beforeEach(async () => {
  await resetDb();
  await resetRedis();
  sendCalls = [];
});

describe("sign-up sends a verification email", () => {
  test("sends exactly one email to the new user's address with a working verification link", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;

    await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Test User" },
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toBe(email);
    expect(sendCalls[0]?.subject).toBe("Verify your email");

    const hrefMatch = sendCalls[0]?.html.match(/href="([^"]+)"/);
    expect(hrefMatch).not.toBeNull();
    const url = new URL(hrefMatch![1]!);
    expect(url.origin).toBe(new URL(env.BETTER_AUTH_URL).origin);
    expect(url.pathname).toContain("/verify-email");
    expect(url.searchParams.get("token")).toBeTruthy();
  });

  test("escapes a name containing HTML so it can't break the email's markup", async () => {
    const email = `u-${crypto.randomUUID()}@example.com`;

    await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: '<img src=x onerror=alert(1)>' },
    });

    expect(sendCalls[0]?.html).not.toContain("<img src=x");
    expect(sendCalls[0]?.html).toContain("&lt;img");
  });
});
