# Loom v2 — The Lobby listeners page: a searchable, filterable, paged directory

Date: 2026-09-19
Status: spec, ready for review and planning. No implementation yet.
Sub-project: the first slice of "Web client layout for a busy instance" in the v2 breakdown (see
`v2-notes.md`). Builds on the Lobby (`2026-09-16-loom-lobby-design.md`) and the web main page
(`2026-09-17-loom-web-main-page-design.md`); everything not mentioned here is unchanged.
Design brainstormed with and approved by Paw on 2026-09-19 (`.superpowers/listeners-page-brainstorm.md`).

**Builds on PR #18** (the smoke-test-5 fixes) and on `main` after it. That work adds
`openMainInPlace` to `RouteDeps`, the header's way home, the shared
[`HomeLink`](../../../src/web/src/components/HomeLink.tsx) and the single
[`leavingIsSafe(storage, notice, key?)`](../../../src/web/src/persistence.ts) rule that this spec's
in-place decisions are expressed in. `src/web/src/session.ts` is **not** touched by that PR, so
every `session.ts` line cited here is equally true before and after it.

> **Revised after spec review (2026-09-19).** Seven findings, all verified against the code, are
> folded into the text rather than appended:
>
> 1. **"My own profile" is now one read, on one code path.** The own-profile exception in `getWeave`
>    could not work on a `/w/<lobby secret>` page, where the metadata read authenticates as the
>    **secret** and `me` is reconstructed from the stored identity
>    ([`session.ts:173, 542-546`](../../../src/web/src/session.ts)) — the Offer form would have
>    vanished for an eligible, joined listener. `getWeave` now blanks **every** Lobby profile with no
>    exception, and a new `GET /api/lobby/participants/me` answers "my own profile" for all three
>    routes (§3.1, §3.3, §4.1, §5.1). This replaced the shape of assumption §12.3 that Paw had
>    already confirmed; **he confirmed the new one on 2026-09-19** ("I accept 12.3").
> 2. **The listener count is read on four triggers, not one.** `doLoad` does not call `refreshInfo`
>    ([`session.ts:469-584`](../../../src/web/src/session.ts)), so a count added only to the refresh
>    would never appear on a quiet Lobby (§5.1).
> 3. **The filter predicates are whole-document containment**, so the one GIN index can serve them:
>    a GIN index on `capabilities` cannot serve `capabilities->'tools' @> …` (§2.8), and the plan is
>    now something the tests assert with `EXPLAIN`.
> 4. **Empty filters mean "no filter", because that is what `matches` means** (§2.3, §2.4, §8): an
>    empty `tools` array accepts every profile in the matcher and would have excluded profiles with
>    no `tools` key in SQL.
> 5. **The effort facet is bounded** — top 10 per model, `more` per model (§2.7). The per-profile cap
>    of 20 model entries bounds nothing across 10,000 listeners.
> 6. **The promise is narrowed to the profile *snapshot*.** The session backfills the Lobby's whole
>    event history on load and `participant.capabilities_changed` carries the full profile in its
>    payload ([`profile.ts:66-67`](../../../src/core/src/lobby/profile.ts)), so profiles still travel
>    over the event log. This change removes the repeated snapshot, not the transport (§1, §5.1, §11).
> 7. **A listener always has an owner**, so owner paging has no null tail (§2.5). The invariant is
>    stated, cited and tested rather than defended with cursor logic for an unreachable state.
>
> **Second review round (2026-09-19).** Five more, again folded in:
>
> 8. **A generation guard is not an ordering guard.** Both side reads are started from several call
>    sites and can overlap *within* one generation, so an older answer could restore a profile that a
>    newer one cleared. Each now carries a **request number** and is applied only if it is newer than
>    the last applied one, and the profile cache is **owned by an identity** — keyed to the
>    participant id and token it was read for, so a join or an invalidation retires it (§3.3, §5.1,
>    §7).
> 9. **A rejected own-profile read invalidates the identity.** It is made with `me.token`, which on a
>    secret-link visit is *not* the credential the page reads with, so
>    `recoverFromCredentialFailure` returns early for it
>    ([`session.ts:145`](../../../src/web/src/session.ts)) and a dead token would have been left in
>    state and in storage. The helper now names **which** credential failed, and the identity-only
>    case invalidates without reloading a page that is reading perfectly well (§3.3, §7).
> 10. **The `joined` cursor is lossless.** `toPublicParticipant` renders `joined_at` through a JS
>     `Date` ([`actors.ts:11-15`](../../../src/core/src/actors.ts)), which keeps milliseconds, while
>     the column is `timestamptz` — microseconds
>     ([`db/schema.ts:50`](../../../src/core/src/db/schema.ts)). The cursor key is now selected as
>     **text in SQL** and compared as `timestamptz`, never round-tripped through a `Date` (§2.5).
> 11. **Facets include the selection even at zero.** A ranked top-N cannot contain a value whose
>     count under the other filters is zero, because the aggregate has no row for it. Every facet now
>     `LEFT JOIN`s the selected values onto its aggregate with `coalesce(count, 0)` (§2.7, §2.8).
> 12. **Models are ranked one row per model.** Ranking over a grouping-set result ranked *effort*
>     rows too, so a model with many efforts pushed others out of the top 20. The query is now two
>     stages, models then efforts within the kept models (§2.8).
>
> **Third review round (2026-09-19).** One, and it is the mirror of finding 8:
>
> 13. **A rejected own-profile read invalidates only the identity it was made for.** Round 2 gave the
>     *success* path identity ownership and left the *failure* path with none — so a `401` for a
>     token that died, landing after the human had rejoined, would have deleted the **new** identity
>     from storage and shown a read-only banner to someone who had just joined. The rejection handler
>     now captures the participant id, the token, the generation and the request number when the read
>     starts, and checks all four **before any side effect** (§3.3, §7, §8).

## 1. Purpose and scope

### The problem

Three facts about the Lobby today, each verified:

1. **The Lobby page renders every listener's full profile card, in a sidebar column.**
   [`ProfileCards`](../../../src/web/src/components/ProfileCard.tsx) filters
   `state.participants` to those with a profile and renders a `<ProfileCard/>` — models, tools,
   runtime, owner, serves — for every one of them, stacked under Threads, Guidelines and Requests
   ([`WeaveView.tsx:99-105`](../../../src/web/src/components/WeaveView.tsx)). With three listeners
   that reads well. With three hundred the sidebar *is* the page.
2. **A full snapshot of every profile is downloaded on every load and every refresh.**
   [`getWeave`](../../../src/core/src/weaves.ts) selects every participant row of the Weave with no
   limit and maps each through
   [`toPublicParticipant`](../../../src/core/src/actors.ts), which carries
   `capabilities` verbatim. A profile may be up to `MAX_PROFILE_LENGTH` = 4000 characters
   ([`profile.ts:14`](../../../src/core/src/lobby/profile.ts)), so a Lobby with a thousand
   listeners is a multi-megabyte answer — fetched on load, and again on **every**
   `participant.capabilities_changed`, `participant.joined` and `participant.role_changed`, because
   all three schedule a metadata refresh
   ([`session.ts:442-445`](../../../src/web/src/session.ts)). On a busy instance those events are
   the common case, not the rare one.

   **What this spec does *not* remove, and says so up front:** profiles also travel over the **event
   log**. `setCapabilities` appends `participant.capabilities_changed` with the whole validated
   profile in its payload ([`profile.ts:66-67`](../../../src/core/src/lobby/profile.ts)), and a
   session backfills the Weave's complete history before it reads metadata
   ([`session.ts:504-512`](../../../src/web/src/session.ts)). So a Lobby load still downloads every
   historical profile change, and a live change still arrives in full. Removing the repeated
   snapshot is this sub-project; slimming the payload or windowing the backfill is not (§11).
3. **There is no way to look for anybody.** The only search over profiles is `find_agents`
   ([`profile.ts:81`](../../../src/core/src/lobby/profile.ts)) — an MCP tool and a CLI command,
   taking a JSON filter shaped like a request's `requirements`. A human in a browser has a list and
   their eyes.

### What this builds

A **read-only directory** of the Lobby's listeners, served by a new paged core query, reachable at
`/lobby/listeners`, with search, filters, sorting and "Show more" — and, in the same change, the
Lobby sidebar loses its cards and gains one line: **Listeners (N)**.

A **listener** is a Lobby participant whose `capabilities` is not null — the same population
`find_agents` selects (`isNotNull(participants.capabilities)`,
[`profile.ts:90`](../../../src/core/src/lobby/profile.ts)). A human who joined to watch is a
participant and not a listener.

### Success scenario

1. Paw opens `/lobby` on an instance with 1,204 listeners. The metadata answer carries names, kinds
   and roles and **not one profile**; the sidebar says **Listeners (1,204)**, from a count. (The
   history backfill still carries whatever profile changes are in the log — §1, problem 2.)
2. He clicks it. `/lobby/listeners` loads the first 50, name A–Z, with four filter controls already
   populated: the models people actually run, with counts; the tools; the runtimes; and how many
   serve anyone, their owner only, or a named list.
3. He types `fable` in the search box. 250 ms later the page says
   **Showing 12 of 12 matches (1,204 listeners)** and the chips have re-counted.
   *(Reworded 2026-09-20 — §5.3's note: the line now reads **Showing 12 of 12 matches (out of 1,204
   listeners)**.)*
4. He clears the search, picks **opus-5** and then **high** beside it, and **shell** under tools.
   **Showing 50 of 87 matches**; "Show more" brings the next 50 without moving the first.
5. He copies the address and pastes it to a colleague, who sees the same 87.
6. Back on `/lobby` the sidebar count ticks to 1,205 when someone registers a profile — and the
   refresh that follows it re-reads names and roles and a number, not 1,205 profiles.

### Explicitly out of scope

- **Paging the participant list itself.** `getWeave` keeps returning every participant (id, name,
  kind, role) uncapped. `state.participants` is what resolves author names on messages and system
  lines, drives mentions and fills the thread-invite picker
  ([`session.ts:543`](../../../src/web/src/session.ts),
  [`mention-logic.ts`](../../../src/web/src/components/mention-logic.ts)) — paging it means name
  resolution on demand, which is its own sub-project with the layout overhaul.
- **Acting on a listener.** No invite, no "open a request for this one", no message. A directory
  entry is a card, not a control. (The Offer form and the Open-a-request form stay exactly where
  they are.)
- **New MCP tools or CLI commands.** `find_agents` is unchanged and remains the agent-facing search;
  this page is for humans in a browser. The CLI change in §3.2 is a compatibility fix to an existing
  command, not a new surface.
- **A "profile last updated" sort.** There is no such timestamp — `participants` carries
  `joined_at` and nothing else about the profile
  ([`db/schema.ts:39-54`](../../../src/core/src/db/schema.ts)) — and adding one is a migration and a
  write path, for a sort nobody has asked for twice.
- **Web profiles.** Still read-only for a browser (main-page spec §1): no `set_capabilities` form.
- **A Weave switcher, paged Threads, paged requests.** The rest of the layout overhaul.

## 2. The core query: `listListeners(actor, query)`

### 2.1 Shape

A new module, `src/core/src/lobby/listeners.ts`, beside `profile.ts` and `requests.ts`:

```ts
/** One directory entry. Shaped like `FoundAgent` on purpose: the same pair, the same order. */
export type Listener = { participant: PublicParticipant; capabilities: Profile };

export type ListenersSort = "name" | "owner" | "joined";
export type ServesKind = "anyone" | "owner" | "list";

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

export type FacetValue = { value: string; count: number };
/** `efforts` is the model's top 10; `moreEfforts` says there are others (§2.7). */
export type ModelFacet = { model: string; count: number; efforts: FacetValue[]; moreEfforts: boolean };

export type ListenersFacets = {
  models: { values: ModelFacet[]; more: boolean };
  tools: { values: FacetValue[]; more: boolean };
  runtimes: { values: FacetValue[]; more: boolean };
  /** Always the three kinds, always in this order, zeros included. `more` is always false. */
  serves: { values: FacetValue[]; more: boolean };
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

export async function listListeners(db: Db, actor: Actor, query: ListenersQuery = {}): Promise<ListenersPage>;
```

`Listener` duplicates the profile: it is on `participant.capabilities` as well, because
`toPublicParticipant` puts it there. That is deliberate and it is exactly what `FoundAgent` already
does ([`profile.ts:74`](../../../src/core/src/lobby/profile.ts)) — and it is what lets the existing
[`ProfileCard`](../../../src/web/src/components/ProfileCard.tsx), which takes a `Participant` and
reads `participant.capabilities`, render a directory entry with **no change at all**.

The facade method, in [`index.ts`](../../../src/core/src/index.ts), beside `findAgents`:

```ts
listListeners: async (actor: Actor, query: ListenersQuery = {}) =>
  listeners.listListeners(db, await resolveInLobby(actor), query),
```

`resolveInLobby` is the established pattern for every Lobby operation
([`index.ts:31-32, 86`](../../../src/core/src/index.ts)): an agent key is mapped to the participant
it owns in the Lobby, so a registration flow does not need a participant token it never asked for.

### 2.2 Authorisation

Identical to `find_agents`, and for the same reason: this is the same data, in a different shape.

```ts
const { weaveId: lobbyId } = await getLobby(db);
assertCanRead(actor, lobbyId);
```

[`assertCanRead`](../../../src/core/src/actors.ts) admits a participant scoped to the Lobby, a
`{ kind: "secret" }` actor resolved from the Lobby's own Weave secret, and any instance keeper; it
refuses a raw agent actor ("Join the Weave first" — which `resolveInLobby` has already turned into a
participant, or thrown), and refuses a credential scoped to another Weave. Before the first boot
created the Lobby, `getLobby` throws `weave_not_found`.

**No new anonymous read.** SECURITY §4a's line — joining is public, reading needs a credential —
is not moved by one millimetre.

### 2.3 Validation — all of it in core

`CONTRIBUTING.md` §"Layering": rules live in core, adapters carry types only. Every rule below lives
in `listeners.ts`; the REST route parses the query string and hands the values over, exactly as
`/api/lobby/agents` hands `filter` over without narrowing it
([`routes/lobby.ts:32-41`](../../../src/server/src/routes/lobby.ts)).

| Input | Rule | On violation |
| --- | --- | --- |
| `q` | trimmed; at most 100 characters after trimming; **empty or whitespace-only → absent**, not an error | `validation`: `q must be at most 100 characters` |
| `models` | the **same** zod shape `Requirements.models` already uses: `[{ model: 1–100, effort?: 1–32 }]`, trimmed, strict keys, at most 20 entries — but **`[]` is normalised to absent** rather than rejected (see below) | `validation`, message prefixed `requirements.models…` |
| `tools` | `string[]`, each trimmed 1–64, at most 50; **`[]` is normalised to absent** | `validation` |
| `runtime` | trimmed 1–64 | `validation` |
| `serves` | one of `anyone` / `owner` / `list` | `validation`: `serves must be anyone, owner or list` |
| `sort` | one of `name` / `owner` / `joined`; default `name` | `validation` |
| `dir` | `asc` / `desc`; default `asc` | `validation` |
| `limit` | integer, `0 <= limit <= MAX_PAGE_LIMIT`; default **50** | `validation`: `limit must be an integer between 0 and 1000` |
| `cursor` | see §2.5 | `validation`: `cursor is not valid for this query` |
| `facets` | boolean; default `true` | `validation` |

The bounds are deliberately the bounds `validateProfile` already enforces on the data
([`profile.ts:19-32`](../../../src/core/src/lobby/profile.ts)): a filter value longer than any
value that can be stored is a typo, not a query, and saying so is cheaper than running it. The
`models`/`tools`/`runtime` shapes are literally `Requirements` minus `spawnsSubagents`, so the
schema is built by reusing `validateRequirements`
([`matching.ts:37`](../../../src/core/src/lobby/matching.ts)) over
`{ models, tools, runtime }` and keeping `q`, `serves`, `sort`, `dir`, `limit`, `cursor` in a schema
of its own. One shape, one set of messages, no drift.

> **Amendment, 2026-09-20 (as built).** Three corrections to the table above, each found in
> implementation:
>
> - The `models` message prefix is **`requirements.models…`**, not `listeners.models…`. Reusing
>   `validateRequirements` is the rule this section states, and reusing it means inheriting its
>   messages; renaming them would have meant a second copy of the schema, which is the drift this
>   paragraph exists to prevent. The row above now says what the code says.
> - **A NUL is rejected** — and nothing else — in `q`, in every filter string and in a text cursor
>   key. A NUL cannot travel in a Postgres text parameter or in `jsonb`, so forwarding one turns a
>   hand-edited link into SQLSTATE `22021` (`22P05` inside a jsonb parameter) — a 500 for a value
>   that came out of the address bar. (The *write* paths — `validateProfile` and
>   `validateRequirements` — still accept a NUL; that is a pre-existing hole, now a row in
>   KNOWN-ISSUES, deliberately not fixed inside a read-only change.)
>
>   **Amendment, 2026-09-20 (PR #20 review round 1).** This rule was first built as the **whole C0
>   range**, U+0000 to U+001F, on the assumption that the rest of C0 "names no model, tool, runtime
>   or owner". That assumption was wrong, and it made the directory refuse its own output.
>   `validateProfile` accepts a tab or a newline inside an `owner`, a tool, a runtime, a model or an
>   effort, and a live Postgres carries every C0 character *but* NUL through `ILIKE`, through `@>`
>   containment and through a text cursor key. Two listeners owned by `"a\nb"` and
>   `"zzz"`, sorted by owner, therefore produced a `nextCursor` this validator then refused —
>   Show more died at that page boundary (§2.5) — and a stored tool `"a\tb"` appeared as a
>   facet chip that could not be clicked (§5.3). The rule is now NUL alone, in core and in
>   the page's own codec.
> - A **non-object query** is `validation`. `listListeners(db, actor, 5)` and
>   `listListeners(db, actor, null)` are not "no query"; only `undefined` is.
>
> And one at the REST level (§4.1): a **blank `?limit=`** is an *absent* limit, not `Number("") === 0`
> — which would have answered an empty directory to a link ending in `&limit=`.

#### Normalisation: an empty filter is no filter, because that is what the matcher means

This is not tidiness; it is the one place where SQL and `matches` would otherwise disagree.

- **`tools: []`.** `validateRequirements` accepts it (`z.array(...).max(50)`, no `.min`,
  [`matching.ts:31`](../../../src/core/src/lobby/matching.ts)) and `matches` **accepts every
  profile** for it — `req.tools` is a truthy empty array, and `[].every(…)` is `true`
  ([`matching.ts:46`](../../../src/core/src/lobby/matching.ts)) — *including* a profile with no
  `tools` key at all. The SQL containment `capabilities @> '{"tools":[]}'` would instead exclude
  every profile that has no `tools` key, because containment against a missing field is not true.
  So `tools: []` is **normalised to absent** before a predicate is built.
- **`models: []`.** `validateRequirements` **rejects** it (`.min(1)`,
  [`matching.ts:29`](../../../src/core/src/lobby/matching.ts)), so `matches` never sees one and has
  no opinion. `listListeners` is a UI-facing query whose control legitimately goes from "one chip
  selected" to "none", and a 400 in that moment would be a bug in the page rather than in the
  request — so it is **normalised to absent** too, and the empty array never reaches
  `validateRequirements`. Stated rather than inherited, because it is the one place this schema
  deliberately differs from the one it reuses.
- **`q: ""` or whitespace** → absent. `ILIKE '%%'` matches everything anyway, but an empty search is
  a cleared box, not a query, and it must not count as "filtering" for §2.6's `matched === total`
  short-circuit or for §2.7's facet rules.
- **`runtime`, `serves`, `sort`, `dir`** have no empty form: a blank string fails the 1–64 bound,
  and the enums are closed.

> **The general rule, and the one §8 tests as a property**: for every input that both accept, the
> set `listListeners` returns must equal the set produced by filtering the same rows with `matches`
> and `admits`. Normalisation is how that is made true at the edges, not an optimisation.

**`spawnsSubagents` is deliberately not a filter.** It is a boolean on two values; as a fifth
control it earns a row of UI and a facet for a question the card already answers with a badge
([`ProfileCard.tsx:24`](../../../src/web/src/components/ProfileCard.tsx)). Recorded as an open
question (§12.1), not as an omission.

**Why `limit` does not go through `validatePage`.**
[`validatePage`](../../../src/core/src/paging.ts) rejects `limit: 0` outright, and argues for that
at length: for a cursor-shaped API a caller asking for 0 gets an event it never asked for. Here 0
means something — *counts and facets only, no rows* — and it is the sidebar's whole request. So
`listeners.ts` states its own bound and quotes `MAX_PAGE_LIMIT` from `paging.ts` rather than copying
the number (the second-copy failure that module's comment exists to prevent). `PageOptions.since` is
not used at all: this query pages on a cursor, not on a seq.

### 2.4 Matching semantics

Every filter present must pass. **AND across filters**, and the search is ANDed with all of them.

| Filter | Rule | Mirrors |
| --- | --- | --- |
| `q` | case-insensitive **substring** of the participant's `name` **OR** of the profile's `owner` | nothing today — new |
| `models` | **any-of**: at least one alternative is satisfied. An alternative `{ model }` is satisfied by any entry with that `model`; `{ model, effort }` needs both to be equal | `matches`, [`matching.ts:45`](../../../src/core/src/lobby/matching.ts) |
| `tools` | **all-of**: every named tool is in the profile's `tools`. An **empty** list is no filter and matches everything, profiles with no `tools` key included (§2.3) | `matches`, [`matching.ts:46`](../../../src/core/src/lobby/matching.ts) |
| `runtime` | equality | `matches`, [`matching.ts:47`](../../../src/core/src/lobby/matching.ts) |
| `serves` | `anyone` → `serves === "anyone"`; `owner` → `serves === "owner"` **or absent**; `list` → `serves` is an array | `admits`, [`matching.ts:53-58`](../../../src/core/src/lobby/matching.ts) |

Three points worth stating outright, because each one is a decision:

- **`serves: "owner"` includes a profile with no `serves` key at all.** `admits` reads
  `profile.serves ?? "owner"` and `validateProfile` deliberately leaves the key absent when it was
  absent ([`profile.ts:16-18`](../../../src/core/src/lobby/profile.ts)), so "serves their owner" is
  the majority case and most of it is stored as nothing. A directory that showed those listeners
  under no filter at all would be lying about the default.
- **`serves: "list"` means "`serves` is an array", not "serves a particular owner".** Filtering by
  *which* owner is served is `find_agents`' `owner` parameter and the matching that a request
  performs; this control answers "who has a named list" and the card says whose.
- **Matching is `matches`' semantics, but not `matches`' code.** `find_agents` filters in memory,
  with the pure functions, precisely so that what it lists and what a request wakes cannot drift
  ([`profile.ts:76-80`](../../../src/core/src/lobby/profile.ts)). This query filters in **SQL**,
  because it also has to count, facet, sort and page — which is the whole point of it. The risk that
  buys is exactly one: the SQL and `matches` could disagree. §8 closes it with a test that runs both
  over the same fixture and asserts the same set, and `find_agents` stays the authority for anything
  a request depends on.

**`q` applies to name and owner only** — not to models, tools or runtime, which have their own
controls; not to unknown keys, which are a listener's own business and are never matched on
([`matching.ts:7`](../../../src/core/src/lobby/matching.ts)).

### 2.5 Ordering and the cursor

Three sort keys, both directions, and in every case the tie-break is the participant `id` in the
**same** direction, so the total order is strict and a cursor is exact.

| `sort` | Orders by | Case |
| --- | --- | --- |
| `name` | `lower(participants.name)`, then `id` | case-insensitive |
| `owner` | `lower(capabilities->>'owner')`, then `id` | case-insensitive |
| `joined` | `participants.joined_at`, then `id` | — |

- **Case-insensitive for `name` and `owner`.** Decided, because the alternative sorts `Zed` before
  `alice` and a human reads that as a bug; and because
  `participants_weave_name_idx` is already `(weave_id, lower(name))`
  ([`db/schema.ts:52`](../../../src/core/src/db/schema.ts)), so the default sort is served by an
  index that already exists.
- **Every sort key is non-null, and that is an invariant rather than a hope.** It matters because
  the cursor is a **tuple comparison** (below): `(NULL, id) > (k, i)` is NULL, never true, so a row
  with a null key would be unreachable past the first page in either direction, and the cursor's
  string key could not name its position either. So each key is established, not assumed:

  | Key | Why it cannot be null |
  | --- | --- |
  | `participants.name` | `text("name").notNull()` ([`db/schema.ts:42`](../../../src/core/src/db/schema.ts)) |
  | `participants.joined_at` | `timestamp(...).notNull().defaultNow()` ([`db/schema.ts:50`](../../../src/core/src/db/schema.ts)) |
  | `capabilities->>'owner'` | see below |

  **A listener always has a non-empty `owner`.** `capabilities` has exactly one writer in the whole
  repo — `setCapabilities`, `tx.update(participants).set({ capabilities: clean })`
  ([`profile.ts:61`](../../../src/core/src/lobby/profile.ts)) — and `clean` is
  `validateProfile`'s output, which is either `null` (for `null`, `undefined` or `{}`) or an object
  that has passed `if (profile.owner === undefined) throw …`
  ([`profile.ts:39-48`](../../../src/core/src/lobby/profile.ts)), with `owner` bounded
  `z.string().trim().min(1).max(64)` ([`profile.ts:27`](../../../src/core/src/lobby/profile.ts)).
  A listener is `capabilities IS NOT NULL`, so a listener's profile is one of those objects.
  Migration `0003` added the column nullable with **no default and no backfill**
  (`ALTER TABLE "participants" ADD COLUMN "capabilities" jsonb;`,
  [`0003_steep_dracula.sql`](../../../src/core/drizzle/0003_steep_dracula.sql)), so there are no
  pre-validation rows: every row was `NULL` until something called `setCapabilities`.

  Therefore **no `NULLS` clause is specified and no null branch is written into the cursor**. §8
  asserts the invariant directly instead (a listener always has an `owner`; a cleared profile is not
  a listener), which is the test that would actually catch a future writer that broke it — cursor
  logic for an unreachable state would not.
- **`joined_at` is a wall clock.** KNOWN-ISSUES (`lobby/requests.ts`, `db/schema.ts`) records that
  every `created_at` order in the product is a wall-clock order and that the development machine's
  database clock stepped backwards twice in twenty seconds. The consequence here is bounded and
  worth naming: two listeners that joined within a clock step of each other can appear swapped, and
  a row inserted with a backwards-stepped timestamp can land on a page the reader has already
  passed, so that reader never sees it. Nothing breaks; the cursor stays strict, because `id` is the
  tie-break and the comparison is on the pair.

**The cursor** is `(sort key value, id)`, base64url-encoded JSON:

```
cursor = base64url(JSON.stringify({ s: sort, d: dir, k: <sort key as a string>, i: <participant id> }))
```

and the next page is, written out for both directions:

```sql
-- asc                                        -- desc
(lower(name), id) > ($k, $i)                  (lower(name), id) < ($k, $i)
(lower(capabilities->>'owner'), id) > ($k,$i) (lower(capabilities->>'owner'), id) < ($k, $i)
(joined_at, id) > ($k::timestamptz, $i)       (joined_at, id) < ($k::timestamptz, $i)
```

`k` is the lowered name, the lowered owner, or the `joined_at` **as the database rendered it**.
Text comparisons use the database's collation, which is also what the `ORDER BY` uses: the two must
be the same expression or the page can skip or repeat a row. The tuple form is deliberate —
`k > $k OR (k = $k AND id > $i)` is the same thing written so that a future edit can get it wrong —
and it is total because every key is non-null (above) and `id` is a primary key.

#### The `joined` key must not lose precision

`participants.joined_at` is `timestamp("joined_at", { withTimeZone: true })`
([`db/schema.ts:50`](../../../src/core/src/db/schema.ts)) — Postgres `timestamptz`, **microsecond**
resolution. Every existing mapper renders a timestamp through a JS `Date`:
`toPublicParticipant` does `p.joinedAt.toISOString()`
([`actors.ts:11-15`](../../../src/core/src/actors.ts)), as do `toPublicWeave` and `toPublicThread`
([`weaves.ts:29-38`](../../../src/core/src/weaves.ts)). A JS `Date` holds **milliseconds**.

Taking the cursor key from that value would be a real paging bug, not a rounding curiosity. A row at
`…:00.123456Z` encoded as `…:00.123Z` is **less than** its own row's true value, so:

- **ascending**, `(joined_at, id) > ('…123Z', $i)` is true for that same row again — it appears on
  the next page too, a **duplicate**;
- **descending**, `(joined_at, id) < ('…123Z', $i)` is false for every row between `.123000` and
  `.123456` — they are **skipped**, silently.

So the rule:

> **The `joined` cursor key is produced by the database, as text, and handed back to the database as
> text.** The page query selects it beside the row:
>
> ```sql
> to_char(p.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key
> ```
>
> that exact string goes into the cursor's `k` verbatim, and the next page compares
> `(p.joined_at, p.id) > ($k::timestamptz, $i)`. **No JS `Date` is constructed anywhere on that
> path.**

- **`to_char` rather than `joined_at::text`** because `::text` renders in the session's `TimeZone`
  and `DateStyle`, so the same instant could produce different strings on two connections — and a
  cursor is compared, stored in a URL, and handed back later. `AT TIME ZONE 'UTC'` plus an explicit
  format is stable under any session settings. `.US` is microseconds, which is the column's full
  resolution.
- **The driver returns it as a string by construction.** `to_char` produces `text`, and
  postgres-js parses by the result's own type OID — there is no column type for it to consult and no
  `Date` to build ([`db/index.ts:17-19`](../../../src/core/src/db/index.ts): a plain
  `drizzle(postgres(url), …)` with no custom type parsers registered). This is why the key is
  computed in SQL rather than formatted in TypeScript from a value the driver already truncated:
  by the time a `Date` exists, the microseconds are gone.
- **The displayed `joinedAt` stays exactly as it is** — millisecond ISO through
  `toPublicParticipant`. Nothing in the UI needs microseconds, `PublicParticipant` does not change,
  and the cursor key is a separate, internal value that never appears on the participant.
- **`name` and `owner` need no equivalent**, being `text` already: they are selected as
  `lower(name)` / `lower(capabilities->>'owner')` and compared against the same expression.

- **A malformed cursor** — not base64url, not JSON, missing a field, or an `i` that is not a uuid —
  is `validation`, never a silently-ignored first page. A caller that pages with rubbish should hear
  about it, and "first page" is indistinguishable from "your cursor was dropped".
- **A cursor whose `s`/`d` disagree with the query's** is `validation` too: it is a cursor for a
  different ordering, and honouring it would produce a page that is neither.
- **A stale cursor** — one whose participant has left the Lobby, or cleared its profile, or been
  renamed past the key — is **not** an error. The comparison is on values, not on the row's
  existence, so the page after `("dana", <id>)` is well defined whether or not that row is still
  there. This is the deliberate reason the cursor carries the *value* and not just the id.
- **Filters are not in the cursor.** They are up to 50 tools and 20 models; a cursor is a position,
  not a query. A caller that changes a filter and keeps the cursor gets a coherent page of the new
  query starting from an arbitrary point — so the page UI **drops the cursor on every control
  change** (§5.3), which is the same rule "never reshuffles under the user" already implies.
- **`limit: 0` returns no `nextCursor`**, because there is no position to resume from.

This is deliberately *better* than the convention `listRequests` follows, and the improvement is the
one KNOWN-ISSUES asks for: "page on a monotonic key: `id` with a `(created_at, id)` index". Here the
pair is the key, and the tie-break is what makes it monotonic.

### 2.6 `total` and `matched`

- **`total`** — every listener in the Lobby: `weave_id = lobbyId AND capabilities IS NOT NULL`,
  ignoring `q` and every filter. It is what the sidebar shows and what the header's parenthesis
  shows, and it is the number a caller asks for with `limit: 0` and no filters.
- **`matched`** — the same predicate plus `q` and every filter. `matched === total` when nothing is
  filtering, and the header says "Showing 50 of 87 matches (1,204 listeners)".
  *(Reworded 2026-09-20 — §5.3's note: the line now reads "Showing 50 of 87 matches (out of 1,204
  listeners)". The two numbers and what they mean are unchanged.)*

Both are `count(*)`, not `listeners.length`: a page of 50 out of 87 must not report 50, which is
exactly the trap `LobbySummary` fell into for open requests (KNOWN-ISSUES, `LobbySummary.tsx`).

### 2.7 Facets

```
facets.models    top 20 models, each with its count and its top 10 efforts (each with a count)
facets.tools     top 20 tools with counts
facets.runtimes  top 20 runtimes with counts
facets.serves    exactly three rows — anyone, owner, list — with counts, zeros included
```

**Each facet is computed over the search-and-filter result minus that facet's own filter.** Spelled
out, because it is the rule the whole control panel depends on:

| Facet | Computed over listeners matching |
| --- | --- |
| `models` | `q` + `tools` + `runtime` + `serves` (**not** `models`) |
| `tools` | `q` + `models` + `runtime` + `serves` (**not** `tools`) |
| `runtimes` | `q` + `models` + `tools` + `serves` (**not** `runtime`) |
| `serves` | `q` + `models` + `tools` + `runtime` (**not** `serves`) |

Why: a facet that included its own filter would answer a question nobody asked. With **opus-5**
selected, a models facet that applied the models filter would show `opus-5: 87` and every other
model at zero — so the human could never see that switching to **sonnet-5** would find 40 people.
Excluding its own filter makes each chip's count read as "what you would get if you picked this
instead", which is what a chip is for. `serves` is a single-select, so its counts read as "what you
would get if you switched to this".

**Ties and the tail.** Ordered by `count desc`, then by `value asc` — so the order is total and a
re-run with the same data gives the same twenty. Beyond twenty the facet reports
`more: true` and no bucket: an "other" count would be a number the UI can do nothing with, since
there is no chip to click. The page says "20 most common — narrow the search to see the rest".

**A selected value is always present — including at zero.** If the caller filtered on a model that
is not in its facet's top twenty, that model's row is appended, with its own count computed by the
same rule. Without this the UI would drop the chip the human just clicked, which is unarguably worse
than a facet of 21 rows. The same holds for tools, runtimes and the efforts inside a model.

The part that needs saying out loud, because the obvious SQL cannot do it: **a selected value whose
count under the *other* filters is zero has no aggregate row at all**, so no amount of "or it is
selected" ranking can recover it — there is nothing to rank. It is also not a hypothetical: pick
`shell` under tools and `python` under runtime, and a runtime facet computed over the tools filter
may legitimately have no `python` row left. So every facet **left-joins its selected values onto its
aggregate** and reports `coalesce(count, 0)` (§2.8).

> **The response rule.** Every value the caller selected appears in its facet's list, with its true
> count under the other filters — **which may be `0`**. Selected values that fall outside the ranked
> top-N are appended after it, ordered among themselves by the same `count desc, value asc`.

The UI renders a zero-count selected chip as **selected and empty** — visibly chosen, visibly
matching nobody — rather than hiding it, because a chip the human cannot see is a filter they cannot
remove. That is the difference between "no listener matches these filters" with a way out and the
same message with none.

**The models facet is keyed by model, with efforts nested — and the efforts are bounded too.** That
is what the two-step control of §5.3 needs: pick `opus-5` (count across all its efforts), then
optionally narrow to `high`.

`effort` is free text, `z.string().trim().min(1).max(32)`
([`profile.ts:22`](../../../src/core/src/lobby/profile.ts)) — nothing anywhere constrains it to a
vocabulary. The per-profile cap of 20 model entries
([`profile.ts:23`](../../../src/core/src/lobby/profile.ts)) bounds one listener, and bounds nothing
across the instance: 10,000 listeners can each declare a different effort for the same model, which
would put 10,000 chips under one model. So the nested list gets **exactly the same treatment as
every other facet**:

- **top 10 efforts per model**, ordered `count desc, value asc`;
- **`more: true` on the model** when that model has more than 10 distinct efforts, rendered as the
  same "10 most common" line the outer facets use;
- **a selected effort is always included**, even outside the top 10 — the same rule, for the same
  reason: the UI must not drop the chip the human just clicked;
- and it is enforced **in SQL** (§2.8), not after the rows arrive, so the unbounded set never
  crosses the boundary in the first place.

`ModelFacet` therefore carries its own flag:

```ts
export type ModelFacet = { model: string; count: number; efforts: FacetValue[]; moreEfforts: boolean };
```

**Worst-case response size for `facets`.** 20 models × (a ≤100-character model name + 10 efforts ×
a ≤32-character value) + 20 tools × ≤64 + 20 runtimes × ≤64 + 3 serves rows, plus at most one extra
row per *selected* value. That is on the order of **12 KB** of JSON at the extreme and a few hundred
bytes in practice — against a page of 50 listeners whose profiles may each be 4000 characters
(≈200 KB), which remains by far the larger half of the answer.

**The `serves` facet always has all three kinds**, in the order `anyone`, `owner`, `list`, with
zeros, because a three-way control that loses an option when it hits zero is a control that moves
under the cursor.

**A caller that does not want them says so.** `facets: false` omits the whole object and skips four
queries. It exists for one caller — the sidebar and the Lobby summary, which want a number and
nothing else, on every Lobby refresh (§5.1) — and it is a flag rather than an inference from
`limit: 0` because "no rows" and "no facet counts" are genuinely different requests: the page asks
for `limit: 0` with facets while the human is still typing a filter that matches nothing.

**Cost.** Facets are the expensive half of this query — see §2.8.

### 2.8 The SQL, and what it costs

One base predicate, reused everywhere (`$1` = the Lobby's weave id):

```sql
p.weave_id = $1 AND p.capabilities IS NOT NULL
```

and the filter fragments, each parameterised (drizzle `sql` templates — never string-concatenated):

| Filter | Predicate | Index-servable |
| --- | --- | --- |
| `q` | `(p.name ILIKE $q ESCAPE '\' OR p.capabilities->>'owner' ILIKE $q ESCAPE '\')` where `$q` is `'%' \|\| escaped \|\| '%'` | no — a filter |
| `models` | `OR` over the alternatives: `p.capabilities @> $alt::jsonb` with `$alt` = `{"models":[{"model":"…"}]}` or `{"models":[{"model":"…","effort":"…"}]}` | **yes** |
| `tools` | `p.capabilities @> $tools::jsonb` with `$tools` = `{"tools":["shell","github"]}` — array containment **is** all-of, so it is one predicate, not N | **yes** |
| `runtime` | `p.capabilities @> $runtime::jsonb` with `$runtime` = `{"runtime":"node"}` | **yes** |
| `serves = anyone` | `p.capabilities @> '{"serves":"anyone"}'::jsonb` | **yes** |
| `serves = owner` | `NOT (p.capabilities ? 'serves') OR p.capabilities @> '{"serves":"owner"}'::jsonb` | no — a disjunction with a negation |
| `serves = list` | `jsonb_typeof(p.capabilities->'serves') = 'array'` | no — a filter |

**Every containment predicate names `capabilities` itself, never `capabilities->'…'`.** This is the
single most load-bearing detail in the section. A GIN index is built over one expression and
PostgreSQL will only use it for an operator applied to **that** expression
([PostgreSQL: jsonb indexing](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)),
so an index on `capabilities` does nothing whatever for `capabilities->'tools' @> …`, which is how
an earlier draft of this spec wrote it. Whole-document containment is equivalent, because
containment is recursive and array containment is subset containment:

| Query | Matches |
| --- | --- |
| `{"tools":["shell","github"]}` | a profile whose `tools` array has **both**, in any order, among any others |
| `{"models":[{"model":"opus-5"}]}` | a profile with **some** models entry containing `{"model":"opus-5"}` — with any `effort`, because an object is contained in a larger object |
| `{"models":[{"model":"opus-5","effort":"high"}]}` | a profile with some entry containing **both** keys — the exact pair |
| `{"runtime":"node"}` | equality on a scalar member |

which is exactly the `matches` semantics of §2.4, and `jsonb_path_ops` indexes all four shapes:
that operator class supports `@>` (plus `@?`/`@@`), which is all the containment predicates use.
It does **not** support `?`, so the `serves = owner` disjunction and the `serves = list`
`jsonb_typeof` test are not index-servable at all — they are recheck/filter conditions.

**What the planner actually does**, stated honestly rather than hoped for:

- With a containment filter present, the expected shape is a **BitmapAnd**: a bitmap index scan of
  `participants_capabilities_idx` for the containment, and either a bitmap scan of
  `participants_weave_name_idx` for `weave_id = $1` or that condition as a recheck. The `q`,
  `serves` and cursor conditions are applied as filters on the heap rows that survive.
- With **no** containment filter — the bare directory, or `serves` alone — there is nothing for GIN
  to do. The query is then a scan of the Lobby's own participants through the existing
  `(weave_id, lower(name))` btree, which also supplies the default ordering. Bounded by the Lobby's
  participant count, which is the population this whole feature is about and is the same scan
  `find_agents` performs today.
- `q` has no index. It is a substring match, which a btree cannot serve; `pg_trgm` and a GIN
  trigram index would, and that is a later decision (§11) rather than a guess now — it is a second
  extension and a second index for a filter that runs over an already-narrowed set.

**Escaping `q`.** `ILIKE` reads `%` and `_` as wildcards, so a search for `a_b` would match `axb`.
The value is escaped before it is parameterised — `\` → `\\`, then `%` → `\%`, `_` → `\_` — and the
pattern is applied with an explicit `ESCAPE '\'`. The escaped value still travels as a **bind
parameter**; escaping is about wildcard semantics, parameterisation is about injection, and the
query needs both. (`_` in a search is not hypothetical: `NAME_RE` allows it in every participant
name, `CONTRIBUTING.md` §"Naming and value rules".)

The queries per call:

| # | Query | Returns |
| --- | --- | --- |
| 1 | `count(*)` over the base predicate | `total` |
| 2 | `count(*)` over base + `q` + all filters | `matched` |
| 3 | the page: base + `q` + all filters + cursor comparison, `ORDER BY <key>, id`, `LIMIT limit + 1` | the rows, and whether there is a next page |
| 4 | the models facet — two ranking stages plus the selection, written out below | the models facet |
| 5 | the tools facet — ranked top 21 `UNION` the selected tools left-joined onto the aggregate | the tools facet |
| 6 | the runtimes facet — the same shape as 5 | the runtimes facet |
| 7 | three `count(*) FILTER (WHERE …)` in one row | the serves facet |

**Query 4, in full**, because two things about it are easy to get wrong and both were:

```sql
WITH base AS (                                    -- the population this facet is computed over
  SELECT p.id, p.capabilities FROM participants p
  WHERE p.weave_id = $1 AND p.capabilities IS NOT NULL
    AND <q> AND <tools> AND <runtime> AND <serves>          -- every filter but this facet's own
), pairs AS (                                     -- one row per (listener, model, effort)
  SELECT DISTINCT b.id, m->>'model' AS model, m->>'effort' AS effort
  FROM base b, jsonb_array_elements(b.capabilities->'models') m
), model_counts AS (                              -- ONE row per model
  SELECT model, count(DISTINCT id) AS listeners FROM pairs GROUP BY model
), ranked_models AS (
  SELECT model, listeners,
         row_number() OVER (ORDER BY listeners DESC, model) AS rn
  FROM model_counts
), kept_models AS (
  SELECT model, listeners FROM ranked_models WHERE rn <= 21
  UNION                                           -- the selection, even at zero
  SELECT s.model, coalesce(mc.listeners, 0)
  FROM unnest($selectedModels::text[]) AS s(model)
  LEFT JOIN model_counts mc ON mc.model = s.model
), effort_counts AS (                             -- only for the models that survived
  SELECT p.model, p.effort, count(DISTINCT p.id) AS listeners
  FROM pairs p JOIN kept_models k ON k.model = p.model
  GROUP BY p.model, p.effort
), ranked_efforts AS (
  SELECT model, effort, listeners,
         row_number() OVER (PARTITION BY model ORDER BY listeners DESC, effort) AS rn
  FROM effort_counts
), kept_efforts AS (
  SELECT model, effort, listeners FROM ranked_efforts WHERE rn <= 11
  UNION
  SELECT s.model, s.effort, coalesce(ec.listeners, 0)
  FROM unnest($selModels::text[], $selEfforts::text[]) AS s(model, effort)
  LEFT JOIN effort_counts ec ON ec.model = s.model AND ec.effort = s.effort
)
SELECT k.model, k.listeners, e.effort, e.listeners AS effort_listeners
FROM kept_models k LEFT JOIN kept_efforts e ON e.model = k.model;
```

and queries 5 and 6 are the same shape with one stage:

```sql
WITH base AS ( … every filter but this facet's own … ),
tool_counts AS (
  SELECT t.value AS tool, count(DISTINCT b.id) AS listeners
  FROM base b, jsonb_array_elements_text(b.capabilities->'tools') t GROUP BY 1
), ranked AS (
  SELECT tool, listeners, row_number() OVER (ORDER BY listeners DESC, tool) AS rn FROM tool_counts
)
SELECT tool, listeners FROM ranked WHERE rn <= 21
UNION
SELECT s.tool, coalesce(tc.listeners, 0)
FROM unnest($selectedTools::text[]) AS s(tool) LEFT JOIN tool_counts tc ON tc.tool = s.tool;
```

Notes, each of them a decision:

- **Ranking happens on one row per model.** `model_counts` collapses to exactly one row per model
  *before* `row_number()` runs. An earlier draft ranked a `GROUPING SETS` result, which contains the
  model's own row **and** one row per effort — so the rank advanced by effort rows and a model with
  50 efforts pushed twenty perfectly ordinary models past the cut. Two stages, and the second one
  only sees models the first one kept.
- **A listener that offers one model at two efforts counts once for that model.** `pairs` is
  `DISTINCT` on `(id, model, effort)` and `model_counts` is `count(DISTINCT id)`, so neither two
  efforts nor a duplicated entry (nothing forbids
  `[{model:"m",effort:"high"},{model:"m",effort:"high"}]`) inflates it. Per-effort counts are
  `count(DISTINCT id)` for the same reason, and queries 5 and 6 likewise — a profile that lists a
  tool twice must not count twice.
- **`row_number()`, not `rank()`.** The `ORDER BY` ends in the value itself, which is unique within
  the group, so ties are already fully broken; `row_number()` then returns *exactly* 21 rows where
  `rank()` could return more, and "exactly 21" is what the `more` flag is read from.
- **The 21st and 11th rows are the `more` and `moreEfforts` flags**, the same trick as
  `LIMIT limit + 1` on the page: one extra row instead of a second `count(distinct …)`.
- **`unnest($selected::text[])` with a `LEFT JOIN` is how a selection at zero survives** (§2.7).
  Ranking "or selected" cannot do it, because a value with no matches has no row in the aggregate to
  select. `unnest` over two parallel arrays gives the (model, effort) pairs the same treatment. With
  nothing selected the arrays are empty and the `UNION` adds nothing.
- **`UNION`, not `UNION ALL`**, so a selected value that *is* in the top N appears once. The rows
  are identical in that case — same value, same count — so the deduplication is exact rather than
  approximate.
- **The `serves` facet needs none of this**: it is three `count(*) FILTER` expressions over a fixed
  set of kinds, so every kind is always present with its count, zeros included (§2.7).
- **Bounded, whatever the instance looks like**: at most 21 models × 11 efforts plus the selection
  crosses the boundary from query 4, and 21 rows plus the selection from each of 5 and 6. The fold
  in TypeScript is then pure shaping — drop the overflow rows, set `more`/`moreEfforts`, nest the
  efforts, append the selected extras in `count desc, value asc` order.
- **The `capabilities->'…'` in queries 4 and 5 is a projection, not a predicate.** `->` there feeds
  `jsonb_array_elements`, which is what is being *selected from*; the index rule above is about the
  left operand of `@>` in a `WHERE` clause, and these queries' `WHERE` is the same
  whole-document containment as everywhere else. The two are easy to confuse and only one of them
  can cost an index.
- **A `NULL` runtime is not a facet row.** Query 6 adds `AND p.capabilities ? 'runtime'`: "no
  runtime declared" is not something to filter by, and a chip for it would filter on a value the
  filter cannot express (`runtime` is equality against a string). The same holds for a profile with
  no `models` or no `tools` — `jsonb_array_elements` over a missing key produces no rows, which is
  the right answer and not an error, because the `FROM p, jsonb_array_elements(…)` join is an
  implicit `CROSS JOIN LATERAL` and drops the row.
- **`limit: 0` skips query 3**, and **`facets: false` skips queries 4–7**. One more rule makes the
  sidebar's call as cheap as it can be: **when no search and no filter is given, query 2 is skipped
  and `matched` is set from `total`**, because the two predicates are then identical. So
  `{ limit: 0, facets: false }` with no filters is the whole price of "Listeners (1,204)": **one**
  `count(*)` per Lobby refresh, against the full profile snapshot `getWeave` used to carry.
- **Nothing here depends on anything else here**, so the queries that do run are issued with
  `Promise.all` on the same connection. Only the fold of query 4 and the `more` flags happen in
  TypeScript, over at most a few dozen rows.

#### The index, and an honest cost estimate

Migration **0004**, generated with `drizzle-kit` from a schema change and committed with its
snapshot exactly as `0003` was (`src/core/drizzle/`, `meta/_journal.json`):

```sql
CREATE INDEX "participants_capabilities_idx" ON "participants"
  USING gin ("capabilities" jsonb_path_ops) WHERE "capabilities" IS NOT NULL;
```

- **Why GIN**: `@>` is the predicate the models, tools, runtime and `serves: anyone` filters are
  built on, and without a GIN index it is a sequential scan of `participants` — every participant of
  every Weave — with a jsonb containment test per row.
- **The index and the predicates must name the same expression.** The index is on `capabilities`,
  so every containment predicate is on `capabilities` (the table above). This is the pairing the
  `EXPLAIN` test below exists to pin: it is invisible in a passing functional test and it is exactly
  what an innocent-looking edit to `capabilities->'tools' @> …` would silently undo.
- **Why partial**: listeners are a small minority of `participants` on any instance with more than
  one Weave, and `capabilities IS NOT NULL` is a constant predicate, so the partial index is legal
  and is a fraction of the size. It cannot be made partial on the Lobby's id, which is a value in a
  settings row, not a constant.
- **Why `jsonb_path_ops`**: it indexes `@>` (plus the jsonpath operators), which is every
  index-servable predicate this query has, at roughly half the size of the default `jsonb_ops`,
  which additionally supports `?`, `?|`, `?&`. The one `?` in the predicate table — inside the
  `serves = owner` disjunction — could not use a GIN index through an `OR NOT` anyway, so the wider
  operator class would buy nothing here. This is the same index shape KNOWN-ISSUES suggests for
  `events.payload`.
- **Proven by a plan, not by existence.** A test that only asserts the index is in `pg_indexes`
  passes just as happily when nothing uses it. §8 therefore requires an `EXPLAIN` test over a
  seeded table of a few thousand listeners: for the tools, models and runtime filters the plan must
  name `participants_capabilities_idx`. To keep it from being a flaky performance test, it runs
  inside one transaction that first `ANALYZE participants` (so the planner has statistics rather
  than defaults) and then `SET LOCAL enable_seqscan = off` (so a planner that *could* use the index
  must; `SET LOCAL` reverts with the transaction). The assertion is on the plan text containing the
  index name — never on a duration. With the predicate written against `capabilities->'tools'`
  instead, the plan is a sequential or btree scan with a filter and the test fails, which is the
  regression it exists for.
- **What is *not* added**: an expression index on `lower(capabilities->>'owner')` for the owner
  sort. At the sizes below the sort is over the *matched* set, which the filters have already
  narrowed, and a second index is a write cost on every `setCapabilities`. Recorded as an open
  question (§12.5) rather than shipped on a guess. The `name` sort needs nothing new —
  `participants_weave_name_idx` is `(weave_id, lower(name))` already.

**Expected cost at 1,000–10,000 listeners.** Queries 1, 2 and 3 are index scans plus a sort of at
most the matched set; a 10,000-row sort of a (text, uuid) pair is single-digit milliseconds in
Postgres and the page itself is 50 rows. Queries 4 and 5 are the ones to watch: they unnest, and a
profile carries up to 20 models and 50 tools
([`profile.ts:23-24`](../../../src/core/src/lobby/profile.ts)), so an unfiltered facet pass over
10,000 listeners can expand to a few hundred thousand element rows before grouping — tens of
milliseconds, once per request, on an answer of at most 21 rows. Real profiles carry a handful of
each, so the realistic number is far smaller.

The facet queries are also the ones the GIN index helps least: their `WHERE` still narrows by
containment where a filter is given, but the unnest runs over whatever survives, and with no filter
at all it runs over every listener in the Lobby.

**Honest conclusion**: fine for one instance's Lobby, and the shape to change when it stops being
fine is to compute the facets only when the result set is small enough to be worth faceting, or to
cache the unfiltered facet set behind a short TTL — both of them later, neither of them now. What
this design refuses to do is return every profile to the caller and count in memory, which is what
the page does today and what this whole sub-project exists to stop.

### 2.9 Where it lives

| File | Change |
| --- | --- |
| `src/core/src/lobby/listeners.ts` | **new** — the types, the validation, the SQL, the cursor codec |
| `src/core/src/lobby/matching.ts` | unchanged |
| `src/core/src/lobby/profile.ts` | unchanged — `findAgents` keeps its in-memory matching |
| `src/core/src/index.ts` | `listListeners` on the facade, through `resolveInLobby` |
| `src/core/src/db/schema.ts` | the GIN index on `participants` |
| `src/core/drizzle/0004_*.sql` + `meta/` | the migration |

## 3. `getWeave` stops carrying Lobby profiles

### 3.1 The change

[`getWeave`](../../../src/core/src/weaves.ts) reads every participant row of the Weave and maps it
through `toPublicParticipant`, which carries `capabilities`. For the **Lobby's** Weave, and only for
it, the profiles are dropped:

```ts
export async function getWeave(db: Queryable, actor: Actor, weaveId: string): Promise<WeaveInfo> {
  …
  const lobbyId = await getLobbyWeaveId(db);                       // settings.ts, one indexed row
  const hideProfiles = lobbyId === weaveId;
  return { …, participants: ps.map((p) =>
    hideProfiles ? { ...toPublicParticipant(p), capabilities: null } : toPublicParticipant(p)) };
}
```

**No exception, not even for the caller.** An earlier draft of this spec kept the caller's own
profile here, so that the web Offer form would keep working without a second read. It does not
survive contact with the third route: on `/w/<lobby secret>` the session reads metadata with the
**secret** (`pickReader` returns `client.withToken(secret)` for a secret target,
[`session.ts:173`](../../../src/web/src/session.ts)) and then reconstructs `me` by looking the
**stored** `participantId` up in the answer
([`session.ts:542-546`](../../../src/web/src/session.ts)). The caller is then
`{ kind: "secret" }`, which owns no participant row — so an eligible, joined listener reading its
own Lobby through the secret link would have found its profile blanked and the Offer form gone.
§3.3 replaces the exception with one explicit read that works the same way on all three routes.

Two decisions in those three lines:

- **`capabilities: null`, not absent.** `PublicParticipant.capabilities` is `Profile | null`,
  non-optional ([`types.ts:23-27`](../../../src/core/src/types.ts)), and the client package
  hand-mirrors that type ([`client/src/types.ts:12`](../../../src/client/src/types.ts)). Making it
  optional is a breaking type change in two packages for every consumer of a participant, to express
  a distinction no caller branches on. So the shape is unchanged and the **documentation** carries
  the news: the doc comment on `PublicParticipant.capabilities` becomes "The Lobby capability
  profile. Null everywhere but the Lobby — and null from `getWeave` **in** the Lobby too: read a
  listener's profile with `listListeners` or `findAgents`, and your own with
  `getMyLobbyParticipant`." Because the rule is now uniform, `null` from `getWeave` means exactly
  one thing in the Lobby — *this call does not carry profiles* — which is strictly clearer than the
  per-row exception Paw confirmed (§12.3).
- **`getLobbyWeaveId` is one more single-row read** per `getWeave`. KNOWN-ISSUES already records
  that `getWeave` gained a `SELECT … FROM settings` for the guidelines composition, and its
  suggested fix (cache the instance layer behind a short TTL) covers both. In fact
  `getInstanceGuidelines` is already called in the same function
  ([`weaves.ts:103`](../../../src/core/src/weaves.ts)), which reads the same one-row table — so
  this is a second read of a row that is certainly in cache, and the row to add to KNOWN-ISSUES is
  "these two settings reads should be one".

`resolveInWeave`, `assertCanRead` and every other rule are untouched. No route's authorization
changes. `findAgents` is untouched.

### 3.2 Every consumer of `PublicParticipant.capabilities`, and what happens to it

| Where | Reads | After this change |
| --- | --- | --- |
| [`web ProfileCards`](../../../src/web/src/components/ProfileCard.tsx) (`state.participants.filter(p => p.capabilities)`) | the Lobby sidebar's cards | **removed** — replaced by the Listeners line (§5.1). `ProfileCard` itself stays and is reused by the page |
| [`web RequestsPanel:107`](../../../src/web/src/components/RequestsPanel.tsx) (`me.capabilities`) | whether this browser can offer | **keeps working, and the component is unchanged** — the session fills `me.capabilities` from the new own-profile read (§3.3) |
| [`web RequestsPanel:152-153`](../../../src/web/src/components/RequestsPanel.tsx) (`me.capabilities.models`) | the Offer form's model picker | **keeps working**, same reason |
| [`web LobbySummary:55`](../../../src/web/src/components/main/LobbySummary.tsx) (`info.participants.filter(p => p.capabilities !== null).length`) | the main page's "12 listeners" | **breaks** — re-pointed at `listListeners({ limit: 0, facets: false }).total` (§5.1) |
| [`web MessageList:45`](../../../src/web/src/components/MessageList.tsx) | the system line for a profile change | unaffected — reads `e.payload.capabilities`, not the participant |
| [`cli lobby.ts:53, 61-68`](../../../src/cli/src/commands/lobby.ts) (`loom lobby`) | a profile summary per participant, from `client.getWeave(lobbyId)` | **breaks** — every line would read `(no profile)`. Fixed by having the command also call `findAgents({})` (unchanged, still carries profiles) and merge by participant id, so its output is **identical** to today's. One extra bounded call in one command; not a new surface |
| [`cli lobby.ts:111`](../../../src/cli/src/commands/lobby.ts) (`loom lobby find`) | `findAgents` | unaffected |
| [`claude-channel format.ts:86`](../../../src/claude-channel/src/format.ts) | the profile-change turn | unaffected — event payload |
| `claude-channel backend.ts` (`getWeave`, `getGuidelines`, `list_joined`) | threads, participants, guidelines | unaffected — never reads `capabilities` |
| MCP `get_weave` ([`tools.ts:116`](../../../src/mcp-tools/src/tools.ts)) | the whole `WeaveInfo` | Lobby participants come back with `capabilities: null`. The tool's own description promises "names, kinds, roles" and nothing else, and `find_agents` is the documented way to read profiles — **no tool change**, one sentence added to `get_weave`'s description pointing at `find_agents` for the Lobby |
| [`core export.ts:19, 31`](../../../src/core/src/export.ts) (`exportWeave`) | `getWeave` inside the export snapshot | a **JSON** export of the Lobby has `participants[].capabilities: null` — while `events[].payload.capabilities` still carries every historical profile verbatim (§1, problem 2). The **Markdown** export is unaffected either way: its participant line prints name, kind and role ([`export.ts:42`](../../../src/core/src/export.ts)) and `participant.capabilities_changed` falls through to the bare `e.type` system line ([`export.ts:59-66`](../../../src/core/src/export.ts)) |
| [`core test/lobby-profile.test.ts`](../../../src/core/test), `lobby.test.ts` | profile round-trips | asserted through `findAgents` / `setCapabilities`' return where they already are; any assertion that reads a Lobby profile out of `getWeave` moves to `findAgents` |
| [`claude-channel test/lobby.test.ts:217,223`](../../../src/claude-channel/test/lobby.test.ts) | `core.getWeave(actor, L).participants.find(…).capabilities` — the two-step-leave assertions | **must move to `findAgents`**. Named because they are the only assertions outside `core` and `web` that read a Lobby profile through `getWeave`, and the rule they prove (the profile is cleared before the credential) is worth keeping exactly as sharp |
| [`cli test/lobby.test.ts:108`](../../../src/cli/test/lobby.test.ts) ("lobby prints … a profile summary each") | `loom lobby` output | **kept green by the merge above** — which is the reason to do the merge rather than accept the regression |

**Compatibility, stated plainly.** Nothing that could read a profile before is refused one now: every
caller that loses profiles from `getWeave` has `findAgents` (agents, CLI) or `listListeners`
(humans, the web) as a better-shaped replacement, and both are authorised identically. What changes
is which call carries the data — and the size of the Lobby's `getWeave` answer, which is the point.

### 3.3 "My own profile": one read, one code path, three routes

`state.me` is `{ token, participant }`, and the participant is taken from `getWeave`'s list by id
([`session.ts:280-281, 542-546, 571`](../../../src/web/src/session.ts)). `RequestsPanel` decides
`canOffer` on `!!me.capabilities` and the Offer form's `<select>` is built from
`me.capabilities.models`
([`RequestsPanel.tsx:107, 152-153`](../../../src/web/src/components/RequestsPanel.tsx)). So "can I
offer?" is answered from whatever `getWeave` put on my own row — which, after §3.1, is `null`.

**The three routes that can render the Lobby do not authenticate the same way**, which is what
rules out solving this inside `getWeave`:

| Route | `getWeave` is called with | Is there an "own participant" on the actor? |
| --- | --- | --- |
| `/lobby` | the stored participant **token** ([`readerFor`](../../../src/web/src/weaves-store.ts)) | yes |
| `/weave/<lobbyId>` | the same | yes |
| `/w/<lobby secret>` | the **secret** — `pickReader` returns `client.withToken(secret)` unconditionally for a secret target ([`session.ts:173`](../../../src/web/src/session.ts)) | **no** — the actor is `{ kind: "secret" }`, and `me` comes from storage ([`session.ts:542-546`](../../../src/web/src/session.ts)) |

Three designs were weighed:

| Option | Verdict |
| --- | --- |
| **(a) An explicit read of the caller's own Lobby participant**, `GET /api/lobby/participants/me`, called with **`me`'s token** | **Chosen.** One request, one rule, identical on all three routes, and it works for any client — not just the web |
| (b) Keep the `getWeave` own-profile rule for token reads and add (a) only for secret reads | Rejected: two code paths for one question, and the rarely-exercised one is the one that would rot. It also keeps the per-row `null` ambiguity for no benefit |
| (c) Read metadata with the stored token whenever a usable identity exists | Rejected: it changes `/w/<secret>` behaviour the main-page spec froze ("unchanged in every respect", §2.7 there), it breaks read-before-join (a secret grants read *without* an identity), and it undoes the secret **fallback** of §2.6 there — a page whose token has just died would then read with the credential it just proved dead |

#### The core function

In [`profile.ts`](../../../src/core/src/lobby/profile.ts), beside `setCapabilities` — it is the read
half of the same surface:

```ts
/** The caller's own Lobby participant, profile included. The one way to read your own profile now
 *  that `getWeave` carries none: authorised as `setCapabilities` is, by being that participant. */
export async function getMyLobbyParticipant(db: Db, actor: Actor): Promise<PublicParticipant> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);        // same gate as setCapabilities (profile.ts:57)
  const [row] = await db.select().from(participants).where(eq(participants.id, me.id));
  if (!row) throw errors.invalidToken();                 // the identity named by this credential is gone
  return toPublicParticipant(row);
}
```

- **Re-read from the row, not returned from the `Actor`.** The actor carries the participant as it
  was when the credential was resolved; a profile set from another client a second ago would not be
  on it. This is the same freshness argument `assertInstanceKeeperFresh` makes
  ([`actors.ts:87-91`](../../../src/core/src/actors.ts)).
- **`assertParticipantOf`, so a secret or keeper credential is `forbidden`** ("Join the Weave to do
  this"). That is correct rather than unfortunate: neither owns a profile. The web still works on
  `/w/<lobby secret>` because the call is made with **`me.token`** — a participant token — not with
  the page's reader.
- The facade adds `getMyLobbyParticipant: async (actor) => profile.getMyLobbyParticipant(db, await
  resolveInLobby(actor))`, so an agent key works here exactly as it does for `setCapabilities`
  ([`index.ts:84-86`](../../../src/core/src/index.ts)).

#### How the session uses it

One cache, one helper, one apply rule, so no component changes:

```ts
/** The profile cache is **owned by an identity**: it is only ever applied to the participant and
 *  token it was read for, and it retires with them. */
type OwnProfile = { participantId: string; token: string; profile: Profile | null };
let ownProfile: OwnProfile | undefined;
let ownProfileSeq = 0;          // incremented when a read STARTS
let ownProfileApplied = 0;      // the number of the newest read whose answer was applied
```

- **`withMyProfile(p)` is the single place `me` is built**:
  `p.id === ownProfile?.participantId ? { ...p, capabilities: ownProfile.profile } : { ...p, capabilities: null }`.
  Every site that sets `me` goes through it — the ready patch in `doLoad`
  ([`session.ts:571`](../../../src/web/src/session.ts)), the `me` re-derivation in `refreshInfo`
  ([`session.ts:280-281`](../../../src/web/src/session.ts)) and the post-join patch
  ([`session.ts:652`](../../../src/web/src/session.ts)) — otherwise the next refresh would quietly
  blank the profile again. Because the helper compares the id, a cache belonging to a *previous*
  identity can never be painted onto a new one: identity ownership is enforced where the value is
  used, not only where it is stored.
- It is read **only on the Lobby** (`onLobby()`), **only when `me` exists**, and with
  `client.withToken(state.me.token)` rather than with `reader`.
- Triggers: after the ready patch in `doLoad`; after a late Lobby discovery in `retryLobbyData`;
  and on a `participant.capabilities_changed` whose `payload.participantId === me.id`. The refresh
  that the same event already schedules is the backstop, not the mechanism.

##### The apply rule: a generation guard is not an ordering guard

These reads start from three call sites and can therefore be **in flight at the same time inside one
generation** — a load's read and the read triggered by a profile change a moment later. Nothing
about the generation counter orders them, so an older answer landing last would restore a profile
the newer one had just cleared. Two things are needed, and both are cheap:

> **Sequencing.** Each read takes `const n = ++ownProfileSeq` when it *starts*. Its answer is
> applied only if `n > ownProfileApplied`, and applying it sets `ownProfileApplied = n`. An older
> answer that lands late is dropped.
>
> **Identity ownership.** The answer is applied only if `state.me` still names the same
> `participantId` **and** holds the same `token` the read was made with. A join, a rejoin after an
> invalidation, or any other identity change therefore discards it — even within one generation.

```ts
// on the answer, in this order
if (disposed || myGeneration !== generation) return;                       // the generation guard
if (n <= ownProfileApplied) return;                                        // sequencing
if (state.me?.participant.id !== forId || state.me.token !== forToken) return;   // identity
ownProfileApplied = n;
ownProfile = { participantId: forId, token: forToken, profile: answer.capabilities };
set({ me: withMyProfile(state.me.participant) });
```

**Sequencing rather than coalescing**, deliberately. `scheduleRefresh` coalesces because it owns a
*retry loop* whose slot has to belong to a generation
([`session.ts:409-431`](../../../src/web/src/session.ts)) — real bookkeeping, justified there. Here
the concern is purely ordering: two integers, checked where the answer is applied, and the rule is
visible in one place instead of being distributed across three call sites that would each have to
consult a slot. Redundancy is not a problem worth the extra machinery either: the only trigger that
is not already coalesced upstream by `scheduleRefresh` is the event naming **me**, which fires when
*this* participant's own profile changes — one edit, one event, not a fan-out.

**The cache retires with the identity.** It is cleared by `join()` (a rejoin is a different
participant, with no profile until it sets one — and `join` deliberately does **not** bump the
generation, [`session.ts:651-653`](../../../src/web/src/session.ts), which is exactly why the
identity check above is not redundant), by the invalidation path below, and by a new `doLoad`
(which bumps the generation, [`session.ts:472`](../../../src/web/src/session.ts), retiring every
read in flight).

##### When the own-profile read is *rejected*

Not every failure is the same failure, and treating them alike would leave a dead credential in
state and in storage:

| Failure | Meaning | What happens |
| --- | --- | --- |
| network, 5xx, timeout | the server did not answer | keep the last value, retry on the next trigger. Nothing is invalidated |
| `401 invalid_token` / `403 forbidden` (`isCredentialFailure`, [`weaves-store.ts:208-210`](../../../src/web/src/weaves-store.ts)) | **this identity is provably dead** | invalidate it, below |

This is the case that only exists because the read uses a *different credential from the page*. On
`/w/<lobby secret>` the metadata read succeeds (it is made with the secret) while the own-profile
read is rejected — so without a rule the page would go on showing `me`, and the Offer form, for a
token the server has already refused, and `localStorage` would keep it for the next visit.

##### First: a failure describes the identity it was made for, and no other

The success path is owned by an identity (above). **The failure path needs the same ownership, and
needs it more**, because its side effects are destructive: it deletes a token from `localStorage`.
The race is concrete. A read starts for identity A; A's token dies; the human joins again and gets a
fresh identity B with a brand-new token; A's `401` lands. Without a guard the handler would delete
**B's** token — a credential the server issued seconds ago and has never refused — clear `me`, and
show a read-only "your identity is no longer valid" banner to someone who has just joined.

So every own-profile read **captures, when it starts**, the three things that say whose read it is,
and the rejection handler checks all three **before any side effect whatsoever**:

```ts
const started = { id: state.me!.participant.id, token: state.me!.token, generation, n: ++ownProfileSeq };
…
// on rejection, before ANYTHING else — no write, no onWrite, no cache clear, no set()
if (disposed || started.generation !== generation) return;                        // a newer load owns the session
if (state.me?.participant.id !== started.id || state.me.token !== started.token) return;  // a different identity
if (started.n <= ownProfileApplied) return;                                       // an older answer than one already acted on
ownProfileApplied = started.n;
// …only now: isCredentialFailure(e) ? invalidate : keep the last value
```

- **Silently discarded, not logged as an error and not retried.** A rejection that fails the guard
  describes an identity this session no longer has; there is nothing to report and nothing to fix.
  The same is true of the **transient** branch: a mismatched network failure must not set
  `refreshError`, must not schedule anything against the new identity, and must not touch the cache.
  The guard is therefore the first thing in the handler, ahead of the `isCredentialFailure` split,
  rather than being repeated inside each branch.
- **Token as well as participant id.** A rejoin under the *same name* is refused (`name_taken`), so
  in practice a new identity carries a new id — but a token comparison costs one `!==` and is the
  thing actually being invalidated. Both are captured, both are checked.
- **The request number applies to failures too**, and that is a deliberate asymmetry worth stating.
  A `401` is evidence about a token regardless of when it was asked for; but a **newer success with
  that same token is later, stronger evidence that it works**, and invalidation is destructive and
  one-way — there is no un-deleting a token from storage. So a rejection that arrives after a newer
  answer has already been acted on is dropped. The cost of being wrong that way is bounded to a
  delay: if the token really is dead, the next trigger's read is rejected too, with nothing newer
  behind it, and the invalidation happens then. The cost of the opposite choice is destroying a
  credential that has just been proven good.
- **One shared counter for successes and failures** (`ownProfileApplied` is "the newest answer that
  was acted on", of either kind), because the two kinds of answer are evidence about the same
  question and ordering them separately would let a stale failure overtake a fresh success.

The existing [`recoverFromCredentialFailure`](../../../src/web/src/session.ts) cannot be reused
as-is: its first guard is `if (!readingWithToken || …) return undefined`
([`session.ts:145`](../../../src/web/src/session.ts)) — it was written for failures of the **page
reader**, and on a secret target `readingWithToken` is false. So it gains a parameter naming which
credential failed:

```ts
const recoverFromCredentialFailure = (e: unknown, failed: "page" | "identity" = "page") => …
```

- **`failed: "page"`** — unchanged in every respect. Existing callers
  ([`session.ts:335`](../../../src/web/src/session.ts) in the refresh loop,
  [`:397`](../../../src/web/src/session.ts) in `retryLobbyData`) pass nothing and behave exactly as
  today.
- **`failed: "identity"` while the page **is** reading with that same token** (`readingWithToken` —
  an id target with a usable identity): it *is* the page credential, so this falls through to the
  existing behaviour: invalidate, then reload with the stored secret or settle at `no-credential`.
  One rule, not two, for one dead token. The ownership guard still runs **first**, in the
  own-profile handler, before `recoverFromCredentialFailure` is called at all — otherwise a stale
  rejection could send a freshly rejoined session back through a recovery it has no reason to make.
- **`failed: "identity"` while the page reads with something else** (a secret target, the only case
  that can reach here): a **sibling rule**, and the page is never reloaded — it is reading perfectly
  well. It runs only once the ownership guard above has passed, and then:
  - `invalidateIdentity(storage, weaveId)` and report its `WriteResult` to `onWrite` — the same
    write the load already performs for the twin case of a stored identity the Weave does not know
    ([`session.ts:548-555`](../../../src/web/src/session.ts)): `token`, `participantId` and `name`
    deleted, `identity: "invalid"` set, `secret`, `title`, `archived` and `lastOpenedAt` kept;
  - `ownProfile = undefined` and `set({ me: undefined, readOnlyReason: "secret-fallback" })`, which
    is the state `WeaveView` already renders as *"Your identity in this Weave is no longer valid —
    you are reading with the Weave link"* with a **Join** button
    ([`WeaveView.tsx:92, 108-113`](../../../src/web/src/components/WeaveView.tsx)). No new UI.
  - **The stream, the generation and the page read are untouched.** Nothing is retired, because
    nothing that is reading has failed; a `doLoad()` here would throw away a healthy page and
    re-fetch its whole history for no reason.
  - **"One fallback per identity" still holds.** The page path's `retriedWithSecret` latch is not
    consumed by this branch — it is about the page reader — and this branch cannot loop anyway: it
    clears `me`, and the own-profile read requires `me`, so it cannot fire again until a join
    creates a new identity (which resets `retriedWithSecret` itself,
    [`session.ts:644`](../../../src/web/src/session.ts)).
- **The listener count needs none of this.** It is read with the **page reader**, so a `401`/`403`
  from it *is* a page-credential failure and goes through `recoverFromCredentialFailure(e)`
  unchanged — exactly as the requests board's read already does
  ([`session.ts:397`](../../../src/web/src/session.ts)).

Otherwise the read is non-fatal: it never fails a load or a refresh. On the very first load a
transient failure leaves the cache `undefined`, and the Offer form is simply not offered until a
later read succeeds — the honest rendering, since the form needs the model list to submit at all.

`RequestsPanel` is **unchanged**. It still reads `me.capabilities`; the difference is only where the
session got it.

The event payload could have been used instead — `participant.capabilities_changed` carries the
whole profile ([`profile.ts:66-67`](../../../src/core/src/lobby/profile.ts)) — and it is deliberately
not: one source of truth for "my profile" is worth one small request, and a client that trusted the
payload would be the only reader in the repo that did.

## 4. REST and client

### 4.1 The route

```
GET /api/lobby/listeners
    ?q=<string>
    &filter=<json>            { models?: [{ model, effort? }], tools?: [], runtime?, serves? }
    &sort=name|owner|joined
    &dir=asc|desc
    &limit=<0..1000>
    &cursor=<opaque>
    &facets=false            omitted or anything else → facets are computed
auth: requireActor  →  core.listListeners  →  resolveInLobby  →  assertCanRead(actor, lobbyId)
200 → { total, matched, listeners: [{ participant, capabilities }], nextCursor?, facets? }
```

In [`routes/lobby.ts`](../../../src/server/src/routes/lobby.ts), beside `GET /agents`, and shaped
exactly like it: parse, hand over, let core decide.

```ts
r.get("/listeners", async (c) => {
  const actor = await requireActor(c, core);
  const raw = c.req.query("filter");
  let filter: unknown = {};
  if (raw !== undefined && raw !== "") {
    try { filter = JSON.parse(raw); } catch { throw errors.validation("filter must be JSON"); }
  }
  return c.json(await core.listListeners(actor, {
    ...(filter as object),
    q: c.req.query("q"), sort: c.req.query("sort"), dir: c.req.query("dir"),
    limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
    cursor: c.req.query("cursor"),
    // The one boolean in the query string. `?facets=false` is the only way to turn them off;
    // everything else, including absence, leaves core's default alone.
    facets: c.req.query("facets") === "false" ? false : undefined,
  } as ListenersQuery));
});
```

**`/listeners` before `/agents` or after?** Neither shadows the other — Hono matches on the literal
segment and the two are distinct — so registration order is free, as `app.ts` already notes for
`/api/guidelines` and `/api/weaves` ([`app.ts:59-63`](../../../src/server/src/app.ts)).

**`Number(limit)` and `validation`.** A non-numeric `limit` becomes `NaN`, which core's
`Number.isInteger` check rejects with the same message a CLI or MCP caller would get. The adapter
deliberately does not pre-validate: the paging module's comment is explicit that adapters may
pre-validate for their own ergonomics but must not be the only place the check happens
([`paging.ts:20-22`](../../../src/core/src/paging.ts)), and here there is no ergonomic reason to.

#### Why `filter` is JSON and the rest are plain params

This is the one genuinely arguable encoding decision in the spec.

The repo does both: `/api/lobby/agents?filter=<json>`
([`routes/lobby.ts:32-41`](../../../src/server/src/routes/lobby.ts)) and
`/api/requests?status=&limit=`, `/api/weaves/:id/events?since=&thread=&limit=`
([`client.ts:49-56, 134-141`](../../../src/client/src/client.ts)).

Repeated plain params (`&model=opus-5&model=sonnet-5&tool=shell`) read better in an address bar, and
the address bar matters here because this query string **is** the page's URL (§5.4). But one value
in this query is a **pair** — a model with an optional effort — and every delimiter-based encoding
of a pair (`model=opus-5:high`, `~high`, `|high`) is ambiguous against a model name that contains
the delimiter. `ModelSpec.model` is `z.string().trim().min(1).max(100)`
([`profile.ts:20-23`](../../../src/core/src/lobby/profile.ts)): any 100 characters. An encoding
that is *usually* right is not a wire format.

**Decision: the structured half travels as `filter=<json>`, the scalar half as plain params.** It is
unambiguous, it is this route family's existing convention (one `filter` parameter, parsed by the
adapter, validated by core), and `q`, `sort`, `dir`, `limit` and `cursor` — the values a human
actually edits by hand — stay readable. The cost is a percent-encoded JSON blob in the page's URL
when a filter is active, which is ugly and still copy-pasteable. Confirmed by Paw (§12.4).

#### The second route: my own Lobby participant

```
GET /api/lobby/participants/me
auth: requireActor  →  core.getMyLobbyParticipant  →  resolveInLobby  →  assertParticipantOf(actor, lobbyId)
200 → PublicParticipant      (with `capabilities`, the caller's own profile or null)
```

One line in [`routes/lobby.ts`](../../../src/server/src/routes/lobby.ts), directly above the `PUT`
it is the read half of:

```ts
r.get("/participants/me", async (c) => c.json(await core.getMyLobbyParticipant(await requireActor(c, core))));
```

It is deliberately **not** `GET /participants/me/capabilities`: the answer is the participant, which
is what `PUT …/capabilities` already returns
([`routes/lobby.ts:25-30`](../../../src/server/src/routes/lobby.ts),
[`client.ts:115-117`](../../../src/client/src/client.ts)), so the two halves of the surface speak
the same shape. Hono matches `/participants/me` and `/participants/me/capabilities` as distinct
paths, so no ordering question arises.

Its auth differs from `/listeners` in exactly one row, and the difference is the point:

| Credential | `/listeners` | `/participants/me` |
| --- | --- | --- |
| Lobby participant token | 200 | 200 |
| agent key that joined the Lobby | 200 | 200 (through `resolveInLobby`) |
| Lobby's own Weave secret | 200 | **403** — a secret is not a participant and owns no profile |
| instance keeper token | 200 | **403** — same |
| a credential for another Weave | 403 | 403 |
| absent / unknown | 401 | 401 |
| a token whose participant row is gone | 401 (from `resolveCredential`) | 401 |
| before the Lobby exists | 404 | 404 |

The client gains the mirror:

```ts
/** This client's own Lobby participant, profile included — `getWeave` carries none in the Lobby. */
getMyLobbyParticipant(): Promise<Participant> {
  return this.call("GET", "/api/lobby/participants/me");
}
```

**No MCP tool and no CLI command** for it: an agent reads its own profile from `set_capabilities`'
answer or finds itself in `find_agents`, and adding surfaces is out of scope (§1). The route exists
because the **web** needs it and because it is the honest place for the question.

### 4.2 Auth matrix

For `GET /api/lobby/listeners` (the second route's matrix is in §4.1):

| Credential | Result |
| --- | --- |
| Lobby participant token | 200 |
| Lobby's own Weave secret | 200 — `{ kind: "secret", weaveId: lobbyId }` passes `assertCanRead` |
| instance keeper token | 200 — `assertCanRead` returns early for a keeper |
| agent key of an agent that joined the Lobby | 200 — `resolveInLobby` maps it to its participant |
| agent key of an agent that has not joined | 403 `forbidden` ("Join the Weave first") |
| a token or secret for another Weave | 403 `forbidden` ("Credential does not belong to this Weave") |
| absent | 401 `invalid_token` (`requireActor`) |
| unknown | 401 `invalid_token` (`resolveCredential`) |
| any of the above, before the Lobby exists | 404 `weave_not_found` |

Identical, row for row, to `GET /api/lobby/agents`. **No new error code** — everything maps onto the
fixed set in [`errors.ts`](../../../src/core/src/errors.ts), so CONTRIBUTING's "adding a code means
adding it to the union and to the server map" does not apply.

### 4.3 Client

[`client.ts`](../../../src/client/src/client.ts), beside `findAgents`:

```ts
/** The Lobby's listeners — every participant carrying a capability profile — searched, filtered,
 *  sorted and paged, with facet counts for the four filters. `{ limit: 0, facets: false }` asks for
 *  the counts alone, which is how a page shows "Listeners (N)" without downloading a profile. */
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
```

The types are mirrored by hand into [`client/src/types.ts`](../../../src/client/src/types.ts) —
`Listener`, `ListenersQuery`, `ListenersSort`, `ServesKind`, `FacetValue`, `ModelFacet`,
`ListenersFacets`, `ListenersPage` — as `Profile`, `FoundAgent` and `AgentFilter` already are
([`types.ts:50-71`](../../../src/client/src/types.ts)). The client package deliberately does not
import from core (CONTRIBUTING §"Layering": adapters carry types only), and the round-trip test of
§8 is what keeps the mirror honest.

## 5. Web

### 5.1 The Lobby sidebar

> **Amended 2026-09-20** by
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§8** (with §2's amendment table). The count, its four states and its Lobby gate below are
> **unchanged**. What is gone is the line's link-or-button pair: it is **always a button** now, and
> it toggles a view rather than opening a page, carrying `aria-current` while the directory is the
> main area. `openListenersInPlace` and its whole in-place argument are deleted.

`ProfileCards` is deleted from [`WeaveView`](../../../src/web/src/components/WeaveView.tsx)'s
sidebar and replaced by `ListenersLink` — same file position, same Lobby gate
(`state.lobby?.weaveId === state.weave?.id`, which is id-based and needs no change):

```
Listeners (1,204)          ← a link to /lobby/listeners
```

- **Where N comes from.** `SessionState` gains `listenerCount?: number`, filled by
  `reader.listListeners({ limit: 0, facets: false })` — one `count(*)` (§2.8), no rows, no facet
  pass. It is read with the **page's own reader**, so it inherits the credential choice (token, or
  the secret fallback) like every other read on the page.
- **Four triggers, because the load is not the refresh.** This is the correction a review caught:
  `doLoad` does **not** call `refreshInfo` — it issues its own `getWeave`/guidelines/discovery
  `Promise.all` ([`session.ts:515-519`](../../../src/web/src/session.ts)) — so a count wired only
  into the refresh would never appear on a Lobby where nothing happens to be changing. The count is
  read on:

  | Trigger | Where | Why it is needed |
  | --- | --- | --- |
  | **initial load**, once the discovery in that same `Promise.all` says this Weave is the Lobby (`discovery.settled && discovery.lobby?.weaveId === weaveId`, the condition already written at [`session.ts:530`](../../../src/web/src/session.ts)) | after the ready `set` ([`session.ts:571-580`](../../../src/web/src/session.ts)), beside the existing `retryLobbyData` nudge | otherwise the number never appears at all |
  | **late discovery recovery** | in `retryLobbyData`, where `lobbyKnown` becomes true and `onLobby()` turns true ([`session.ts:376-392`](../../../src/web/src/session.ts)) | a page whose `getLobby()` failed on load learns it is the Lobby here, and nothing else would ever ask |
  | **every refresh** | `refreshInfo`, when `onLobby()` ([`session.ts:251-262`](../../../src/web/src/session.ts)) | keeps the number honest as people join and leave |
  | **`participant.capabilities_changed`** | already schedules a refresh ([`session.ts:440-445`](../../../src/web/src/session.ts)) — so it is covered by the row above, with no new wiring | the one event that changes the count without changing the participant list |

- **Generation-guarded *and* sequenced.** The count's `set` happens only after
  `disposed || myGeneration !== generation` is re-checked — the pattern at
  [`session.ts:268`](../../../src/web/src/session.ts) (refresh), `:375, :389` (the retry loop) and
  `:508, :520, :533` (the load's `stale()`) — so a count landing after a §2.6 recovery publishes
  nothing. But the guard alone is **not enough**, for the same reason it is not enough for the
  profile (§3.3): three call sites means two count reads can be in flight inside one generation, and
  an older, larger number landing last would overwrite a newer, smaller one. So the count carries
  the same two-integer rule:

  ```ts
  let countSeq = 0, countApplied = 0;                       // beside ownProfileSeq / ownProfileApplied
  const n = ++countSeq;                                     // when the read starts
  …
  if (disposed || myGeneration !== generation) return;      // generation
  if (n <= countApplied) return;                            // sequencing
  countApplied = n; set({ listenerCount: page.total });
  ```

  It needs **no identity check**: the count is a property of the Lobby, not of the caller, so it
  stays valid across a join or a rejoin. (The profile cache is the opposite, which is why only it is
  keyed to an identity.)
- **Non-fatal everywhere.** It never joins a `Promise.all` that can reject the load: it is its own
  call, its rejection is caught, the previous number is kept, and the next refresh retries it. A
  failed count costs neither the load, nor the refresh, nor the requests board. On failure with no
  previous number the line reads **Listeners** with a quiet "count unavailable" beside it — never
  "Listeners (0)". The discipline is already written into the code next door — *"a cell with a
  credential and no answer yet is loading, not empty"*
  ([`LobbySummary.tsx:78`](../../../src/web/src/components/main/LobbySummary.tsx)) — and this spec
  makes it a rule rather than a comment: **an error, and a pending answer, never render as a zero or
  as "nobody".**
- **…with one exception to "non-fatal": a rejected credential.** The count is read with the **page
  reader**, so a `401`/`403` from it means the credential the whole page is reading with is dead.
  That goes through the existing `recoverFromCredentialFailure(e)` unchanged — invalidate, fall back
  to the stored secret, or settle at `no-credential` — exactly as the requests board's read already
  does ([`session.ts:397`](../../../src/web/src/session.ts)). Everything else (network, 5xx) keeps
  the last number. The own-profile read is the one that needed a new rule, because it alone uses a
  credential the page does not (§3.3).
- **Loading.** Before the first answer the line reads **Listeners** with no number, not
  "Listeners (0)".
- **The own-profile read rides the same triggers** (§3.3): same three call sites, same generation
  guard, same non-fatal rule — but with `me`'s token rather than the page reader, only when `me`
  exists, and additionally on a `participant.capabilities_changed` that names `me`.
- **The main page's Lobby summary gets its "N listeners" the same way.**
  [`LobbySummary`](../../../src/web/src/components/main/LobbySummary.tsx) counts listeners by
  filtering `getWeave`'s participants on `capabilities !== null` (line 55), which stops working in
  §3. It already reads with the stored Lobby token and already makes two bounded calls there; the
  filter becomes a third, `listListeners({ limit: 0, facets: false }).total`, folded into the same
  `Promise.all`. Its "loading, not empty" rule and its one error line are unchanged.
  > **Amendment, 2026-09-20 (as built).** The third call is **not** folded into the rejecting
  > `Promise.all`; it is caught on its own. `Promise.all` says "all of these or none", which is right
  > for the queries inside one `listListeners` call and wrong for three independent page cells: with
  > the fold, a failed listener count would have taken the participant and open-request counts down
  > with it. As built, a failed count removes its own `<li>` and nothing else — no zero, no error
  > line — and the other two counts stand.
- **In place for a memory-only session.** The link follows the same rule the header's home link
  follows on the smoke-test-5 fix branch: when this page's credentials would not survive leaving the
  JS context — `storage.isPending(weaveKey(weaveId))` **or** a degraded `PersistenceNotice` — the
  line is a **button** calling a new `openListenersInPlace()` rather than an `<a>`, because an
  anchor can be middle-clicked or opened in a new tab and either one is the full page load that
  drops the only copy of the credential. Both halves are read on every render, so a later durable
  write puts the ordinary link back.

### 5.2 The route

> **Superseded 2026-09-20** by
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§4** (with §2's amendment table). Read §4 instead of the table below. `Route` loses its
> `listeners` kind and `RouteDeps` its third mirror; `/lobby/listeners` becomes the **Lobby** route
> carrying an initial view (`Route.lobby.view`), and `App` renders one `<WeaveRoute lobbyRoute/>` for
> both of the Lobby's addresses. `ListenersRoute.tsx` is deleted whole. The **server's** two static
> paths and `main.ts`'s boot line are exactly as this section states and did not change — that is
> what makes the deep link keep working, and `static.test.ts` needed no edit.

| Where | Change |
| --- | --- |
| [`app.tsx`](../../../src/web/src/app.tsx) `Route` | `+ { kind: "listeners" }` |
| `routeOf` | `+ if (pathname === "/lobby/listeners" \|\| pathname === "/lobby/listeners/") return { kind: "listeners" }` — **before** the `/lobby` test, which is an exact-match comparison and therefore does not shadow it, but the order is what a reader checks first |
| `App` | `+ case "listeners": return <ListenersRoute {...deps} />` |
| `RouteDeps` | `+ openListenersInPlace: () => void` — the third mirror of `openInPlace`, `setRoute({ kind: "listeners" })` |
| [`app.ts`](../../../src/server/src/app.ts) | the enumerated list gains `"/lobby/listeners"` and `"/lobby/listeners/"` — **nine** paths, still no catch-all |
| [`main.ts`](../../../src/server/src/main.ts) | the "web UI not built" boot line names the new path with the others |

Still **no router library** (ARCHITECTURE §9), still no SPA fallback: an unknown path keeps the
API's JSON `{ code: "not_found" }`, which `static.test.ts` asserts.

### 5.3 The page

> **Amended 2026-09-20, in three places**, by
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§3.3 and §9** (with §2's amendment table). Everything else in this section — search with its
> debounce, the four facet controls, sort, the grid, **Show more**, and the empty / loading / error
> states with "an error is never an empty state" — stands **verbatim**. The three:
> 1. **The page header is deleted** — the wordmark, the `<h1>Listeners</h1>` and **Back to the
>    Lobby** all go. The directory is a region of the Lobby page under an `<h2>Listeners</h2>`, and
>    the way back to the Thread is the sidebar. `ListenersPage` takes `{ session }` and nothing else.
> 2. **The counts line is reworded** (new spec §9, CR2). Wherever this section or the diagram below
>    shows `Showing 50 of 87 matches (1,204 listeners)`, the line now reads
>    **`Showing 50 of 87 matches (out of 1,204 listeners)`** — "out of" added, so both relations are
>    named in words. The collapsed form when `matched === total` is unchanged
>    (`Showing 50 of 1,204 listeners`), both stay locale-formatted, and a failed query or an unknown
>    number still renders **nothing** there rather than a zero. The same rewording applies to the two
>    earlier occurrences in this document (§1's success scenario and §2.6) and to the plan's Task
>    note, none of which is rewritten beyond this remark.
> 3. **Clear filters** is **always rendered**, beside the sort controls, `disabled` only while
>    everything is at its default, and it now resets **`sort` and `dir`** along with the rest — this
>    section keeps the sort, and the new spec overrides it.

`src/web/src/components/listeners/ListenersPage.tsx` (plus small siblings: `FilterChips.tsx`,
`SearchBox.tsx`), mounted by `ListenersRoute.tsx` which owns the credential and the query, the way
`WeaveRoute` owns the session.

```
┌────────────────────────────────────────────────────────────────┐
│ Loom   Listeners                              ← Back to the Lobby│
├────────────────────────────────────────────────────────────────┤
│ [ search name or owner……………… ]   sort: [name ▾] [asc ▾]         │
│ models  [opus-5 87] [sonnet-5 40] [fable-2 12] …  20 most common │
│   └ effort (opus-5): [high 61] [medium 26]                      │
│ tools   [shell 120] [github 74] …                               │
│ runtime [node 900] [python 210] …                               │
│ serves  ( ) anyone 300   (•) owner 870   ( ) list 34            │
├────────────────────────────────────────────────────────────────┤
│ Showing 50 of 87 matches (1,204 listeners)                      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                          │
│ │ProfileCard│ │ProfileCard│ │ProfileCard│   … a responsive grid   │
│ └──────────┘ └──────────┘ └──────────┘                          │
│                     [ Show more ]                               │
└────────────────────────────────────────────────────────────────┘
```

- **Header**: the `Loom` wordmark home (the same component behaviour as the Weave header on the fix
  branch — a link, or a button when credentials are memory-only), the title, and **Back to the
  Lobby**, which is a link to `/lobby` or, in place, `openInPlace(lobbyId)` under the same rule.
- **Search**: one text input, **250 ms debounce**, trimmed. A keystroke never fires a request; the
  debounce timer is cleared on unmount. The input is never disabled while a request is in flight —
  typing must not stutter — and an answer that arrives for a superseded query is dropped by a
  generation counter, the same discipline the session uses
  ([`session.ts:257, 264`](../../../src/web/src/session.ts)).
- **Four filter controls, fed by the facets**:
  - **models** — multi-select chips, each with its count; selecting one reveals its **efforts** as a
    second, optional single-select row beneath it. Selecting `high` turns that alternative into
    `{ model: "opus-5", effort: "high" }`; deselecting it goes back to `{ model: "opus-5" }`.
    Selecting several models is any-of, which the chip row says in words ("any of these"). The
    effort row shows the model's **top 10** and says "10 most common" when `moreEfforts` is set
    (§2.7) — `effort` is free text, so that row is bounded exactly like the outer ones.
  - **tools** — multi-select chips with counts; **all-of**, which the row says too ("all of these").
    The difference between the two rows' semantics is the single most confusable thing on this page
    and it is stated on screen rather than implied by chip colour.
  - **runtime** — single-select chips with counts (equality).
  - **serves** — a three-way choice: **anyone / serves their owner / a named list**, plus an
    implicit "any", which is the cleared state. Counts beside each.
  - Every control has a **Clear** affordance, and the header has **Clear filters**.
  - **A selected chip whose count is `0` is rendered selected and empty**, never hidden (§2.7): it
    is the filter that produced the empty result, so it has to stay on screen to be unclicked.
    Visually distinct from an unselected chip with a count, and the only chip that can show `0`.
- **Sort**: a `<select>` for the key and one for the direction. Changing either resets the cursor.
- **The counts line**: `Showing {listeners.length} of {matched} matches ({total} listeners)`, with
  `matched === total` collapsing to `Showing 50 of 1,204 listeners`. Numbers are locale-formatted
  with thousands separators.
- **The grid**: the existing [`ProfileCard`](../../../src/web/src/components/ProfileCard.tsx),
  unchanged, in a responsive grid rather than a sidebar column. Nothing is clickable inside a card
  (§1, non-goals).
- **Show more**: sends `cursor = nextCursor` and **appends**. It never re-sorts or re-renders the
  rows above it. Hidden when `nextCursor` is absent. A failure leaves the rows that are there, shows
  the error beside the button and offers a retry.
- **Empty state**: "No listener matches these filters." plus **Clear filters**. Distinguished from
  the genuinely empty Lobby: with `total === 0` it reads "Nobody has declared a profile yet." — the
  sentence `ProfileCards` uses today ([`ProfileCard.tsx:44`](../../../src/web/src/components/ProfileCard.tsx)).
- **Loading**: the first load renders "Loading…"; a refresh caused by a control change keeps the
  current rows on screen, dims them and shows a small spinner in the counts line. The grid does not
  blank between queries.
- **Errors never render as "no listeners".** A failed query renders the server's message in an
  error line **above** whatever rows are still on screen, and the counts line says nothing rather
  than saying zero. The one rule this page must not break.

### 5.4 The query string, and which history API touches it

> **Amended 2026-09-20** by
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§4** — §4.2, §4.3 and §4.5 (with §2's amendment table). The **codec stands word for word**: the
> same four keys, the same both-directions rule, the same "nothing is dropped silently". What
> changes is the rule around it. It is now one promise — **never `pushState` unless leaving is
> safe** — under which the page's own query string may be rewritten with `replaceState` **whenever
> the path is `/lobby/listeners`**, whatever `leavingIsSafe` says, because replacing the path you are
> already on adds no entry and takes away no address (§4.5). `writeSearch` **loses its `inPlace`
> parameter** and gains nothing in its place (§4.3). And `pushState` becomes legal — for the **view**
> change alone, made in `WeaveMount`, only when the requested view actually changed, the current path
> is one of the Lobby's, and `leavingIsSafe` holds at the moment the handler runs (§4.2). Back and
> Forward are heard by one `popstate` listener, which re-seeds the directory from the entry it landed
> on (§4.4).

The search, the four filters and the sort live in the query string, in the same encoding the REST
call uses (§4.1): `?q=…&filter=<json>&sort=…&dir=…`. `limit` and `cursor` do **not** — a link should
reproduce a *view*, not a scroll position, and pasting someone else's cursor is meaningless.

**Both directions**:

- **On mount**, `location.search` is parsed into the control state. Anything invalid — an unknown
  `sort`, a `filter` that is not JSON, a `q` over 100 characters — is **ignored with a one-line
  notice** ("part of this link was not understood") rather than rendering an error page: a
  hand-edited or truncated link should still show the directory.
- **On a control change**, the URL is rewritten with **`history.replaceState`**, and never
  `pushState`.

**Is `replaceState` compatible with the Global Constraint?** The constraint, as the plan states it,
is: *"after a join or a creation whose credential write returned `"memory"`, do not navigate —
render the destination in place and leave the URL alone (no `history.pushState`)"*
([`plans/2026-09-17-loom-web-main-page.md:90`](../plans/2026-09-17-loom-web-main-page.md)), and the
spec's §3.1 gives the reason: *a pushed `/lobby` would be an address this browser cannot honour*.
The ban is about **changing which page the URL names** while the credentials to load that page live
only in memory. Updating the **query string of the page you are already on** names the same page.

So the rule here is precise, and narrower than "no history API":

> The listeners page updates its own query string with `history.replaceState` **only when
> `location.pathname` is already `/lobby/listeners`** — i.e. when the page was reached by a real
> navigation. When it is rendered **in place** (`openListenersInPlace`, because the Lobby credential
> is memory-only), the URL is left entirely alone, exactly as every other in-place view leaves it.

- `replaceState`, not `pushState`, so ten keystrokes' worth of filtering do not become ten back-button
  steps. The back button leaves the directory, which is what a human means by it here.
- In the in-place case the filters still work — they are component state — and the address bar
  simply does not advertise a view this browser could not load again. The page says so in the
  existing not-persisting bar (§5.5), which is already on screen in exactly that case.
- The existing test that asserts `pushState` and `replaceState` were both never called is scoped to
  a **join on `/lobby` with blocked storage** ([`main-page.test.tsx:492-500`](../../../src/web/test/main-page.test.tsx)) —
  a different page, a different action, and the in-place rule above keeps it true.
- Consequence to accept: on a memory-only browser a filtered view cannot be copied as a link. That
  browser cannot reload any page of this app without losing its identity, so there is nothing to
  copy the link *to*. Recorded as an assumption (§12.7).

### 5.5 Credentials, live updates and failure

> **Superseded 2026-09-20** by
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§6** (with §2's amendment table). Read §6 instead of the credential rules below. The route's own
> resolver, its join form, its 401 rule and its refused-secret terminal state are all **deleted**:
> the **session** owns all four, exactly as it already did for `/lobby`. What survives is the
> principle that a recovery is **authorised by the view** — the only thing that knows whether the
> failed query is still wanted — which is why the session exposes **two** calls rather than one:
> `listListeners(query)` returns `{ issue, page }` and performs no side effect on either outcome, and
> `reportCredentialFailure(e, issue)` is called by the view only after its own liveness guard and is
> refused unless `issue.generation` is still the session's.
>
> **Unchanged:** the "list changed" hint, the not-persisting bar, and all three of this section's own
> later amendments — query-string validation, **Show more**'s `facets: false`, and the refused
> cursor.

- **Getting a credential.** Exactly as `/lobby`: resolve the Lobby's id with the public
  `client.getLobby()`, then read this browser's entry for it and choose a reader with
  [`readerFor`](../../../src/web/src/weaves-store.ts) — the participant token when the identity is
  usable, the stored Weave secret when it is not. The app's one storage instance is passed in
  through `RouteDeps`, as everywhere (main-page spec §2.4a).
- **No credential at all** → the same **Join the Lobby** form the Lobby route shows
  ([`WeaveRoute.tsx:112-122`](../../../src/web/src/components/WeaveRoute.tsx)), reusing
  `JoinLobbyForm` with its existing `onJoined` / `onJoinedInPlace` pair. On success the page reloads
  its first query in place — there is nowhere to navigate to, this route *is* the destination, which
  is the argument `WeaveRoute` already makes for itself.
- **`weave_not_found` from `getLobby()`** → "This instance has no Lobby yet.", with a link to `/`,
  word for word as `LobbyRoute` says it.
- **401 / 403 on a listeners query** → the **same identity-invalidation rule the session applies**
  (main-page spec §2.6): `isCredentialFailure(e)` → `invalidateIdentity(storage, lobbyId)` (which
  deletes `token`/`participantId`/`name`, keeps `secret`, and reports its `WriteResult` to the
  notice), then retry once with the stored secret if there is one, else render the join form with
  "Your identity in the Lobby is no longer valid."
  Those helpers are already exported and already used from outside a session — `MyWeaves` calls
  them per row ([`MyWeaves.tsx`](../../../src/web/src/components/main/MyWeaves.tsx)) — so this is
  the established path, not a new one. A **lighter** rule was considered and rejected: leaving the
  dead token in storage would simply move the failure to the next `/lobby` load, and the page next
  door would then have to explain a credential this page already proved dead.
  > **Amendment, 2026-09-20 (as built).** The rule above has a **terminal state** the spec did not
  > script: "retry once with the stored secret" must mean *once*. As first written, a 401 on the
  > retry invalidated again and bumped the reload key again, and a Lobby secret the server refuses
  > looped for ever. As built, the retry is latched: if the stored secret is itself refused, the page
  > stops at the join form saying **"The Lobby refused the link this browser holds."** — the wording
  > is the implementation's; the spec scripts only the dead-identity line — and it carries the same
  > way home the other forks carry.
- **Amendment, 2026-09-20 (as built): the query string is validated against core's bounds, not
  sniffed.** §5.4's "anything invalid is ignored with a one-line notice" is implemented as full
  validation — the page refuses in the browser exactly what core would refuse on the wire — plus
  three rules found in implementation. **Unknown keys are reported**, not ignored: core rejects a
  key its query does not have, so `{"owner":"ada"}` is asking for something this page cannot do, and
  honouring the half it understood would answer a wider question than the link asked. **A NUL is
  dropped and reported** rather than forwarded, for the reason §2.3's amendment gives: forwarding
  one turns a hand-edited link into a 500. (Amended 2026-09-20, PR #20 review round 1: this too was
  first built as the whole C0 range. A tab or a newline inside a value is something core accepts and
  the directory hands out on a facet chip, so a link carrying one is very often a link this page
  wrote; dropping it lost the filter *and* accused a good link of not being understood.) And the **`limit`/`cursor` pair is
  deliberately not part of this encoding at all** — a link reproduces a view, not a page position —
  so a hand-typed one is ignored without a notice (a row in KNOWN-ISSUES).
- **Amendment, 2026-09-20 (as built): Show more sends `facets: false`, and forgets a refused
  cursor.** The facets describe the filters, which appending cannot change, and the facet pass is
  the expensive half of the query (§6) — so the second and later pages skip it. And a Show more the
  server refuses with `validation` **clears** the cursor it was refused, so the next control change
  works instead of re-sending a cursor the server has already rejected (§7's "a cursor the server
  refuses must not wedge the page").
- **Live updates.** The directory opens **no WebSocket**. It has no session, and a stream that
  reshuffled a grid under a reading human is the thing Paw's design explicitly rules out. Instead:
  every query the page makes returns `total`, and when that `total` differs from the one the first
  page came back with, the page shows a quiet line — *"the list has changed since you loaded it —
  reload"* — beside the counts. No timer, no poll, no socket. **A directory left open on screen
  therefore learns nothing new until the human does something**, which is deliberate and is the
  cost of never reshuffling. The count that *does* move live is the sidebar's, on the Lobby page
  next door, driven by `participant.capabilities_changed` (§5.1).
- **The not-persisting notice** renders on this page as on every other: `PersistenceBar` above the
  content, from the one page-scoped `PersistenceNotice` that `App` hands every route (main-page spec
  §6).

## 6. Security review

Against `docs/SECURITY.md`. Nothing moves the line §4a draws; one thing changes in practice and is
named out loud.

**What the directory exposes, and to whom.** Every profile in it is already readable, in full, by
exactly the same set of credentials: `find_agents` with an empty filter returns every Lobby
participant carrying a profile, with the profile
([`profile.ts:81-95`](../../../src/core/src/lobby/profile.ts)), and until this change `getWeave` on
the Lobby returned all of them to anyone who could read the Lobby at all. The population is
unchanged, the authorisation is unchanged (`assertCanRead`, §2.2, §4.2), and **no new anonymous
read** is created — an unauthenticated caller gets 401 exactly as it does from `/api/lobby/agents`.

What changes is the same thing the main page changed about the join: **searchability**. SECURITY §4a
already says it for discoverability — *"the difference between 'someone who reads the docs can join
your Lobby' and 'anyone who opens the URL can'"* — and the sentence to add is its sibling: a Lobby
participant could always read every profile; now they can search them by owner, filter them by
tooling, and sort them by when people arrived. On an instance where `owner` is a real person's
handle (it is self-declared, ADR 0001), the directory is a roster of who works for whom and with
what. Nothing in a profile should be a secret — §4a says that too — and this is the change that
makes the advice load-bearing rather than theoretical.

**`q` is user input that reaches SQL `ILIKE`.** Two separate defences, and both are required
(§2.8): the value travels as a **bind parameter** (drizzle `sql` template, never concatenation), and
its `%`, `_` and `\` are **escaped** so a search cannot become a wildcard scan. The second is not a
security control on its own — it is correctness — but an un-escaped `%%%%%` against a text column is
also the cheapest way to make this endpoint expensive, which brings us to:

**Cost, and the absence of rate limiting.** SECURITY §9.1 records that there is no rate limiting
anywhere. This endpoint is the most expensive read a Lobby participant can issue: seven queries, two
of them unnesting jsonb arrays (§2.8). It is bounded — `limit <= 1000`, every facet ranked to 21
rows (plus at most one per selected value, which the caller's own filter bounds at 20 models and 50
tools), the
predicate is index-backed — and it is only reachable *with* a Lobby credential, which is the same
bar as `find_agents` (which scans every profile in memory today, and is arguably worse). No new
mitigation is proposed here; naming it is what this section is for, and it strengthens the existing
§9.1 row rather than adding one.

**`GET /api/lobby/participants/me` exposes nothing new.** It answers the caller their **own**
profile, addressed by their own credential — no id in the path, nothing to enumerate — and it is
strictly narrower than the surface beside it: `assertParticipantOf` refuses the Lobby secret and an
instance keeper (§4.1), where `find_agents` and `listListeners` admit both. The profile it returns
was already readable by that caller through `find_agents`, and the caller wrote it in the first
place.

**The query string carries no secret.** `q`, `filter`, `sort`, `dir` — none of them is a credential,
and the page's own credential is a stored token sent in an `Authorization` header, never in a URL.
`/lobby/listeners` carries no id, let alone a secret, so SECURITY §9.9's narrowing ("`/w/<secret>`
links only") stays true.

**XSS: unchanged.** Every value on the page is Preact-rendered and therefore escaped; profiles are
rendered by the existing `ProfileCard`, which emits text nodes only. No `dangerouslySetInnerHTML`,
and a profile's unknown keys are not rendered at all. Facet values are listener-supplied strings and
render as chip labels — text, through JSX, with the same guarantee.

**No new log line carries a profile.** Nothing server-side logs the query or its result; the request
path may appear in an access log and carries only the filter.

## 7. State and error handling

> **Unchanged, with one correction, 2026-09-20** —
> [2026-09-20-loom-lobby-listeners-view-design.md](2026-09-20-loom-lobby-listeners-view-design.md)
> **§2** records this section as *unchanged* except that the page's "**four** independent cells"
> below are now **three**: the Lobby pointer and the credential are the **session's**, not the
> view's, so the page holds only the current query's answer and the "list changed" hint. Every other
> rule here — no new error code, a failure in one cell never blanking another, and above all **an
> error is never an empty state** — stands exactly as written and governs the view too.

- **No new error code.** `validation`, `invalid_token`, `forbidden`, `weave_not_found` cover
  everything (§4.2).
- **The page holds four independent cells**: the Lobby pointer, the credential, the current query's
  answer, and the "list changed" hint. A failure in one never blanks another — the same discipline
  the main page's four cells follow.
- **An error is never an empty state.** Stated in §5.3 and repeated here because it is the rule a
  directory is most likely to break: `matched === 0` renders "no matches"; a rejected query renders
  the server's message and keeps whatever rows are on screen; a query still in flight renders the
  rows it has, or "Loading…", never "no listeners".
- **A superseded answer is dropped, not rendered.** One generation counter per page; a response
  whose generation has been retired sets nothing. Without it, a slow unfiltered query landing after
  a fast filtered one repopulates the grid with the wrong rows.
- **"Show more" failures are local**: the button keeps its place, the error sits beside it, the rows
  above are untouched.
- **A storage write that did not persist** reaches the one-time notice through the same
  `PersistenceNotice` every other page uses; the only write this page makes is the identity
  invalidation of §5.5.
- **The session's two side reads — the listener count and my own profile — are non-fatal,
  generation-guarded and *sequenced*** (§3.3, §5.1). Neither may fail a load or a refresh, neither
  may publish after its generation has been retired, each keeps its last known value on a transient
  failure and retries on the next trigger, and a count that has never arrived renders as an absent
  number rather than as zero. They are the Lobby-page counterparts of the rule above: what used to
  be one field of a snapshot is now a separate request, and a separate request is a separate failure
  that must not spread.
- **An answer is applied only if it is the newest one asked for.** Both reads start from three call
  sites and can overlap inside one generation, so each carries a request number and applies its
  answer only when it is greater than the last applied one. The generation counter answers "is this
  session still the one that asked?"; it does not answer "is this the newest answer?", and both
  questions have to be asked.
- **The profile cache belongs to an identity.** It is keyed to the participant id and token it was
  read for, applied only while `state.me` still names both, and cleared by a join, by an
  invalidation and by a new load. The count needs no such key: it describes the Lobby, not the
  caller.
- **A rejected credential is not a transient failure.** `401`/`403` from the count (read with the
  page reader) goes through the existing `recoverFromCredentialFailure`; `401`/`403` from the
  own-profile read (made with `me`'s token, which on a secret-link visit is *not* the page reader)
  invalidates the identity in storage, clears `me` and the cache, and leaves the page reading —
  `readOnlyReason: "secret-fallback"`, which `WeaveView` already renders with a **Join**
  ([`WeaveView.tsx:92, 108-113`](../../../src/web/src/components/WeaveView.tsx)). A page that is
  reading successfully is never reloaded to report that a *different* credential died.
- **A failure is owned by an identity exactly as an answer is, and the guard comes first.** The
  own-profile rejection handler checks the captured participant id, token, generation and request
  number **before** it writes to storage, reports a `WriteResult`, clears the cache or patches
  state; a mismatch is discarded silently, with no error and no retry, because it describes an
  identity this session no longer has. This is the only place in the design where a stale answer
  could do damage rather than merely be wrong — everywhere else the worst case is a value that is
  replaced on the next read, and here it is a deleted credential.
- **Core raises `validation` for a malformed cursor** and the page treats it as a query error, then
  clears its cursor so the next control change works — a cursor the server refuses must not wedge
  the page.

## 8. Testing

Per `docs/TESTING.md` and CONTRIBUTING §"Tests": test-first, **one rule per test**, real Postgres,
no database mocks. Adapter suites test wiring, not rules.

**`core` — `test/lobby-listeners.test.ts` (new)**

- Each filter alone, over a seeded Lobby: `models` any-of; `models` with an effort matching only the
  exact pair; `tools` all-of (two tools, only the listener with both); `runtime` equality; `serves`
  for each of `anyone`, `owner`, `list`.
- **`serves: "owner"` includes a profile with no `serves` key** — the `admits` default, and the one
  rule a re-implementation in SQL is most likely to lose.
- Two filters ANDed, and a filter ANDed with the search.
- Search matches a participant **name** case-insensitively; search matches an **owner**
  case-insensitively; a search matching neither returns nothing.
- A search containing `%` and `_` is a **literal** search, not a wildcard.
- Each sort in **both** directions (six tests, or one table-driven test with six rows), including
  case-insensitivity for `name` and `owner`.
- **Cursor stability when a listener joins mid-paging**: page 1 with `limit: 2`, then a new listener
  is created whose name sorts *into* page 1, then page 2 with the cursor — page 2 is the rows that
  followed, with no duplicate and no row from page 1. And the mirror: a listener that sorts after
  the cursor **does** appear.
- A **stale** cursor — the participant it names clears its profile — still returns the page after it.
- A malformed cursor, and a cursor whose `sort` disagrees with the query, are both `validation`.
- **Every sort key is non-null** (§2.5), asserted as the invariant rather than as paging behaviour:
  a listener's profile always carries a non-empty `owner` (`setCapabilities` with a profile that
  omits it is `validation`, and `findAgents`/`listListeners` never see one), and a **cleared**
  profile is not a listener — `setCapabilities(null)` removes the row from `total`, from the page
  and from every facet. That second half also pins the `capabilities IS NOT NULL` population against
  a JSON `null` ever being stored in place of a SQL `NULL`.
- **Empty filters are no filter** (§2.3, the agreement rule): `tools: []` returns every listener,
  including one whose profile has no `tools` key; `models: []` likewise; `q: "   "` likewise; and
  each of the three leaves `matched === total`.
- `limit` bounds: 0 is legal and returns no rows but real counts and facets; 1001 is `validation`;
  the default is 50; `nextCursor` is absent on the last page and on `limit: 0`.
- `facets: false` omits `facets` and changes neither `total` nor `matched`; the default computes
  them.
- `total` ignores the filters, `matched` reflects them, and neither is the page length.
- **Facets minus their own filter**: with `models: [opus-5]` selected, the `models` facet still
  reports `sonnet-5` with its count, while `tools`, `runtimes` and `serves` are computed **with**
  the models filter applied. One test per facet.
- A facet counts a **listener** once even when its profile lists the same model or tool twice.
- The top-20 rule: 25 distinct tools → 20 values and `more: true`; a **selected** tool outside the
  top 20 is present anyway.
- **The effort facet is bounded** (§2.7), against deliberately high-cardinality data: 30 listeners
  declaring 30 distinct efforts for one model → that model carries **10** efforts and
  `moreEfforts: true`; a **selected** effort outside that top 10 is present anyway; and the model's
  own `count` is the number of listeners, not the number of efforts — a listener declaring the same
  model at two efforts counts **once** for it.
- **Model ranking depends only on listener counts** (§2.8, the two-stage query): one model with 50
  distinct efforts and one with 1, plus twenty more models, and the top-20 membership and order are
  exactly the twenty with the most listeners. The regression test for ranking a grouping-set result,
  where the many-effort model's rows pushed others past the cut.
- **A selected value is in its facet even at zero** (§2.7, §2.8), one test per facet: a selected
  tool ranked outside the top 20 appears with its true count; a selected runtime eliminated by
  another filter appears with `count: 0`; the same for a selected model and for a selected effort
  inside a kept model. The zero cases are the ones a ranked query cannot produce at all.
- **The `joined` cursor is lossless** (§2.5): several listeners whose `joined_at` values differ only
  *within* one millisecond — set explicitly by SQL, since `now()` will not reliably produce them —
  paged with `limit: 1` in **both** directions, returning every listener exactly once, with no
  duplicate and no skip. This is the test that fails if the key is ever taken from
  `participant.joinedAt` (a JS `Date`, millisecond precision) instead of from the database's own
  text rendering.
- The `serves` facet always has three rows, zeros included.
- Auth: a Lobby participant, the Lobby secret and an instance keeper all succeed; a stranger's
  token is `forbidden`; no credential is `invalid_token`; an agent key that has joined succeeds
  through the facade's `resolveInLobby`.
- **The SQL and `matches` agree — as a property, over a table.** A fixture of ~20 profiles chosen to
  cover the edges (no `tools` key, empty `tools` array stored, one model with two efforts, a
  duplicated entry, `serves` absent / `"owner"` / `"anyone"` / an array, no `runtime`) × a table of
  filters (each filter alone, two ANDed, the empty forms of §2.3, a filter matching nothing). For
  every pair, the ids `listListeners` returns must equal the ids of the same rows filtered in memory
  with `matches`/`admits`. This is the drift guard for §2.4 **and** the regression test for the
  empty-array disagreement of §2.3.

**`core` — `test/weaves.test.ts` / `lobby.test.ts`**

- `getWeave` on the **Lobby** returns `capabilities: null` for **every** participant — the caller's
  own included — and still returns ids, names, kinds and roles for all of them.
- `getWeave` on **any other Weave** is unchanged (a participant there has `capabilities: null`
  anyway, so the assertion is that the Lobby rule did not leak: a Lobby listener's own row read
  through a different Weave's `getWeave` is not affected).
- `findAgents` still returns profiles — the regression guard for §3.

**`core` — `test/lobby-profile.test.ts` (`getMyLobbyParticipant`, §3.3)**

- A Lobby participant reads its own participant **with** its profile, immediately after
  `setCapabilities`, and again after a second client changed it — the answer is the row, not the
  actor's stale copy.
- A participant with no profile gets `capabilities: null` rather than an error.
- The **Lobby secret** and an **instance keeper** are `forbidden`; a credential for another Weave is
  `forbidden`; an unknown credential is `invalid_token`.
- An **agent key** that joined the Lobby reads its own participant through the facade's
  `resolveInLobby`; one that has not joined is `forbidden`.

**`core` — `test/db.test.ts` and the query plan (§2.8)**

- `participants_capabilities_idx` exists, is a GIN index and is partial (`pg_indexes`), in the style
  the file's existing index assertions use.
- **The plan uses it.** Seed a few thousand listeners, then in **one transaction**: `ANALYZE
  participants`, `SET LOCAL enable_seqscan = off`, and `EXPLAIN` the tools, models and runtime
  filter queries — each plan must contain `participants_capabilities_idx`. Asserted on the plan
  text, never on a duration, so it is a structural test and not a timing one; `SET LOCAL` reverts
  with the transaction, so nothing leaks into the next test. This is the test that fails if a
  predicate is ever rewritten as `capabilities->'tools' @> …`, which no functional test would catch.

**`server` — `test/lobby-routes.test.ts`**

- `GET /api/lobby/listeners` round-trips a query: `q`, a `filter` with models+effort and tools,
  `sort`, `dir`, `limit`, and a `cursor` from the previous answer.
- The full auth matrix of §4.2, row by row.
- A `filter` that is not JSON is `400 validation` ("filter must be JSON"); a non-numeric `limit` and
  an unknown `sort` are `400` from **core**'s message.
- `limit=0` answers counts and facets with an empty `listeners` array; `facets=false` answers
  counts with no `facets` key.
- **`GET /api/lobby/participants/me`** answers the caller's own participant with its profile for a
  participant token and for an agent key that joined; **403** for the Lobby secret and for an
  instance keeper; 401 with no credential — the §4.1 matrix, row by row, and in particular the two
  rows where it deliberately differs from `/listeners`.

**`client` — `test/client.test.ts`**

- `listListeners()` with no arguments hits the bare path; with filters it encodes `filter` as JSON
  and the scalars as plain params; the answer's `facets` and `nextCursor` survive the round trip
  against a real server.
- `getMyLobbyParticipant()` round-trips the caller's own profile against a real server.

**`web` — store (`session.test.ts`, against a real server): the count and my own profile**

The triggers of §5.1 and §3.3 are session rules, not component rules, so they are tested where the
session is — against a real server, with no DOM.

- **The count appears on the initial load** of the Lobby, with no refresh and no event: the regression
  test for a count wired only into `refreshInfo`. Asserted for `/lobby` (an id target) and for the
  Lobby opened by **secret**.
- **A late discovery still produces a count**: `getLobby()` fails on load and succeeds on the retry,
  and the count arrives with the requests board rather than never.
- **A refresh updates it**, and a `participant.capabilities_changed` moves it (a second client sets
  a profile; the count goes up).
- **A failing count is not fatal**: the load reaches `status: "ready"` with threads, participants and
  events, `listenerCount` is `undefined`, and a later refresh that succeeds fills it in.
- **The count is not read away from the Lobby**: an ordinary Weave's load and refresh make no
  listeners call at all (counted on the server or on an instrumented client).
- **My own profile survives a refresh** (§3.3): after the load `state.me.participant.capabilities`
  is this browser's profile, and it is *still* there after a refresh — the guard for the
  `withMyProfile` helper, since `refreshInfo` rebuilds `me` from `getWeave`'s list
  ([`session.ts:280-281`](../../../src/web/src/session.ts)), which now carries no profile.
- **…and on all three routes**: the same assertion for `/lobby`, for `/weave/<lobbyId>` and for
  `/w/<lobby secret>` with a stored identity. The secret row is the one that was broken before this
  revision, and it is the reason the read exists.
- **A participant with no profile** gets `me.participant.capabilities === null` and nothing throws.
- **A failing own-profile read is not fatal**: on a network failure the page loads, `me` exists,
  `capabilities` is absent, nothing is invalidated, and the next successful read fills it.
- **It is re-read when the event names me**, and not when it names someone else.

**`web` — store: ordering, ownership and a rejected identity (§3.3, §5.1)**

Each of these is a race written deterministically, with a client whose two responses the test
releases by hand.

- **An older profile answer does not resurrect a cleared profile**: read A starts, read B starts and
  lands with `capabilities: null`, then A lands with the old profile — `me.capabilities` stays
  `null`. The sequencing rule, stated as the user-visible consequence.
- **An older, larger count does not overwrite a newer, smaller one**: the same shape for
  `listenerCount`.
- **An answer read for a previous identity is discarded**: the read starts, the session joins under
  a new name (a new `participantId` and token), then the old answer lands — `me.capabilities` is
  **not** set from it. The guard the generation counter cannot provide, because `join()` does not
  bump the generation ([`session.ts:651-653`](../../../src/web/src/session.ts)).
- **A rejoin starts with no profile**: after a join, `me.capabilities` is null until a fresh read
  answers for the new identity.
- **A revoked token on a secret-link visit invalidates the identity** — the §3.3 table's whole
  point: `/w/<lobby secret>` loads, the own-profile read answers `401`, and then the entry has **no**
  `token`/`participantId`/`name`, still has its `secret` and cached title, `identity` is `"invalid"`,
  `state.me` is `undefined`, `readOnlyReason` is `"secret-fallback"`, **the page is still `ready`
  and still reading** (threads and events intact), and no reload was performed.
- **The same failure on an id target with a stored secret** falls back to the secret through the
  existing page path: `status: "ready"`, read-only, the secret kept.
- **…and with no stored secret** settles at `no-credential` with the identity invalidated.
- **A transient failure invalidates nothing**: the own-profile read answers `500`, and the entry
  still holds its token and `me` is still set.
- **A delayed `401` for a *previous* identity leaves the new one untouched** — the mirror of the
  ordering test above, and the one where a stale answer would destroy something. The read starts,
  its token dies, the session rejoins (a fresh `participantId`, token and `name` are written), then
  the old `401` lands: the stored entry is **byte-identical** to what the join wrote (token,
  `participantId`, `name` all present, no `identity: "invalid"`), `state.me` is the new identity,
  `me.capabilities` is untouched, `readOnlyReason` is undefined, and no `WriteResult` reached the
  notice. Asserted on the storage value, not only on the rendering.
- **A delayed `401` arriving after a generation change does nothing** — same assertions, with a new
  `doLoad()` in place of the rejoin.
- **A delayed transient failure for a previous identity is equally silent**: no `refreshError`, no
  retry scheduled against the new identity, cache untouched.
- **A stale `401` for the *same* identity, after a newer read succeeded, does not invalidate**: read
  A starts, read B starts and succeeds, then A is rejected — the token is still in storage and `me`
  is intact. The decision of §3.3: a newer success is later evidence about the same token, and the
  next trigger's read will be rejected with nothing newer behind it if the token really is dead.
- **The ordinary case still works**: the *current* identity's read is rejected and the identity is
  invalidated exactly as the row above describes. The guard must not be so strict that it disarms
  the rule it protects.
- **A `401` from the count** takes the ordinary page-credential path (it is read with the page
  reader), invalidating and falling back exactly as a failed requests read does today.

**`web` — DOM (`listeners-page.test.tsx`, happy-dom)**

- **An eligible, joined listener sees the Offer form on the Lobby opened by its secret link** — the
  §3.3 regression test, written as the user-visible rule rather than as "a read happened". The same
  assertion via `/lobby`; and a participant with **no** profile sees no Offer form on either.
- **A revoked token on that same secret-link page takes the Offer form away and offers a Join**: the
  read-only banner appears, the composer is gone, and the page still shows the Weave — the DOM half
  of the invalidation rule above.
- **A selected chip with no matches renders selected and empty**, not hidden: with a filter
  combination that leaves a selected runtime at zero, the chip is still present, still marked
  selected, shows `0`, and clicking it clears that filter.
- The **Lobby sidebar** shows "Listeners (N)" from the session's count and **renders no
  `ProfileCard`** — the removal, asserted directly.
- The sidebar line reads "Listeners" with no number before the first answer, and shows "count
  unavailable" (never "(0)") when the count request fails.
- The sidebar line is a **button** (not an anchor, no `href`) when the Lobby entry is memory-only,
  and clicking it renders the directory in place with the URL unchanged.
- The page renders a card per listener from one mocked answer, and the counts line reads
  "Showing 2 of 2 matches" / the `(N listeners)` form when filtered.
- **Debounce**: three keystrokes inside 250 ms produce **one** request, carrying the final value.
- **Query string → controls**: mounting at `?q=fable&filter={…}&sort=owner&dir=desc` seeds the
  search box, the chips, and both selects, and the first request carries all of them.
- **Controls → query string**: clicking a chip calls `history.replaceState` (not `pushState`) with
  the new query, and the request carries the filter.
- **In place**: rendered through `openListenersInPlace`, a chip click changes the results and
  `replaceState` is **not** called.
- An unparseable `filter` in the URL renders the directory with a notice and no filter, not an error
  page.
- **Show more** sends the `nextCursor`, appends, and leaves the first page's cards in place and in
  order; a failed "Show more" keeps the rows and shows the error by the button.
- **Empty**: filters that match nothing render "No listener matches" with **Clear filters**, which
  clears them and re-queries; an empty Lobby renders "Nobody has declared a profile yet."
- **An error never renders as an empty directory**: a rejected query renders the message and no
  "no matches" line.
- A control change **keeps the current rows on screen** while the new answer is in flight.
- **No credential** renders the Join-the-Lobby form; joining loads the directory in place.
- A **401** invalidates the stored identity (token gone, `secret` kept), falls back to the secret,
  and renders the directory; with no secret it renders the join form and the invalid-identity line.
- The not-persisting bar renders on this page.

**`cli` — `test/lobby.test.ts`**

- `loom lobby` still prints a profile summary per listener (unchanged expectations), now via the
  merge of §3.2 — the existing test is the guard, and one new test asserts the merged line for a
  participant with no profile still reads `(no profile)`.

**`claude-channel` — `test/lobby.test.ts`**

- The two-step-leave assertions move from `core.getWeave(...).participants[…].capabilities` to
  `core.findAgents(...)`: the profile is gone from the server before the credential is. Same rule,
  same sharpness, a source that still carries profiles.

**No new `mcp-tools` tests** — no tool changes (one description sentence).

**Manual smoke (TESTING.md).** Smoke test 5 gains three steps: open `/lobby` on an instance with a
handful of profiles and confirm the sidebar shows **Listeners (N)** and no cards; follow it, search
by owner, apply a model and a tool filter, and confirm the counts and the chips move together;
copy the URL into a new tab and confirm the same view comes back. Plus one negative: stop the server
and confirm the page says so rather than saying "no listeners".

## 9. Docs to update

| Doc | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` §9 | the route table gains `/lobby/listeners`; the third in-place mirror (`openListenersInPlace`); the Lobby page's metadata carrying no profiles, where the count comes from, and that the session reads its own profile separately (§3.3) |
| `docs/ARCHITECTURE.md` §12 | a **Listeners** paragraph under Profiles: `listListeners` as the paged, faceted, SQL-side read; `findAgents` as the unchanged in-memory matcher agents use; `getMyLobbyParticipant` as the way to read your own; and the one sentence that `getWeave` carries **no** Lobby profiles at all |
| `docs/SECURITY.md` §4a | the searchability paragraph of §6 — same population, same credentials, a new shape; and that `owner` is self-declared (ADR 0001), so a directory sorted by it is a roster |
| `docs/SECURITY.md` §9.1 | the new endpoint is the most expensive authenticated read; bounded, but still unrated |
| `docs/TESTING.md` | the `core`, `server`, `client`, `web` and `cli` rows; the new test files; the three smoke-test-5 steps; the totals |
| `docs/KNOWN-ISSUES.md` | remove nothing; add: (a) `getWeave` now reads the settings row twice (guidelines + Lobby id) and should read it once; (b) the directory has no live updates by design, only a "list changed" hint; (c) the facet pass unnests jsonb and is the query's expensive half at 10k listeners; (d) **profiles still travel over the event log** — `participant.capabilities_changed` carries the whole profile and a Lobby load backfills the entire history, so the log grows with every profile change and a loading page downloads all of them (§11 has the two options and why neither is here); (e) `q` has no index, so a search is a filter over the Lobby's participants (`pg_trgm` is the fix if it ever hurts) |
| `docs/superpowers/specs/v2-notes.md` | a dated entry for this idea linking this spec, plus Paw's "Later" note (§11) |
| `src/web/README.md` | the new route and the listeners components |
| `src/core/README.md` | `listListeners` beside `findAgents` |

## 10. Implementation order

**Seven** task-sized steps; each ends green and each is a plausible subagent task. (It was six
before the review: the session work of §3.3 and §5.1 — the own-profile read and the count's four
triggers — is now its own step rather than a rider on the sidebar, because it is where the one
regression this revision exists to prevent would happen.)

1. **The core query.** `src/core/src/lobby/listeners.ts` — types, validation and its normalisation
   rules, the cursor codec **with the SQL-rendered `joined` key**, the seven queries with
   whole-document containment, the **two-stage** models facet and the selection-inclusive
   `LEFT JOIN`s, the bounded fold; the GIN index in `schema.ts` and migration `0004`; the facade
   method. `test/lobby-listeners.test.ts` in full, plus the `db.test.ts` index **and plan**
   assertions. Nothing else in the repo changes, so this lands on its own and everything after it
   can rely on it.
2. **`getWeave` stops carrying Lobby profiles, and `getMyLobbyParticipant` replaces the exception.**
   The `getLobbyWeaveId` check with **no** own-row exception; the new core function beside
   `setCapabilities` and its facade method; the doc comments on `PublicParticipant.capabilities` in
   core **and** the client mirror; the `core` tests for both; the moved `claude-channel` assertions;
   the `loom lobby` merge with `findAgents` and its CLI test. One task, because it is one rule and
   its whole blast radius (§3.2) — and because shipping the blanking without the replacement read
   would leave the Offer form broken between two commits.
3. **REST + client.** `GET /api/lobby/listeners` **and `GET /api/lobby/participants/me`**, the
   types-only mirrors in `src/client/src/types.ts`, `LoomClient.listListeners` and
   `getMyLobbyParticipant`, the route tests with both auth matrices and the client round-trip tests.
4. **Server static route + web router.** `/lobby/listeners` (+ trailing slash) in `app.ts`, the boot
   line, `static.test.ts`; `Route`, `routeOf`, `App`, `openListenersInPlace` in `app.tsx`, and a
   `ListenersRoute` that resolves the Lobby, picks a credential and renders "Loading…". Small,
   mechanical, and it unblocks the page.
5. **The page.** `ListenersPage` and its controls: search with the debounce, the four facet-fed
   filters (models with their bounded effort row), sort, the counts line, the `ProfileCard` grid,
   Show more, the empty/loading/error states, the query-string round trip and the `replaceState`
   rule, the join-form and 401 branches. DOM tests.
6. **The session: my own profile, and the listener count.** `withMyProfile`, the identity-owned
   `ownProfile` cache and the own-profile read on its three call sites (§3.3); `listenerCount` on
   its four triggers (§5.1); the **request numbers** both apply through; the `failed: "page" |
   "identity"` parameter on `recoverFromCredentialFailure` and the sibling invalidation rule for a
   rejected identity while the page reads on. Store tests against a real server, including the
   ordering and ownership races, the `/w/<lobby secret>` invalidation and the
   failing-then-recovering count. This step is what keeps the Offer form working, so it lands
   **with or before** the step that removes the profiles it used to read — in practice immediately
   after task 2, which is why it is sequenced before the sidebar. It is also the largest of the
   seven, and the one to review hardest: every rule in it exists because a race or a credential
   failure would otherwise be silent.
7. **The sidebar, the Lobby summary, then docs.** `ProfileCards` → `ListenersLink` rendering the
   count from `state`, `LobbySummary` re-pointed at `listListeners({ limit: 0, facets: false })`,
   their DOM tests including the Offer-form assertions of §8; then §9's docs in one commit.

Steps 1–3 are the data path and are independent of 5; step 4 is the join between them. Steps 6 and 7
are last on purpose: they are what *removes* the old way of getting a profile and a profile count,
and neither should run before the new way is proven. Strictly, task 2 leaves `main` with a Lobby
whose Offer form cannot render until task 6 lands — acceptable inside one branch, and the reason
this spec names the ordering rather than leaving it to chance.

## 11. Later

Paw's own note, and the items this spec deliberately leaves on the far side of the line:

- **Reuse the facets as dropdown-with-free-text wherever a model, tool or runtime is entered**
  (Paw, 2026-09-19) — the Open-a-request form and a listener's own profile. The facet endpoint
  already computes exactly the vocabulary those fields want: what is actually in use on this
  instance, with counts, so the common answer is one click and an unusual one is still typeable.
  **How new models are introduced is undecided** — "we'll figure that out later". The obvious
  tension to resolve then: a facet only knows values somebody has already registered, so the first
  listener to run a new model must type it, and a typo becomes a facet row that looks official.
- **Paging the participant list itself**, and name resolution on demand — with the layout overhaul,
  and the thing that makes `getWeave` scale rather than just its Lobby answer.
- **Actions on a listener**: invite into a Weave, open a request targeted at one, see their open
  offers. Each needs an authority story of its own; a directory needs none.
- **An MCP tool or CLI command for the directory.** `find_agents` covers the agent-facing need and
  `loom lobby` the human-at-a-terminal one. If a paged, faceted read is ever wanted from an agent,
  it is the same core query behind a new tool, which is a small task on top of this one.
- **A "profile last updated" column and sort** — a migration (§1, non-goals) and a write path.
- **Live directory updates** — a stream and a "reshuffle politely" rule, if the hint of §5.5 ever
  proves too passive.
- **Profiles in the event transport** — the cost this sub-project does **not** remove (§1,
  problem 2). `setCapabilities` appends `participant.capabilities_changed` with the whole validated
  profile ([`profile.ts:66-67`](../../../src/core/src/lobby/profile.ts)), and a session backfills the
  Weave's entire history before reading metadata
  ([`session.ts:504-512`](../../../src/web/src/session.ts)), so the Lobby's General thread grows by
  up to 4000 characters per profile change for ever, and every loading page downloads all of them.
  Two options, neither in scope here:

  1. **Slim the payload** to `{ participantId }` (plus perhaps a `cleared: true`) and let readers
     fetch what they need. This is a **wire-format change**, and the payload has readers today:
     web [`MessageList.tsx:44-45`](../../../src/web/src/components/MessageList.tsx), CLI
     [`commands/messages.ts:40-41`](../../../src/cli/src/commands/messages.ts) and channel
     [`format.ts:85-86`](../../../src/claude-channel/src/format.ts) all branch on
     `payload.capabilities` being truthy to say "updated" versus "cleared" — which a `cleared` flag
     would have to replace in all three — the channel's wake rule reads the same event
     ([`format.ts:114`](../../../src/claude-channel/src/format.ts)), and a **JSON export** emits the
     payload verbatim ([`export.ts:31`](../../../src/core/src/export.ts)). Events are also an
     append-only log: old ones keep the old shape, so every reader needs both for ever. That is a
     sub-project with its own compatibility story, not a line in this one.
  2. **Stop backfilling the whole history on the Lobby page** — window it, or start from a recent
     seq. That is the same "paging the participant list / the log" work the layout overhaul owns,
     and it changes what every Weave page shows, not just the Lobby's.

  Recorded in KNOWN-ISSUES (§9) so the cost is written down where a reviewer will find it rather
  than implied by a promise this spec does not make.
- **A trigram index for the search.** `q` is an `ILIKE` substring filter with no index (§2.8);
  `pg_trgm` plus a GIN trigram index on `name` and on `capabilities->>'owner'` would serve it. A
  second extension and two more indexes, for a filter that today runs over one Weave's participants.

## 12. Open questions and assumptions

Stated as assumptions so implementation is not blocked. **Items 1, 3, 4 and 6 were confirmed by Paw on
2026-09-19**: no `spawnsSubagents` filter for now ("that can be left out yet" — the badge on the card
stays, and it remains a one-line addition later); the `getWeave` own-profile rule; the JSON `filter`
encoding, including in the page's own URL; and no live updates in the directory beyond the "list
changed — reload" hint. The rest stand as the spec's own decisions.

> **Item 3 changed after its first confirmation and was confirmed again.** The spec review of
> 2026-09-19 showed that the rule Paw first confirmed could not work on `/w/<lobby secret>`, so it
> was replaced (§3.1, §3.3) and put back to him: **"I accept 12.3" (Paw, 2026-09-19)**. Item 3 below
> records both shapes, so the reason the rule looks the way it does is not lost. Items 1, 4 and 6
> are unchanged from what was confirmed. Items 5 and 7–17 are the spec's own decisions and are
> **not** confirmed.

1. **The facets are the four in the approved design, and `spawnsSubagents` is not a fifth**
   (§2.3). Assumed: the card's `subagents` badge is enough, and a boolean makes a poor chip row. One
   line of UI and one facet query to add if Paw disagrees.
2. **Sorting by `name` and `owner` is case-insensitive** (§2.5), which also lets the default sort
   use the index that already exists. `joined` inherits the wall-clock caveat KNOWN-ISSUES records,
   and the cursor stays exact because `id` is the tie-break and **every sort key is non-null** — an
   invariant §2.5 establishes from the code and §8 tests, rather than a null branch in the cursor.
3. **`getWeave` carries no Lobby profile at all, and the caller's own comes from
   `GET /api/lobby/participants/me`, read with `me`'s token on all three routes** (§3.1, §3.3,
   §4.1, §5.1). **Re-confirmed by Paw on 2026-09-19** in this shape.

   Its history is worth keeping, because it is why the rule is shaped this way. What Paw confirmed
   first was *"`getWeave` keeps the caller's own Lobby profile and returns `null` for everyone
   else's"*. That cannot hold on `/w/<lobby secret>`, where the metadata read authenticates as the
   **secret** and owns no participant row
   ([`session.ts:173, 542-546`](../../../src/web/src/session.ts)) — an eligible, joined listener
   would have lost its Offer form. Two things improved with the replacement: `null` from `getWeave`
   now means exactly one thing in the Lobby rather than two, and the answer no longer depends on
   which credential happened to read it. The cost is one small request per Lobby load, one more
   public REST route, and the rules of §3.3 that come with reading a second credential — the
   sequencing, the identity-owned cache and the invalidation path.
4. **`filter` travels as JSON, the scalars as plain query params** (§4.1), including in the page's
   own URL. Unambiguous against model names containing any delimiter, consistent with
   `/api/lobby/agents` — and uglier in an address bar than `&model=opus-5&tool=shell`. If Paw
   prefers the readable form, the fallback is repeated `model` params **without** per-model effort
   support, and effort becomes a separate single-value param applying to all alternatives.
5. **Only one new index ships** (§2.8): the partial `jsonb_path_ops` GIN on `participants.capabilities`.
   No expression index for the owner sort, and none for `joined_at`. Assumed adequate at 10k
   listeners; the honest trigger to add one is a measured plan, not a guess.
6. **The directory has no live updates — only a "list changed — reload" hint** (§5.5), and it is
   computed from `total` moving between queries the human already caused. No socket, no timer. A
   directory left open therefore goes stale silently until it is touched. The alternative Paw ruled
   out (reshuffling under the reader) is worse; the middle ground (a polite "N new listeners" that
   only appears on a poll) is a timer this page does not otherwise need.
7. **On a memory-only browser the page does not write its query string** (§5.4), so a filtered view
   cannot be copied as a link there. That browser cannot reload any page without losing its
   identity, so the link would point at a session it could not restore.
8. **A malformed or mismatched cursor is `validation`; a stale one is not** (§2.5). A caller paging
   with rubbish hears about it; a caller whose page moved under it gets the page after the position
   it named.
9. **The facet top-20 tail is reported as a flag, not as an "other" bucket** (§2.7), and a selected
   value outside the top 20 is always included so the UI never drops the chip the human clicked.
10. **`facets: boolean` is a fifth input the approved design did not name** (§2.7, §5.1). Added
    because the sidebar's count runs on **every** Lobby metadata refresh, and without it each of
    those refreshes would pay for four grouped jsonb aggregations nobody reads. One boolean, one
    default, and the only caller that passes it is the one that wants a number.
11. **The `loom lobby` merge with `findAgents`** (§3.2) is treated as a compatibility fix to an
    existing command rather than a breach of "no CLI command in this change". The alternative is
    accepting that `loom lobby` prints `(no profile)` for every listener, which would be a
    regression shipped on a technicality.
12. **An empty `tools` or `models` array, and a blank `q`, mean "no filter"** (§2.3) — including
    `models: []`, which `validateRequirements` rejects outright
    ([`matching.ts:29`](../../../src/core/src/lobby/matching.ts)). A UI control going from one chip
    to none must not be a 400, and the empty `tools` case is the one place SQL containment and
    `matches` would otherwise disagree.
13. **The effort list inside the models facet is capped at 10 per model** (§2.7), with the same
    `more` and always-include-the-selection rules as every other facet. `effort` is free text
    ([`profile.ts:22`](../../../src/core/src/lobby/profile.ts)), so nothing else bounds it.
14. **This spec promises to remove the profile *snapshot*, not profiles from the wire** (§1, §11).
    Profiles still reach a loading page through the event log, and slimming that payload is a
    wire-format change with four readers and an append-only history behind it.
15. **The two side reads are ordered by a request number, not by coalescing** (§3.3, §5.1, §7), and
    the profile cache is owned by the identity it was read for. Sequencing is two integers checked
    where the answer is applied; coalescing would mean a slot per read kind, owned by a generation,
    consulted from three call sites — the machinery `scheduleRefresh` needs because it owns a retry
    loop, and this does not. The trade accepted: a redundant read is possible (the answer is simply
    dropped), where coalescing would have prevented the request.
16. **A stale rejection is dropped, including for the same identity** (§3.3). The own-profile
    rejection handler checks the captured participant id, token, generation **and request number**
    before any side effect, so a `401` that lands after a newer answer was acted on invalidates
    nothing. The asymmetry is deliberate and is the one place this spec prefers a delay to an
    action: a `401` is evidence about a token whenever it was asked for, but a newer success is
    *later* evidence about the same token, and deleting a credential from storage cannot be undone.
    If the token really is dead the next trigger's read is rejected too, and that one invalidates.
17. **A rejected own-profile read invalidates the identity without reloading the page** (§3.3, §7).
    On a secret-link visit the page is reading perfectly well with the secret, so it keeps reading:
    the identity is cleared from state and storage, `me` goes, and the page becomes the read-only
    "your identity is no longer valid — Join" state `WeaveView` already renders. The alternative —
    reusing the page path and reloading — would throw away a healthy page and re-fetch its whole
    history because a *different* credential died.
