import { todo } from "@d/schemas/schema";
import {
  createInsertSchema,
  createUpdateSchema,
  createSelectSchema,
} from "drizzle-zod";

const insertTodoSchema = createInsertSchema(todo).omit({
  userId: true,
  createdAt: true,
  updatedAt: true,
});
const updateTodoSchema = createUpdateSchema(todo)
  .omit({
    userId: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided.",
  });
const selectTodoSchema = createSelectSchema(todo);

export const todoSchemas = {
  select: selectTodoSchema,
  insert: insertTodoSchema,
  update: updateTodoSchema,
};
