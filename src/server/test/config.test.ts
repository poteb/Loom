import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "B_-9".padEnd(43, "z");

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: ` ${TOKEN_A} , ${TOKEN_B} ,, ` });
    expect(c).toEqual({ port: 3000, databaseUrl: "postgres://x", keeperTokens: [TOKEN_A, TOKEN_B] });
  });
  it("accepts no keeper tokens at all", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).keeperTokens).toEqual([]);
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: "" }).keeperTokens).toEqual([]);
  });
  it.each(["change-me", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`])(
    "rejects a keeper token that is not 43-char base64url: %j", (token) => {
      expect(() => loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: token }))
        .toThrow(/43-character base64url/);
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
