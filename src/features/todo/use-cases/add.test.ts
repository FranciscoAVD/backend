import { describe, expect, test, beforeEach } from "bun:test";
import { addTodo } from "@f/todo/use-cases/add";
import { resetDb, seedUser } from "@/test-helpers/db";

describe("addTodo", () => {
  beforeEach(resetDb);

  test("inserts a todo scoped to the given user", async () => {
    const userID = await seedUser();
    const res = await addTodo({ userID }, { name: "write tests" });

    expect(res).not.toBeNull();
    expect(res?.name).toBe("write tests");
    expect(res?.userID).toBe(userID);
  });

  test("defaults isComplete to false when not provided", async () => {
    const userID = await seedUser();
    const res = await addTodo({ userID }, { name: "another task" });

    expect(res?.isComplete).toBe(false);
  });
});
