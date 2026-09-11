import { db } from "@d/connection";
import { todo as todoTable } from "@d/schemas/schema";
import type { Todo } from "@f/todo/lib/types";

/**
 * @description Insert query for todo. Assumes validation. Operation must be wrapped in try-catch
 * @param user object of user ID enforced by Pick<Todo, "userID">
 * @param todo object of insert fields enforced by Todo.Insert
 * @returns Todo object or null. If null, the insert didn't return a row.
 */
export async function addTodo(
  user: Pick<Todo, "userID">,
  todo: Todo.Create,
): Promise<Todo | null> {
  const res = await db
    .insert(todoTable)
    .values({ ...todo, userID: user.userID })
    .returning();
  return res[0] ?? null;
}
