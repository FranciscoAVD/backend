import { describe, expect, test, beforeEach, mock } from "bun:test";

let sendCalls: Record<string, unknown>[] = [];

// mocks @backend/f/email/lib/client, not @backend/f/email/send: any file that needs @backend/f/email/send to resolve to
// something other than its real module conflicts with send.test.ts, which needs the real one -
// see CLAUDE.md's testing section for why. Mocking one level deeper lets the real send.ts run
// (already covered on its own in features/email/tests/send.test.ts) while still avoiding Resend.
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

import { sendVerificationEmail } from "@backend/f/auth/lib/verification-email";

beforeEach(() => {
  sendCalls = [];
});

describe("sendVerificationEmail", () => {
  test("sends to the user's email with the verification template's subject and link", async () => {
    await sendVerificationEmail({
      user: { email: "user@example.test", name: "Ada" },
      url: "https://example.test/api/auth/verify-email?token=abc",
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toBe("user@example.test");
    expect(sendCalls[0]?.subject).toBe("Verify your email");
    expect(sendCalls[0]?.html).toContain(
      'href="https://example.test/api/auth/verify-email?token=abc"',
    );
  });
});
