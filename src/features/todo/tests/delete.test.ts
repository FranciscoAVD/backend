import { describe, expect, test, beforeEach } from "bun:test";
import { deleteTodo } from "@f/todo/use-cases/delete";
import { addTodo } from "@f/todo/use-cases/add";
import { getTodo } from "@f/todo/use-cases/get";
import { resetDb, seedUser } from "@/test-helpers/db";

describe("deleteTodo", () => {
  beforeEach(resetDb);

  test("deletes the todo, and it's no longer retrievable", async () => {
    const userId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await deleteTodo({ id: created!.id, userId });
    expect(res?.id).toBe(created!.id);

    const after = await getTodo({ id: created!.id, userId });
    expect(after).toBeNull();
  });

  test("returns null when the todo belongs to a different user, and leaves it intact", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await deleteTodo({ id: created!.id, userId: otherUserId });
    expect(res).toBeNull();

    const stillThere = await getTodo({ id: created!.id, userId });
    expect(stillThere).not.toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userId = await seedUser();
    const res = await deleteTodo({ id: 999999, userId });
    expect(res).toBeNull();
  });
});
