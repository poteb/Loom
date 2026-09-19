# Loom — Lobby Listeners Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Lobby sidebar's stack of profile cards with one **Listeners (N)** line and a searchable, filterable, sorted, paged directory at `/lobby/listeners`, served by a new core query that filters in SQL — so a Lobby with thousands of listeners neither floods the sidebar nor ships every profile on every metadata read.

**Architecture:** Core gains `listListeners(actor, query)` in `src/core/src/lobby/listeners.ts`: whole-document `jsonb` containment behind one partial GIN index, a `(sort key, id)` cursor, `total`/`matched` counts and four selection-inclusive facets. `getWeave` stops carrying Lobby profiles altogether, and a new `GET /api/lobby/participants/me` answers "my own profile" with `me`'s token on all three Lobby routes. The web session gains two sequenced, identity-owned side reads (my profile, the listener count); the page itself is a new route with its query string as its state.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, drizzle-orm over postgres-js, Hono, Preact 10 + `@preact/preset-vite`, Vite 7, Vitest 4 (node environment against real Postgres and a real server; happy-dom via a `// @vitest-environment happy-dom` docblock for DOM tests), `@testing-library/preact` 3.

**Spec:** docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md (read it whole before any task). Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`.

**Base:** branch `feat/lobby-listeners` off `main` **after PR #18** (`fix/blank-opener-and-home-link`) merges. From PR #18 this plan consumes, unchanged: `HomeLink({ openMainInPlace?: () => void })` in `src/web/src/components/HomeLink.tsx`; `leavingIsSafe(storage, notice, key?): boolean` in `src/web/src/persistence.ts`; `RouteDeps = { client, storage, notice, openInPlace, openMainInPlace }` in `src/web/src/app.tsx`; `WeaveRoute`/`WeaveView` in their post-#18 shape. PR #18 also establishes the rule this plan extends: **every navigation away from a page goes through `leavingIsSafe`** — per entry where the destination is one entry, page-level where it is not. PR #18 does **not** touch `src/web/src/session.ts`, so every `session.ts` line number cited in the spec and here is valid before and after it. PR #18 also changed core: a blank opener appends **no** `message` event, so a Weave created with `opener: ""` is born at `lastSeq` **2** (`weave` + `participant.joined`) and with `opener: "hi"` at **3**.

## Global Constraints

- **Branch** `feat/lobby-listeners`, one commit per task with the exact subject the task gives, ending with the `Co-Authored-By:` trailer the controller states in that dispatch. No pushes, no PR, until the plan is finished.
- **Rules live in `core`; adapters carry types only.** The REST route parses the query string and hands the values over — every bound, default and normalisation is `listeners.ts`'s. The client package mirrors the types by hand and imports nothing from core.
- **`listListeners(db, actor, query)` input:** `q?`, `models?: { model: string; effort?: string }[]`, `tools?: string[]`, `runtime?: string`, `serves?: "anyone" | "owner" | "list"`, `sort?: "name" | "owner" | "joined"` (default `"name"`), `dir?: "asc" | "desc"` (default `"asc"`), `limit?: number` (default **50**, `0..MAX_PAGE_LIMIT`), `cursor?: string`, `facets?: boolean` (default `true`).
- **Output:** `{ total, matched, listeners: { participant, capabilities }[], nextCursor?, facets? }`. `total` = every listener in the Lobby ignoring `q` and every filter; `matched` = after `q` and the filters; both `count(*)`, never `listeners.length`. `nextCursor` is absent on the last page and whenever `limit` is 0. `facets` is absent only when the caller passed `facets: false`.
- **Validation bounds, all in core:** `q` trimmed, ≤ 100 chars; `models` entries `{ model: 1–100, effort?: 1–32 }`, ≤ 20; `tools` each 1–64, ≤ 50; `runtime` 1–64; `serves` one of the three words; `sort`/`dir` closed enums; `limit` an integer `0 <= limit <= 1000` (`MAX_PAGE_LIMIT`, quoted from `paging.ts`, **not** `validatePage`, which rejects 0); `facets` a boolean. Anything else is `errors.validation`.
- **Empty means absent — and empty means an *empty array*, not a falsy `.length`.** `tools: []`, `models: []` and a blank or whitespace-only `q` are **normalised to absent** before any predicate is built. Only `Array.isArray(v) && v.length === 0` normalises: `{}`, `5`, `null` and `""` are **supplied values**, and every one of them travels on to validation and is rejected with `validation`. A truthiness test (`input.models?.length ? … : undefined`) would read all four as "no filter" and answer `filter={"tools":{}}` with the whole Lobby. The same rule for scalars: **absent is `undefined` and nothing else**, so a supplied non-string `q` is `validation`, and `sort`/`dir`/`limit` take their defaults with `=== undefined` rather than `??`, under which a supplied `null` would silently become `"name"`, `"asc"` and 50. `matches(profile, { tools: [] })` accepts every profile including one with no `tools` key (`[].every(…)` is `true`, `matching.ts:46`), while `@> '{"tools":[]}'` would exclude it; and `models: []` is rejected outright by `validateRequirements` (`.min(1)`, `matching.ts:29`), which a UI control going from one chip to none must not turn into a 400.
- **The SQL must agree with `matches()`/`admits()` for every input both accept.** That is a property test over a table of profiles × filters, not a hope.
- **Matching semantics:** `q` = case-insensitive substring of the participant `name` **or** the profile `owner`; `models` = any-of, `{ model }` matching any effort and `{ model, effort }` the exact pair; `tools` = all-of; `runtime` = equality; `serves` `anyone` → `serves === "anyone"`, `owner` → `serves === "owner"` **or absent**, `list` → `serves` is an array. All filters ANDed with each other and with `q`.
- **Ordering:** `name` → `lower(participants.name)`, `owner` → `lower(capabilities->>'owner')`, `joined` → `participants.joined_at`; in every case the tie-break is `participants.id` **in the same direction**. Every sort key is non-null by invariant (`name`/`joined_at` are `NOT NULL`; a listener's profile always carries `owner`), so no `NULLS` clause and no null branch in the cursor.
- **Cursor** = `base64url(JSON.stringify({ s, d, k, i }))`, compared as a tuple: `(key, id) > ($k, $i)` for `asc`, `<` for `desc`. Malformed, or `s`/`d` disagreeing with the query → `errors.validation`. A **stale** cursor (its row gone or changed) is **not** an error.
- **The cursor's `k` is validated by the decoder, never by Postgres.** `s` and `d` decide what a legal key looks like, and a key that is not one is `validation` before a statement is issued: for `joined`, exactly the string `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` emits — a strict regex plus a range check on the captured fields, and **no `Date`**, which would drop the microseconds the format exists to keep; for `name` and `owner`, a non-empty string within a length bound. Anything looser hands `"not-a-date"::timestamptz` to the database, which is a 500 for a value that came out of the address bar.
- **The `joined` key is lossless.** The page query selects `to_char(p.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key`, that exact string is the cursor's `k`, and the comparison is `$k::timestamptz`. **No JS `Date` on that path** — `toPublicParticipant` renders `joinedAt` through `Date.toISOString()` (`actors.ts:11-15`, milliseconds) while the column is `timestamptz` (microseconds, `db/schema.ts:50`), which would duplicate rows ascending and skip them descending. The participant's displayed `joinedAt` is unchanged.
- **Facets:** top **20** values each (`tools`, `runtimes`, `models`), top **10** efforts per model, `more` / `moreEfforts` answered by asking for one row more (21 / 11) rather than a second count; ordered `count desc, value asc`; `serves` always returns its three kinds with counts including zeros.
- **Each facet is computed over the search-and-filter result MINUS that facet's own filter.**
- **Facets are selection-inclusive, including at zero.** Every facet `UNION`s its selected values, `LEFT JOIN`ed onto the aggregate with `coalesce(count, 0)` — a ranked query cannot contain a value whose count is 0, because there is no row to rank. A selected value is always in its facet's list, with its true count under the other filters, which may be `0`.
- **Model ranking is staged:** aggregate **one row per model** (`count(DISTINCT id)`, so a listener declaring a model at two efforts counts once), rank those with `row_number()`, keep the top 21 plus the selected models; only then aggregate efforts **for the kept models** and rank within each. Ranking a grouping-set result ranks effort rows too and lets one many-effort model push others past the cut.
- **Every containment predicate names `capabilities` itself**, never `capabilities->'…'`: `@> '{"tools":[…]}'`, `@> '{"models":[{"model":…}]}'`, `@> '{"runtime":…}'`, `@> '{"serves":"anyone"}'`. A GIN index serves only the expression it indexes.
- **One new index, migration `0004`:** `CREATE INDEX "participants_capabilities_idx" ON "participants" USING gin ("capabilities" jsonb_path_ops) WHERE "capabilities" IS NOT NULL;` — proven by an **`EXPLAIN` plan test**, not by its presence in `pg_indexes`.
- **`q` is escaped and parameterised**: `\` → `\\`, then `%` → `\%`, `_` → `\_`, applied with `ESCAPE '\'`, the value always a bind parameter.
- **`getWeave` blanks the `capabilities` of EVERY participant of the Lobby's Weave**, the caller's own included; `capabilities: null`, never absent. `findAgents` is untouched.
- **`GET /api/lobby/participants/me`** (core `getMyLobbyParticipant`, gated by `assertParticipantOf`) is the one way to read your own profile. The web calls it with **`me.token`**, never with the page reader — on `/w/<lobby secret>` the page reads with the secret, which owns no participant row.
- **Request-number sequencing.** Each side read takes `n = ++seq` when it **starts**; its answer *or rejection* is acted on only if `n > applied`, which it then sets. The generation counter answers "is this session still the one that asked?", not "is this the newest answer?". **The failure path is not an exception to this** — in either side read, and on the listeners page's own queries: the ordering guard and the watermark come **before** any side effect, because a rejection's side effects (invalidating a credential, painting an error, publishing a "count unavailable") are more destructive than an answer's, not less. A success path that is guarded and a failure path that is not is the bug this sentence names.
- **A helper's return value is part of its contract.** `recoverFromCredentialFailure` performs the invalidation and then *reports whether the caller must switch readers* — `if (recovered?.reload) void doLoad();` at **every** call site, the two existing ones (`session.ts:335`, `:397`) and every new one. Calling it for its side effect alone leaves the page reading with a credential the helper has just retired.
- **The profile cache is owned by an identity**: `{ participantId, token, profile }`, applied only while `state.me` names the same id **and** token, cleared by `join()`, by an invalidation and by a new `doLoad`. `withMyProfile` is the single place `me` is built, and it compares the id. The listener count needs no identity key — it describes the Lobby.
- **The rejection guard comes before any side effect.** A rejected own-profile read is acted on only if the captured `generation`, `id`, `token` and `n` all still hold; otherwise it is discarded **silently** — no error, no retry, no write, no `onWrite`, no cache clear, no `set()`. A stale rejection for the **same** identity (one that lands after a newer answer was acted on) is also dropped: a newer success is later evidence about that token, and deleting a credential cannot be undone.
- **401/403 on the own-profile read invalidates the identity** through `recoverFromCredentialFailure(e, failed: "page" | "identity")`. With `failed: "identity"` and `readingWithToken`, it is the page credential and takes today's path — invalidate, then `{ reload: true }` when a secret remains, **which the own-profile handler acts on** (`if (recovered?.reload) void doLoad();`), because switching readers is the caller's job in every other call site too. With `failed: "identity"` on a secret target, the sibling rule runs: `invalidateIdentity` + `onWrite`, clear the cache, `set({ me: undefined, readOnlyReason: "secret-fallback" })` — and the page is **never reloaded**, the stream and the generation are untouched. Transient failures (network, 5xx) invalidate nothing.
- **Listener count triggers:** the initial load (once discovery says this Weave is the Lobby), a late discovery recovery in `retryLobbyData`, and every `refreshInfo`. `participant.capabilities_changed` is covered by the refresh it already schedules. Read with the **page reader**, generation-guarded, sequenced (on the answer **and** on the rejection), non-fatal; a `401`/`403` from it is a page-credential failure and takes the existing path, return value acted on. It **never renders as "Listeners (0)"** — an absent count is an absent number. An accepted non-credential failure sets `listenerCountError`, cleared by the next success, so "not answered yet" and "asked and failed" are different states and are worded differently (spec §5.1): plain **Listeners** while pending, **Listeners** plus "count unavailable" after a failure with no number, and the **last known number** kept when there is one.
- **REST query string:** `?q=&filter=<json>&sort=&dir=&limit=&cursor=&facets=false`, where `filter` carries `{ models?, tools?, runtime?, serves? }`. The page's own URL uses the same encoding.
- **`history.replaceState` only, and only to rewrite this page's own query string while `location.pathname` is already `/lobby/listeners`.** Never `pushState`; never when the page is rendered in place (`openListenersInPlace`), where the URL is left entirely alone.
- **Page size 50**, "Show more" sends `nextCursor` and **appends**; a control change drops the cursor and starts a fresh query.
- **Nothing is dropped silently.** Every value the page takes out of a URL is validated against **core's own bounds** — not merely shape-sniffed — and every supplied value that is discarded sets `partial`, which is what renders the "part of this link was not understood" line (spec §5.4). That includes **individual entries of an array**: a `.filter()` that quietly removes three of four models is a link that lies about what it shows. A value that is simply absent is not a drop and is not reported.
- **A read whose failure costs only its own line is not folded into a rejecting `Promise.all`.** `Promise.all` says "all of these or none": right for the queries inside one `listListeners` call, wrong for a page cell. The listener count beside two other counts is caught on its own, so its failure removes one line rather than three.
- **An error never renders as an empty directory.** "No listener matches these filters" appears only after a **successful** read returning zero rows; a rejected read shows the server's message above whatever rows are on screen, and the counts line says nothing rather than zero.
- **The narrowed promise:** this work removes the repeated profile **snapshot** from metadata. Profiles still travel over the event log (`participant.capabilities_changed` carries the whole profile, `profile.ts:66-67`, and a load backfills the whole history, `session.ts:504-512`). No sentence in code comments, docs or commit messages may claim otherwise.
- **No MCP tool and no new CLI command.** `loom lobby` gets a compatibility merge with `findAgents` so its output is unchanged; that is the only CLI edit.
- **Tests:** test-first, RED before GREEN, **one rule per test**, real Postgres (no database mocks), pristine output, exact expectations never loosened to pass. Build before a package's tests: `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build`. Run one file with `cd src/<pkg> && npx vitest run test/<file>`.
- **Seq and event-count expectations use exact values and account for the blank-opener rule** (PR #18): `opener: ""` → no `message` event, `lastSeq` 2; `opener: "hi"` → `lastSeq` 3.
- **Never `cb?.(write())`.** A write happens first, into a variable; the callback reports it afterwards. `onWrite?.(invalidateIdentity(…))` skips the write itself when nobody is listening.
- **Every async function that awaits and then writes state re-checks its generation *inside itself*, immediately before publishing** — not only in its caller. `refreshInfo` does this at `session.ts:268` for exactly this reason.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/lobby/listeners-input.ts` (new) | `ListenersQuery`, `ListenersPage`, `Listener`, `FacetValue`, `ModelFacet`, `ListenersFacets`, `ListenersSort`, `ServesKind`; `validateListenersQuery` (bounds + normalisation); `encodeCursor` / `decodeCursor`. No database, no SQL |
| `src/core/src/lobby/listeners.ts` (new) | `listListeners`: authorisation, the base predicate and filter fragments, the page query with its lossless cursor key, the two counts, the four facet queries and the fold |
| `src/core/src/lobby/profile.ts` (modify) | `getMyLobbyParticipant` beside `setCapabilities`; `findAgents` unchanged |
| `src/core/src/weaves.ts` (modify, `getWeave` at lines 95–104) | Blank `capabilities` for every participant of the Lobby's Weave |
| `src/core/src/types.ts` (modify, lines 23–27) | The doc comment on `PublicParticipant.capabilities` |
| `src/core/src/db/schema.ts` (modify, lines 51–54) | The partial `jsonb_path_ops` GIN index on `participants.capabilities` |
| `src/core/drizzle/0004_*.sql` + `meta/` (new) | Migration 0004, generated by drizzle-kit with its snapshot |
| `src/core/src/index.ts` (modify, near lines 84–86) | `listListeners` and `getMyLobbyParticipant` on the facade, both through `resolveInLobby` |
| `src/server/src/routes/lobby.ts` (modify) | `GET /listeners` and `GET /participants/me`; parse only, never narrow |
| `src/server/src/app.ts` (modify, lines 84–88) | `/lobby/listeners` and `/lobby/listeners/` in the enumerated static paths |
| `src/server/src/main.ts` (modify, line 33) | Boot wording names the new path |
| `src/client/src/types.ts` (modify) | The hand-written mirrors of the new core types |
| `src/client/src/client.ts` (modify, after `findAgents` at line 120) | `listListeners(query)` and `getMyLobbyParticipant()` |
| `src/cli/src/commands/lobby.ts` (modify, lines 58–70) | `loom lobby` merges `findAgents({})` by participant id so its output is unchanged |
| `src/web/src/side-reads.ts` (new) | `createCounter()` and `isCurrent(stamp, now)`: the sequencing and identity-ownership rule, pure and unit-testable, so `session.ts` gains wiring rather than policy |
| `src/web/src/session.ts` (modify) | `listenerCount` and `listenerCountError` in `SessionState`, the identity-owned profile cache and `withMyProfile`, the two side reads on their triggers, `recoverFromCredentialFailure(e, failed)` and the sibling invalidation rule |
| `src/web/src/app.tsx` (modify) | `Route` gains `{ kind: "listeners" }`; `routeOf` matches `/lobby/listeners` and its trailing slash; `RouteDeps` gains `openListenersInPlace` |
| `src/web/src/components/listeners/ListenersRoute.tsx` (new) | Resolves the Lobby pointer, picks a credential, owns the join form and the 401 rule; renders `ListenersPage` |
| `src/web/src/components/listeners/ListenersPage.tsx` (new) | Search, controls, sort, counts line, the `ProfileCard` grid, Show more, and every loading/empty/error state |
| `src/web/src/components/listeners/FacetChips.tsx` (new) | One facet's chips: counts, selected state, the zero-count selected chip, the nested effort row |
| `src/web/src/components/listeners/listeners-query.ts` (new) | `ListenersView` ⇄ query string, both directions, shape-checked; and the one `replaceState` rule |
| `src/web/src/components/ListenersLink.tsx` (new) | The sidebar's "Listeners (N)" line: link, or button when leaving is not safe |
| `src/web/src/components/ProfileCard.tsx` (modify) | `ProfileCards` removed; `ProfileCard` and `modelSpecs` stay and are reused by the page |
| `src/web/src/components/WeaveView.tsx` (modify, sidebar at lines 99–105) | `ProfileCards` → `ListenersLink` |
| `src/web/src/components/WeaveRoute.tsx` (modify) | Threads `openListenersInPlace` and the listeners link's dependencies through to `WeaveView` |
| `src/web/src/components/main/LobbySummary.tsx` (modify, lines 43–62) | The listener count comes from `listListeners({ limit: 0, facets: false })` |
| `src/web/src/styles.css` (modify) | The directory grid, chips, the counts line, the sidebar line |
| `src/core/test/lobby-listeners-input.test.ts` (new) | Validation, normalisation and the cursor codec as pure units |
| `src/core/test/lobby-listeners.test.ts` (new) | Every `listListeners` rule against real Postgres, including the plan test and the `matches` property test |
| `src/core/test/db.test.ts` (modify) | The GIN index exists, is partial and is `jsonb_path_ops` |
| `src/core/test/lobby-profile.test.ts` (modify) | `getMyLobbyParticipant` and its auth matrix |
| `src/core/test/weaves.test.ts` (modify) | `getWeave` blanks every Lobby profile and leaves other Weaves alone |
| `src/server/test/lobby-routes.test.ts` (modify) | Both new routes and both auth matrices |
| `src/server/test/static.test.ts` (modify) | Nine static paths, the JSON 404, the API-only app |
| `src/client/test/client.test.ts` (modify) | Both wrappers round-tripped against a real server |
| `src/cli/test/lobby.test.ts` (modify) | `loom lobby` still prints a profile summary per listener |
| `src/claude-channel/test/lobby.test.ts` (modify, lines 217, 223) | The two-step-leave assertions read `findAgents` instead of `getWeave` |
| `src/web/test/side-reads.test.ts` (new) | `createCounter` and `isCurrent` as units |
| `src/web/test/session.test.ts` (modify) | The count's triggers, the own-profile read, the ordering/ownership races and the rejection rules |
| `src/web/test/listeners-query.test.ts` (new) | The query-string codec both ways, including malformed input |
| `src/web/test/listeners-page.test.tsx` (new, happy-dom) | The route, the page and the sidebar line |
| `src/web/test/components.test.tsx` (modify) | The Offer form on all three Lobby routes |
| docs | ARCHITECTURE §9/§12, SECURITY §4a/§9.1, TESTING, KNOWN-ISSUES, v2-notes, `src/web/README.md`, `src/core/README.md` |

**Why ten tasks rather than the spec's seven.** Spec §10 step 1 is split into Tasks 1 and 2 along a clean seam — everything that needs no database (types, bounds, normalisation, the cursor codec, the schema change and its migration) from everything that is SQL — because it is by far the largest step and a reviewer can approve each half on its own. Spec §10 step 7 is split into Tasks 8 and 9 for the reason the last plan split its own docs step out: docs need the real test totals, which only exist once every code task is green. Everything else follows §10 one for one, in its order.

---

### Task 0: Branch

- [ ] Confirm PR #18 is merged into `main` and that `main` contains `src/web/src/components/HomeLink.tsx` and `leavingIsSafe` in `src/web/src/persistence.ts`. If either is missing, stop: this plan's web tasks consume them.
- [ ] `git checkout main && git pull && git checkout -b feat/lobby-listeners`
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm -r build`
- [ ] Confirm the baseline is green: `pnpm --workspace-concurrency=1 -r test`. Record the file/test totals in the branch's first commit message body — Task 9 compares against them.

---

### Task 1: Core — the listeners query input, the cursor codec, and migration 0004

Spec §2.1 (shape), §2.3 (validation and normalisation), §2.5 (the cursor, including the lossless `joined` key), §2.8 (the index).

**Files:** Create `src/core/src/lobby/listeners-input.ts`; Modify `src/core/src/db/schema.ts` (lines 51–54); Create `src/core/drizzle/0004_*.sql` and its `meta/` snapshot (generated); Test `src/core/test/lobby-listeners-input.test.ts` (new), `src/core/test/db.test.ts` (modify).

**Interfaces:**
- *Consumes:* `MAX_PAGE_LIMIT` from `src/core/src/paging.ts`; `errors` from `src/core/src/errors.ts`; `validateRequirements` and `Profile` from `src/core/src/lobby/matching.ts`; `PublicParticipant` from `src/core/src/types.ts`.
- *Produces:*
```ts
export type ListenersSort = "name" | "owner" | "joined";
export type ServesKind = "anyone" | "owner" | "list";
export type Listener = { participant: PublicParticipant; capabilities: Profile };
export type FacetValue = { value: string; count: number };
export type ModelFacet = { model: string; count: number; efforts: FacetValue[]; moreEfforts: boolean };
export type ListenersFacets = {
  models: { values: ModelFacet[]; more: boolean };
  tools: { values: FacetValue[]; more: boolean };
  runtimes: { values: FacetValue[]; more: boolean };
  serves: { values: FacetValue[]; more: boolean };
};
export type ListenersQuery = {
  q?: string; models?: { model: string; effort?: string }[]; tools?: string[];
  runtime?: string; serves?: ServesKind; sort?: ListenersSort; dir?: "asc" | "desc";
  limit?: number; cursor?: string; facets?: boolean;
};
export type ListenersPage = {
  total: number; matched: number; listeners: Listener[]; nextCursor?: string; facets?: ListenersFacets;
};
/** Bounds, defaults and normalisation. Returns the query every predicate is built from. */
export type CleanQuery = {
  q?: string; models?: { model: string; effort?: string }[]; tools?: string[];
  runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";
  limit: number; facets: boolean; cursor?: Cursor;
};
export type Cursor = { s: ListenersSort; d: "asc" | "desc"; k: string; i: string };
export function validateListenersQuery(q: ListenersQuery | undefined): CleanQuery;
export function encodeCursor(c: Cursor): string;
export function decodeCursor(raw: string, sort: ListenersSort, dir: "asc" | "desc"): Cursor;
/** `%`, `_` and `\` escaped for an `ILIKE … ESCAPE '\'` pattern. */
export function likePattern(q: string): string;
```

- [ ] **Step 1: Failing tests** in `src/core/test/lobby-listeners-input.test.ts` (no database — a plain unit file):
  - `validateListenersQuery(undefined)` → `{ sort: "name", dir: "asc", limit: 50, facets: true }` and no filter keys.
  - Defaults: an empty object gives the same.
  - `q: "  dana  "` → `q: "dana"`; `q: "   "` → `q` **absent**; `q: "x".repeat(101)` → `validation`.
  - **A supplied non-string `q` is `validation`, not "absent"**: `q: 42` → `validation`. Absent is `undefined` and nothing else.
  - `tools: []` → `tools` **absent**; `models: []` → `models` **absent**; `tools: [" shell "]` → `["shell"]`.
  - **Only an actually empty array normalises to absent** — four tests, one rule each: `tools: {}` → `validation`; `models: 5` → `validation`; `models: null` → `validation`; `tools: ""` → `validation`. The regression these exist for: a REST caller sending `filter={"tools":{}}` must not be served **every** listener.
  - `models: [{ model: "m", effort: "high" }]` survives; `models: [{ model: "" }]` → `validation`; 21 entries → `validation`; `tools` of 51 → `validation`.
  - `runtime: ""` → `validation`; `serves: "nobody"` → `validation`; `sort: "age"` → `validation`; `dir: "up"` → `validation`.
  - `limit: 0` → `0` (legal); `limit: 1000` → `1000`; `limit: 1001` → `validation`; `limit: -1` → `validation`; `limit: 1.5` → `validation`; `limit: NaN` → `validation`.
  - `facets: false` → `false`; `facets: "no"` → `validation`.
  - **A supplied `null` is a value, not an absence** — three tests: `limit: null` → `validation` (not the default 50); `sort: null` → `validation` (not `"name"`); `dir: null` → `validation`. The `??` that would have swallowed all three is the same defect as `?.length` one bullet up.
  - `encodeCursor`/`decodeCursor` round-trip a cursor whose `k` contains `+`, `/` and `=` (base64url must not mangle it) and one whose `k` is `2026-09-19T12:00:00.123456Z`.
  - `decodeCursor("not-base64!", "name", "asc")` → `validation`; a cursor of valid base64url that is not JSON → `validation`; JSON missing `i` → `validation`; `i` that is not a uuid → `validation`; a cursor with `s: "owner"` decoded for `sort: "name"` → `validation`; same for a `d` mismatch.
  - **A `raw` that is not a string is `validation`, not a `TypeError`**: `decodeCursor(42 as unknown as string, "name", "asc")` → `validation`. `Buffer.from(42, "base64url")` throws a `TypeError`, which is a 500.
  - **A `joined` key that is not the exact string the SQL emits is `validation`, never a 500** — the finding this codec exists to close. One test per shape, all with `sort: "joined"`: `k: "not-a-date"`; `k: "2026-09-19T12:00:00.123Z"` (milliseconds — `.US` is always six digits); `k: "2026-09-19 12:00:00.123456Z"` (a space instead of `T`); `k: "2026-09-19T12:00:00.123456"` (no `Z`); `k: "2026-13-19T12:00:00.123456Z"` (month 13); `k: "2026-09-19T24:00:00.123456Z"` (hour 24); `k: "2026-09-19T12:60:00.123456Z"` (minute 60). Each must reach the caller as `validation`, so that `$k::timestamptz` never sees it.
  - **A genuine emitted `joined` key still round-trips**: `k: "2026-09-19T12:00:00.123456Z"` decodes unchanged, **character for character** — the test that would fail if the decoder ever normalised through `Date` and dropped the microseconds.
  - **Text keys are length-bounded**: `sort: "name"` with a `k` of 300 characters → `validation`; a `k` of `""` is legal for neither sort (a lowered `name` and a lowered `owner` are both non-empty) → `validation`. A `k` of 64 characters is accepted for `owner`.
  - There is **no null-key form to decode**: spec §2.5 establishes every sort key as non-null (`name`/`joined_at` are `NOT NULL`, a listener's profile always carries `owner`), so `k: null` is simply "not a string" → `validation`, and no null branch is written.
  - `likePattern("100%_a\\b")` → `"%100\\%\\_a\\\\b%"` (escape `\` first, then `%` and `_`).
- [ ] **Step 2: RED** — `cd src/core && npx vitest run test/lobby-listeners-input.test.ts`.
- [ ] **Step 3: Implement `listeners-input.ts`.** Bounds through one zod schema that reuses `validateRequirements` for the `{ models, tools, runtime }` third, **after** normalisation has removed the empty arrays:
```ts
const MAX_Q = 100;

export function validateListenersQuery(input: ListenersQuery = {}): CleanQuery {
  // Absent is `undefined` and nothing else. A supplied `q` that is not a string is a caller error,
  // not an empty search box — reading it as "absent" would answer a nonsense query with the whole
  // Lobby instead of a 400.
  if (input.q !== undefined && typeof input.q !== "string") throw errors.validation("q must be a string");
  const q = input.q?.trim();
  if (q !== undefined && q.length > MAX_Q) throw errors.validation(`q must be at most ${MAX_Q} characters`);
  // An empty filter is no filter: `matches` accepts every profile for `tools: []`, and a control
  // that goes from one chip to none must not be a 400 (spec §2.3). **Only an actually empty array**
  // — `?.length` is a truthiness test, and `{}`, `5` and `null` are all falsy-length: each would be
  // silently normalised to "no filter", so `filter={"tools":{}}` over REST would return every
  // listener. Anything that is not an empty array is passed on **unchanged** to `validateRequirements`,
  // whose schema rejects it with `validation`.
  const emptyArrayToAbsent = <T>(v: T): T | undefined => (Array.isArray(v) && v.length === 0 ? undefined : v);
  const models = emptyArrayToAbsent(input.models);
  const tools = emptyArrayToAbsent(input.tools);
  const req = validateRequirements({ models, tools, runtime: input.runtime });
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
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PAGE_LIMIT) {
    throw errors.validation(`limit must be an integer between 0 and ${MAX_PAGE_LIMIT}`);
  }
  if (input.facets !== undefined && typeof input.facets !== "boolean") throw errors.validation("facets must be a boolean");
  return { q: q || undefined, ...req, serves: input.serves, sort, dir, limit,
    facets: input.facets ?? true, cursor: input.cursor === undefined ? undefined : decodeCursor(input.cursor, sort, dir) };
}
```
  and the codec, which is the only place base64url is spelled out:
```ts
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
/**
 * Exactly what `to_char(joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` emits and
 * nothing else (spec §2.5): four-digit year, `.US` is always **six** digits, always `T` and `Z`.
 * The pattern is matched against the string the caller handed back — **never round-tripped through
 * a JS `Date`**, which holds milliseconds and would quietly turn `.123456Z` into `.123Z`, which is
 * the paging bug §2.5 exists to prevent.
 */
const JOINED_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;
/** A key is a value out of a URL. Bounded so an unbounded string never reaches a query: the longest
 *  key this query can emit is `lower(capabilities->>'owner')` over an owner of 64 (`profile.ts:27`)
 *  or `lower(name)` over 32 (`names.ts:3`), and lowercasing can widen a character, so 256 is the
 *  sanity bound rather than the exact one. */
const MAX_KEY = 256;

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
  // The key is validated **here**, not by Postgres. A well-formed cursor carrying `s: "joined"` and
  // `k: "not-a-date"` used to pass this decoder and fail at `$k::timestamptz` — a 500 for a value
  // that came out of the address bar. `sort` decides what a legal key looks like:
  if (sort === "joined") {
    const m = JOINED_KEY_RE.exec(k);
    if (!m) throw bad();
    // Shape is not sense: `2026-13-19T24:60:00.000000Z` matches the digits and is no instant.
    // Range-checked on the captured fields — still no `Date`, so no microsecond is lost.
    const [mo, day, hh, mm, ss] = [m[2], m[3], m[4], m[5], m[6]].map((g) => Number(g));
    if (mo! < 1 || mo! > 12 || day! < 1 || day! > 31 || hh! > 23 || mm! > 59 || ss! > 59) throw bad();
  } else if (k.length === 0 || k.length > MAX_KEY) {
    // `lower(name)` and `lower(capabilities->>'owner')` are both non-empty by the §2.5 invariant,
    // so an empty key names no row this query could have been at.
    throw bad();
  }
  return { s: sort, d: dir, k, i };
}
export function likePattern(q: string): string {
  return `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}
```
- [ ] **Step 4: GREEN** — `cd src/core && npx vitest run test/lobby-listeners-input.test.ts`.
- [ ] **Step 5: The index.** In `src/core/src/db/schema.ts`, add to the `participants` index list (lines 51–54):
```ts
  // `@>` over the whole profile document is what every listener filter is built from (spec §2.8);
  // partial because listeners are a minority of participants, and `capabilities IS NOT NULL` is a
  // constant predicate. `jsonb_path_ops` indexes `@>` at about half the size of the default class.
  index("participants_capabilities_idx").using("gin", sql`${t.capabilities} jsonb_path_ops`)
    .where(sql`${t.capabilities} IS NOT NULL`),
```
  Generate the migration: `cd src/core && npx drizzle-kit generate`. Confirm `drizzle/0004_*.sql` contains exactly one `CREATE INDEX … USING gin … WHERE "capabilities" IS NOT NULL` and that `drizzle/meta/_journal.json` gained one entry. Commit the generated SQL **and** the snapshot.
- [ ] **Step 6: Failing test** in `src/core/test/db.test.ts`, in the style of the existing index assertions: query `pg_indexes` for `participants_capabilities_idx` and assert its `indexdef` contains `USING gin`, `jsonb_path_ops` and `WHERE (capabilities IS NOT NULL)`.
- [ ] **Step 7: GREEN** — `cd src/core && npx vitest run test/db.test.ts` (the migration runs in `freshDb()`), then `npx vitest run` for the package.
- [ ] **Step 8: Commit** — `feat(core): listeners query input, cursor codec and the capabilities GIN index`

---

### Task 2: Core — `listListeners`

Spec §2.2 (authorisation), §2.4 (matching), §2.5 (ordering and paging), §2.6 (counts), §2.7 (facets), §2.8 (the SQL and the plan), §2.9 (where it lives).

**Files:** Create `src/core/src/lobby/listeners.ts`; Modify `src/core/src/index.ts` (add the facade method beside `findAgents`, near line 86); Test `src/core/test/lobby-listeners.test.ts` (new), `src/core/test/db.test.ts` (modify — the plan test).

**Interfaces:**
- *Consumes:* everything Task 1 produced from `listeners-input.js`; `getLobby` from `./lobby.js`; `assertCanRead`, `toPublicParticipant` from `../actors.js`; `matches`, `admits`, `type Profile` from `./matching.js`; `participants` from `../db/schema.js`; `Db` from `../db/index.js`.
- *Produces:* `listListeners(db: Db, actor: Actor, query?: ListenersQuery): Promise<ListenersPage>`, and on the facade `core.listListeners(actor, query?)` (through `resolveInLobby`).

- [ ] **Step 1: Failing tests** in `src/core/test/lobby-listeners.test.ts`. Build one seeded Lobby helper — `seed(profiles: Record<string, Profile>)` joining one participant per key and calling `setCapabilities` for each — plus a `lurker` with no profile. Every test asserts **names**, in order where order is the rule. One rule per test:
  - **Filters alone:** `models: [{ model: "opus-5" }]` (any effort); `models: [{ model: "opus-5", effort: "high" }]` (only the exact pair); `models` with two alternatives (any-of); `tools: ["shell", "github"]` (only the listener with both); `runtime: "node"`; `serves: "anyone"`; `serves: "list"`; `serves: "owner"`.
  - **`serves: "owner"` includes a profile with no `serves` key** — its own test.
  - **AND:** `tools` + `runtime` together; `q` + `models` together.
  - **Search:** matches a participant name case-insensitively; matches an `owner` case-insensitively; matches neither → empty; `q` containing `%` and `_` is literal (`a_b` does not match `axb`).
  - **Empty filters are no filter** (three tests): `tools: []`, `models: []`, `q: "   "` — each returns every listener and leaves `matched === total`.
  - **Sorting:** one table-driven test over the six `(sort, dir)` pairs, asserting the full expected order; plus `name` and `owner` ordering is case-insensitive (`Zed` after `alice`).
  - **Paging:** `limit: 2` then the `nextCursor` gives the next two with no overlap; `nextCursor` is absent on the last page and when `limit` is 0.
  - **Cursor stability when a listener joins mid-paging:** page 1 of `limit: 2` sorted by name, then a new listener whose name sorts **into** page 1, then page 2 by cursor — page 2 is what followed, no duplicate, no row from page 1. Mirror: a listener sorting **after** the cursor does appear.
  - **A stale cursor still works:** the participant the cursor names clears its profile, and the next page is still the rows after that position.
  - **A malformed cursor**, and a cursor whose `sort` disagrees with the query, are both `validation` **through `listListeners`**.
  - **A well-formed cursor carrying a `joined` key that is not a timestamp is `validation`, not a database error** — `encodeCursor({ s: "joined", d: "asc", k: "not-a-date", i: <a real uuid> })` passed to `listListeners({ sort: "joined", dir: "asc", cursor })` rejects with `validation` and **no statement is issued**. Asserted on the error `code`, because the failure this replaces was a 500 out of `$k::timestamptz`. Its twin: the `nextCursor` this query really emitted is accepted by the very next call, unchanged — the codec must reject rubbish without rejecting its own output.
  - **The `joined` cursor is lossless** — the precision test. Create four listeners, then `UPDATE participants SET joined_at = $2 WHERE id = $1` with four explicit timestamps inside one millisecond (`…T12:00:00.123400Z`, `.123450Z`, `.123456Z`, `.123999Z`). Page with `sort: "joined", limit: 1` through the whole list ascending, then descending: each direction visits all four exactly once, in the right order, with no duplicate and no skip.
  - **The non-null invariant:** every listener's profile carries a non-empty `owner` (`setCapabilities` with a profile that omits it is `validation`), and a **cleared** profile is not a listener (`setCapabilities(null)` drops the participant out of `total`, out of the page and out of every facet).
  - **`limit` bounds through `listListeners`:** `0` returns no rows but real counts and facets; `1001` is `validation`; the default page is 50.
  - **`facets: false`** omits `facets` and changes neither count.
  - **`total` ignores filters, `matched` reflects them**, and neither equals the page length (seed 5, `limit: 2`, one filter).
  - **Facets minus their own filter** — one test per facet: with `models: [opus-5]` selected, the `models` facet still reports `sonnet-5` with its count, while `tools`, `runtimes` and `serves` are computed **with** the models filter applied.
  - **A facet counts a listener once** when its profile lists the same model or tool twice.
  - **Top-20:** 25 distinct tools → 20 values and `more: true`.
  - **The effort facet is bounded:** 30 listeners declaring 30 distinct efforts for one model → 10 efforts and `moreEfforts: true`; the model's own `count` is the listener count, and a listener declaring that model at two efforts counts once.
  - **Model ranking depends only on listener counts:** one model with 50 distinct efforts (few listeners) and 21 models with more listeners each — the top 20 is the twenty with the most listeners, in that order.
  - **Selection-inclusive, including at zero** — four tests: a selected tool ranked outside the top 20 appears with its true count; a selected **runtime eliminated by another filter** appears with `count: 0`; a selected model outside the top 20 appears; a selected **effort** outside a model's top 10 appears.
  - **The `serves` facet always has three rows**, zeros included.
  - **Auth:** a Lobby participant succeeds; the Lobby's own secret succeeds; an instance keeper succeeds; a token of another Weave is `forbidden`; no credential is `invalid_token`; an agent key that has joined succeeds **through the facade** (`core.listListeners`).
  - **The SQL and `matches` agree** — the property test. A fixture of ~20 profiles covering the edges (no `tools` key, a stored empty `tools` array, one model at two efforts, a duplicated entry, `serves` absent / `"owner"` / `"anyone"` / an array, no `runtime`) × a table of filters (each alone, two ANDed, the three empty forms, one matching nothing). For every pair: the ids `listListeners` returns, sorted, equal the ids of the same rows filtered in memory with `matches`/`admits`.
- [ ] **Step 2: RED** — `cd src/core && npx vitest run test/lobby-listeners.test.ts`.
- [ ] **Step 3: Implement the predicates.** One `where` builder shared by every query, so the filters cannot drift between the page, the counts and the facets:
```ts
const base = (lobbyId: string) => and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities));

/** Whole-document containment, so the one GIN index on `capabilities` serves it (spec §2.8). */
function filterSql(c: CleanQuery, omit?: "models" | "tools" | "runtime" | "serves"): SQL[] {
  const out: SQL[] = [];
  if (c.q) {
    const p = likePattern(c.q);
    out.push(sql`(${participants.name} ILIKE ${p} ESCAPE '\\' OR ${participants.capabilities}->>'owner' ILIKE ${p} ESCAPE '\\')`);
  }
  if (c.models && omit !== "models") {
    const alts = c.models.map((m) => sql`${participants.capabilities} @> ${JSON.stringify({ models: [m.effort === undefined ? { model: m.model } : { model: m.model, effort: m.effort }] })}::jsonb`);
    out.push(sql`(${sql.join(alts, sql` OR `)})`);          // any-of
  }
  if (c.tools && omit !== "tools") {
    out.push(sql`${participants.capabilities} @> ${JSON.stringify({ tools: c.tools })}::jsonb`);  // all-of
  }
  if (c.runtime && omit !== "runtime") {
    out.push(sql`${participants.capabilities} @> ${JSON.stringify({ runtime: c.runtime })}::jsonb`);
  }
  if (c.serves && omit !== "serves") {
    out.push(c.serves === "anyone" ? sql`${participants.capabilities} @> '{"serves":"anyone"}'::jsonb`
      : c.serves === "list" ? sql`jsonb_typeof(${participants.capabilities}->'serves') = 'array'`
      // `admits` reads an absent `serves` as "owner" (matching.ts:54), so the default is included.
      : sql`(NOT (${participants.capabilities} ? 'serves') OR ${participants.capabilities} @> '{"serves":"owner"}'::jsonb)`);
  }
  return out;
}
```
- [ ] **Step 4: Implement the page query and the counts.** The sort key is selected **as text, by the database**, and is what the cursor carries:
```ts
const keySql = (sort: ListenersSort) => sort === "name" ? sql`lower(${participants.name})`
  : sort === "owner" ? sql`lower(${participants.capabilities}->>'owner')`
  : sql`${participants.joinedAt}`;
// The cursor key is rendered by Postgres and handed back to Postgres. `joined_at` is timestamptz
// (microseconds) and a JS Date holds milliseconds, so a key taken from `participant.joinedAt`
// would repeat a row ascending and skip rows descending (spec §2.5).
const cursorKeySql = (sort: ListenersSort) => sort === "joined"
  ? sql<string>`to_char(${participants.joinedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  : keySql(sort);
const afterCursor = (c: CleanQuery) => {
  if (!c.cursor) return undefined;
  // `c.cursor` came through `decodeCursor`, which has already checked that `k` is exactly what
  // `cursorKeySql` emits for this `sort` — so `::timestamptz` here can only ever see a timestamp.
  // A cast is not a validator: an unchecked `k` makes a hand-edited URL a 500 (Task 1).
  const k = c.sort === "joined" ? sql`${c.cursor.k}::timestamptz` : sql`${c.cursor.k}`;
  const key = keySql(c.sort);
  return c.dir === "asc" ? sql`(${key}, ${participants.id}) > (${k}, ${c.cursor.i})`
                         : sql`(${key}, ${participants.id}) < (${k}, ${c.cursor.i})`;
};
```
  The page selects the row plus `cursorKeySql(...) AS cursorKey`, orders by `key` then `id` in `dir`, and asks for `limit + 1`; the extra row decides `nextCursor = encodeCursor({ s, d, k: row.cursorKey, i: row.id })` from the **last returned** row. `total` is `count(*)` over `base` alone; `matched` is `count(*)` over `base + filterSql(c)` — **skipped, and set from `total`, when `c` has no `q` and no filter**. `limit: 0` skips the page query.
- [ ] **Step 5: Implement the facets.** Models in two stages, tools and runtimes in one, each selection-inclusive, exactly as spec §2.8 writes them:
```sql
WITH base AS (
  SELECT p.id, p.capabilities FROM participants p
  WHERE p.weave_id = $1 AND p.capabilities IS NOT NULL AND <every filter but this facet's own>
), pairs AS (
  SELECT DISTINCT b.id, m->>'model' AS model, m->>'effort' AS effort
  FROM base b, jsonb_array_elements(b.capabilities->'models') m
), model_counts AS (
  SELECT model, count(DISTINCT id) AS listeners FROM pairs GROUP BY model
), ranked_models AS (
  SELECT model, listeners, row_number() OVER (ORDER BY listeners DESC, model) AS rn FROM model_counts
), kept_models AS (
  SELECT model, listeners FROM ranked_models WHERE rn <= 21
  UNION
  SELECT s.model, coalesce(mc.listeners, 0)
  FROM unnest($2::text[]) AS s(model) LEFT JOIN model_counts mc ON mc.model = s.model
), effort_counts AS (
  SELECT p.model, p.effort, count(DISTINCT p.id) AS listeners
  FROM pairs p JOIN kept_models k ON k.model = p.model GROUP BY p.model, p.effort
), ranked_efforts AS (
  SELECT model, effort, listeners,
         row_number() OVER (PARTITION BY model ORDER BY listeners DESC, effort) AS rn FROM effort_counts
), kept_efforts AS (
  SELECT model, effort, listeners FROM ranked_efforts WHERE rn <= 11
  UNION
  SELECT s.model, s.effort, coalesce(ec.listeners, 0)
  FROM unnest($3::text[], $4::text[]) AS s(model, effort)
  LEFT JOIN effort_counts ec ON ec.model = s.model AND ec.effort = s.effort
)
SELECT k.model, k.listeners, e.effort, e.listeners AS effort_listeners
FROM kept_models k LEFT JOIN kept_efforts e ON e.model = k.model;
```
```sql
-- tools (runtimes identical, with `p.capabilities->>'runtime'` and `AND p.capabilities ? 'runtime'`)
WITH base AS ( … ), tool_counts AS (
  SELECT t.value AS tool, count(DISTINCT b.id) AS listeners
  FROM base b, jsonb_array_elements_text(b.capabilities->'tools') t GROUP BY 1
), ranked AS (
  SELECT tool, listeners, row_number() OVER (ORDER BY listeners DESC, tool) AS rn FROM tool_counts
)
SELECT tool, listeners FROM ranked WHERE rn <= 21
UNION
SELECT s.tool, coalesce(tc.listeners, 0)
FROM unnest($2::text[]) AS s(tool) LEFT JOIN tool_counts tc ON tc.tool = s.tool;
```
  and `serves` as one row of three `count(*) FILTER (WHERE …)` over `base` with the `serves` filter omitted. The fold in TypeScript is pure shaping: sort `count desc, value asc`, drop the 21st/11th row and set `more`/`moreEfforts` from its existence, append any selected value that fell outside in the same order, nest the efforts under their model.
- [ ] **Step 6: Assemble.** `listListeners` = `getLobby` → `assertCanRead` → `validateListenersQuery` → the queries that are needed (`Promise.all`; `limit: 0` skips the page, `facets: false` skips the four facet queries, no-filter skips `matched`) → the shape. Add the facade method in `src/core/src/index.ts` beside `findAgents`:
```ts
    listListeners: async (actor: Actor, query: ListenersQuery = {}) =>
      listeners.listListeners(db, await resolveInLobby(actor), query),
```
- [ ] **Step 7: GREEN** — `cd src/core && npx vitest run test/lobby-listeners.test.ts`.
- [ ] **Step 8: The plan test** in `src/core/test/db.test.ts`: seed ~3,000 listeners in one `INSERT … SELECT` over `generate_series` (profiles varying model, tool and runtime), then **in one transaction**: `ANALYZE participants`, `SET LOCAL enable_seqscan = off`, and `EXPLAIN` the tools, models and runtime filter queries — each plan text must contain `participants_capabilities_idx`. Assert on the plan text only, never on a duration. Add a comment saying this is the test that fails if a predicate is ever written against `capabilities->'tools'`.
- [ ] **Step 9: GREEN** — `cd src/core && npx vitest run test/db.test.ts && npx vitest run`.
- [ ] **Step 10: Commit** — `feat(core): listListeners — searched, filtered, sorted, paged and faceted`

---

### Task 3: Core — `getWeave` carries no Lobby profile, and `getMyLobbyParticipant`

Spec §3.1, §3.2 (the consumer table), §3.3 (the core function).

**Files:** Modify `src/core/src/weaves.ts` (`getWeave`, lines 95–104), `src/core/src/lobby/profile.ts` (after `setCapabilities`), `src/core/src/types.ts` (lines 23–27), `src/core/src/index.ts`, `src/client/src/types.ts` (the mirrored doc comment only), `src/cli/src/commands/lobby.ts` (lines 58–70), `src/mcp-tools/src/tools.ts` (the `get_weave` description, line 116); Test `src/core/test/weaves.test.ts`, `src/core/test/lobby-profile.test.ts`, `src/cli/test/lobby.test.ts`, `src/claude-channel/test/lobby.test.ts` (lines 217, 223).

**Interfaces:**
- *Consumes:* `getLobbyWeaveId` from `src/core/src/settings.ts`; `assertParticipantOf`, `toPublicParticipant` from `src/core/src/actors.ts`; `getLobby` from `src/core/src/lobby/lobby.ts`.
- *Produces:* `getMyLobbyParticipant(db: Db, actor: Actor): Promise<PublicParticipant>`; `core.getMyLobbyParticipant(actor)` on the facade.

- [ ] **Step 1: Failing tests.**
  - `src/core/test/weaves.test.ts`: `getWeave` on the **Lobby** returns `capabilities: null` for **every** participant — the caller's own included — while ids, names, kinds and roles are all still there. A second test: `getWeave` on **another Weave** is unchanged (a listener's row read through a different Weave is unaffected). A third: `findAgents` still returns profiles.
  - `src/core/test/lobby-profile.test.ts`, a new `describe("getMyLobbyParticipant")`: reads the caller's own participant **with** its profile straight after `setCapabilities`; reads the **row**, not the actor's copy (a second client changes the profile; the answer is the new one); a participant with no profile gets `capabilities: null`; the **Lobby secret** is `forbidden`; an **instance keeper** is `forbidden`; a credential for another Weave is `forbidden`; an unknown credential is `invalid_token`; an **agent key** that joined succeeds through `core.getMyLobbyParticipant`, and one that has not joined is `forbidden`.
  - `src/cli/test/lobby.test.ts`: the existing "lobby prints the Lobby, its participants and a profile summary each" must stay green; add one asserting a participant **without** a profile still prints `(no profile)` on the merged line.
  - `src/claude-channel/test/lobby.test.ts` lines 217 and 223: move both assertions from `core.getWeave(actor, L).participants.find(…)?.capabilities` to `core.findAgents(actor, {})`, keeping the rule identical — after `set_capabilities` the profile is there; after `leave_weave` it is gone **before** the credential is.
- [ ] **Step 2: RED** — `pnpm --filter @loom/core build && cd src/core && npx vitest run test/weaves.test.ts test/lobby-profile.test.ts`.
- [ ] **Step 3: Implement `getWeave`.** In `src/core/src/weaves.ts`:
```ts
  // The Lobby's profiles are a directory, not page metadata: `getWeave` used to carry every one of
  // them on every load and every refresh (spec §1). Read them with `listListeners` or `findAgents`,
  // and your own with `getMyLobbyParticipant` — there is no exception for the caller here, because
  // a `/w/<lobby secret>` read authenticates as the secret and owns no participant row (spec §3.1).
  const hideProfiles = (await getLobbyWeaveId(db)) === weaveId;
  return { weave: toPublicWeave(w), threads: ts.map(toPublicThread),
    participants: ps.map((p) => hideProfiles ? { ...toPublicParticipant(p), capabilities: null } : toPublicParticipant(p)),
    guidelines: guidelinesFor(await getInstanceGuidelines(db), w) };
```
- [ ] **Step 4: Implement `getMyLobbyParticipant`** in `src/core/src/lobby/profile.ts`, beside `setCapabilities`:
```ts
/**
 * The caller's own Lobby participant, profile included. The one way to read your own profile now
 * that `getWeave` carries none: authorised as `setCapabilities` is, by being that participant — a
 * Weave secret and an instance keeper own no profile and are refused.
 */
export async function getMyLobbyParticipant(db: Db, actor: Actor): Promise<PublicParticipant> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);
  // Re-read rather than returning the actor's copy: it was captured when the credential resolved,
  // and a profile set from another client a second ago would not be on it.
  const [row] = await db.select().from(participants).where(eq(participants.id, me.id));
  if (!row) throw errors.invalidToken();
  return toPublicParticipant(row);
}
```
  and on the facade: `getMyLobbyParticipant: async (actor: Actor) => getMyLobbyParticipant(db, await resolveInLobby(actor)),`.
- [ ] **Step 5: Doc comments.** `src/core/src/types.ts` and the mirror in `src/client/src/types.ts`: "The Lobby capability profile. Null everywhere but the Lobby — and null from `getWeave` **in** the Lobby too: read a listener's profile with `listListeners` or `findAgents`, and your own with `getMyLobbyParticipant`." Add one sentence to `get_weave`'s MCP description: profiles of Lobby participants are not included; use `find_agents`.
- [ ] **Step 6: The `loom lobby` compatibility merge.** In `src/cli/src/commands/lobby.ts`, the `lobby.action` handler:
```ts
    // `getWeave` no longer carries Lobby profiles (spec §3.1), so the summary column comes from
    // `find_agents`, which does. Two bounded reads, one command, identical output.
    const [info, agents] = await Promise.all([client.getWeave(where.weaveId), client.findAgents({})]);
    const profiles = new Map(agents.map((a) => [a.participant.id, a.capabilities]));
    …info.participants.map((p) => participantLine({ ...p, capabilities: profiles.get(p.id) ?? null }))
```
- [ ] **Step 7: GREEN** — `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build`, then `cd src/core && npx vitest run`, `cd src/cli && npx vitest run test/lobby.test.ts`, `cd src/claude-channel && npx vitest run test/lobby.test.ts`. Then the whole suite for those three packages.
- [ ] **Step 8: Commit** — `feat(core): getWeave carries no Lobby profiles; read your own with getMyLobbyParticipant`

---

### Task 4: REST and client — both routes, both wrappers

Spec §4.1 (both routes and the encoding argument), §4.2 (the auth matrix), §4.3 (the client).

**Files:** Modify `src/server/src/routes/lobby.ts`, `src/client/src/types.ts`, `src/client/src/client.ts` (after line 123); Test `src/server/test/lobby-routes.test.ts`, `src/client/test/client.test.ts`.

**Interfaces:**
- *Consumes:* `core.listListeners(actor, query)` and `core.getMyLobbyParticipant(actor)` from Tasks 2 and 3; `requireActor` from `src/server/src/auth.ts`; `errors` from `@loom/core`.
- *Produces:* `LoomClient.listListeners(query?: ListenersQuery): Promise<ListenersPage>` and `LoomClient.getMyLobbyParticipant(): Promise<Participant>`; the client-side mirrors `ListenersQuery`, `ListenersPage`, `Listener`, `ListenersSort`, `ServesKind`, `FacetValue`, `ModelFacet`, `ListenersFacets` — the same names and the same fields as Task 1's core types.

- [ ] **Step 1: Failing tests** in `src/server/test/lobby-routes.test.ts`:
  - `GET /api/lobby/listeners` round-trips a query: `q`, a `filter` carrying models-with-effort and tools, `sort`, `dir`, `limit`, then the returned `cursor`.
  - `filter` that is not JSON → 400 `validation` with the message `filter must be JSON`.
  - **`filter` that is JSON but is not an object** → 400 `validation` with the message `filter must be a JSON object` — one test each for `filter=[]`, `filter=null` and `filter=5`. The regression: `{ ...(5 as object) }` and `{ ...null }` both spread **nothing**, so a nonsense filter would silently return every listener; `{ ...[1,2] }` would instead smuggle in `{"0":1,"1":2}`. This is still "parse, hand over, let core decide" — whether the value is a filter-shaped thing at all is the adapter's decision, exactly as "is it JSON" already is; what a legal filter *contains* stays core's.
  - **A `filter` carrying an empty array still means "no filter"** end to end: `filter={"tools":[]}` → 200 with `matched === total`, while `filter={"tools":{}}` → 400 `validation` (core's rule from Task 1, asserted once through the route so the two cannot drift).
  - A non-numeric `limit` → 400 from **core**'s message (`limit must be an integer between 0 and 1000`); an unknown `sort` → 400.
  - `limit=0` → counts and facets with `listeners: []`; `facets=false` → counts with **no** `facets` key.
  - The `/listeners` auth matrix, row by row: Lobby participant token 200; the Lobby's own Weave secret 200; instance keeper 200; agent key that joined 200; agent key that has not joined 403; a token of another Weave 403; no credential 401; unknown credential 401.
  - `GET /api/lobby/participants/me` answers the caller's own participant with its profile for a participant token and for an agent key that joined; **403** for the Lobby secret and **403** for an instance keeper; 401 with no credential. (The two 403 rows are where it deliberately differs from `/listeners`.)
  In `src/client/test/client.test.ts`: `listListeners()` with no arguments hits the bare path; with filters it sends `filter` as JSON and the scalars as plain params, and the answer's `facets` and `nextCursor` survive; `getMyLobbyParticipant()` round-trips the caller's own profile.
- [ ] **Step 2: RED** — `pnpm --filter @loom/core build && cd src/server && npx vitest run test/lobby-routes.test.ts`.
- [ ] **Step 3: Implement the routes** in `src/server/src/routes/lobby.ts`, beside `GET /agents` (order is free — Hono matches literal segments, and `/participants/me` and `/participants/me/capabilities` are distinct paths):
```ts
  r.get("/listeners", async (c) => {
    const actor = await requireActor(c, core);
    const raw = c.req.query("filter");
    let filter: unknown = {};
    if (raw !== undefined && raw !== "") {
      // Only that it is JSON is decided here; what a legal filter contains is core's rule.
      try { filter = JSON.parse(raw); } catch { throw errors.validation("filter must be JSON"); }
      // …and that it is an *object*, because the line below spreads it. `{ ...5 }` and `{ ...null }`
      // spread nothing — a nonsense filter would become "no filter" and answer with the whole Lobby
      // — and `{ ...[1,2] }` would spread `{"0":1,"1":2}`. Nothing is narrowed here; the values
      // inside are still core's to accept or reject.
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
        throw errors.validation("filter must be a JSON object");
      }
    }
    return c.json(await core.listListeners(actor, {
      ...(filter as object),
      q: c.req.query("q"), sort: c.req.query("sort"), dir: c.req.query("dir"),
      limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
      cursor: c.req.query("cursor"),
      // `?facets=false` is the only way to turn them off; absence leaves core's default alone.
      facets: c.req.query("facets") === "false" ? false : undefined,
    } as ListenersQuery));
  });

  r.get("/participants/me", async (c) => c.json(await core.getMyLobbyParticipant(await requireActor(c, core))));
```
- [ ] **Step 4: Implement the client wrappers** in `src/client/src/client.ts`, after `findAgents`:
```ts
  /** The Lobby's listeners — every participant carrying a capability profile — searched, filtered,
   *  sorted and paged, with facet counts for the four filters. `{ limit: 0, facets: false }` asks
   *  for the counts alone, which is how a page shows "Listeners (N)" without downloading a profile. */
  async listListeners(query: ListenersQuery = {}): Promise<ListenersPage> {
    const { models, tools, runtime, serves, ...rest } = query;
    const q = new URLSearchParams();
    const filter = { models, tools, runtime, serves };
    if (Object.values(filter).some((v) => v !== undefined)) q.set("filter", JSON.stringify(filter));
    for (const k of ["q", "sort", "dir", "cursor"] as const) if (rest[k] !== undefined) q.set(k, rest[k]!);
    if (rest.limit !== undefined) q.set("limit", String(rest.limit));
    if (rest.facets === false) q.set("facets", "false");
    const qs = q.toString();
    return this.call("GET", `/api/lobby/listeners${qs ? `?${qs}` : ""}`);
  }
  /** This client's own Lobby participant, profile included — `getWeave` carries none in the Lobby. */
  getMyLobbyParticipant(): Promise<Participant> {
    return this.call("GET", "/api/lobby/participants/me");
  }
```
  and mirror the types in `src/client/src/types.ts`, hand-written, beside `Profile`/`FoundAgent`.
- [ ] **Step 5: GREEN** — `pnpm --filter @loom/core build && cd src/server && npx vitest run test/lobby-routes.test.ts && npx vitest run`; `pnpm --filter @loom/client build && cd src/client && npx vitest run`.
- [ ] **Step 6: Commit** — `feat(server,client): GET /api/lobby/listeners and /api/lobby/participants/me`

---

### Task 5: The `/lobby/listeners` route — server paths and the web router

Spec §5.2, and §5.5's credential resolution (the route shell only; the page itself is Task 6).

**Files:** Modify `src/server/src/app.ts` (lines 84–88), `src/server/src/main.ts` (line 33), `src/web/src/app.tsx`, `src/web/src/components/WeaveRoute.tsx`; Create `src/web/src/components/listeners/ListenersRoute.tsx`; Test `src/server/test/static.test.ts`, `src/web/test/listeners-page.test.tsx` (new, first line `// @vitest-environment happy-dom`).

**Interfaces:**
- *Consumes:* `RouteDeps` (post-#18: `{ client, storage, notice, openInPlace, openMainInPlace }`), `HomeLink`, `leavingIsSafe(storage, notice, key?)`, `readerFor(client, entry)`, `readWeaveEntry(storage, weaveId)`, `weaveKey(weaveId)`, `isCredentialFailure(e)`, `invalidateIdentity(storage, weaveId)`, `JoinLobbyForm` (`{ client, storage, notice, lobby: { weaveId, title }, onJoined, onJoinedInPlace }`), `LoomClient.listListeners` (Task 4).
- *Produces:* `RouteDeps.openListenersInPlace: () => void`; `Route` gains `{ kind: "listeners" }`; `routeOf("/lobby/listeners")`; and
```ts
export function ListenersRoute(deps: RouteDeps & { inPlace?: boolean }): JSX.Element;
```
  where `inPlace` is `true` when the route was reached through `openListenersInPlace` rather than by navigation — Task 6's `replaceState` rule reads it.

- [ ] **Step 1: Failing tests** in `src/server/test/static.test.ts`: `index.html` is served for `/lobby/listeners` and `/lobby/listeners/` (200, `content-type` contains `text/html`, body contains `<div id=app>`); `/lobby/listenersx` and `/lobby/listeners/extra` still answer the JSON 404 with `code: "not_found"`; the API-only app (no `webDist`) answers the JSON 404 for all **nine** paths.
- [ ] **Step 2: Failing tests** in `src/web/test/listeners-page.test.tsx` — the harness first, since every later DOM test uses it. Copy the shape from `main-page.test.tsx`: `BASE = "https://loom.test"` (**https**: `http://loom.test` throws `insecure_url`, the client allows plain http on loopback only), a `stubFetch(routes)` table where an unstubbed URL throws loudly, `POST /api/auth/ws-ticket` answered with a **fatal 403** so no socket and no reconnect timer exist, and `settle()` as twelve macrotask turns. Then:
  - `routeOf("/lobby/listeners")` and `routeOf("/lobby/listeners/")` → `{ kind: "listeners" }`; `routeOf("/lobby")` is still `{ kind: "lobby" }`; `routeOf("/lobby/listenersx")` → `{ kind: "unknown" }`.
  - Mounting `<App>` at `/lobby/listeners` with a stored Lobby identity renders the directory's heading and calls `GET /api/lobby/listeners?...` exactly once.
  - With **no** stored credential it renders the Join-the-Lobby form; joining renders the directory in place (`onJoined` path) without a navigation.
  - `getLobby()` answering `weave_not_found` renders "This instance has no Lobby yet." with a `HomeLink`.
  - `getLobby()` failing for any other reason renders the server's message, **not** "no listeners".
- [ ] **Step 3: RED** — `cd src/server && npx vitest run test/static.test.ts`; `cd src/web && npx vitest run test/listeners-page.test.tsx`.
- [ ] **Step 4: Implement the server paths.** In `src/server/src/app.ts`, extend the enumerated list to nine and keep the comment about it deliberately not being a catch-all:
```ts
    for (const p of ["/", "/lobby", "/lobby/", "/lobby/listeners", "/lobby/listeners/",
                     "/weave/:id", "/weave/:id/", "/w/:secret", "/w/:secret/"]) {
```
  and name the new path in `main.ts`'s boot line.
- [ ] **Step 5: Implement the router.** In `src/web/src/app.tsx`: add `{ kind: "listeners" }` to `Route`; in `routeOf`, **before** the `/lobby` comparison (both are exact-match, so neither shadows the other — the order is for the reader):
```ts
  if (pathname === "/lobby/listeners" || pathname === "/lobby/listeners/") return { kind: "listeners" };
```
  add `openListenersInPlace: () => void` to `RouteDeps` with a doc comment naming it the third mirror of `openInPlace`, implement it as `setRoute({ kind: "listeners", inPlace: true })`, and render `case "listeners": return <ListenersRoute {...deps} inPlace={route.inPlace} />`. `Route`'s listeners member carries `inPlace?: boolean`, set only by the in-place switch.
- [ ] **Step 6: Implement `ListenersRoute`.** It owns the pointer, the credential and the failure branches — not the controls:
  - resolve `client.getLobby()` once in an effect, exactly as `LobbyRoute` does; `weave_not_found` is the instance's own answer ("This instance has no Lobby yet.", plus `<HomeLink openMainInPlace={leavingIsSafe(storage, notice) ? undefined : openMainInPlace} />`), every other failure is a failed read and shows its message;
  - `readerFor(client, readWeaveEntry(storage, lobbyId))` picks the credential — the token when usable, the stored secret otherwise; `undefined` renders `JoinLobbyForm` with both `onJoined` and `onJoinedInPlace` re-running the first query in place (this route **is** the destination, so there is nowhere to navigate);
  - it passes `reader`, `lobbyId` and `inPlace` down to `ListenersPage` (Task 6) and renders `<PersistenceBar notice={notice}/>` above it, as `WeaveRoute` does for a Weave page.
- [ ] **Step 7: Implement the sidebar's way in** — only the plumbing, so Task 8 can render the line: thread `openListenersInPlace` from `RouteDeps` through `WeaveRoute` into `WeaveView` (which already receives the other in-place callbacks post-#18).
- [ ] **Step 8: GREEN** — `pnpm --filter @loom/core build && pnpm --filter @loom/client build && cd src/server && npx vitest run && cd ../web && npx vitest run test/listeners-page.test.tsx`.
- [ ] **Step 9: Commit** — `feat(web,server): the /lobby/listeners route`

---

### Task 6: The listeners page

Spec §5.3 (the page), §5.4 (the query string and `replaceState`), §5.5 (the 401 rule and the "list changed" hint), §7 (state and error handling).

**Files:** Create `src/web/src/components/listeners/ListenersPage.tsx`, `src/web/src/components/listeners/FacetChips.tsx`, `src/web/src/components/listeners/listeners-query.ts`; Modify `src/web/src/components/listeners/ListenersRoute.tsx`, `src/web/src/styles.css`; Test `src/web/test/listeners-query.test.ts` (new), `src/web/test/listeners-page.test.tsx` (extend).

**Interfaces:**
- *Consumes:* `ListenersRoute`'s `{ reader: LoomClient; lobbyId: string; inPlace?: boolean }` (Task 5); `LoomClient.listListeners` (Task 4); `ProfileCard` and `modelSpecs` from `src/web/src/components/ProfileCard.tsx`; `HomeLink`, `leavingIsSafe`, `weaveKey`, `isCredentialFailure`, `invalidateIdentity`.
- *Produces:*
```ts
// listeners-query.ts
export type ListenersView = {
  q: string; models: { model: string; effort?: string }[]; tools: string[];
  runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";
};
export const EMPTY_VIEW: ListenersView;
/** Parses `location.search`. Never throws: anything unreadable is dropped and reported. */
export function viewFromSearch(search: string): { view: ListenersView; partial: boolean };
export function searchFromView(view: ListenersView): string;      // "" when the view is empty
export function queryFromView(view: ListenersView, extra: { limit?: number; cursor?: string }): ListenersQuery;
```

- [ ] **Step 1: Failing tests** in `src/web/test/listeners-query.test.ts` (pure, node environment):
  - `viewFromSearch("")` → `EMPTY_VIEW`, `partial: false`.
  - A full round trip: a view with two models (one with an effort), two tools, a runtime, `serves`, `sort: "owner"`, `dir: "desc"` → `searchFromView` → `viewFromSearch` gives back the same view.
  - `searchFromView(EMPTY_VIEW)` is `""` — an untouched page leaves no query string.
  - `?filter=not-json` → `EMPTY_VIEW` with `partial: true` and **no throw**.
  - `?filter={"tools":"shell"}` (wrong shape) → the bad key dropped, `partial: true`; a `filter` that is a JSON **array** or `null` → dropped, `partial: true`.
  - `?sort=age` → the default sort, `partial: true`; `?dir=up` → the default `asc`, `partial: true`; `?q=` 101 characters → `q` dropped, `partial: true`.
  - **Every value the parser validates, one test each — and each one sets `partial`.** The bounds are core's (`matching.ts:26-33`, spec §2.3), and the rule being tested is that a link the page would otherwise send to core renders the directory rather than core's 400:
    - a model alternative with a **non-string `effort`**: `?filter={"models":[{"model":"opus-5","effort":123}]}` → that alternative **dropped**, `partial: true` (the `{model:"opus-5",effort:123}` the finding names);
    - an **empty** model name, and one of **101** characters → dropped, `partial: true`;
    - an `effort` of **33** characters → the alternative dropped whole, never half-kept as `{ model }`;
    - an entry that is **not an object** (`?filter={"models":[{"model":"a"},"nope",null]}`) → the two bad entries dropped, the good one kept, `partial: true`;
    - **21** models → 20 kept and `partial: true` (core's `.max(20)`); **51** tools → 50 kept and `partial: true`;
    - a tool that is **empty**, **65 characters**, or not a string → that entry dropped, the others kept, `partial: true`;
    - `runtime` **empty**, **65 characters**, or not a string → dropped, `partial: true`;
    - `serves: "nobody"` and `serves: 5` → dropped, `partial: true`.
  - **A discarded array entry is never silent.** The rule as its own test: `?filter={"tools":["shell",""]}` keeps `["shell"]` **and** reports `partial: true`, so the "part of this link was not understood" line (spec §5.4) appears. Entries used to be `filter`ed out and vanish.
  - **No false positives**: the full valid round trip above asserts `partial: false`, and so does a view using every control at its bounds (a 100-character model, a 32-character effort, 20 models, 50 tools, a 64-character runtime, a 100-character `q`).
  - `queryFromView` passes `limit: 50` by default and the cursor when given, and omits every absent filter, including an empty `q` (`q: ""` is a cleared box, not a search).
- [ ] **Step 2: Failing tests** in `src/web/test/listeners-page.test.tsx`, using the harness from Task 5. Where an intermediate state is asserted, the route's response is a **gated** promise the test releases by hand:
  - Renders one `ProfileCard` per listener from a single stubbed answer, and the counts line reads `Showing 2 of 2 matches`; with `matched < total` it reads `Showing 50 of 87 matches (1,204 listeners)`.
  - **Debounce:** three `input` events inside 250 ms produce **one** request, carrying the last value (fake timers; advance 250 ms once).
  - **Query string → controls:** mounting at `?q=fable&filter={…}&sort=owner&dir=desc` seeds the search box, the chips and both selects, and the first request carries all of them.
  - **Controls → query string:** clicking a chip calls `history.replaceState` (spied) with the new query and **never** `pushState`, and the next request carries the filter.
  - **In place:** rendered through `openListenersInPlace`, a chip click changes the results and `replaceState` is **not** called.
  - **A malformed `filter` in the URL** renders the directory with a one-line note and no filter — not an error page, and nothing thrown.
  - **Show more** sends the `nextCursor`, **appends**, and leaves the first page's cards in place and in order; a failed "Show more" keeps the rows and shows the error beside the button.
  - **A control change starts one query and supersedes the one in flight**: with the first response gated, a second control change is made, then both are released oldest-last — the grid shows the **newer** result, and the older response never paints (the page's own generation counter).
  - **A superseded query's *rejection* is equally silent**: same setup, but the older query is released as a **401**. The newer rows stay, no error line appears, `invalidateIdentity` is **not** called (the stored entry is byte-identical) and the page does not fall back to the join form. The guard runs before every side effect, on the failure path as well as the success path.
  - **Empty:** filters matching nothing render "No listener matches these filters" plus **Clear filters**, which clears them and re-queries; `total === 0` renders "Nobody has declared a profile yet."
  - **An error never renders as empty:** a rejected query renders the server's message and **no** "No listener matches" line, and keeps the rows that were on screen.
  - **Loading keeps the rows:** during a control-change refresh the previous cards are still in the document.
  - **A zero-count selected chip** renders selected, shows `0`, and clicking it clears that filter.
  - **The "list changed — reload" hint** appears when a later answer's `total` differs from the first answer's, and not before.
  - **401 on a listeners query**: the identity is invalidated (the entry keeps its `secret`, loses `token`/`participantId`/`name`, gains `identity: "invalid"`), the page retries with the stored secret and renders; with **no** secret it renders the join form and the invalid-identity line.
  - **Back to the Lobby** is an `<a href="/lobby">` when `leavingIsSafe(storage, notice, weaveKey(lobbyId))`, and a **button** that calls `openInPlace(lobbyId)` when it is not.
- [ ] **Step 3: RED** — `cd src/web && npx vitest run test/listeners-query.test.ts test/listeners-page.test.tsx`.
- [ ] **Step 4: Implement `listeners-query.ts`.** Every value out of the URL is shape-checked before a property is read, nothing throws, and — the rule the whole file turns on — **every value that is supplied and not usable is `drop()`ped, which is what sets `partial`**. A value that merely does not appear is neither dropped nor reported.

  The parser validates **completely**, against core's own bounds, rather than letting "close enough" through: a page that forwards `{ model: "opus-5", effort: 123 }` gets core's 400 back and renders an error page for a hand-edited link, which is precisely what spec §5.4 says must not happen ("ignored with a one-line notice … a hand-edited or truncated link should still show the directory"). The bounds are quoted from `validateRequirements` (`matching.ts:26-33`): **model 1–100, effort 1–32, at most 20 alternatives; tools 1–64 each, at most 50; runtime 1–64**; `q` ≤ 100 and the three closed enums from spec §2.3.
```ts
export function viewFromSearch(search: string): { view: ListenersView; partial: boolean } {
  const p = new URLSearchParams(search);
  let partial = false;
  const drop = () => { partial = true; return undefined; };
  // Supplied-and-unusable is dropped **and** reported; absent is neither. Every helper below goes
  // through this, so no branch can forget half of the rule.
  const given = <T>(raw: unknown, parse: (v: unknown) => T | undefined): T | undefined =>
    raw === undefined ? undefined : parse(raw);
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return drop();
    const t = v.trim();                       // core trims, so the page compares what core will store
    return t.length >= 1 && t.length <= max ? t : drop();
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : drop();

  const raw = p.get("filter");
  let filter: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // A JSON array, `null` and a scalar all parse; none of them is a filter.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) filter = parsed as Record<string, unknown>;
      else drop();
    } catch { drop(); }
  }
  const models = given(filter.models, (v) => {
    if (!Array.isArray(v)) return drop();
    const out: { model: string; effort?: string }[] = [];
    for (const m of v) {
      // An entry that is thrown away is thrown away **out loud**: a silent `.filter()` here was the
      // finding — the link said four models, the page showed three and said nothing.
      if (!m || typeof m !== "object" || Array.isArray(m)) { drop(); continue; }
      const { model, effort } = m as { model?: unknown; effort?: unknown };
      const name = str(model, 100);
      if (name === undefined) continue;                       // `str` has already dropped it
      if (effort === undefined) { out.push({ model: name }); continue; }
      const e = str(effort, 32);
      // An alternative whose effort is unusable is dropped whole rather than widened to "any
      // effort": keeping half of it would silently answer a different question.
      if (e !== undefined) out.push({ model: name, effort: e });
    }
    if (out.length > 20) { drop(); return out.slice(0, 20); } // core's `.max(20)`
    return out;
  }) ?? [];
  const tools = given(filter.tools, (v) => {
    if (!Array.isArray(v)) return drop();
    const out: string[] = [];
    for (const t of v) { const s = str(t, 64); if (s !== undefined) out.push(s); }
    if (out.length > 50) { drop(); return out.slice(0, 50); }
    return out;
  }) ?? [];
  const runtime = given(filter.runtime, (v) => str(v, 64));
  const serves = given(filter.serves, (v) => oneOf(v, ["anyone", "owner", "list"] as const));
  // The scalars are `string | null` out of `URLSearchParams`; `null` is "not there".
  const sort = given(p.get("sort") ?? undefined, (v) => oneOf(v, ["name", "owner", "joined"] as const)) ?? "name";
  const dir = given(p.get("dir") ?? undefined, (v) => oneOf(v, ["asc", "desc"] as const)) ?? "asc";
  // `?q=` (empty) is a cleared box, not a rejected value: absent, and not reported.
  const qRaw = p.get("q");
  const q = qRaw === null || qRaw.trim() === "" ? "" : (str(qRaw, 100) ?? "");
  return { view: { q, models, tools, runtime, serves, sort, dir }, partial };
}
```
  `searchFromView` is its inverse and writes `filter` only when at least one of the four is set, so an untouched page has an empty query string.
- [ ] **Step 5: Implement `ListenersPage`.** The rules that are easy to get wrong, each as written:
  - **One query in flight, superseded by generation, never stacked.** The page holds `const gen = useRef(0)`; every query takes `const n = ++gen.current` and applies its answer only if `n === gen.current`. A control change bumps it, which is what makes the older answer harmless. "Show more" is the one query that **appends** rather than replaces, and it too checks `n` before it appends.
  - **The rejection path carries the same guard, before any side effect.** `n === gen.current` is checked in the `catch`/reject handler too — ahead of `setState`, ahead of the 401 rule, ahead of `invalidateIdentity`. A superseded query's failure must not paint an error over a newer query's rows, and must certainly not delete a credential on the strength of a request nobody is waiting for any more. This is the page's copy of the session's rule (Task 7, spec §3.3): *the guard comes before any side effect, and it applies to rejections as much as to answers.* Its test: with two queries in flight, the **older** one rejecting last leaves the newer rows on screen, shows no error, and writes nothing to storage.
  - **The cursor is dropped on every control change** and kept only by "Show more".
  - **State is `{ status: "loading" | "ready" | "error"; rows; total; matched; facets; nextCursor; error }`** — an error is a state of its own, never an empty `rows`. "No listener matches" is rendered **only** when `status === "ready" && rows.length === 0`.
  - **Debounce** the search box by 250 ms with a `useRef<number>` timer cleared on unmount; the input is never disabled while a request is in flight.
  - **`replaceState` only**, and only when `!inPlace && location.pathname === "/lobby/listeners"`:
```ts
  // Rewriting this page's own query string names the same page, which is what the no-pushState rule
  // is about (spec §5.4). Rendered in place, the URL is left entirely alone: the address would name
  // a page this browser could not load again.
  if (!inPlace && location.pathname.startsWith("/lobby/listeners")) {
    const s = searchFromView(view);
    history.replaceState(null, "", s ? `${location.pathname}?${s}` : location.pathname);
  }
```
  - **The 401 rule**: on `isCredentialFailure(e)`, write first and report after — `const wrote = invalidateIdentity(storage, lobbyId); notice.note(wrote);` — then retry once with the stored secret if there is one, else fall back to the join form.
  - **The "list changed" hint** compares each answer's `total` against the first answer's; no timer, no socket.
- [ ] **Step 6: Implement `FacetChips`.** One facet, given `{ values, more }`, the selected set and an `onToggle`. A chip shows its value and count; a **selected** chip is marked and may show `0`; the model chips render their `efforts` row beneath the selected model, with `moreEfforts` as "10 most common". The rows say their semantics in words — "any of these" for models, "all of these" for tools — and `serves` is a three-way choice with counts.
- [ ] **Step 7: GREEN** — `cd src/web && npx vitest run test/listeners-query.test.ts test/listeners-page.test.tsx`.
- [ ] **Step 8: Commit** — `feat(web): the Lobby listeners directory page`

---

### Task 7: Session — my own profile and the listener count

Spec §3.3 ("How the session uses it", the apply rule, the rejection guard), §5.1 (the count's triggers), §7.

**Files:** Create `src/web/src/side-reads.ts`; Modify `src/web/src/session.ts`; Test `src/web/test/side-reads.test.ts` (new), `src/web/test/session.test.ts` (modify), `src/web/test/components.test.tsx` (modify).

**Interfaces:**
- *Consumes:* `LoomClient.getMyLobbyParticipant()` and `LoomClient.listListeners` (Task 4); `invalidateIdentity`, `isCredentialFailure`, `readWeaveEntry` from `weaves-store.ts`; the existing `recoverFromCredentialFailure`, `refreshInfo`, `retryLobbyData`, `doLoad`, `onLobby()`, `generation` and `set` in `session.ts`.
- *Produces:*
```ts
// side-reads.ts
export type Stamp = { id: string; token: string; generation: number; n: number };
export type Now = { generation: number; meId?: string; meToken?: string; applied: number };
/** The one ownership-and-ordering rule (spec §3.3): may this answer — or this rejection — be acted on? */
export function isCurrent(stamp: Stamp, now: Now): boolean;
export function createCounter(): { next(): number; applied(): number; markApplied(n: number): void };
export type OwnProfile = { participantId: string; token: string; profile: Profile | null };
```
  and in `session.ts`: `SessionState.listenerCount?: number`; `SessionState.listenerCountError?: boolean` — **true when the newest count read that was acted on failed**, cleared by the next success, so a consumer can tell "not answered yet" from "asked and failed" (spec §5.1 words the two states differently and `listenerCount === undefined` cannot say which); `recoverFromCredentialFailure(e: unknown, failed: "page" | "identity" = "page"): { reload: boolean } | undefined` — the default is what keeps both existing callers (lines 335 and 397) unchanged, and **every** caller acts on the returned `{ reload }`.

- [ ] **Step 1: Failing tests** in `src/web/test/side-reads.test.ts` (pure units):
  - `createCounter()`: `next()` returns 1, 2, 3; `applied()` starts at 0; `markApplied(2)` then `applied()` is 2.
  - `isCurrent` is **true** for a stamp whose generation, id and token match and whose `n > applied`.
  - **false** on a generation mismatch; **false** on a different participant id; **false** on a different token with the same id; **false** when `n <= applied` (a stale answer *or* rejection); **false** when `meId`/`meToken` are absent (no identity at all).
- [ ] **Step 2: Failing tests** in `src/web/test/session.test.ts`, against a real server (`startTestServer()`), one rule per test. Weaves created for these use `opener: "hi"` and therefore start at `lastSeq` 3; where a test creates one with `opener: ""` it starts at 2.
  - **The count appears on the initial load** of the Lobby — no refresh, no event — for an id target **and** for the Lobby opened by secret. The regression test for a count wired only into `refreshInfo`.
  - **A late discovery still produces a count**: `getLobby()` fails once and succeeds on the retry; the count arrives with the requests board.
  - **A refresh updates it**, and a `participant.capabilities_changed` from a second client moves it.
  - **A failing count is not fatal**: the load reaches `ready` with threads, participants and events, `listenerCount` is `undefined`, and a later successful refresh fills it in.
  - **A failing count says it failed**: on a 500 from the count read, `listenerCount` is `undefined` **and** `listenerCountError` is `true` — the state Task 8 renders as "count unavailable" rather than as "still loading".
  - **A success clears the error flag**: after that failure, the next refresh's count answers and `listenerCountError` is `false` with `listenerCount` set.
  - **A failure after a success keeps the number**: count answers 7, a later count read fails transiently — `listenerCount` is still 7 and `listenerCountError` is `true`. The number is never replaced by `undefined` and never by 0.
  - **A count rejection is sequenced exactly as an answer is** — the ordering rule on the failure path: read A starts and is gated, read B starts and succeeds with `total: 4`, then A is released as a **401**. `listenerCount` is still 4, `listenerCountError` is `false` (B's success cleared it and A's rejection did not set it), **no identity was invalidated** (the stored entry is byte-identical), and **no reload happened** (the `getWeave` call count did not rise). Without the `n <= countReads.applied()` guard on that path, a stale rejection tears down a page whose newest read has just succeeded.
  - **A count rejection after a *newer* rejection is also dropped**: A gated, B fails and sets the flag, then A fails — nothing is written twice and nothing is invalidated.
  - **The count is not read away from the Lobby**: an ordinary Weave's load and refresh make no listeners call (counted on an instrumented client).
  - **My own profile survives a refresh**: after the load `state.me.participant.capabilities` is this browser's profile and it is **still** there after a refresh — the guard for `withMyProfile`, since `refreshInfo` rebuilds `me` from `getWeave`'s list, which now carries no profile.
  - **…on all three routes**: the same assertion for `/lobby` (id target), `/weave/<lobbyId>` and `/w/<lobby secret>` with a stored identity. The secret row is the one that was broken before the spec's second revision.
  - **A participant with no profile** gets `me.participant.capabilities === null` and nothing throws.
  - **A failing own-profile read is not fatal**: on a 500 the page loads, `me` exists, `capabilities` is absent, nothing is invalidated.
  - **It is re-read when the event names me**, and not when it names someone else.
  - **An older profile answer does not resurrect a cleared profile**: A starts, B starts and lands with `capabilities: null`, then A lands with the old profile — `me.capabilities` stays `null`.
  - **An older, larger count does not overwrite a newer, smaller one.**
  - **An answer read for a previous identity is discarded**: the read starts, the session joins under a new name, then the old answer lands — `me.capabilities` is not set from it.
  - **A rejoin starts with no profile** until a fresh read answers for the new identity.
  - **A revoked token on a secret-link visit invalidates the identity**: `/w/<lobby secret>` loads, the own-profile read answers 401 — the entry has no `token`/`participantId`/`name`, keeps its `secret` and cached title, is marked `identity: "invalid"`; `state.me` is `undefined`; `readOnlyReason` is `"secret-fallback"`; the page is **still `ready` and still reading** (threads and events intact); and **no reload happened** (the `getWeave` call count did not rise).
  - **A rejected own-profile read on an id target reloads the page with the secret** — the finding this test exists for. `/lobby` (or `/weave/<lobbyId>`) is loaded **by token**, so `readingWithToken` is true and `failed: "identity"` falls through to the page path (spec §3.3: *"it **is** the page credential, so this falls through to the existing behaviour"*), which returns `{ reload: true }` and leaves the reader switch to its caller. Assert all four: the stored entry lost `token`/`participantId`/`name` and kept its `secret` with `identity: "invalid"`; `doLoad` ran again (the `getWeave` call count **rose**, and the new read carried the **secret**); `state.me` is `undefined`; and `readOnlyReason` is `"secret-fallback"` as the reload's own fallback sets it. Before the fix the returned `{ reload: true }` was discarded, so the page kept reading with the rejected token and kept showing a stale `me`.
  - **…and with no secret** it settles at `no-credential`, identity invalidated, `me` cleared.
  - **The secret-target case still does not reload** — the pair to the test above, asserted together with it so the asymmetry is visible: on `/w/<lobby secret>` the sibling branch returns `{ reload: false }` and the `getWeave` call count does **not** rise.
  - **A delayed 401 for a previous identity leaves the new one untouched**: the read starts, the session rejoins, then the 401 lands — the stored entry is **byte-identical** to what the join wrote, `me` is the new identity, `readOnlyReason` is undefined, and no `WriteResult` reached `onWrite` (spy).
  - **A delayed 401 after a generation change does nothing** (a fresh `load()` in place of the rejoin).
  - **A delayed transient failure for a previous identity is equally silent**: no `refreshError`, no retry, cache untouched.
  - **A stale 401 for the same identity, after a newer read succeeded, does not invalidate**: A starts, B starts and succeeds, then A is rejected — the token is still in storage and `me` is intact.
  - **The ordinary case still invalidates**: the current identity's read is rejected and the identity is invalidated.
  - **A 401 from the count** takes the page-credential path (invalidate, fall back), exactly as a failed requests read does.
- [ ] **Step 3: Failing tests** in `src/web/test/components.test.tsx` (DOM, beside the existing `RequestsPanel` cases): an eligible joined listener **sees the Offer form** on the Lobby opened by its secret link, and on `/lobby`; a participant with **no** profile sees no Offer form on either; and after a 401 on the own-profile read the Offer form is **gone**, the read-only banner with **Join** is shown, and the Weave is still rendered.
- [ ] **Step 4: RED** — `cd src/web && npx vitest run test/side-reads.test.ts test/session.test.ts`.
- [ ] **Step 5: Implement `side-reads.ts`.** Twenty lines, no Preact, no client — the policy lives here so `session.ts` gains wiring only:
```ts
export function isCurrent(stamp: Stamp, now: Now): boolean {
  // Four questions, and each one has bitten this design: is this session still the one that asked
  // (generation); is this still the identity it was asked for (id, token); and is this the newest
  // answer (n)? A generation guard alone orders nothing within a generation.
  return stamp.generation === now.generation
    && stamp.id === now.meId && stamp.token === now.meToken
    && stamp.n > now.applied;
}
```
- [ ] **Step 6: Implement the session's own profile.** The cache, the helper and the one apply path:
```ts
  let ownProfile: OwnProfile | undefined;
  const profileReads = createCounter();
  /** The single place `me` is built, so a refresh cannot quietly blank the profile again. */
  const withMyProfile = (p: Participant): Participant =>
    p.id === ownProfile?.participantId ? { ...p, capabilities: ownProfile.profile } : { ...p, capabilities: null };

  const readMyProfile = () => {
    const me = state.me;
    if (!me || !onLobby()) return;
    const stamp: Stamp = { id: me.participant.id, token: me.token, generation, n: profileReads.next() };
    void client.withToken(me.token).getMyLobbyParticipant().then(
      (p) => {
        if (disposed || !isCurrent(stamp, nowFor(stamp))) return;   // generation, identity, order
        profileReads.markApplied(stamp.n);
        ownProfile = { participantId: stamp.id, token: stamp.token, profile: p.capabilities };
        if (state.me) set({ me: { token: state.me.token, participant: withMyProfile(state.me.participant) } });
      },
      (e: unknown) => {
        // The guard comes before ANY side effect: no write, no onWrite, no cache clear, no set().
        // A rejection that fails it describes an identity this session no longer has.
        if (disposed || !isCurrent(stamp, nowFor(stamp))) return;
        profileReads.markApplied(stamp.n);
        if (!isCredentialFailure(e)) return;                        // transient: keep what we have
        // The return value is the caller's job, exactly as at lines 335 and 397. On a **secret**
        // target the sibling branch answers `{ reload: false }` and there is nothing to do — the
        // page is reading perfectly well. On an **id** target this token *is* the page credential
        // (spec §3.3), so the helper invalidates it and answers `{ reload: true }`, meaning "I have
        // retired the credential; switch readers by loading again". Dropping that answer leaves the
        // page reading with the token the server has just refused, and `me` stale behind it.
        const recovered = recoverFromCredentialFailure(e, "identity");
        if (recovered?.reload) void doLoad();
      },
    );
  };
  const nowFor = (s: Stamp): Now => ({ generation, meId: state.me?.participant.id,
    meToken: state.me?.token, applied: profileReads.applied() });
```
  `withMyProfile` is used at **all three** `me` sites: the ready patch in `doLoad` (line 571), the `me` re-derivation in `refreshInfo` (lines 280–281) and the post-join patch (line 652). `join()` additionally clears `ownProfile` — a rejoin is a different participant, and `join()` does not bump the generation.
- [ ] **Step 7: Implement the rejection rule.** Give the existing helper a parameter and the sibling branch, leaving both current callers (lines 335 and 397) byte-identical:
```ts
  const recoverFromCredentialFailure = (e: unknown, failed: "page" | "identity" = "page"): { reload: boolean } | undefined => {
    if (!isCredentialFailure(e) || !weaveId || retriedWithSecret) return undefined;
    // The page reader's own failure keeps today's guard. An identity failure while the page reads
    // with something else (a secret target) is a different event: the page is reading perfectly
    // well, so it is never reloaded and nothing is retired (spec §3.3).
    if (failed === "page" && !readingWithToken) return undefined;
    if (failed === "identity" && !readingWithToken) {
      const wrote = invalidateIdentity(storage, weaveId);   // written first, reported after
      onWrite(wrote);
      ownProfile = undefined;
      set({ me: undefined, readOnlyReason: "secret-fallback" });
      return { reload: false };
    }
    … // unchanged from here: invalidate, retriedWithSecret = true, reload with the secret or no-credential
  };
```
- [ ] **Step 8: Implement the count.** `SessionState.listenerCount?: number` and `listenerCountError?: boolean`, its own counter, and three call sites:
```ts
  const countReads = createCounter();
  const readListenerCount = (myGeneration: number) => {
    if (!weaveId || !onLobby()) return;
    const n = countReads.next();
    void reader.listListeners({ limit: 0, facets: false }).then(
      (page) => {
        // Re-checked inside the function, immediately before publishing — not only in the caller.
        if (disposed || myGeneration !== generation || n <= countReads.applied()) return;
        countReads.markApplied(n);
        // A success clears the failure flag: the number on screen is answered, not stale.
        set({ listenerCount: page.total, listenerCountError: false });
      },
      (e: unknown) => {
        // **The same two guards as the success path, and both before any side effect.** One
        // watermark for answers and rejections alike (the Global Constraint on request sequencing,
        // and spec §3.3's argument for it): an older read's rejection must not undo a newer read's
        // answer, and it must certainly not spend the page's credential recovery — the most
        // destructive act on this page — on a request nothing is waiting for.
        if (disposed || myGeneration !== generation || n <= countReads.applied()) return;
        countReads.markApplied(n);
        // Read with the page reader, so a rejected credential is a page-credential failure.
        const recovered = recoverFromCredentialFailure(e);
        if (recovered) { if (recovered.reload) void doLoad(); return; }
        // Anything else: keep the last known number, record that the newest attempt failed, and let
        // the next trigger retry. The flag is what lets the sidebar say "count unavailable" instead
        // of going on looking like it is still loading — and it is never a 0 (spec §5.1).
        set({ listenerCountError: true });
      },
    );
  };
```
  called after the ready patch in `doLoad` (when `discovery.settled && discovery.lobby?.weaveId === weaveId`), in `retryLobbyData` once `lobbyKnown` is true and `onLobby()` holds, and at the end of `refreshInfo` when `onLobby()`. `readMyProfile()` is called from the same three places, after `me` is known.
- [ ] **Step 9: GREEN** — `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build && cd src/web && npx vitest run test/side-reads.test.ts test/session.test.ts test/components.test.tsx`.
- [ ] **Step 10: Commit** — `feat(web): the session reads its own Lobby profile and the listener count`

---

### Task 8: The Lobby sidebar line and the main page's Lobby summary

Spec §5.1.

**Files:** Create `src/web/src/components/ListenersLink.tsx`; Modify `src/web/src/components/ProfileCard.tsx` (remove `ProfileCards`), `src/web/src/components/WeaveView.tsx` (lines 99–105), `src/web/src/components/main/LobbySummary.tsx` (lines 43–62), `src/web/src/styles.css`; Test `src/web/test/listeners-page.test.tsx` (extend), `src/web/test/main-page.test.tsx` (modify).

**Interfaces:**
- *Consumes:* `SessionState.listenerCount` **and `SessionState.listenerCountError`** (Task 7); `openListenersInPlace` on `RouteDeps` (Task 5); `leavingIsSafe(storage, notice, key?)`, `weaveKey`; `LoomClient.listListeners` (Task 4).
- *Produces:* `ListenersLink({ state, storage, notice, weaveId, openListenersInPlace })` — renders nothing away from the Lobby.

- [ ] **Step 1: Failing tests** in `src/web/test/listeners-page.test.tsx`:
  - The **Lobby sidebar** shows `Listeners (3)` from `state.listenerCount` and renders **no** `.profile-card` — the removal, asserted directly.
  - **The four count states, one test each** — the two middle ones are indistinguishable without `listenerCountError`, which is why Task 7 adds it:
    - **pending** (`listenerCount` undefined, `listenerCountError` unset): the line reads `Listeners`, with **no** number and **no** "count unavailable" — spec §5.1: *"Before the first answer the line reads **Listeners** with no number"*;
    - **failed with no count** (`listenerCountError: true`, no number): `Listeners` plus the quiet "count unavailable", word for word as spec §5.1 gives it, and **never** `Listeners (0)` — asserted as the absence of `(0)` in the line's text;
    - **failed with a previous count** (`listenerCount: 7`, `listenerCountError: true`): still `Listeners (7)` — the known number is kept, and "count unavailable" is **not** shown beside a number that is on screen;
    - **recovered** (a later success): `Listeners (9)` and no "count unavailable".
  - The line is an `<a href="/lobby/listeners">` when `leavingIsSafe(storage, notice, weaveKey(lobbyId))`, and a **button with no `href`** when it is not; clicking the button renders the directory in place with `location.pathname` unchanged and `pushState`/`replaceState` never called.
  - It renders nothing on a Weave that is not the Lobby.
  And in `src/web/test/main-page.test.tsx`: the Lobby summary's "N listeners" comes from `GET /api/lobby/listeners?limit=0&facets=false` (asserted on the stub's calls), and the other two counts are unchanged. Then the independence rule, three tests:
  - **a failure of that one call leaves the participant and open-request counts rendered**, with no listener line, no zero and **no error line** — the regression test against folding it into the rejecting `Promise.all`;
  - the same when that call answers **401** (the component has no credential rule of its own, so it behaves as for any other failure);
  - **a failure of `getWeave`** still shows the section's one error line and no counts, unchanged from today — the half that must *not* become independent.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/listeners-page.test.tsx test/main-page.test.tsx`.
- [ ] **Step 3: Implement `ListenersLink`.** The Lobby gate is the existing one (`state.lobby?.weaveId === state.weave?.id`); the link/button choice is `leavingIsSafe(storage, notice, weaveKey(weaveId))`, asked **on every render** so a later durable write puts the ordinary link back. The label is the three-way read of the two count cells, and nothing in it can produce a zero that nobody counted:
```tsx
  // `listenerCount` alone cannot say whether the number is missing because nothing has answered yet
  // or because the read failed, and spec §5.1 words those two states differently. A known number
  // always wins: a failed refresh behind a number that is on screen is a stale number, not a
  // missing one, and saying "count unavailable" beside it would be a worse answer than saying
  // nothing. And there is no `(0)` branch here at all — an absent count is an absent number.
  const label = state.listenerCount !== undefined
    ? `Listeners (${state.listenerCount.toLocaleString()})`
    : "Listeners";
  …
  {state.listenerCount === undefined && state.listenerCountError && <span class="muted">count unavailable</span>}
``` A button rather than an anchor-with-handler, for the reason PR #18 gives: an anchor can be middle-clicked or opened in a new tab, and either is the full page load that loses an in-memory credential.
- [ ] **Step 4: Remove `ProfileCards`** from `ProfileCard.tsx` and from `WeaveView`'s sidebar, and put `<ListenersLink …/>` in its place. `ProfileCard` and `modelSpecs` stay exactly as they are — the directory renders them, and `RequestsPanel` imports `modelSpecs`.
- [ ] **Step 5: Re-point `LobbySummary`.** A third call beside the existing two — but **caught on its own**, not folded into the rejecting `Promise.all`:
```ts
    Promise.all([
      reader.getWeave(weaveId),
      reader.listRequests("open", { limit: PAGE }),
      // A "listener" is a participant carrying a capability profile. `getWeave` no longer carries
      // profiles for the Lobby (spec §3.1), so the count comes from the directory query itself.
      // **Its own failure costs only its own line.** Inside the `Promise.all` it would reject the
      // whole tuple, and the two counts this section has always shown would disappear behind one
      // error line — the opposite of the rule next door (`LobbySummary.tsx:78`: a cell with a
      // credential and no answer yet is loading, not empty) and of this task's own test.
      reader.listListeners({ limit: 0, facets: false }).then((p) => p.total, () => undefined),
    ])
```
  `Counts.listeners` becomes `listeners?: number`, and its `<li>` renders only when it is a number — no zero, no empty line. **A credential failure is not swallowed differently from the other two reads**: this component has no 401 handling at all (no `isCredentialFailure`, no `invalidateIdentity` — that is the session's job, and `MyWeaves`'s), and all three calls use the *same* stored token, so a dead token is reported by `getWeave` rejecting, exactly as it is today. Catching this one call therefore hides nothing the component would otherwise have said. Its "loading, not empty" rule and its single error line are unchanged.
- [ ] **Step 6: Styles.** The sidebar line, the directory grid, the chips (including the selected-and-empty chip) and the counts line in `styles.css`. No test covers appearance — note it in the KNOWN-ISSUES styling row in Task 9.
- [ ] **Step 7: GREEN** — `cd src/web && npx vitest run`.
- [ ] **Step 8: Commit** — `feat(web): the Lobby sidebar links to the listeners directory instead of stacking cards`

---

### Task 9: Docs and totals

Spec §9.

**Files:** Modify `docs/ARCHITECTURE.md` (§9, §12), `docs/SECURITY.md` (§4a, §9.1), `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `docs/superpowers/specs/v2-notes.md`, `src/web/README.md`, `src/core/README.md`.

- [ ] **ARCHITECTURE §9**: the route table gains `/lobby/listeners`; `openListenersInPlace` as the third in-place mirror; the Lobby page's metadata carrying no profiles, where the count comes from, and that the session reads its own profile separately with `me`'s token.
- [ ] **ARCHITECTURE §12**: a **Listeners** paragraph under Profiles — `listListeners` as the paged, faceted, SQL-side read; `findAgents` unchanged as the in-memory matcher a request's wake-up shares; `getMyLobbyParticipant` as the way to read your own; and the sentence that `getWeave` carries **no** Lobby profiles at all.
- [ ] **SECURITY §4a**: same population, same credentials, a new shape — the directory makes profiles *searchable*, and `owner` is self-declared (ADR 0001), so a directory sorted by it is a roster. **§9.1**: the listeners query is the most expensive authenticated read (up to seven statements, two unnesting jsonb); bounded, still unrated.
- [ ] **TESTING.md**: the `core`, `server`, `client`, `web`, `cli` and `claude-channel` coverage cells; the new test files; and three steps appended to manual smoke test 5 — open `/lobby` and confirm **Listeners (N)** with no cards; follow it, search by owner, apply a model and a tool filter, confirm the counts and chips move together; copy the URL into a new tab and confirm the same view; plus one negative — stop the server and confirm the page says so rather than "no listeners".
- [ ] **KNOWN-ISSUES.md**: add (a) `getWeave` now reads the settings row twice (guidelines + Lobby id) and should read it once; (b) the directory has no live updates by design, only a "list changed" hint; (c) the facet pass unnests jsonb and is the query's expensive half at 10k listeners; (d) **profiles still travel over the event log** — `participant.capabilities_changed` carries the whole profile and a Lobby load backfills the whole history; (e) `q` has no index (a `pg_trgm` GIN index is the fix if it ever hurts); (f) the directory's appearance is untested, as the existing styling row says.
- [ ] **v2-notes.md**: mark the Lobby listeners page **shipped**, in the shape the Lobby and main-page entries use, and keep Paw's "Later" note (facets as dropdown-with-free-text; how new models are introduced is undecided).
- [ ] **READMEs**: `src/core/README.md` — `listListeners` and `getMyLobbyParticipant` beside `findAgents`; `src/web/README.md` — the new route and the `components/listeners/` files.
- [ ] Run `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test` and put the **real** totals (files and tests per package) and the last code commit's hash into `docs/TESTING.md`. Do not estimate them.
- [ ] **Commit** — `docs: the Lobby listeners page across architecture, security, testing and the READMEs`

---

## Self-review against the spec

- **§1** (the problem, the success scenario, the non-goals) → the shape of the whole plan; the narrowed promise is a Global Constraint and a KNOWN-ISSUES row in Task 9. No task pages the participant list, acts on a listener, adds an MCP tool or adds a sort that needs a new column.
- **§2.1** types → Task 1 (`listeners-input.ts`). **§2.2** authorisation → Task 2. **§2.3** bounds **and** the normalisation rules → Task 1 (only an *empty array* normalises; every other supplied value reaches validation, and a supplied non-string `q` is `validation`), with the `listListeners`-level assertions in Task 2 and the route-level ones in Task 4. **§2.4** matching semantics → Task 2's predicates and its property test. **§2.5** ordering, the cursor, the non-null invariant and the lossless `joined` key → Task 1 (the codec, which validates `k` against exactly the format §2.5's `to_char` emits, without a `Date`) and Task 2 (the SQL, the paging tests, the microsecond test, and the well-formed-cursor-with-a-rubbish-`joined`-key test that must be `validation` rather than a 500). §2.5's non-null invariant is why the decoder has no null-key branch and rejects an empty `k`. **§2.6** `total`/`matched` → Task 2. **§2.7** facets, selection-inclusive at zero, the effort cap → Task 2 (query and fold) and Task 6 (the zero-count chip). **§2.8** predicates, the seven queries, the staged model ranking, the index and the plan test → Tasks 1 (index, migration) and 2 (queries, plan test). **§2.9** file layout → the File structure table.
- **§3.1** `getWeave` blanks every Lobby profile → Task 3. **§3.2** every consumer: `ProfileCards` → Task 8; `RequestsPanel` → Task 7 (unchanged component, session-filled `me`); `LobbySummary` → Task 8; CLI merge → Task 3; channel test move → Task 3; MCP description → Task 3; the JSON export note → Task 3's doc comment and Task 9's ARCHITECTURE §12. **§3.3** the core function, the session cache, `withMyProfile`, sequencing, identity ownership and the rejection guard → Task 3 (core) and Task 7 (session), with the ownership rule unit-tested in `side-reads.test.ts`.
- **§4.1** both routes and the `filter` encoding, **§4.2** the auth matrix, **§4.3** the client → Task 4.
- **§5.1** the sidebar line, its **four** states (pending, failed with no number, failed behind a known number, recovered — distinguished by `listenerCountError`, since `listenerCount === undefined` cannot tell the first two apart) and the in-place rule → Task 8, with `LobbySummary`'s third read **caught on its own** so its failure costs one line and not three; the count's triggers and its non-fatal, sequenced (answers **and** rejections), generation-guarded rules → Task 7. **§5.2** the route → Task 5. **§5.3** the page → Task 6. **§5.4** the query string, the single `replaceState` rule, and "anything invalid is ignored with a one-line notice" — which Task 6 implements as **full validation against core's bounds** plus a `drop()` for every discarded value, entries of an array included, so the notice appears whenever the view shown is not the view the link asked for. **§5.5** credential resolution, the join form, `weave_not_found`, the 401 rule and the "list changed" hint → Tasks 5 (resolution, join form, pointer failures) and 6 (401, hint).
- **§6** security: nothing new is written, so it lands in docs → Task 9 (SECURITY §4a, §9.1). The escaping and parameterisation of `q` are Task 2's predicate and its literal-search test.
- **§7** state and error handling: no new error code (Task 4 asserts the existing set); the four independent cells and "an error is never an empty state" → Task 6; the superseded-answer **and superseded-rejection** rule → Task 6 (page generation, both handlers) and Task 7 (session sequencing, both handlers); the identity-owned cache and the guard-before-side-effects → Task 7. "Pending" and "failed" are separate states wherever a consumer words them differently — `status` on the page (Task 6), `listenerCountError` in the session (Task 7).
- **§8 test by test.** Core input units → Task 1. Core `listListeners` — filters, the `serves` default, AND, search and the literal wildcard, the empty-filter trio, six sorts, paging and cursor stability, the stale cursor, the malformed/mismatched cursor, the well-formed cursor with an unparseable `joined` key (`validation`, not a 500), the microsecond `joined` test, the non-null invariant, `limit` bounds, `facets: false`, `total`/`matched`, facets-minus-own-filter (four), counting a listener once, top-20, the bounded effort facet, model ranking by listener count, the four selection-inclusive cases, the three `serves` rows, the auth matrix, the `matches` property test → Task 2. `db.test.ts` index → Task 1; the `EXPLAIN` plan test → Task 2. `getWeave` blanking (three) and `getMyLobbyParticipant` (eight) → Task 3. Server routes and both matrices → Task 4; static paths → Task 5. Client round trips (two) → Task 4. Web store: the count's cases (its triggers, non-fatal, the error flag and its clearing, the previous number kept) and the own profile's → Task 7; the ordering/ownership/rejection cases, now including a **stale rejection** for each of the two reads and the reload a rejected own-profile read owes an id target → Task 7. DOM: the Offer form on three routes plus its loss after a 401 → Task 7 (`components.test.tsx`); the sidebar's link/button rule and its **four** count states → Task 8, with `LobbySummary`'s three independence cases; the page's cases, including the superseded **rejection** → Task 6; the query-string codec's, including one per validated value and one per silent-drop class → Task 6. CLI (two) → Task 3; channel (one) → Task 3. Manual smoke → Task 9.
- **§9** docs, item for item → Task 9. **§10** implementation order followed, with the two deviations named under the File structure table (step 1 split at the database seam; docs split out so the totals are real).
- **§11 / §12**: nothing in "Later" is implemented; §12.3 is built in its re-confirmed shape (no own-row exception in `getWeave`, the dedicated route instead); §12.10's `facets` flag, §12.12's normalisation, §12.13's effort cap, §12.15's sequencing and §12.16's stale-rejection rule are each a Global Constraint and a test.
- **Lessons carried from the last plan's review rounds**, each an explicit step or note above: never `cb?.(write())` (Task 6 Step 5 and Task 7 Step 7 both write into a variable first); every async function re-checks its generation **inside itself** before publishing (Task 7 Steps 6 and 8, Task 6 Step 5); a re-derive must not restart or duplicate work in flight (Task 6's single-query-with-generation rule, and "Show more" appending under the same check); one limit across renders rather than per render (Task 6 holds its generation in a `useRef`, not in a closure rebuilt per render); per-entry versus page-level "leaving is safe" (Task 8's sidebar line uses `weaveKey(lobbyId)`, Task 6's back-link the same, Task 5's pointer-failure cards the page-level form); an error never renders as an empty list (Task 6 Step 5's status union); JSON from a URL is shape-checked before any property access (Task 6 Step 4); the DOM harness facts — `https://loom.test`, the table-driven `fetch` stub, the fatal-403 `ws-ticket`, gated promises for intermediate states, and `tsconfig.test.json` already globbing `src` and `test` (Tasks 5, 6, 7, 8); and exact seq/event-count expectations under the blank-opener rule (Task 7 Step 2).
- **Lessons added by this plan's own review round**, each now a Global Constraint, a named code comment and a RED test: a helper's **return value is acted on** — `recoverFromCredentialFailure` answers `{ reload }` and every caller obeys it (Task 7 Steps 7 and 8, tested by the id-target own-profile 401 that must reload and its secret-target twin that must not); a **failure path carries the same ordering guard as its success path**, before any side effect (Task 7 Step 8's count, Task 6 Step 5's page queries, each with a stale-rejection test); **truthiness is not a shape check** — `?.length` reads `{}`, `5` and `null` as "empty" (Task 1 Step 3, with the `filter={"tools":{}}` regression at both the core and the REST level); **decoded input is validated where it is decoded**, so a cursor key never reaches `::timestamptz` unchecked and a JSON `filter` is confirmed to be an object before it is spread (Tasks 1 and 4); **a discarded value is reported, never dropped in silence**, entries of an array included (Task 6 Step 4); and **`Promise.all` is for "all or none", not for three independent page cells** (Task 8 Step 5).
- **Type consistency** (each symbol grepped, one definition, one signature everywhere): `ListenersQuery`, `ListenersPage`, `Listener`, `ListenersSort`, `ServesKind`, `FacetValue`, `ModelFacet`, `ListenersFacets` are defined in Task 1's `listeners-input.ts` and hand-mirrored once in Task 4's `client/src/types.ts`; `CleanQuery` and `Cursor` never leave core; `validateListenersQuery(input)`, `encodeCursor(c)`, `decodeCursor(raw, sort, dir)` and `likePattern(q)` have those exact signatures in Tasks 1 and 2; `listListeners(db, actor, query?)` in core and `core.listListeners(actor, query?)` on the facade, `LoomClient.listListeners(query?)` in the client, in Tasks 2 and 4; `getMyLobbyParticipant(db, actor)`, `core.getMyLobbyParticipant(actor)` and `LoomClient.getMyLobbyParticipant()` in Tasks 3 and 4; `Stamp`, `Now`, `isCurrent(stamp, now)`, `createCounter()` and `OwnProfile` are defined once in Task 7's `side-reads.ts` and used only by `session.ts`; `recoverFromCredentialFailure(e, failed?)` has that one signature in Task 7, both existing callers keep calling it with one argument, and all four call sites (the refresh loop, `retryLobbyData`, the count, the own-profile read) act on the `{ reload }` it returns; `withMyProfile(p)` is the only builder of `me`; `ListenersView`, `EMPTY_VIEW`, `viewFromSearch`, `searchFromView` and `queryFromView` are defined once in Task 6's `listeners-query.ts`; `openListenersInPlace` is on `RouteDeps` in Task 5 and consumed in Tasks 6 and 8; `ListenersLink` takes the props Task 8 declares and nothing else; `ProfileCards` appears in **no** task except Task 8's removal. Placeholder scan: no "TBD", no "add error handling", no "similar to Task N", no "write tests for the above"; every symbol a task consumes is produced by an earlier task's **Produces** block or by named code from PR #18.
