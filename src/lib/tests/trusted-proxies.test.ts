import { describe, expect, test } from "bun:test";
import { trustedProxiesSchema } from "@/env";

describe("TRUSTED_PROXIES", () => {
  test("parses a comma-separated list of IPs and CIDRs", () => {
    expect(trustedProxiesSchema.parse(" 10.0.0.0/8, 172.16.0.1 ,fd00::/8")).toEqual([
      "10.0.0.0/8",
      "172.16.0.1",
      "fd00::/8",
    ]);
  });

  test("unset means none", () => {
    expect(trustedProxiesSchema.parse(undefined)).toBeUndefined();
  });

  // better-auth would silently drop an entry it can't parse - fail at startup instead
  test.each(["10.0.0.0/33", "not-an-ip", "10.0.0.0/8,,", "10.0.0"])(
    "rejects a malformed entry: %p",
    (value) => {
      expect(trustedProxiesSchema.safeParse(value).success).toBe(false);
    },
  );
});

async function buckets(trustedProxies: string | undefined) {
  const proc = Bun.spawn(["bun", "run", "src/lib/tests/fixtures/rate-limit-buckets.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LOG_LEVEL: "fatal", TRUSTED_PROXIES: trustedProxies ?? "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`fixture failed: ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    floodedGot429: boolean;
    otherClient: number;
  };
}

describe("rate limiting behind a proxy", () => {
  test("with the proxy trusted, one client's flood doesn't throttle another", async () => {
    expect(await buckets("10.0.0.0/8")).toEqual({ floodedGot429: true, otherClient: 200 });
  });

  test("without it, every client behind the proxy shares one bucket", async () => {
    expect(await buckets(undefined)).toEqual({ floodedGot429: true, otherClient: 429 });
  });
});
