import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: " a , b ,, " });
    expect(c).toEqual({ port: 3000, databaseUrl: "postgres://x", keeperTokens: ["a", "b"] });
  });
  it("requires DATABASE_URL and a numeric PORT", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "x", PORT: "abc" })).toThrow(/PORT/);
  });
  it.each(["abc", "0", "-1", "1.5", "Infinity", "65536"])("rejects PORT=%j", (port) => {
    expect(() => loadConfig({ DATABASE_URL: "x", PORT: port })).toThrow(/PORT/);
  });
  it("accepts the top of the port range", () => {
    expect(loadConfig({ DATABASE_URL: "x", PORT: "65535" }).port).toBe(65535);
  });
});
