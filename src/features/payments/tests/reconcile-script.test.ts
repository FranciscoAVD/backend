import { describe, expect, test } from "bun:test";

// Spawns the real CLI script as a subprocess, rather than importing it - it's a top-level
// script that calls process.exit() directly, which would kill the test runner itself if
// imported in-process. Only the argument-validation branch is covered here: it returns
// before ever calling paymentsServices.reconcile.purchases (services/reconcile.ts, already
// unit-tested), so this stays fully
// deterministic and network-free, unlike exercising a real Stripe call would be.
async function runScript(...args: string[]) {
  const proc = Bun.spawn(
    ["bun", "run", "src/features/payments/scripts/reconcile.ts", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      // the assertion below needs the script's error-level log line to actually print -
      // Bun.spawn otherwise inherits process.env, so a developer's own .env (e.g.
      // LOG_LEVEL=fatal) would silently swallow it and fail this test for reasons that
      // have nothing to do with the script's own behavior
      env: { ...process.env, LOG_LEVEL: "info" },
    },
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
