import { describe, expect, test, spyOn } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import { logger } from "@/lib/logger";
import { authLoggerBridge, createAuthLoggerBridge } from "@f/auth/lib/log-bridge";

// Unit-tests the bridge function directly, not through a real betterAuth()/stripe-plugin
// instance: @f/auth/auth is a shared singleton across every test file that imports it, and
// giving it anything less than a fully-featured Stripe fake here would corrupt whichever other
// test file's import of it resolves second in the same `bun test` run (see CLAUDE.md's testing
// section on @f/auth/auth's shared-module-mock hazard) - this avoids that entirely.
describe("authLoggerBridge", () => {
  test("a webhook failure logs at error, with the real message intact", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => logger);

    authLoggerBridge.log("error", "Stripe webhook failed. Error: Stripe is down");

    expect(errorSpy).toHaveBeenCalledWith({}, "Stripe webhook failed. Error: Stripe is down");

    errorSpy.mockRestore();
  });

  test("an attached Error goes under the err key, not a plain args field", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => logger);
    const err = new Error("boom");

    authLoggerBridge.log("error", "Failed to run background task:", err);

    expect(errorSpy).toHaveBeenCalledWith({ err }, "Failed to run background task:");

    errorSpy.mockRestore();
  });

  test("non-error levels pass through at the matching pino level", () => {
    const infoSpy = spyOn(logger, "info").mockImplementation(() => logger);

    authLoggerBridge.log("info", "some better-auth info line");

    expect(infoSpy).toHaveBeenCalledWith({}, "some better-auth info line");
    infoSpy.mockRestore();
  });
});

// The tests above only check the JS call arguments the bridge passes to pino's methods - they
// can't see what pino's real serializer does with them, which is exactly where the duplicate-`msg`
// bug lived (a merging object that itself has a `msg` key produces two `"msg"` keys in the written
// JSON line; JSON.parse and most log consumers keep only the last one, discarding the real
// message). These exercise a throwaway, undestroyed pino instance pointed at an in-memory
// destination and parse what it actually wrote.
function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino({}, destination), lines };
}

const lastLine = (lines: string[]) => JSON.parse(lines.at(-1)!) as Record<string, unknown>;

describe("authLoggerBridge's real pino output", () => {
  test("a passthrough error with an attached Error serializes to one msg and an expanded err", () => {
    const { logger: testLogger, lines } = capturingLogger();
    const bridge = createAuthLoggerBridge(testLogger);

    bridge.log("error", "Failed to run background task:", new Error("boom"));

    const line = lastLine(lines);
    expect(line.msg).toBe("Failed to run background task:");
    expect(line.err).toMatchObject({ message: "boom" });
  });

  test("a passthrough with no extra arg has the real message as msg and no err key", () => {
    const { logger: testLogger, lines } = capturingLogger();
    const bridge = createAuthLoggerBridge(testLogger);

    bridge.log("warn", "Base URL is not set");

    const line = lastLine(lines);
    expect(line.msg).toBe("Base URL is not set");
    expect("err" in line).toBe(false);
  });
});
