import { describe, it, expect, expectTypeOf } from "vitest";
import { LoomError, errors, ERROR_CODES } from "../src/errors.js";
import { EVENT_TYPES, type EventType } from "../src/types.js";
import { newId, newSecret, isUuid } from "../src/ids.js";
import { validateName } from "../src/names.js";
import { parseMentions } from "../src/mentions.js";
import { isNameTakenViolation } from "../src/weaves.js";
import { MAX_PAGE_LIMIT, validatePage } from "../src/paging.js";

describe("errors", () => {
  it("carries a code", () => {
    const e = errors.weaveArchived();
    expect(e).toBeInstanceOf(LoomError);
    expect(e.code).toBe("weave_archived");
    expect(e.message.length).toBeGreaterThan(0);
  });

  it("ERROR_CODES holds every code a LoomError factory constructs, each once (spec 2026-09-28 §10.0)", () => {
    // Every factory takes at most one argument; "x" stands for any of them.
    const made = Object.values(errors).map((make) => (make as (...args: unknown[]) => LoomError)("x").code);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    // Distinct: a second factory may reuse a code (two ways to say not_found); "each once" is ERROR_CODES's.
    expect([...new Set(made)].sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe("EVENT_TYPES (spec 2026-09-28 §10.0)", () => {
  /** The members the EventType union named before it was derived from EVENT_TYPES, in its order. */
  const NAMED = [
    "message", "participant.joined", "participant.role_changed",
    "thread.created", "thread.closed", "thread.invited", "thread.removed", "thread.url_changed",
    "weave.archived", "weave.guidelines_changed",
    "participant.capabilities_changed",
    "request.opened", "request.offered", "request.accepted", "request.closed", "request.completed", "request.overdue",
    "weave.invited",
  ] as const;

  it("EVENT_TYPES holds every type the EventType union named, each once, and EventType accepts exactly those", () => {
    expect([...EVENT_TYPES]).toEqual([...NAMED]);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    // A type-level assertion: `pnpm --filter @loom/core typecheck` (tsconfig.test.json) checks it, not the run.
    expectTypeOf<EventType>().toEqualTypeOf<(typeof NAMED)[number]>();
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
  it("secret never starts with a dash", () => {
    for (let i = 0; i < 2000; i++) {
      const s = newSecret();
      expect(s.startsWith("-")).toBe(false);
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("isUuid", () => {
  it("accepts generated ids and canonical uuids", () => {
    expect(isUuid(newId())).toBe(true);
    expect(isUuid("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isUuid("11111111-2222-3333-4444-555555555555".toUpperCase())).toBe(true);
  });
  it.each(["", "not-a-uuid", "11111111-2222-3333-4444-55555555555", "11111111-2222-3333-4444-5555555555555",
    "11111111222233334444555555555555", "gggggggg-2222-3333-4444-555555555555", " 11111111-2222-3333-4444-555555555555"])(
    "rejects %j", (s) => { expect(isUuid(s)).toBe(false); });
});

describe("isNameTakenViolation", () => {
  it("matches only the per-weave participant name index", () => {
    expect(isNameTakenViolation({ code: "23505", constraint_name: "participants_weave_name_idx" })).toBe(true);
    expect(isNameTakenViolation({ cause: { code: "23505", constraint_name: "participants_weave_name_idx" } })).toBe(true);
  });
  it("does not swallow other unique violations or other errors", () => {
    expect(isNameTakenViolation({ code: "23505", constraint_name: "participants_token_unique" })).toBe(false);
    expect(isNameTakenViolation({ code: "23505" })).toBe(false);
    expect(isNameTakenViolation({ code: "23503", constraint_name: "participants_weave_name_idx" })).toBe(false);
    expect(isNameTakenViolation(new Error("boom"))).toBe(false);
    expect(isNameTakenViolation(null)).toBe(false);
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

describe("validatePage", () => {
  /** The code a call rejects with, or undefined when it is accepted. */
  const codeOf = (fn: () => void): string | undefined => {
    try { fn(); return undefined; } catch (e) { return (e as LoomError).code; }
  };

  it("accepts an omitted, zero or positive since and a limit inside 1..MAX_PAGE_LIMIT", () => {
    expect(codeOf(() => validatePage({}))).toBeUndefined();
    expect(codeOf(() => validatePage({ since: 0, limit: 1 }))).toBeUndefined();
    expect(codeOf(() => validatePage({ since: 7, limit: MAX_PAGE_LIMIT }))).toBeUndefined();
  });

  it("rejects a since that is negative or not an integer", () => {
    for (const since of [-1, -0.5, 1.5, NaN, Infinity]) {
      expect(codeOf(() => validatePage({ since }))).toBe("validation");
    }
  });

  it("rejects a limit below 1, above the maximum, or not an integer", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, MAX_PAGE_LIMIT + 1]) {
      expect(codeOf(() => validatePage({ limit }))).toBe("validation");
    }
  });

  it("honours a caller-supplied maximum", () => {
    expect(codeOf(() => validatePage({ limit: 50 }, 50))).toBeUndefined();
    expect(codeOf(() => validatePage({ limit: 51 }, 50))).toBe("validation");
  });
});
