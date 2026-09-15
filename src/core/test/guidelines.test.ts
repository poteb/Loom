import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { DEFAULT_INSTANCE_GUIDELINES } from "../src/guidelines-default.js";
import { MAX_GUIDELINES_LENGTH, validateGuidelines, guidelinesFor, getInstanceGuidelines } from "../src/guidelines.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { seedKeepers } from "../src/keepers.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("validateGuidelines", () => {
  it("trims and accepts up to the limit", () => {
    expect(validateGuidelines("  hi  ")).toBe("hi");
    expect(validateGuidelines("x".repeat(MAX_GUIDELINES_LENGTH))).toHaveLength(4000);
  });
  it("rejects one character over the limit with validation", () => {
    expect(() => validateGuidelines("x".repeat(4001))).toThrow(expect.objectContaining({ code: "validation" }));
  });
  it("whitespace-only clears", () => {
    expect(validateGuidelines("  \n\t ")).toBe("");
  });
});

describe("guidelinesFor", () => {
  it("composes both layers under fixed headings, joined by a blank line", () => {
    expect(guidelinesFor("be kind", { guidelines: "one PR per Thread" }))
      .toBe("## Loom guidelines\nbe kind\n\n## Guidelines for this Weave\none PR per Thread");
  });
  it("instance only, weave only, neither", () => {
    expect(guidelinesFor("be kind")).toBe("## Loom guidelines\nbe kind");
    expect(guidelinesFor("", { guidelines: "w" })).toBe("## Guidelines for this Weave\nw");
    expect(guidelinesFor("", { guidelines: "" })).toBe("");
  });
});

describe("instance guidelines", () => {
  it("ships a non-empty default under the limit and reads it publicly", async () => {
    expect(DEFAULT_INSTANCE_GUIDELINES.length).toBeGreaterThan(0);
    expect(DEFAULT_INSTANCE_GUIDELINES.length).toBeLessThan(MAX_GUIDELINES_LENGTH);
    expect(await getInstanceGuidelines(db)).toBe(DEFAULT_INSTANCE_GUIDELINES);
    expect((await getSettings(db)).guidelines).toBe(DEFAULT_INSTANCE_GUIDELINES);
  });
  it("a keeper patch sets, rejects 4001 chars, and clears with an empty string", async () => {
    await seedKeepers(db, [keeperToken("k")]);
    const k = await resolveCredential(db, keeperToken("k"));
    expect((await updateSettings(db, k, { guidelines: " reply in thread " })).guidelines).toBe("reply in thread");
    expect(await getInstanceGuidelines(db)).toBe("reply in thread");
    await expect(updateSettings(db, k, { guidelines: "x".repeat(4001) })).rejects.toMatchObject({ code: "validation" });
    expect((await updateSettings(db, k, { guidelines: "" })).guidelines).toBe("");
    expect(await getInstanceGuidelines(db)).toBe("");
  });
});
