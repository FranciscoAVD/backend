import { describe, expect, test, beforeEach } from "bun:test";
import { getTodo, getAllTodos } from "@f/todo/use-cases/get";
import { addTodo } from "@f/todo/use-cases/add";
import { resetDb, seedUser } from "@/test-helpers/db";

describe("getTodo", () => {
  beforeEach(resetDb);

  test("returns the todo when it belongs to the given user", async () => {
    const userID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await getTodo({ id: created!.id, userID });
    expect(res?.id).toBe(created!.id);
  });

  test("returns null for a todo belonging to a different user", async () => {
    const userID = await seedUser();
    const otherUserID = await seedUser();
    const created = await addTodo({ userID }, { name: "task" });

    const res = await getTodo({ id: created!.id, userID: otherUserID });
    expect(res).toBeNull();
  });

  test("returns null for a nonexistent id", async () => {
    const userID = await seedUser();
    const res = await getTodo({ id: 999999, userID });
    expect(res).toBeNull();
  });
});

describe("getAllTodos", () => {
  beforeEach(resetDb);

  test("returns only the given user's todos", async () => {
    const userID = await seedUser();
    const otherUserID = await seedUser();
    await addTodo({ userID }, { name: "mine" });
    await addTodo({ userID: otherUserID }, { name: "not mine" });

    const res = await getAllTodos({ userID });
    expect(res).toHaveLength(1);
    expect(res[0]?.name).toBe("mine");
  });

  test("returns an empty array when the user has no todos", async () => {
    const userID = await seedUser();
    const res = await getAllTodos({ userID });
    expect(res).toEqual([]);
  });
});
