import { errors } from "../errors.js";
import { isUuid } from "../ids.js";
import { MAX_PAGE_LIMIT } from "../paging.js";
import type { PublicParticipant } from "../types.js";
import { validateRequirements, type Profile } from "./matching.js";

/** One directory entry. Shaped like `FoundAgent` on purpose: the same pair, the same order. */
export type Listener = { participant: PublicParticipant; capabilities: Profile };

export type ListenersSort = "name" | "owner" | "joined";
export type ServesKind = "anyone" | "owner" | "list";

export type FacetValue = { value: string; count: number };
/** `efforts` is the model's top 10; `moreEfforts` says there are others. */
export type ModelFacet = { model: string; count: number; efforts: FacetValue[]; moreEfforts: boolean };

export type ListenersFacets = {
  models: { values: ModelFacet[]; more: boolean };
  tools: { values: FacetValue[]; more: boolean };
  runtimes: { values: FacetValue[]; more: boolean };
  /** Always the three kinds, always in this order, zeros included. `more` is always false. */
  serves: { values: FacetValue[]; more: boolean };
};

export type ListenersQuery = {
  /** Case-insensitive substring of the participant's name OR the profile's `owner`. */
  q?: string;
  /** Any-of, with an optional effort per alternative — the same shape as `Requirements.models`. */
  models?: { model: string; effort?: string }[];
  /** All-of. */
  tools?: string[];
  /** Equality. */
  runtime?: string;
  serves?: ServesKind;
  sort?: ListenersSort;          // default "name"
  dir?: "asc" | "desc";          // default "asc"
  limit?: number;                // default 50, 0..MAX_PAGE_LIMIT
  cursor?: string;               // opaque; from a previous answer's nextCursor
  /** Default true. `false` skips the four facet queries for a caller that only wants the counts. */
  facets?: boolean;
};

export type ListenersPage = {
  /** Every listener in the Lobby, ignoring `q` and every filter. What the sidebar counts. */
  total: number;
  /** After the search and the filters. What the header counts. */
  matched: number;
  listeners: Listener[];
  /** Absent when this is the last page, and always absent when `limit` is 0. */
  nextCursor?: string;
  /** Absent only when the caller asked for `facets: false`. */
  facets?: ListenersFacets;
};

/** A page position: the sort key value as the database rendered it, plus the row's id. */
export type Cursor = { s: ListenersSort; d: "asc" | "desc"; k: string; i: string };

/** The query every predicate is built from: bounded, normalised, with the defaults applied. */
export type CleanQuery = {
  q?: string; models?: { model: string; effort?: string }[]; tools?: string[];
  runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";
  limit: number; facets: boolean; cursor?: Cursor;
};

const MAX_Q = 100;
const DEFAULT_LIMIT = 50;

/**
 * Every key `ListenersQuery` has, and the whole of what this query will read. The shape is closed
 * on purpose: an unknown key read as absent answers `?filter={"owner":"ada"}` — or a typo like
 * `"tool"` for `"tools"` — with the **entire Lobby** instead of a 400, which is a filter silently
 * not applied. Keep in step with `ListenersQuery` above.
 */
const QUERY_KEYS = ["q", "models", "tools", "runtime", "serves", "sort", "dir", "limit", "cursor", "facets"];
/** How much of a rejected key the message repeats. It is a value out of a URL, so it is bounded. */
const MAX_SHOWN_KEY = 64;

/** Postgres text cannot carry `\u0000` (22021) and jsonb rejects it too; the rest of C0 matches no name or owner. */
const CONTROL_CHAR_RE = /[\u0000-\u001f]/;

/**
 * Bounds, defaults and normalisation — all of it here, because the adapters carry types only.
 * The `{ models, tools, runtime }` third reuses `validateRequirements`, so a filter and a request's
 * requirements can never drift apart in shape or in message.
 */
export function validateListenersQuery(input: ListenersQuery = {}): CleanQuery {
  // The default covers `undefined` and nothing else: a supplied `null` used to reach `input.q` and
  // throw a `TypeError` (a 500), and `5`, `"str"` and `[]` used to read every property as absent and
  // be answered with the whole Lobby. Same idiom as `validateProfile` (`profile.ts:41`).
  if (typeof input !== "object" || (input as unknown) === null || Array.isArray(input)) {
    throw errors.validation("query must be an object");
  }
  // Named back, so a typo is findable rather than silently honoured as "no filter" — but named back
  // through `JSON.stringify` and cut first: the key came out of a query string, and neither a
  // control character nor five hundred characters of it belong in an error message. A key merely
  // *present* with `undefined` is still a known key; the REST route sets six of them that way.
  const unknown = Object.keys(input).find((k) => !QUERY_KEYS.includes(k));
  if (unknown !== undefined) {
    throw errors.validation(`unknown query key ${JSON.stringify(unknown.slice(0, MAX_SHOWN_KEY))}`);
  }
  // Absent is `undefined` and nothing else. A supplied `q` that is not a string is a caller error,
  // not an empty search box — reading it as "absent" would answer a nonsense query with the whole
  // Lobby instead of a 400.
  if (input.q !== undefined && typeof input.q !== "string") throw errors.validation("q must be a string");
  const q = input.q?.trim();
  if (q !== undefined && q.length > MAX_Q) throw errors.validation(`q must be at most ${MAX_Q} characters`);
  // `q` becomes an `ILIKE` bind parameter, and a `\u0000` in a text parameter is 22021 "invalid byte
  // sequence for encoding UTF8" — a 500 for a value that came out of the address bar.
  if (q !== undefined && CONTROL_CHAR_RE.test(q)) throw errors.validation("q must not contain control characters");
  // An empty filter is no filter: `matches` accepts every profile for `tools: []`, and a control
  // that goes from one chip to none must not be a 400. **Only an actually empty array** — `?.length`
  // is a truthiness test, and `{}`, `5` and `null` are all falsy-length: each would be silently
  // normalised to "no filter", so `filter={"tools":{}}` over REST would return every listener.
  // Anything that is not an empty array is passed on **unchanged** to `validateRequirements`,
  // whose schema rejects it with `validation`.
  const emptyArrayToAbsent = <T>(v: T): T | undefined => (Array.isArray(v) && v.length === 0 ? undefined : v);
  const req = validateRequirements({
    models: emptyArrayToAbsent(input.models),
    tools: emptyArrayToAbsent(input.tools),
    runtime: input.runtime,
  });
  // Explicitly, never `...req`: `Requirements` also declares `spawnsSubagents`, which `CleanQuery`
  // does not have and no listener filter offers.
  const { models, tools, runtime } = req;
  // The same hole one level down. These three end up inside a jsonb containment bind parameter, and
  // jsonb answers a `\u0000` with "unsupported Unicode escape sequence" — another 500 out of a URL.
  // `validateRequirements` is shared with requests and profiles, so the rule is applied here.
  const filterStrings = [runtime, ...(tools ?? []), ...(models ?? []).flatMap((m) => [m.model, m.effort])];
  if (filterStrings.some((s) => s !== undefined && CONTROL_CHAR_RE.test(s))) {
    throw errors.validation("filters must not contain control characters");
  }
  if (input.serves !== undefined && !["anyone", "owner", "list"].includes(input.serves)) {
    throw errors.validation("serves must be anyone, owner or list");
  }
  // `=== undefined`, not `??`: a supplied `null` is a value the caller chose and a rejection it has
  // earned, not an absence that quietly takes the default. (`??` would read `sort: null` as "name"
  // and `limit: null` as 50.) The checks below then do the rejecting, each with its own message.
  const sort = input.sort === undefined ? "name" : input.sort;
  if (!["name", "owner", "joined"].includes(sort)) throw errors.validation("sort must be name, owner or joined");
  const dir = input.dir === undefined ? "asc" : input.dir;
  if (dir !== "asc" && dir !== "desc") throw errors.validation("dir must be asc or desc");
  // Not `validatePage`, which rejects 0: here 0 means "counts and facets, no rows" and is the
  // sidebar's whole request. The bound is quoted from `paging.ts` rather than copied.
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PAGE_LIMIT) {
    throw errors.validation(`limit must be an integer between 0 and ${MAX_PAGE_LIMIT}`);
  }
  if (input.facets !== undefined && typeof input.facets !== "boolean") throw errors.validation("facets must be a boolean");
  return {
    q: q || undefined, models, tools, runtime, serves: input.serves, sort, dir, limit,
    facets: input.facets ?? true,
    cursor: input.cursor === undefined ? undefined : decodeCursor(input.cursor, sort, dir),
  };
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * Exactly what `to_char(joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` emits and
 * nothing else: four-digit year, `.US` is always **six** digits, always `T` and `Z`. The pattern is
 * matched against the string the caller handed back — **never round-tripped through a JS `Date`**,
 * which holds milliseconds and would quietly turn `.123456Z` into `.123Z`, duplicating rows
 * ascending and skipping them descending.
 */
const JOINED_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

/**
 * A key is a value out of a URL. Bounded so an unbounded string never reaches a query: the longest
 * key this query can emit is `lower(capabilities->>'owner')` over an owner of 64 (`profile.ts:27`)
 * or `lower(name)` over 32 (`names.ts`), and lowercasing can widen a character, so 256 is the
 * sanity bound rather than the exact one.
 */
const MAX_KEY = 256;

/** The cursor's whole contract, including its key: a bad one is `validation`, never a 500. */
export function decodeCursor(raw: string, sort: ListenersSort, dir: "asc" | "desc"): Cursor {
  const bad = () => errors.validation("cursor is not valid for this query");
  // Not a string at all: `Buffer.from(42, "base64url")` throws a `TypeError`, which would be a 500
  // for what is plainly a bad request.
  if (typeof raw !== "string") throw bad();
  let c: unknown;
  try { c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { throw bad(); }
  // Shape-checked before any property is read: a cursor is user input from a URL.
  if (typeof c !== "object" || c === null) throw bad();
  const { s, d, k, i } = c as Record<string, unknown>;
  if (typeof k !== "string" || typeof i !== "string" || !isUuid(i)) throw bad();
  if (s !== sort || d !== dir) throw bad();     // a cursor for a different ordering is not this page's
  // The key is validated **here**, not by Postgres: a well-formed cursor carrying `s: "joined"` and
  // `k: "not-a-date"` would otherwise fail at `$k::timestamptz` — a 500 for a value that came out of
  // the address bar. `sort` decides what a legal key looks like.
  if (sort === "joined") {
    const m = JOINED_KEY_RE.exec(k);
    if (!m) throw bad();
    // Shape is not sense: `2026-13-19T24:60:00.000000Z` matches the digits and is no instant.
    // Range-checked on the captured fields — still no `Date`, so no microsecond is lost.
    const [yr, mo, day, hh, mm, ss] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((g) => Number(g));
    // The day bound is the **month's own**, leap years included: `2026-02-31` and `2025-02-29` pass
    // a flat `<= 31` and Postgres answers both with "date/time field value out of range" — the same
    // 500 by another door. Year `0000` does not exist for `timestamptz` either.
    const leap = (yr! % 4 === 0 && yr! % 100 !== 0) || yr! % 400 === 0;
    const daysIn = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (yr! < 1 || mo! < 1 || mo! > 12 || day! < 1 || day! > daysIn[mo! - 1]! || hh! > 23 || mm! > 59 || ss! > 59) throw bad();
  } else if (k.length === 0 || k.length > MAX_KEY || CONTROL_CHAR_RE.test(k)) {
    // `lower(name)` and `lower(capabilities->>'owner')` are both non-empty by invariant, so an empty
    // key names no row this query could have been at. A control character names no row either, and a
    // `\u0000` in the text bind parameter would be 22021 rather than an empty page.
    throw bad();
  }
  return { s: sort, d: dir, k, i };
}

/** `%`, `_` and `\` escaped for an `ILIKE … ESCAPE '\'` pattern. The backslash goes first. */
export function likePattern(q: string): string {
  return `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}
