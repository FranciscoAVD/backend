import { describe, expect, test } from "bun:test";

// Spawns the real CLI script as a subprocess, rather than importing it - it's a top-level
// script that calls process.exit() directly, which would kill the test runner itself if
// imported in-process. Only the argument-validation branch is covered here: it returns
// before ever calling run() (lib/reconcile.ts, already unit-tested), so this stays fully
// deterministic and network-free, unlike exercising a real Stripe call would be.
async function runScript(...args: string[]) {
  const proc = Bun.spawn(
    ["bun", "run", "src/features/payments/scripts/reconcile.ts", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("payments:reconcile CLI", () => {
  test("exits 1 for a non-numeric --days, without ever running the reconciler", async () => {
    const { exitCode, stdout, stderr } = await runScript("--days", "abc");
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("payments.reconcile.args");
  });

  test("exits 1 for a zero --days", async () => {
    const { exitCode } = await runScript("--days", "0");
    expect(exitCode).toBe(1);
  });

  test("exits 1 for a negative --days", async () => {
    const { exitCode } = await runScript("--days", "-1");
    expect(exitCode).toBe(1);
  });
});
