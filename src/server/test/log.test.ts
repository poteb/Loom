import { describe, it, expect, vi, afterEach } from "vitest";
import { inspect } from "node:util";
import { logError, redact } from "../src/log.js";

afterEach(() => { vi.restoreAllMocks(); });

/** What the spied console.error would actually have rendered, as one string. */
function joined(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n");
}

const SENTINEL = "S3nt1nel".padEnd(43, "x");   // token-shaped: 43 chars of base64url

describe("redact", () => {
  it("replaces token-shaped runs", () => {
    expect(redact(`before ${SENTINEL} after`)).toBe("before [redacted] after");
    expect(redact(SENTINEL)).not.toContain(SENTINEL);
    expect(redact("short-token")).toBe("short-token");
  });
  it("replaces URL credentials", () => {
    expect(redact("postgres://loom:hunter2@db/loom")).toBe("postgres://[redacted]@db/loom");
    expect(redact("connect to postgres://u:p@h:5432/d now")).toBe("connect to postgres://[redacted]@h:5432/d now");
    expect(redact("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("logError", () => {
  it("logs identity but never the statement, its parameters or its detail", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("ctx", Object.assign(new Error("duplicate key"), {
      code: "23505",
      parameters: ["sekret-token-value"],
      query: "insert ... sekret-token-value",
      detail: "Key (token)=(sekret-token-value)",
    }));
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = joined(spy);
    expect(logged).toContain("ctx");
    expect(logged).toContain("23505");
    expect(logged).toContain("duplicate key");
    expect(logged).not.toContain("sekret-token-value");
    expect(logged.split("\n")).toHaveLength(1);
  });

  it("redacts secrets in the message and drops every other property and the stack's message line", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(
      new Error(`connect ${SENTINEL} via postgres://loom:hunter2@db/loom`),
      {
        code: "28P01",
        parameters: ["driver-sentinel"],
        query: "select * from keepers where token = $1",
        detail: "Key (token)=(driver-sentinel)",
        hint: "driver-sentinel",
        where: "driver-sentinel",
      },
    );
    const stackMessageLine = (err.stack ?? "").split("\n")[0]!;
    logError("db failed", err);
    const logged = joined(spy);
    expect(logged).toContain("db failed");
    expect(logged).toContain("Error");
    expect(logged).toContain("28P01");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("driver-sentinel");
    expect(logged).not.toContain(stackMessageLine);
    expect(logged).toContain("at ");   // stack frames are still there
  });

  it("does not print a thrown non-error value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logError("ctx", "sekret-token-value")).not.toThrow();
    expect(joined(spy)).not.toContain("sekret-token-value");
  });
});
