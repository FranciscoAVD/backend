// Run as a subprocess by trusted-proxies.test.ts, with TRUSTED_IP_HEADER set to a custom header
// name: better-auth reads it once, when auth.ts is first evaluated, so each configuration needs a
// fresh process. Reads env.TRUSTED_IP_HEADER itself to decide which header to send - proving
// whichever header name is configured is the one actually consulted, not a hardcoded one.
import { env } from "@backend/env";

const { auth } = await import("@backend/f/auth/auth");
const headerName = env.TRUSTED_IP_HEADER!;
// unique per run, so leftover rate-limit counters from an earlier run can't interfere
const run = Math.floor(Math.random() * 200) + 20;
const asClient = (client: string) =>
  auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/ok`, {
      // a single, direct value - no forwarded chain, as a platform's own dedicated header works
      headers: { [headerName]: client },
    }),
  );

const flooded = await Promise.all(
  Array.from({ length: 150 }, async () => (await asClient(`203.0.113.${run}`)).status),
);
const otherClient = (await asClient(`198.51.100.${run}`)).status;

console.log(JSON.stringify({ floodedGot429: flooded.includes(429), otherClient }));
process.exit(0);
