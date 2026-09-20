# Loom — The Lobby Listeners View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the listeners directory from a page of its own into a **view of the Lobby's main area**, so following **Listeners (N)** swaps the chat area while the header, the sidebar, the session and its WebSocket stay exactly where they are — and `/lobby/listeners` survives as a deep link and as a real history entry.

**Architecture:** `Route` loses its `listeners` kind; `/lobby/listeners` becomes `{ kind: "lobby", view: "listeners" }`, so `App` renders **one** element for both of the Lobby's addresses and a view flip is a prop change rather than a remount. The view lives in `WeaveSession` above `key={reloadKey}`; `WeaveView` multiplies it with the Lobby gate **once** into `showListeners`, which is the only thing any rendering branch reads. `ListenersRoute` — a second Lobby resolver, a second credential pick, a second join fork — is deleted whole: the session owns the credential and serves the directory through `session.listListeners(query)`, with a recovery authorised only by the view through `session.reportCredentialFailure(e, issue)`. `WeaveMount` makes the app's first `pushState`, under one condition.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Preact 10 + `@preact/preset-vite`, Vite 7, Vitest 4 (node environment against real Postgres and a real server; happy-dom 20 via a `// @vitest-environment happy-dom` docblock for DOM tests), `@testing-library/preact` 3. No core, server or client change.

**Spec:** `docs/superpowers/specs/2026-09-20-loom-lobby-listeners-view-design.md` (read it whole, §16 included, before any task). It **amends** `docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md`, which is still the governing text for everything it does not touch. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`.

**Base:** branch `feat/lobby-listeners-view` off `main` **after this docs branch (`docs/lobby-listeners-view-spec`) merges**. From `main` this plan consumes, unchanged: `leavingIsSafe(storage, notice, key?)` in `src/web/src/persistence.ts:54`; `useSession(target, deps)` memoised on `[key, client, storage]` (`src/web/src/useSession.ts:20`); `recoverFromCredentialFailure(e, failed?)` (`src/web/src/session.ts:167-205`); `readListenerCount` and its two guards (`session.ts:347-373`); `discoverLobby` / `retryLobbyData` (`session.ts:284-290`, `:500-541`); `doLoad` (`session.ts:611-768`); `ListenersPage`, `FacetChips` and `listeners-query.ts` in their PR #20 shape; `src/server/src/app.ts:86-88`, which **already** enumerates `/lobby/listeners` and `/lobby/listeners/` among its nine served paths.

**Commit trailer.** Every commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. The quoted rules are the spec's own words.

- **Branch** `feat/lobby-listeners-view`, one commit per task with the exact subject the task gives, ending with the trailer above. No pushes and no PR until the plan is finished.
- **One effective predicate decides everything that is rendered.** `WeaveView` computes, once, immediately below its early returns for `no-credential`, `loading` and `error`:
  ```tsx
  const lobbyGate = state.status === "ready" && !!state.lobby && state.lobby.weaveId === state.weave?.id;
  const showListeners = lobbyGate && view === "listeners";
  ```
  **`showListeners` — the effect** is read by everything rendered: which group of §3.3 is drawn, the composer slot's `hidden`, `ListenersPage` with its `<h2>` and its `viewKey`, and the sidebar line's `active`/`aria-current`. **Nothing rendered reads `view`.** **`view` — the request** is read only by the push of §4.2, by the `popstate` listener, by `initialView` which seeds it, and by the state itself held above `key={reloadKey}`. A requested `"listeners"` the gate refuses renders the Thread **whole and writable** — message list, invite banner and composer — exactly as `/lobby` renders it.
- **The view state lives in `WeaveSession`, above `key={reloadKey}`**, as one `useState`; a join rebuilds everything below that key and "which part of the page the human was looking at is not the join's to reset". `popSeq` sits in the same state object, and the `popstate` listener is registered there too.
- **The session never remounts on a view flip.** `App` renders one `<WeaveRoute lobbyRoute …/>` for both of the Lobby's addresses; no `key` from `App` down to `WeaveView` is a function of the view; `useSession` is memoised on `[key, client, storage]`, none of which is. A test asserts it **by counting requests, not by inspecting internals**.
- **The history rules.**
  - **Push only when** `viewOfPath(location.pathname) !== undefined` **and** `leavingIsSafe(storage, notice, weaveKey(lobbyWeaveId))` is true at the moment of the click. Both halves re-read per click.
  - The push is made **in `WeaveMount`**, which already computes the second half as `canLeave`; it wraps the setter and gives `WeaveView` the wrapped `onView`. No new prop, and nothing below it has a history decision of its own.
  - What is pushed is `pathForView(next)` **with no query string** — `/lobby/listeners` on open, `/lobby` on close — and the push happens **before** the state change, in the same handler.
  - `writeSearch` is **`replaceState` only**, with the **exact path test** (both spellings) and the **no-op guard**, and it **loses its `inPlace` parameter** without gaining another. It rewrites this page's own query string wherever the path is this page's, **whatever `leavingIsSafe` says**.
  - **One `popstate` listener**, in `WeaveSession`, in an effect with an empty dependency list, registered **only when `viewOfPath(location.pathname)` is defined at mount** and removed on unmount. Registration deliberately does **not** depend on `canLeave`. On each event it sets the view from the path and **bumps `popSeq`**, which is the directory's `key`.
  - Where no push is allowed the URL and the view may disagree, with no notice beyond the persistence bar already on screen.
- **`session.listListeners(query)` returns `{ issue, page }` and performs no side effect whatever** — no write, no `onWrite`, no `set()`, no `doLoad` — on the answer or on the rejection. **`session.reportCredentialFailure(e, issue)` is called by the view only AFTER its own `live.current && n === gen.current` guard**, and the session refuses it unless `issue.generation` is still the session's. Reading and spending the credential are two calls precisely so that the first cannot perform the second.
- **The composer stays mounted in a `hidden` slot.** `<div class="composer-slot" hidden={showListeners}>` around the existing `<Composer …/>`, drawn exactly where it is today — so the text, the caret, an in-flight send and today's cross-Thread draft behaviour are all unchanged. `hidden` and not a class of our own, because it is the one way of being off the page that also takes the textarea out of the accessibility tree and the tab order. **No CSS rule may give `.composer-slot` a `display`** — that would defeat the UA's `[hidden]`.
- **The mutation error bar renders in both views.** `reportError` is the failure channel of `Header`, `ThreadList`, `GuidelinesPanel` and `RequestsPanel` (`WeaveView.tsx:121-127`), every one of which is in the header or the sidebar and stays live while the directory is open. Drawn only in the thread view, a failed thread creation, a failed guidelines save, a refused offer or a failed archive would fail **silently**.
- **CR2 — the counts line.** Two forms, and nothing else is ever rendered there: filtered (`matched !== total`) `Showing 11 of 11 matches (out of 62 listeners)`; unfiltered (`matched === total`) `Showing 50 of 62 listeners`. Locale-formatted. When the query failed or either number is unknown the line says **nothing** — never a zero.
- **CR5 — Clear filters.** Always rendered, next to the sort controls, and `disabled` when everything is at its default:
  ```ts
  const atDefaults = draft === "" && view.q === "" && view.models.length === 0 && view.tools.length === 0
    && view.runtime === undefined && view.serves === undefined && view.sort === "name" && view.dir === "asc";
  ```
  The **raw `draft`**, not a trimmed one: a single typed space must leave the control live, because pressing it is also what cancels a pending debounce. Pressing it clears the pending timer **before** `apply`, empties the box and its ref, resets everything **including `sort` to `"name"` and `dir` to `"asc"`** (one `EMPTY_VIEW`, overriding listeners spec §5.3), makes one fresh query and leaves the address bar at a bare `/lobby/listeners`.
- **No core, server or client change.** `src/server/src/app.ts:86-88` already serves both spellings of the deep link; `GET /api/lobby/listeners`, `LoomClient.listListeners` and every core rule behind them are untouched. `src/server/test/static.test.ts` is unchanged and must stay green — confirm it, do not edit it.
- **Visuals are out of scope.** This plan prescribes structure and behaviour and names class hooks (`composer-slot`, the kept `listeners`); it prescribes no styling, no spacing, no colour and no responsive rules. The owner's separate design session owns all of it, CR4's nested effort row included.
- **Never `cb?.(write())`.** A write happens first, into a variable; the callback reports it afterwards. `onWrite?.(invalidateIdentity(…))` skips the *argument* — and the write with it — whenever nobody is listening.
- **The guard comes before any side effect, on rejections as much as on answers.** This defect was fixed three times on this codebase (the own-profile read, the count read, the directory's own rejection handler) and this change re-states it as a two-call API.
- **Every async continuation re-checks liveness inside itself**, immediately before it acts — not only in its caller (`session.ts:395` does exactly this).
- **Tests:** test-first, RED captured before GREEN, **one rule per test**, pristine output, exact expectations never loosened to pass. No mocks below the fetch seam. DOM tests speak to `https://loom.test` (`http://loom.test` is refused by the client's own URL policy; http is allowed on loopback only). Intermediate states are reached with **gated promises, never sleeps**.
- **Build before a package's tests:** `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build`. Run one web file with `cd src/web && npx vitest run test/<file>`.
- **TOOLING TRAP.** The Edit/Write tools decode `\uXXXX` escapes in tool input into literal bytes. `listeners-query.ts` carries a NUL-matching regular expression written as a unicode escape (`NUL_RE`, `listeners-query.ts:25`), and `listeners-page.test.tsx` has a fixture whose tool name carries a tab (`:449-451`) — re-typing either one turns the escape into the byte itself. Writing **this plan** hit it: the sentence you are reading had to be written twice. After every commit run `git diff --cached --stat` (or `git show --stat HEAD`) and check for a `Bin` row: a text file reported as binary means an escape was decoded into a control byte. Fix it before moving on.
- **The two side reads, and the pathname they share.** Every refresh of a Lobby page makes two side reads: `GET /api/lobby/listeners?limit=0&facets=false` and `GET /api/lobby/participants/me`. The directory's own query now hits **the same pathname** as the count read, so any stub or counter that pins "exactly N requests" must tell them apart **by query string** (`limit=0` is the count, `limit=50` is the directory). A table keyed on the pathname alone answers the session's side read with the directory's script and wrecks every `inTurn` numbering in the file.
- **`retryLobbyData` sleeps before its first attempt** (`DEFAULT_RETRY.delaysMs[0]` is 250 ms, and the DOM tests build the session through `useSession`, which passes no `retry` override). A DOM test that waits on the retry must use `vi.useFakeTimers()` and the file's `settleFake()` (12 × 50 ms = 600 ms); the real-timer `settle()` (12 × `setTimeout(0)`) never reaches it.
- **happy-dom history.** `history.pushState` / `replaceState` and `location` work; `history.back()` does **not** dispatch `popstate`. A test therefore does what the browser does, in this order: `history.replaceState(null, "", "<the entry's path>")` to move the address bar without adding an entry, then `window.dispatchEvent(new PopStateEvent("popstate"))`. The listener reads `location.pathname` and never `event.state`, so a plain `new Event("popstate")` is an equally valid trigger. `location` is reset between tests by an `afterEach` that calls `history.replaceState(null, "", "/")`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/web/src/lobby-view.ts` (new) | `MainArea`, `viewOfPath(pathname)`, `pathForView(view)` — the Lobby's two addresses in one module, so `app.tsx` and `WeaveView` share them without an import cycle |
| `src/web/src/session.ts` (modify, the returned object at `:770-931`) | `QueryIssue`; `listListeners(query)` and `reportCredentialFailure(e, issue)` on `Session`, beside `targets()` |
| `src/web/src/app.tsx` (modify, `:10-14`, `:24-35`, `:47-86`) | `Route.lobby` gains `view?: MainArea`; the `listeners` kind, `App`'s `case "listeners"` and `RouteDeps.openListenersInPlace` are deleted; `RouteDeps` is back to two in-place mirrors |
| `src/web/src/components/WeaveRoute.tsx` (modify) | `initialView` threaded `WeaveRoute` → `LobbyRoute` → `WeaveSession`; the view state and the `popstate` listener in `WeaveSession` above `key={reloadKey}`; the push in `WeaveMount`, which already holds `canLeave` (`:134-135`) |
| `src/web/src/components/WeaveView.tsx` (modify) | `showListeners`; the four render groups; the hidden composer slot; the shared error bar; `<h2>Listeners</h2>` over `ListenersPage`; `openListenersInPlace` deleted |
| `src/web/src/components/ListenersLink.tsx` (modify) | Always a `<button>`; `{ state, active, onToggle }` with `aria-current` |
| `src/web/src/components/ThreadList.tsx` (modify, `:17`, `:26`, `:51`) | `onPick?: () => void`, called after `selectThread` and after a successful `createThread` |
| `src/web/src/components/listeners/ListenersPage.tsx` (modify) | Props down to `{ session }`; the two-call credential rule; the `listeners-head` block deleted; CR2 and CR5 |
| `src/web/src/components/listeners/listeners-query.ts` (modify, `:160-168`) | `writeSearch` loses `inPlace` |
| `src/web/src/components/listeners/ListenersRoute.tsx` | **Deleted whole** |
| `src/web/src/styles.css` (modify) | Nothing but the removal of rules for the deleted `listeners-head`; **no rule for `.composer-slot`** |
| `src/web/test/session.test.ts` (modify) | The two entry points and who may authorise a recovery |
| `src/web/test/listeners-query.test.ts` (modify) | `viewOfPath` / `pathForView` units; `writeSearch`'s `inPlace` test deleted |
| `src/web/test/listeners-page.test.tsx` (modify) | The harness re-homed onto the Lobby page; every directory block re-mounted through it; the new view, history, gate and credential tests |
| `src/web/test/components.test.tsx` | Unchanged — its `routeOf` table and its `WeaveView` renders must stay green, which is why `view`/`viewKey`/`onView` are optional props |
| docs | ARCHITECTURE §9/§12, TESTING (smoke test 6 and the totals), KNOWN-ISSUES, `src/web/README.md`, REVIEW-BRIEF, v2-notes, and the dated "superseded by" notes in the predecessor spec |

**Why six tasks, and where they leave spec §14.** §14's four steps are followed in order with **one seam moved**, because the code shows a better one. §14 step 2 bundles the session's two entry points with the deletion of `ListenersRoute`; the entry points **can** land on their own, tested against a real server, while nothing consumes them yet, so they become **Task 1**. What cannot be split is the rest of §14 steps 1 and 2, and **Task 2 keeps them together deliberately**: the moment `Route` loses its `listeners` kind, `/lobby/listeners` mounts the whole Lobby page, so every test in `listeners-page.test.tsx` that mounted the route needs the Lobby's stub table in the same commit; and `ListenersPage` cannot take `{ session }` before there is a session above it. Spec §14 step 1's "temporary adapter" — `ListenersPage` kept on its old props, fed a `reader` that `WeaveMount` picks for itself — is deliberately **not** built: it would re-create the second credential owner this change exists to delete, and it would not save the test re-homing, which is the bulk of the work. §14 step 4 is split into **Task 4** (CR2, CR5) and **Task 5** (docs and totals), for the reason the predecessor plan split its own docs step out: the totals must be real, and they only exist once every code task is green. Test 6 moves from §14 step 3 to Task 2, because a deep link needs `initialView` and the seeding rule and no history at all.

---

### Task 0: Branch

- [ ] Confirm `main` contains `docs/superpowers/specs/2026-09-20-loom-lobby-listeners-view-design.md` (this plan's spec, merged with the docs branch). If it is missing, stop.
- [ ] Confirm `src/server/src/app.ts` line 86 already lists `"/lobby/listeners", "/lobby/listeners/"`. If it does not, stop: spec §10's "no server change" is false and the spec must be re-read.
- [ ] `git checkout main && git pull && git checkout -b feat/lobby-listeners-view`
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm -r build`
- [ ] Confirm the baseline is green: `pnpm --workspace-concurrency=1 -r test`. It must report **1663 tests in 65 files** — core 485/24, web 712/13, server 178/9, claude-channel 139/9, cli 70/5, client 45/4, mcp-tools 34/1. Record what it actually printed in the branch's first commit message body; Task 5 compares against it.

---

### Task 1: The session's two entry points

Spec §6.1 (both methods, both guards, and why they are two), §11 ("nothing on the read path is authorised by the session alone"), §16 assumption 10.

**Files:** Modify `src/web/src/session.ts` (the `Session` type at `:61-75`, the returned object at `:770-931`); Test `src/web/test/session.test.ts` (modify — the side-read section that begins at `:1893`).

**Interfaces:**
- *Consumes:* `reader`, `generation`, `disposed`, `recoverFromCredentialFailure(e, failed?)` and `doLoad` from inside `createSession`; `ListenersQuery` and `ListenersPage` types from `@loom/client`; the test file's existing `sideReadClient(script, weaveRead?)`, `refuses`/`REVOKED`/`BROKEN`, `onCall`, `delivering`, `afterDelivery`, `makeSession`, `storedIdentity`, `lobbyFixture` and `lobbyId()` helpers.
- *Produces:*
```ts
/** What a query was issued under — which reader asked. Opaque to the view: it exists to be handed back. */
export type QueryIssue = { readonly generation: number };
// on `Session`, beside `targets()`:
listListeners(query: ListenersQuery): { issue: QueryIssue; page: Promise<ListenersPage> };
/** Told of a rejection by a caller that has **already** established the query is still wanted. */
reportCredentialFailure(e: unknown, issue: QueryIssue): void;
```

- [ ] **Step 1: Write the failing tests** in `src/web/test/session.test.ts`, in a new `describe("reading the directory, and who may spend a recovery (spec §6.1)")` placed after the existing listener-count section. They run against the real server, as the rest of that file does. `LISTENERS` there is the **path** `/api/lobby/listeners`, and the session's own count read is call **1** on it — every script below numbers from 2.
  - **Test 10a — the page is handed back, and nothing is written.** A Lobby session with a stored identity **and a secret beside it**; `sideReadClient({ [LISTENERS]: onCall(2, REVOKED) })`. Call `session.listListeners({ limit: 50 })`, await the `page` promise's **rejection**, then `afterDelivery`. Assert the stored entry is **byte-identical** to what it was before (`storage.get(weaveKey(id))`), `getState().status` is still `"ready"`, and `c.weaveReads()` has not moved — no reload happened.
  - **Test 10b — a 401 alone is not a recovery, and reporting it is.** Same setup; after the assertions above, call `session.reportCredentialFailure(e, issue)` with the rejection and the `issue` that query handed back, then `waitFor` the entry to read `{ secret, identity: "invalid" }`. One rule: the recovery happens **only** through the second call.
  - **Test 14a — two rejections of one generation cause exactly one invalidation.** Script `always(REVOKED)` from call 2 on. Issue **two** queries before either is reported; report the first, wait for the reload, then report the second. Assert `vi.spyOn(storage, "set")` recorded **one** call, and the entry is invalid once.
  - **Test 14c — an issue taken before a completed reload is refused.** Take `const { issue, page } = session.listListeners({ limit: 50 })` with a `delivering(parksThen(gate, REVOKED))` answer; while it is parked, `await session.load()` (a full reload, which bumps `generation`); release the gate, `await afterDelivery(...)`, then call `reportCredentialFailure(e, issue)`. Assert nothing was written (`storage.set` spy at zero after the reload's own writes are captured as the baseline) and `status` never left `"ready"` for `no-credential`.
  - **Test 10c — `listListeners` reads the credential the page reads with.** With the session reading on the **secret** (an entry whose identity has already been invalidated), assert the request `sideReadClient` saw for call 2 carried `Bearer <secret>`.
- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build && cd src/web && npx vitest run test/session.test.ts`
  Expected: FAIL — `session.listListeners is not a function`.
- [ ] **Step 3: Write the implementation.** In `src/web/src/session.ts`, add `QueryIssue` beside `TargetWeave` (`:59`), the two members to the `Session` type beside `targets()` (`:74`), and the two methods to the returned object beside `targets()` (`:895`):
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
  Import `type ListenersQuery` and `type ListenersPage` from `@loom/client` at `:1-2`. Nothing else in this file changes. Note for the reviewer: `generation` is bumped by `doLoad` **before** its first `await` (`:614`), by the retirement inside `recoverFromCredentialFailure` (`:201`) and by `dispose` (`:925`), and by nothing else — which is what makes the second rejection of one generation refusable **synchronously**.
- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd src/web && npx vitest run test/session.test.ts`
  Expected: PASS, and the whole package green with `cd src/web && npx vitest run`.
- [ ] **Step 5: Commit**

```bash
git add src/web/src/session.ts src/web/test/session.test.ts
git commit
# feat(web): the session reads the directory, and only a live query may spend a recovery
```

---

### Task 2: The directory becomes a view of the Lobby

Spec §3 (the whole section), §4.1 (`routeOf` and the module), §4.3 (seeding, and `writeSearch` losing `inPlace`), §5 (the gate and every state), §6.2, §6.3, §7 (what is deleted and what is kept), §8 (the sidebar line), §16 assumptions 1–9, 13, 14, 15, 19.

**This task carries spec §12 tests 1, 2, 3, 6, 9, 13, 14b, 15, 16, 19 and 20, and every re-homed block.** It is the largest task in the plan and it is one task for the reason stated under the File structure table.

**Files:** Create `src/web/src/lobby-view.ts`; Modify `src/web/src/app.tsx`, `src/web/src/components/WeaveRoute.tsx`, `src/web/src/components/WeaveView.tsx`, `src/web/src/components/ListenersLink.tsx`, `src/web/src/components/ThreadList.tsx`, `src/web/src/components/listeners/ListenersPage.tsx`, `src/web/src/components/listeners/listeners-query.ts`, `src/web/src/styles.css`; **Delete** `src/web/src/components/listeners/ListenersRoute.tsx`; Test `src/web/test/listeners-page.test.tsx`, `src/web/test/listeners-query.test.ts`.

**Interfaces:**
- *Consumes:* `session.listListeners(query)` and `session.reportCredentialFailure(e, issue)` with `QueryIssue` (Task 1); `leavingIsSafe`, `weaveKey`, `useSession`, `JoinLobbyForm`, `HomeLink`, `PersistenceBar` unchanged; `EMPTY_VIEW`, `viewFromSearch`, `searchFromView`, `queryFromView`, `writeSearch`, `ListenersView` from `listeners-query.ts`; `ProfileCard`, `FacetChips`, `ModelChips`.
- *Produces:*
```ts
// src/web/src/lobby-view.ts
export type MainArea = "thread" | "listeners";
/** `undefined` when this is not one of the Lobby's four addresses. */
export function viewOfPath(pathname: string): MainArea | undefined;
/** The canonical spelling this app writes: "/lobby" or "/lobby/listeners", never a trailing slash. */
export function pathForView(view: MainArea): string;

// src/web/src/app.tsx
export type Route =
  | { kind: "main" }
  /** `view` is the area the page **opened** on, never a live value: the view itself lives in
   *  `WeaveSession` (spec §3.1), and after a `pushState` this field is deliberately not updated. */
  | { kind: "lobby"; view?: MainArea }
  | { kind: "weave"; weaveId: string } | { kind: "secret"; secret: string } | { kind: "unknown" };
export type RouteDeps = { client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  openInPlace: (weaveId: string) => void; openMainInPlace: () => void };   // back to two mirrors

// src/web/src/components/WeaveRoute.tsx — `WeaveRoute` gains `initialView?: MainArea` on its
// `lobbyRoute` member; `LobbyRoute(deps: RouteDeps & { initialView?: MainArea })`.

// src/web/src/components/WeaveView.tsx — three new props, all optional so that
// `components.test.tsx`'s bare `<WeaveView session state />` renders keep compiling and so that
// every non-Lobby page gets the right defaults without a prop of its own:
//   view?: MainArea (default "thread"); viewKey?: number (default 0); onView?: (next: MainArea) => void
// `openListenersInPlace` is gone.

// src/web/src/components/ListenersLink.tsx
export function ListenersLink({ state, active, onToggle }: {
  state: SessionState; active: boolean; onToggle: () => void }): JSX.Element | null;

// src/web/src/components/ThreadList.tsx — `onPick?: () => void` added to its props.

// src/web/src/components/listeners/ListenersPage.tsx
export function ListenersPage({ session }: { session: Session }): JSX.Element;

// src/web/src/components/listeners/listeners-query.ts
export function writeSearch(view: ListenersView): void;      // the `inPlace` parameter is gone
```

- [ ] **Step 1: Re-home the DOM harness** in `src/web/test/listeners-page.test.tsx` — this comes first, because every block below mounts through it. Six edits, and no test body is rewritten blind:

  1. Delete the `ListenersRoute` import and the whole `mountRoute` helper (`:149-160`). Eleven tests call it; five are deleted with the code they covered (the four `inPlace` tests at `:401-431` and the in-place "Back to the Lobby" at `:1075-1080`), and the other six — the two effort-chip tests, the two serves-chip tests and the two facet-cut tests, at `:862-923` — become `mountLobby` calls with **no other change**, because `mountRoute` and `mountApp` already share `harness` and the assertions read the same helpers.
  2. Split the shared pathname. Add beside `LISTENERS`:
```ts
/** The session's own count read (spec §5.1) shares this path with the directory's query and is told
 *  apart by `limit=0`. It gets a row of its own in the table, so an ordinary `[LISTENERS]` row still
 *  means "what the directory is answered with" and every `inTurn` script keeps its call numbering. */
const COUNT = `${LISTENERS}?limit=0`;
const LISTENERS_PATH = new URL(LISTENERS).pathname;
const isCount = (url: URL) => url.pathname === LISTENERS_PATH && url.searchParams.get("limit") === "0";
```
     and in `stubFetch` (`:65-72`) look the row up under `isCount(url) ? COUNT : `${url.origin}${url.pathname}``.
  3. `INSTANCE` (`:92-100`) becomes the **Lobby page's** table: keep `[LOBBY_URL]`, `[LISTENERS]`, `[JOIN]` and the fatal-403 `ws-ticket`, and add the five rows the session reads — `/api/weaves/<LOBBY.weaveId>/events` → `{ events: [] }`, `/api/weaves/<LOBBY.weaveId>` → the weave with one `General` thread and `[JOINED.participant]`, `/api/guidelines`, `/api/requests` → `{ requests: [] }`, `/api/lobby/participants/me` → `JOINED.participant` — plus `[COUNT]: () => json(directory([], { total: 12 }))`. These are exactly the rows the file's own `LOBBY_PAGE` (`:1212-1224`) and `components.test.tsx`'s Offer-form table (`:329-345`) already build; move `LOBBY_PAGE` up into `INSTANCE` and delete the duplicate.
  4. `harness` (`:115-133`) stops counting the count read as a directory query:
```ts
    /** What each **directory** query asked for, in order. The count read is not one of them. */
    queries: () => to(LISTENERS).map((c) => new URL(String(c[0])).searchParams).filter((p) => p.get("limit") !== "0"),
    /** How many directory queries have been made. Replaces `calls(LISTENERS)`, which now also counts
     *  the session's two-side-reads-per-refresh. */
    asked: () => h.queries().length,
    /** The credential the n-th **directory** query was made with. */
    authOf: (n: number) => (to(LISTENERS).filter((c) => new URL(String(c[0])).searchParams.get("limit") !== "0")[n]
      ?.[1]?.headers as Record<string, string> | undefined)?.authorization,
```
     Replace every `v.calls(LISTENERS)` with `v.asked()` (ten sites: `:226`, `:253`, `:296`, `:469`, `:514`, `:526`, `:534`, `:987`, `:1016`, and the `typingThen` block's).
  5. Add the one new mount helper, and use it everywhere `mountApp` was used with a directory expectation:
```ts
/**
 * The Lobby page, with the directory open or closed. The path is the *real* one this browser loaded,
 * so `/lobby` is a Lobby whose directory is reached by pressing the line and `/lobby/listeners` is a
 * deep link — which is the only difference between them.
 */
function mountLobby(opts: MountOpts = {}) {
  const v = mountApp({ storage: joined(), ...opts, path: opts.path ?? "/lobby" });
  const line = (): HTMLElement | null => screen.queryByRole("button", { name: /^Listeners/ });
  return {
    ...v,
    line,
    /** Presses the sidebar line and lets the query that follows land. */
    toggle: async () => { fireEvent.click(line()!); await settle(); },
    directory: () => !!v.container.querySelector(".listeners"),
    composerSlot: () => v.container.querySelector(".composer-slot") as HTMLElement | null,
  };
}
```
     `heading()` (`:129`) changes to look for the `<h2>`: `!!screen.queryByRole("heading", { level: 2, name: "Listeners" })`.
  6. Name the three paths the no-remount test counts, beside `LISTENERS`, and reset `location` between tests — from this task on, a test can leave the address bar somewhere else:
```ts
const WEAVE = `${BASE}/api/weaves/${LOBBY.weaveId}`;
const EVENTS = `${WEAVE}/events`;
const TICKET = `${BASE}/api/auth/ws-ticket`;

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); history.replaceState(null, "", "/"); });
```
- [ ] **Step 2: Write the failing tests.** In `src/web/test/listeners-query.test.ts`, a new `describe("the Lobby's two addresses (spec §4.1)")` — it lives here rather than in a file of its own because `lobby-view.ts` is a twenty-line module and `writeSearch`'s own path test is already in this file, so all of the feature's path rules read together:
```ts
  it("names the directory for both spellings the server serves", () => {
    expect([viewOfPath("/lobby/listeners"), viewOfPath("/lobby/listeners/")]).toEqual(["listeners", "listeners"]);
  });
  it("names the thread for both spellings of the Lobby", () => {
    expect([viewOfPath("/lobby"), viewOfPath("/lobby/")]).toEqual(["thread", "thread"]);
  });
  it("says nothing at all about a path that is not the Lobby's", () => {
    expect([viewOfPath("/"), viewOfPath("/lobby/listenersx"), viewOfPath("/weave/x")])
      .toEqual([undefined, undefined, undefined]);
  });
  it("writes one canonical spelling, never a trailing slash", () => {
    expect([pathForView("thread"), pathForView("listeners")]).toEqual(["/lobby", "/lobby/listeners"]);
  });
```
  and **delete** the `writeSearch` test "leaves the address bar entirely alone for a page rendered in place" (`:326-331`), whose parameter is gone. The other five `writeSearch` tests stand unchanged and are the proof that the path test, the no-op guard and the never-push rule survived.
- [ ] **Step 3: Write the failing tests** in `src/web/test/listeners-page.test.tsx`. **Test 1** replaces the four `routeOf` tests of `describe("the listeners route (spec §5.2)")` (`:198-214`), which are deleted with the route kind:
```ts
  it("reads /lobby/listeners as the Lobby with the directory open", () => {
    expect(routeOf("/lobby/listeners")).toEqual({ kind: "lobby", view: "listeners" });
  });
  it("reads its trailing slash the same way, as the server serves both", () => {
    expect(routeOf("/lobby/listeners/")).toEqual({ kind: "lobby", view: "listeners" });
  });
  it("leaves /lobby the Lobby with no view of its own", () => {
    expect(routeOf("/lobby")).toEqual({ kind: "lobby" });
  });
  it("makes no page of a near miss", () => {
    expect(routeOf("/lobby/listenersx")).toEqual({ kind: "unknown" });
  });
```
  Then the new blocks, one rule per test:
  - **Test 2 — the session does not remount.** `const v = mountLobby(); await settle(); await v.toggle(); await v.toggle(); await v.toggle();` then
    `expect([v.calls(WEAVE), v.calls(EVENTS), v.calls(TICKET)]).toEqual([1, 1, 1])` — asserted by counting requests, never by inspecting internals.
  - **Test 3 — the sidebar line.** Three tests: it is a `button` and carries **no** `href`; `aria-current` is `"true"` only while the directory is open (assert `null` before, `"true"` after, `null` after a second press); pressing it again closes the directory (`v.directory()` false).
  - **Test 6 — the deep link.** `mountLobby({ path: "/lobby/listeners?q=ada" })`: the directory is on screen, `(screen.getByLabelText("Search") as HTMLInputElement).value` is `"ada"`, and `v.queries()` has length **1** with `get("q") === "ada"`.
  - **Test 9 — a live 401 recovers, exactly once.** Storage `joinedWithSecret()`; the directory's own query is scripted `inTurn(INVALID, () => json(directory([listener("ada", "a")])))` while `[COUNT]` answers normally — **the split of Step 1 is what makes this test about the directory's 401 and not the count read's**. Four tests: the entry reads `{ secret: "lobby-secret", identity: "invalid" }`; the second directory query carried `Bearer lobby-secret` and the rows are on screen (`v.authOf(1)`, `v.names()`); with `storage: joined()` and `[LISTENERS]: INVALID` the page settles on the join fork (`screen.queryByRole("heading", { name: "Join the Lobby" })`) and the layout is gone; and with two directory queries of one generation both refused, `vi.spyOn(storage, "set")` records **one** write.
  - **Test 13 — picking a Thread, and the composer.** Four tests: pressing a thread button closes the directory; a successful **Create** closes it; while the directory is open `v.composerSlot()!.hasAttribute("hidden")` is `true` and the slot still contains a `textarea` (mounted, not drawn — assert the attribute, **not** `queryByRole("textbox")`: happy-dom's handling of the UA `[hidden]` rule is not something this suite should depend on); and an event arriving on the stream while the directory is open still updates the thread list.
  - **Test 14b — a 401 that lands too late.** Two tests, both with a gated `INVALID`: released **after** the directory was closed, and released after the whole `<App>` was unmounted (`v.unmount()`). Each asserts the stored entry is byte-identical and no join fork appeared.
  - **Test 15 — the draft survives the round trip.** Three tests: type into the composer, open the directory, come back — the textarea still holds the text and `selectionStart` is where it was; the send that follows posts **exactly that text** (assert the `POST` body); and switching Threads still carries the draft across, which this test pins so the next change cannot move it by accident.
  - **Test 16 — a mutation failure is visible while the directory is open.** Two tests: a failed `createThread` from the sidebar, and a failed guidelines save, each put their message in `.error-bar` with the directory on screen.
  - **Test 19 — a delayed discovery leaves the Thread writable.** `vi.useFakeTimers()`. The `[LOBBY_URL]` row answers by call number: 1 → `json(LOBBY)` (`LobbyRoute`'s own), 2 → a **rejected** promise (`Promise.reject(new Error("simulated network failure"))` — the session's, inside `doLoad`'s `Promise.all`, which settles the load with `lobbyKnown` false), 3 → a **gated** `json(LOBBY)` (the one `retryLobbyData` makes after its 250 ms sleep, which is why this test needs `settleFake()`). Deep-link at `/lobby/listeners`. Four tests, each re-running that setup: with the retry still held, there is a message list, **no** `<h2>Listeners</h2>` and **no** sidebar line at all; the composer is visible (`composerSlot()!.hasAttribute("hidden")` is `false`) and a typed message **sends**, the `POST` carrying exactly that text; after `gate.release()` and one more `settleFake()` the directory is open, the slot carries `hidden` and the line carries `aria-current="true"`; and the request counts of test 2 have not moved.
  - **Test 20 — a failed or absent Lobby still leaves the Thread writable.** Two tests, real timers: the session's `getLobby` **rejecting** on every call after the first, and answering `weave_not_found` on call 2. In both, `/lobby/listeners` is ready, the message list is there and a typed message sends; in the `weave_not_found` case assert additionally that nothing ever opens the directory (`v.directory()` is false after a further `settle()`), because that answer settles the question and no retry is started.
  - **The re-homed blocks**, all of which keep their bodies and change only their mount: `describe("the directory grid and its counts")`, `"the controls and the query string"`, `"a control pressed while the typing has not settled"`, `"one query at a time"`, `"Show more"`, `"a control change drops the cursor"`, `"the controls stop at core's bounds"`, `"a cursor the Lobby refuses"`, `"a failed query is never an empty directory"`, `"the chips"`, `"the list changed while you were reading it"`, `"the states this page says out loud"`. Each `mountApp({…})` becomes `mountLobby({…})`; each that asserted the directory is on screen without a path keeps the default `/lobby` and calls `await v.toggle()` first, and each that seeded from a link keeps its `path: "/lobby/listeners?…"`.
  - **Deleted with the code they covered**, each named so a reviewer can tick it off: the four `routeOf` tests above (replaced); the whole route-level block `describe("the listeners page (spec §5.5)")` (`:216-312`) — credential resolution, the join form, "navigates nowhere to do it", "renders the directory in place for a browser whose join reached memory alone", "says so on that browser", "keeps its reader across a re-render", and the two `getLobby` cards, which `LobbyRoute`'s own tests already cover; the three `inPlace` tests in `describe("the controls and the query string")` (`:401-431`); the whole `describe("a Lobby secret the instance refuses (spec §5.5)")` (`:983-1026`) — §6.2 gives the refused secret **no** replacement, it is an ordinary query error; the whole `describe("the way out of the directory (spec §5.3)")` (`:1068-1101`) — the `listeners-head` block with its wordmark and **Back to the Lobby** is deleted; and `ListenersLink`'s three link-versus-button tests (`:1185-1202`) plus the two in `describe("the listeners line on the Lobby page")` (`:1245-1255`), replaced by test 3.
- [ ] **Step 4: Run the tests to verify they fail**

  Run: `cd src/web && npx vitest run test/listeners-page.test.tsx test/listeners-query.test.ts`
  Expected: FAIL — `viewOfPath is not a function`, `routeOf("/lobby/listeners")` still `{ kind: "listeners" }`, and no `.composer-slot` in the document.
- [ ] **Step 5: Write `src/web/src/lobby-view.ts`.** Its own module so `app.tsx` and `WeaveView` share it without `WeaveView` importing `app.tsx`, which would be an import cycle:
```ts
/** Which of the Lobby page's two things the main area is showing (spec §3.1). A string union rather
 *  than a boolean, because the main area is one slot showing one thing and a name reads better at
 *  every call site than `listenersOpen`. */
export type MainArea = "thread" | "listeners";

/** `undefined` when this is not one of the Lobby's four addresses — which is also the first half of
 *  the push rule (spec §4.2): a Lobby rendered in place sits on another page's path and writes nothing. */
export function viewOfPath(pathname: string): MainArea | undefined {
  if (pathname === "/lobby/listeners" || pathname === "/lobby/listeners/") return "listeners";
  if (pathname === "/lobby" || pathname === "/lobby/") return "thread";
  return undefined;
}

/** The canonical spelling this app writes, never a trailing slash. */
export function pathForView(view: MainArea): string {
  return view === "listeners" ? "/lobby/listeners" : "/lobby";
}
```
- [ ] **Step 6: Write `app.tsx`.** Delete the `ListenersRoute` import, the `listeners` member of `Route`, the `case "listeners"`, `openListenersInPlace` from `RouteDeps` and its definition in `App`. `routeOf` keeps its two exact comparisons and returns a view:
```ts
  if (pathname === "/lobby/listeners" || pathname === "/lobby/listeners/") return { kind: "lobby", view: "listeners" };
  if (pathname === "/lobby" || pathname === "/lobby/") return { kind: "lobby" };
```
  and the switch renders **one** element for both addresses, which is the invariant of §3.2:
```tsx
    case "lobby":  return <WeaveRoute {...deps} lobbyRoute initialView={route.view} />;
```
  Keep the existing comment above `routeOf` and add one sentence to `Route`: the `view` is the area the page **opened** on, never a live value, and a later `pushState` deliberately does not update it.
- [ ] **Step 7: Write `WeaveRoute.tsx`.** Four edits.
  - `WeaveRoute`'s prop union: the `lobbyRoute: true` member gains `initialView?: MainArea`. Stop destructuring `openListenersInPlace`; `deps` is back to five keys. `LobbyRoute` takes `RouteDeps & { initialView?: MainArea }` and hands it to `WeaveSession` at `:78`.
  - `WeaveSession` (`:93-96`) gains the view state, **above** the key:
```tsx
function WeaveSession(props: RouteDeps & { target: SessionTarget; lobby?: Lobby; initialView?: MainArea }) {
  const [reloadKey, setReloadKey] = useState(0);
  // Above the key, deliberately: a join rebuilds everything below it, and which part of the page the
  // human was looking at is not the join's to reset. `initialView` is read once, to seed this.
  const [view, setView] = useState<MainArea>(() => props.initialView ?? "thread");
  return <WeaveMount key={reloadKey} {...props} onJoined={() => setReloadKey((n) => n + 1)}
    view={view} setView={setView} />;
}
```
  - `WeaveMount` takes `view` and `setView`, and passes `view` and `onView` down. In this task `onView` **is** `setView` — the push is Task 3's, and is added here so that nothing below `WeaveMount` ever gains a history decision:
```tsx
  return <WeaveView session={session} state={state} banner={<PersistenceBar notice={notice} />}
    noCredential={noCredential} openMainInPlace={canLeave ? undefined : openMainInPlace}
    view={view} onView={setView} />;
```
  - Delete the `openListenersInPlace` prop, its destructuring and the paragraph of its comment (`:164-166`); `canLeave` (`:134-135`) stays exactly as it is — Task 3 is its second reader.
- [ ] **Step 8: Write `WeaveView.tsx`.** Delete the `openListenersInPlace` prop and its doc comment; add `view = "thread"`, `viewKey = 0` and `onView` as optional props (optional because `components.test.tsx` renders `<WeaveView session state />` bare, and because every non-Lobby page wants exactly these defaults). Below the three early returns and above `const message = …`, the one predicate:
```tsx
  // §5's gate, which is the sidebar line's own, id-based and unchanged by this spec (ListenersLink.tsx:23).
  const lobbyGate = state.status === "ready" && !!state.lobby && state.lobby.weaveId === state.weave?.id;
  // The one predicate every rendering branch below reads. `view` on its own renders nothing: a site
  // that forgot the gate would not be a missing directory, it would be a broken Thread.
  const showListeners = lobbyGate && view === "listeners";
```
  The sidebar line becomes `<ListenersLink state={state} active={showListeners} onToggle={() => onView?.(showListeners ? "thread" : "listeners")} />`, and `<div class="main">` becomes the four groups. The error bar keeps **exactly today's position** — below the main area's content and above the composer — so the thread view does not move a pixel, while the directory view gets it too:
```tsx
        <div class="main">
          {archived && <div class="banner">This Weave is archived and read-only.</div>}
          {readOnly && (/* unchanged, with its Join button */)}
          {state.refreshError && <div class="warn-bar">Having trouble syncing: {state.refreshError}</div>}
          {!showListeners && <InviteBanner state={state} session={session} />}
          {!showListeners && <MessageList state={state} />}
          {showListeners && (
            <section class="listeners-view">
              {/* Demoted from <h1>: the page's <h1> is the Weave title in the header, and this is
                  the heading of one region of it (spec §3.3). */}
              <h2>Listeners</h2>
              <ListenersPage key={viewKey} session={session} />
            </section>
          )}
          {error && <div class="error-bar">{error}</div>}
          {!archived && !readOnly && (
            // Mounted in both views and drawn in one, so a half-written message survives a look at
            // the directory (spec §3.5). `hidden` and not a class of our own: it is the one way of
            // being off the page that also leaves the accessibility tree and the tab order. No CSS
            // rule may give this element a `display`.
            <div class="composer-slot" hidden={showListeners}>
              <Composer state={state} onSend={send} draft={draft} />
            </div>
          )}
        </div>
```
  `ThreadList` gains the callback that closes the directory: `<ThreadList state={state} session={session} onError={reportError} onPick={() => onView?.("thread")} />`. `NamePrompt` stays outside `<div class="main">`, unmoved.
- [ ] **Step 9: Write `ThreadList.tsx`.** Add `onPick?: () => void` to the props, call it **after** `session.selectThread(t.id)` in the thread button's handler (`:51`) and **after** a successful `session.createThread(…)` in `submit` (`:26`, inside the `try`, after `setCreating(false)`), with the comment that creating a Thread selects it (`session.ts:831`) and leaving the human on the directory would hide what they just made. Nothing else changes; `aria-current` (`:50`) is untouched in both views.
- [ ] **Step 10: Write `ListenersLink.tsx`.** Keep the file position, the gate (`:23`), the four count states and the `count unavailable` span. The control is **always** a button:
```tsx
      {/* Always a button, never an anchor: it toggles a region of the page it is already on, and an
          anchor could be middle-clicked into a full page load. The address bar is put right by the
          push of spec §4.2, which is the only place that knows whether this browser may have one. */}
      <button type="button" class="listeners-line-link" aria-current={active ? "true" : undefined}
        onClick={() => onToggle()}>{label}</button>
```
  `aria-current` rather than `aria-pressed`, to match the thread buttons beside it (`ThreadList.tsx:50`). `active` is `showListeners` and never the raw `view`.
- [ ] **Step 11: Write `ListenersPage.tsx`.** Props down to `{ session: Session }` — it reads nothing from `SessionState`. Delete the `KeyValueStorage`, `PersistenceNotice`/`leavingIsSafe` and `isCredentialFailure`/`weaveKey` imports, the `canLeave` line (`:224`) and the whole `listeners-head` element (`:234-247`). Keep `LoomClientError` — the refused-cursor rule still reads it. Three changed rules:
```ts
  // Read where it is written (spec §4.3): one condition governs both halves, so there is no browser
  // that seeds itself from an address it then refuses to keep up to date.
  const opened = useMemo(
    () => viewOfPath(location.pathname) === "listeners"
      ? viewFromSearch(location.search) : { view: EMPTY_VIEW, partial: false }, []);
```
```ts
    const { issue, page } = session.listListeners(queryFromView(next, { limit: PAGE, cursor, facets: cursor === undefined }));
    page.then(
      (page) => { /* unchanged, guard first */ },
      (e: unknown) => {
        // The guard comes **first**, and it is the same guard the answer takes: a rejection nobody is
        // waiting for must not paint an error over newer rows, and must certainly not spend the page's
        // one credential recovery. Only a LIVE query may authorise one (spec §6.1).
        if (!live.current || n !== gen.current) return;
        session.reportCredentialFailure(e, issue);
        // …and the failure is rendered either way: where it recovered, `doLoad` takes the page to
        // `loading` and this view unmounts under the error it has just painted (spec §6.1, §6.3).
        const message = e instanceof Error ? e.message : String(e);
        const refused = cursor !== undefined && e instanceof LoomClientError && e.code === "validation";
        setState((s) => cursor
          ? { ...s, appending: false, moreError: message, nextCursor: refused ? undefined : s.nextCursor }
          : { ...s, status: "error", error: message, appending: false });
      },
    );
```
  and the query effect keys on the session instead of the reader: `useEffect(() => { run(view); }, [view, session]);` — `useSession` memoises the session on `[key, client, storage]` (`useSession.ts:20`), so it is the same object across a view flip and across a `doLoad`, and the re-query after a recovery comes from the `loading` → `ready` remount (spec §6.3) rather than from this dependency. `apply` calls `writeSearch(next)` with one argument. Everything else in this file — the generation counter, the `live` ref, the 250 ms debounce, the supersede-the-pending-keystroke rule, Show more, the caps, the four status branches, the `partial` notice, the chips and the "list changed" line — is **kept verbatim**; CR2 and CR5 are Task 4's.
- [ ] **Step 12: Write `listeners-query.ts`.** `writeSearch(view: ListenersView): void` loses its first line (`if (inPlace) return;`) and its parameter. Rewrite the third bullet of its doc comment: the `inPlace` reason is replaced by spec §4.5's narrower promise — `replaceState` onto the path the browser is **already on** adds no entry, loads nothing and takes away no address this browser could otherwise have survived, so the permission to *leave* is not consulted, because nothing is being left. The exact path test and the no-op guard keep their reasons word for word.
- [ ] **Step 13: Delete `ListenersRoute.tsx`** (`git rm src/web/src/components/listeners/ListenersRoute.tsx`) and remove the `.listeners-head`, `.listeners-back` and `.home-link`-inside-the-directory rules from `styles.css`. Then `grep -n "composer-slot" src/web/src/styles.css` — there must be **no** rule for it, and above all none carrying a `display`.
- [ ] **Step 14: Run the tests to verify they pass**

  Run: `cd src/web && npx vitest run`
  Expected: PASS — the whole web package, `components.test.tsx` and `session.test.ts` included. Then `pnpm -r typecheck`.
- [ ] **Step 15: Commit**

```bash
git add -A src/web
git commit
# feat(web): the Lobby listeners directory is a view of the Lobby, not a page of its own
```
  Then `git show --stat HEAD` and confirm no file is reported as `Bin`.

---

### Task 3: History — the push, `popstate`, and the directory's key

Spec §4.2, §4.4, §4.5, §16 assumptions 4, 5, 9, 12, 17. **Tests 4, 5, 7, 8, 17, 18.**

**Files:** Modify `src/web/src/components/WeaveRoute.tsx`, `src/web/src/components/WeaveView.tsx` (the `viewKey` prop is already there from Task 2 — only its source changes); Test `src/web/test/listeners-page.test.tsx`.

**Interfaces:**
- *Consumes:* `viewOfPath`, `pathForView`, `MainArea` (Task 2); `canLeave` in `WeaveMount` (`WeaveRoute.tsx:134-135`), which is already `leavingIsSafe(storage, notice, weaveKey(weaveId))` for the Lobby's own entry; `WeaveView`'s `view`, `viewKey` and `onView` props (Task 2).
- *Produces:* no new exported symbol. `WeaveSession`'s state widens from `MainArea` to `{ view: MainArea; popSeq: number }`, and `WeaveMount` passes `viewKey={popSeq}` and a **wrapped** `onView`.

- [ ] **Step 1: Write the failing tests** in `src/web/test/listeners-page.test.tsx`. Add the helper the whole block shares, with its reason stated once:
```ts
/**
 * What the browser does on Back, in the order it does it: happy-dom implements `pushState`,
 * `replaceState` and `location`, but `history.back()` dispatches no `popstate`. So the address bar is
 * moved without adding an entry, and then the event is dispatched. The listener reads
 * `location.pathname` and never `event.state`, so a plain `new Event("popstate")` would do as well.
 */
const pop = async (to: string) => {
  history.replaceState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await settle();
};
```
  - **Test 4 — from `/lobby` on a durable browser.** Three tests, each spying on `history.pushState` and `history.replaceState` after `settle()` and clearing them: opening pushes exactly once with `"/lobby/listeners"` and `location.pathname` reads it; a chip click **replaces** once and pushes **never**, and the pushed entry carries **no** query string (assert the push's third argument is exactly `"/lobby/listeners"`); picking a thread pushes once with `"/lobby"`.
  - **Test 5 — Back and Forward.** From `/lobby`, open the directory, click the `shell` chip (which `replaceState`s `/lobby/listeners?filter=…`), then `await pop("/lobby")`: the thread view is back and the directory is gone. Then `await pop("/lobby/listeners?" + FILTERED)`: the directory is back, the chip reads `aria-pressed="true"` and the search box is seeded from **that entry's** query string, and exactly one fresh query was made carrying the filter.
  - **Test 7 — the Lobby under another address.** Two paths, `/weave/<LOBBY.weaveId>` and `/w/<lobby secret>` (the latter needs the `/api/weaves/<secret>/lookup` row, exactly as `components.test.tsx:331` builds it). For each: the sidebar line is there, pressing it opens the directory, a chip filters the rows, and **neither** `pushState` nor `replaceState` was called.
  - **Test 8 — memory-only `/lobby`.** `storage: joinedInMemory()` and a `notice` already degraded. The view switches, a chip filters, `location.pathname` never leaves `/lobby`, `location.search` stays `""`, and both spies are at zero.
  - **Test 17 — a rejoin restores the view.** Twice. Durable: `mountLobby({ path: "/lobby/listeners", storage: joined() })` with the directory's query answered `INVALID` **and no secret stored**, so the session settles at `no-credential` and `WeaveRoute`'s join fork replaces the page; `await v.joinAs("dana")`; the directory is what comes back, and `location.pathname` read `/lobby/listeners` throughout. Memory-only: the same from `/lobby` with `joinedInMemory()` — the open never touched the URL, the address bar never left `/lobby`, and the view is still `listeners` after the join, which is the only record there is.
  - **Test 18 — one history rule, in the two cases the path test alone got wrong.** Two tests. A deep-linked memory-only `/lobby/listeners`: a chip **replaces** the query string, and `pushState` is never called — not by the filter, not by the sidebar line, not by picking a thread. A durable `/lobby` that opens the directory (one push) and then loses persistence (`notice.note("memory")`, `await settle()`): a chip still replaces, closing the directory pushes nothing more, and the address bar stays at `/lobby/listeners` with the Thread on screen.
- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd src/web && npx vitest run test/listeners-page.test.tsx`
  Expected: FAIL — `pushState` is never called, and `pop()` leaves the view where it was.
- [ ] **Step 3: Write the implementation** in `WeaveSession` — the state widens, and the one listener joins it there, beside the state it writes and above the join remount:
```tsx
function WeaveSession(props: RouteDeps & { target: SessionTarget; lobby?: Lobby; initialView?: MainArea }) {
  const [reloadKey, setReloadKey] = useState(0);
  // `popSeq` shares this object because it has the same owner and the same lifetime: it is the
  // directory's `key` (spec §4.4), bumped only by `popstate`.
  const [main, setMain] = useState<{ view: MainArea; popSeq: number }>(
    () => ({ view: props.initialView ?? "thread", popSeq: 0 }));
  // One listener, registered only where a path of ours could ever be popped, and deliberately NOT
  // conditioned on `canLeave`: storage can degrade after a push, and a listener torn down mid-life
  // would leave Back changing the URL without changing the view. A `popstate` this page never caused
  // is harmless — it sets the view to what the URL already says.
  useEffect(() => {
    if (viewOfPath(location.pathname) === undefined) return;
    const onPop = () => setMain((m) => ({ view: viewOfPath(location.pathname) ?? "thread", popSeq: m.popSeq + 1 }));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const setView = (next: MainArea) => setMain((m) => ({ ...m, view: next }));
  return <WeaveMount key={reloadKey} {...props} onJoined={() => setReloadKey((n) => n + 1)}
    view={main.view} viewKey={main.popSeq} setView={setView} />;
}
```
  and in `WeaveMount`, the wrap — made here because this is where `canLeave` already is, so the permission needs no new prop:
```tsx
  // The app's first `pushState` (spec §4.2). It loads nothing — same document, same session, same
  // storage — and the address it writes is one this browser can honour, which is the same question
  // `canLeave` already answers. Written BEFORE the state change, so the view mounts with `location`
  // already on the new path and §4.3's seeding rule needs no special case. No query string: the
  // filters belong to the entry the directory then rewrites in place.
  const onView = (next: MainArea) => {
    if (viewOfPath(location.pathname) !== undefined && canLeave) history.pushState(null, "", pathForView(next));
    setView(next);
  };
```
  and hand `viewKey` and `onView` to `WeaveView`. Nothing below `WeaveMount` changes.
- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd src/web && npx vitest run`
  Expected: PASS for the whole package. Then `pnpm -r typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/src/components/WeaveRoute.tsx src/web/src/components/WeaveView.tsx src/web/test/listeners-page.test.tsx
git commit
# feat(web): the Lobby's two addresses are real history entries, and Back means what a human means
```

---

### Task 4: Wording — the counts line and Clear filters

Spec §9 (CR2 and CR5), §16 assumption 16. **Tests 11 and 12.**

**Files:** Modify `src/web/src/components/listeners/ListenersPage.tsx` (`:205-215`, `:226-230`, `:273`); Test `src/web/test/listeners-page.test.tsx`.

**Interfaces:**
- *Consumes:* `EMPTY_VIEW` and `ListenersView` from `listeners-query.ts`; `view`, `draft`, `draftRef`, `debounce` and `apply` inside `ListenersPage` (Task 2's shape).
- *Produces:* no new exported symbol.

- [ ] **Step 1: Write the failing tests** in `src/web/test/listeners-page.test.tsx`:
  - **Test 12 — the counts line, word for word.** Two tests. Unfiltered: 50 rows of a Lobby of 62 answered with `matched === total` renders exactly `Showing 50 of 62 listeners`. Filtered: 11 rows with `matched: 11, total: 62` renders exactly `Showing 11 of 11 matches (out of 62 listeners)` — built with `toLocaleString()` for the numbers, as the existing test at `:335` does, so no locale is pinned. Update that existing test (`"names both numbers when a filter has narrowed the Lobby"`) to the new wording in the same step; it is the only existing assertion CR2 moves.
  - **Test 11 — Clear filters.** Five tests: it is **rendered** at defaults and `disabled` there; one keystroke enables it **before** the 250 ms debounce fires (fake timers, advance 0); a single typed **space** enables it (the raw draft, not a trimmed one); pressing it with `sort=owner&dir=desc` in the link resets the two selects to `name`/`asc` **and** sends a query carrying neither; and pressing it leaves the address bar at a bare `/lobby/listeners` with `location.search === ""`.
- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd src/web && npx vitest run test/listeners-page.test.tsx`
  Expected: FAIL — the control is absent at defaults, and the filtered line reads `(62 listeners)`.
- [ ] **Step 3: Write the implementation.** Replace `anySet` (`:205-206`) with the CR5 predicate, copied from spec §9 unchanged, and make `clear` reset the sort too:
```ts
  // The raw `draft`, not a trimmed one: anything at all in the box — a space included — must leave
  // the control live, because pressing it is also what cancels a pending debounce (spec §9).
  const atDefaults = draft === "" && view.q === "" && view.models.length === 0 && view.tools.length === 0
    && view.runtime === undefined && view.serves === undefined && view.sort === "name" && view.dir === "asc";
  const clear = () => {
    // The pending keystroke is cancelled *before* `apply`, not folded into it: Clear filters empties
    // the box too, so there is no text left for it to carry, and a timer left running would have
    // typed it back in 250 ms after the click.
    if (debounce.current) { clearTimeout(debounce.current); debounce.current = undefined; }
    setDraft("");
    draftRef.current = "";
    // One `EMPTY_VIEW`: the sort and the direction go back too. This overrides listeners spec §5.3,
    // which kept the sort (spec §9, CR5).
    apply(() => ({ ...EMPTY_VIEW }));
  };
```
  and the control is always rendered (`:273`): `<button type="button" class="link" disabled={atDefaults} onClick={clear}>Clear filters</button>`. The counts line (`:226-230`) gains CR2's two words:
```ts
  // `of` before `matched` and `out of` before `total`: three numbers in one sentence need the two
  // relations spelled differently (spec §9, CR2). Nothing else is ever rendered here — never a zero.
  const counts = state.status !== "error" && state.total !== undefined && state.matched !== undefined
    ? state.matched === state.total
      ? `Showing ${n(state.rows.length)} of ${n(state.total)} listeners`
      : `Showing ${n(state.rows.length)} of ${n(state.matched)} matches (out of ${n(state.total)} listeners)`
    : undefined;
```
- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd src/web && npx vitest run`
  Expected: PASS for the whole package.
- [ ] **Step 5: Commit**

```bash
git add src/web/src/components/listeners/ListenersPage.tsx src/web/test/listeners-page.test.tsx
git commit
# feat(web): the counts line names both relations, and Clear filters is always there
```

---

### Task 5: Docs and totals

Spec §13, item by item.

**Files:** Modify `docs/ARCHITECTURE.md` (§9, §12), `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `src/web/README.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md`, `docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md`.

- [ ] **`docs/ARCHITECTURE.md` §9** — the route table: `/lobby/listeners` is the Lobby **with the directory open**, not a page of its own; the in-place mirrors go back to **two**; a new paragraph beside `leavingIsSafe` for the one history rule — never **push** unless leaving is safe, and the page's own query string rewritten wherever the path is this page's (spec §4.5); the component list loses `ListenersRoute`.
- [ ] **`docs/ARCHITECTURE.md` §12** — two sentences: the directory is read through `session.listListeners`, which is the page's own reader, and a credential recovery is authorised by the **view** through `session.reportCredentialFailure`. Core's Listeners paragraph is otherwise unchanged.
- [ ] **`docs/TESTING.md` smoke test 6** — rewrite three steps and the Back/Forward sentence of step 8:
  - **step 3**: the line is a **button**; pressing it keeps the header, the sidebar and the connection indicator and swaps only the main area; the address bar reads `/lobby/listeners`; and a half-written message left in the composer is still there on the way back.
  - **step 8**: **Back** leaves the directory and returns to the **live** Thread (same session, nothing reloaded); **Forward** comes back to the directory with the filters seeded from that entry; filter changes are still **not** history entries.
  - **step 10**: blocked site data — the view still opens, the address bar **never** moves, and the way back to the Thread is the **Thread list**, not a "Back to the Lobby" link (there is none any more).
  Keep the 2026-09-20 run record where it is, marked as the run that produced this spec.
- [ ] **`docs/KNOWN-ISSUES.md`** — narrow the appearance row (`:144`) to what this change does **not** settle and re-point it at the design session; re-measure the `ListenersPage` size row (`:149`) against the file as it now stands; leave the "no live updates" (`:145`) and "`partial` latches" (`:146`) rows alone.
- [ ] **`src/web/README.md`** — the routes table row for `/lobby/listeners` (`:23`); `ListenersRoute` out of the component list (`:256`) and out of the prose (`:126`); the in-place pair described as two, not three (`:15`, `:185`); `session.listListeners` added beside the count read (`:112`).
- [ ] **`docs/REVIEW-BRIEF.md`** — the web row of the layer table (`:70`) and the "where to look first" list (`:99-106`), which must now name `src/web/src/lobby-view.ts`, `WeaveRoute.tsx`'s view state and push, and `WeaveView.tsx`'s `showListeners`.
- [ ] **`docs/superpowers/specs/v2-notes.md`** — the listeners section's 2026-09-20 entry moves from "spec approved 2026-09-20, plan written, awaiting review" to **built**, in the shape the Lobby and main-page entries use, naming the branch and the PR.
- [ ] **`docs/superpowers/specs/2026-09-19-loom-lobby-listeners-design.md`** — a dated "superseded by" note on **§5.1, §5.2, §5.3, §5.4, §5.5 and §7**, each naming the section of the new spec that replaces it. The new spec's §2 table is the list; copy its verdicts (amended / superseded / unchanged) rather than inventing new ones.
- [ ] Run `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test` and put the **real** totals (tests and files, per package) and the last code commit's hash into `docs/TESTING.md`'s "Current totals", against the recorded baseline of **1663 tests in 65 files** (core 485/24, web 712/13, server 178/9, claude-channel 139/9, cli 70/5, client 45/4, mcp-tools 34/1). Do not estimate them; only `web` should have moved, and `server`'s 178 in 9 is the proof that `static.test.ts` needed no edit.
- [ ] **Commit**

```bash
git add -A docs src/web/README.md
git commit
# docs: the Lobby listeners view across architecture, the smoke test and the READMEs
```

---

## Self-review against the spec

- **§1** (the problem, what this builds, the success scenario, the non-goals) → the shape of the whole plan. No task changes core, REST, the client or the query semantics; no task adds live updates or an action on a listener; no task prescribes styling, and CR4 appears nowhere.
- **§2**, the amendment table, row by row: §5.1 the sidebar line → Task 2 Step 10 (always a button, toggling a view; `openListenersInPlace` gone in Step 6). §5.2 the route → Task 2 Steps 5, 6. §5.3 the page → Task 2 Step 11 (header deleted) and Task 4 (counts reworded, Clear filters always rendered and resetting the sort). §5.4 the query string → Task 2 Step 12 (`writeSearch` loses `inPlace`) and Task 3 (the push). §5.5 credentials → Task 1 (the two entry points) and Task 2 Steps 11, 13. The three "unchanged" amendments and §7's cells are asserted by the re-homed blocks, which keep their bodies.
- **§3.1** where the state lives, its type, the prop table, and the requested-versus-effective split → Task 2 Steps 5, 7, 8; **§3.2** the no-remount invariant → Task 2's test 2, which counts requests; **§3.3** the four groups → Task 2 Step 8; **§3.4** `onPick` → Task 2 Step 9; **§3.5** the hidden composer slot → Task 2 Step 8 and test 15.
- **§4.1** `routeOf` and `lobby-view.ts` → Task 2 Steps 5, 6, test 1. **§4.2** the push → Task 3 Step 3, tests 4, 7, 8, 18. **§4.3** seeding and `writeSearch` → Task 2 Steps 11, 12. **§4.4** `popstate` and `popSeq` → Task 3 Step 3, test 5. **§4.5** the narrow exception → Task 2 Step 12's rewritten comment and Task 3's test 18, which is the pair of cases the path test alone got wrong.
- **§5** the gate and the eight-row state table → Task 2 Step 8's one predicate, with the last two rows as tests 19 and 20 and the `no-credential` row as test 17.
- **§6.1** the two entry points, both guards and the ticket-out-of-the-query rule → Task 1. **§6.2** the four forks → Task 2 (the join fork is `WeaveRoute`'s, the refused-secret card is deleted with its whole describe, the `getLobby` cards are `LobbyRoute`'s). **§6.3** the re-query after a recovery → Task 2 Step 11's effect keyed on `session`, with test 9 on screen and the store assertions in Task 1.
- **§7** deleted / kept verbatim → Task 2 Steps 6, 8, 10, 11, 12, 13, each deletion named; the "kept, verbatim" list is exactly what the re-homed blocks still assert.
- **§8** the sidebar line → Task 2 Step 10, test 3. **§9** wording → Task 4. **§10** no core/server/client change → Task 0's second check and Task 5's totals line. **§11** the deltas → Tasks 1, 2 (the error bar in both views, the two guards, what a switch destroys). **§13** docs → Task 5, item by item. **§14** order → followed with the one seam moved, argued under the File structure table.
- **§12 test by test.** 1 → Task 2 (`routeOf`, plus the `viewOfPath`/`pathForView` units in `listeners-query.test.ts`). 2, 3, 6, 9, 13, 15, 16, 19, 20 → Task 2. 4, 5, 7, 8, 17, 18 → Task 3. 10 → Task 1. 11, 12 → Task 4. **Test 14 is the one numbered test split across two tasks, and the spec splits it itself**: §12 puts 14a and 14c in `session.test.ts` and 14b in the DOM suite, and 14b cannot exist before the view does — so 14a and 14c are Task 1 and 14b is Task 2. Every deleted test file section is named in Task 2 Step 3's last bullet; every re-homed block is named in the bullet above it and says how it mounts now (`mountLobby`, whose signature is given once, in Task 2 Step 1).
- **§15** nothing from "Later" is implemented: no rows cache, no scroll memory, no second view. **§16** all nineteen assumptions are implemented as stated; where one needed a concession to the existing tests it is named — assumption 4's `view`/`viewKey`/`onView` are **optional** props on `WeaveView` with the defaults `"thread"` / `0` / undefined, so that `components.test.tsx`'s bare `<WeaveView session state />` renders keep compiling and every non-Lobby page gets the right value without a prop of its own.
- **Lessons carried**, each an explicit constraint, comment or step above: never `cb?.(write())` (Global Constraints; `recoverFromCredentialFailure` already writes into a variable and Task 1 adds no new write); the guard before any side effect on rejections as much as answers (Global Constraints, Task 1's two-call API, Task 2 Step 11's handler); every async continuation re-checks liveness **inside itself** (Task 2 Step 11's `live.current && n === gen.current`, and the session's own `disposed || issue.generation !== generation`); one rule per test with RED captured before GREEN and pristine output (every task's Steps 2 and 4); gated promises, never sleeps (Task 2's tests 14b and 19, Task 3's test 5); `https://loom.test` (Global Constraints); the **TOOLING TRAP** of `\uXXXX` escapes decoded into bytes, with the `git show --stat` check after Task 2 (Global Constraints, Task 2 Step 15); the two side reads per refresh and the **shared pathname** the directory's query now collides with, told apart by `limit=0` (Global Constraints, Task 2 Step 1's `COUNT` row and `queries()` filter — without which test 9 would be about the count read's 401 and every `inTurn` script would mis-number); happy-dom's `history`/`location` handling, with the exact `pop()` recipe and the `afterEach` reset (Global Constraints, Task 3 Step 1); `retryLobbyData`'s 250 ms first sleep, which is why test 19 needs fake timers (Global Constraints, Task 2 Step 3); and build order before the web tests (Global Constraints, Task 1 Step 2).
- **Placeholder scan.** No "TBD", no "implement later", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries the code; every deleted thing is named by file and line; every test is described by its rule and its assertion.
- **Type and name consistency**, each symbol grepped for one definition and one spelling everywhere: `MainArea`, `viewOfPath(pathname)` and `pathForView(view)` are defined once in Task 2's `lobby-view.ts` and consumed by `app.tsx`, `WeaveRoute.tsx` and `ListenersPage.tsx`; `QueryIssue`, `listListeners(query): { issue, page }` and `reportCredentialFailure(e, issue)` are defined once in Task 1 and consumed only by Task 2's `ListenersPage`; `Route.lobby.view` is written by `routeOf` and read only by `App`, which hands it on as `initialView`; `initialView` has that one spelling in `WeaveRoute`, `LobbyRoute` and `WeaveSession`; `view` / `viewKey` / `onView` have those three spellings on `WeaveView` in Tasks 2 and 3 and nowhere else, and `setView` never leaves `WeaveRoute.tsx`; `showListeners` is computed once, in `WeaveView`, and passed to `ListenersLink` as `active` and to the composer slot as `hidden`; `onToggle` and `onPick` are the two new callback props, on `ListenersLink` and `ThreadList` respectively; `writeSearch(view)` has one signature after Task 2 and one caller; `ListenersPage({ session })` takes exactly that and nothing else. `ListenersRoute`, `openListenersInPlace`, `RouteDeps.openListenersInPlace`, `Route.listeners`, `ListenersPageProps` and `writeSearch`'s `inPlace` appear in **no** task except Task 2's deletions. Every symbol a task consumes is produced by an earlier task's **Produces** block or exists in the code today at the line cited.
