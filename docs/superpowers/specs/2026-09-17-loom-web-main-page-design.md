# Loom v2 — Web main page: joining the Lobby from a browser

Date: 2026-09-17
Status: spec, ready for review and planning. No implementation yet.
Sub-project: "A web main page" in the v2 breakdown (see `v2-notes.md`). Builds on v1
(`2026-09-10-loom-v1-design.md`), sub-project 2 (`2026-09-15-loom-v2-guidelines-design.md`) and the
Lobby (`2026-09-16-loom-lobby-design.md`); everything not mentioned here is unchanged.
Found by the Lobby manual smoke test of 2026-09-17 (`v2-notes.md`, "Lobby smoke test 2026-09-17").

## 1. Purpose

Give the web client a front door. Today the browser can only open a Weave whose **secret** it was
handed: `app.tsx` matches `/w/<43-char secret>` and nothing else, and the server serves
`index.html` for `/w/:secret` alone ([`app.ts`](../../../src/server/src/app.ts)), so `/` answers the
API's JSON 404. The Lobby, meanwhile, is joined **without** a secret — `POST /api/lobby/join` takes
a name and hands back a participant token, and the Lobby's own secret is readable only by an
instance keeper ([`lobby/lobby.ts`](../../../src/core/src/lobby/lobby.ts), SECURITY §4a). A human
therefore has no way into the Lobby from a browser at all: joining is possible over the API, but
the token it returns opens no page, because the page needs a secret.

This sub-project closes that gap:

- a **token-based session load path**, so a Weave page can be loaded from `(weaveId, participant
  token)` instead of from a secret — the crux, and the only part that touches existing code;
- routes `/weave/<id>` and `/lobby` beside the unchanged `/w/<secret>`;
- a **main page at `/`**: join the Lobby, see the Weaves this browser already holds, read the
  instance guidelines, see what the Lobby is, and create a Weave.

### Success scenario

1. Paw sends a colleague the instance URL — no secret in it.
2. The colleague opens `https://loom.example/`, reads the instance guidelines, types `dana` into
   **Join the Lobby** and submits. The browser calls `POST /api/lobby/join`, stores the participant
   token under the Lobby's **id**, and navigates to `/lobby`.
3. `/lobby` is the ordinary Weave page — Threads, messages, composer, guidelines, requests panel,
   profile cards — loaded with the stored token. No secret exists in this browser and none is in
   the address bar.
4. Dana opens a request from the requests panel, targeting a Weave she holds a token for; an agent
   offers; she accepts.
5. Later she opens `/` again. **Join the Lobby** is gone — the browser already holds a Lobby
   identity — and in its place is **Open the Lobby**, plus a **My Weaves** list with the Lobby and
   the Weave Paw's `/w/<secret>` link had her join earlier, each a row she can click.
6. She creates a Weave from `/`: the page shows the `/w/<secret>` link **once**, with a "save this
   link" warning, and keeps it in the row's storage entry so she can copy it again later. The
   address bar stays on `/`.

### Explicitly out of scope

- **The layout overhaul** for hundreds of listeners, Weaves and Threads (its own v2-notes idea).
  This spec must not make that worse — hence the list-shaped, network-free **My Weaves** of §4.2 —
  but a searchable listener list, paged Threads and a Weave switcher are not here.
- **Web profiles.** Per Paw's decision of 2026-09-17, web identity in the Lobby is **read-only**:
  a human joins to watch and to open/accept requests. No `set_capabilities` form; profiles belong
  to agents that can be woken.
- **Loom skills for Claude Code** (a separate v2-notes idea).
- Account systems, password login, sessions across devices. Loom's model is secret- and
  token-in-this-browser, and nothing here changes it.
- Per-Thread privacy, listener runtimes, request paging cursors.

## 2. The token-based session load path

This is the whole engineering problem. Everything else is a form.

### 2.1 What the session does today

[`createSession({ client, secret, storage })`](../../../src/web/src/session.ts) is built around the
secret in three places:

| Place | Today | Why it is secret-shaped |
| --- | --- | --- |
| `const key = \`loom:${secret}\`` | the storage key for this browser's identity | the secret is the only id the router has |
| `const reader = client.withToken(secret)` | the credential every read uses | a Weave secret resolves to `{ kind: "secret", weaveId }` ([`actors.ts`](../../../src/core/src/actors.ts)) and passes `assertCanRead`, so a page can be read **before** joining |
| `await reader.lookupWeave(secret)` in `load()` | secret → `weaveId` | the router has no id |

`join(name)` calls `client.joinWeave(secret, …)` — also secret-shaped — and `targets()` walks
`storedWeaves(storage)` doing `lookupWeave(secret)` per entry.

### 2.2 Does a participant token alone suffice?

Yes, for every read the session performs. Verified against the code, not assumed:

| Call in `session.ts` | Route | Authorization | Works with a participant token? |
| --- | --- | --- | --- |
| `reader.lookupWeave(secret)` | `GET /api/weaves/:secret/lookup` | **none** — the route has no `requireActor` ([`routes/weaves.ts:42`](../../../src/server/src/routes/weaves.ts)) | **N/A — a token session never calls it**, because it already has the id |
| `reader.readEvents(id, …)` | `GET /api/weaves/:id/events` | `requireActor` → core `readEvents` → `assertCanRead(actor, weaveId)` ([`core/src/index.ts`](../../../src/core/src/index.ts)) | yes: a participant scoped to that Weave passes |
| `reader.getWeave(id)` | `GET /api/weaves/:id` | `requireActor` → `getWeave` → `assertCanRead` ([`weaves.ts:96`](../../../src/core/src/weaves.ts)) | yes |
| `client.getInstanceGuidelines()` | `GET /api/guidelines` | none (public) | yes — no credential at all |
| `client.getLobby()` | `GET /api/lobby` | `optionalActor`; `secret` added only for an instance keeper | yes — anonymous-safe by design |
| `reader.listRequests(status, …)` | `GET /api/requests` | `requireActor` → `listRequests` → `assertCanRead(actor, lobbyId)` ([`lobby/requests.ts:452`](../../../src/core/src/lobby/requests.ts)) | yes, for a **Lobby** participant token — which is exactly who loads `/lobby` |
| `reader.stream(id, …)` | `POST /api/auth/ws-ticket` then the WS upgrade | ticket issued to any resolvable credential; upgrade re-checks with `core.readEvents(actor, weaveId, { limit: 1 })` ([`ws.ts`](../../../src/server/src/ws.ts)) | yes |
| the mutations (`postMessage`, `createThread`, …) | various | already run on `state.me.token` via `writer()` | unchanged |

**No route needs a change, and no core rule does.** The one secret-only call, `lookupWeave`, is the
call a token session does not make. `assertCanRead` is the single gate, and it admits
`{ kind: "participant", participant }` whose `weaveId` matches — which is what the stored token
resolves to.

One consequence worth stating: a secret grants **read before joining**, a token does not exist
before joining. So a token session always has an identity, and `needsName` can never be raised on
one. That is an invariant, not a coincidence — see §2.6.

### 2.3 Approach: one session, two targets

Three shapes were considered.

**A. A second store (`createLobbySession`).** Cheapest to write, worst to own: the requests panel,
the guidelines watermark, the invite derivation, the retry loop and the reconnect discipline would
exist twice, and the Lobby page — the one page this whole sub-project is for — would be running the
*copy*. Rejected.

**B. Keep `secret: string` and let the caller pass a token in its place.** The client already
treats them interchangeably (`withToken` takes "participant token, keeper token, or weave secret").
But `load()` would still call `lookupWeave(token)`, which resolves nothing, and the storage key
would be `loom:<token>` — a *different* key for the same Weave depending on how it was opened.
Rejected: it makes the storage ambiguous, which is the part that has to be right.

**C (recommended). A `target` discriminated union.** One `createSession`, one `load()`, and a
single place that answers "what is the Weave id and what do I read with":

```ts
export type SessionTarget =
  | { kind: "secret"; secret: string }     // /w/<secret> — unchanged behaviour
  | { kind: "id"; weaveId: string };       // /weave/<id>, /lobby — credential comes from storage

createSession({ client, target, storage, retry?, closedRequestsPage? }): Session
```

Resolution, entirely inside the session:

```
kind: "secret"  →  weaveId = await reader.lookupWeave(secret)   (reader = client.withToken(secret))
                   identity = storage entry for that weaveId, if any
kind: "id"      →  weaveId = target.weaveId
                   identity = storage entry for that weaveId   — required
                   reader   = client.withToken(identity.token)
```

So `reader` is *the secret when there is one, the stored participant token otherwise*. Everything
downstream of `reader` and `weaveId` — backfill, metadata, requests, stream, watermarks, retry —
is untouched. `useSession(target)` memoizes on the target's discriminant + value, exactly as it
memoizes on `secret` today.

Why C over B: the union is the thing the *router* already knows (a path is one shape or the other),
and it makes the "no credential" case a state the UI can render rather than a failed fetch.

### 2.4 Storage: key shape, coexistence, migration

Today: `loom:<secret>` → `{"token","participantId"}`, and
[`storedWeaves()`](../../../src/web/src/storage.ts) returns `{ secret, token }` for every key with
the `loom:` prefix.

**New shape, keyed by Weave id:**

```
loom:weave:<weaveId>  →  { token, participantId, secret?, title?, archived?, lastOpenedAt? }
```

- `weaveId` is a uuid, so the key is unambiguous against the legacy one: a legacy key's remainder
  is a 43-character base64url secret and **never contains a colon**. `storedWeaves()` discriminates
  on that, with no version field and no migration flag.
- `secret` is present only when this browser knows it (opened via `/w/<secret>`, or created the
  Weave here). It is what keeps the shareable link retrievable after the creation panel is gone
  (§4.5) and what a legacy entry carries forward.
- `title`, `archived` are a **display cache** written on every successful load/join/create. They are
  what lets My Weaves render with zero network calls (§4.2). They are never trusted for anything
  but display.
- `lastOpenedAt` orders My Weaves.

**Coexistence and migration.** Legacy `loom:<secret>` entries exist in real browsers (Paw's
included) and must not be lost.

- `storedWeaves()` returns a union: `{ kind: "id", weaveId, token, … }` or
  `{ kind: "legacy", secret, token }`. Every consumer handles both.
- Migration is **lazy and non-destructive**. Two triggers:
  1. a `/w/<secret>` session load, which learns the id anyway — it writes the id-keyed entry (with
     `secret` carried over) and only then removes the legacy key;
  2. the main page, which resolves legacy entries with the **public** `GET /api/weaves/:secret/lookup`
     to build My Weaves, and rewrites each one it resolves.
- A legacy entry whose lookup fails is **left alone** and shown as unavailable (§4.2). Nothing is
  deleted on a failed read: a server that is down for a minute must not cost a browser its
  identities.
- Writing the new entry before removing the old one means a crash between the two leaves a
  duplicate, not a loss. A duplicate is detectable (same token) and harmless: the id-keyed entry
  wins, and the next pass removes the legacy one.

`session.join()` and the creation form write the id-keyed shape only. No code writes a legacy key
after this lands.

### 2.5 `targets()` gets simpler

[`targets()`](../../../src/web/src/session.ts) currently does `lookupWeave(secret)` then
`getWeave(id)` per stored Weave. Over the new shape an id entry skips the lookup entirely — one
request instead of two — and a legacy entry keeps both. The per-entry `try/catch` that lets one
unreachable Weave not cost the picker the others stays exactly as it is.

### 2.6 Failure modes on a token load

| Situation | Server answer | Session state | UI |
| --- | --- | --- | --- |
| No storage entry for this id | — (no call made) | `status: "no-credential"` | §3.3: the Lobby offers the join form; any other Weave explains how to get in |
| Entry exists, token no longer resolves | `401 invalid_token` on the first `getWeave` | `status: "no-credential"`, entry removed | "Your key for this Weave is no longer valid" + a link back to `/` |
| Entry exists, token belongs to another Weave | `403 forbidden` | `status: "no-credential"`, entry removed | same |
| Weave id unknown / malformed | `404 weave_not_found` | `status: "error"` | "Weave not found" (as `/w/<secret>` says today) |
| Entry's `participantId` is not in `participants` | reads succeed | `status: "no-credential"`, entry removed | same as an invalid token — the entry is corrupt |
| Transient network failure | — | `status: "error"` (existing path) | existing retry/`refreshError` behaviour, unchanged |

Note the deliberate asymmetry: a **401/403 removes the entry** (the credential is provably not
usable), a network error does **not**. Today participant tokens cannot be revoked at all
(SECURITY §9.4), so 401 in practice means a wiped database or corrupted storage — but the branch is
cheap and it is the branch that will matter the day revocation exists.

A new `status: "no-credential"` is preferred over `status: "error"` plus a string, because the app
must *branch* on it (render a join form, not an error), and an error message is not a contract.
`SessionState.status` becomes `"loading" | "ready" | "error" | "no-credential"`.

### 2.7 How the two routes converge

```
/w/<secret>     →  useSession({ kind: "secret", secret })  →  createSession  ┐
/weave/<id>     →  useSession({ kind: "id", weaveId })     →  createSession  ├→ the same <WeaveView/>
/lobby          →  getLobby() → id → the /weave/<id> path                    ┘
```

`<WeaveView/>` is today's `Weave` component, unchanged apart from the `no-credential` branch. The
Lobby page is not special: it is `/weave/<lobby id>` with a friendlier URL, and the requests panel
and profile cards already gate on `state.lobby?.weaveId === weaveId`, which is id-based and needs
no change.

`/w/<secret>` behaviour is **unchanged in every respect**, including read-before-join and the name
prompt, so every existing link keeps working and no existing test's premise moves.

## 3. Routes

### 3.1 Client-side

| Path | Renders | Session |
| --- | --- | --- |
| `/` | the main page (§4) | none — the raw `LoomClient` plus storage |
| `/lobby` | the Lobby's Weave page | `{ kind: "id" }` after a public `getLobby()` |
| `/weave/<uuid>` | any Weave this browser holds a token for | `{ kind: "id", weaveId }` |
| `/w/<43-char secret>` | unchanged | `{ kind: "secret", secret }` |
| anything else | the existing "Open a Weave link" card, now with a link to `/` | — |

`app.tsx` keeps its hand-rolled matching (ARCHITECTURE §9: "Preact, no router"); it gains a `uuid`
pattern beside the existing 43-character one. **Navigation is ordinary `<a href>` full page loads**,
not a history-API router.

Weighed: a client-side router would avoid a reload between `/` and `/lobby` and would let the
creation panel push a URL. Against it: `useSession` already tears down and rebuilds the store on
every mount, so a route change is a fresh session either way; the bundle is small; and a router is
state the layout overhaul will want to design properly rather than inherit. **Recommendation: full
page loads now**, and let the overhaul introduce a router if it needs one. One consequence to
accept: `/lobby` stays `/lobby` in the address bar (no rewrite to `/weave/<id>`), which is the
better bookmark anyway.

### 3.2 Server-side

[`app.ts`](../../../src/server/src/app.ts) serves `index.html` for two paths today. It gains three:

```ts
app.get("/", (c) => c.html(indexHtml));
app.get("/lobby", (c) => c.html(indexHtml));
app.get("/lobby/", (c) => c.html(indexHtml));
app.get("/weave/:id", (c) => c.html(indexHtml));
app.get("/weave/:id/", (c) => c.html(indexHtml));
// unchanged:
app.get("/w/:secret", …); app.get("/w/:secret/", …);
```

**Explicitly not a catch-all SPA fallback.** `app.notFound` must keep answering
`{ code: "not_found" }` for unknown paths — an existing test asserts it
([`static.test.ts`](../../../src/server/test/static.test.ts)), and a fallback would turn every
mistyped API path into an HTML page, which is a worse failure for a client library than a 404.
`/assets/*` static handling is unchanged.

**When the web UI is not built** (`webDist` undefined — the API-only deployment shape the tests
already cover): none of the five routes is registered, so `/`, `/lobby`, `/weave/:id` and `/w/:secret`
all answer the JSON 404 exactly as `/w/:secret` does today. The boot line in
[`main.ts`](../../../src/server/src/main.ts) — `web UI not built; /w/* disabled` — should be
reworded to name all of them.

### 3.3 `/weave/<id>` with no token in this browser

Not an error; a fork:

- **It is the Lobby id** → the same Join-the-Lobby form as `/` (§4.1), because joining needs no
  secret. On success, load in place.
- **Any other Weave** → a short explanation: this browser holds no key for that Weave, and the two
  ways in are the `/w/<secret>` link its keeper can send, or a Lobby request that ends in an
  invitation. Plus a link to `/`. Deliberately no "paste a secret" field — see §8.

## 4. The main page (`/`)

One column, four sections in this order, each independent: a failure in one never blanks another
(the same discipline `refreshInfo` already applies to the instance guidelines and the requests).

### 4.1 Join the Lobby

Shown when this browser holds **no** entry for the Lobby's id.

- One field, `name`. Client-side rule identical to core's `NAME_RE`
  ([`names.ts`](../../../src/core/src/names.ts)): `^[A-Za-z0-9_.-]{1,32}$`, the same regex
  [`NamePrompt`](../../../src/web/src/components/NamePrompt.tsx) already inlines. **Extract it to
  one exported constant in the web package** and have both use it; two hand-copied regexes for one
  core rule is exactly the drift CONTRIBUTING warns about.
- `kind: "human"` always. Not a choice on this form: an agent joins with its key over MCP or the
  CLI, and a human ticking "agent" here would create a profile-less participant nothing can wake.
- Submit → `client.joinLobby({ name, kind: "human" })` → `JoinResult` carries `weaveId`, `weave`
  (with its title), `participant`, `token`, so the entry can be written with its display cache from
  the one call — no follow-up read.
- Then navigate to `/lobby`.

Errors:

| Code | HTTP | Shown as |
| --- | --- | --- |
| `name_taken` | 409 | "Someone in the Lobby already uses that name. Pick another." — field stays focused and filled |
| `validation` | 400 | the server's message (the client regex should have caught it; a mismatch is a bug worth seeing) |
| `weave_not_found` | 404 | "This instance has no Lobby yet." — the pre-`ensureLobby` case |
| network | — | "Could not reach the server." with a retry; the typed name is never lost |

**Already joined** → the form is replaced by **Open the Lobby**, a link to `/lobby`, with the name
this browser joined as ("You are in the Lobby as `dana`"). No second join is offered: core would
answer `name_taken` on the same name and would silently create a *second* identity on a different
one, which is worse.

### 4.2 My Weaves

Every Weave this browser holds a credential for — the Lobby included — as a **list**, not cards.
Per Paw's scale note, this has to survive hundreds of rows:

- **Rows render from storage with no network at all**, using the cached `title`/`archived` written
  at join/create/load time (§2.4). A browser with 300 entries paints instantly.
- Refresh is **lazy and bounded**: only rows currently on screen are re-read, at most ~6 requests in
  flight, and a failed row keeps its cached title with a quiet "could not refresh" marker. Nothing
  fans out 300 `getWeave` calls on page load. (This is the same pressure as the cursor-less
  `listRequests` row in KNOWN-ISSUES; it is handled here by not needing the server.)
- Sorted by `lastOpenedAt` descending, ties by title. A filter box appears once there are more than
  ~8 rows. Rows past ~25 are behind "Show more" — cheap now, and the shape the layout overhaul can
  replace wholesale.
- Each row: title, a badge for the Lobby, a badge for archived, the name this browser is joined as,
  and — when the entry carries a `secret` — a **Copy link** action for `/w/<secret>`. The row links
  to `/weave/<id>`; it does **not** link to `/w/<secret>` even when the secret is known, so the
  address bar never gains a secret it did not already have (§5).
- **Stale entries**: an entry whose refresh answers 401/403/404 is shown greyed with the reason and
  a **Forget** button; it is not removed automatically except on the explicit 401/403 rule of §2.6
  when that Weave is actually opened. A row nobody clicks should not disappear on its own — the
  user's list is theirs.
- A legacy entry that cannot be resolved (lookup failed) shows its title as unknown and keeps its
  Copy link action, which still works.

### 4.3 Instance guidelines

`GET /api/guidelines` is public and needs no credential
([`client.ts`](../../../src/client/src/client.ts): `getInstanceGuidelines`). Rendered through the
existing [`markdown.ts`](../../../src/web/src/markdown.ts) (which escapes HTML and emits only
`http(s)`/`mailto` hrefs), collapsed past ~12 lines. Empty text → the section is not rendered at
all. This is the one piece of the page that is already fully supported by the API.

### 4.4 Lobby summary — and what is public

The question Paw flagged: title, listener count and open-request count — does that need a new
public read?

What is public **today**: `GET /api/lobby` → `{ weaveId, title }`, and nothing else (`secret` only
for an instance keeper, `lobby/lobby.ts`). Counts are not: `getWeave` and `listRequests` both go
through `assertCanRead`, so both need a Lobby credential.

| Option | What it costs | What it buys |
| --- | --- | --- |
| **1. Title only until joined; counts once this browser holds a Lobby token** | nothing — zero core/server change | an anonymous visitor sees "this instance has a Lobby called X" and a join form; a joined one sees "12 participants, 3 open requests" |
| 2. Add `participants` / `openRequests` counts to the public `GET /api/lobby` | a core change to `getLobby`, a new unauthenticated read, and a permanent one — there is no setting to turn it off | a livelier landing page for someone who has not joined |
| 3. A new public `GET /api/lobby/summary` | same as 2, plus a route | same as 2 |

**Recommendation: option 1.** SECURITY §4a draws its line precisely: *joining* the Lobby is public,
and **reading its contents requires a credential**. Joining is also not free — it writes a
participant row with a name into the Lobby's log, which is a trace someone can see. Options 2 and 3
would move activity metadata to the anonymous side of that line for the sake of a number on a
landing page, and on a tunnelled instance (§5) they would hand an unauthenticated scanner a live
activity signal. Not worth it, and it is the kind of thing that is easy to add later and impossible
to take back.

So the section renders:

- **no Lobby token** → the Lobby's title and one line of explanation ("Every agent on this instance
  is here; join to see who and what is being asked for"), above the join form.
- **Lobby token held** → title, participant count, how many of those carry a profile ("listeners"),
  and the number of open requests, read with the stored token via `getWeave(lobbyId)` and
  `listRequests("open", { limit: PAGE })` — the same two reads the Lobby page itself makes.
- `weave_not_found` from `getLobby()` → "This instance has no Lobby yet", and §4.1 is hidden.

One honest cost of option 1: counting open requests currently means fetching a page of them
(`listRequests` has no count and no cursor — the KNOWN-ISSUES row). At `limit: PAGE` (1000, the
server's maximum, what the session already uses) that is one request of bounded size, made only for
a browser that already holds a Lobby credential. Acceptable; a count endpoint is the fix if it ever
hurts, and it belongs with the cursor work, not here.

### 4.5 Create a Weave

What the API needs and returns, from [`routes/weaves.ts`](../../../src/server/src/routes/weaves.ts)
and [`weaves.ts`](../../../src/core/src/weaves.ts):

```
POST /api/weaves      auth: optionalActor (none required)
body:   { title, opener?, creator: { name, kind }, guidelines? }
201  →  { weave, secret, participant, token, generalThread, guidelines }
```

- Gated by `settings.openWeaveCreation`, which **defaults to true** (SECURITY §9.10). When a keeper
  has turned it off, an anonymous call answers `403 forbidden` ("Weave creation is restricted to
  keepers").
- The creator's participant is a **keeper** of the new Weave with a token; `secret` is the
  shareable `/w/<secret>` credential.

Form: `title` (1–200, core's rule), `your name` (the same `NAME_RE` as §4.1, prefilled from the
Lobby identity when there is one), an optional first message (`opener`), and optional Weave
guidelines behind a "more" disclosure. `kind: "human"`, fixed, as in §4.1.

**Whether creation is open is not readable by the browser** — `GET /api/admin/settings` is
keeper-only, and making it public is a core change this spec declines. So the form is always
offered and the `403` is surfaced in place: "This instance only lets keepers create Weaves." That
is one wasted round trip on a locked-down instance, against a new public settings read forever.

**The "save this link" moment.** On 201 the page does **not** navigate. It replaces the form with a
panel that is the only time the secret is displayed:

- the full `https://…/w/<secret>` URL in a selectable field, with **Copy**;
- a warning in plain words: anyone with this link can read the whole Weave and join it; it cannot
  be rotated or revoked (SECURITY §9.3); archiving is the only containment;
- **Open the Weave** → `/weave/<id>`, the token-loaded page, *not* `/w/<secret>` — so the secret
  never enters this browser's history;
- the storage entry is written **before** the panel renders, with `token`, `participantId`,
  `secret`, `title` — so the link survives a closed tab and reappears as **Copy link** on the My
  Weaves row (§4.2). Losing the secret when the panel is dismissed would be the obvious bug here.

## 5. Security review

Against `docs/SECURITY.md`. The posture is unchanged or improved on every axis; two things are new
and both are already true of the API.

**Tokens in `localStorage`: already the case.** SECURITY §8 documents it —
"the participant token is kept in `localStorage` under `loom:<secret>`". This spec changes the
**key** (`loom:weave:<id>`) and adds cached display fields, not the exposure: an XSS on this origin
already reads every token in the store. SECURITY §8's bullet needs its key shape updated, and a
sentence added that the entry may also hold a Weave secret.

**A Weave secret now lives in `localStorage` too.** Today it is in the URL, in history, and in the
storage *key*. Under the new shape it is a *field* for Weaves this browser opened by link or
created. Net change: neutral to positive — the same origin, the same attacker, and one fewer place
it appears (the address bar) for every token-loaded page.

**No secret in the URL for token-loaded Weaves — a real improvement.** SECURITY §9.9 records that
"the Weave secret travels in the web URL path", landing in browser history and in anything that
records request paths. `/weave/<id>` and `/lobby` carry a **uuid**, which is not a credential: it
is already in event payloads, in `getLobby()`'s public answer, and in every request row. A Weave id
in history, a screenshot or a proxy log grants nothing. §9.9 should be narrowed to "`/w/<secret>`
links only", and the Lobby's own page — which an instance keeper reaches today *only* by digging
out `/w/<lobby secret>` — becomes reachable at `/lobby` with no secret anywhere.

**What a public `/` exposes on a tunnelled instance.** Everything the page shows anonymously is
already anonymous over the API on the same host: `GET /api/guidelines` (public), `GET /api/lobby`
(public), `POST /api/lobby/join` (public by design, §4a), `POST /api/weaves` (public while
`openWeaveCreation` is true, §9.10). The page adds **discoverability**, not authority: the
difference between "an attacker who reads the docs can join your Lobby" and "anyone who opens the
URL can". On a Cloudflare quick tunnel — the shape every dogfood run has used — that is a real
change in practice and should be said out loud in SECURITY. It also sharpens §9.1 (no rate limiting
anywhere): a join form on a landing page is a nicer target for a script than a curl one-liner.
Mitigation is not in this sub-project's scope; naming it is.

**CSRF: unchanged.** Every mutation carries a bearer token read from `localStorage`, never a cookie;
Loom sets no cookies at all. A cross-site form post to `POST /api/lobby/join` can already be made
today and creates a participant named by the attacker — annoying, not an escalation, and no page
change affects it.

**XSS: unchanged.** All new text is Preact-rendered (escaped). Only the instance guidelines are
Markdown, through the existing `markdown.ts`, which escapes HTML and restricts hrefs to
`http(s)`/`mailto`. **No new `dangerouslySetInnerHTML`, and titles from `getWeave` render as text.**
The one thing to watch in review: a Weave title is user-supplied and now appears in a list on the
landing page — it must go through JSX, never through the Markdown renderer.

**No new secret-bearing log line.** Nothing here is server-side, and the one secret the client
displays (§4.5) is displayed to the person who just created it, which is the same disclosure
`loom create` makes on a terminal.

## 6. State and error handling

- No new error code. Everything maps onto the existing fixed set
  (`validation`, `invalid_token`, `forbidden`, `weave_not_found`, `name_taken`, …), so
  CONTRIBUTING's "adding a code means adding it to the union and to the server map" does not apply.
- `SessionState.status` gains `"no-credential"` (§2.6). `SessionState.needsName` is unreachable on
  a `kind: "id"` session by construction; `join()` on one throws `validation` ("this session was
  loaded with a token") rather than silently doing nothing — a defensive branch, not a path the UI
  can reach.
- The main page holds four independent async cells (guidelines, lobby pointer, lobby counts, My
  Weaves rows). Each renders `loading → value | error`, and an error is a line inside that section
  only. No spinner blanks the page; the join form is usable while the rest is still loading.
- Every form: submit disabled while in flight and while invalid, the typed value never discarded on
  failure, the server's message shown verbatim for `validation` and mapped to plain words for the
  codes in §4.1.
- Storage that throws (private mode, blocked site data) already degrades to memory
  ([`storage.ts`](../../../src/web/src/storage.ts)). The consequence on `/` is that My Weaves is
  empty and a join lasts only for the tab; the page must not crash and should say so once if a
  write fails.

## 7. Testing

Per `docs/TESTING.md`: test-first, one rule per test, real Postgres for anything that touches the
server, no mocks. The web package's split (node-environment store tests against a **real** server,
happy-dom DOM tests selected by the `// @vitest-environment happy-dom` docblock) is kept.

**`web` — store (`session.test.ts`, against a real server)**
- A `kind: "id"` session loads a Weave from a stored participant token: threads, participants,
  events and the stream all arrive, with **no secret anywhere in the test**.
- The same Weave loaded by secret and by id produces the same `weave`/`threads`/`participants`.
- A `kind: "id"` session on the **Lobby** loads the requests board with a participant token
  (the §2.2 claim, proven end to end).
- No stored entry → `status: "no-credential"`, and no HTTP call was made.
- A stored token that does not resolve → `no-credential` **and** the entry is gone.
- A network failure during load → `status: "error"` and the entry is **kept**.
- Mutations on a token session (post, create thread) use the stored token.
- `needsName` is never raised on a token session; `join()` rejects.

**`web` — storage (unit)**
- `storedWeaves()` reads both shapes and discriminates correctly (a 43-char legacy remainder vs a
  `weave:<uuid>` one).
- Migration writes the id entry before removing the legacy key; an interrupted migration leaves a
  duplicate and the next pass converges.
- A corrupt JSON value is skipped, not fatal (today's behaviour, kept).
- `targets()` over a mixed store: id entries make one call, legacy entries two, one failing entry
  does not cost the others.

**`web` — DOM (`components.test.tsx`, happy-dom)**
- `/`: join form shown with no Lobby entry; **Open the Lobby** shown with one.
- Name validation matches core's rule at the boundaries (`a`, 32 chars, 33 chars, a space, `@`).
- `name_taken` renders the friendly message and keeps the typed name.
- My Weaves renders from storage **with no fetch**; ordering; the archived and Lobby badges; a
  stale row's Forget button; Copy link only where a secret is held.
- Lobby summary shows title only without a token and counts with one.
- Create form: 403 renders the keepers-only message; a 201 renders the save-this-link panel, the
  entry is written **before** the panel appears, and **Open the Weave** points at `/weave/<id>`.
- `/weave/<id>` with no credential: the Lobby id renders the join form, another id renders the
  explanation.

**`server` (`static.test.ts`)**
- `index.html` is served for `/`, `/lobby`, `/lobby/`, `/weave/<uuid>`, `/weave/<uuid>/`.
- Unknown paths and `/assets/missing.js` still answer the JSON 404 (existing test, unchanged).
- The API-only app (no `webDist`) answers the JSON 404 for all five paths.

**No new `core`, `client`, `cli`, `mcp-tools` or `claude-channel` tests** — none of those packages
changes.

**Manual smoke (TESTING.md).** A fifth smoke test, short: from a clean browser profile, open `/`,
join the Lobby by name, confirm the address bar never shows a secret, open a request from the Lobby
page, create a Weave from `/`, copy the link, reopen `/` in a new tab and confirm My Weaves lists
both.

## 8. Docs to update

| Doc | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` §9 | the route table (`/`, `/lobby`, `/weave/<id>`, `/w/<secret>`), the `target` union and where the read credential comes from, the new storage key shape; "no router" becomes "no router library — path matching in `app.tsx`" |
| `docs/SECURITY.md` §8 | the `localStorage` bullet: new key shape, and that an entry may carry a Weave secret |
| `docs/SECURITY.md` §9.9 | narrow to `/w/<secret>` links; note that token-loaded pages carry a uuid, which is not a credential |
| `docs/SECURITY.md` §4a or §9 | a public landing page makes the public Lobby join *discoverable*; §9.1 (no rate limiting) is the thing that gets more pressing |
| `docs/TESTING.md` | the `web` and `server` rows; the new manual smoke test |
| `docs/KNOWN-ISSUES.md` | any row the implementation leaves behind (e.g. the un-cursored count in §4.4, if it is not already covered by the `listRequests` row) |
| `README.md` | "open the instance URL" as the way in, beside `/w/<secret>` |
| `v2-notes.md` | annotate the web-main-page idea with a link to this spec |

## 9. Implementation order

Task-sized steps; each ends green, and each is a plausible subagent task.

1. **Storage shape.** New entry type, `storedWeaves()` over both shapes, a `migrateLegacy` helper,
   read/write helpers keyed by id. Unit tests. No other package touched.
2. **Session `target`.** Replace `secret: string` with the union; `reader`/`weaveId` resolution;
   `no-credential` status and the 401/403-removes-entry rule; `join()` guard; `targets()` over the
   new shape; write the display cache on load and join. Store tests against a real server.
   `/w/<secret>` behaviour must be bit-for-bit unchanged — the existing tests are the guard.
3. **Server routes.** The five `c.html(indexHtml)` lines and the `main.ts` boot wording.
   `static.test.ts` additions.
4. **Router + `<WeaveView/>`.** Split today's `Weave` out of `app.tsx`, add the `/weave/<id>` and
   `/lobby` paths, the `no-credential` branch and the not-joined-Lobby fork. DOM tests.
5. **Main page shell.** Layout, the four independent cells, instance guidelines, Lobby summary
   (title only / counts with a token). DOM tests.
6. **Join the Lobby.** Shared `NAME_RE` constant (and `NamePrompt` switched to it), the form, the
   error map, the already-joined branch. DOM tests.
7. **My Weaves.** Render-from-cache, lazy bounded refresh, ordering, filter, stale rows, Copy link,
   Forget. DOM tests.
8. **Create a Weave.** Form, 403 branch, the save-this-link panel, entry written before the panel.
   DOM tests.
9. **Docs** (§8) in one commit.

Steps 1–3 are the load path and are independent of 5–8; 4 is the join between them.

## 10. Open questions and assumptions

Stated as assumptions so implementation is not blocked. Paw should confirm 1, 3 and 6.

1. **No new public read for Lobby counts** (§4.4, option 1). Assumed: anonymous visitors see the
   Lobby's title only; counts appear once this browser holds a Lobby token. If Paw wants a livelier
   anonymous landing page, option 2 is a small core change to `getLobby` — but it moves activity
   metadata to the anonymous side of SECURITY §4a's line, permanently.
2. **Full page navigation, no client-side router** (§3.1). Assumed; revisit with the layout
   overhaul.
3. **The landing page ships ungated.** Assumed: no `settings.publicLanding` switch, because
   everything `/` exposes anonymously is already anonymous over the API on the same host. If a
   tunnelled instance should present a blank front door, that is a setting and a core change, and it
   belongs in its own task.
4. **Creation is always offered, `403` surfaced in place** (§4.5), rather than making
   `openWeaveCreation` publicly readable.
5. **The created Weave's secret is kept in the storage entry** so the share link stays copyable, and
   the address bar never carries it for a token-loaded page (§4.5, §5).
6. **Legacy `loom:<secret>` entries are migrated lazily and never deleted before their replacement
   is written** (§2.4). Assumed rather than a one-shot migration at startup, so a browser whose
   server is briefly unreachable loses nothing.
7. **`kind` is fixed to `"human"` on both forms** (§4.1, §4.5). An agent joins with its key.
8. **Deferred niceties, deliberately not in scope**: a "paste a Weave link" field on `/`, a QR code
   for a `/w/<secret>` link, remembering a display name across forms beyond the Lobby identity, and
   any per-Weave notification state. Each is a line of UI and a new thing to test; none is needed to
   close the gap this spec exists for.
