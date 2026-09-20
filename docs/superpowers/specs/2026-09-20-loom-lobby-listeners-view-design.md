# Loom v2 — The Lobby listeners view: the directory moves inside the Lobby's layout

Date: 2026-09-20
Status: spec, ready for review and planning. No implementation yet.
Sub-project: the second slice of "Web client layout for a busy instance" in the v2 breakdown (see
[v2-notes.md](v2-notes.md)); the first was the directory itself
([2026-09-19-loom-lobby-listeners-design.md](2026-09-19-loom-lobby-listeners-design.md)).
Found by **manual smoke test 6** (Paw, 2026-09-20, 12 of 12 passed, appearance not signed off): the
notes are in v2-notes.md under "From the first run in a real browser", and every decision below was
approved in `.superpowers/listeners-view-brainstorm.md` on the same day.

This spec **amends** the listeners spec rather than replacing it. Everything about core, REST, the
client, the query codec and the controls stands; what changes is where the directory is rendered and
who owns its credential. See §2 for the section-by-section list.

## 1. Purpose and scope

### The problem

The directory works, and it is a page of its own. `/lobby/listeners` mounts
[`ListenersRoute`](../../../src/web/src/components/listeners/ListenersRoute.tsx), which resolves the
Lobby pointer a second time, picks a credential a second time, owns a second copy of the
join-the-Lobby fork and a 401 rule the session already has, and renders a page with its own wordmark,
its own headline and a **Back to the Lobby** link. Following the sidebar's **Listeners (N)** line
therefore **tears the session down**: the WebSocket closes, the Thread list and the message history
go, and coming back reloads all of it. For a directory a human opens to look someone up and then
closes again that is the wrong shape, and it is what produced the cosmetic complaints of the smoke
test run.

### What this builds

The directory becomes a **view of the Lobby's main area**. The header and the sidebar stay on screen,
the session stays mounted and streaming, and the main area shows either the current Thread
(`MessageList` + `Composer`) or the directory. `/lobby/listeners` survives as a deep link and as a
real history entry, so the address bar still names what is on screen and Back still means what a
human means by it.

### Success scenario

1. Paw is on `/lobby`, reading the General thread. The sidebar says **Listeners (62)**.
2. He presses it. The main area becomes the directory; the header, the Thread list, the guidelines
   panel and the requests board do not move; the connection indicator still says `open`. The address
   bar reads `/lobby/listeners`.
3. He searches `bob` and picks two tool chips. The address bar gains `?q=bob&filter=…` — by
   `replaceState`, so those four control changes are **not** four Back steps.
4. He presses **Back** once. The address bar reads `/lobby`, the directory closes, the General
   thread is where he left it — same session, nothing reloaded.
5. **Forward** returns him to `/lobby/listeners?q=bob&filter=…` with the search box and both chips
   seeded from that URL.
6. He sends the link to a colleague, who opens it cold: the Lobby loads with the directory already
   open, showing the same view.

### Explicitly out of scope

- **All visual design.** The owner runs a separate design session on the whole web client. This spec
  prescribes structure and behaviour, and names class hooks where a rule needs one; it prescribes no
  styling, no spacing, no colour and no responsive rules.
- **CR4, the nested effort row's layout** — the same design session owns it.
- Any change to core, the REST surface, the client library or the query semantics (§10).
- Live updates in the directory; a stream that reshuffles a grid is still ruled out (listeners spec
  §5.5, KNOWN-ISSUES).
- Actions on a listener. The directory stays read-only.

## 2. What this amends in the predecessor spec

| Listeners spec | What happens to it |
| --- | --- |
| §5.1 the sidebar line | **Amended.** The count, its four states and its Lobby gate are unchanged. The line stops being a link-or-button pair: it is **always a button**, and it now toggles a view rather than opening a page (§8). `openListenersInPlace` and its whole in-place argument are gone. |
| §5.2 the route | **Superseded by §4.** `Route` loses the `listeners` kind; `/lobby/listeners` becomes the Lobby route with an initial view. The server's static paths are unchanged. |
| §5.3 the page | **Amended in three places** (§3.3, §9): the page header — wordmark, `<h1>Listeners</h1>`, **Back to the Lobby** — is deleted; the counts line is reworded; **Clear filters** is always rendered and now resets the sort. Everything else — search with its debounce, the four facet controls, sort, the grid, Show more, the empty/loading/error states — stands verbatim. |
| §5.4 the query string | **Amended by §4.** The codec and the `replaceState`-only rule stand word for word; the `inPlace` half of the rule is subsumed by the path test, and `pushState` becomes legal for the **view** change under one precise condition, which §5.4's own reasoning already permits. |
| §5.5 credentials | **Superseded by §6.** The route's own resolver, join form, 401 rule and refused-secret terminal state are deleted; the session owns all four. The "list changed" hint and the not-persisting bar are unchanged. |
| §5.5 amendments (query-string validation, Show more's `facets: false` and refused cursor) | **Unchanged**, all three. |
| §7 state and error handling | **Unchanged**, except that the page's "four independent cells" become three: the Lobby pointer and the credential are the session's, not the view's. |

Each of these gets a dated "superseded by" note in the predecessor spec itself (§13).

## 3. The view

### 3.1 Where the state lives, and its type

In [`WeaveView`](../../../src/web/src/components/WeaveView.tsx), as one `useState`:

```ts
// src/web/src/lobby-view.ts
export type MainArea = "thread" | "listeners";
```

A string union rather than a boolean, because the main area is one slot showing one thing and a name
reads better at every call site than `listenersOpen`; and rather than an object, because there is
nothing else to carry. It is **not** put in `App`'s route state: the route is what the URL says, the
view is what is on screen, and on a browser that may not write history those two are allowed to
differ (§4.4).

`WeaveView` gains two props, both optional and both absent on every non-Lobby page:

| Prop | Meaning |
| --- | --- |
| `initialView?: MainArea` | which view this page opened on, derived from the path by `routeOf` and handed down unchanged by `WeaveRoute`. Defaults to `"thread"`. |
| `canLeave?: boolean` | the positive form of the answer `WeaveMount` already computes with `leavingIsSafe` for `openMainInPlace`. Read on every render; §4.2 is its only consumer. |

It loses one: `openListenersInPlace` (§7).

`initialView` is an **initial** value and is never re-read. It cannot go stale: the only remount of
`WeaveView` inside one page load is `WeaveSession`'s `key={reloadKey}` bump after a join
([`WeaveRoute.tsx:93-96`](../../../src/web/src/components/WeaveRoute.tsx)), and a join is only
reachable from the `no-credential` fork, which renders no sidebar and therefore no way to have
changed the view first (§5).

### 3.2 The session does not remount

This is the whole point of the change, so it is stated as an invariant with its three reasons:

- `App` renders **one** element for both of the Lobby's addresses (`<WeaveRoute lobbyRoute …/>`), so
  a view flip changes a prop and never the component at that position. Had `listeners` stayed a route
  kind, `App`'s `switch` would return a different element and Preact would unmount the subtree.
- The view state lives **below** `useSession`, in `WeaveView`; `WeaveMount`'s `useSession` is
  memoised on `[key, client, storage]` ([`useSession.ts:20`](../../../src/web/src/useSession.ts)) and
  none of the three changes.
- No `key` in the chain from `App` to `WeaveView` is a function of the view.

A test asserts it by counting requests, not by inspecting internals (§12).

### 3.3 The layout, and what each view renders

```
┌ header ───────────────────────────────────────────────────────────┐
│ Loom   <Weave title>                      open   you are dana     │
├────────────┬──────────────────────────────────────────────────────┤
│ Threads    │  ← the main area: the Thread, OR the directory        │
│ Guidelines │                                                       │
│ Requests   │                                                       │
│ Listeners  │                                                       │
│  (62) ←──── pressed while the directory is open                    │
└────────────┴──────────────────────────────────────────────────────┘
```

Inside `<div class="main">`, three groups:

- **Always, in both views** — the `archived` banner, the read-only/`secret-fallback` banner with its
  **Join**, and the `refreshError` warn bar. Each describes the page or the Weave, not the Thread.
- **Thread view only** — `InviteBanner`, `MessageList`, the mutation `error` bar and `Composer`. The
  composer is not rendered in the directory: there is nothing on screen it would post to.
- **Directory view only** — `ListenersPage`, under an `<h2>Listeners</h2>`. Demoted from `<h1>`
  because the page's `<h1>` is the Weave title in the header; this is the heading of one region of
  it. The class hook stays `listeners` so the existing selectors keep working, and the deleted
  `listeners-head` block takes the wordmark and **Back to the Lobby** with it (§7).

The header is **unchanged in both views**: it names the Weave, which is what the page is, and saying
"Listeners" there would be a second headline for the region below it — the CR3 complaint, moved
rather than fixed.

### 3.4 Picking a Thread closes the directory

[`ThreadList`](../../../src/web/src/components/ThreadList.tsx) calls `session.selectThread(id)`
itself, so there is no state change `WeaveView` can watch: `currentThreadId` is also set once by the
load itself ([`session.ts:717`](../../../src/web/src/session.ts)), and an effect keyed on it would
close a deep-linked directory the moment the Lobby became ready. So the intent is passed explicitly:

> `ThreadList` gains `onPick?: () => void`, called **after** `session.selectThread(id)` in the thread
> button's handler and **after** a successful `session.createThread(…)`. `WeaveView` passes a
> callback that switches to the thread view through the same function the sidebar line uses (§4.2),
> so picking a Thread pushes `/lobby` exactly as pressing the line pushes `/lobby/listeners`.

Creating a Thread closes the directory too, because it selects the new Thread
([`session.ts:831`](../../../src/web/src/session.ts)) and leaving the human on the directory would
hide what they just made.

**Unread, invites and the stream are untouched.** Opening or closing the directory marks nothing seen
and un-marks nothing: `seenUpTo` moves only in `selectThread` and `markSeen`. A message arriving while
the directory is open updates the Thread list exactly as it does today, and the directory — which has
no stream and no live updates by design — ignores it.

## 4. The address bar

### 4.1 `routeOf`, and the route kind that goes away

```ts
export type Route =
  | { kind: "main" }
  /** `view` is the area the page **opened** on, never a live value: the view itself lives in
   *  `WeaveView` (spec §3.1), and after a `pushState` this field is deliberately not updated. */
  | { kind: "lobby"; view?: MainArea }
  | { kind: "weave"; weaveId: string } | { kind: "secret"; secret: string } | { kind: "unknown" };
```

`routeOf("/lobby/listeners")` returns `{ kind: "lobby", view: "listeners" }`; `routeOf("/lobby")`
returns `{ kind: "lobby" }`. Both spellings of both paths keep working, as the server serves four.
The path decisions move into one module, `src/web/src/lobby-view.ts`, so that `app.tsx` and
`WeaveView` share them without `WeaveView` importing `app.tsx` (which would be an import cycle):

```ts
export type MainArea = "thread" | "listeners";
/** `undefined` when this is not one of the Lobby's four addresses. */
export function viewOfPath(pathname: string): MainArea | undefined;
/** The canonical spelling this app writes: "/lobby" or "/lobby/listeners", never a trailing slash. */
export function pathForView(view: MainArea): string;
```

**Why a Lobby route with a view, and not a route kind of its own.** The path names the Lobby page;
the extra segment names which part of that page is open. One kind means one mounted component for
both addresses, which is precisely the invariant of §3.2 — a separate kind would make "do not remount
the session" a thing to be careful about rather than a thing that cannot happen. It also keeps
`Route` a description of the URL and nothing else.

### 4.2 When `pushState` is allowed

> The Lobby page pushes a history entry when the human changes the view — and **only** when
> `viewOfPath(location.pathname) !== undefined` **and** `leavingIsSafe(storage, notice,
> weaveKey(lobbyWeaveId))` is true at the moment of the click.

Both halves are re-read per click, the second through the `canLeave` prop `WeaveMount` already
computes for `openMainInPlace`
([`WeaveRoute.tsx:134-135`](../../../src/web/src/components/WeaveRoute.tsx)). What is pushed is
`pathForView(next)` with **no query string**: `/lobby/listeners` on open, `/lobby` on close. The push
happens **before** the state change, in the same handler, so the view mounts with `location` already
reading the new path — which is what makes §4.3's seeding rule a single rule with no special case.

**This is the app's first `pushState`, and it does not contradict the in-place rule.** The Global
Constraint bans navigating *away* while the only copy of a credential lives in memory, and
`openInPlace` / `openMainInPlace` exist because a pushed `/lobby` or `/` would be an address this
browser cannot honour after a reload. Two things make this push different:

1. **It loads nothing.** Same document, same JS context, same session, same storage instance. There
   is no moment at which the credential could be dropped.
2. **The address it writes is one this browser can honour.** The only risk a pushed URL carries is a
   later reload or a Back-out-and-in landing on it as a real page load — and that load needs exactly
   the credential `leavingIsSafe` was asked about. **When a reload of `/lobby/listeners` is safe is
   the same question as when the push is allowed**, so it is asked once, with the same predicate, at
   the same moment as every other in-place decision in the app.

The first half — the path test — also disposes of the in-place cases for free. A Lobby rendered by
`openInPlace` leaves `location.pathname` at `/` or wherever it was, `viewOfPath` says `undefined`,
and nothing is written. On `/weave/<lobbyId>` and `/w/<secret>` — where the Lobby gate of §5 can still
be true and the directory can still be opened — the same test fails and history is never touched.

### 4.3 The query string, and `replaceState`

Unchanged from listeners spec §5.4, minus one dead parameter:

- **Seeding.** The directory reads `location.search` when `viewOfPath(location.pathname) ===
  "listeners"`, and takes `EMPTY_VIEW` with `partial: false` otherwise. Read once per mount, as
  today.
- **Writing.** [`writeSearch`](../../../src/web/src/components/listeners/listeners-query.ts) keeps
  its body verbatim — `replaceState` only, the exact path test, and the no-op guard — and **loses its
  `inPlace` parameter**. That parameter existed because a page rendered in place sat on some other
  path; now the path test *is* the whole rule, and on a browser whose push was skipped the path is
  `/lobby` and nothing is written. One rule, one condition, stated once.
- Ten keystrokes' worth of filtering are still not ten Back steps, and Back still leaves the
  directory. That is now literally true: the entry Back returns to is the `/lobby` the open pushed.

### 4.4 `popstate`

`WeaveView` registers one `popstate` listener in an effect with an empty dependency list, **only**
when `viewOfPath(location.pathname)` is defined at mount, and removes it on unmount. Registration
deliberately does **not** depend on `canLeave`: storage can degrade after a push, and a listener torn
down mid-life would leave Back changing the URL without changing the view. A `popstate` the page never
caused is harmless — it sets the view to what the URL already says.

On each event:

1. `setView(viewOfPath(location.pathname) ?? "thread")`.
2. Bump a `popSeq` counter that is the directory's `key`, so Back/Forward **always remounts** it and
   it re-seeds from `location.search` by §4.3's one rule. Nothing else changes the key, so an
   ordinary re-render — a message arriving, a refresh landing — never remounts the directory and
   never re-queries.

**Back, and Forward again.** Opening the directory pushes `/lobby/listeners`; filtering rewrites
*that entry* to `/lobby/listeners?q=bob&filter=…`; picking a Thread pushes a bare `/lobby`. Back
therefore returns to the filtered listeners entry — view flips, filters come back from its query
string, one fresh query — and Forward returns to the bare `/lobby`, which carries no query string of
its own and flips to the thread. The filters stay on the entry that owns them. The directory's rows
and its in-flight query are **not** preserved across a close: the view unmounts, and its seed is
always the URL.

### 4.5 Where history is never touched

On `/weave/<lobbyId>`, on `/w/<secret>`, and on any Lobby page whose `leavingIsSafe` says no: the
view switches, the URL does not move, filtering rewrites nothing, and no `popstate` listener does
anything. The URL and the view may then disagree — the same trade `openListenersInPlace` made, minus
its machinery — and the page already says why: the not-persisting bar is on screen in exactly that
case. A filtered view cannot be copied as a link there, which is the consequence listeners spec §12.7
already recorded and accepted.

## 5. The Lobby gate, and every state the page can be in

The gate is the sidebar line's own, unchanged and id-based:
`state.status === "ready" && !!state.lobby && state.lobby.weaveId === state.weave?.id`
([`ListenersLink.tsx:23`](../../../src/web/src/components/ListenersLink.tsx)). One rule covers all of
it:

> The view state is held whatever the gate says; the gate decides only whether the directory is
> **rendered**. `view === "listeners"` with a false gate renders the Thread.

So a deep link whose Lobby pointer has not settled yet shows the Thread and opens the directory the
moment `retryLobbyData` settles it — no second flag, no pending-open state.

| Situation on `/lobby/listeners` | What happens |
| --- | --- |
| discovery pending | `LobbyRoute` renders its existing "Loading…" card. `WeaveView` is not mounted yet; the initial view is still in the route. |
| discovery fails | `LobbyRoute`'s existing error card, with its way home. The directory's own duplicate of this card is deleted (§7). |
| `weave_not_found` — no Lobby | `LobbyRoute`'s existing "This instance has no Lobby yet." |
| session `loading` | `WeaveView`'s existing "Loading…"; `WeaveView` stays mounted, so the initial view survives and the directory opens on ready. |
| session `error` | `WeaveView`'s existing error card. |
| session `no-credential` — an unjoined visitor | `WeaveRoute`'s existing unjoined-Lobby fork: `JoinLobbyForm` with its own way home. On success `reloadKey` remounts `WeaveMount`, `initialView` is still `"listeners"`, and the visitor lands **in the directory** — the brainstorm's rule, with no code of its own. |
| ready, gate true | the directory. |
| ready, gate false (pointer unsettled, or not the Lobby) | the Thread; the sidebar line is not rendered either. |

## 6. Credentials: one owner

### 6.1 `session.listListeners(query)`

```ts
listListeners(query: ListenersQuery): Promise<ListenersPage>;
```

on the [`Session`](../../../src/web/src/session.ts) object, beside `targets()`. It is a thin wrapper
with exactly one rule of its own:

```ts
async listListeners(query) {
  const myGeneration = generation;
  try { return await reader.listListeners(query); }
  catch (e) {
    // The guard first, and before any side effect: a rejection from a retired generation must not
    // spend the page's credential recovery, which is the most destructive act on this page.
    if (disposed || myGeneration !== generation) throw e;
    const recovered = recoverFromCredentialFailure(e);
    if (recovered?.reload) void doLoad();
    throw e;                                  // the caller still has a query that failed to render
  }
}
```

- **The page reader**, `reader`, exactly as `readListenerCount` and `readRequests` use it
  ([`session.ts:350`](../../../src/web/src/session.ts)). The directory therefore reads with the
  credential the page next to it reads with — the token while the identity is usable, the stored
  secret when it is not. **One credential owner**, which is the whole of this section.
- **The generation guard** is the count read's, for the count read's reason. `reader` is evaluated
  before the `await`, so a reload landing mid-flight cannot change which credential this request was
  made with.
- **It re-throws.** The session's job is the credential; the query's answer and its failure belong to
  the view, which already has a generation guard, an error cell and a "keep the rows" rule.
- **Disposed** is the same as retired: re-throw without recovery. The view's own `live` ref drops the
  rejection, as it does today.

### 6.2 What replaces each of `ListenersRoute`'s four forks

| Old behaviour (listeners spec §5.5) | What replaces it |
| --- | --- |
| No credential at all → the route's own `JoinLobbyForm` | The session reaches `no-credential` and `WeaveRoute`'s unjoined-Lobby fork replaces the whole page (§5). The directory is not on screen. |
| 401/403 while reading with the **token** → `invalidateIdentity` + `key` remount on the secret | `recoverFromCredentialFailure` does exactly this — invalidate (keeping the secret), report the `WriteResult`, answer `{ reload: true }` — and `doLoad()` re-picks the reader. |
| 401/403 while reading with the **secret** → the terminal "The Lobby refused the link this browser holds." card | **Nothing, deliberately.** `recoverFromCredentialFailure` answers `undefined` for a page-credential failure while not reading with a token, so it is an ordinary query error: the message goes above the rows that are on screen and the rows stay. The loop the amended §5.5 was written against cannot happen here — the session's `retriedWithSecret` latch is the same one-fallback-per-identity rule, and it is not the view's to spend. |
| `getLobby()` failures | `LobbyRoute`'s, already (§5). |

### 6.3 Re-querying after a recovery

No new session state, and no signal to plumb: `doLoad()` sets `status: "loading"`
([`session.ts:626`](../../../src/web/src/session.ts)), `WeaveView` renders its loading card, the
directory **unmounts**, and on ready it mounts again and makes its first query with the new
credential. `WeaveView` itself is not unmounted, so the view stays open across the round trip.

The cost, stated: that remount re-seeds from the URL, so a durable browser keeps its filters (they
are in the query string) and a memory-only browser loses them (they never were). Acceptable — a
browser that cannot keep a credential has just had one replaced, and it could not have reloaded the
page either.

## 7. What is deleted, and what is kept verbatim

**Deleted**

- [`src/web/src/components/listeners/ListenersRoute.tsx`](../../../src/web/src/components/listeners/ListenersRoute.tsx),
  whole: the second Lobby resolver, the second credential pick, the `readerFor` memo, the second join
  fork, `onCredentialFailure`, the `refused` latch and its wording, and the `reloadKey` remount.
- `Route`'s `listeners` kind and its `inPlace` flag; `App`'s `case "listeners"`.
- `RouteDeps.openListenersInPlace` and its definition in `App` — the third in-place mirror goes, and
  `RouteDeps` is back to two.
- `ListenersLink`'s anchor form **and** its button-with-a-callback form: the line is one button now
  (§8).
- `ListenersPage`'s props `reader`, `lobbyId`, `inPlace`, `storage`, `notice`, `openInPlace`,
  `openMainInPlace`, `onCredentialFailure`; its whole `listeners-head` element — the `Loom` wordmark,
  `<h1>Listeners</h1>` and **Back to the Lobby** in both forms; and with them its `leavingIsSafe`
  call and its `weaveKey`/`PersistenceNotice` imports. What is left is `{ session: Session }` — the
  directory reads nothing from session state.
- `writeSearch`'s `inPlace` parameter (§4.3).
- The tests that covered each of the above (§12).

**Kept, verbatim**

The link parser and its codec (`viewFromSearch`, `searchFromView`, the `partial` notice, the NUL
rule, core's bounds); `writeSearch`'s `replaceState` rule and its three reasons minus the dead one;
the page's own generation counter and `live` ref; the 250 ms debounce and the `apply` updater with
its supersede-the-pending-keystroke rule; Show more (`facets: false`, append-only, the refused cursor
cleared); the loading / ready / empty / error states and the rule that an error is never an empty
directory; the caps (`MAX_Q`, 20 models, 50 tools) and their wording; `FacetChips` / `ModelChips`
whole; the `ProfileCard` grid; the "the list has changed since you loaded it" line and its
**Reload the list**.

## 8. The sidebar line

[`ListenersLink`](../../../src/web/src/components/ListenersLink.tsx) keeps its file position, its
Lobby-and-status gate and its four count states — pending renders **Listeners** with no number, a
failed read adds "count unavailable", a known number renders `Listeners (1,204)` locale-formatted,
and **there is never an invented zero**. Two changes:

- It is **always** a `<button type="button" class="listeners-line-link">`. Not an anchor: it toggles a
  region of the page it is already on. The address bar is put right by §4.2's push, which is the
  right place for that decision because it is the only place that knows whether this browser may have
  one.
- It takes `{ state, active, onToggle }` and carries `aria-current={active ? "true" : undefined}`.
  `aria-current` rather than `aria-pressed`: the sidebar is one list of places in this page and the
  thread buttons next to it already say `aria-current="true"` for the selected Thread
  ([`ThreadList.tsx:50`](../../../src/web/src/components/ThreadList.tsx)). One convention for "this
  is the one you are looking at" beats two.

Pressing it while the directory is open closes it (and pushes `/lobby`), so the control is a toggle in
behaviour as well as in appearance.

## 9. Wording

**CR2 — the counts line.** Two forms, and nothing else is ever rendered there:

- filtered (`matched !== total`): `Showing 11 of 11 matches (out of 62 listeners)`
- unfiltered (`matched === total`): `Showing 50 of 62 listeners`

`of` before `matched` and `out of` before `total`, because three numbers in one sentence need the two
relations spelled differently. Locale-formatted, as today. When the query failed or either number is
unknown the line says **nothing** — never a zero.

**CR5 — Clear filters.** Always rendered, next to the sort controls, and `disabled` when everything is
at its default. "At its default" is:

```ts
const atDefaults = draft === "" && view.q === "" && view.models.length === 0 && view.tools.length === 0
  && view.runtime === undefined && view.serves === undefined && view.sort === "name" && view.dir === "asc";
```

The raw `draft`, not a trimmed one: anything at all in the box — including a space — must leave the
control live, because pressing it is also what cancels a pending debounce. Pressing it:

1. clears the pending debounce timer **before** `apply`, as today, so the keystroke cannot type
   itself back in 250 ms later;
2. empties the box and its ref;
3. resets `q`, `models`, `tools`, `runtime`, `serves` **and** `sort` to `"name"` and `dir` to
   `"asc"` — one `EMPTY_VIEW`. This overrides listeners spec §5.3, which kept the sort;
4. makes one fresh query and, through `writeSearch`, leaves the address bar at a bare
   `/lobby/listeners` — `searchFromView(EMPTY_VIEW)` is the empty string.

## 10. Server, core and client: no change

Confirmed by reading the code, not assumed:

- [`src/server/src/app.ts:86-88`](../../../src/server/src/app.ts) already enumerates `/lobby`,
  `/lobby/`, `/lobby/listeners`, `/lobby/listeners/` among its nine served paths, so the deep link
  keeps working with no edit, and `main.ts`'s boot line keeps naming them.
- `GET /api/lobby/listeners`, `LoomClient.listListeners` and every core rule behind them are untouched:
  this change moves who calls the client method, not what it does.
- No new error code, no new REST route, no migration.

## 11. State and error handling — the deltas only

- **Three cells on the Lobby page, not the directory's four.** The Lobby pointer and the credential
  are the session's; the directory owns the current query's answer and the "list changed" hint. A
  failure in one still never blanks another.
- **A failed listeners query never costs the page anything else.** It is not part of a refresh, not
  part of a `Promise.all`, and the session's only involvement is the credential rule of §6.1.
- **A superseded query's 401 still writes nothing.** The view's generation guard runs before it calls
  the session, exactly as it runs before it renders an answer, and the session's own guard is behind
  it.
- **An error is still never an empty state**, and `updating…` still keeps the rows on screen. The
  rules the directory already passes are unchanged by the move.

## 12. Testing

Per `docs/TESTING.md` and CONTRIBUTING §"Tests": one rule per test, no mocks below the fetch seam.

**Re-homed** — `src/web/test/listeners-page.test.tsx` keeps these blocks and mounts them through the
Lobby's layout instead of through `ListenersRoute`: the grid and its counts, the controls and the
query string, the pressed-while-typing block, "one query at a time", Show more, "a control change
drops the cursor", the caps, the refused cursor, "a failed query is never an empty directory", the
chips, and "the list changed while you were reading it". The harness is the file's existing
`mountApp`, pointed at `/lobby` or `/lobby/listeners` and given the Lobby-page stub table that
`components.test.tsx`'s Offer-form block already builds (`getWeave`, events, guidelines, requests and
the refused ws-ticket), with a helper that presses the sidebar line.

**Deleted with the code they covered** — the four `routeOf` tests for `{ kind: "listeners" }`
(replaced below); the whole route-level block: credential resolution, the join fork, "navigates
nowhere to do it", "keeps its reader across a re-render", the no-Lobby and unreadable-pointer cards
(`LobbyRoute`'s own tests cover those, unchanged); the three `inPlace` tests; "a Lobby secret the
instance refuses"; and `ListenersLink`'s link-versus-button tests.

**New**

1. `routeOf("/lobby/listeners")` is `{ kind: "lobby", view: "listeners" }`; with a trailing slash too;
   `/lobby` is `{ kind: "lobby" }`; a near miss is still `unknown`.
2. Opening and closing the directory **does not remount the session**: `getWeave` and `readEvents`
   are each asked for exactly once across an open-close-open cycle, and the ws-ticket call count does
   not move.
3. The sidebar line is a `button`, carries `aria-current="true"` only while the directory is open, and
   closes it when pressed again.
4. From `/lobby` on a durable browser: opening pushes `/lobby/listeners`; a filter change only
   **replaces**; picking a Thread pushes `/lobby`.
5. `popstate` Back flips to the thread view; Forward flips back to the directory and seeds the search
   box and the chips from that entry's query string.
6. Deep link: `/lobby/listeners?q=ada` mounts the Lobby with the directory open, the box seeded, and
   exactly one query carrying `q=ada`.
7. `/weave/<lobbyId>` and `/w/<lobby secret>`: the directory opens and filters, and neither
   `pushState` nor `replaceState` is called.
8. Memory-only `/lobby` (a degraded notice, and a pending storage key): same — the view switches,
   filtering works, the address bar never changes.
9. A 401 from a listeners query goes through the session: the identity is invalidated, the secret is
   kept, the next query carries the secret, and the directory is still on screen. With no secret to
   fall back to, the page settles at `no-credential` and the join fork replaces the layout. The store
   assertions live in `session.test.ts` against a real server; what is on screen is asserted here.
10. `session.listListeners` re-throws a failure the view renders, and drops a retired generation's
    rejection without touching storage (`session.test.ts`).
11. **Clear filters**: rendered at defaults and disabled there; enabled by one keystroke before the
    debounce fires; resets sort and direction as well as the filters; leaves the address bar at a bare
    `/lobby/listeners`.
12. The counts line in both forms, word for word.
13. Picking a Thread closes the directory; creating one closes it too; the composer is not rendered
    while the directory is open; an event arriving while it is open still updates the Thread list.

## 13. Docs to update

| Doc | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` §9 | the route table: `/lobby/listeners` is the Lobby with the directory open, not a page of its own; the in-place mirrors go back to two; a new paragraph for the one `pushState` rule beside `leavingIsSafe`; the component list loses `ListenersRoute` |
| `docs/ARCHITECTURE.md` §12 | one sentence: the directory is read through `session.listListeners`, which is the page's own reader — core's Listeners paragraph is otherwise unchanged |
| `docs/TESTING.md` smoke test 6 | **step 3** rewritten (the line is a button; pressing it keeps the header, sidebar and connection and swaps the main area; the address bar reads `/lobby/listeners`); **step 8** rewritten (Back leaves the directory and returns to the live Thread, Forward comes back with the filters; filter changes are still not history entries); **step 10** rewritten (blocked site data: the view still opens, the address bar never moves, and the way back is the Thread list, not a "Back to the Lobby" link). The 2026-09-20 run record stays, marked as the run that produced this spec |
| `docs/KNOWN-ISSUES.md` | the appearance row (the directory's look, still unsigned) narrowed to what this change does not settle and re-pointed at the design session; the `ListenersPage` size row re-measured; the "no live updates" and "`partial` latches" rows unchanged |
| `src/web/README.md` | the routes table row for `/lobby/listeners`; `ListenersRoute` out of the component list; the in-place pair description; `session.listListeners` added beside the count read |
| `docs/REVIEW-BRIEF.md` | the web row and the "where to look first" list |
| `docs/superpowers/specs/v2-notes.md` | the listeners section gains a dated entry pointing at this spec |
| `docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md` | dated "superseded by" notes on §5.1, §5.2, §5.3, §5.4, §5.5 and §7, each naming the section of this spec that replaces it (§2's table is the list) |

## 14. Implementation order

Four task-sized steps; each ends green.

1. **The route and the view shell.** `lobby-view.ts`; `Route`/`routeOf`/`App` (the `listeners` kind
   and `openListenersInPlace` deleted); `WeaveView`'s view state, its three render groups, the
   `<h2>`; `ListenersLink` as a toggle; `ThreadList`'s `onPick`. `ListenersPage` still mounted with
   its old props behind a temporary adapter so the suite stays green. DOM tests 2, 3, 13.
2. **`session.listListeners`, and `ListenersPage`'s new props.** The session wrapper with its
   guard and recovery; `ListenersPage` down to `{ session }`; `ListenersRoute` deleted; `writeSearch`
   loses `inPlace`; the seeding rule. Tests 9, 10, plus the re-homed blocks.
3. **History.** The push rule, the `popstate` listener, the `popSeq` key. Tests 4, 5, 6, 7, 8.
4. **Wording and docs.** CR2, CR5, then §13 in one commit. Tests 11, 12.

Step 1 is the only one that touches a component every Weave page renders, so it is first and on its
own. Step 3 is last of the behavioural three because it is the only new *capability* in the change
and the easiest to get wrong without the rest already settled.

## 15. Later / out of scope

- **The visual design of the whole web client**, CR4's effort-row layout included — the owner's own
  session. This spec deliberately names no styling.
- **Remembering the directory's rows across a close.** Reopening re-queries; a cache would have to
  answer "how stale is too stale" for a directory that already refuses to update itself live.
- **A view for anything else in the main area** (a Weave switcher, a paged participant list).
  `MainArea` is a union so that adding one is a case rather than a rewrite; nothing else is designed.

## 16. Assumptions to confirm

Stated as assumptions so implementation is not blocked. Each was decided here because the brainstorm
does not settle it.

1. `routeOf("/lobby/listeners")` returns `{ kind: "lobby", view: "listeners" }`, and `Route.view` is
   an initial value that a later `pushState` deliberately does not update (§4.1).
2. The sidebar line is **always** a `<button>` and never an anchor, and it carries `aria-current`
   rather than `aria-pressed`, to match the Thread buttons beside it (§8).
3. `ThreadList` gains an `onPick` prop, and **creating** a Thread closes the directory as well as
   selecting one (§3.4).
4. `WeaveView` keeps rendering the archived, read-only and refresh-error banners in the directory
   view, and renders `InviteBanner`, `MessageList`, the mutation error bar and `Composer` only in the
   thread view (§3.3).
5. The directory **unmounts** when closed and re-seeds from the URL on every open, and every
   `popstate` remounts it through a `popSeq` key (§4.4).
6. No new `SessionState` field: the re-query after a credential recovery comes from the existing
   `loading` → `ready` round trip (§6.3).
7. `writeSearch` loses its `inPlace` parameter, the path test being the whole of the rule (§4.3).
8. The refused-secret terminal card has **no** replacement: it becomes an ordinary query error
   (§6.2).
9. `ListenersPage` takes `{ session }` alone — it reads nothing from `SessionState` (§7).
10. The view's own heading is `<h2>Listeners</h2>` inside the main area, and the page header is
    unchanged in both views (§3.3).
11. **Clear filters**' disabled test uses the raw draft box, so a single typed space leaves it live
    (§9).
12. On a memory-only browser the URL and the view are allowed to disagree, with no notice of its own
    beyond the persistence bar already on screen (§4.5).
13. No core, server or client change — verified against `src/server/src/app.ts` and the existing
    client method (§10).
