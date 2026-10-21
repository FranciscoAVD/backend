import { db } from "@backend/d/connection";
import { todo as todoTable } from "@backend/d/schemas/schema";
import type { Todo } from "@backend/f/todo/lib/types";

/**
 * @description Insert query for todo. Assumes validation. Operation must be wrapped in try-catch
 * @param user object of user ID enforced by Pick<Todo, "userId">
 * @param todo object of insert fields enforced by Todo.Insert
 * @returns Todo object or null. If null, the insert didn't return a row.
 */
export async function addTodo(
  user: Pick<Todo, "userId">,
  todo: Todo.Insert,
): Promise<Todo | null> {
  const res = await db
    .insert(todoTable)
    .values({ ...todo, userId: user.userId })
    .returning();
  return res[0] ?? null;
}
