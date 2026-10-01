import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin } from "better-auth/plugins/admin";
import { db } from "@d/connection";
import * as schema from "@d/schemas/auth-schema";
import { env } from "@/env";
import { authSecondaryStorage } from "@f/auth/lib/secondary-storage";
import { ac, user, admin } from "@f/auth/lib/permissions";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  trustedOrigins: [env.CLIENT_URL],
  secondaryStorage: authSecondaryStorage,
  session: {
    // without this, secondaryStorage becomes the only session store
    storeSessionInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    adminPlugin({
      ac,
      roles: {
        user,
        admin,
      },
    }),
  ],
});
