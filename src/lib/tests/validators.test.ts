import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { idParamValidator } from "@/lib/validators";

const app = new Hono().get("/:id", idParamValidator, (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id });
});

describe("idParamValidator", () => {
  test("rejects a numeric-prefixed garbage id like 12abc", async () => {
    // parseInt("12abc") is 12 - Number() is what actually rejects trailing garbage
    const res = await app.request("/12abc");
    expect(res.status).toBe(400);
  });

  test("accepts a clean integer id", async () => {
    const res = await app.request("/12");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 12 });
  });

  test("rejects a non-integer like 12.5", async () => {
    const res = await app.request("/12.5");
    expect(res.status).toBe(400);
  });
});
