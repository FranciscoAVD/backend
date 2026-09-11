# Resource conventions

When adding a new DB-backed resource (routes/use-cases/schemas, following the `features/todo` pattern):

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
  - Read/delete actions that need no payload instead take `Pick<Resource, "id" | "userID">` off the bare entity type, since they only need identifying fields.

Don't reach for this namespace pattern for things that aren't DB-backed resources with insert/update/select variants (middleware options, adapter contracts like better-auth's `secondaryStorage`) — a plain type is correct there.

# Logging

When a route or use-case needs to log something (a caught error, a noteworthy state), use the shared pino instance from `@/lib/logger` — don't reach for `console.log`/`console.error`.

- Call pino's native API directly: `logger.error(mergingObject, msg)`, `logger.warn(...)`, `logger.info(...)`, etc. There is no custom wrapper — `@/lib/logger` just exports the configured `pino()` instance.
- The message (second argument) is a dot-scoped name identifying the call site, e.g. `"todo.add"`, `"auth.permission.todo.create"` (see `features/todo/routes/todo.ts` for the established scope-naming convention).
- Put the error under the `err` key in the merging object (`{ err: error, ...meta }`) — pino's default serializer expands `.message`/`.stack` from that key in both dev (pretty) and prod (JSON) output.
- Log level and dev/prod formatting (pretty vs. raw JSON) are controlled centrally in `src/lib/logger.ts` via `LOG_LEVEL`/`NODE_ENV` — don't configure logging per call site.

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
