import { todo } from "@d/schemas/schema";
import {
  createInsertSchema,
  createUpdateSchema,
  createSelectSchema,
} from "drizzle-zod";

export const insertTodoSchema = createInsertSchema(todo).omit({
  userID: true,
  createdAt: true,
  updatedAt: true,
});
export const updateTodoSchema = createUpdateSchema(todo)
  .omit({
    userID: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided.",
  });
export const selectTodoSchema = createSelectSchema(todo);
