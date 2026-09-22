import { describe, it, expect } from "vitest";
import { loadConfig, describeSeeding } from "../src/config.js";

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
      migrateOnBoot: true,
    });
  });
  it("defaults migrateOnBoot to true, so every existing use is unchanged with nothing set", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).migrateOnBoot).toBe(true);
  });
  it.each([
    ["true", true], ["TRUE", true], ["True", true], ["  true  ", true],
    ["false", false], ["FALSE", false], ["False", false], ["  false  ", false],
  ])("parses LOOM_MIGRATE_ON_BOOT=%j as %s", (raw, expected) => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_MIGRATE_ON_BOOT: raw }).migrateOnBoot).toBe(expected);
  });
  it.each(["0", "1", "no", "yes", "", " ", "off"])(
    "rejects LOOM_MIGRATE_ON_BOOT=%j rather than guessing a default", (raw) => {
      // The one variable whose whole job is to stop a migration: a permissive parser here is a
      // value that only reveals itself in production.
      expect(() => loadConfig({ DATABASE_URL: "postgres://x", LOOM_MIGRATE_ON_BOOT: raw }))
        .toThrow(/LOOM_MIGRATE_ON_BOOT/);
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

// The boot line the operator reads. It used to echo the configured token count ("keepers seeded: 1")
// whether or not anything was seeded, which is what hid a no-op seed during the 2026-09-15 dogfood.
describe("describeSeeding", () => {
  it("reports what was seeded", () => {
    const d = describeSeeding({ seeded: 1, existing: 0, ignored: 0 }, 1);
    expect(d.line).toBe("keepers: seeded 1 from LOOM_KEEPER_TOKENS");
    expect(d.warning).toBeUndefined();
  });
  it("says the configured tokens were ignored, and how to rotate instead", () => {
    const d = describeSeeding({ seeded: 0, existing: 1, ignored: 0 }, 1);
    expect(d.line).toContain("keepers: 1 already present, LOOM_KEEPER_TOKENS ignored");
    expect(d.line).toContain("seeding only runs on an empty table");
    expect(d.line).toContain("loom admin keepers add");
    expect(d.warning).toContain("not seeded");
  });
  it("says the admin API is unavailable when nothing is configured or present", () => {
    const d = describeSeeding({ seeded: 0, existing: 0, ignored: 0 }, 0);
    expect(d.line).toBe("keepers: none configured, none present — admin API unavailable until LOOM_KEEPER_TOKENS is set on an empty table");
    expect(d.warning).toBeUndefined();
  });
  it("stays quiet about LOOM_KEEPER_TOKENS when none are configured but keepers exist", () => {
    const d = describeSeeding({ seeded: 0, existing: 2, ignored: 0 }, 0);
    expect(d.line).toBe("keepers: 2 already present, LOOM_KEEPER_TOKENS not set");
    expect(d.warning).toBeUndefined();
  });
  it("names ignored entries and never prints a token", () => {
    const d = describeSeeding({ seeded: 1, existing: 0, ignored: 2 }, 3);
    expect(d.line).toBe("keepers: seeded 1 from LOOM_KEEPER_TOKENS (2 configured entries ignored as malformed or duplicate)");
    const allIgnored = describeSeeding({ seeded: 0, existing: 0, ignored: 1 }, 1);
    expect(allIgnored.line).toContain("every configured LOOM_KEEPER_TOKENS entry was ignored");
    expect(allIgnored.warning).toBeUndefined();
  });
});
