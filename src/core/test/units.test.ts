import { describe, it, expect } from "vitest";
import { LoomError, errors } from "../src/errors.js";
import { newId, newSecret } from "../src/ids.js";
import { validateName } from "../src/names.js";
import { parseMentions } from "../src/mentions.js";

describe("errors", () => {
  it("carries a code", () => {
    const e = errors.weaveArchived();
    expect(e).toBeInstanceOf(LoomError);
    expect(e.code).toBe("weave_archived");
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe("ids", () => {
  it("secret is 43 chars base64url", () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(s);
  });
  it("id is a uuid", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("validateName", () => {
  it("accepts allowed names", () => {
    expect(validateName("Claude_Code-1.0")).toBe("Claude_Code-1.0");
  });
  it("trims", () => {
    expect(validateName("  Paw ")).toBe("Paw");
  });
  it.each(["", "a b", "x".repeat(33), "ø", "@paw"])("rejects %j", (n) => {
    expect(() => validateName(n)).toThrow(LoomError);
    try { validateName(n); } catch (e) { expect((e as LoomError).code).toBe("validation"); }
  });
});

describe("parseMentions", () => {
  const ps = [{ id: "p1", name: "Claude" }, { id: "p2", name: "ChatGPT" }, { id: "p3", name: "Paw.B" }];
  it("resolves case-insensitively", () => {
    expect(parseMentions("hey @claude and @CHATGPT", ps)).toEqual(["p1", "p2"]);
  });
  it("requires a word boundary after the name", () => {
    expect(parseMentions("@Claudette", ps)).toEqual([]);
    expect(parseMentions("@Claude, yes", ps)).toEqual(["p1"]);
    expect(parseMentions("(@Claude)", ps)).toEqual(["p1"]);
  });
  it("handles dots in names", () => {
    expect(parseMentions("ping @paw.b.", ps)).toEqual(["p3"]);
  });
  it("dedupes and ignores unknown", () => {
    expect(parseMentions("@Claude @Claude @nobody", ps)).toEqual(["p1"]);
  });
  it("ignores emails", () => {
    expect(parseMentions("mail me@Claude", ps)).toEqual([]);
  });
});
