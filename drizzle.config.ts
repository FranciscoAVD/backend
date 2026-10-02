import { DB_URL } from "@/db/url";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schemas/*",
  dbCredentials: {
    url: DB_URL,
  },
  dialect: "postgresql",
});
