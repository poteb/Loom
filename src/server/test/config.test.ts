import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "B_-9".padEnd(43, "z");

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: ` ${TOKEN_A} , ${TOKEN_B} ,, ` });
    expect(c).toEqual({
      port: 3000,
      host: "127.0.0.1",
      databaseUrl: "postgres://x",
      keeperTokens: [TOKEN_A, TOKEN_B],
      webDist: undefined,
    });
  });
  it("reads LOOM_WEB_DIST", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_WEB_DIST: "/srv/web" }).webDist).toBe("/srv/web");
  });
  it("defaults host to loopback only", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).host).toBe("127.0.0.1");
  });
  it("honors LOOM_HOST", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_HOST: "::1" }).host).toBe("::1");
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
  it("rejects duplicate keeper tokens", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: `${TOKEN_A},${TOKEN_B},${TOKEN_A}` }))
      .toThrow(/duplicate/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: ` ${TOKEN_A} , ${TOKEN_A}` }))
      .toThrow("LOOM_KEEPER_TOKENS contains duplicate tokens");
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
