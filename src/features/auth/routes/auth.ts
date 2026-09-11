import { Hono } from "hono";
import { auth } from "@f/auth/auth";

const app = new Hono();

app.all("/*", (c) => auth.handler(c.req.raw));

export default app;
