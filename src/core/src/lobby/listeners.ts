import { and, asc, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { participants } from "../db/schema.js";
import { assertCanRead, toPublicParticipant } from "../actors.js";
import { getLobby } from "./lobby.js";
import type { Profile } from "./matching.js";
import {
  encodeCursor, likePattern, validateListenersQuery,
  type CleanQuery, type FacetValue, type Listener, type ListenersFacets, type ListenersPage,
  type ListenersQuery, type ListenersSort, type ModelFacet,
} from "./listeners-input.js";
import type { Actor } from "../types.js";

/** How many values a facet reports, and how many efforts one model reports (spec §2.7). */
const TOP_VALUES = 20;
const TOP_EFFORTS = 10;

/** The filter a facet leaves out: every facet is computed over the others (spec §2.7). */
type FacetKey = "models" | "tools" | "runtime" | "serves";

/** Every listener of the Lobby and nobody else. The one predicate every query starts from. */
const base = (lobbyId: string) => and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities));

/**
 * Whole-document containment, so the one GIN index on `capabilities` serves it (spec §2.8).
 *
 * Every guard here is `!== undefined` — the same test `filtering` makes in `listListeners`, so a
 * filter can never be built for a query that does not count as filtering. **Invariant, from Task
 * 1:** `validateListenersQuery` normalises an empty `tools`/`models` array and a blank `q` to
 * absent, so none of them ever reaches this function. That is what makes `!== undefined` safe, and
 * why truthiness would be the wrong test rather than merely a looser one: `tools: []` would build
 * `@> '{"tools":[]}'`, which **excludes** every profile with no `tools` key — the opposite of "no
 * filter" — and `models: []` would render `sql.join([])` as `()`, a syntax error.
 */
function filterSql(c: CleanQuery, omit?: FacetKey): SQL[] {
  const out: SQL[] = [];
  if (c.q !== undefined) {
    const p = likePattern(c.q);
    out.push(sql`(${participants.name} ILIKE ${p} ESCAPE '\\' OR ${participants.capabilities}->>'owner' ILIKE ${p} ESCAPE '\\')`);
  }
  if (c.models !== undefined && omit !== "models") {
    const alts = c.models.map((m) => sql`${participants.capabilities} @> ${JSON.stringify({ models: [m.effort === undefined ? { model: m.model } : { model: m.model, effort: m.effort }] })}::jsonb`);
    out.push(sql`(${sql.join(alts, sql` OR `)})`);          // any-of
  }
  if (c.tools !== undefined && omit !== "tools") {
    // Array containment is subset containment, so one predicate is all-of — not one per tool.
    out.push(sql`${participants.capabilities} @> ${JSON.stringify({ tools: c.tools })}::jsonb`);
  }
  if (c.runtime !== undefined && omit !== "runtime") {
    out.push(sql`${participants.capabilities} @> ${JSON.stringify({ runtime: c.runtime })}::jsonb`);
  }
  if (c.serves !== undefined && omit !== "serves") {
    out.push(c.serves === "anyone" ? sql`${participants.capabilities} @> '{"serves":"anyone"}'::jsonb`
      : c.serves === "list" ? sql`jsonb_typeof(${participants.capabilities}->'serves') = 'array'`
      // `admits` reads an absent `serves` as "owner" (matching.ts:54), so the default is included.
      : sql`(NOT (${participants.capabilities} ? 'serves') OR ${participants.capabilities} @> '{"serves":"owner"}'::jsonb)`);
  }
  return out;
}

/** The base predicate plus the filters, shared by the page, the counts and every facet. */
const whereFor = (lobbyId: string, c: CleanQuery, omit?: FacetKey): SQL =>
  and(base(lobbyId), ...filterSql(c, omit))!;

const keySql = (sort: ListenersSort) => sort === "name" ? sql`lower(${participants.name})`
  : sort === "owner" ? sql`lower(${participants.capabilities}->>'owner')`
  : sql`${participants.joinedAt}`;

// The cursor key is rendered by Postgres and handed back to Postgres. `joined_at` is timestamptz
// (microseconds) and a JS Date holds milliseconds, so a key taken from `participant.joinedAt`
// would repeat a row ascending and skip rows descending (spec §2.5).
const cursorKeySql = (sort: ListenersSort) => sort === "joined"
  ? sql<string>`to_char(${participants.joinedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  : (keySql(sort) as SQL<string>);

const afterCursor = (c: CleanQuery): SQL | undefined => {
  if (!c.cursor) return undefined;
  // `c.cursor` came through `decodeCursor`, which has already checked that `k` is exactly what
  // `cursorKeySql` emits for this `sort` — so `::timestamptz` here can only ever see a timestamp.
  // A cast is not a validator: an unchecked `k` makes a hand-edited URL a 500 (Task 1).
  const k = c.sort === "joined" ? sql`${c.cursor.k}::timestamptz` : sql`${c.cursor.k}`;
  const key = keySql(c.sort);
  return c.dir === "asc" ? sql`(${key}, ${participants.id}) > (${k}, ${c.cursor.i})`
                         : sql`(${key}, ${participants.id}) < (${k}, ${c.cursor.i})`;
};

async function countRows(db: Db, where: SQL): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(participants).where(where);
  return row!.n;
}

type PageRow = { row: typeof participants.$inferSelect; cursorKey: string };

/** One row more than asked for: the extra decides whether there is a next page. */
function pageRows(db: Db, lobbyId: string, c: CleanQuery): Promise<PageRow[]> {
  const way = c.dir === "asc" ? asc : desc;
  return db.select({ row: participants, cursorKey: cursorKeySql(c.sort) })
    .from(participants)
    .where(and(whereFor(lobbyId, c), afterCursor(c)))
    // The tie-break goes the same way as the key, so the order is total and the cursor is exact.
    .orderBy(way(keySql(c.sort)), way(participants.id))
    .limit(c.limit + 1);
}

/** The population one facet is computed over: every filter but its own (spec §2.7). */
const facetBase = (lobbyId: string, c: CleanQuery, omit: FacetKey): SQL =>
  sql`SELECT ${participants.id} AS id, ${participants.capabilities} AS capabilities
      FROM ${participants} WHERE ${whereFor(lobbyId, c, omit)}`;

type CountRow = { value: string; n: number };

/**
 * One ranked facet: the top 21 by `count desc, value asc`, `UNION`ed with the caller's own
 * selection left-joined onto the aggregate. The join is what carries a selected value whose count
 * under the other filters is **zero** — it has no aggregate row, so no ranking can recover it.
 */
function rankedFacet(db: Db, lobbyId: string, c: CleanQuery, kind: "tools" | "runtime"): Promise<CountRow[]> {
  const selected = kind === "tools" ? (c.tools ?? []) : (c.runtime === undefined ? [] : [c.runtime]);
  const counts = kind === "tools"
    // `->` here is a projection, not a predicate: it is what `jsonb_array_elements_text` reads.
    // A profile with no `tools` key produces no rows, which is the right answer, not an error.
    ? sql`SELECT t.value AS value, count(DISTINCT b.id)::int AS n
          FROM base b, jsonb_array_elements_text(b.capabilities->'tools') t GROUP BY 1`
    // "No runtime declared" is not a value the filter can express, so it is not a chip (spec §2.8).
    : sql`SELECT b.capabilities->>'runtime' AS value, count(DISTINCT b.id)::int AS n
          FROM base b WHERE b.capabilities ? 'runtime' GROUP BY 1`;
  return db.execute<CountRow>(sql`
    WITH base AS (${facetBase(lobbyId, c, kind)}), counts AS (${counts}), ranked AS (
      -- COLLATE "C" so this cut and byCountThenValue's re-sort are one order: without it the rank
      -- uses the database collation while the fold compares bytes, and on a glibc/ICU database the
      -- displayed twenty would be the top twenty under neither comparator.
      SELECT value, n, row_number() OVER (ORDER BY n DESC, value COLLATE "C") AS rn FROM counts
    )
    SELECT value, n FROM ranked WHERE rn <= ${TOP_VALUES + 1}
    UNION
    SELECT s.value, coalesce(cs.n, 0) FROM unnest(${sql.param(selected)}::text[]) AS s(value)
    LEFT JOIN counts cs ON cs.value = s.value
  `);
}

type ModelRow = { model: string; n: number; effort: string | null; effort_n: number | null };

/**
 * The models facet, ranked in two stages: models first, from **one row per model**, then the
 * efforts of the models that survived. Ranking a grouping-set result ranks effort rows too, and one
 * model with fifty efforts then pushes twenty ordinary models past the cut (spec §2.8).
 */
function modelsFacet(db: Db, lobbyId: string, c: CleanQuery): Promise<ModelRow[]> {
  const selected = c.models ?? [];
  const selModels = selected.map((m) => m.model);
  const withEffort = selected.filter((m) => m.effort !== undefined);
  const selEffortModels = withEffort.map((m) => m.model);
  const selEfforts = withEffort.map((m) => m.effort!);
  return db.execute<ModelRow>(sql`
    WITH base AS (${facetBase(lobbyId, c, "models")}), pairs AS (
      SELECT DISTINCT b.id, m->>'model' AS model, m->>'effort' AS effort
      FROM base b, jsonb_array_elements(b.capabilities->'models') m
    ), model_counts AS (
      SELECT model, count(DISTINCT id)::int AS n FROM pairs GROUP BY model
    ), ranked_models AS (
      -- COLLATE "C" for the reason rankedFacet gives: one order for the cut and for the fold.
      SELECT model, n, row_number() OVER (ORDER BY n DESC, model COLLATE "C") AS rn FROM model_counts
    ), kept_models AS (
      SELECT model, n FROM ranked_models WHERE rn <= ${TOP_VALUES + 1}
      UNION
      SELECT s.model, coalesce(mc.n, 0) FROM unnest(${sql.param(selModels)}::text[]) AS s(model)
      LEFT JOIN model_counts mc ON mc.model = s.model
    ), effort_counts AS (
      -- IS NOT NULL here and *only* here. A model entry with no effort, {"model":"m"}, is still a
      -- listener offering that model, so pairs and model_counts above must keep its row. It is not
      -- an effort on offer, though: grouped in, the NULL group takes one of the ranked slots and is
      -- then dropped by foldModels, leaving a real effort unshown and moreEfforts reading false
      -- although there are more.
      SELECT p.model, p.effort, count(DISTINCT p.id)::int AS n
      FROM pairs p JOIN kept_models k ON k.model = p.model
      WHERE p.effort IS NOT NULL GROUP BY p.model, p.effort
    ), ranked_efforts AS (
      SELECT model, effort, n,
             row_number() OVER (PARTITION BY model ORDER BY n DESC, effort COLLATE "C") AS rn FROM effort_counts
    ), kept_efforts AS (
      SELECT model, effort, n FROM ranked_efforts WHERE rn <= ${TOP_EFFORTS + 1}
      UNION
      SELECT s.model, s.effort, coalesce(ec.n, 0)
      FROM unnest(${sql.param(selEffortModels)}::text[], ${sql.param(selEfforts)}::text[]) AS s(model, effort)
      LEFT JOIN effort_counts ec ON ec.model = s.model AND ec.effort = s.effort
    )
    SELECT k.model, k.n, e.effort, e.n AS effort_n
    FROM kept_models k LEFT JOIN kept_efforts e ON e.model = k.model
  `);
}

type ServesRow = { anyone: number; owner: number; list: number };

/** Three counts in one row, so the facet always has its three kinds, zeros included (spec §2.7). */
async function servesFacet(db: Db, lobbyId: string, c: CleanQuery): Promise<ServesRow> {
  const rows = await db.execute<ServesRow>(sql`
    WITH base AS (${facetBase(lobbyId, c, "serves")})
    SELECT count(*) FILTER (WHERE capabilities @> '{"serves":"anyone"}'::jsonb)::int AS anyone,
           count(*) FILTER (WHERE NOT (capabilities ? 'serves') OR capabilities @> '{"serves":"owner"}'::jsonb)::int AS owner,
           count(*) FILTER (WHERE jsonb_typeof(capabilities->'serves') = 'array')::int AS list
    FROM base
  `);
  return rows[0]!;
}

/**
 * `count desc, value asc` — the same total order the ranking used, so a re-run is the same list.
 * The tie-break compares UTF-8 **bytes**, which is exactly what the queries' `COLLATE "C"` does;
 * JavaScript's own `<` compares UTF-16 code units and disagrees for astral characters.
 */
const byCountThenValue = (a: CountRow, b: CountRow) =>
  b.n - a.n || Buffer.compare(Buffer.from(a.value, "utf8"), Buffer.from(b.value, "utf8"));

/**
 * Pure shaping over at most a few dozen rows: keep the top N, say whether the ranking was cut, and
 * append every selected value that fell outside it.
 *
 * `more` is read from the rows that have a **count**, not from how many rows came back: a selected
 * value at zero has no aggregate row and was never ranked, so it can never mean "there are more".
 * The selection is appended rather than dropped even when it is the very row the cut removed.
 */
function foldFacet(rows: CountRow[], top: number, selected: string[]): { values: FacetValue[]; more: boolean } {
  const sorted = [...rows].sort(byCountThenValue);
  const more = sorted.filter((r) => r.n > 0).length > top;
  const chosen = new Set(selected);
  const kept = [...sorted.slice(0, top), ...sorted.slice(top).filter((r) => chosen.has(r.value))];
  return { values: kept.map((r) => ({ value: r.value, count: r.n })), more };
}

function foldModels(rows: ModelRow[], c: CleanQuery): { values: ModelFacet[]; more: boolean } {
  const selected = c.models ?? [];
  const efforts = new Map<string, CountRow[]>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.model, r.n);
    // A kept model with no efforts at all — a selected model at zero — left-joins to a null row.
    if (r.effort === null) continue;
    const have = efforts.get(r.model);
    if (have) have.push({ value: r.effort, n: r.effort_n! });
    else efforts.set(r.model, [{ value: r.effort, n: r.effort_n! }]);
  }
  const folded = foldFacet([...counts].map(([value, n]) => ({ value, n })), TOP_VALUES, selected.map((m) => m.model));
  return {
    more: folded.more,
    values: folded.values.map((m) => {
      const ef = foldFacet(efforts.get(m.value) ?? [], TOP_EFFORTS,
        selected.filter((s) => s.model === m.value && s.effort !== undefined).map((s) => s.effort!));
      return { model: m.value, count: m.count, efforts: ef.values, moreEfforts: ef.more };
    }),
  };
}

async function readFacets(db: Db, lobbyId: string, c: CleanQuery): Promise<ListenersFacets> {
  const [models, tools, runtimes, serves] = await Promise.all([
    modelsFacet(db, lobbyId, c),
    rankedFacet(db, lobbyId, c, "tools"),
    rankedFacet(db, lobbyId, c, "runtime"),
    servesFacet(db, lobbyId, c),
  ]);
  return {
    models: foldModels(models, c),
    tools: foldFacet(tools, TOP_VALUES, c.tools ?? []),
    runtimes: foldFacet(runtimes, TOP_VALUES, c.runtime === undefined ? [] : [c.runtime]),
    // A three-way control that loses an option when it hits zero is a control that moves under the
    // cursor, so the three kinds are always there, in this order, and there is never more.
    serves: { values: [
      { value: "anyone", count: serves.anyone },
      { value: "owner", count: serves.owner },
      { value: "list", count: serves.list },
    ], more: false },
  };
}

/**
 * The Lobby's listeners: searched, filtered, sorted, paged and faceted — all of it in SQL, because
 * this query also has to count and facet, which is what `find_agents`' in-memory matching cannot do.
 * `find_agents` stays the authority for anything a request depends on; the test suite runs both
 * over one fixture and asserts the same set (spec §2.4).
 */
export async function listListeners(db: Db, actor: Actor, query: ListenersQuery = {}): Promise<ListenersPage> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  const c = validateListenersQuery(query);
  // The cursor is a position, not a filter: it decides the page and never either count.
  const filtering = c.q !== undefined || c.models !== undefined || c.tools !== undefined
    || c.runtime !== undefined || c.serves !== undefined;
  // Nothing here depends on anything else here. `limit: 0` skips the page, `facets: false` skips the
  // four facet queries, and with nothing filtering the two counts are the same `count(*)`.
  //
  // These are independent reads on pooled connections, not one snapshot: there is no surrounding
  // transaction, so a profile set or cleared while they run can land between two of them and leave
  // a page disagreeing with its counts or its facets by one. That is the tolerance the page is
  // built for — spec §5.5's "list changed — reload" hint — not an error, and a repeatable-read
  // transaction here would buy consistency for a directory nobody reads twice in the same second.
  const [total, matched, rows, facets] = await Promise.all([
    countRows(db, base(lobbyId)!),
    filtering ? countRows(db, whereFor(lobbyId, c)) : undefined,
    c.limit === 0 ? undefined : pageRows(db, lobbyId, c),
    c.facets ? readFacets(db, lobbyId, c) : undefined,
  ]);
  const page = rows ?? [];
  const hasNext = page.length > c.limit;
  const shown = hasNext ? page.slice(0, c.limit) : page;
  const last = shown.at(-1);
  const listeners: Listener[] = shown.map(({ row }) =>
    ({ participant: toPublicParticipant(row), capabilities: row.capabilities as Profile }));
  return {
    total, matched: matched ?? total, listeners,
    ...(hasNext && last ? { nextCursor: encodeCursor({ s: c.sort, d: c.dir, k: last.cursorKey, i: last.row.id }) } : {}),
    ...(facets ? { facets } : {}),
  };
}
