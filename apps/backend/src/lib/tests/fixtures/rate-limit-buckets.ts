// Run as a subprocess by trusted-proxies.test.ts, with TRUSTED_PROXIES set or not: better-auth reads
// it once, when auth.ts is first evaluated, so each configuration needs a fresh process.
import { env } from "@backend/env";

const { auth } = await import("@backend/f/auth/auth");
// unique per run, so leftover rate-limit counters from an earlier run can't interfere
const run = Math.floor(Math.random() * 200) + 20;
const viaProxy = (client: string) =>
  auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/ok`, {
      // two hops: the client, then the app's own proxy
      headers: { "x-forwarded-for": `${client}, 10.0.0.7` },
    }),
  );

const flooded = await Promise.all(
  Array.from({ length: 150 }, async () => (await viaProxy(`203.0.113.${run}`)).status),
);
const otherClient = (await viaProxy(`198.51.100.${run}`)).status;

console.log(
  JSON.stringify({ floodedGot429: flooded.includes(429), otherClient }),
);
process.exit(0);
