import { describe, expect, test, beforeEach, mock } from "bun:test";

let sendCalls: Record<string, unknown>[] = [];

// mocks @backend/f/email/lib/client, not @backend/f/email/send - see CLAUDE.md's testing section (and
// verification-email.test.ts, which this mirrors) for why: any file that needs @backend/f/email/send to
// resolve to something other than its real module conflicts with send.test.ts.
mock.module("@backend/f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: {
      send: async (payload: Record<string, unknown>) => {
        sendCalls.push(payload);
        return { data: { id: "email_1" }, error: null };
      },
    },
  }),
}));

import { sendResetPasswordEmail } from "@backend/f/auth/lib/reset-password-email";

beforeEach(() => {
  sendCalls = [];
});

describe("sendResetPasswordEmail", () => {
  test("sends to the user's email with the reset-password template's subject and link", async () => {
    await sendResetPasswordEmail({
      user: { email: "user@example.test", name: "Ada" },
      url: "https://example.test/reset-password?token=abc",
      token: "abc",
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toBe("user@example.test");
    expect(sendCalls[0]?.subject).toBe("Reset your password");
    expect(sendCalls[0]?.html).toContain(
      'href="https://example.test/reset-password?token=abc"',
    );
  });
});
