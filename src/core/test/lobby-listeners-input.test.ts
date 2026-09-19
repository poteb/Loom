import { describe, it, expect } from "vitest";
import type { LoomError } from "../src/errors.js";
import {
  decodeCursor, encodeCursor, likePattern, validateListenersQuery,
  type Cursor, type ListenersQuery, type ListenersSort,
} from "../src/lobby/listeners-input.js";

/** The code a call rejects with, or undefined when it is accepted. */
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as LoomError).code; }
};

/** A query the type would refuse: every one of these is a value a REST caller really can send. */
const q = (v: unknown) => () => validateListenersQuery(v as ListenersQuery);

const ID = "11111111-2222-3333-4444-555555555555";
const cursor = (k: string, s: ListenersSort = "name", d: "asc" | "desc" = "asc"): Cursor => ({ s, d, k, i: ID });

describe("validateListenersQuery defaults", () => {
  it("answers an absent query with the defaults and no filter", () => {
    expect(validateListenersQuery(undefined)).toEqual({ sort: "name", dir: "asc", limit: 50, facets: true });
  });

  it("answers an empty query with the same defaults", () => {
    expect(validateListenersQuery({})).toEqual({ sort: "name", dir: "asc", limit: 50, facets: true });
  });
});

describe("validateListenersQuery q", () => {
  it("trims a search", () => {
    expect(validateListenersQuery({ q: "  dana  " }).q).toBe("dana");
  });

  it("reads a whitespace-only search as no search", () => {
    expect(validateListenersQuery({ q: "   " }).q).toBeUndefined();
  });

  it("rejects a search longer than 100 characters", () => {
    expect(codeOf(q({ q: "x".repeat(101) }))).toBe("validation");
  });

  it("rejects a supplied q that is not a string", () => {
    expect(codeOf(q({ q: 42 }))).toBe("validation");
  });
});

describe("validateListenersQuery filter normalisation", () => {
  it("reads an empty tools list as no tools filter", () => {
    expect(validateListenersQuery({ tools: [] }).tools).toBeUndefined();
  });

  it("reads an empty models list as no models filter", () => {
    expect(validateListenersQuery({ models: [] }).models).toBeUndefined();
  });

  it("trims the tools it keeps", () => {
    expect(validateListenersQuery({ tools: [" shell "] }).tools).toEqual(["shell"]);
  });

  it("rejects an object where tools should be", () => {
    expect(codeOf(q({ tools: {} }))).toBe("validation");
  });

  it("rejects a number where models should be", () => {
    expect(codeOf(q({ models: 5 }))).toBe("validation");
  });

  it("rejects a null where models should be", () => {
    expect(codeOf(q({ models: null }))).toBe("validation");
  });

  it("rejects an empty string where tools should be", () => {
    expect(codeOf(q({ tools: "" }))).toBe("validation");
  });
});

describe("validateListenersQuery filter bounds", () => {
  it("keeps a model alternative that names an effort", () => {
    expect(validateListenersQuery({ models: [{ model: "m", effort: "high" }] }).models)
      .toEqual([{ model: "m", effort: "high" }]);
  });

  it("rejects an empty model name", () => {
    expect(codeOf(q({ models: [{ model: "" }] }))).toBe("validation");
  });

  it("rejects more than 20 model alternatives", () => {
    expect(codeOf(q({ models: Array.from({ length: 21 }, (_, i) => ({ model: `m-${i}` })) }))).toBe("validation");
  });

  it("rejects more than 50 tools", () => {
    expect(codeOf(q({ tools: Array.from({ length: 51 }, (_, i) => `t-${i}`) }))).toBe("validation");
  });

  it("rejects an empty runtime", () => {
    expect(codeOf(q({ runtime: "" }))).toBe("validation");
  });

  it("rejects a serves that is not one of the three kinds", () => {
    expect(codeOf(q({ serves: "nobody" }))).toBe("validation");
  });
});

describe("validateListenersQuery ordering and paging", () => {
  it("rejects an unknown sort", () => {
    expect(codeOf(q({ sort: "age" }))).toBe("validation");
  });

  it("rejects an unknown direction", () => {
    expect(codeOf(q({ dir: "up" }))).toBe("validation");
  });

  it("accepts a limit of 0, which asks for counts without rows", () => {
    expect(validateListenersQuery({ limit: 0 }).limit).toBe(0);
  });

  it("accepts a limit of MAX_PAGE_LIMIT", () => {
    expect(validateListenersQuery({ limit: 1000 }).limit).toBe(1000);
  });

  it("rejects a limit above MAX_PAGE_LIMIT", () => {
    expect(codeOf(q({ limit: 1001 }))).toBe("validation");
  });

  it("rejects a negative limit", () => {
    expect(codeOf(q({ limit: -1 }))).toBe("validation");
  });

  it("rejects a fractional limit", () => {
    expect(codeOf(q({ limit: 1.5 }))).toBe("validation");
  });

  it("rejects a limit of NaN", () => {
    expect(codeOf(q({ limit: NaN }))).toBe("validation");
  });

  it("accepts facets: false", () => {
    expect(validateListenersQuery({ facets: false }).facets).toBe(false);
  });

  it("rejects a facets that is not a boolean", () => {
    expect(codeOf(q({ facets: "no" }))).toBe("validation");
  });

  it("decodes a cursor for this ordering into the clean query", () => {
    const c = cursor("dana");
    expect(validateListenersQuery({ cursor: encodeCursor(c) }).cursor).toEqual(c);
  });
});

describe("validateListenersQuery treats a supplied null as a value", () => {
  it("rejects a null limit rather than defaulting to 50", () => {
    expect(codeOf(q({ limit: null }))).toBe("validation");
  });

  it("rejects a null sort rather than defaulting to name", () => {
    expect(codeOf(q({ sort: null }))).toBe("validation");
  });

  it("rejects a null dir rather than defaulting to asc", () => {
    expect(codeOf(q({ dir: null }))).toBe("validation");
  });
});

describe("cursor codec", () => {
  it("round-trips a key containing +, / and =", () => {
    const c = cursor("a+b/c=d");
    expect(decodeCursor(encodeCursor(c), "name", "asc")).toEqual(c);
  });

  it("round-trips a microsecond joined key", () => {
    const c = cursor("2026-09-19T12:00:00.123456Z", "joined");
    expect(decodeCursor(encodeCursor(c), "joined", "asc")).toEqual(c);
  });

  it("keeps a joined key character for character", () => {
    const c = cursor("2026-09-19T12:00:00.123456Z", "joined");
    expect(decodeCursor(encodeCursor(c), "joined", "asc").k).toBe("2026-09-19T12:00:00.123456Z");
  });

  it("rejects a cursor that is not base64url of JSON", () => {
    expect(codeOf(() => decodeCursor("not-base64!", "name", "asc"))).toBe("validation");
  });

  it("rejects valid base64url that is not JSON", () => {
    expect(codeOf(() => decodeCursor(Buffer.from("hello", "utf8").toString("base64url"), "name", "asc"))).toBe("validation");
  });

  it("rejects a cursor with no i", () => {
    const raw = Buffer.from(JSON.stringify({ s: "name", d: "asc", k: "dana" }), "utf8").toString("base64url");
    expect(codeOf(() => decodeCursor(raw, "name", "asc"))).toBe("validation");
  });

  it("rejects an i that is not a uuid", () => {
    const raw = encodeCursor({ s: "name", d: "asc", k: "dana", i: "not-a-uuid" });
    expect(codeOf(() => decodeCursor(raw, "name", "asc"))).toBe("validation");
  });

  it("rejects a cursor whose sort is not this query's", () => {
    expect(codeOf(() => decodeCursor(encodeCursor(cursor("dana", "owner")), "name", "asc"))).toBe("validation");
  });

  it("rejects a cursor whose direction is not this query's", () => {
    expect(codeOf(() => decodeCursor(encodeCursor(cursor("dana", "name", "desc")), "name", "asc"))).toBe("validation");
  });

  it("rejects a raw cursor that is not a string", () => {
    expect(codeOf(() => decodeCursor(42 as unknown as string, "name", "asc"))).toBe("validation");
  });

  it("rejects a key that is not a string", () => {
    const raw = Buffer.from(JSON.stringify({ s: "name", d: "asc", k: null, i: ID }), "utf8").toString("base64url");
    expect(codeOf(() => decodeCursor(raw, "name", "asc"))).toBe("validation");
  });
});

describe("cursor codec: a joined key is exactly what the SQL emits", () => {
  const rejects = (k: string) => codeOf(() => decodeCursor(encodeCursor(cursor(k, "joined")), "joined", "asc"));

  it("rejects a key that is not a timestamp at all", () => {
    expect(rejects("not-a-date")).toBe("validation");
  });

  it("rejects milliseconds where the format always emits six digits", () => {
    expect(rejects("2026-09-19T12:00:00.123Z")).toBe("validation");
  });

  it("rejects a space where the format emits T", () => {
    expect(rejects("2026-09-19 12:00:00.123456Z")).toBe("validation");
  });

  it("rejects a key with no trailing Z", () => {
    expect(rejects("2026-09-19T12:00:00.123456")).toBe("validation");
  });

  it("rejects month 13", () => {
    expect(rejects("2026-13-19T12:00:00.123456Z")).toBe("validation");
  });

  it("rejects hour 24", () => {
    expect(rejects("2026-09-19T24:00:00.123456Z")).toBe("validation");
  });

  it("rejects minute 60", () => {
    expect(rejects("2026-09-19T12:60:00.123456Z")).toBe("validation");
  });

  it("rejects a day the month does not have", () => {
    expect(rejects("2026-02-31T12:00:00.123456Z")).toBe("validation");
  });

  it("rejects 29 February of a common year", () => {
    expect(rejects("2025-02-29T12:00:00.123456Z")).toBe("validation");
  });

  it("accepts 29 February of a leap year", () => {
    expect(rejects("2024-02-29T12:00:00.123456Z")).toBeUndefined();
  });

  it("rejects year 0, which no timestamptz has", () => {
    expect(rejects("0000-01-01T00:00:00.000000Z")).toBe("validation");
  });
});

describe("cursor codec: a text key is bounded", () => {
  it("rejects a name key longer than the bound", () => {
    expect(codeOf(() => decodeCursor(encodeCursor(cursor("x".repeat(300))), "name", "asc"))).toBe("validation");
  });

  it("rejects an empty name key, which names no row", () => {
    expect(codeOf(() => decodeCursor(encodeCursor(cursor("")), "name", "asc"))).toBe("validation");
  });

  it("rejects an empty owner key, which names no row", () => {
    expect(codeOf(() => decodeCursor(encodeCursor(cursor("", "owner")), "owner", "asc"))).toBe("validation");
  });

  it("accepts an owner key of 64 characters, the longest an owner can be", () => {
    const k = "o".repeat(64);
    expect(decodeCursor(encodeCursor(cursor(k, "owner")), "owner", "asc").k).toBe(k);
  });
});

describe("likePattern", () => {
  it("escapes the backslash first, then the wildcards", () => {
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});
