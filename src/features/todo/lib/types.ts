import {
  insertTodoSchema,
  updateTodoSchema,
  selectTodoSchema,
} from "@f/todo/lib/schemas";
import { z } from "zod";

export namespace Todo {
  export type Create = z.infer<typeof insertTodoSchema>;
  export type Update = z.infer<typeof updateTodoSchema>;
}
export type Todo = z.infer<typeof selectTodoSchema>;
