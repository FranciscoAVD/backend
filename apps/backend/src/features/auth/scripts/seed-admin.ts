/**
 * @description Creates an initial admin user by calling the admin plugin's createUser
 * endpoint directly through this app's own `auth` instance. The `auth@latest create-admin`
 * CLI can't be used here: it loads the auth config through jiti, which can't resolve the
 * `bun` built-in that `drizzle-orm/bun-sql` (this app's DB driver) needs - that only exists
 * under Bun's own module loader, so running this as a real Bun script is required.
 *
 * Usage: bun run db:seed-admin -- --email admin@example.com --password <password> [--name Admin] [--role admin] [--yes]
 */
import { parseArgs } from "node:util";
import { auth } from "@backend/f/auth/auth";
import { logger } from "@backend/lib/logger";
import tryCatch from "@vicstack/try-catch";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string", default: "Admin" },
    role: { type: "string", default: "admin" },
    yes: { type: "boolean", default: false },
  },
});

const roles = ["admin", "user"] as const;

if (!values.email || !values.password || !roles.includes(values.role as (typeof roles)[number])) {
  console.error(
    "Usage: bun run db:seed-admin -- --email <email> --password <password> [--name <name>] [--role admin|user] [--yes]"
  );
  process.exit(1);
}
const role = values.role as (typeof roles)[number];

const totalUsers = await (await auth.$context).internalAdapter.countTotalUsers();
if (totalUsers > 0 && !values.yes) {
  console.error(`Found ${totalUsers} existing user(s). Re-run with --yes to create an admin anyway.`);
  process.exit(1);
}

const [result, error] = await tryCatch(
  auth.api.createUser({
    body: {
      email: values.email,
      password: values.password,
      name: values.name,
      role,
      data: { emailVerified: true },
    },
  })
);

if (error) {
  logger.error({ err: error }, "auth.seed-admin.create");
  process.exit(1);
}

logger.info(
  { userId: result.user?.id, email: result.user?.email, role: result.user?.role },
  "auth.seed-admin.created"
);
process.exit(0);
