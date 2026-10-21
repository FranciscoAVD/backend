import { describe, expect, test } from "bun:test";

// Exercises the real app as src/index.ts serves it - the cap lives on the root router, in front of
// better-auth's handler - so it runs in a subprocess (see fixtures/webhook-body-limit.ts for why it
// can't be imported here). Network-free: every request is rejected before any Stripe call.
async function statuses() {
  const proc = Bun.spawn(["bun", "run", "src/features/payments/tests/fixtures/webhook-body-limit.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LOG_LEVEL: "fatal" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`fixture failed: ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, number>;
}

describe("the Stripe webhook's request body cap", () => {
  test("oversized bodies are refused before they're read or signature-checked", async () => {
    const { oversized, oversizedStreamed, eventSized, webhookOverApiCap } = await statuses();
    expect({ oversized, oversizedStreamed, eventSized, webhookOverApiCap }).toEqual({
      oversized: 413,
      // no Content-Length to trust - the cap still applies as the body streams in
      oversizedStreamed: 413,
      // an event-sized body still reaches the plugin, which rejects the forged signature
      eventSized: 400,
      // the app-wide cap doesn't apply to the webhook - its own, larger one does
      webhookOverApiCap: 400,
    });
  });
});

describe("the app-wide request body cap", () => {
  test("every other route refuses an oversized body before auth or routing", async () => {
    const { signUpOversized, signUpOversizedStreamed, checkoutOversized } = await statuses();
    expect({ signUpOversized, signUpOversizedStreamed, checkoutOversized }).toEqual({
      // unauthenticated, and still refused
      signUpOversized: 413,
      // no Content-Length - refused as it streams in
      signUpOversizedStreamed: 413,
      // refused before the session check would 401 it
      checkoutOversized: 413,
    });
  });
});
