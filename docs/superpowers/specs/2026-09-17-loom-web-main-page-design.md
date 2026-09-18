# Loom v2 — Web main page: joining the Lobby from a browser

Date: 2026-09-17
Status: spec, ready for review and planning. No implementation yet.
Sub-project: "A web main page" in the v2 breakdown (see `v2-notes.md`). Builds on v1
(`2026-09-10-loom-v1-design.md`), sub-project 2 (`2026-09-15-loom-v2-guidelines-design.md`) and the
Lobby (`2026-09-16-loom-lobby-design.md`); everything not mentioned here is unchanged.
Found by the Lobby manual smoke test of 2026-09-17 (`v2-notes.md`, "Lobby smoke test 2026-09-17").

> **Revised after spec review (2026-09-17).** Two findings, both about losing a credential the
> browser had already been given, are folded into the text rather than appended:
>
> 1. **Persisting a credential is now an observable result, not an assumption.** `set` returns
>    `"durable" | "memory"`, migration keeps the legacy key until the replacement is confirmed
>    durable, and a join or a creation whose credential did not persist **does not navigate** — the
>    destination is rendered in the same JS context instead (§2.4, §3.1, §4.1, §4.5, §6).
> 2. **An invalid participant identity no longer deletes the Weave's secret.** The identity is
>    cleared, the `secret` and the display cache are kept, and a token load that finds a stored
>    secret falls back to reading with it and offers a rejoin (§2.4, §2.6, §3.3, §4.2).
>
> **Second review round (2026-09-17).** Secret preservation was accepted; two gaps in the
> persistence work were not, and both are closed in the text below:
>
> 3. **One app-owned storage instance.** Staying in the same JS context is not enough on its own:
>    `useSession` builds a fresh `browserStorage()` for every session it creates
>    ([`useSession.ts:9`](../../../src/web/src/useSession.ts)) and each one owns a **separate**
>    memory fallback ([`storage.ts:15-16`](../../../src/web/src/storage.ts)), so the in-place
>    transition would hand the new session a store that does not hold what the form just wrote.
>    §2.4a makes a single instance, created at the app root and passed down, an invariant
>    (§3.1, §7, §9).
> 4. **A failed write now wins over a stale persisted value.** `get` prefers `localStorage`
>    ([`storage.ts:19`](../../../src/web/src/storage.ts)), so a *failed update to an existing key*
>    read back the old value — which would resurrect an identity just marked `identity: "invalid"`,
>    or hide a fresh rejoin token behind the dead one. §2.4b adds a pending-override layer with a
>    precise precedence rule (§2.6, §6, §7).
>
> **Planning review (2026-09-18).** Four points the plan needed and this text did not settle:
>
> 5. **Which entry wins when a legacy and an id entry describe the same Weave** — the id entry, and
>    an invalidated one never takes a legacy identity (§2.4).
> 6. **A bookmarked `/w/<secret>` migrates its own legacy key** before resolving an identity, so a
>    browser that joined before this work is not treated as a stranger (§2.4).
> 7. **`/weave/<lobbyId>` offers the join form too**, not only `/lobby` (§3.3).
> 8. **Creation persists one complete entry**, and the save-this-link panel branches on that one
>    verdict (§4.5). My Weaves refreshes a row with the same credential the session would pick
>    (§4.2).
>
> **Second planning review (2026-09-18).** Two more, both about My Weaves:
>
> 9. **What the list shows follows what storage holds.** One page-scoped change signal, bumped by
>    every writer that can change a row, is what makes a finished migration, a refreshed title, an
>    invalidated identity, a **Forget** or a creation appear without the human doing anything (§4.2).
> 10. **My Weaves reports its own failed writes.** A refresh's title write and its identity
>     invalidation each carry a `WriteResult` to the one-time notice; without it a row can show an
>     invalid identity while durable storage still holds the old token, and say nothing (§4.2, §6).
>
> **Third planning review (2026-09-18).** One, again in My Weaves:
>
> 11. **"At most six requests in flight" is a bound on the browser, not on a batch.** The list
>     recomputes its visible rows on "Show more", on each filter keystroke and on every change signal
>     bump, so a bounded batch started per recompute lets each new one add six more beside the six
>     still running. The bound now belongs to **one scheduler per mounted list** that outlives every
>     render, rows that become visible later queue behind rows already waiting, and the secret retry
>     of §2.6 reuses its row's slot (§4.2, §7).
>
> **Corrected during implementation (2026-09-18).** This document stays the record of what was
> built, so four things the tasks settled are folded into the text rather than appended:
>
> 12. **The entry gained a `name`** — the name this browser joined under, a display cache written
>     with the identity and deleted with it. §4.1's "You are in the Lobby as `dana`" and §4.2's
>     "joined as `dana`" both claim to render from storage with no network, and nothing in the entry
>     carried a name (§2.4, §2.6).
> 13. **The one-time notice renders on Weave pages as well as on `/`.** The in-place transition of
>     §3.1 replaces the main page — and its bar — with a Weave page in the same render, so a bar that
>     lived only in the main page's layout was invisible in exactly the case it exists for (§6).
> 14. **My Weaves has a fifth row state and a manual copy fallback**: `"unresolved"` for a legacy
>     entry no lookup has turned into a Weave id yet, and — when the clipboard is missing or refuses —
>     one selectable link field with a **Hide** button, at most one open at a time (§4.2).
> 15. **An unknown path says "No such page."** rather than reusing the old "Open a Weave link" card,
>     which stopped existing when `/` became a real page (§3.1).

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
   token under the Lobby's **id**, confirms the write actually persisted, and navigates to `/lobby`.
   (Had it not persisted, the Lobby would be rendered in this same tab instead — §3.1.)
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
before joining. So a session *reading with a token* always has an identity and never raises
`needsName`. The converse is what makes §2.6's fallback work: when the identity is gone but the
entry still holds a secret, the page can go on reading and offer a join — a token load degrades
into the secret load, not into nothing.

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
                   entry    = storage entry for that weaveId    — required
                   reader   = client.withToken(entry.token)     when the entry has a usable identity
                            = client.withToken(entry.secret)    when it does not but holds a secret (§2.6)
                            = none → status "no-credential"     when it holds neither
```

So `reader` is *the secret when there is one, the stored participant token otherwise*. Everything
downstream of `reader` and `weaveId` — backfill, metadata, requests, stream, watermarks, retry —
is untouched. `useSession(target)` memoizes on the target's discriminant + value, exactly as it
memoizes on `secret` today.

Why C over B: the union is the thing the *router* already knows (a path is one shape or the other),
and it makes the "no credential" case a state the UI can render rather than a failed fetch.

### 2.4 Storage: key shape, durable writes, coexistence, migration

Today: `loom:<secret>` → `{"token","participantId"}`, and
[`storedWeaves()`](../../../src/web/src/storage.ts) returns `{ secret, token }` for every key with
the `loom:` prefix.

#### A write must say whether it persisted

`KeyValueStorage.set` returns `void` today, and `browserStorage().set` swallows every failure:

```ts
set: (k, v) => { try { ls()?.setItem(k, v); } catch { /* quota or blocked */ } fallback.set(k, v); },
```

([`storage.ts:20`](../../../src/web/src/storage.ts)). The `fallback` is one `memoryStorage()` map
per JS context ([`storage.ts:16`](../../../src/web/src/storage.ts)), and `get` reads
`ls()?.getItem(k) ?? fallback.get(k)` ([`storage.ts:19`](../../../src/web/src/storage.ts)) — so a
caller cannot tell a persisted write from a tab-lifetime one, and **a read-back through `get` would
not tell it either**, because the memory fallback answers. That is a real hole once §3.1 navigates
with a full page load: `joinLobby` succeeds server-side, the token lands only in memory, the
navigation destroys the JS context, the destination has no credential, and the obvious retry
answers `name_taken`.

So the interface gains a result:

```ts
export type WriteResult = "durable" | "memory";

export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): WriteResult;   // was void
  remove(key: string): void;
  keys(): string[];
};
```

- **`browserStorage().set`** attempts `localStorage.setItem`, then **verifies by reading back from
  `localStorage` itself** (never through `get`, for the reason above): `"durable"` when
  `localStorage.getItem(k) === v`, `"memory"` otherwise. The memory fallback is written either way,
  so behaviour on the happy path is unchanged. Read-back rather than "it did not throw", because a
  blocked or full store can accept the call and keep nothing, and the extra synchronous read runs a
  handful of times per page.
- **`memoryStorage(opts?: { durable?: boolean })`** reports `"durable"` by default: when it *is* the
  whole store — which is how the tests use it — a write really does last as long as the store. The
  fallback inside `browserStorage` constructs `memoryStorage({ durable: false })`, and in any case
  `browserStorage.set` returns its own verdict rather than the fallback's. `memoryStorage({ durable:
  false })` is what the blocked-storage tests of §7 use.
- Every write goes through one helper, `saveWeaveEntry(storage, weaveId, entry): WriteResult`, so
  there is a single place that knows the key shape and a single place that returns the verdict.

`remove` keeps returning `void`. Nothing downstream branches on a failed removal, because §2.4b
makes a failed removal *read* as absent anyway; and the one caller that might have cared —
migration — only removes the legacy key after the replacement is already durable, so a removal that
does not stick costs one repeated migration attempt on the next page load and nothing else.

#### 2.4a One storage instance, owned by the app

Today [`useSession.ts:9`](../../../src/web/src/useSession.ts) constructs the store inside the memo
that builds the session:

```ts
const client = new LoomClient({ baseUrl: location.origin, … });
return createSession({ client, secret, storage: browserStorage() });
```

and every `browserStorage()` closes over a **`memoryStorage()` fallback of its own**
([`storage.ts:15-16`](../../../src/web/src/storage.ts)). Two consequences, both fatal to §3.1's
in-place transition if left alone: a target change rebuilds the memo and therefore the store, and
the main page's forms would have a third store again. A credential written non-durably by the Join
form would sit in the form's memory map while the new session reads an empty one — same JS context,
different fallback, credential gone. The in-place render would then be worse than the navigation it
replaced, because it would *look* like it worked.

> **Invariant: `browserStorage()` is called exactly once in the whole web package, at the app root,
> and the instance it returns is passed to everything that touches storage.**

- It is created in [`main.tsx`](../../../src/web/src/main.tsx) — the entry that already does the one
  root-level construction — and handed to the app: `render(<App storage={browserStorage()} />, …)`.
  A module-scope singleton inside `storage.ts` would be fewer lines and worse: invisible at the call
  sites and impossible for a DOM test to substitute.
- `App` passes it to the main page's forms (Join the Lobby, Create a Weave), to My Weaves and its
  `storedWeaves()` read, and to `useSession(target, storage)` → `createSession({ client, target,
  storage })`. `useSession`'s memo keeps depending on the **target**; the storage comes from outside
  the memo and therefore survives every target change.
- The open-request target picker needs nothing new: `RequestsPanel` does not import storage at all
  — it calls `session.targets()`, and [`session.ts:533`](../../../src/web/src/session.ts) is the
  only caller of `storedWeaves()` in the package. It inherits the shared instance with the session.
- Tests keep injecting `memoryStorage()` exactly as they do today (28 call sites in
  `src/web/test/session.test.ts`), and DOM tests mount `<App storage={memoryStorage()} />`.

§7 adds a guard test so the invariant cannot rot: `browserStorage(` occurs exactly once in
`src/web/src` outside `storage.ts`.

#### 2.4b Read precedence: a failed write beats a stale persisted value

`get` prefers `localStorage` and falls back to memory only when the key is absent there:

```ts
get: (k) => { try { return ls()?.getItem(k) ?? fallback.get(k); } catch { return fallback.get(k); } },
```

([`storage.ts:19`](../../../src/web/src/storage.ts)). That is right for a key that was never
persisted and wrong for a key that **was**. If an entry is already durable and an update to it fails
— the store filled up, or site data was turned off mid-session — `set` now honestly reports
`"memory"`, but the next `get` still answers with the *old* durable value. Two concrete harms, both
in paths this spec introduced: §2.6 marks an identity `identity: "invalid"`, the write fails, and
the next read **resurrects the dead token**, so the page tries it again and again; or a rejoin
issues a fresh token, the write fails, and the new token is hidden behind the dead one.

So `browserStorage` keeps a **pending-override layer**: a per-instance `Map` of the keys whose last
write or removal did not reach `localStorage`, holding either the value that should have been stored
or a **tombstone** for a removal that did not stick.

> **Precedence.** A key with a pending override is answered from that override — value, or `null`
> for a tombstone — ahead of `localStorage`. Every other key keeps today's order: `localStorage`
> first, then the memory fallback. The invariant this buys, and the one to hold the implementation
> to: **whatever verdict a write returns, the value it just wrote is what `get` returns for the rest
> of this page.**

Mechanically:

| Call | Behaviour |
| --- | --- |
| `set(k, v)` | write the memory fallback; attempt `localStorage.setItem` and verify by read-back. Verified → **delete** any override for `k`, return `"durable"`. Not verified → **set** the override to `v`, return `"memory"` |
| `remove(k)` | remove from the memory fallback; attempt `localStorage.removeItem` and verify it is gone. **Confirmed** gone → delete any override. Still there, **or not consultable** → set the override to the **tombstone** |
| `get(k)` | override first (tombstone → `null`), else `localStorage`, else the memory fallback |
| `keys()` | today's union of `localStorage` and fallback keys ([`storage.ts:22-28`](../../../src/web/src/storage.ts)), **plus** every override key, **minus** every tombstoned key |

- **`WriteResult` and the override are the same fact.** `"memory"` means "an override now exists for
  this key"; `"durable"` means "no override exists for this key" — any earlier one has just been
  cleared. A caller never has to ask the store which keys are overridden; the verdict of its own
  write is the whole answer it needs.
- **Retry is opportunistic and narrow**: the only thing that ever clears an override is a later
  successful `set` or `remove` **of that same key**, which already attempts `localStorage`. There is
  no background retry loop, no timer, and `get` stays side-effect-free — a read must not write. A
  browser whose store frees up mid-session recovers the first time the key is written again, which
  for an identity is the next join, rejoin or invalidation.
- **Overrides live exactly as long as the page.** They are per `browserStorage` instance, which by
  §2.4a means one per page load. A reload starts from `localStorage` alone, which is the honest
  state: whatever did not persist is gone.
- **Cross-tab: no sync, and none needed.** Another tab has its own instance and still reads the
  stale durable value; there is no `storage`-event listener and none is in scope. For the case that
  matters — an identity invalidated in this tab whose write did not persist — the other tab simply
  presents the same dead token, receives the same `401`, and performs the same invalidation itself
  (§2.6). It converges on its own, one failed request later. The same is true in reverse for a
  rejoin: the other tab keeps the old token until its next load, then converges.
- **A store that cannot be consulted confirms nothing.** The read-back is three-valued: a value or
  "absent" only from a *successful* `localStorage.getItem`, and "unknown" whenever the store is
  missing or throws. "Unknown" must never be read as "absent" — that is what would let a failed
  removal drop its tombstone and the value reappear the moment storage came back.
- **`memoryStorage` needs no override layer** — it is the whole store, so the invariant above holds
  trivially, in both `durable: true` and `durable: false` modes.

**How this meets migration.** §2.4's rule is that the legacy key stays until the id-keyed
replacement is confirmed durable. With overrides the two halves are now both well defined: on a
`"memory"` verdict the new entry is **readable for this page** (through its override) *and* the
legacy key is still there for the next one. Nothing is lost either way, and the page does not have
to choose between a readable copy and a durable one.

#### The entry

```
loom:weave:<weaveId>  →  { token?, participantId?, name?, identity?: "invalid",
                           secret?, title?, archived?, lastOpenedAt? }
```

- `weaveId` is a uuid, so the key is unambiguous against the legacy one: a legacy key's remainder
  is a 43-character base64url secret and **never contains a colon**. `storedWeaves()` discriminates
  on that, with no version field and no migration flag.
- `token` + `participantId` are this browser's **identity** in that Weave. Both are optional,
  because an entry can exist without one: a `/w/<secret>` visit writes (or updates) an entry with
  its `secret` and display cache **before** anyone joins, so a Weave this browser can read but has
  not joined still appears in My Weaves. `join()` fills the two fields in.
- `name` is the name this browser is joined under in that Weave — a display cache like `title`,
  never a credential and never sent anywhere. It is what lets "You are in the Lobby as `dana`"
  (§4.1) and a row's "joined as `dana`" (§4.2) be rendered from storage alone, with no request. It
  belongs to the identity, so it is written with it and deleted with it: `setIdentity` carries it
  beside `token`/`participantId` in the one write (join, create and rejoin all go through that), a
  successful load caches it in the existing ready-path save once `me` resolves — which is how an
  entry written before this field existed, or adopted from a legacy key, acquires one — and
  `invalidateIdentity` deletes it alongside them, so an invalidated row never claims a name.
- `identity: "invalid"` marks an identity that was there and stopped working (§2.6). It is what
  distinguishes "never joined from this browser" (no identity fields, no marker) from "joined, then
  the credential failed" — the UI says different things about the two. When it is set, `token`,
  `participantId` and `name` are **deleted**: a credential known to be dead is not worth keeping in
  storage, and a name is a fact about that identity rather than about the Weave.
- `secret` is present only when this browser knows it (opened via `/w/<secret>`, or created the
  Weave here). It is an **independent credential**: it keeps the shareable link retrievable after
  the creation panel is gone (§4.5), it is the read fallback of §2.6, and **no identity failure ever
  deletes it**.
- `title`, `archived` are a **display cache** written on every successful load/join/create. They are
  what lets My Weaves render with zero network calls (§4.2). They are never trusted for anything
  but display.
- `lastOpenedAt` orders My Weaves.

#### Coexistence and migration

Legacy `loom:<secret>` entries exist in real browsers (Paw's included) and must not be lost.

- `storedWeaves()` returns a union: `{ kind: "id", weaveId, token?, participantId?, identity?,
  secret?, … }` or `{ kind: "legacy", secret, token }`. Every consumer handles both, and a consumer
  that needs a usable identity (`targets()`, the writer path) skips entries that have none.
- Migration is **lazy and non-destructive**. Two triggers:
  1. a `/w/<secret>` session load, which learns the id anyway. It runs **before** the session
     resolves an identity, because for a browser that joined before this work the legacy key *is*
     the identity: without it, a bookmarked link comes back as a stranger and the name prompt asks
     for a name that browser already has.
  2. the main page, which resolves legacy entries with the **public**
     `GET /api/weaves/:secret/lookup` to build My Weaves.
- **The id entry is authoritative when both exist.** Duplicates are a supported state (the
  non-durable path below leaves one on purpose), so the merge is a rule rather than an overwrite: an
  id entry with a usable identity **keeps** it; an id entry marked `identity: "invalid"` **never**
  takes the legacy identity; an id entry with neither **adopts** it; and a missing `secret` is
  carried over in every case. The middle rule needs its reason stated: invalidation deletes the dead
  token without recording it, so nothing can tell whether the legacy token *is* that token, and
  adopting it would send the session back into the `401` it just survived. A blind merge would also
  let a leftover legacy key undo a rejoin.
- **The legacy key is removed only when the id-keyed write returns `"durable"`.** On `"memory"` the
  legacy key stays exactly as it is — it is still the durable copy — and the in-memory entry is used
  as-is for the life of the page. Removing a durable key in favour of a copy that exists only in
  memory is precisely the quota-failure hole this rule closes.
- **No rewrite storm.** Migration is attempted at most once per Weave per page load, and a
  `"memory"` verdict sets a page-scoped `storageNotPersisting` flag that suppresses further attempts
  for every Weave and raises the one-time notice of §6. Nothing retries on an interval, and nothing
  retries on a re-render.
- A legacy entry whose lookup fails is **left alone** and shown as unavailable (§4.2). Nothing is
  deleted on a failed read: a server that is down for a minute must not cost a browser its
  identities.
- Writing the new entry before removing the old one means a crash between the two leaves a
  duplicate, not a loss — and the non-durable path leaves one deliberately. **My Weaves folds
  duplicates**: a legacy entry is folded into an id entry when their `secret` matches, or failing
  that when their `token` matches, and the id entry wins. So the degraded mode shows one row, not
  two.

`session.join()` and the creation form write the id-keyed shape only. No code writes a legacy key
after this lands.

### 2.5 `targets()` gets simpler

[`targets()`](../../../src/web/src/session.ts) currently does `lookupWeave(secret)` then
`getWeave(id)` per stored Weave. Over the new shape an id entry skips the lookup entirely — one
request instead of two — and a legacy entry keeps both. The per-entry `try/catch` that lets one
unreachable Weave not cost the picker the others stays exactly as it is.

One rule is added: an entry with no usable identity is **skipped**. A request's `targetCredential`
has to pass `assertIsKeeperOf` in the target Weave ([`actors.ts`](../../../src/core/src/actors.ts)),
and a Weave secret resolves to `{ kind: "secret", weaveId }`, which that check refuses. So a Weave
this browser can read but has not joined is not a target it can offer, and saying so by omission is
the same answer the existing `catch` gives.

### 2.6 Failure modes on a token load

A participant token and a Weave secret are **two independent credentials**. A token that stopped
working says nothing about a secret, so nothing here ever deletes one.

| Situation | Server answer | What happens to the entry | Session state | UI |
| --- | --- | --- | --- | --- |
| No storage entry for this id | — (no call made) | — | `no-credential` | §3.3: the Lobby offers the join form; any other Weave explains how to get in |
| Entry has no identity but holds a `secret` | reads succeed **with the secret** | untouched | `ready`, read-only until joined | the Weave, plus "you are reading with the Weave link" and a Join button |
| Token no longer resolves | `401 invalid_token` on the first `getWeave` | `token`/`participantId`/`name` **deleted**, `identity: "invalid"` set; `secret`, `title`, `archived`, `lastOpenedAt` **kept** | retry with `entry.secret` if there is one → `ready` read-only; otherwise `no-credential` | "Your identity in this Weave is no longer valid." Then either the Weave read-only with a Join button, or a link back to `/` |
| Token belongs to another Weave | `403 forbidden` | same | same | same |
| Entry's `participantId` is not in `participants` | reads succeed | same | same — the reads already succeeded, so a secret fallback is not even needed unless the token was the reader | "Your identity in this Weave is no longer valid", read-only, Join offered |
| Weave id unknown / malformed | `404 weave_not_found` | untouched (shown as unavailable in My Weaves) | `error` | "Weave not found" (as `/w/<secret>` says today) |
| Transient network failure | — | untouched | `error` (existing path) | existing retry/`refreshError` behaviour, unchanged |

**Rejoining self-heals.** A read-only page reached this way offers the ordinary name prompt; the
secret path already supports `join()` ([`session.ts`](../../../src/web/src/session.ts)), and a
successful join writes fresh `token`/`participantId`/`name` into the **same** entry and clears
`identity: "invalid"`. So the degraded state is a step on the way back, not a dead end.

**Both of those writes are updates to a key that already exists**, which is exactly the case §2.4b
exists for: whether the invalidation and the rejoin reach `localStorage` or only the override layer,
the value this page reads back is the new one. Without that rule the invalidation would be undone by
the next `get` and the fresh token would be hidden behind the dead one — the session would loop on a
credential it has already proven unusable.

Three deliberate asymmetries:

- A **401/403 invalidates the identity** — that credential is provably unusable — while a network
  error invalidates nothing. Today participant tokens cannot be revoked at all (SECURITY §9.4), so
  401 in practice means a wiped database or corrupted storage; the branch is cheap and it is the
  branch that will matter the day revocation exists.
- A failed identity **never touches `secret`**. Deleting the whole entry, as an earlier draft did,
  would in the worst case destroy this browser's only copy of a just-created Weave's secret (§4.5)
  and cost read access, the share link and the way back in — all on the strength of an unrelated
  credential failing.
- An entry with an invalid identity **and** no secret is **kept**, not removed, and shown as an
  unavailable row with a **Forget** button (§4.2). Removing it would silently erase the only record
  that the Weave exists — its cached title is what lets the human ask its keeper for a link. The
  user's list is theirs to prune.

A new `status: "no-credential"` is preferred over `status: "error"` plus a string, because the app
must *branch* on it (render a join form, not an error), and an error message is not a contract.
`SessionState.status` becomes `"loading" | "ready" | "error" | "no-credential"`. `SessionState`
also gains `readOnlyReason?: "secret-fallback"`, so the page can explain why the composer needs a
join without inferring it from the absence of `me`.

### 2.7 How the two routes converge

```
/w/<secret>     →  useSession({ kind: "secret", secret })  →  createSession  ┐
/weave/<id>     →  useSession({ kind: "id", weaveId })     →  createSession  ├→ the same <WeaveView/>
/lobby          →  getLobby() → id → the /weave/<id> path                    ┘
```

`<WeaveView/>` is today's `Weave` component, unchanged apart from the `no-credential` branch and the
read-only banner of §2.6. Note that a `kind: "id"` session can end up reading with a secret (§2.6),
which is a credential choice inside the session, not a second code path: the two targets still
converge on one `load()`. The Lobby page is not special: it is `/weave/<lobby id>` with a friendlier
URL, and the requests panel
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
| `/weave/<uuid>` | any Weave this browser holds a credential for | `{ kind: "id", weaveId }` |
| `/w/<43-char secret>` | unchanged | `{ kind: "secret", secret }` |
| anything else | a card saying "No such page." with a link to `/` | — |

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

#### The one exception: a credential that did not persist

A full page load destroys the JS context, and with it the memory fallback that holds a credential
whose durable write failed (§2.4). So the rule has a precise exception:

> **After a join or a creation, navigate only if the credential write returned `"durable"`. On
> `"memory"`, render the destination in place, in the same JS context, and leave the URL alone.**

`App` keeps the current target in `useState`, seeded from `location.pathname`; the in-place switch
sets that state to `{ kind: "id", weaveId }` and `useSession` rebuilds the session on the new target,
exactly as it does on a mount. That is the whole mechanism — a few lines, not a router, and it is
reached only in the degraded mode.

**It only works because of §2.4a.** The session is rebuilt, but the **storage instance is not**: it
is created once at the app root and passed in, so the credential the form wrote a moment ago —
possibly only into that instance's memory fallback and override layer — is the same one the new
session reads. With today's `browserStorage()` inside `useSession`'s memo
([`useSession.ts:9`](../../../src/web/src/useSession.ts)) the rebuilt session would get a fresh,
empty fallback and the transition would silently produce a credential-less page. §7 tests the
outcome (a *writable* destination), not the absence of a navigation, for exactly this reason.

**The URL is deliberately not updated** — no `history.pushState`. Pushing `/lobby` would put an
address in the bar that this browser cannot honour: a reload, a restored tab or a copied link would
land on a credential-less `/lobby`, offer the join form again and answer `name_taken` — the exact
failure the exception exists to prevent. An address bar still reading `/` is an honest signal that
this view is alive only as long as the tab is. The page says so, once, through the notice of §6.

The alternative — stay on `/` and show a recovery panel with the credential to copy — is **rejected
for the join** and **already the design for the creation**:

- **Join the Lobby.** The durable artefact would be a participant token, and there is no UI anywhere
  in the web client that accepts a pasted token (§10.8 keeps a paste-a-credential field out of
  scope). Showing one would be a string the human can do nothing with. Rendering the Lobby in place
  gives them a working session for the tab, which is the most that can honestly be offered; the cost
  of losing it is a name, not access, because the Lobby join is free and secretless (SECURITY §4a).
- **Create a Weave.** Here the recovery panel *is* the design already: §4.5 shows the
  `/w/<secret>` link and does not navigate. On `"memory"` that panel does not become optional — it
  hardens. Losing a secret is the worse loss, and the link is a credential a human genuinely can
  save, so the panel stays on screen, the warning is stronger, and **Open the Weave** renders in
  place rather than navigating.

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

### 3.3 `/weave/<id>` with no usable credential in this browser

"No token" is not the same as "no credential": an entry may hold a `secret` and no identity, or an
identity that has been invalidated (§2.6). The fork is on what the entry still has.

- **The entry holds a `secret`** → not this branch at all: the page loads read-only with the secret
  and offers a join (§2.6).
- **No credential at all, and it is the Lobby id** → the same Join-the-Lobby form as `/` (§4.1),
  because joining needs no secret. On success, load **in place** — this is already the same JS
  context, so the credential written by the join is the one the view uses, durable or not.

  This holds for `/weave/<lobbyId>` as much as for `/lobby`. A direct link carries no discovery of
  its own, so the page cannot know the id is the Lobby's until it asks: it resolves the public
  `GET /api/lobby` **on this branch only** — a page that loaded fine never makes the call — and
  compares. One code path, two ways in.
- **No credential at all, any other Weave** → a short explanation: this browser holds no key for
  that Weave, and the two ways in are the `/w/<secret>` link its keeper can send, or a Lobby request
  that ends in an invitation. Plus a link to `/`. Deliberately no "paste a secret" field — see
  §10.8.

## 4. The main page (`/`)

One column, four sections in this order, each independent: a failure in one never blanks another
(the same discipline `refreshInfo` already applies to the instance guidelines and the requests).

### 4.1 Join the Lobby

Shown when this browser holds no **usable identity** for the Lobby's id — no entry, or an entry
whose identity is missing or `"invalid"` (§2.4).

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
- **Write the entry, then branch on the result** (§2.4, §3.1): `"durable"` → navigate to `/lobby`;
  `"memory"` → render the Lobby in place, leave the URL on `/`, and raise the notice of §6. The
  order matters — the credential is persisted before anything that could destroy this JS context.
  The form writes through the **app's** storage instance (§2.4a), which is the same one the Lobby
  session then reads; on the `"memory"` path that is the only reason the destination is usable.

Errors:

| Code | HTTP | Shown as |
| --- | --- | --- |
| `name_taken` | 409 | see below |
| `validation` | 400 | the server's message (the client regex should have caught it; a mismatch is a bug worth seeing) |
| `weave_not_found` | 404 | "This instance has no Lobby yet." — the pre-`ensureLobby` case |
| network | — | "Could not reach the server." with a retry; the typed name is never lost |

**`name_taken`, including for a browser that already lost its token.** The message has to cover two
cases the server cannot tell apart, because `joinWeave` reports only that the per-Weave unique name
index was violated ([`weaves.ts`](../../../src/core/src/weaves.ts)): someone else has the name, or
*this human* joined under it earlier from a browser that did not keep the token. So:

> "**`dana`** is already in the Lobby. If that was you from a browser that did not save its key,
> that identity cannot be recovered — pick another name. Try **`dana-2`**?"

The suggestion is a plain client-side first-free-suffix guess (`-2`, `-3`, …, kept inside the 32
character limit), offered as a button that fills the field; it is **not** auto-submitted, and it
makes no extra server call to check availability — a failed guess just re-runs the same error, which
is honest and costs one request. **No server change is justified here.** A "reclaim my name" path
would have to prove the claimant is the earlier participant, and the only proof that exists is the
token that was lost; anything weaker would let anyone take over a Lobby identity by name, which is a
strictly worse trade than asking for a new name. Note also that on this instance a lost Lobby name
costs a label, not access: the Lobby join is free and secretless (SECURITY §4a), so a new name is a
complete recovery.

**Already joined** (a usable identity for the Lobby) → the form is replaced by **Open the Lobby**, a
link to `/lobby`, with the name this browser joined as ("You are in the Lobby as `dana`"). No second
join is offered: core would answer `name_taken` on the same name and would silently create a
*second* identity on a different one, which is worse. An entry whose identity is `"invalid"` is not
"already joined" — it shows the form, with a line saying the previous identity stopped working.

### 4.2 My Weaves

Every Weave this browser holds a credential for — the Lobby included — as a **list**, not cards.
Per Paw's scale note, this has to survive hundreds of rows:

- **Rows render from storage with no network at all**, using the cached `title`/`archived` written
  at join/create/load time (§2.4). A browser with 300 entries paints instantly.
- Refresh is **lazy and bounded**: only rows currently on screen are re-read, at most **6 requests in
  flight in total**, and a failed row keeps its cached title with a quiet "could not refresh" marker.
  Nothing fans out 300 `getWeave` calls on page load. (This is the same pressure as the cursor-less
  `listRequests` row in KNOWN-ISSUES; it is handled here by not needing the server.) **The bound is
  total across renders, not per batch**: the list recomputes what is on screen when the human clicks
  "Show more", on each keystroke in the filter, and on every change signal below, so the six is held
  by **one scheduler per mounted list** — a FIFO with a count of active requests, living for as long
  as the list does — and not by a helper created inside whatever recomputed the slice. A bounded
  batch started per recompute is not a bound at all: three overlapping recomputes are eighteen
  requests. Rows that become visible later queue behind rows already waiting, a row that fails frees
  its slot like any other, and leaving the page drops what has not started.
- A row is refreshed with **the credential the session would have picked for it** (§2.3): the token
  when the identity is usable, the stored secret when it is not, and no request at all when the
  entry holds neither. The list deliberately contains rows for Weaves this browser has read but not
  joined, and rows whose identity has been invalidated, so assuming a token would fail precisely on
  the rows that most need their title. A `401`/`403` from a token read invalidates the identity
  exactly as §2.6 says — the secret survives — and the refresh then tries once more with it, within
  the same slot of the bound below rather than as a newly scheduled row.
- Sorted by `lastOpenedAt` descending, ties by title. A filter box appears once there are more than
  ~8 rows. Rows past ~25 are behind "Show more" — cheap now, and the shape the layout overhaul can
  replace wholesale.
- Each row: title, a badge for the Lobby, a badge for archived, the name this browser is joined as
  (from the entry's `name`, §2.4), and — when the entry carries a `secret` — a **Copy link** action
  for `/w/<secret>`. The row links to `/weave/<id>`; it does **not** link to `/w/<secret>` even when
  the secret is known, so the address bar never gains a secret it did not already have (§5).
- **Copy link must always answer.** An insecure origin has no `navigator.clipboard` at all, and a
  clipboard that exists can refuse — by rejecting, or by throwing outright. All three fall back to
  showing the link in one selectable read-only field with a **Hide** button beside it. That field is
  the one place a stored secret reaches the DOM in this list, it appears only after an explicit click
  on that row, and **only one is ever open**: clicking Copy on a second row, typing in the filter,
  pressing "Show more" or Forgetting the row closes it (§5).
- **Duplicates are folded** (§2.4): a legacy entry and an id entry that share a `secret`, or failing
  that a `token`, are one row, and the id entry wins. The degraded, non-durable migration path
  therefore still shows one row per Weave.
- **Row states**, which the entry already distinguishes:

  | Entry | Row |
  | --- | --- |
  | usable identity | normal, clickable, "joined as `dana`" |
  | `secret`, no identity (never joined, or joined via a link only) | normal, clickable, "read-only — not joined" |
  | `identity: "invalid"`, `secret` present | normal, clickable, "your identity here stopped working — open to rejoin" |
  | `identity: "invalid"`, no `secret` | greyed, not clickable, the reason, and a **Forget** button |
  | no identity and no `secret` at all | greyed, "this browser holds no key for this Weave", **Forget** |
  | a legacy entry nothing has resolved into an id yet | `"unresolved"`: the title is unknown and the row cannot be linked to — `/weave/<id>` is the only row link there is — but **Copy link** still works, and it has no **Forget** either, because `forgetWeave` needs an id |
  | refresh answered 404 | greyed, "this Weave is gone", **Forget** |
  | refresh failed on the network | cached title, a quiet "could not refresh" marker, still clickable |

  The two greyed dead ends say *why* in their own words rather than sharing one, because "the
  identity died and there was no link" and "this browser never held a credential" are different
  sentences to be told.

- **The list follows storage, and updates itself.** Rows are derived from the stored entries on every
  change, not captured once at mount. The page keeps **one change signal** beside the storage
  instance of §2.4a, and every writer that can change what this list shows bumps it: a legacy entry
  finishing migration, a refresh that writes a new `title`/`archived`, an identity invalidation, a
  **Forget**, and a creation that completes while this page stays on screen (§4.5 does not navigate).
  The list re-derives from storage on each bump. Nothing polls; `KeyValueStorage` itself does **not**
  become observable — the session and every test inject it, and that blast radius buys nothing here;
  and a bump must never restart a refresh already in flight, re-read a row already refreshed, or
  raise the number of requests in flight — it feeds the one scheduler above like every other
  recompute, so the rendered-slice rule and the total bound still hold. Without this, a migration that
  finishes a moment after the first paint leaves a legacy row unresolved on screen until the human
  reloads, and a refreshed title never appears at all.
- **Every write this list makes reports whether it persisted.** The refresh's `title`/`archived`
  write and its identity invalidation both hand their `WriteResult` to the one-time notice of §6,
  exactly as a join or a creation does. The invalidation is the case that must not be silent: the row
  says the identity is dead, §2.4b's override keeps that true for the page, and durable storage still
  holds the old token — the human is told once, rather than being left with a page and a browser that
  disagree. **Forget** is the deliberate exception and reports nothing: it is a `remove`, which
  returns no verdict, and §2.4b's tombstone rule makes it read as absent for the rest of the page
  whether or not it reached `localStorage`. The row goes and stays gone; a removal that did not stick
  costs one reappearance after a reload and no credential, which is not worth a warning.
- Nothing is removed automatically. The 401/403 rule of §2.6 clears an **identity**, never a row,
  and `Forget` is the only thing that deletes an entry. A row nobody clicked should not disappear on
  its own — the user's list is theirs.
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

- **no usable Lobby identity** → the Lobby's title and one line of explanation ("Every agent on this
  instance is here; join to see who and what is being asked for"), above the join form.
- **Lobby token held** → title, participant count, how many of those carry a profile ("listeners"),
  and the number of open requests, read with the stored token via `getWeave(lobbyId)` and
  `listRequests("open", { limit: PAGE })` — the same two reads the Lobby page itself makes.
- `weave_not_found` from `getLobby()` → "This instance has no Lobby yet", and §4.1 is hidden. That
  is the instance's own **answer**, not a failed read, so the summary takes it as a separate input
  (a `noLobby` flag beside `lobby` and `error`) and words and colours it as ordinary text; a failed
  read of the pointer is what gets the error treatment.

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
- **One write, and the panel branches on that write's verdict.** Splitting it — the identity first,
  the secret after — would let the small write persist while the large one failed, which is exactly
  what happens near a quota limit, and the panel would then relax on the strength of a verdict that
  never covered the secret. The secret is the part that cannot be recovered, so it is the part the
  verdict has to be about.

**When that write was not durable** (§2.4 returns `"memory"`), this panel is the recovery panel and
it hardens rather than softens:

- it cannot be dismissed until the link has been copied or explicitly acknowledged;
- the warning gains the reason and the stake, in plain words: this browser is not saving data, so
  **this link is the only copy of it anywhere**, and closing the tab without saving it loses the
  Weave for good — Loom has no recovery, no rotation and no deletion (SECURITY §9.3);
- **Open the Weave** renders the Weave **in place** (§3.1) instead of navigating, so the keeper
  token in memory survives and the creator can actually use the Weave in this tab — which holds
  only because the form and the session share one storage instance (§2.4a);
- the one-time notice of §6 is raised as well.

This is the case that makes §3.1's exception worth its few lines: a lost Lobby name is an
inconvenience, a lost Weave secret is unrecoverable.

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
created, and §2.6 makes it **outlive an invalidated participant identity**, because the two are
independent credentials and a dead token is no evidence against a secret. Net change: neutral to
positive — the same origin, the same attacker, and one fewer place it appears (the address bar) for
every token-loaded page. The hygiene point in the other direction is that a token proven dead by a
401/403 is **deleted** rather than left lying in the store.

**A credential that does not persist is now visible rather than silent.** `set` returning
`"durable" | "memory"` (§2.4) does not change what is stored or who can read it; it stops the client
believing a credential was saved when it was not. The security-relevant part is §4.5's hardened
panel: a Weave secret that exists only in a tab's memory is one closed tab from an unrecoverable
Weave (no rotation, no deletion — SECURITY §9.3), and the person who created it is told so while
they can still act on it.

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
- `SessionState.status` gains `"no-credential"` and `readOnlyReason?: "secret-fallback"` (§2.6).
  `needsName` is reachable on a `kind: "id"` session only through the secret fallback — a session
  reading with a token always has an identity, one reading with a secret may not — and `join()` is
  available in exactly that case, refusing with `validation` when the session has no secret to join
  against.
- The main page holds four independent async cells (guidelines, lobby pointer, lobby counts, My
  Weaves rows). Each renders `loading → value | error`, and an error is a line inside that section
  only. No spinner blanks the page; the join form is usable while the rest is still loading.
- Every form: submit disabled while in flight and while invalid, the typed value never discarded on
  failure, the server's message shown verbatim for `validation` and mapped to plain words for the
  codes in §4.1.
- **Storage that does not persist.** `browserStorage` already survives a throwing `localStorage`
  by falling back to memory ([`storage.ts:17,19-21,27`](../../../src/web/src/storage.ts)), and
  nothing in this design adds a `try`/`catch` of its own: the degraded mode arrives as a returned
  `"memory"` (§2.4), never as an exception, so **no component can crash on it**. Its consequences,
  all specified above: the value written stays readable for the page through the override layer
  (§2.4b), a join or creation renders in place instead of navigating (§3.1), migration keeps the
  legacy key for the next page load (§2.4), and the creation panel hardens (§4.5).
- **Within a page, storage never contradicts itself.** One instance (§2.4a) and the precedence rule
  (§2.4b) together mean a component can write and then read without wondering which layer answered:
  the last write wins, durable or not. That is what keeps the invalid-identity and rejoin paths of
  §2.6 from oscillating, and it is the property the tests assert rather than the layering that
  produces it.
- **The "storage is not persisting" notice.** Raised the first time any write in a page load returns
  `"memory"` — a join, a creation, a migration, or a My Weaves refresh writing a title or
  invalidating an identity (§4.2) — and shown once, at the top of the page, until
  dismissed. **It belongs to the page, not to the main page's layout**, so it renders on `/` *and* on
  every Weave page: a join from `/` whose credential did not persist replaces the main page with the
  Weave in the very same render (§3.1), and a `/w/<secret>` load writes an entry of its own (§10.9) —
  without a seam on the Weave page the one warning the human needs would be latched and never drawn.
  The notice object is one per page load and is handed to whichever route is mounted, so it stays
  **at most one bar, and one dismissal, per page**, and a dismissal made before the in-place switch
  carries across it. It does not reappear on later writes in the same page load (the page-scoped
  `storageNotPersisting` flag of §2.4 is also what suppresses the repeat). Wording intent: say what
  is happening in the user's terms and what to do about it, never in the browser's. Not "quota
  exceeded" or "localStorage unavailable", but: *this browser is not saving anything for this site,
  so Weaves you join or create here will be gone when you close the tab — copy any Weave link you
  want to keep, or allow this site to store data.* It never blocks the page, never blocks a form,
  and is the only place the condition is announced.

  Its cause is usually private browsing, blocked site data or a full store; the page does not guess
  which, because it cannot tell and the advice is the same.
- A browser in that state also shows an empty (or legacy-only) My Weaves, which the notice explains.

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
- A network failure during load → `status: "error"` and the entry is **kept** untouched.
- Mutations on a token session (post, create thread) use the stored token.
- `needsName` is never raised on a session reading with a token.

**`web` — store, invalid identity (§2.6, against a real server)**
- **Invalid token, valid stored secret**: the load falls back to the secret, `status: "ready"` with
  `readOnlyReason: "secret-fallback"`, and the entry still holds its `secret`, `title` and
  `lastOpenedAt` while `token`/`participantId` are gone and `identity` is `"invalid"`.
- **Rejoin from that state** writes a fresh `token`/`participantId` into the same entry, clears
  `identity`, and the session becomes writable — the self-healing path.
- **Missing `participantId`** (token valid, participant not in the list): same invalidation, same
  fallback, same rejoin.
- **Invalid token, no secret**: `status: "no-credential"`, and the entry is **still there**, marked
  `identity: "invalid"`, with its cached title intact.
- **403 for a token belonging to another Weave**: same as the invalid token.
- **Invalidation that cannot be persisted** (`setItem` starts throwing after the entry was written
  durably): the entry still **reads** `identity: "invalid"` with no token — the dead credential is
  not resurrected — and the session falls back to the secret, exactly as in the durable case.
- **A rejoin whose write cannot be persisted**: the entry reads back the **new** token and the
  session is writable (`post` succeeds), rather than reading the dead one.

**`web` — storage (unit)**
- `storedWeaves()` reads both shapes and discriminates correctly (a 43-char legacy remainder vs a
  `weave:<uuid>` one).
- A corrupt JSON value is skipped, not fatal (today's behaviour, kept).
- `targets()` over a mixed store: id entries make one call, legacy entries two, one failing entry
  does not cost the others, and an entry with no usable identity is skipped.

**`web` — one storage instance (§2.4a)**
- **Guard test**: reading the sources under `src/web/src`, `browserStorage(` appears exactly once
  outside `storage.ts` — in `main.tsx`. A plain `node:fs` walk in the node-environment suite; it
  fails loudly the day someone reaches for a second store.
- `useSession(target, storage)` does **not** construct a store: changing the target rebuilds the
  session and keeps the same storage object (asserted by writing through the injected store before
  the target change and reading it after).

**`web` — storage, durable-write result (unit, §2.4)**
- `memoryStorage()` reports `"durable"`; `memoryStorage({ durable: false })` reports `"memory"`.
- `browserStorage().set` returns `"durable"` when the value reads back from `localStorage`.
- `setItem` **throws** (blocked site data) → `"memory"`, and `get` still answers from the fallback.
- `setItem` **silently stores nothing** (accepts the call, `getItem` answers `null`) → `"memory"`.
  This is the case a "did not throw" check would get wrong, and the case a read-back through `get`
  would also get wrong, because `get` consults the memory fallback
  ([`storage.ts:19`](../../../src/web/src/storage.ts)) — so the test asserts the verdict, not the
  readability.
- A quota failure on one key does not change the verdict of a later successful key.

**`web` — storage, read precedence (unit, §2.4b)**
- **A failed update to an existing durable key reads back the NEW value** — the regression test for
  gap 2. `localStorage` still holds the old string; `get` answers the new one.
- A failed `remove` of an existing durable key reads as **absent** (`get` → `null`) and the key is
  **not** in `keys()`.
- `keys()` includes a key that exists only as an override.
- A later **successful** write of the same key clears the override: with `setItem` working again,
  `localStorage` holds the new value **and** `get` still returns it (the assertion has to check both,
  or it cannot tell a cleared override from a lingering one that happens to agree).
- A later successful `remove` clears a tombstone the same way.
- `get` never writes: a read while an override exists leaves `localStorage` untouched, and nothing
  retries on a timer.
- A key that was never persisted keeps today's order (`localStorage`, then the memory fallback).

**`web` — storage, migration (unit, §2.4)**
- A durable replacement: the id entry is written, **then** the legacy key is removed.
- A **non-durable** replacement (quota exceeded on the id key): the legacy key is **still present**
  and still parses to a usable identity after a simulated reload — the P2-1 regression test.
- Migration is attempted at most once per Weave per page load, and a `"memory"` verdict suppresses
  further attempts for the other Weaves too (no rewrite storm).
- An interrupted migration leaves a duplicate, and My Weaves folds it to one row (by `secret`, else
  by `token`).

**`web` — DOM (`components.test.tsx`, happy-dom)**
- `/`: join form shown with no Lobby identity; **Open the Lobby** shown with one; the form (not
  "Open the Lobby") shown for an entry marked `identity: "invalid"`.
- Name validation matches core's rule at the boundaries (`a`, 32 chars, 33 chars, a space, `@`).
- `name_taken` renders the two-case message, keeps the typed name, and offers a suffix suggestion
  that fills the field **without** submitting.
- **Blocked storage on join**: `setItem` throws, the join succeeds, and the destination is
  **loaded and writable** — the Lobby session reaches `status: "ready"`, `state.me` is the joined
  participant, and a `post` succeeds. The URL is unchanged and the notice is shown, but those are
  the weaker assertions: "no navigation was attempted" would pass against a credential-less page,
  which is the bug §2.4a fixes, so the test asserts the outcome.
- **Blocked storage on create**: `setItem` throws, the save-this-link panel appears with the
  hardened warning and cannot be dismissed unacknowledged, and **Open the Weave** renders a Weave in
  which this browser **is the keeper** (`state.me.participant.role === "keeper"`, a keeper-only
  action available), not merely a page that did not navigate.
- The notice appears once per page load and does not repeat on a second non-durable write; it never
  blocks a form.
- My Weaves renders from storage **with no fetch**; ordering; the archived and Lobby badges; each
  row state of §4.2 including the read-only and "identity stopped working" rows; Forget only on the
  unavailable ones; Copy link only where a secret is held.
- My Weaves **follows storage without a user action**: a migration that resolves after the first
  paint turns a legacy row into an id row; a refresh result (new title, archived flag) appears; a
  401 invalidation changes the row state; Forget removes the row; and a change signal bump does
  **not** re-fetch a row already refreshed (counted on the stub).
- My Weaves keeps the refresh bound **in total, across renders** — the regression test for a bound
  that was only ever per batch. With 30+ rows and a `getWeave` the test releases by hand, the first
  six block; then the visible slice changes repeatedly while they are still blocked (a filter
  keystroke, "Show more", and a change signal bump that brings a newly migrated row in), and a
  running maximum of concurrent stub calls never exceeds 6. Releasing the block drains the queue and
  each row is fetched exactly once. Leaving the page starts nothing further: after unmount the
  queued rows never begin and the in-flight ones write nothing back.
- The scheduler holding that bound is tested as a unit too, with no DOM: the limit is honoured across
  several separate submissions, items run first-in-first-out, a rejecting run frees its slot rather
  than stranding it, disposal starts nothing further and ignores later submissions, and the queue
  drains completely.
- My Weaves **reports its failed writes**: an invalidation that cannot persist still shows the
  invalid-identity row *and* raises the notice bar once; a title write that cannot persist raises the
  same one notice and still updates the title on screen; with durable writes the notice stays quiet.
- Lobby summary shows title only without an identity and counts with one.
- Create form: 403 renders the keepers-only message; a 201 renders the save-this-link panel, the
  entry is written **before** the panel appears, and **Open the Weave** points at `/weave/<id>`.
- `/weave/<id>` with no credential at all: the Lobby id renders the join form, another id renders
  the explanation; with a secret and no identity it renders the Weave read-only with a Join button.

**`server` (`static.test.ts`)**
- `index.html` is served for `/`, `/lobby`, `/lobby/`, `/weave/<uuid>`, `/weave/<uuid>/`.
- Unknown paths and `/assets/missing.js` still answer the JSON 404 (existing test, unchanged).
- The API-only app (no `webDist`) answers the JSON 404 for all five paths.

**No new `core`, `client`, `cli`, `mcp-tools` or `claude-channel` tests** — none of those packages
changes.

**Manual smoke (TESTING.md).** A fifth smoke test, short: from a clean browser profile, open `/`,
join the Lobby by name, confirm the address bar never shows a secret, open a request from the Lobby
page, create a Weave from `/`, copy the link, reopen `/` in a new tab and confirm My Weaves lists
both. Then repeat the join and the creation in a **private window with site data blocked** and
confirm the notice appears, the page does not navigate, and the created Weave's link is still on
screen.

## 8. Docs to update

| Doc | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` §9 | the route table (`/`, `/lobby`, `/weave/<id>`, `/w/<secret>`), the `target` union and where the read credential comes from (token, else secret), the new storage key shape, the `WriteResult` the interface now returns **and its read-precedence rule**, and the **one storage instance created in `main.tsx`** and passed to `App`/`useSession`; "no router" becomes "no router library — path matching in `app.tsx`, with one in-place switch when a credential did not persist". The existing sentence "Identity (participant token) is kept in `localStorage` via `storage.ts`, which degrades to memory when storage throws" needs the degradation described as observable rather than silent |
| `docs/SECURITY.md` §8 | the `localStorage` bullet: new key shape, that an entry may carry a Weave secret, that a secret outlives an invalidated identity, and that a token proven dead by a 401/403 is deleted |
| `docs/SECURITY.md` §9.9 | narrow to `/w/<secret>` links; note that token-loaded pages carry a uuid, which is not a credential |
| `docs/SECURITY.md` §4a or §9 | a public landing page makes the public Lobby join *discoverable*; §9.1 (no rate limiting) is the thing that gets more pressing |
| `docs/TESTING.md` | the `web` and `server` rows; the new manual smoke test |
| `docs/KNOWN-ISSUES.md` | any row the implementation leaves behind (e.g. the un-cursored count in §4.4, if it is not already covered by the `listRequests` row) |
| `README.md` | "open the instance URL" as the way in, beside `/w/<secret>` |
| `v2-notes.md` | annotate the web-main-page idea with a link to this spec |

## 9. Implementation order

Task-sized steps; each ends green, and each is a plausible subagent task.

1. **Durable-write result and read precedence.** `KeyValueStorage.set` returns `WriteResult`;
   `browserStorage` verifies by reading back from `localStorage` itself; the pending-override layer
   with tombstones, the `get`/`keys()` precedence and the clear-on-next-success rule (§2.4b);
   `memoryStorage({ durable })`. Unit tests, including the throwing case, the
   silently-storing-nothing case and the failed update to an existing key. Nothing else changes —
   every existing caller ignores the return value — so this lands on its own and everything after it
   can rely on it.
2. **One storage instance** (§2.4a). `browserStorage()` moves to `main.tsx`; `App` takes a `storage`
   prop; `useSession(target, storage)` stops constructing one. Small, mechanical, and it must come
   before anything depends on the in-place transition. Includes the guard test.
3. **Storage entry shape.** The entry type (identity optional, `identity: "invalid"`, `secret`,
   display cache), `storedWeaves()` over both shapes, `saveWeaveEntry`, the `migrateLegacy` helper
   with the keep-the-legacy-key-until-durable rule and the once-per-page guard. Unit tests. No other
   package touched.
4. **Session `target`.** Replace `secret: string` with the union; `reader`/`weaveId` resolution
   including the secret fallback; `no-credential`, `readOnlyReason` and the
   401/403-invalidates-the-identity rule; `targets()` over the new shape; write the display cache on
   load and join; rejoin rewrites the identity. Store tests against a real server.
   `/w/<secret>` behaviour must be bit-for-bit unchanged — the existing tests are the guard.
5. **Server routes.** The five `c.html(indexHtml)` lines and the `main.ts` boot wording.
   `static.test.ts` additions.
6. **Router + `<WeaveView/>`.** Split today's `Weave` out of `app.tsx`, add the `/weave/<id>` and
   `/lobby` paths, the target-in-`useState` switch of §3.1, the `no-credential` branch, the
   read-only/rejoin banner and the not-joined-Lobby fork. DOM tests.
7. **Main page shell + the storage notice.** Layout, the four independent cells, instance
   guidelines, Lobby summary (title only / counts with an identity), and the one-time
   "storage is not persisting" bar. DOM tests.
8. **Join the Lobby.** Shared `NAME_RE` constant (and `NamePrompt` switched to it), the form, the
   error map, the `name_taken` two-case message with its suffix suggestion, the durable/in-place
   branch, the already-joined and invalid-identity branches. DOM tests.
9. **My Weaves.** Render-from-cache, duplicate folding, lazy bounded refresh, ordering, filter, the
   row states, Copy link, Forget, the change signal that keeps the list in step with storage, and
   the write verdicts reported to the notice. DOM tests.
10. **Create a Weave.** Form, 403 branch, the save-this-link panel, entry written before the panel,
    and the hardened non-durable variant. DOM tests.
11. **Docs** (§8) in one commit.

Steps 1–5 are the load path and are independent of 7–10; 6 is the join between them. Steps 1 and 2
are deliberately first and deliberately small: 3, 8 and 10 branch on the write verdict, and 6, 8 and
10 are only correct because of the shared instance.

## 10. Open questions and assumptions

Stated as assumptions so implementation is not blocked. Paw should confirm 1, 3, 9, 10 and 13.

1. **No new public read for Lobby counts** (§4.4, option 1). Assumed: anonymous visitors see the
   Lobby's title only; counts appear once this browser holds a Lobby token. If Paw wants a livelier
   anonymous landing page, option 2 is a small core change to `getLobby` — but it moves activity
   metadata to the anonymous side of SECURITY §4a's line, permanently.
2. **Full page navigation, no client-side router** (§3.1), with the **one exception** for a
   credential that did not persist. Assumed; revisit with the layout overhaul.
3. **The landing page ships ungated.** Assumed: no `settings.publicLanding` switch, because
   everything `/` exposes anonymously is already anonymous over the API on the same host. If a
   tunnelled instance should present a blank front door, that is a setting and a core change, and it
   belongs in its own task.
4. **Creation is always offered, `403` surfaced in place** (§4.5), rather than making
   `openWeaveCreation` publicly readable.
5. **The created Weave's secret is kept in the storage entry** so the share link stays copyable, the
   address bar never carries it for a token-loaded page, and **no identity failure ever deletes it**
   (§2.6, §4.5, §5).
6. **Legacy `loom:<secret>` entries are migrated lazily, and the legacy key is removed only once the
   id-keyed replacement is confirmed durable** (§2.4). Assumed rather than a one-shot migration at
   startup, so neither an unreachable server nor a full store costs a browser an identity.
7. **`kind` is fixed to `"human"` on both forms** (§4.1, §4.5). An agent joins with its key.
8. **Deferred niceties, deliberately not in scope**: a "paste a Weave link" or "paste a token" field
   on `/`, a QR code for a `/w/<secret>` link, remembering a display name across forms beyond the
   Lobby identity, and any per-Weave notification state. Each is a line of UI and a new thing to
   test; none is needed to close the gap this spec exists for. Note that the absence of a
   paste-a-token field is what makes §3.1 choose render-in-place over a copy-your-token recovery
   panel for the join.
9. **A `/w/<secret>` visit writes a storage entry before any join** (§2.4), so a Weave this browser
   can read but has not joined appears in My Weaves as a read-only row. New behaviour — today
   nothing is stored until `join()`. It is what makes the secret fallback of §2.6 and the row states
   of §4.2 coherent, but it does mean opening someone's link leaves a trace in this browser that it
   does not leave today. Worth a yes or no from Paw.
10. **An entry is never deleted automatically** (§2.6, §4.2): an invalid identity is cleared, a dead
    Weave is greyed, and **Forget** is the only thing that removes a row. The cost is that a browser
    accumulates rows for Weaves it can no longer reach; the benefit is that nothing the user was
    given ever vanishes without them saying so.
11. **No server change for a lost Lobby identity** (§4.1): `name_taken` is answered with an
    explanation and a client-side suffix suggestion. A "reclaim my name" path would need proof the
    claimant is the earlier participant, and the only proof that exists is the token that was lost.
12. **One storage instance, created in `main.tsx` and passed down** (§2.4a), rather than a
    module-scope singleton in `storage.ts`. The prop is one more thing to thread through `App`, and
    it is what makes the store substitutable in a DOM test and visible at every call site. A guard
    test keeps `browserStorage()` from reappearing elsewhere.
13. **A failed write overrides a stale persisted value for the life of the page, and a reload starts
    from `localStorage` alone** (§2.4b). So a page can read back something the browser will not have
    after a refresh — deliberately, because the alternative is a page that contradicts its own
    writes. The retry is opportunistic (the next write of that key) with **no background loop and no
    cross-tab sync**; another tab keeps the stale value until its own next read fails and converges.
    Worth a yes or no from Paw, because it is the one place where what the page shows and what the
    browser has stored are knowingly allowed to differ.
