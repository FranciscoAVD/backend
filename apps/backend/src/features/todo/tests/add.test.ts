import { describe, expect, test, beforeEach } from "bun:test";
import { addTodo } from "@backend/f/todo/use-cases/add";
import { resetDb, seedUser } from "@backend/test-helpers/db";

describe("addTodo", () => {
  beforeEach(resetDb);

  test("inserts a todo scoped to the given user", async () => {
    const userId = await seedUser();
    const res = await addTodo({ userId }, { name: "write tests" });

    expect(res).not.toBeNull();
    expect(res?.name).toBe("write tests");
    expect(res?.userId).toBe(userId);
  });

  test("defaults isComplete to false when not provided", async () => {
    const userId = await seedUser();
    const res = await addTodo({ userId }, { name: "another task" });

    expect(res?.isComplete).toBe(false);
  });
});
