import { describe, expect, test, beforeEach, mock } from "bun:test";

let sendCalls: Record<string, unknown>[] = [];
let sendError: { message: string; statusCode: number | null; name: string } | null = null;

// no free local "real Resend" to run against - the SDK surface sendEmail actually calls is
// faked here via bun:test's mock.module. Mocks @backend/f/email/lib/client (this app's own wrapper),
// not the "resend" package directly: client.ts lazily caches one Resend instance in a
// module-level singleton, and that module is only ever evaluated once for the whole bun test
// process - mocking "resend" itself still lets that real caching code run, and whichever test
// file's call to getEmailClient() happens first in the process permanently wins the cached
// instance for every other file afterward (reproduced directly). Mocking client.ts replaces the
// whole module, so that singleton logic never runs at all - same reason every Stripe-dependent
// test mocks @backend/f/payments/lib/stripe/client, never the "stripe" package itself.
mock.module("@backend/f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: {
      send: async (payload: Record<string, unknown>) => {
        sendCalls.push(payload);
        return sendError ? { data: null, error: sendError } : { data: { id: "email_1" }, error: null };
      },
    },
  }),
}));

import { sendEmail } from "@backend/f/email/send";
import { env } from "@backend/env";

beforeEach(() => {
  sendCalls = [];
  sendError = null;
});

describe("sendEmail", () => {
  test("sends through Resend with the configured from address and the given fields", async () => {
    await sendEmail({ to: "user@example.test", subject: "Hi", html: "<p>hi</p>" });

    expect(sendCalls).toEqual([
      {
        from: env.EMAIL_FROM,
        to: "user@example.test",
        subject: "Hi",
        html: "<p>hi</p>",
        text: undefined,
      },
    ]);
  });

  test("passes a text fallback through when given", async () => {
    await sendEmail({ to: "user@example.test", subject: "Hi", html: "<p>hi</p>", text: "hi" });

    expect(sendCalls[0]).toMatchObject({ text: "hi" });
  });

  test("logs and resolves (doesn't throw) when Resend returns an error", async () => {
    sendError = { message: "invalid API key", statusCode: 401, name: "invalid_api_key" };

    await expect(
      sendEmail({ to: "user@example.test", subject: "Hi", html: "<p>hi</p>" }),
    ).resolves.toBeUndefined();
  });
});
