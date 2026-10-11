import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@d/connection";
import { redis } from "@/lib/redis";
import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

/**
 * @description Readiness check: confirms both Postgres and Redis are actually
 * reachable, not just that the process is running. Unauthenticated and outside
 * `/api`, so orchestrators (Docker, Kubernetes, a load balancer) can hit it
 * without a session and regardless of API versioning.
 */
export const healthRoute = new Hono().get("/health", async (c) => {
  const [, dbError] = await tryCatch(db.execute(sql`select 1`));
  const [, redisError] = await tryCatch(redis.send("PING", []));

  if (dbError || redisError) {
    return c.json(
      {
        status: "unhealthy",
        db: dbError ? "unreachable" : "ok",
        redis: redisError ? "unreachable" : "ok",
      },
      HTTP.ServiceUnavailable,
    );
  }

  return c.json({ status: "ok" }, HTTP.OK);
});
