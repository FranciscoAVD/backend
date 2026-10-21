import { describe, expect, test } from "bun:test";
import {
  assertTestDatabaseName,
  assertTestRedisDb,
  parseClientInfoDb,
} from "@backend/test-helpers/guard";

describe("test-helper guard", () => {
  test("only a database named *_test may be reset", () => {
    expect(() => assertTestDatabaseName("backend_test")).not.toThrow();
    expect(() => assertTestDatabaseName("backend")).toThrow(/Refusing/);
    expect(() => assertTestDatabaseName("backend_test_old")).toThrow(/Refusing/);
    expect(() => assertTestDatabaseName("undefined")).toThrow(/Refusing/);
  });

  test("reads the selected db index out of CLIENT INFO", () => {
    const info = "id=3 addr=127.0.0.1:5000 laddr=127.0.0.1:6379 fd=8 name= db=1 sub=0 psub=0";
    expect(parseClientInfoDb(info)).toBe(1);
    expect(parseClientInfoDb("id=3 db=12 sub=0\n")).toBe(12);
    // a field merely ending in "db" doesn't count
    expect(parseClientInfoDb("id=3 xdb=1 sub=0")).toBeNull();
    expect(parseClientInfoDb("")).toBeNull();
  });

  test("only Redis db 1 may be flushed", () => {
    expect(() => assertTestRedisDb(1)).not.toThrow();
    expect(() => assertTestRedisDb(0)).toThrow(/Refusing/);
    expect(() => assertTestRedisDb(null)).toThrow(/Refusing/);
  });
});
