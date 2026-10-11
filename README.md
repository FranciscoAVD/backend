# backend

A Hono + better-auth + Drizzle API, built on Bun. This isn't just a stack choice — the following principles are what the codebase actually optimizes for, and new code should follow them.

## Philosophy

**Postgres is truth. Redis is cache.** Every durable fact (users, sessions, todos) lives in Postgres via Drizzle. Redis exists to make reads faster (session cache) and to bound abuse (rate limiting) — never as the only place a fact lives. When wiring anything into `secondaryStorage`, session storage must stay mirrored to the database (`storeSessionInDatabase: true`); losing Redis should degrade performance, not correctness or auth state.

**Features own their vertical slice.** Code is organized by domain (`features/auth`, `features/todo`), not by technical layer (no global `controllers/`, `services/`, `models/`). Each feature owns its routes, use-cases, middleware, and schemas. A new feature should be addable without touching unrelated ones.

**Use-cases are the unit of business logic, routes are glue.** Route handlers stay thin: validate input, check permission, call one use-case function, map the result to an HTTP response. Each use-case does one DB operation, documents its assumptions (validation already happened, must be wrapped by the caller), and returns `T | null` rather than throwing on "not found."

**Errors are values, not control flow.** `tryCatch` turns exceptions into `[result, error]` tuples at every I/O boundary. This keeps failure handling explicit and uniform — every route logs with a dot-scoped name (`todo.add`, `auth.permission.todo.create`) and meta, then returns a deliberate status code (`404`, `422`, `403`, `429`, `500`), instead of letting errors bubble unpredictably.

**The schema is the single source of truth.** Drizzle table definitions generate the Zod validators (`drizzle-zod`) and the TypeScript types (`z.infer`). There's one place to change a field, not three places that can drift out of sync.

**Authorization is capability-based, not just role-based.** better-auth's access-control plugin checks specific permissions (`todo:create`, `todo:delete`) rather than only branching on `role === "admin"`. Roles are just named bundles of capabilities — adding a new role shouldn't require touching route code.

**Fail fast on configuration.** All env vars are validated at boot (`@t3-oss/env-core` + Zod). A missing or malformed var should crash on startup, not produce a confusing runtime error three requests later.

**Rate limiting matches the actual risk, not a blanket rule.** Pre-auth endpoints (sign-in, sign-up) are limited per-IP by better-auth itself, since there's no session yet to key on. Authenticated mutations are limited per-user, since IP-based limiting would punish shared networks for one abusive account. Reads stay unlimited unless there's a reason otherwise.

**Prefer the platform over a dependency.** Bun's built-ins (`Bun.redis`, `Bun.sql`, `bun:test`) are used directly instead of `ioredis`, `pg`, or a test framework. Dependencies are added when they solve something the platform genuinely doesn't (Hono for routing, better-auth for auth, Drizzle for the query layer, Zod for validation, pino for structured/leveled logging) — not by default.

## Stack

- **Runtime:** Bun
- **Framework:** Hono
- **Auth:** better-auth (email/password, admin plugin, access-control roles)
- **Payments:** Stripe — admin-created plans, subscriptions and one-time Checkout via better-auth's stripe plugin
- **Database:** Postgres via Drizzle ORM (`drizzle-orm/bun-sql`)
- **Cache / rate limiting:** Redis via `Bun.redis`
- **Logging:** pino, shared by request logging (`hono-pino`) and app/error logging — structured JSON in production, pretty-printed in development, level set via `LOG_LEVEL`. Every request gets an id (`hono/request-id`, returned as `X-Request-Id`) that's attached to its log lines as `reqId`, so one request's lines can be grepped together.

## Local development

```sh
cp .env.example .env      # fill in BETTER_AUTH_SECRET, DB_*, etc.
docker compose up -d      # Postgres + Redis
bun install
bun run dev                # bun run --hot src/index.ts
```

Seed an admin user with `./src/features/auth/lib/seed-admin.sh` (creates `admin@verified.com` with the `admin` role via better-auth's CLI).

See `CLAUDE.md` for Bun-specific conventions (APIs to prefer, testing).

## Testing

```sh
docker compose exec postgres psql -U admin -d backend -c "CREATE DATABASE backend_test"   # one-time
bun run db:test:push   # re-run after schema changes
bun run test
```

Always use `bun run test`, not bare `bun test` — the script points DB-integration tests at `backend_test` and Redis-dependent tests at Redis db index 1, instead of dev's. See `CLAUDE.md`'s Testing section for what's covered so far and what isn't yet.

## Running with Docker

`docker build -t backend .` produces a production image (multi-stage: `bun install --production` in its own layer, so it's only re-run when `bun.lock` changes). It expects every env var in `.env.example` to be set — e.g. `--env-file .env` — and listens on `SERVER_PORT` (`EXPOSE 8000` matches the example default). `compose.yaml` only provisions Postgres and Redis for local dev; it doesn't define a service for this image.

## Client usage

`src/index.ts` exports `AppType`, so a TS client gets full request/response type inference for free via `hono/client`, no codegen or OpenAPI spec needed:

```ts
import { hc } from "hono/client";
import type { AppType } from "../backend/src"; // wherever this repo lives relative to the client

const client = hc<AppType>("http://localhost:8000");
const res = await client.api.todo.$get();
```

Covers `/todo` and `/payments`. `/auth` is in there too but untyped — better-auth's own handler returns a raw `Response`, so use better-auth's own client (`createAuthClient`) for that surface instead.

## Logs in production

In production, pino writes structured JSON to stdout and keeps nothing itself. To make logs durable, ship stdout from the platform rather than from the app: a Docker logging driver, a Kubernetes collector (Fluent Bit, Vector), or a host's log drain, into a store such as Loki, Elasticsearch/OpenSearch, CloudWatch, Datadog or Axiom. Set retention in that store. The app stays unaware of where its logs go.

If a project needs the app to ship logs itself, add a pino transport (`pino-roll` for rotating files, `pino-loki`, `pino-elasticsearch`, `@axiomhq/pino`, …) in `src/lib/logger.ts`, next to the dev-only `pino-pretty` one. The right target varies per deployment, so the template doesn't pick one.

Shipped logs make a convenience-grade audit trail: good for "who did what last Tuesday", but not for compliance. See `AUDITING.md`.
