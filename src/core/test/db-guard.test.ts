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

  it("flags the Spool application database on the same box", () => {
    expect(isProtectedDatabase("postgres://spool:spool@localhost:5432/spool")).toBe(true);
  });

  it("flags the live instance database", () => {
    expect(isProtectedDatabase("postgres://loom:loom@localhost:5432/loom_live")).toBe(true);
  });

  it("flags the server's own postgres database", () => {
    expect(isProtectedDatabase("postgres://loom:loom@localhost:5432/postgres")).toBe(true);
  });

  it("flags a URL that does not parse, because a truncate guard must fail closed", () => {
    expect(isProtectedDatabase("not a url")).toBe(true);
  });

  it("does not flag the dedicated test database", () => {
    expect(isProtectedDatabase("postgres://loom:loom@localhost:5432/loom_test")).toBe(false);
  });

  it("does not flag any other database whose name ends in _test", () => {
    expect(isProtectedDatabase("postgres://u:p@localhost:5432/migrations7_test")).toBe(false);
  });

  it("does not flag the named testcontainer URL", () => {
    expect(isProtectedDatabase("postgres://test:test@localhost:54923/loom_test")).toBe(false);
  });

  it("flags the unnamed testcontainer's default database, `test`", () => {
    expect(isProtectedDatabase("postgres://test:test@localhost:54923/test")).toBe(true);
  });

  it("is not fooled by a protected name elsewhere in the URL", () => {
    expect(isProtectedDatabase("postgres://loom:loom@loom:5432/loom_test")).toBe(false);
  });
});
