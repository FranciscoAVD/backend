# Resource conventions

When adding a new DB-backed resource (routes/use-cases/schemas, following the `features/todo` pattern):

- Each use-case still lives in its own file under `use-cases/`, one DB operation per file as usual. Add a `repo.ts` at the top level of the feature directory that imports every use-case and re-groups them into one exported object, `<feature>Repo` — a barrel, not a place to put logic. For a single flat resource (see `features/todo/repo.ts`), group by operation: `add`, `get: { one, all }`, `update`, `delete`. For a feature with multiple sub-resources or cross-cutting operations that don't belong to any one resource (see `features/payments/repo.ts`: `plan`, `purchase`, `checkout`), nest one level deeper by sub-resource first, operation second. Consumers (routes, other features) import the single `<feature>Repo` object and call through it (`todoRepo.add(...)`, `paymentsRepo.plan.getByName(...)`), never by reaching into `use-cases/*` directly; a use-case calling another use-case in the same feature is the one exception, and keeps importing it directly rather than through the barrel.
- A feature's router is a single top-level `route.ts` — routes are built as one continuous chained expression per the RPC/AppType convention below, so there's no multi-file routing layer to justify a directory.
- Generate Zod variants from the Drizzle table with `drizzle-zod`: `insertXSchema`, `updateXSchema`, `selectXSchema` (see `features/todo/lib/schemas.ts`).
- Nest the payload variants in a namespace named after the resource, derived via `z.infer`; the bare (non-namespaced) type is the full entity/select shape (see `features/todo/lib/types.ts`):

  ```ts
  export namespace Resource {
    export type Insert = z.infer<typeof insertResourceSchema>;
    export type Update = z.infer<typeof updateResourceSchema>;
  }
  export type Resource = z.infer<typeof selectResourceSchema>;
  ```

- Type each use-case's payload parameter by mirroring which namespace member it needs — this is the part that matters, not just having the namespace exist:
  - Create actions take the `.Insert` variant: `addResource(user, data: Resource.Insert)`.
  - Update actions take the `.Update` variant: `updateResource(target, data: Resource.Update)`.
  - Read/delete actions that need no payload instead take `Pick<Resource, "id" | "userId">` off the bare entity type, since they only need identifying fields.

Don't reach for this namespace pattern for things that aren't DB-backed resources with insert/update/select variants (middleware options, adapter contracts like better-auth's `secondaryStorage`) — a plain type is correct there.

# Logging

When something needs logging (a caught error, a noteworthy state), don't reach for `console.log`/`console.error`.

- **Inside a route handler** (has `c` in scope): use `c.var.logger`, the per-request pino child `hono-pino` attaches to the context. It's pre-bound with that request's `reqId` (set by `hono/request-id` in `src/index.ts`), so every log line for a request can be grepped together. Type the router's `Hono<...>` generic with hono-pino's `Env` (see `features/todo/route.ts`: `Hono<PinoLoggerEnv>`) so `c.var.logger` type-checks. Don't also merge in `RequireSessionEnv` there — `session`'s non-null typing should only come from chaining `.use(sessionMiddleware).use(requireSessionMiddleware)` before a handler, never from the app's own generic, or a handler placed before that middleware in the chain stops being a compile error.
- **Outside a request** (use-cases, module-level middleware wiring like `src/lib/redis.ts`/`src/lib/rate-limit.ts`'s `onError`, scripts like `payments/scripts/reconcile.ts`): use the shared global pino instance from `@/lib/logger` — there's no request/`c` to attach a `reqId` to.
- Either way, call pino's native API directly: `logger.error(mergingObject, msg)`, `.warn(...)`, `.info(...)`, etc. There is no custom wrapper.
- The message (second argument) is a dot-scoped name identifying the call site, e.g. `"todo.add"`, `"auth.permission.todo.create"` (see `features/todo/route.ts` for the established scope-naming convention).
- Put the error under the `err` key in the merging object (`{ err: error, ...meta }`) — pino's default serializer expands `.message`/`.stack` from that key in both dev (pretty) and prod (JSON) output.
- Log level and dev/prod formatting (pretty vs. raw JSON) are controlled centrally in `src/lib/logger.ts` via `LOG_LEVEL`/`NODE_ENV` — don't configure logging per call site.

# RPC / AppType

`src/index.ts` exports `AppType` (`typeof app`) for TS clients to get full request/response type inference via `hono/client`'s `hc<AppType>()`. This only works if a feature's router is built as **one continuous chained expression assigned directly to `const app`** — e.g. `const app = new Hono<PinoLoggerEnv>().use(...).get(...).post(...)` — all the way through to `export default app`. Calling `.use()`/`.get()`/etc. as a *separate* statement after `const app = new Hono()` still works at runtime (same mutated instance) but the exported `app`'s static type won't pick up those routes, so RPC inference on it silently sees nothing. Same rule applies in `src/index.ts` itself for `.route(...)` mounting a feature's router.

A conditionally-mounted router (behind an env flag, if one exists again later) can't be part of this chain without either always mounting it or lying about `AppType` — keep it as a separate statement and accept it's excluded from `AppType`, or expose its own standalone `export type <Feature>AppType = typeof app` from that feature's route file for a client that knows it's enabled.

# Testing

**Always run `bun run test`, never bare `bun test`.** The `test` script sets `DB_NAME=backend_test` and points `REDIS_URL` at db index 1; bare `bun test` falls through to `.env`'s values (the dev database, dev Redis db 0) and will truncate real dev data the moment a test file's `beforeEach(resetDb)`/`resetRedis()` runs.

- Test files live in a `tests/` folder at the top level of each feature directory (`features/<feature>/tests/<name>.test.ts`) — one folder per feature, not split by `use-cases/`/`lib/` and not co-located next to the file under test. Path aliases (`@f/...`, `@/...`) mean a test file's own location never affects what it can import.
- One-time setup per machine: `docker compose exec postgres psql -U admin -d backend -c "CREATE DATABASE backend_test"`, then `bun run db:test:push` (re-run the latter after schema changes, same as `db:push` for dev). Redis needs no setup — db index 1 just exists once anything writes to it.
- DB-integration tests import `resetDb`/`seedUser`/`seedPlan` from `src/test-helpers/db.ts`. Call `resetDb()` in a top-level `beforeEach` so every test starts from an empty database; `seedUser()`/`seedPlan()` insert the minimal valid row a use-case's FK constraints need (bypassing better-auth/Stripe entirely — these tests exercise the use-case's query logic, not auth or payment processing).
- Redis-dependent tests (`pending-checkout.ts`, the webhook) use the *real* Redis the same way DB tests use the real Postgres — call `resetRedis()` (from `src/test-helpers/redis.ts`, a `FLUSHDB` scoped to db index 1) in a top-level `beforeEach`.
- Stripe-dependent tests (`add-plan.ts`, `checkout.ts`, the webhook's `updateByCharge`) fake it instead, since there's no free local "real Stripe" the way Postgres/Redis are already running via `docker compose`: `mock.module("@f/payments/payment", () => ({ getPaymentProcessor: () => fakeClient }))`, with a hand-rolled fake implementing only the methods that file's code actually calls. Verified empirically that this correctly patches even a use-case's own *already-statically-imported* reference (Bun's `mock.module` is retroactive), and that per-file mocks of the same module path don't leak across test files in the same `bun test` run — each file gets its own fake. Call `mock.module(...)` before the use-case import in the same file (ordering in the source doesn't matter at runtime, but keep it readable).
- Pure functions (no `db`/`redis`/Stripe import in their call chain, e.g. `payments/lib/utils.ts`) need none of the above — plain `describe`/`test`/`expect`.
- Route-level HTTP tests (`payments/tests/route.test.ts`) fake `@f/auth/middleware` the same way Stripe is faked, replacing `sessionMiddleware`/`requireSessionMiddleware`/`requirePermissionMiddleware` with test doubles driven by a module-level `setSession(user, permissions)` helper in the test file; the real rate limiter and DB run for real (reset the same way as any other test). Unlike the Stripe fake, this one **must** be imported dynamically (`const { default: app } = await import("@f/payments/route")`) *after* the `mock.module(...)` call, not statically: `route.ts` calls `.use(sessionMiddleware)` at module-evaluation time, which copies the function *by value* into Hono's middleware chain immediately — a static import is hoisted above the mock regardless of where it's written, so it would still capture the real middleware. (Stripe's fake doesn't have this problem because `getPaymentProcessor()` is called fresh at request time, long after the mock is in place — not copied into a persistent structure at import time.) Since `route.ts` itself has no `pinoLogger` middleware (it relies on being mounted under `src/index.ts`'s root app in production), wrap it with one in the test too (`new Hono().use(requestId()).use(pinoLogger({ pino: logger })).route("/", app)`) so `c.var.logger` doesn't crash the handler.
- Covered: `payments/lib/utils.ts`'s pure functions; every use-case in `features/todo/use-cases/` and `features/payments/use-cases/` (including `add-plan.ts` and `checkout.ts`); `payments/lib/pending-checkout.ts` and `payments/lib/webhook.ts`; `payments` route-level tests, including `POST /checkout`'s full inline plan/repeatable/pending-checkout/audit-log sequence (auth/permission gating; the branches that live only in `route.ts` and aren't exercised by any use-case test: `GET /plans/:id/access`'s `plan.type` branch, `POST /plans`'s duplicate-name 409, `PATCH /plans/:id`'s repeatable-flip 409, and `POST /checkout`'s full happy/blocked paths with both the auth and Stripe fakes layered together). **Not yet covered:** `payments/scripts/reconcile.ts` (just its CLI arg-parsing/exit-code wrapper - the reconciliation logic it calls is already tested). `todo` has no route-level tests at all — it's the example feature, not worth the investment.

# Branches

Before starting work on a new feature, create a branch off an up-to-date `master` and do the feature's commits there, not on `master`: `git switch -c <feature-name>`, with a short kebab-case name for the feature (e.g. `payments`).

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
