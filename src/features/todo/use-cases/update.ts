import { db } from "@d/connection";
import { todo as todoTable } from "@d/schemas/schema";
import type { Todo } from "@f/todo/lib/types";
import { eq, and } from "drizzle-orm";

/**
 * @description Update query for todo with a matching todo ID and user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param todo object of todo ID and user ID enforced by Pick<Todo, "id" | "userID">
 * @param update object of updated fields. Some fields can't be updated and is enforced by Todo.Update
 * @returns Object containing the updated todo's ID, or null. If null, the query couldn't find a todo for the given constraints.
 */
export async function updateTodo(
  todo: Pick<Todo, "id" | "userID">,
  update: Todo.Update,
): Promise<Pick<Todo, "id"> | null> {
  const res = await db
    .update(todoTable)
    .set(update)
    .where(and(eq(todoTable.id, todo.id), eq(todoTable.userID, todo.userID)))
    .returning({ id: todoTable.id });
  return res[0] ?? null;
}
