import { describe, it, expect, vi, afterEach } from "vitest";
import { inspect } from "node:util";
import { logError } from "../src/log.js";

afterEach(() => { vi.restoreAllMocks(); });

/** What the spied console.error would actually have rendered, as one string. */
function joined(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n");
}

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

  it("does not print a thrown non-error value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("ctx", "sekret-token-value");
    expect(joined(spy)).not.toContain("sekret-token-value");
  });
});
