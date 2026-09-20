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
4. He presses **Back** once. The address bar reads `/lobby`, the directory closes and the General
   thread is back — same session, nothing reloaded, and the half-written message he had left in the
   composer is still in it (§3.5). The message list is scrolled to the newest message, which is the
   one thing the round trip does not put back (§11).
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
| §5.4 the query string | **Amended by §4.** The codec stands word for word. The rule around it is restated as one promise — **never push** unless leaving is safe — under which the page's own query string may be rewritten whenever the path is `/lobby/listeners` (§4.5); `writeSearch` loses its `inPlace` parameter with it (§4.3), and `pushState` becomes legal for the **view** change alone, under one precise condition (§4.2). |
| §5.5 credentials | **Superseded by §6.** The route's own resolver, join form, 401 rule and refused-secret terminal state are deleted; the session owns all four — but a recovery is still **authorised by the view**, which is the only thing that knows whether the failed query is still wanted (§6.1). The "list changed" hint and the not-persisting bar are unchanged. |
| §5.5 amendments (query-string validation, Show more's `facets: false` and refused cursor) | **Unchanged**, all three. |
| §7 state and error handling | **Unchanged**, except that the page's "four independent cells" become three: the Lobby pointer and the credential are the session's, not the view's. |

Each of these gets a dated "superseded by" note in the predecessor spec itself (§13).

## 3. The view

### 3.1 Where the state lives, and its type

```ts
// src/web/src/lobby-view.ts
export type MainArea = "thread" | "listeners";
```

A string union rather than a boolean, because the main area is one slot showing one thing and a name
reads better at every call site than `listenersOpen`; and rather than an object, because there is
nothing else to carry. It is **not** put in `App`'s route state: the route is what the URL says, the
view is what the human has asked the main area for, and on a browser that may not write history those
two are allowed to differ (§4.5).

It lives in [`WeaveSession`](../../../src/web/src/components/WeaveRoute.tsx) — the component that
owns `reloadKey` — as one `useState`, **above** the `key` that rebuilds the page after a join:

```tsx
const [reloadKey, setReloadKey] = useState(0);
// Above the key, deliberately: a join rebuilds everything below it, and which part of the page the
// human was looking at is not the join's to reset.
const [main, setMain] = useState<{ view: MainArea; popSeq: number }>(
  () => ({ view: initialView ?? "thread", popSeq: 0 }));
return <WeaveMount key={reloadKey} {...props} view={main.view} … />;
```

**Why above the `key`, and not inside `WeaveView`.** `WeaveView` is the obvious home and it is the
wrong one. Open `/lobby`, press **Listeners**, and then let the stored token die with no secret
behind it: the session settles at `no-credential`, the visitor joins, and `reloadKey` remounts
everything under it ([`WeaveRoute.tsx:93-96`](../../../src/web/src/components/WeaveRoute.tsx)). A
view held below that key is gone with it, and what comes back is the value the page *opened* on —
on a durable browser, the Thread, with the address bar still reading `/lobby/listeners`; on a
memory-only one, where the open never touched the URL, the directory closing itself for no reason a
human could see. Held in `WeaveSession` the view is neither derived from the URL nor rebuilt: it is
the same state before and after the join, which is right in both cases and needs no second rule for
the browser that has no URL to be read back from.

(An earlier draft of this spec argued the remount was harmless because the `no-credential` fork
renders no sidebar, so the view could not have been changed first. That is false: the view is
changed while the page is perfectly healthy, and it is the credential that dies afterwards.)

`popSeq` sits in the same state object because it has the same owner and the same lifetime: it is
the directory's `key` (§4.4), bumped only by `popstate`, and the `popstate` listener is registered
here too — above the join remount, so Back still flips the view after a rejoin.

`WeaveSession` is on every Weave route, not only the Lobby's, and that costs nothing: away from the
Lobby `initialView` is absent, the gate of §5 is false, and the value is never read.

The props that carry it:

| Where | Prop | Meaning |
| --- | --- | --- |
| `WeaveRoute` → `LobbyRoute` → `WeaveSession` | `initialView?: MainArea` | which view this page opened on, derived from the path by `routeOf` and handed down unchanged. Defaults to `"thread"`, absent on every non-Lobby page, and read **once** — to seed the state above, never again. |
| `WeaveSession` → `WeaveMount` | `setView: (next: MainArea) => void` | the raw setter. |
| `WeaveMount` → `WeaveView` | `view: MainArea` | the view the human **asked for**, and not by itself what is rendered — that is `showListeners`, below. |
| `WeaveMount` → `WeaveView` | `viewKey: number` | the directory's `key` (§4.4). |
| `WeaveMount` → `WeaveView` | `onView: (next: MainArea) => void` | the one way the view changes. `WeaveMount` wraps `setView` with §4.2's push, because `WeaveMount` is where `canLeave` already is — so the history permission needs **no new prop**, and nothing below it has a history decision of its own. |

`WeaveView` loses one prop: `openListenersInPlace` (§7).

**The requested view, and the effective one.** `view` is what was asked for — by pressing the sidebar
line, by a `popstate`, or by opening `/lobby/listeners` cold. Whether the directory can be drawn at
all is a **second** question, and §5's Lobby gate is what answers it: away from the Lobby, and on a
Lobby page whose pointer has not settled, there is no directory to draw. Those two are multiplied
together **once**, in `WeaveView`, immediately below its early returns for `no-credential`, `loading`
and `error`:

```tsx
// §5's gate, which is the sidebar line's own, id-based and unchanged by this spec
// (ListenersLink.tsx:23).
const lobbyGate = state.status === "ready" && !!state.lobby && state.lobby.weaveId === state.weave?.id;
// The one predicate every rendering branch below reads. `view` on its own renders nothing.
const showListeners = lobbyGate && view === "listeners";
```

**Why one name, and not the gate repeated at each site.** Because a site that forgets it is not a
missing directory — it is a **broken Thread**. `view === "listeners"` with a false gate renders the
Thread (§5), and a composer hidden on the raw `view` would then be hidden behind a Thread the human
is perfectly entitled to write in: a deep-linked `/lobby/listeners` that reaches `ready` while
discovery is still retrying would show a message list, no directory, and no way to answer it. The
same slip would leave the `<h2>` heading a directory that is not there, or mark the sidebar line
current while the Thread is on screen. One predicate, computed once and passed nowhere, is how none
of those has to be remembered separately.

| Reads | Who, and why |
| --- | --- |
| **`view`** — the request | The push of §4.2, which writes `pathForView(next)` for the view that was *asked* for; the `popstate` listener that sets it (§4.4); `initialView`, which seeds it; and the state itself, held above `key={reloadKey}` so a rejoin restores the request (§3.1, §5). Every one of these is about the **address** and about what the human wants, and the Lobby pointer has no say in either. |
| **`showListeners`** — the effect | Everything **rendered**: which group of §3.3 is drawn, the composer slot's `hidden` (§3.5), `ListenersPage` with its `<h2>` and its `viewKey`, and the sidebar line's `active`/`aria-current` (§8). Nothing rendered reads `view`. |

**When the gate turns true later.** `retryLobbyData` settles the pointer and publishes it —
`set({ lobby: found.lobby })` ([`session.ts:508-514`](../../../src/web/src/session.ts)) — `WeaveView`
re-renders for that state change as it does for any other, `showListeners` is now true, and the
directory opens exactly as the deep link asked. **No extra state, no pending-open flag and no
effect**: the predicate is recomputed on the render the pointer already causes, and `view` never
moved, so nothing has to remember that an open is owed.

**And when it turns false.** It can, in one way, and the answer is the same one backwards. Within a
load the pointer is only ever written while it is unknown (`if (!lobbyKnown)`, `session.ts:508`), so
it cannot flicker under a live directory; but a **new load** republishes it — `doLoad` sets
`status: "loading"` and then `set({ …, lobby: discovery.lobby })`
([`session.ts:717`](../../../src/web/src/session.ts)) — so a reload whose own `getLobby()` fails
comes back ready with no pointer. Then `showListeners` is false: the Thread comes back **whole**,
composer included, the sidebar line is not rendered either (it shares the gate), and the retry that
load already started opens the directory again the moment it settles the pointer. The human's
request is not spent by the gap, because the gap never touched `view`.

### 3.2 The session does not remount

This is the whole point of the change, so it is stated as an invariant with its three reasons:

- `App` renders **one** element for both of the Lobby's addresses (`<WeaveRoute lobbyRoute …/>`), so
  a view flip changes a prop and never the component at that position. Had `listeners` stayed a route
  kind, `App`'s `switch` would return a different element and Preact would unmount the subtree.
- The view state is **not part of any key**. It lives in `WeaveSession`, above the session's mount,
  so a flip re-renders `WeaveMount` at the same position, with the same type and the same
  `key={reloadKey}` — which is an update, not a remount — and `WeaveMount`'s `useSession` is
  memoised on `[key, client, storage]` ([`useSession.ts:20`](../../../src/web/src/useSession.ts)),
  none of which is a function of the view.
- No `key` in the chain from `App` to `WeaveView` is a function of the view: `reloadKey` is bumped
  by a join and by nothing else, and `popSeq` is the directory's own key, below the session.

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

Inside `<div class="main">`, four groups — and **one question** decides which group an element is
in: *does anything that stays live in the directory view feed it, and does not drawing it destroy
something?* An element may be thread-view-only only when both answers are no — when it is derived
from session state that is still there when the Thread comes back, and when nothing that is still on
screen and still clickable reports through it.

Which group an element is *drawn* in is decided by **`showListeners`** (§3.1) and by nothing else:
the two one-view groups below are `!showListeners` and `showListeners`, never the raw `view`. A
requested `"listeners"` the gate refuses is therefore the thread view in full — the always group, the
invite banner, the message list and the composer, exactly as on `/lobby`.

- **Always, in both views** — the `archived` banner, the read-only/`secret-fallback` banner with its
  **Join**, the `refreshError` warn bar, and the mutation **`error` bar**. The first three describe
  the page or the Weave, not the Thread. The error bar is in this group for a harder reason:
  `WeaveView`'s `reportError` is the failure channel of `Header`, `ThreadList`, `GuidelinesPanel`
  and `RequestsPanel` ([`WeaveView.tsx:121-127`](../../../src/web/src/components/WeaveView.tsx)),
  every one of which is in the **header or the sidebar** and stays live while the directory is open.
  Drawn only in the thread view, a failed thread creation, a failed guidelines save, a refused offer
  or a failed archive would fail **silently** — the button would simply do nothing. The bar belongs
  to the layout, not to the Thread.
- **Thread view only** (`!showListeners`) — `InviteBanner` and `MessageList`. Both are pure
  functions of session state: every line of the invite banner is derived from `state.invitesForMe`,
  so nothing is destroyed by not drawing it and the same lines are back, unchanged, the moment the
  Thread is. Nothing reports a failure through either, and the banner's one control — its dismiss,
  `session.markSeen` — cannot fail. Nor is an invite arriving while the directory is open lost:
  `ThreadList`'s `invited` badge is in the sidebar, on screen in **both** views, fed by the same
  `invitesForMe` and cleared by the same `markSeen`. The banner is an invitation to go and read the
  Thread below it; with no Thread below it there is nothing for it to point at.
- **Mounted in both, drawn in one** — `Composer`, which keeps what was typed (§3.5). Drawn whenever
  `showListeners` is false, which includes every state in which the directory was asked for and
  refused: a Thread on screen is a Thread that can be written in.
- **Directory view only** (`showListeners`) — `ListenersPage`, under an `<h2>Listeners</h2>`.
  Demoted from `<h1>` because the page's `<h1>` is the Weave title in the header; this is the heading
  of one region of it. The class hook stays `listeners` so the existing selectors keep working, and
  the deleted `listeners-head` block takes the wordmark and **Back to the Lobby** with it (§7).

`NamePrompt` is outside `<div class="main">` altogether, at the foot of the layout, and stays
exactly where it is: the read-only banner's **Join** is on screen in both views, so the prompt it
opens has to be too.

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
> callback that calls the same `onView` the sidebar line calls (§3.1), so picking a Thread pushes
> `/lobby` exactly as pressing the line pushes `/lobby/listeners`, under §4.2's one condition.

Creating a Thread closes the directory too, because it selects the new Thread
([`session.ts:831`](../../../src/web/src/session.ts)) and leaving the human on the directory would
hide what they just made.

**Unread, invites and the stream are untouched.** Opening or closing the directory marks nothing seen
and un-marks nothing: `seenUpTo` moves only in `selectThread` and `markSeen`. A message arriving while
the directory is open updates the Thread list exactly as it does today, and the directory — which has
no stream and no live updates by design — ignores it.

### 3.5 The composer keeps what was typed

[`Composer`](../../../src/web/src/components/Composer.tsx) holds the message text, the caret, the
in-flight `busy` flag and its mention state in its own `useState`
([`Composer.tsx:6-11`](../../../src/web/src/components/Composer.tsx)). Unmounting it in the
directory view would therefore do the one thing this whole change exists to stop: throw away
something a human made. Typing half a message, opening the directory to look up who to @-mention,
and coming back is not an exotic path — it is the **reason** the directory is a view and not a page.

So the composer is **mounted in both views and drawn in one**:

> `WeaveView` renders it exactly where it does today, wrapped in one element that carries the
> `hidden` attribute while the directory is open:
>
> ```tsx
> {!archived && !readOnly && (
>   <div class="composer-slot" hidden={showListeners}>
>     <Composer state={state} onSend={send} draft={draft} />
>   </div>
> )}
> ```
>
> `hidden`, and not a class of our own, because it is the one way of being off the page that also
> takes the textarea out of the accessibility tree and out of the tab order: a hidden composer
> cannot be typed into by a keyboard that wandered into it, and a screen reader is not offered a
> message box for a Thread that is not on screen. `composer-slot` is a hook for the design session,
> and **no rule may give it a `display`** — that would defeat the UA's `[hidden]`.

**`showListeners`, and never `view === "listeners"`.** The composer is hidden because the Thread is
not on screen, so it must be hidden by the same predicate that took the Thread off it (§3.1). On the
raw `view` the two come apart in an ordinary case: a cold `/lobby/listeners` whose Lobby pointer is
still being retried reaches `ready` with the gate false, so §5 renders the **Thread** — and a
composer hidden on the request alone would leave a human with a valid identity reading a Thread they
cannot answer, with no directory on screen to explain why and no control anywhere to put it right.
The same holds for a Weave that is not the Lobby, and for the window after a reload whose discovery
failed (§3.1). There is exactly one predicate so that this cannot be got wrong in one place and
right in the others.

**Why not lift the text into `WeaveView`.** It is the larger change and it buys less. The text would
survive; the caret, the `busy` flag of a send in flight, the mention list's highlight and its
`dismissed` latch would not, and each would have to be lifted in turn or quietly reset. And it would
force a decision this spec has no business making: today the composer is **not** keyed on
`state.currentThreadId`, so a draft typed in one Thread follows the human into the next one. Whether
that is right is a question for another day; lifting the state would answer it as a side effect —
either reproducing it (one draft for the page) or changing it (a draft per Thread) — in a change
about the directory. Leaving the component mounted moves nothing: **switching Threads behaves
exactly as it does today, because nothing about the composer's lifetime has changed.**

**The `draft` prop is untouched.** A send that failed after a join is still handed back through it
([`WeaveView.tsx:104`](../../../src/web/src/components/WeaveView.tsx)), and the effect that restores
it still fires on `[draft]`. It may now land in a composer that is hidden — the read-only banner's
**Join**, and the prompt it opens, are on screen in either view (§3.3) — and the text is waiting,
with the caret at its end exactly as today, when the Thread comes back.

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

**Amended 2026-09-20 (found in the second plan review):** the handler belongs to the mount that owns it and is **dead once that mount has unmounted** — `key={reloadKey}` retires `WeaveMount` on a join while the view state and its setter stay with `WeaveSession`, which survives, so an `onView` captured before the join still holds a live setter and a ref that stopped updating when it was retired; it therefore checks its own liveness (a `mounted` ref cleared in an effect cleanup) **first**, before the change test below, before `leavingIsSafe`, and before any `pushState` or `setView`.

**Amended 2026-09-20 (found in plan review):** a push is made only when the requested view actually **changes** — `onView` is also `ThreadList`'s `onPick` (§3.4), called on every Thread selection and every successful creation, so an unguarded handler would push a duplicate `/lobby` for ordinary Thread navigation with the directory closed; the handler therefore compares `next` with the **current** requested view, read through a ref rather than from the render that created it (the same render that must not be trusted for `leavingIsSafe`, since `onPick` runs after an `await`), and where they are equal it pushes nothing and changes nothing.

Both halves are re-read per click, and the push is made **in `WeaveMount`**, which already computes
that second half as `canLeave` for `openMainInPlace`
([`WeaveRoute.tsx:134-135`](../../../src/web/src/components/WeaveRoute.tsx)): it wraps the setter
`WeaveSession` handed it and gives `WeaveView` the wrapped `onView` (§3.1). The permission therefore
needs no new prop, and the one component that knows it is the one component that writes history.
What is pushed is
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
  `inPlace` parameter**. What replaces that parameter is not the path test quietly standing in for
  it: it is the narrower promise of §4.5. The parameter existed because a page rendered in place sat
  on **another page's path**, and a query string written there would have hung this page's filters
  off an address that names something else. The path test refuses exactly that, and it refuses
  nothing else — which is the point: `replaceState` onto the path the browser is **already on** adds
  no entry, loads nothing, and takes away no address this browser could otherwise have survived.
  The permission to *leave* is not consulted, because nothing is being left (§4.5).
- **The directory reads the query string exactly where it writes it.** One condition,
  `viewOfPath(location.pathname) === "listeners"`, governs both halves, so there is no browser that
  seeds itself from an address it then refuses to keep up to date — which is the state that leaves
  an address bar actively lying about what is on screen.
- Ten keystrokes' worth of filtering are still not ten Back steps, and Back still leaves the
  directory. That is literally true wherever the open was allowed to push: the entry Back returns to
  is the `/lobby` that push wrote.

### 4.4 `popstate`

`WeaveSession` registers one `popstate` listener in an effect with an empty dependency list,
**only** when `viewOfPath(location.pathname)` is defined at mount, and removes it on unmount. It is
registered there, beside the state it writes and above the join remount (§3.1), so a Back pressed
after a rejoin still flips the view; nothing is missed by mounting late, since `WeaveSession` is on
screen before any control that could have pushed. Registration deliberately does **not** depend on
`canLeave`: storage can degrade after a push, and a listener torn down mid-life would leave Back
changing the URL without changing the view. A `popstate` the page never caused is harmless — it sets
the view to what the URL already says.

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
always §4.3's one rule.

### 4.5 Where history is never pushed — and the one thing that is still written

**The promise, in one sentence.** This app **never pushes** a history entry unless `leavingIsSafe`
says the address it would push is one this browser could load again (§4.2). That is the whole of the
Global Constraint's claim on this feature, and it holds on `/weave/<lobbyId>`, on `/w/<secret>`, on
any Lobby rendered in place, and on any Lobby page whose storage is degraded: the view switches and
the URL does not move.

**The exception, stated once and narrowly.** The directory rewrites **its own page's query string**
whenever `location.pathname` is `/lobby/listeners` — either spelling — whatever `leavingIsSafe`
says. `replaceState` onto the path the browser is already sitting on adds no entry, loads nothing,
and leaves reachable exactly the addresses that were reachable a moment before: the entry it
rewrites is the one the human is on, and a reload of `/lobby/listeners` costs a memory-only browser
its identity with or without `?q=bob` on the end. There is no version of that URL this browser
survives, so a query string on it takes nothing away.

This has to be said rather than assumed, because a browser that may not push can be standing on that
path in two ordinary ways:

1. **A deep link.** `/lobby/listeners` is a public address; anyone may open it cold and then join
   into a browser that persists nothing (§5). No push ever happened, and the path is still this
   page's.
2. **Persistence lost afterwards.** A durable `/lobby` pushes `/lobby/listeners`, and the notice
   latches later on a failed write. From then on `canLeave` is false: closing the directory no
   longer pushes `/lobby`, and the address bar stays at `/lobby/listeners` while the Thread is on
   screen.

In both, filtering keeps the address bar honest about what the directory is showing. The alternative
— refusing the write — leaves the stale query string of the link the page was opened with on an
address that names **this** page, which is worse than no query string at all: it is a URL that is
wrong about the screen it belongs to, and the page would also be seeding itself from an address it
had decided not to maintain (§4.3).

**What is given up.** Where no push is allowed, the URL and the view may disagree — the same trade
`openListenersInPlace` made, minus its machinery — and the page already says why: the not-persisting
bar is on screen in exactly that case. On `/weave/<lobbyId>` and `/w/<secret>` the path is not this
page's at all, so nothing whatever is written and a filtered view cannot be copied as a link there,
which is the consequence listeners spec §12.7 already recorded and accepted.

## 5. The Lobby gate, and every state the page can be in

The gate is the sidebar line's own, unchanged and id-based:
`state.status === "ready" && !!state.lobby && state.lobby.weaveId === state.weave?.id`
([`ListenersLink.tsx:23`](../../../src/web/src/components/ListenersLink.tsx)). One rule covers all of
it:

> The view state is held whatever the gate says; the gate decides only whether the directory is
> **rendered**. The two are multiplied once, in §3.1, into `showListeners = lobbyGate && view ===
> "listeners"`, and that is the only thing any rendering branch reads. A requested `"listeners"`
> under a false gate is `showListeners === false`, which renders the Thread — **the whole Thread**:
> message list, invite banner and composer, exactly as `/lobby` renders it.

So a deep link whose Lobby pointer has not settled yet shows a working Thread, and opens the
directory the moment `retryLobbyData` settles it — no second flag, no pending-open state. The Thread
it shows in the meantime is not a degraded one: the credential is whatever the session picked, the
identity is whatever the human joined as, and neither has anything to do with the pointer being
unread. Withholding the composer there would punish a human for a `getLobby()` that is still in
flight.

**Two discoveries, not one** — which is why the last row is reachable at all on a page that got this
far. `LobbyRoute` resolves the pointer to know which Weave to mount; the session resolves it **again**
for `state.lobby` ([`discoverLobby`, `session.ts:284-289`](../../../src/web/src/session.ts)), and the
gate reads the session's copy. `LobbyRoute`'s copy answering is therefore no promise that the
session's has: the first three rows below are `LobbyRoute`'s and they replace the whole page, while
the gate can still be false underneath a page that is up, ready and perfectly usable.

| Situation on `/lobby/listeners` | What happens |
| --- | --- |
| discovery pending | `LobbyRoute` renders its existing "Loading…" card. `WeaveSession` is not mounted yet; the initial view is still in the route, and nothing can have pushed. |
| discovery fails | `LobbyRoute`'s existing error card, with its way home. The directory's own duplicate of this card is deleted (§7). |
| `weave_not_found` — no Lobby | `LobbyRoute`'s existing "This instance has no Lobby yet." |
| session `loading` | `WeaveView`'s existing "Loading…". The view state is above it (§3.1) and untouched by a load, so the directory opens on ready — which is also what happens after a credential recovery (§6.3) — provided that load settled the pointer too; where it did not, the row below applies until the retry does. |
| session `error` | `WeaveView`'s existing error card. |
| session `no-credential` — an unjoined visitor | `WeaveRoute`'s existing unjoined-Lobby fork: `JoinLobbyForm` with its own way home. On success `reloadKey` remounts `WeaveMount`, and the view comes back **as it was**, because it is held above that key (§3.1): a visitor who deep-linked the directory lands in it — the brainstorm's rule — and so does one who opened it here and then lost the credential, including on a browser that was never allowed to put it in the URL. |
| ready, gate true | the directory (`showListeners`). |
| ready, gate false (the session's own discovery still retrying or failed, or this Weave is not the Lobby) | the Thread, **whole and writable** — `showListeners` is false, so every group of §3.3 renders exactly as it does on `/lobby`, the composer slot included. The sidebar line is not rendered either, since it shares the gate. `view` still says `"listeners"`, so the directory opens by itself if the pointer settles later (§3.1). |

## 6. Credentials: one owner, and who may spend a recovery

### 6.1 Reading, and spending the credential: two entry points

```ts
/** What a query was issued under — which reader asked. Opaque to the view: it exists to be handed back. */
export type QueryIssue = { readonly generation: number };

listListeners(query: ListenersQuery): { issue: QueryIssue; page: Promise<ListenersPage> };
/** Told of a rejection by a caller that has **already** established the query is still wanted. */
reportCredentialFailure(e: unknown, issue: QueryIssue): void;
```

on the [`Session`](../../../src/web/src/session.ts) object, beside `targets()`. **Two entry points,
not one**, and that split is the whole of this section: reading the directory is not the same act as
spending the page's one credential recovery, and only the second needs an owner.

```ts
listListeners(query) {
  // Both read before the request leaves, in one synchronous step: `issue` names the very reader
  // this asks with. No guard on the answer, because there is nothing to guard — the session does
  // nothing with it. The page is the view's, and the view's own guard decides whether it is wanted.
  const issue = { generation };
  return { issue, page: reader.listListeners(query) };
},
reportCredentialFailure(e, issue) {
  // The reader this query was issued under is not the one the session holds now: a newer load has
  // replaced it, or the session is disposed. Recovering here would retire a credential on the
  // strength of a request that proves nothing about the one in hand.
  if (disposed || issue.generation !== generation) return;
  const recovered = recoverFromCredentialFailure(e);
  if (recovered?.reload) void doLoad();
},
```

and the call site, which is the other half of the rule and is not optional:

```ts
const { issue, page } = session.listListeners(queryFromView(next, { limit: PAGE, cursor, facets: cursor === undefined }));
page.then(onAnswer, (e: unknown) => {
  if (!live.current || n !== gen.current) return;   // the view's guard, first, as on the answer
  session.reportCredentialFailure(e, issue);        // only a LIVE query may authorise a recovery
  /* …then render the failure exactly as any other query failure (§6.2)… */
});
```

**Why not one method that recovers for itself.** Because it cannot know whether anybody is still
waiting. A `listListeners` that caught its own 401 would run the recovery **inside** the session,
before the view's `n === gen.current` guard ever ran: query B supersedes A, A comes back 401, and the
page invalidates its identity and reloads on the strength of an answer nobody wanted. Worse, the
session outlives the view — the same 401 landing after the directory was closed, or after
`WeaveView` itself was replaced, would still spend the one fallback there is. This is the defect the
predecessor work fixed three times, on the own-profile read, on the count read and on the
directory's own rejection handler, and each time the fix was the same sentence: **the guard comes
before any side effect, on rejections as much as on answers**
([`session.ts:323`](../../../src/web/src/session.ts),
[`session.ts:359-363`](../../../src/web/src/session.ts)). A rejection cannot be trusted to guard
itself; only the thing that is waiting for it knows whether it still is.

**Why the ticket comes out of the query, and not from a getter.** `issue` is handed back by the call
that made the request, so it cannot be captured a moment too late. A `session.currentGeneration()`
the view read *after* its await would return the generation of the reader that **replaced** the one
the query used, and would authorise precisely the recovery this rule exists to refuse.

**The two guards answer different questions, and both are needed.**

- The **view's** guard answers *is anyone waiting for this?* — is this still the newest query this
  directory asked, and is the directory still mounted. The session cannot answer it: `gen.current`
  and `live.current` are the view's.
- The **session's** guard answers *is this evidence about the credential I hold?* — a view can be
  perfectly live and still be holding a rejection from a reader the session has since replaced. It
  is the same question, and the same counter, that `readListenerCount` asks on its own rejection
  ([`session.ts:363`](../../../src/web/src/session.ts)). `generation` is the right name for "which
  reader": it is bumped by `doLoad` **before** `reader` is reassigned
  ([`session.ts:614`](../../../src/web/src/session.ts), `:630`), by the retirement inside
  `recoverFromCredentialFailure` ([`session.ts:201`](../../../src/web/src/session.ts)) and by
  `dispose`, and by nothing else — so a live generation *is* the reader the query went out with.

**Every rejection, and what it does.**

| The rejection | What happens |
| --- | --- |
| Query A superseded by B; A returns 401 | The **view's** guard drops it. `reportCredentialFailure` is never reached; nothing is read, written or reported. |
| A 401 landing after the directory was closed, or after `WeaveView` unmounted | The view's `live` ref drops it, for the same reason. The promise is handled either way, so there is no unhandled rejection. |
| A 401 landing after the session has already fallen back to the secret | The view may be perfectly live — a newer mount with an older query still in flight — so the **session's** guard is what refuses it: `issue.generation` is the retired reader's. Nothing is invalidated a second time. |
| Two queries of the same generation both 401 | The first recovers. Recovery bumps the generation **synchronously** — `doLoad` bumps before its first `await`, the no-credential branch bumps in place — so the second is refused by the session's guard. Exactly one recovery. |
| A live 401 while reading with the **token**, a secret stored | `recoverFromCredentialFailure` invalidates the identity (keeping the secret), reports the `WriteResult`, answers `{ reload: true }`, and the session calls `doLoad()`, which re-picks the reader (§6.3). |
| A live 401 while reading with the **token**, no secret | The same helper retires the stream and the generation and settles the session at `no-credential`; `WeaveRoute`'s join fork replaces the page (§5). |
| A live 401 while reading with the **secret** | `undefined` — an ordinary query error (§6.2, row 3). |
| A live failure that is not a credential failure at all | `undefined`, for the same reason: `isCredentialFailure` is asked **inside** the session, so the view never has to know what a credential failure looks like (§7). |

Three notes on what did not change:

- **The page reader**, `reader`, exactly as `readListenerCount` and `readRequests` use it
  ([`session.ts:350`](../../../src/web/src/session.ts)). The directory therefore reads with the
  credential the page next to it reads with — the token while the identity is usable, the stored
  secret when it is not. **One credential owner**, which is the whole of this section.
- `reader` is read before the request leaves, in the same step as `issue`, so a reload landing
  mid-flight cannot change which credential this request was made with — and `issue` names that
  reader and no other.
- **The view still renders the failure.** The session's job is the credential; the query's answer and
  its failure belong to the view, which already has a generation guard, an error cell and a "keep the
  rows" rule. `reportCredentialFailure` returns nothing to branch on: where it recovered, `doLoad`
  takes the page to `loading` and the directory unmounts under the error it has just painted (§6.3);
  where it did not, that error is the only thing that happened.

### 6.2 What replaces each of `ListenersRoute`'s four forks

| Old behaviour (listeners spec §5.5) | What replaces it |
| --- | --- |
| No credential at all → the route's own `JoinLobbyForm` | The session reaches `no-credential` and `WeaveRoute`'s unjoined-Lobby fork replaces the whole page (§5). The directory is not on screen. |
| 401/403 while reading with the **token** → `invalidateIdentity` + `key` remount on the secret | `recoverFromCredentialFailure` does exactly this — invalidate (keeping the secret), report the `WriteResult`, answer `{ reload: true }` — and `doLoad()` re-picks the reader. It is reached only through `reportCredentialFailure`, and only for a query that is still live under the reader that made it (§6.1). |
| 401/403 while reading with the **secret** → the terminal "The Lobby refused the link this browser holds." card | **Nothing, deliberately.** `recoverFromCredentialFailure` answers `undefined` for a page-credential failure while not reading with a token, so it is an ordinary query error: the message goes above the rows that are on screen and the rows stay. The loop the amended §5.5 was written against cannot happen here — the session's `retriedWithSecret` latch is the same one-fallback-per-identity rule, and it is not the view's to spend. |
| `getLobby()` failures | `LobbyRoute`'s, already (§5). |

### 6.3 Re-querying after a recovery

No new session state, and no signal to plumb: `doLoad()` sets `status: "loading"`
([`session.ts:626`](../../../src/web/src/session.ts)), `WeaveView` renders its loading card, the
directory **unmounts**, and on ready it mounts again and makes its first query with the new
credential. The view state is above all of it (§3.1) and a load does not touch it, so the directory
is what comes back — whether the round trip ended in a reload or in a join through the fork.

What the round trip *can* move is the **gate**, not the view: the reload runs its own
`discoverLobby`, and one that fails republishes the page with no pointer. Then `showListeners` is
false and what comes back is the Thread, whole and writable, until the retry settles the pointer and
the directory opens by itself (§3.1). The request the human made survives that gap untouched, because
nothing in it is written to `view`.

The cost, stated: that remount re-seeds from the URL, so the filters survive exactly where the
address bar holds them — which by §4.5 is **every browser sitting on `/lobby/listeners`**, durable
or not, the deep-linked memory-only one included. They are lost only where the path was never this
page's: a Lobby rendered in place, `/weave/<lobbyId>`, `/w/<secret>`, and a `/lobby` whose open was
not allowed to push. Acceptable — and it is the same round trip that makes closing and reopening the
directory bring the filters back on a page whose URL holds them, because that URL is the only memory
the directory has and §4.5 is what keeps it honest.

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
  call and its `weaveKey`/`isCredentialFailure`/`PersistenceNotice` imports — "is this a credential
  failure?" now has exactly one asker, inside the session (§6.1), and the view's failure path is one
  branch shorter for it. What is left is `{ session: Session }` — the directory reads nothing from
  session state.
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

`active` is **`showListeners`** (§3.1), not the raw `view` — the line says what is on screen, and it
is the same predicate that put it there. The two can only differ where the line renders nothing at
all, since its own gate *is* `lobbyGate`; passing the effective view anyway is what keeps "the line
is marked current exactly when the directory is drawn" true by construction rather than by two
conditions happening to agree.

**`ThreadList`'s own `aria-current` is untouched**, in both views. The selected Thread is still
selected — it is what the main area comes back to, its unread mark keeps moving, and clearing the
mark while the directory is open would say the session had forgotten where it was. It is not a
function of the view today and this spec does not make it one; whether the two marked lines want to
look different is a question for the design session (§15), not a behaviour change here.

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
- **A superseded query's 401 writes nothing, and two guards say so.** The view's
  generation-and-mounted guard runs first, before the session is told anything at all — so the
  session is never asked to recover for a query nobody is waiting for, nor for one whose owner has
  unmounted. Behind it, `reportCredentialFailure` compares the generation the query was **issued**
  under with the one the session holds now, so a rejection from a reader that has already been
  replaced is refused even when the view asking is perfectly live. Reading and spending the
  credential are two calls precisely so that the first cannot perform the second (§6.1).
- **Nothing on the read path is authorised by the session alone.** `listListeners` performs no side
  effect whatever — no write, no `onWrite`, no `set()`, no `doLoad` — on the answer or on the
  rejection.
- **A mutation failure is visible in both views.** `reportError` is the failure channel of the header
  and of all three sidebar panels, every one of which stays live while the directory is open, so the
  bar it feeds is rendered in both (§3.3). Nothing that can still be clicked reports into a bar that
  is not on screen.
- **What a view switch destroys, deliberately, and what it does not.** Destroyed: the directory's
  rows, facets, "list changed" baseline and in-flight query when it closes (§4.4, §15), whether the
  human closed it or a reload's own failed discovery closed it under them (§3.1) — reopening
  re-queries either way; and the
  message list's scroll position when the Thread comes back — `MessageList` holds no scroll state of
  its own and its one effect scrolls to the newest message on mount
  ([`MessageList.tsx:53`](../../../src/web/src/components/MessageList.tsx)), so a human who had
  scrolled up is returned to the bottom. That is a smaller loss than today's, where opening the
  directory tore the whole session down, and putting it back needs a scroll-position mechanism this
  change does not have (§15). Not destroyed: the composer's text, caret and in-flight send (§3.5),
  `ThreadList`'s open **New thread** form with both its fields, `ThreadTools`, `GuidelinesPanel`'s
  open editor and its draft, and `RequestsPanel`'s open request form, its per-request offer notes,
  its accept form and its countdown — every one of those is in the sidebar, which never unmounts.
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
8. Memory-only `/lobby` (a degraded notice, and a pending storage key): the view switches, filtering
   works, and the address bar never changes — no push, so the path stays `/lobby` and `writeSearch`
   has nothing to write to.
9. **A live 401 recovers, exactly once.** From the open directory, a query answered `401`: the
   identity is invalidated, the secret is kept, the next query carries the secret, and the directory is
   on screen again with rows — **re-fetched, not preserved**: the recovery takes the page through
   `loading`, which unmounts the directory, and its fresh first query is the one that carries the
   secret (§6.3). The stub must tell the directory's query from the session's count read, which
   shares its pathname: the count is the one with `limit=0`, and a `401` scripted onto the pathname
   alone would be spent by the count read instead. Two rejections from the same
   generation cause **one** invalidation. With no secret to fall back to, the page settles at
   `no-credential` and the join fork replaces the layout. The store assertions live in
   `session.test.ts` against a real server; what is on screen is asserted here.
10. `session.listListeners` has no side effect of its own: it hands back the rejection for the view
    to render and writes **nothing**, not even for a 401 — a recovery happens only when
    `reportCredentialFailure` is called for that query (`session.test.ts`).
11. **Clear filters**: rendered at defaults and disabled there; enabled by one keystroke before the
    debounce fires; resets sort and direction as well as the filters; leaves the address bar at a bare
    `/lobby/listeners`.
12. The counts line in both forms, word for word.
13. Picking a Thread closes the directory; creating one closes it too; the composer is not *drawn*
    while the directory is open — its wrapper carries `hidden`, so it is out of the tab order and out
    of the accessibility tree; an event arriving while it is open still updates the Thread list.
14. **A recovery is authorised only by a live query.** Three ways it must not be, and none of them
    writes to storage or moves `status` (`session.test.ts` for the first and third, the DOM suite for
    the second):
    a. a 401 for a query the view has already superseded — `reportCredentialFailure` is never
       reached, because the view's own guard returns first;
    b. a 401 that lands after the directory was closed, and one that lands after `WeaveView` has
       unmounted entirely;
    c. a 401 whose `issue` was taken before a reload the session has since completed — reported by a
       live view, and refused by the session's own generation guard.
15. **The draft survives the round trip.** Type into the composer, open the directory, come back: the
    text and the caret are where they were, and the send that follows posts exactly that text. The
    hand-back is unchanged — a send that fails after a join still returns its text to the composer,
    and it is still there after a trip through the directory. Switching Threads behaves as it does
    today, which this test pins so the next change cannot move it by accident.
16. **A mutation failure is visible while the directory is open.** A failed `createThread` from the
    sidebar, and a failed guidelines save, each put their message in the shared error bar with the
    directory on screen.
17. **A rejoin restores the view.** Open the directory, let the token die with no stored secret, join
    through the fork: the directory is what comes back. Twice — on a durable browser, where the
    address bar reads `/lobby/listeners` throughout, and on a memory-only one, where it never left
    `/lobby` and the view is the only record there is.
18. **One history rule, in the two cases the path test alone got wrong.** A deep-linked memory-only
    `/lobby/listeners`: filtering **replaces** the query string, and `pushState` is never called — not
    by a filter, not by the sidebar line, not by picking a Thread. A durable `/lobby` that opens the
    directory and then loses persistence: filtering still replaces, closing the directory pushes
    nothing, and the address bar stays at `/lobby/listeners` with the Thread on screen.
19. **A deep link whose Lobby discovery is delayed renders a WRITABLE Thread.** The stub answers
    `LobbyRoute`'s `getLobby`, **rejects the session's first one transiently** (a network failure,
    not a credential failure and not `weave_not_found`), and **holds the next one pending** — the
    one `retryLobbyData` makes. A first discovery that merely *hangs* cannot reach this state:
    `discoverLobby()` sits inside `doLoad`'s `Promise.all`
    ([`session.ts:663`](../../../src/web/src/session.ts)), so the page would stay `loading` and
    never paint a Thread at all. A rejected one settles the load with `lobbyKnown` false, the page
    goes `ready` with no pointer, and the retry loop owns the discovery from there — which is the
    real-world shape of the gap, and needs no change to how the session loads. On screen: the message list, and the composer **visible and usable** —
    type into it and send, and the post lands with exactly that text. No directory is rendered, no
    `<h2>Listeners</h2>`, and no sidebar line is marked current — the line is not on screen at all,
    because it shares the gate. Then release the held **retry**: with no further input the
    directory opens, the composer's wrapper carries `hidden`, and the line is there carrying
    `aria-current="true"`. The requested view was never touched, and nothing was re-mounted to get
    there (the request counts of test 2 do not move).
20. **A deep link whose discovery fails, or finds no Lobby, still leaves the Thread writable.** The
    same shape with the session's `getLobby` **rejecting**, and again with it answering
    `weave_not_found`: `/lobby/listeners` is ready, the Thread is whole, and a typed message sends.
    In the `weave_not_found` case nothing ever opens the directory, and the page is a working Lobby
    Thread rather than a half-drawn one for the rest of its life.

## 13. Docs to update

| Doc | Change |
| --- | --- |
| `docs/ARCHITECTURE.md` §9 | the route table: `/lobby/listeners` is the Lobby with the directory open, not a page of its own; the in-place mirrors go back to two; a new paragraph beside `leavingIsSafe` for the one history rule — never **push** unless leaving is safe, and the page's own query string rewritten wherever the path is this page's (§4.5); the component list loses `ListenersRoute` |
| `docs/ARCHITECTURE.md` §12 | two sentences: the directory is read through `session.listListeners`, which is the page's own reader, and a credential recovery is authorised by the **view** through `session.reportCredentialFailure` — core's Listeners paragraph is otherwise unchanged |
| `docs/TESTING.md` smoke test 6 | **step 3** rewritten (the line is a button; pressing it keeps the header, sidebar and connection and swaps the main area; the address bar reads `/lobby/listeners`; a half-written message left in the composer is still there on the way back); **step 8** rewritten (Back leaves the directory and returns to the live Thread, Forward comes back with the filters; filter changes are still not history entries); **step 10** rewritten (blocked site data: the view still opens, the address bar never moves, and the way back is the Thread list, not a "Back to the Lobby" link). The 2026-09-20 run record stays, marked as the run that produced this spec |
| `docs/KNOWN-ISSUES.md` | the appearance row (the directory's look, still unsigned) narrowed to what this change does not settle and re-pointed at the design session; the `ListenersPage` size row re-measured; the "no live updates" and "`partial` latches" rows unchanged |
| `src/web/README.md` | the routes table row for `/lobby/listeners`; `ListenersRoute` out of the component list; the in-place pair description; `session.listListeners` added beside the count read |
| `docs/REVIEW-BRIEF.md` | the web row and the "where to look first" list |
| `docs/superpowers/specs/v2-notes.md` | the listeners section gains a dated entry pointing at this spec |
| `docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md` | dated "superseded by" notes on §5.1, §5.2, §5.3, §5.4, §5.5 and §7, each naming the section of this spec that replaces it (§2's table is the list) |

## 14. Implementation order

Four task-sized steps; each ends green.

1. **The route and the view shell.** `lobby-view.ts`; `Route`/`routeOf`/`App` (the `listeners` kind
   and `openListenersInPlace` deleted); the view state in `WeaveSession` and the prop chain down to
   `WeaveView`; **`showListeners`**, computed once and read by every branch below it (§3.1); the four
   render groups, the hidden composer slot, the shared error bar, the `<h2>`; `ListenersLink` as a
   toggle taking `active={showListeners}`; `ThreadList`'s `onPick`. `ListenersPage` still mounted
   with its old props behind a temporary adapter so the suite stays green. DOM tests 2, 3, 13, 15,
   16, **19 and 20** — the gated-deep-link pair belongs here, with the predicate it pins, and needs
   no query string and no history to run.
2. **`session.listListeners` / `reportCredentialFailure`, and `ListenersPage`'s new props.** The two
   entry points with their guards; `ListenersPage` down to `{ session }` and its failure path down to
   one branch; `ListenersRoute` deleted; `writeSearch` loses `inPlace`; the seeding rule. Tests 9,
   10, 14, plus the re-homed blocks.
3. **History.** The push rule in `WeaveMount`, the `popstate` listener, the `popSeq` key. Tests 4, 5,
   6, 7, 8, 17, 18.
4. **Wording and docs.** CR2, CR5, then §13 in one commit. Tests 11, 12.

Step 1 is the only one that touches a component every Weave page renders, so it is first and on its
own. Step 3 is last of the behavioural three because it is the only new *capability* in the change
and the easiest to get wrong without the rest already settled.

## 15. Later / out of scope

- **The visual design of the whole web client**, CR4's effort-row layout included — the owner's own
  session. This spec deliberately names no styling.
- **Remembering the directory's rows across a close.** Reopening re-queries; a cache would have to
  answer "how stale is too stale" for a directory that already refuses to update itself live.
- **Keeping the message list's scroll position across a view switch.** The Thread comes back
  scrolled to its newest message (§11). Preserving it means giving `MessageList` a scroll memory it
  has never had, and answering "where should it land when six messages arrived while you were away?"
  — a question worth asking on its own, not as a side effect of this change.
- **A view for anything else in the main area** (a Weave switcher, a paged participant list).
  `MainArea` is a union so that adding one is a case rather than a rewrite; nothing else is designed.

## 16. Assumptions to confirm

Stated as assumptions so implementation is not blocked. Each was decided here because the brainstorm
does not settle it.

1. `routeOf("/lobby/listeners")` returns `{ kind: "lobby", view: "listeners" }`, and `Route.view` is
   an initial value that a later `pushState` deliberately does not update (§4.1).
2. The sidebar line is **always** a `<button>` and never an anchor, and it carries `aria-current`
   rather than `aria-pressed`, to match the Thread buttons beside it; its `active` is
   `showListeners`, and `ThreadList`'s own `aria-current` is not made a function of the view (§8).
3. `ThreadList` gains an `onPick` prop, and **creating** a Thread closes the directory as well as
   selecting one (§3.4).
4. The view state (and `popSeq`, and the `popstate` listener) lives in **`WeaveSession`**, above
   `key={reloadKey}`, so a join rebuilds the page under it without resetting which part of the page
   the human was looking at; `WeaveView` takes `view`, `viewKey` and `onView` as props and owns none
   of it (§3.1). `view` is the view **requested**: history and the rejoin read it, and nothing
   rendered does — see assumption 19.
5. The push of §4.2 is made in **`WeaveMount`**, which wraps the setter before handing it on, so the
   `leavingIsSafe` permission needs no new prop and no component below it makes a history decision
   (§3.1, §4.2).
6. `WeaveView` keeps rendering the archived, read-only and refresh-error banners **and the mutation
   error bar** in both views, because the header and all three sidebar panels report through that bar
   and stay live in the directory view; `InviteBanner` and `MessageList` are thread-view-only, on the
   ground that both are pure functions of session state and the sidebar's `invited` badge carries the
   invite in both views (§3.3). Which group is drawn is decided by `showListeners`, never by `view`.
7. `Composer` is **mounted in both views and hidden** in the directory, in a `composer-slot` wrapper
   carrying `hidden={showListeners}`, rather than unmounted — so the text, the caret, an in-flight
   send and today's cross-Thread draft behaviour are all unchanged. The `draft` hand-back is
   untouched (§3.5).
8. The message list's **scroll position is not preserved** across a view switch: the Thread comes
   back at its newest message (§11, §15).
9. The directory **unmounts** when closed and re-seeds by §4.3's one rule on every open, and every
   `popstate` remounts it through a `popSeq` key (§4.4).
10. `session.listListeners` returns `{ issue, page }` and performs no side effect; a credential
    recovery happens only through `session.reportCredentialFailure(e, issue)`, called by the view
    **after** its own liveness guard, and refused by the session unless `issue.generation` is still
    the session's (§6.1).
11. No new `SessionState` field: the re-query after a credential recovery comes from the existing
    `loading` → `ready` round trip (§6.3).
12. The history rule is **never push** unless leaving is safe; the page's own query string is
    rewritten wherever `location.pathname` is `/lobby/listeners`, whatever `leavingIsSafe` says, and
    `writeSearch` therefore loses its `inPlace` parameter without gaining another (§4.3, §4.5).
13. The refused-secret terminal card has **no** replacement: it becomes an ordinary query error
    (§6.2).
14. `ListenersPage` takes `{ session }` alone — it reads nothing from `SessionState`, and it no
    longer asks whether a failure is a credential failure (§7).
15. The view's own heading is `<h2>Listeners</h2>` inside the main area, and the page header is
    unchanged in both views (§3.3).
16. **Clear filters**' disabled test uses the raw draft box, so a single typed space leaves it live
    (§9).
17. Where no push is allowed the URL and the view may disagree, with no notice of its own beyond the
    persistence bar already on screen (§4.5).
18. No core, server or client change — verified against `src/server/src/app.ts` and the existing
    client method (§10).
19. **One effective predicate decides everything that is rendered.** `WeaveView` computes
    `showListeners = lobbyGate && view === "listeners"` once, and the main area, the §3.3 groups, the
    composer slot's `hidden`, the directory with its `<h2>` and `viewKey`, and the sidebar line's
    `active` all read it; the raw `view` is read only by the push of §4.2, by `popstate`, by
    `initialView` and by the state that survives a rejoin. A requested `"listeners"` the gate refuses
    therefore renders the Thread **whole and writable**, and a gate that turns true later opens the
    directory with no extra state and no effect (§3.1, §5).
