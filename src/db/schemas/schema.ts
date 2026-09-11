import { relations } from "drizzle-orm";
import {
  pgTable,
  integer,
  timestamp,
  boolean,
  index,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const todo = pgTable(
  "todo",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userID: text("user_id")
      .references(() => user.id)
      .notNull(),
    name: varchar("name", { length: 50 }).notNull(),
    isComplete: boolean("is_complete").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("todo_user_idx").on(t.userID)],
);

export const todoRelations = relations(todo, ({ one }) => ({
  users: one(user, {
    fields: [todo.userID],
    references: [user.id],
  }),
}));
