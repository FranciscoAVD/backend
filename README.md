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
- **Database:** Postgres via Drizzle ORM (`drizzle-orm/bun-sql`)
- **Cache / rate limiting:** Redis via `Bun.redis`
- **Logging:** pino, shared by request logging (`hono-pino`) and app/error logging — structured JSON in production, pretty-printed in development, level set via `LOG_LEVEL`

## Local development

```sh
docker compose up -d      # Postgres + Redis
bun install
bun run dev                # bun run --hot src/index.ts
```

Seed an admin user with `./src/features/auth/lib/seed-admin.sh` (creates `admin@verified.com` with the `admin` role via better-auth's CLI).

See `CLAUDE.md` for Bun-specific conventions (APIs to prefer, testing).
