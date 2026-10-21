import { describe, expect, test, beforeEach } from "bun:test";
import { updateTodo } from "@backend/f/todo/use-cases/update";
import { addTodo } from "@backend/f/todo/use-cases/add";
import { getTodo } from "@backend/f/todo/use-cases/get";
import { resetDb, seedUser } from "@backend/test-helpers/db";

describe("updateTodo", () => {
  beforeEach(resetDb);

  test("updates fields and persists them", async () => {
    const userId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await updateTodo(
      { id: created!.id, userId },
      { isComplete: true },
    );
    expect(res?.id).toBe(created!.id);

    const after = await getTodo({ id: created!.id, userId });
    expect(after?.isComplete).toBe(true);
  });

  test("returns null when the todo belongs to a different user", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await updateTodo(
      { id: created!.id, userId: otherUserId },
      { isComplete: true },
    );
    expect(res).toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userId = await seedUser();
    const res = await updateTodo({ id: 999999, userId }, { isComplete: true });
    expect(res).toBeNull();
  });
});
