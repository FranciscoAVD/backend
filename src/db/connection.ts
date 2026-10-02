import { drizzle } from "drizzle-orm/bun-sql";
import { DB_URL } from "@/db/url";

export { DB_URL };
export const db = drizzle(DB_URL);
