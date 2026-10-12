import { todoSchemas } from "@f/todo/lib/schemas";
import { z } from "zod";

export namespace Todo {
  export type Insert = z.infer<typeof todoSchemas.insert>;
  export type Update = z.infer<typeof todoSchemas.update>;
}
export type Todo = z.infer<typeof todoSchemas.select>;
