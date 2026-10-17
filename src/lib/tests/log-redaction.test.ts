import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { pinoLogger, type Env as PinoLoggerEnv } from "hono-pino";
import pino from "pino";
import { httpLoggerOptions } from "@/lib/logger";

// Mirrors how src/index.ts actually wires requestId + pinoLogger, against a throwaway pino
// instance (same redact config as the real one) pointed at an in-memory destination - the same
// technique as src/features/auth/tests/log-bridge.test.ts's capturingLogger - so this inspects the
// real serialized JSON output, not just mocked call arguments.
function capturingApp() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const testLogger = pino(
    {
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["stripe-signature"]',
          'res.headers["set-cookie"]',
        ],
        censor: "[Redacted]",
      },
    },
    destination,
  );

  const app = new Hono<PinoLoggerEnv>()
    .use(requestId())
    .use(pinoLogger({ pino: testLogger, http: httpLoggerOptions }))
    .get("/ok", (c) => {
      c.header("Set-Cookie", "better_auth.session_token=realsecret; Path=/; HttpOnly");
      return c.json({ ok: true });
    });

  return { app, lines };
}

const requestLogLine = (lines: string[]) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => (line.req as { url?: string } | undefined)?.url === "/ok")!;

describe("request/response logging redacts secrets", () => {
  test("request headers: cookie, authorization and stripe-signature are redacted", async () => {
    const { app, lines } = capturingApp();

    await app.request("/ok", {
      headers: {
        cookie: "better_auth.session_token=stealme",
        authorization: "Bearer stealme",
        "stripe-signature": "t=1,v1=stealme",
        "content-type": "application/json",
      },
    });

    const line = requestLogLine(lines);
    const headers = (line.req as { headers: Record<string, unknown> }).headers;
    expect(headers.cookie).toBe("[Redacted]");
    expect(headers.authorization).toBe("[Redacted]");
    expect(headers["stripe-signature"]).toBe("[Redacted]");
    // an unrelated header proves this redacts specific fields, not the whole object
    expect(headers["content-type"]).toBe("application/json");
  });

  test("response headers: set-cookie is redacted", async () => {
    const { app, lines } = capturingApp();

    await app.request("/ok");

    const line = requestLogLine(lines);
    const headers = (line.res as { headers: Record<string, unknown> }).headers;
    expect(headers["set-cookie"]).toBe("[Redacted]");
    expect(headers["content-type"]).toBe("application/json");
  });
});
