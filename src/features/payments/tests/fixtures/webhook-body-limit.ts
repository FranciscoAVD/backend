// Run as a subprocess by webhook-body-limit.test.ts, never imported by a test: it loads the real app
// from src/index.ts, and doing that inside the shared test process would cache route.ts/auth.ts with
// their real auth middleware and Stripe client before other test files can mock them.
import { env } from "@/env";

const { default: server } = await import("@/index");

const webhook = async (body: string | ReadableStream, headers: Record<string, string> = {}) =>
  (
    await server.fetch(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": "t=0,v1=forged", ...headers },
        body,
      }),
    )
  ).status;

const chunk = new Uint8Array(256 * 1024);
let sent = 0;
const stream = new ReadableStream({
  pull(controller) {
    if (sent++ < 8) controller.enqueue(chunk);
    else controller.close();
  },
});

console.log(
  JSON.stringify({
    oversized: await webhook("x".repeat(2 * 1024 * 1024), { "content-type": "application/json" }),
    oversizedStreamed: await webhook(stream),
    eventSized: await webhook(JSON.stringify({ id: "evt_1", data: { object: {} } }), {
      "content-type": "application/json",
    }),
  }),
);
process.exit(0);
