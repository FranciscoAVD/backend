import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { idParamValidator } from "@backend/lib/validators";

const app = new Hono().get("/:id", idParamValidator, (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id });
});

describe("idParamValidator", () => {
  test("rejects a numeric-prefixed garbage id like 12abc", async () => {
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

  test("rejects a negative id", async () => {
    const res = await app.request("/-12");
    expect(res.status).toBe(400);
  });

  test("rejects a leading-plus id like +12", async () => {
    const res = await app.request("/%2B12");
    expect(res.status).toBe(400);
  });

  test("rejects hex notation like 0x10", async () => {
    const res = await app.request("/0x10");
    expect(res.status).toBe(400);
  });
});
