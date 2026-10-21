import { Hono } from "hono";
import { auth } from "@backend/f/auth/auth";

// chained in one expression: RPC's AppType only picks up routes registered
// on the exact value assigned to `app`, not ones added via a later statement
const app = new Hono().all("/*", (c) => auth.handler(c.req.raw));

export default app;
