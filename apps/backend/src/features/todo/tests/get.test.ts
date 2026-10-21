import { describe, expect, test, beforeEach } from "bun:test";
import { getTodo, getAllTodos } from "@backend/f/todo/use-cases/get";
import { addTodo } from "@backend/f/todo/use-cases/add";
import { resetDb, seedUser } from "@backend/test-helpers/db";

describe("getTodo", () => {
  beforeEach(resetDb);

  test("returns the todo when it belongs to the given user", async () => {
    const userId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await getTodo({ id: created!.id, userId });
    expect(res?.id).toBe(created!.id);
  });

  test("returns null for a todo belonging to a different user", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const created = await addTodo({ userId }, { name: "task" });

    const res = await getTodo({ id: created!.id, userId: otherUserId });
    expect(res).toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userId = await seedUser();
    const res = await getTodo({ id: 999999, userId });
    expect(res).toBeNull();
  });
});

describe("getAllTodos", () => {
  beforeEach(resetDb);

  test("returns only the given user's todos", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    await addTodo({ userId }, { name: "mine" });
    await addTodo({ userId: otherUserId }, { name: "not mine" });

    const res = await getAllTodos({ userId });
    expect(res).toHaveLength(1);
    expect(res[0]?.name).toBe("mine");
  });

  test("returns an empty array when the user has no todos", async () => {
    const userId = await seedUser();
    const res = await getAllTodos({ userId });
    expect(res).toEqual([]);
  });
});
