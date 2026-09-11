import { describe, it, expect } from "vitest";
import { fallbackTestUrl, isProtectedDatabase } from "./db-guard.js";

describe("fallbackTestUrl", () => {
  it("rewrites the compose database name to loom_test, keeping host/credentials", () => {
    expect(fallbackTestUrl("postgres://loom:loom@localhost:5432/loom"))
      .toBe("postgres://loom:loom@localhost:5432/loom_test");
  });

  it("rewrites any database name, not just loom", () => {
    expect(fallbackTestUrl("postgres://u:p@db.example.com:5432/somedb"))
      .toBe("postgres://u:p@db.example.com:5432/loom_test");
  });
});

describe("isProtectedDatabase", () => {
  it("flags the compose application database", () => {
    expect(isProtectedDatabase("postgres://loom:loom@localhost:5432/loom")).toBe(true);
  });

  it("does not flag the dedicated test database", () => {
    expect(isProtectedDatabase("postgres://loom:loom@localhost:5432/loom_test")).toBe(false);
  });

  it("does not flag a testcontainer URL", () => {
    expect(isProtectedDatabase("postgres://test:test@localhost:54923/test")).toBe(false);
  });

  it("is not fooled by a protected name elsewhere in the URL", () => {
    expect(isProtectedDatabase("postgres://loom:loom@loom:5432/loom_test")).toBe(false);
  });
});
