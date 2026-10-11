import { describe, expect, test, beforeEach } from "bun:test";
import { updateTodo } from "@f/todo/use-cases/update";
import { addTodo } from "@f/todo/use-cases/add";
import { getTodo } from "@f/todo/use-cases/get";
import { resetDb, seedUser } from "@/test-helpers/db";

describe("updateTodo", () => {
  beforeEach(resetDb);

  test("updates fields and persists them", async () => {
    const userID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await updateTodo(
      { id: created!.id, userID },
      { isComplete: true },
    );
    expect(res?.id).toBe(created!.id);

    const after = await getTodo({ id: created!.id, userID });
    expect(after?.isComplete).toBe(true);
  });

  test("returns null when the todo belongs to a different user", async () => {
    const userID = await seedUser();
    const otherUserID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await updateTodo(
      { id: created!.id, userID: otherUserID },
      { isComplete: true },
    );
    expect(res).toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userID = await seedUser();
    const res = await updateTodo({ id: 999999, userID }, { isComplete: true });
    expect(res).toBeNull();
  });
});
