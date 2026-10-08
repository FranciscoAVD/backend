import { db } from "@d/connection";
import { todo as todoTable } from "@d/schemas/schema";
import type { Todo } from "@f/todo/lib/types";
import { eq, and } from "drizzle-orm";

/**
 * @description Select query for todo with a matching todo ID and user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param todo object of todo ID and user ID enforced by Pick<Todo, "id" | "userID">
 * @returns Todo object or null. If null, the query couldn't find a todo for the given constraints.
 */
export async function getTodo(
  todo: Pick<Todo, "id" | "userID">,
): Promise<Todo | null> {
  const res = await db
    .select()
    .from(todoTable)
    .where(and(eq(todoTable.id, todo.id), eq(todoTable.userID, todo.userID)));
  return res[0] ?? null;
}

/**
 * @description Select query for all todos with a matching user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param todo object of user ID enforced by Pick<Todo, "userID">
 * @returns Array of Todos.
 */
export async function getAllTodos(todo: Pick<Todo, "userID">): Promise<Todo[]> {
  const res = await db
    .select()
    .from(todoTable)
    .where(eq(todoTable.userID, todo.userID));
  return res;
}
