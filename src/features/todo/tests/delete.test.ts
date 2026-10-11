import { describe, expect, test, beforeEach } from "bun:test";
import { deleteTodo } from "@f/todo/use-cases/delete";
import { addTodo } from "@f/todo/use-cases/add";
import { getTodo } from "@f/todo/use-cases/get";
import { resetDb, seedUser } from "@/test-helpers/db";

describe("deleteTodo", () => {
  beforeEach(resetDb);

  test("deletes the todo, and it's no longer retrievable", async () => {
    const userID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await deleteTodo({ id: created!.id, userID });
    expect(res?.id).toBe(created!.id);

    const after = await getTodo({ id: created!.id, userID });
    expect(after).toBeNull();
  });

  test("returns null when the todo belongs to a different user, and leaves it intact", async () => {
    const userID = await seedUser();
    const otherUserID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await deleteTodo({ id: created!.id, userID: otherUserID });
    expect(res).toBeNull();

    const stillThere = await getTodo({ id: created!.id, userID });
    expect(stillThere).not.toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userID = await seedUser();
    const res = await deleteTodo({ id: 999999, userID });
    expect(res).toBeNull();
  });
});
