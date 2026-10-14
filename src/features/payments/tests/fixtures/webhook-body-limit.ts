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
// a body with no Content-Length, streamed in 256 KB chunks
const streamOf = (chunks: number) => {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(chunk);
      else controller.close();
    },
  });
};
const stream = streamOf(8);

// any other API route: the app-wide cap, enforced before auth or routing
const post = async (path: string, body: string | ReadableStream) =>
  (
    await server.fetch(
      new Request(`${env.BETTER_AUTH_URL}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.CLIENT_URL },
        body,
      }),
    )
  ).status;
const json200k = JSON.stringify({ padding: "x".repeat(200 * 1024) });

console.log(
  JSON.stringify({
    oversized: await webhook("x".repeat(2 * 1024 * 1024), { "content-type": "application/json" }),
    oversizedStreamed: await webhook(stream),
    eventSized: await webhook(JSON.stringify({ id: "evt_1", data: { object: {} } }), {
      "content-type": "application/json",
    }),
    // over the app-wide cap but under the webhook's own: still reaches signature checking
    webhookOverApiCap: await webhook(json200k, { "content-type": "application/json" }),
    signUpOversized: await post("/auth/sign-up/email", json200k),
    signUpOversizedStreamed: await post("/auth/sign-up/email", streamOf(1)),
    checkoutOversized: await post("/payments/checkout", json200k),
  }),
);
process.exit(0);
