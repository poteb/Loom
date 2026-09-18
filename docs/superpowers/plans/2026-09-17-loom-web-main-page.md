# Loom — Web Main Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web client a front door at `/` — join the Lobby by name without a secret, see the Weaves this browser holds, read the instance guidelines, create a Weave — backed by a session that can load a Weave from `(weaveId, participant token)` instead of from a secret.

**Architecture:** The web session gains a `target` union (`{ kind: "secret" }` or `{ kind: "id" }`) and picks its read credential from it — the secret when there is one, the stored participant token otherwise, the stored secret as a read-only fallback when an identity has been invalidated. Storage moves from `loom:<secret>` to `loom:weave:<weaveId>` through a lazy, never-destructive migration, and reports whether each write actually persisted, so a credential that reached only memory is never navigated away from. The server gains static routes and nothing else: no core rule and no route authorization changes.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Preact 10 + `@preact/preset-vite`, Vite 7, Hono, Vitest 4 (node environment for store/unit tests against a real server and Postgres, happy-dom via a `// @vitest-environment happy-dom` docblock for DOM tests), `@testing-library/preact` 3.

**Spec:** `docs/superpowers/specs/2026-09-17-loom-web-main-page-design.md` (read it whole before any task). Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`.

> **Revised after plan review (2026-09-18).** Six findings, all about a credential being lost or a
> stale one winning, folded into the tasks they belong to:
>
> 1. **A bookmarked `/w/<secret>` keeps its existing identity.** The secret load now migrates that
>    one legacy key before resolving the identity, so a user who joined before this work does not
>    come back as a stranger (Task 4).
> 2. **The id-keyed entry is authoritative over a legacy duplicate.** `mergeLegacy` is one pure
>    function, shared by the main-page pass and the secret load; a newer identity is never replaced
>    by a leftover legacy one (Task 3).
> 3. **The unjoined Lobby actually offers the join form**, on `/lobby` and on a direct
>    `/weave/<lobbyId>`. The join form moved ahead of the router so the router can consume it: the
>    old Tasks 6/7/8 are now **Task 6 = Join the Lobby, Task 7 = Router, Task 8 = Main page shell**.
> 4. **Creation persists one complete entry** and branches the save-this-link panel on *that*
>    verdict, so the secret can never be the part that did not persist (Tasks 3 and 10).
> 5. **My Weaves refreshes with the same credential the session would pick** — `readerFor`, shared —
>    instead of assuming a token every row has (Tasks 3, 4 and 9).
> 6. **Storage that cannot be consulted is not storage that is empty.** `peek` is three-valued, so a
>    failed removal leaves a tombstone rather than clearing its override (Task 1).
>
> **Second plan review round (2026-09-18).** Two more, both in My Weaves:
>
> 7. **A storage change updates the visible list.** One page-scoped `WeavesSignal`, created beside
>    the storage instance in `main.tsx`, bumped by migration, by a row refresh, by an invalidation,
>    by Forget and by a creation that completes in place; `MyWeaves` re-derives
>    `foldRows(storedWeaves(storage), …)` on every bump and unsubscribes on unmount (Tasks 2, 3, 8,
>    9 and 10).
> 8. **My Weaves reports its failed writes.** `MyWeaves` gains `onWrite`, wired to `notice.note`, and
>    every write it makes passes its verdict to it — otherwise an invalidation that reached only
>    memory leaves the page saying "invalid" while durable storage still holds the old token, with no
>    warning (Tasks 8 and 9).

## Global Constraints

- **No core rule change and no route authorization change.** `src/core` is not touched at all. `src/server` gains static `index.html` routes and one boot log line — nothing else. Any task that finds itself editing a `core` rule or an auth check has misread the spec.
- **Storage key** `loom:weave:<weaveId>`; entry `{ token?, participantId?, identity?: "invalid", secret?, title?, archived?, lastOpenedAt? }`. `token`/`participantId` are the **identity**; `secret` is an **independent credential**; `title`/`archived` are a display cache; `lastOpenedAt` orders My Weaves.
- **`WriteResult = "durable" | "memory"`**, returned by `KeyValueStorage.set`. `browserStorage().set` attempts `localStorage.setItem` and then **verifies by reading back from `localStorage` itself**, never through `get` — `"durable"` when `localStorage.getItem(k) === v`, `"memory"` otherwise. `memoryStorage({ durable })` defaults to `"durable"`; `browserStorage`'s internal fallback is `memoryStorage({ durable: false })`.
- **One storage instance (§2.4a invariant):** `browserStorage()` is called exactly once in the whole web package, in `src/web/src/main.tsx`, and the instance is passed to `App` → the main-page forms, My Weaves/`storedWeaves()`, and `useSession`/`createSession`. `RequestsPanel` needs no plumbing: it reaches storage only through `session.targets()`. A guard test asserts `browserStorage(` appears exactly once in `src/web/src` outside `storage.ts`. Tests keep injecting `memoryStorage()`.
- **Storage that cannot be consulted is not storage that is empty.** `peek(k)` is three-valued: a `string` or `null` **only** from a successful `localStorage.getItem`, and `undefined` whenever the store is missing or throws. `undefined` therefore never confirms anything — a `set` under it is `"memory"` with an override, and a `remove` under it leaves a **tombstone**. Treating it as "absent" would drop the tombstone and resurrect the value the moment storage came back.
- **Read precedence (§2.4b):** a key whose last write or removal did not reach `localStorage` carries a pending override — the value, or a **tombstone** for a failed removal — and `get` answers from that override first (tombstone → `null`), ahead of `localStorage`; every other key keeps `localStorage` first, then the memory fallback. `keys()` = today's union **plus** override keys **minus** tombstoned keys. **Invariant: whatever verdict a write returns, the value it just wrote is what `get` returns for the rest of this page.** An override is cleared **only** by a later successful `set` or `remove` of that same key — no background retry, no timer, `get` stays side-effect-free. Overrides live for the page; a reload starts from `localStorage` alone. No cross-tab sync.
- **One change signal (§4.2):** the page holds one `WeavesSignal` — `{ bump(): void; subscribe(fn: () => void): () => void }` — created in `main.tsx` beside the one storage instance and passed down with it. **Every writer that can change what My Weaves shows bumps it**: `migrateLegacy` (once per entry it writes), a row refresh that saves a new title/`archived`, an identity invalidation, `Forget`, and a creation that completes while the main page stays on screen. `MyWeaves` subscribes, re-derives `foldRows(storedWeaves(storage), …)` on each bump, and unsubscribes on unmount. `KeyValueStorage` is **not** made observable — the session and every test inject it, and nothing outside this list needs the events. A bump never restarts an in-flight refresh nor re-reads a row already refreshed.
- **Every entry write on the main page reports its `WriteResult`.** Join, creation, migration *and* every write My Weaves makes (the refresh's title/`archived` save and its `invalidateIdentity`) pass their verdict to `notice.note`, so the one-time notice of §6 covers all of them. `notice.note` is the only function ever passed as an `onWrite`. `forgetWeave` is the one write that reports nothing: `remove` returns `void`, and the tombstone rule above makes a failed removal read as absent for the rest of the page anyway.
- **Legacy coexistence:** `loom:<secret>` entries stay readable forever. Migration is lazy (a `/w/<secret>` load, or the main page resolving them through the **public** `GET /api/weaves/:secret/lookup`), the id-keyed entry is written **first**, and the legacy key is removed **only** on a `"durable"` verdict. A `"memory"` verdict stops migration for the rest of the page. A failed lookup leaves the legacy entry alone. My Weaves folds a legacy and an id entry into one row when their `secret` matches, else when their `token` matches.
- **The id-keyed entry is authoritative over a legacy duplicate.** Duplicates are a supported state, so migration merges through one pure `mergeLegacy(existing, legacy)`: an id entry with a **usable identity keeps it**; an entry marked `identity: "invalid"` **never takes the legacy identity** (invalidation deletes the dead token without recording it, so nothing can tell whether the legacy token is that same dead one — adopting it would loop the session through the 401 it just survived); an entry with no identity and no marker **adopts** the legacy one; in every case a missing `secret` is carried over. Never a blind merge: a leftover legacy key must not undo a rejoin.
- **Invalid identity:** a `401 invalid_token` / `403 forbidden` on a token read, or a stored `participantId` absent from `participants`, **deletes `token` and `participantId` and sets `identity: "invalid"`**, keeping `secret`, `title`, `archived`, `lastOpenedAt`. A stored `secret` then becomes the reader (read-only, `readOnlyReason: "secret-fallback"`, join offered); with no secret the status is `no-credential`. A network failure invalidates nothing. **Nothing ever deletes a `secret`.** Only `Forget` deletes an entry.
- **`target` union:** `{ kind: "secret"; secret } | { kind: "id"; weaveId }`. `reader` = the secret for a secret target; for an id target the stored token when usable, else the stored secret, else nothing (`status: "no-credential"`). A token target never calls `lookupWeave`.
- **Routes:** `/` main page, `/lobby` (shortcut to the Lobby's id), `/weave/<uuid>`, `/w/<secret>` **unchanged in every respect**. The server serves `index.html` for exactly `/`, `/lobby`, `/lobby/`, `/weave/:id`, `/weave/:id/`, `/w/:secret`, `/w/:secret/`. **No SPA catch-all**: unknown paths keep the JSON `{ code: "not_found" }` 404, and an app built without `webDist` answers that 404 for all seven.
- **Name rule** `^[A-Za-z0-9_.-]{1,32}$` (A-Z a-z 0-9 `_ . -`, 1–32), one exported constant shared by the join form, the create form and `NamePrompt`. `kind: "human"` fixed on both forms.
- **Non-durable flow:** after a join or a creation whose credential write returned `"memory"`, **do not navigate** — render the destination in place, in the same JS context, and **leave the URL alone** (no `history.pushState`). Otherwise navigation is ordinary full page loads; no router library.
- **Lobby summary:** the Lobby's **title only** without a stored Lobby identity; participant/listener/open-request counts **only** with one, read with the stored token. **No new public read.**
- Tests: real server + Postgres via `startTestServer()` for store tests, happy-dom + `@testing-library/preact` for DOM tests, **one rule per test**, RED before GREEN, pristine output (no stray logs). Build before web tests: `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build`.
- Commits: conventional subject, body says why, trailer `Co-Authored-By: …` exactly as the controller states it in each dispatch. Branch `feat/web-main-page` off `main`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/web/src/storage.ts` (modify) | `WriteResult`, `KeyValueStorage`, `memoryStorage({ durable })`, `browserStorage()` with the override/tombstone layer. Loses `storedWeaves` to `weaves-store.ts` |
| `src/web/src/weaves-store.ts` (new) | `WeaveEntry`, `StoredWeave`, key helpers, `readWeaveEntry`, `saveWeaveEntry`, `setIdentity`, `invalidateIdentity`, `forgetWeave`, `hasIdentity`, `storedWeaves`, `mergeLegacy`, `migrateLegacy`, `migrateLegacyOne`, `readerFor` — every rule about what is stored per Weave and which credential it is read with |
| `src/web/src/persistence.ts` (new) | `createPersistenceNotice()`: the page-scoped "a write did not persist" latch the notice bar and `migrateLegacy` both read |
| `src/web/src/weaves-signal.ts` (new) | `createWeavesSignal()`: the page-scoped "the stored Weaves changed" signal every writer bumps and My Weaves subscribes to |
| `src/web/src/name.ts` (new) | `NAME_RE`, `isValidName` — core's rule, once |
| `src/web/src/session.ts` (modify) | `SessionTarget`, credential resolution, the secret fallback and identity invalidation, `readOnlyReason`, `onWrite`, `targets()` over the new store. No main-page logic |
| `src/web/src/useSession.ts` (modify) | `useSession(target, { client, storage, onWrite })` — creates no client and no storage |
| `src/web/src/main.tsx` (modify) | Composition root: the one `browserStorage()`, the one `LoomClient`, the notice |
| `src/web/src/app.tsx` (modify) | `routeOf(pathname)`, the route state (including the in-place switch), and the four route components |
| `src/web/src/components/WeaveView.tsx` (new) | Today's `Weave` component, moved out of `app.tsx`, plus the `no-credential` and read-only/rejoin branches |
| `src/web/src/components/PersistenceBar.tsx` (new) | The one-time "storage is not persisting" bar |
| `src/web/src/components/main/MainPage.tsx` (new) | The `/` shell: four independent cells, each failing on its own |
| `src/web/src/components/main/InstanceGuidelines.tsx` (new) | Public `getInstanceGuidelines()` rendered through `markdown.ts`, collapsed past 12 lines |
| `src/web/src/components/main/LobbySummary.tsx` (new) | Title always; counts only with a stored Lobby identity |
| `src/web/src/components/main/JoinLobbyForm.tsx` (new) | Name field, `joinLobby`, the error map, the `name_taken` two-case message and suffix suggestion, the durable/in-place branch |
| `src/web/src/components/main/MyWeaves.tsx` (new) | List from cache, duplicate folding, bounded refresh, filter, row states, Copy link, Forget |
| `src/web/src/components/main/CreateWeaveForm.tsx` (new) | `createWeave`, the 403 branch, the save-this-link panel and its hardened non-durable variant |
| `src/web/src/components/NamePrompt.tsx` (modify) | Imports `NAME_RE` instead of inlining it |
| `src/web/src/styles.css` (modify) | Main-page layout, notice bar, row states |
| `src/web/tsconfig.test.json` (modify) | Widen `include` to globs so new sources and tests typecheck |
| `src/server/src/app.ts` (modify, lines 75–86) | The seven `index.html` routes |
| `src/server/src/main.ts` (modify, line 33) | Boot wording |
| `src/web/test/storage.test.ts` (new) | Durable verdicts and read precedence |
| `src/web/test/weaves-store.test.ts` (new) | Entry shape, discrimination, identity helpers, migration |
| `src/web/test/one-storage-instance.test.ts` (new) | The `browserStorage(` guard |
| `src/web/test/session.test.ts` (modify) | Target union, secret fallback, invalidation, rejoin |
| `src/web/test/components.test.tsx` (modify) | `WeaveView` branches |
| `src/web/test/main-page.test.tsx` (new, happy-dom) | Every `/` component |
| `src/server/test/static.test.ts` (modify) | The seven paths, the JSON 404, the API-only app |
| docs | ARCHITECTURE §9, SECURITY §8/§9.9/§4a, TESTING, KNOWN-ISSUES, README, v2-notes |

---

### Task 0: Branch

- [ ] `git checkout -b feat/web-main-page main`
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/server build`
- [ ] Confirm the baseline is green: `cd src/web && npx vitest run` (5 files pass).

---

### Task 1: Storage — durable-write result and read precedence

Spec §2.4 ("A write must say whether it persisted") and §2.4b in full.

**Files:** Modify `src/web/src/storage.ts` (lines 1–31; leave `storedWeaves` at lines 33–46 untouched — Task 3 moves it); Test `src/web/test/storage.test.ts` (new).

**Interfaces:**

Consumes: nothing.

Produces:
```ts
export type WriteResult = "durable" | "memory";
export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): WriteResult;   // was void
  remove(key: string): void;
  keys(): string[];
};
export function memoryStorage(opts?: { durable?: boolean }): KeyValueStorage;   // durable defaults to true
export function browserStorage(): KeyValueStorage;
```

- [ ] **Step 1: Failing tests.** Create `src/web/test/storage.test.ts` with this fake — `browserStorage` reads `globalThis.localStorage` on every call, so installing one per test is the whole seam:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { browserStorage, memoryStorage } from "../src/storage.js";

type Mode = "ok" | "throw" | "silent";

/** A localStorage that can refuse writes (blocked site data) or accept them and keep nothing. */
function installLocalStorage() {
  const raw = new Map<string, string>();
  let mode: Mode = "ok";
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (mode === "throw") throw new Error("QuotaExceededError");
      if (mode === "silent") return;                       // accepts the call, stores nothing
      raw.set(k, v);
    },
    removeItem: (k: string) => {
      if (mode === "throw") throw new Error("blocked");
      if (mode === "silent") return;
      raw.delete(k);
    },
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() { return raw.size; },
    clear: () => raw.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true, writable: true });
  return { raw, setMode: (m: Mode) => { mode = m; } };
}
afterEach(() => { Reflect.deleteProperty(globalThis as object, "localStorage"); });

describe("memoryStorage", () => {
  it("reports durable by default and memory when told it is a fallback", () => {
    expect(memoryStorage().set("k", "v")).toBe("durable");
    expect(memoryStorage({ durable: false }).set("k", "v")).toBe("memory");
  });
});

describe("browserStorage write verdict", () => {
  it("is durable when the value reads back from localStorage", () => {
    installLocalStorage();
    expect(browserStorage().set("k", "v")).toBe("durable");
  });

  it("is memory when setItem throws, and the value is still readable", () => {
    const ls = installLocalStorage();
    ls.setMode("throw");
    const s = browserStorage();
    expect(s.set("k", "v")).toBe("memory");
    expect(s.get("k")).toBe("v");
    expect(ls.raw.has("k")).toBe(false);
  });

  it("is memory when setItem accepts the call and stores nothing", () => {
    const ls = installLocalStorage();
    ls.setMode("silent");
    const s = browserStorage();
    expect(s.set("k", "v")).toBe("memory");     // a 'did not throw' check would say durable here
    expect(s.get("k")).toBe("v");
  });

  it("judges each key on its own", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    ls.setMode("throw");
    expect(s.set("a", "1")).toBe("memory");
    ls.setMode("ok");
    expect(s.set("b", "2")).toBe("durable");
  });
});

describe("browserStorage read precedence", () => {
  it("a failed update to an existing durable key reads back the NEW value", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    expect(s.set("k", "old")).toBe("durable");
    ls.setMode("throw");
    expect(s.set("k", "new")).toBe("memory");
    expect(s.get("k")).toBe("new");
    expect(ls.raw.get("k")).toBe("old");        // the browser still holds the old one; the page does not
  });

  it("a failed remove of an existing durable key reads as absent and leaves keys()", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");
    ls.setMode("throw");
    s.remove("k");
    expect(s.get("k")).toBeNull();
    expect(s.keys()).not.toContain("k");
    expect(ls.raw.get("k")).toBe("v");
  });

  it("keys() includes a key that exists only as an override", () => {
    const ls = installLocalStorage();
    ls.setMode("throw");
    const s = browserStorage();
    s.set("k", "v");
    expect(s.keys()).toContain("k");
  });

  it("a later successful write clears the override", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    ls.setMode("throw");
    s.set("k", "new");
    ls.setMode("ok");
    expect(s.set("k", "newest")).toBe("durable");
    expect(ls.raw.get("k")).toBe("newest");     // durable storage is the single source again
    expect(s.get("k")).toBe("newest");
  });

  it("a later successful remove clears a tombstone", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");
    ls.setMode("throw");
    s.remove("k");
    ls.setMode("ok");
    s.remove("k");
    expect(ls.raw.has("k")).toBe(false);
    expect(s.get("k")).toBeNull();
  });

  it("get never writes", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    ls.setMode("throw");
    s.set("k", "new");
    s.get("k"); s.get("k");
    expect(ls.raw.get("k")).toBe("old");        // no opportunistic retry on a read
  });

  it("a key with no override reads localStorage first, then the memory fallback", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");                            // durable: in localStorage and in the fallback
    expect(s.get("k")).toBe("v");
    ls.raw.delete("k");                         // another tab cleared it; the fallback still has it
    expect(s.get("k")).toBe("v");
  });
});

describe("browserStorage when localStorage cannot be consulted", () => {
  it("a removal leaves a tombstone, so the value does not come back when storage returns", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "v");                            // durable
    Reflect.deleteProperty(globalThis as object, "localStorage");   // site data switched off
    s.remove("k");
    expect(s.get("k")).toBeNull();
    Object.defineProperty(globalThis, "localStorage", { value: ls.api, configurable: true, writable: true });
    expect(ls.raw.get("k")).toBe("v");          // the browser still holds it…
    expect(s.get("k")).toBeNull();              // …and this page still says it is gone
    expect(s.keys()).not.toContain("k");
  });

  it("a write is memory, and reads back the new value once storage returns", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    s.set("k", "old");
    Reflect.deleteProperty(globalThis as object, "localStorage");
    expect(s.set("k", "new")).toBe("memory");
    Object.defineProperty(globalThis, "localStorage", { value: ls.api, configurable: true, writable: true });
    expect(s.get("k")).toBe("new");
    expect(ls.raw.get("k")).toBe("old");
  });

  it("a removal that IS confirmed absent still clears its override", () => {
    const ls = installLocalStorage();
    const s = browserStorage();
    ls.setMode("throw");
    s.set("k", "v");                            // override only
    ls.setMode("ok");
    s.remove("k");                              // getItem answers null: confirmed gone
    expect(s.get("k")).toBeNull();
    expect(s.keys()).not.toContain("k");
  });
});
```

  `installLocalStorage` returns its `api` alongside `raw`/`setMode` so these three can take it away and put it back:
```ts
  return { raw, api, setMode: (m: Mode) => { mode = m; } };
```

- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/storage.test.ts`. Expect failures: `set` returns `undefined` (not `"durable"`), the silent-store case reports nothing, the failed-update case reads `"old"`, and the storage-gone removal reads `"v"` again once storage returns.
- [ ] **Step 3: Implement.** Replace lines 1–31 of `src/web/src/storage.ts` with:

```ts
/** Whether a write reached `localStorage` (`"durable"`) or only this page's memory (`"memory"`). */
export type WriteResult = "durable" | "memory";

export type KeyValueStorage = {
  get(key: string): string | null;
  /** Says whether the value persisted. `"memory"` means it is readable for this page and no longer. */
  set(key: string, value: string): WriteResult;
  remove(key: string): void;
  /** Every key held, so the Weaves this browser has a credential for can be listed. */
  keys(): string[];
};

export function memoryStorage(opts: { durable?: boolean } = {}): KeyValueStorage {
  // A map that *is* the whole store persists as long as the store does, which is what a test wants
  // to hear. `browserStorage` builds its fallback with `durable: false` and reports its own verdict.
  const durable = opts.durable ?? true;
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v); return durable ? "durable" : "memory"; },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

/** A key whose last removal did not reach `localStorage`: it must read as absent all the same. */
const TOMBSTONE = Symbol("tombstone");

/**
 * localStorage when available; every call is guarded because some contexts throw on access.
 *
 * Two things beyond a plain wrapper. A write is **verified by reading back from `localStorage`
 * itself** — a blocked or full store can accept `setItem` and keep nothing, and a read-back through
 * `get` would be answered by the fallback below and prove nothing. And a key whose last write or
 * removal did not persist keeps a **pending override**, answered ahead of `localStorage`: without
 * it, a failed update to an existing key would read back the value it was meant to replace, which
 * is how a dead credential gets resurrected. The override is cleared by the next successful write
 * or removal of that key — there is no background retry, and `get` never writes.
 */
export function browserStorage(): KeyValueStorage {
  const fallback = memoryStorage({ durable: false });
  const overrides = new Map<string, string | typeof TOMBSTONE>();
  const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
  /**
   * Three-valued on purpose: a `string` or `null` **only** from a successful read, `undefined`
   * when the store is missing or throws. `undefined` confirms nothing — reading it as "absent"
   * would let `remove` clear its override and resurrect the value once storage came back.
   */
  const peek = (k: string): string | null | undefined => {
    try { const store = ls(); return store ? store.getItem(k) : undefined; } catch { return undefined; }
  };
  return {
    get: (k) => {
      const o = overrides.get(k);
      if (o !== undefined) return o === TOMBSTONE ? null : o;
      const stored = peek(k);
      if (typeof stored === "string") return stored;
      return fallback.get(k);                       // absent, or unreadable: the fallback is all there is
    },
    set: (k, v) => {
      fallback.set(k, v);
      try { ls()?.setItem(k, v); } catch { /* quota or blocked */ }
      if (peek(k) === v) { overrides.delete(k); return "durable"; }
      overrides.set(k, v);
      return "memory";
    },
    remove: (k) => {
      fallback.remove(k);
      try { ls()?.removeItem(k); } catch { /* ignore */ }
      // Only a successful read that found nothing proves the removal. `undefined` — no store, or a
      // throwing one — is not that proof, and must leave a tombstone.
      if (peek(k) === null) overrides.delete(k); else overrides.set(k, TOMBSTONE);
    },
    keys: () => {
      const seen = new Set(fallback.keys());
      try {
        const store = ls();
        for (let i = 0; i < (store?.length ?? 0); i++) { const k = store!.key(i); if (k !== null) seen.add(k); }
      } catch { /* blocked: the in-memory keys are all this context has */ }
      for (const [k, v] of overrides) { if (v === TOMBSTONE) seen.delete(k); else seen.add(k); }
      return [...seen];
    },
  };
}
```

- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run test/storage.test.ts && npx vitest run && pnpm typecheck`. Every existing caller ignores the return value, so nothing else moves.
- [ ] **Step 5: Commit** — `feat(web): storage reports whether a write persisted, and a failed write wins over a stale value`

---

### Task 2: One app-owned storage instance

Spec §2.4a. Mechanical, and everything after it depends on the invariant.

**Files:** Modify `src/web/src/main.tsx` (all 5 lines), `src/web/src/app.tsx` (lines 19–26: `App` takes props, `Weave` keeps its own signature for now), `src/web/src/useSession.ts` (all 18 lines); Create `src/web/src/persistence.ts`, `src/web/src/weaves-signal.ts`; Test `src/web/test/one-storage-instance.test.ts` (new).

**Interfaces:**

Consumes: `KeyValueStorage`, `WriteResult`, `browserStorage()`, `memoryStorage(opts?)` (Task 1).

Produces:
```ts
// src/web/src/persistence.ts
export type PersistenceNotice = {
  /** Latches "degraded" the first time a write reports `"memory"`. Idempotent. */
  note(result: WriteResult): void;
  degraded(): boolean;
  dismissed(): boolean;
  dismiss(): void;
  subscribe(fn: () => void): () => void;
};
export function createPersistenceNotice(): PersistenceNotice;

// src/web/src/weaves-signal.ts
/**
 * "The stored Weaves changed." One instance per page, created beside the one storage instance, so
 * anything that writes an entry can say so and My Weaves can re-read storage (§4.2).
 */
export type WeavesSignal = {
  /** Say that the stored entries changed. Synchronous; every subscriber is called once. */
  bump(): void;
  subscribe(fn: () => void): () => void;
};
export function createWeavesSignal(): WeavesSignal;

// src/web/src/useSession.ts — `secret` becomes a `target` in Task 4; `deps` is final.
export function useSession(
  secret: string,
  deps: { client: LoomClient; storage: KeyValueStorage; onWrite?: (r: WriteResult) => void },
): { session: Session; state: SessionState };

// src/web/src/app.tsx
export type AppDeps = {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
};
export function App(deps: AppDeps): JSX.Element;
```

Why a signal beside the storage instance rather than an observable `KeyValueStorage`: the store is
injected into the session and into 28 test call sites, so making it observable would put an event
system in everybody's way for one list's benefit. A separate signal has the same lifetime and the
same reach as the storage instance — whoever is handed `storage` is handed `weaves` — and stays a
five-line object. It lives at the app root rather than inside `MainPage` for the same reason
`storage` does: a page-scoped fact belongs to the page, not to whichever component happens to be
mounted, and a route switch (§3.1's in-place transition) must not silently give someone a second one.

- [ ] **Step 1: Failing tests.** Create `src/web/test/one-storage-instance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("one storage instance (spec §2.4a)", () => {
  it("constructs browserStorage() exactly once outside storage.ts", () => {
    const hits = sources(SRC)
      .filter((f) => path.basename(f) !== "storage.ts")
      .filter((f) => /browserStorage\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replaceAll("\\", "/"));
    expect(hits).toEqual(["main.tsx"]);
  });
});
```

  Plus, in the same file, a `PersistenceNotice` describe block: `note("durable")` leaves `degraded()` false; the first `note("memory")` makes it true and calls every subscriber exactly once; a second `note("memory")` notifies nobody; `dismiss()` sets `dismissed()` and notifies; `degraded()` stays true after a dismiss.

  And a `WeavesSignal` describe block: a `bump()` calls every subscriber exactly once; a **second** `bump()` calls them again (unlike the notice, this one does not latch — every change is news); an unsubscribed listener is not called again; `bump()` with no subscribers does nothing and does not throw.

- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/one-storage-instance.test.ts`. Expect `["useSession.ts"]` from the guard and missing-module errors for `persistence.js` and `weaves-signal.js`.
- [ ] **Step 3: Implement `persistence.ts` and `weaves-signal.ts`:**

```ts
import type { WriteResult } from "./storage.js";

/**
 * Whether anything this page wrote failed to persist, and whether the human has been told.
 * Page-scoped and latching: one notice per page load, and `migrateLegacy` reads the same latch to
 * stop rewriting entries once the store has proven it will not keep them.
 */
export type PersistenceNotice = {
  note(result: WriteResult): void;
  degraded(): boolean;
  dismissed(): boolean;
  dismiss(): void;
  subscribe(fn: () => void): () => void;
};

export function createPersistenceNotice(): PersistenceNotice {
  let degraded = false;
  let dismissed = false;
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };
  return {
    note: (r) => { if (r === "memory" && !degraded) { degraded = true; emit(); } },
    degraded: () => degraded,
    dismissed: () => dismissed,
    dismiss: () => { if (!dismissed) { dismissed = true; emit(); } },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
```

```ts
// src/web/src/weaves-signal.ts

/**
 * "The stored Weaves changed." My Weaves renders from storage, and a `KeyValueStorage` says nothing
 * when it is written — so without this a finished migration, a refreshed title or an invalidated
 * identity would sit in storage while the screen kept the values it read at mount (spec §4.2).
 *
 * Deliberately not an observable storage: the store is injected into the session and into every
 * test, and only this one list wants the events. Deliberately not latching either — unlike
 * `PersistenceNotice`, every bump is news.
 */
export type WeavesSignal = {
  bump(): void;
  subscribe(fn: () => void): () => void;
};

export function createWeavesSignal(): WeavesSignal {
  const listeners = new Set<() => void>();
  return {
    // A copy, so a listener that unsubscribes while being notified cannot disturb this pass.
    bump: () => { for (const l of [...listeners]) l(); },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
```

- [ ] **Step 4: Implement the composition root.** `src/web/src/main.tsx` becomes:

```tsx
import { render } from "preact";
import { LoomClient } from "@loom/client";
import { App } from "./app.js";
import { browserStorage } from "./storage.js";
import { createPersistenceNotice } from "./persistence.js";
import { createWeavesSignal } from "./weaves-signal.js";
import "./styles.css";

// The one storage instance in the package (spec §2.4a). Every session, form and list shares it, so
// a credential that could only be written to memory is still there after an in-place transition.
// The signal is its companion: one per page, handed to everyone who is handed the store, so a write
// here shows up in the list there (spec §4.2).
render(
  <App
    client={new LoomClient({ baseUrl: location.origin, allowInsecure: location.protocol === "http:" })}
    storage={browserStorage()}
    notice={createPersistenceNotice()}
    weaves={createWeavesSignal()}
  />,
  document.getElementById("app")!,
);
```

  `src/web/src/useSession.ts` stops constructing anything:

```ts
import { useEffect, useMemo, useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionState } from "./session.js";
import type { KeyValueStorage, WriteResult } from "./storage.js";

export function useSession(
  secret: string,
  deps: { client: LoomClient; storage: KeyValueStorage; onWrite?: (r: WriteResult) => void },
): { session: Session; state: SessionState } {
  const { client, storage, onWrite } = deps;
  const session = useMemo(() => createSession({ client, secret, storage, onWrite }), [secret, client, storage]);
  const [state, setState] = useState<SessionState>(session.getState());
  useEffect(() => {
    const off = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => { off(); session.dispose(); };
  }, [session]);
  return { session, state };
}
```

  `App` in `app.tsx` takes `{ client, storage, notice, weaves }` and threads `client`/`storage` into `useSession`; `notice` and `weaves` are unused until Tasks 7–8 (no dead prop — pass them to nothing yet, but accept them, and say so in a comment). `createSession` gains an optional `onWrite?: (r: WriteResult) => void` that it calls after each storage write (today: the one `storage.set` in `join()`).

- [ ] **Step 5: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 6: Commit** — `refactor(web): one storage instance and one client, created at the app root`

---

### Task 3: The Weave entry store and legacy migration

Spec §2.4 ("The entry", "Coexistence and migration").

**Files:** Create `src/web/src/weaves-store.ts`; Modify `src/web/src/storage.ts` (delete `storedWeaves`, lines 33–46), `src/web/src/session.ts` (line 3 and line 533: import `storedWeaves` from `./weaves-store.js`); Test `src/web/test/weaves-store.test.ts` (new).

**Interfaces:**

Consumes: `KeyValueStorage`, `WriteResult`, `memoryStorage(opts?)`, `browserStorage()` (Task 1); `PersistenceNotice` (Task 2).

Produces:
```ts
export type WeaveEntry = {
  token?: string; participantId?: string; identity?: "invalid";
  secret?: string; title?: string; archived?: boolean; lastOpenedAt?: string;
};
export type StoredWeave =
  | ({ kind: "id"; weaveId: string } & WeaveEntry)
  | { kind: "legacy"; secret: string; token: string; participantId?: string };

export const KEY_PREFIX = "loom:";
export const WEAVE_PREFIX = "loom:weave:";
export function weaveKey(weaveId: string): string;
export function legacyKey(secret: string): string;

export function readWeaveEntry(storage: KeyValueStorage, weaveId: string): WeaveEntry | undefined;
/** Merges the defined keys of `patch` over what is stored. Never deletes a key. */
export function saveWeaveEntry(storage: KeyValueStorage, weaveId: string, patch: Partial<WeaveEntry>): WriteResult;
/**
 * Writes an identity and clears `identity: "invalid"`, in **one** write — `extra` carries whatever
 * else the same moment learned (`secret`, `title`, `lastOpenedAt`), so a caller never has to trust
 * the verdict of a small write to stand for a larger one. The one writer for join/create/rejoin.
 */
export function setIdentity(
  storage: KeyValueStorage, weaveId: string,
  who: { token: string; participantId: string }, extra?: Partial<WeaveEntry>,
): WriteResult;
/** Deletes `token`/`participantId`, sets `identity: "invalid"`. Keeps `secret` and the display cache. */
export function invalidateIdentity(storage: KeyValueStorage, weaveId: string): WriteResult;
export function forgetWeave(storage: KeyValueStorage, weaveId: string): void;
export function hasIdentity(e: WeaveEntry | undefined): e is WeaveEntry & { token: string; participantId: string };
export function storedWeaves(storage: KeyValueStorage): StoredWeave[];

/** The id entry wins. Pure, so both migration paths decide identically. */
export function mergeLegacy(
  existing: WeaveEntry | undefined,
  legacy: { secret: string; token: string; participantId?: string },
): WeaveEntry;
/** Migrates one known legacy key; `undefined` when there was nothing to migrate. */
export function migrateLegacyOne(storage: KeyValueStorage, weaveId: string, secret: string): WriteResult | undefined;
/**
 * `onChanged` is called once **per entry actually written**, not once at the end: the caller is a
 * list on screen (§4.2), a lookup can be slow or hang, and the pass returns early once the store has
 * proven it keeps nothing — an end-only call would be skipped in exactly the degraded case where the
 * screen is most wrong. The cost is bounded by the number of legacy keys, which is small by
 * construction (no code writes one after this lands).
 */
export async function migrateLegacy(
  storage: KeyValueStorage, notice: PersistenceNotice, lookup: (secret: string) => Promise<string>,
  onChanged?: () => void,
): Promise<void>;

/**
 * Which credential to read a Weave with, given what this browser holds for it (spec §2.3/§2.6).
 * The session and My Weaves both call it, so a row is never refreshed with a credential the page
 * itself would not have used. `undefined` means this browser holds nothing for that Weave.
 */
export type ReaderChoice = { reader: LoomClient; withToken: boolean; readOnlyReason?: "secret-fallback" };
export function readerFor(client: LoomClient, entry: WeaveEntry | undefined): ReaderChoice | undefined;
/** A 401/403 on a read: this credential is provably unusable, unlike a network failure. */
export function isCredentialFailure(e: unknown): boolean;
```

- [ ] **Step 1: Failing tests** in `src/web/test/weaves-store.test.ts` (node environment, `memoryStorage()` unless a durability rule is under test), one rule each:
  - `storedWeaves` returns `{ kind: "id" }` for `loom:weave:<uuid>` and `{ kind: "legacy" }` for `loom:<43-char secret>` — the discriminator is the colon in the remainder.
  - A key that is neither (`other:x`, `loom:weave:` with an empty id, a legacy value with no `token`) is skipped.
  - A corrupt JSON value is skipped, not fatal.
  - `saveWeaveEntry` merges: `{ title: "A" }` then `{ lastOpenedAt: "t" }` leaves both; `undefined` values in the patch change nothing.
  - `setIdentity` writes `token`/`participantId` **and removes** an existing `identity: "invalid"`.
  - `setIdentity` with `extra` writes the identity **and** `secret`/`title`/`lastOpenedAt` in **one** `storage.set` (assert with a counting storage double: exactly one `set` call).
  - `mergeLegacy` table — existing `{ token: "new", participantId: "pNew" }` + legacy `{ token: "old" }` → keeps `"new"`; existing `{ identity: "invalid", secret: "s" }` + legacy `{ token: "old" }` → **no** `token` and `identity` still `"invalid"`; existing `{ title: "T" }` (no identity, no marker) + legacy `{ token: "old", participantId: "pOld" }` → adopts both and keeps `title`; existing without `secret` → the legacy `secret` is carried over; existing **with** a `secret` → it is not overwritten; `existing === undefined` → the legacy identity and secret.
  - `readerFor` table — usable identity → `{ withToken: true }` and the token as the credential; `identity: "invalid"` with a `secret` → `{ withToken: false, readOnlyReason: "secret-fallback" }`; no identity but a `secret` → the same; neither → `undefined`.
  - `migrateLegacyOne` with no legacy key present → `undefined`, and nothing is written (counting double).
  - `invalidateIdentity` deletes `token` and `participantId`, sets `identity: "invalid"`, and keeps `secret`, `title`, `archived`, `lastOpenedAt`.
  - `hasIdentity` is false for `{}`, false for `{ token, participantId, identity: "invalid" }`, true for `{ token, participantId }`.
  - `forgetWeave` removes the key; `storedWeaves` no longer lists it.
  - Migration, durable: a legacy entry + a `lookup` returning an id → the id entry holds `token`, `participantId` and `secret`, and the legacy key is **gone**.
  - Migration over a **conflicting duplicate**: an id entry whose token is `"new"` plus a legacy key whose token is `"old"` → the id entry still reads `"new"` afterwards, and the legacy key is removed (durable) — the regression test for a rejoin being undone.
  - Migration over an **`identity: "invalid"`** id entry: the entry still has no `token` and still reads `identity: "invalid"`, and its `secret` is intact.
  - Migration, non-durable (`installLocalStorage()` from Task 1 in `silent` mode, over a real `browserStorage()`): the id entry is **readable on this page**, the legacy key is **still in `localStorage`**, and a *second* `browserStorage()` over the same raw map (a reload) still yields the legacy entry with its token.
  - Migration stops after a `"memory"` verdict: with two legacy entries and a `lookup` spy, the spy is called at most once more after the first failed write, and the second legacy key is untouched.
  - A `lookup` that rejects leaves that legacy entry alone and moves on to the next.
  - `onChanged` is called **once per entry written**: two legacy entries that both migrate → a `vi.fn()` `onChanged` called twice; a `lookup` that rejects for one of them → called once; no legacy entries at all → never called.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/weaves-store.test.ts`.
- [ ] **Step 3: Implement** `weaves-store.ts`. The load-bearing parts:

```ts
export function saveWeaveEntry(storage: KeyValueStorage, weaveId: string, patch: Partial<WeaveEntry>): WriteResult {
  const next: WeaveEntry = { ...(readWeaveEntry(storage, weaveId) ?? {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return storage.set(weaveKey(weaveId), JSON.stringify(next));
}

export function setIdentity(
  storage: KeyValueStorage, weaveId: string,
  who: { token: string; participantId: string }, extra: Partial<WeaveEntry> = {},
): WriteResult {
  // Spread-minus, not `saveWeaveEntry`: a rejoin has to *clear* `identity`, and a merge cannot.
  // One write, `extra` included: two writes would let the credential persist while the secret beside
  // it did not (or the reverse), and leave the caller branching on the verdict of the wrong one.
  const { identity: _dropped, ...rest } = readWeaveEntry(storage, weaveId) ?? {};
  const next: WeaveEntry = { ...rest, token: who.token, participantId: who.participantId };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return storage.set(weaveKey(weaveId), JSON.stringify(next));
}

/**
 * How a legacy `loom:<secret>` entry folds into an id-keyed one. The **id entry is authoritative**:
 * duplicates are a supported state (a non-durable migration leaves one on purpose), so a leftover
 * legacy key must never undo a rejoin that happened since.
 *
 * An entry marked `identity: "invalid"` does not take the legacy identity either. Invalidation
 * deletes the dead token without recording it, so nothing here can tell whether the legacy token is
 * that very token; adopting it would march the session back into the 401 it just survived. The
 * secret is different — it is an independent credential — so it is carried over whenever the id
 * entry lacks one.
 */
export function mergeLegacy(
  existing: WeaveEntry | undefined,
  legacy: { secret: string; token: string; participantId?: string },
): WeaveEntry {
  const next: WeaveEntry = { ...(existing ?? {}) };
  next.secret ??= legacy.secret;
  const settled = hasIdentity(existing) || existing?.identity === "invalid";
  if (!settled) { next.token = legacy.token; if (legacy.participantId) next.participantId = legacy.participantId; }
  return next;
}

export function migrateLegacyOne(storage: KeyValueStorage, weaveId: string, secret: string): WriteResult | undefined {
  const raw = storage.get(legacyKey(secret));
  if (!raw) return undefined;
  let legacy: WeaveEntry;
  try { legacy = JSON.parse(raw) as WeaveEntry; } catch { return undefined; }
  if (!legacy.token) return undefined;
  const merged = mergeLegacy(readWeaveEntry(storage, weaveId), { secret, token: legacy.token, participantId: legacy.participantId });
  // Written even when the merge changed nothing: it is the only way to learn whether the id entry
  // is durable, and the legacy key may not be dropped on anything less than that answer.
  const result = storage.set(weaveKey(weaveId), JSON.stringify(merged));
  if (result === "durable") storage.remove(legacyKey(secret));
  return result;
}

/** The session's and My Weaves' shared credential choice (spec §2.3/§2.6). */
export function readerFor(client: LoomClient, entry: WeaveEntry | undefined): ReaderChoice | undefined {
  if (hasIdentity(entry) && entry.identity !== "invalid") return { reader: client.withToken(entry.token), withToken: true };
  if (entry?.secret) return { reader: client.withToken(entry.secret), withToken: false, readOnlyReason: "secret-fallback" };
  return undefined;
}

export function isCredentialFailure(e: unknown): boolean {
  return e instanceof LoomClientError && (e.code === "invalid_token" || e.code === "forbidden");
}

export function invalidateIdentity(storage: KeyValueStorage, weaveId: string): WriteResult {
  // The secret is an independent credential: a dead token is no evidence against it (spec §2.6).
  const { token: _t, participantId: _p, ...rest } = readWeaveEntry(storage, weaveId) ?? {};
  return storage.set(weaveKey(weaveId), JSON.stringify({ ...rest, identity: "invalid" as const }));
}

export function storedWeaves(storage: KeyValueStorage): StoredWeave[] {
  const out: StoredWeave[] = [];
  for (const key of storage.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const rest = key.slice(KEY_PREFIX.length);
    const raw = storage.get(key);
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as WeaveEntry;
      if (rest.startsWith("weave:")) {
        const weaveId = rest.slice("weave:".length);
        if (weaveId) out.push({ kind: "id", weaveId, ...v });
      } else if (!rest.includes(":") && v.token) {
        out.push({ kind: "legacy", secret: rest, token: v.token, participantId: v.participantId });
      }
    } catch { /* a corrupt entry is simply not a Weave this browser can offer */ }
  }
  return out;
}

/**
 * Rewrites `loom:<secret>` entries to `loom:weave:<id>`, lazily and without ever losing one.
 *
 * The new entry is written first and the legacy key removed only once that write is confirmed
 * durable: dropping a durable key in favour of a copy that exists only in memory is the whole
 * failure this ordering exists to prevent. A `"memory"` verdict also stops the pass — the store has
 * just proven it will not keep anything, so rewriting the rest would be a storm with no benefit.
 *
 * `onChanged` fires per entry written, because the caller is usually a list on screen and a row that
 * has just resolved should not wait for the slowest lookup in the pass (spec §4.2).
 */
export async function migrateLegacy(
  storage: KeyValueStorage, notice: PersistenceNotice, lookup: (secret: string) => Promise<string>,
  onChanged: () => void = () => {},
): Promise<void> {
  for (const w of storedWeaves(storage)) {
    if (w.kind !== "legacy") continue;
    if (notice.degraded()) return;
    let weaveId: string;
    try { weaveId = await lookup(w.secret); } catch { continue; }   // unreachable: leave it alone
    const result = migrateLegacyOne(storage, weaveId, w.secret);    // merge rule and removal live there
    if (result) { notice.note(result); onChanged(); }               // the entry changed, durable or not
  }
}
```

- [ ] **Step 4: Move `storedWeaves`** out of `storage.ts` and repoint `src/web/src/session.ts` line 3 (`import { storedWeaves, type KeyValueStorage }`) at `./weaves-store.js` for `storedWeaves` and `./storage.js` for the type. `targets()` (line 533) keeps compiling by destructuring the legacy shape for now — Task 4 rewrites it.
- [ ] **Step 5: GREEN** — `cd src/web && npx vitest run && pnpm typecheck`.
- [ ] **Step 6: Commit** — `feat(web): per-Weave storage entries keyed by id, with non-destructive legacy migration`

---

### Task 4: Session — the `target` union, the secret fallback, identity invalidation

Spec §2.3, §2.5, §2.6, §2.7.

**Files:** Modify `src/web/src/session.ts` (lines 1–10 imports, 78–98 the `createSession` head, 334–430 `load()`, 432–445 `join()`, 531–548 `targets()`), `src/web/src/useSession.ts` (first parameter); Test `src/web/test/session.test.ts` (modify: `makeSession` helper + new cases).

**Interfaces:**

Consumes: `KeyValueStorage`, `WriteResult` (Task 1); `PersistenceNotice` (Task 2); `WeaveEntry`, `readWeaveEntry`, `saveWeaveEntry`, `setIdentity(storage, weaveId, who, extra?)`, `invalidateIdentity`, `hasIdentity`, `storedWeaves`, `migrateLegacyOne`, `readerFor`, `ReaderChoice` (Task 3).

Produces:
```ts
export type SessionTarget = { kind: "secret"; secret: string } | { kind: "id"; weaveId: string };

export type SessionState = {
  status: "loading" | "ready" | "error" | "no-credential";
  /** Set when the page is reading with a stored secret because the identity is gone (spec §2.6). */
  readOnlyReason?: "secret-fallback";
  // …every existing field unchanged…
};

export type TargetWeave = { weaveId: string; title: string; token: string; threads: { id: string; name: string }[] };

export function createSession(opts: {
  client: LoomClient; target: SessionTarget; storage: KeyValueStorage;
  onWrite?: (result: WriteResult) => void; retry?: RetryOptions; closedRequestsPage?: number;
}): Session;

// useSession's first parameter becomes the union; `deps` is unchanged from Task 2.
export function useSession(
  target: SessionTarget,
  deps: { client: LoomClient; storage: KeyValueStorage; onWrite?: (r: WriteResult) => void },
): { session: Session; state: SessionState };
```

- [ ] **Step 1: Failing tests** in `src/web/test/session.test.ts`. Change the helper to `makeSession(target: SessionTarget, storage = memoryStorage(), over = {})` and update the existing call sites to `{ kind: "secret", secret }` — those must all keep passing untouched otherwise, they are the guard that `/w/<secret>` did not move. New cases:
  - A `{ kind: "id" }` session loads a Weave from a stored participant token: threads, participants, events and the stream all arrive, **with no secret anywhere in the test** (join through the API with `anon.joinWeave`, put the token in storage with `setIdentity`, then load by id).
  - The same Weave loaded by secret and by id yields equal `weave`, `threads` and `participants`.
  - A `{ kind: "id" }` session on the **Lobby** loads the requests board with a Lobby participant token.
  - No stored entry → `status: "no-credential"`, and **no HTTP call was made** (assert with a counting `fetch` in the injected client).
  - A network failure during load → `status: "error"` and the entry is untouched (compare the raw stored string before and after).
  - Mutations on a token session (`post`, `createThread`) succeed.
  - `needsName` is never raised on a session reading with a token.
  - **Invalid token, valid stored secret**: entry holds a bad `token` plus a real `secret` → `status: "ready"`, `readOnlyReason === "secret-fallback"`, and the entry keeps `secret`/`title`/`lastOpenedAt` while `token`/`participantId` are gone and `identity === "invalid"`.
  - **Rejoin from that state**: `session.join("Dana")` → the entry has a fresh `token`/`participantId`, no `identity`, and `post` succeeds.
  - **Missing `participantId`** (valid token, `participantId` pointing at nobody) → same invalidation, same fallback, same rejoin.
  - **Invalid token, no secret** → `status: "no-credential"`, the entry is **still there** with `identity: "invalid"` and its cached `title`.
  - **403 for a token belonging to another Weave** → same as the invalid token.
  - **Invalidation that cannot be persisted**: over a `browserStorage()` on a `silent`-mode fake `localStorage`, the entry still **reads** `identity: "invalid"` with no token, and the session falls back to the secret.
  - **A rejoin whose write cannot be persisted**: the entry reads back the **new** token and `post` succeeds.
  - **A bookmarked `/w/<secret>` keeps an existing legacy identity**: seed storage with **only** `loom:<secret>` → `{"token","participantId"}` (the pre-migration shape, written by hand, no id key at all) and load `{ kind: "secret", secret }`. The session comes up **joined**: `state.me.participant.id` is that participant, `needsName` is false, and `post` succeeds. Afterwards the id entry exists with the `secret` carried over, and the legacy key is **gone** (durable storage).
  - The same seed over a `browserStorage()` on a `silent`-mode fake `localStorage`: the session is **still joined this page**, and the legacy key is **still present** — nothing was traded away for a copy that would not survive a reload.
  - The same seed **plus** an id entry whose token is newer: the session uses the newer token, not the legacy one (the `mergeLegacy` rule, seen from the session).
  - `onWrite` is called with the verdict of every storage write the session makes (join, invalidate, the secret-load migration).
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/session.test.ts`.
- [ ] **Step 3: Implement the credential resolution.** Replace the head of `createSession` (today's lines 81–96, `const key = …` and `const reader = client.withToken(secret)`) with:

```ts
  const { client, target, storage } = opts;
  const onWrite = opts.onWrite ?? (() => {});
  let weaveId: string | undefined = target.kind === "id" ? target.weaveId : undefined;
  let secret: string | undefined = target.kind === "secret" ? target.secret : undefined;
  let reader: LoomClient = client;                 // replaced by pickReader() on every load()
  let readingWithToken = false;

  const entry = () => (weaveId ? readWeaveEntry(storage, weaveId) : undefined);

  /**
   * The credential this load reads with (spec §2.3).
   *
   * A secret target reads with its secret, exactly as before — that is what grants read *before*
   * joining. An id target reads with the stored token while it is usable and falls back to a stored
   * secret when it is not, which is read-only until a join. `undefined` means this browser holds
   * nothing for this Weave.
   */
  const pickReader = (): ReaderChoice | undefined => {
    if (target.kind === "secret") return { reader: client.withToken(secret!), withToken: false };
    const e = entry();
    secret ??= e?.secret;
    // One shared rule, so My Weaves refreshes a row with the credential this page would have used.
    return readerFor(client, secret && !e?.secret ? { ...e, secret } : e);
  };

```
  `isCredentialFailure` comes from `weaves-store.ts` (Task 3) — the same test My Weaves uses.

  Hoist the body of today's `load()` into `const doLoad = async (): Promise<void> => { … }` above the `return {` and expose it as `load: doLoad`, so the one retry below can call it. Inside it:
  - before the first request:
```ts
        const picked = pickReader();
        if (!picked) { set({ status: "no-credential", readOnlyReason: undefined }); return; }
        reader = picked.reader;
        readingWithToken = picked.withToken;
        if (target.kind === "secret") {
          const id = await reader.lookupWeave(secret!);     // unchanged: the secret-only route
          if (stale()) return;
          weaveId = id;
          // Spec §2.4, migration trigger 1. This is the load that learns the id, and a browser that
          // joined before this work has its only identity under `loom:<secret>` — without this, a
          // bookmarked link comes back as a stranger and the name prompt asks for a name it already
          // has. `migrateLegacyOne` owns the merge rule and removes the legacy key only on
          // `"durable"`, so the non-durable case keeps both and is still joined for this page.
          const migrated = migrateLegacyOne(storage, weaveId, secret!);
          if (migrated) onWrite(migrated);
        }
```
    and every later `id` in the body becomes `weaveId!`.
  - the stored identity is read from the entry rather than from `storage.get(key)` (today's lines 383–390):
```ts
        const e = entry();
        let me: SessionState["me"];
        if (hasIdentity(e) && e.identity !== "invalid") {
          const p = info.participants.find((x) => x.id === e.participantId);
          // A token that reads but names nobody is a corrupt identity, and on a token load it is
          // also the credential in hand — treated exactly like a 401 (spec §2.6).
          if (p) me = { token: e.token, participant: p };
          else if (readingWithToken) throw new LoomClientError("invalid_token", "Stored identity is not in this Weave");
        }
```
  - on success, the display cache and the entry for a secret load:
```ts
        onWrite(saveWeaveEntry(storage, weaveId!, {
          secret, title: info.weave.title, archived: !!info.weave.archivedAt, lastOpenedAt: new Date().toISOString(),
        }));
```
    (a `/w/<secret>` visit therefore writes an entry before any join — spec §10.9 — and only after a **successful** metadata read, so a failed load stores nothing.)
  - `set({ status: "ready", …, readOnlyReason: picked.readOnlyReason })`.
  - the catch:
```ts
      } catch (e) {
        if (stale()) return;
        // The credential in hand is provably unusable: clear the identity (never the secret) and,
        // when a secret is stored, load again with it. Once only — `retriedWithSecret` makes a
        // second failure an error rather than a loop.
        if (readingWithToken && isCredentialFailure(e) && weaveId && !retriedWithSecret) {
          onWrite(invalidateIdentity(storage, weaveId));
          retriedWithSecret = true;
          if (readWeaveEntry(storage, weaveId)?.secret) return await doLoad();
          set({ status: "no-credential", error: "Your identity in this Weave is no longer valid" });
          return;
        }
        const msg = e instanceof LoomClientError && e.code === "weave_not_found"
          ? "Weave not found: the link may be wrong" : (e as Error).message;
        set({ status: "error", error: msg });
      }
```
    with `let retriedWithSecret = false;` beside `generation`, reset to `false` at the top of `doLoad`'s successful path only when the load came from a token (`readingWithToken`).
- [ ] **Step 4: Implement `join()` and `targets()`.** `join(name)` joins with `secret` (the target's, or the entry's on the fallback path) and throws `new LoomClientError("validation", "This session has no way to join")` when there is none; on success it calls `setIdentity(storage, weaveId!, { token: j.token, participantId: j.participant.id }, { secret, title: j.weave.title, lastOpenedAt: new Date().toISOString() })` — **one** write, so the verdict covers the identity and the secret together — reports it through `onWrite`, and keeps the rest of today's body (optimistic participant list, `deriveInvites`, `scheduleRefresh`) plus `readOnlyReason: undefined`. `targets()` iterates `storedWeaves(storage)`:
```ts
      for (const w of storedWeaves(storage)) {
        // A target credential must pass `assertIsKeeperOf` in the target Weave, which a secret does
        // not: an entry with no usable identity is not a target this browser can offer.
        const token = w.kind === "legacy" ? w.token : (hasIdentity(w) && w.identity !== "invalid" ? w.token : undefined);
        if (!token) continue;
        try {
          const c = client.withToken(token);
          const id = w.kind === "legacy" ? await c.lookupWeave(w.secret) : w.weaveId;   // id entries skip the lookup
          if (id === state.lobby?.weaveId) continue;
          const info = await c.getWeave(id);
          if (info.weave.archivedAt) continue;
          out.push({ weaveId: id, title: info.weave.title, token, threads: info.threads.filter((t) => !t.closedAt).map((t) => ({ id: t.id, name: t.name })) });
        } catch { /* not a target this browser can offer */ }
      }
```
- [ ] **Step 5: `useSession`** takes the union and memoizes on a **string** key, because a `target` object literal is a new reference on every render:
```ts
  const key = target.kind === "secret" ? `s:${target.secret}` : `i:${target.weaveId}`;
  const session = useMemo(() => createSession({ client, target, storage, onWrite }), [key, client, storage]);
```
  Update `app.tsx`'s `Weave` component to pass `{ kind: "secret", secret }`.
- [ ] **Step 6: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 7: Commit** — `feat(web): the session loads a Weave from a stored token, and falls back to a secret when an identity dies`

---

### Task 5: Server — serve `index.html` for the new paths

Spec §3.2.

**Files:** Modify `src/server/src/app.ts` (lines 75–86), `src/server/src/main.ts` (line 33); Test `src/server/test/static.test.ts` (modify).

**Interfaces:** Consumes nothing from earlier tasks. Produces no exported symbol — only routes.

- [ ] **Step 1: Failing tests** in `src/server/test/static.test.ts`, alongside the existing four:
  - `index.html` is served for `/`, `/lobby`, `/lobby/`, `/weave/<uuid>` and `/weave/<uuid>/` — status 200, `content-type` contains `text/html`, body contains `<div id=app>` (the same three assertions the `/w/<secret>` test already makes).
  - The existing "keeps JSON 404 for unknown routes" test is extended with `/weave` (no id), `/weave/<uuid>/extra` and `/lobbyx` → 404 with `code: "not_found"`.
  - The API-only app (`apiOnlyUrl`, no `webDist`) answers the JSON 404 for all seven paths.
- [ ] **Step 2: RED** — `cd src/server && npx vitest run test/static.test.ts`.
- [ ] **Step 3: Implement.** Replace lines 84–85 of `src/server/src/app.ts` with:
```ts
    // Every path the web UI routes; deliberately enumerated rather than a catch-all, so an unknown
    // path stays the API's JSON 404 (a client library must not be handed an HTML page).
    for (const p of ["/", "/lobby", "/lobby/", "/weave/:id", "/weave/:id/", "/w/:secret", "/w/:secret/"]) {
      app.get(p, (c) => c.html(indexHtml));
    }
```
  and line 33 of `src/server/src/main.ts`:
```ts
  console.log(webDist ? `serving web UI from ${webDist}` : "web UI not built; the web pages are disabled");
```
- [ ] **Step 4: GREEN** — `pnpm --filter @loom/core build && pnpm --filter @loom/client build && cd src/server && npx vitest run test/static.test.ts && npx vitest run`.
- [ ] **Step 5: Commit** — `feat(server): serve the web UI at /, /lobby and /weave/<id>`

---

### Task 6: Join the Lobby

Spec §4.1, plus the durable/in-place branch of §3.1. **Moved ahead of the router** (it was Task 8):
the router's unjoined-Lobby fork renders this form, so it has to exist first. The form takes
everything it needs as props, so it is testable long before either page it appears on.

**Files:** Create `src/web/src/name.ts`, `src/web/src/components/main/JoinLobbyForm.tsx`; Modify `src/web/src/components/NamePrompt.tsx` (line 3), `src/web/tsconfig.test.json` (widen `include` to `["src/**/*.ts", "src/**/*.tsx", "test", "../server/test/helpers.ts", "../core/test/helpers.ts"]` so new sources and `.tsx` tests typecheck); Test `src/web/test/main-page.test.tsx` (new, first line `// @vitest-environment happy-dom`).

**Interfaces:**

Consumes: `KeyValueStorage` (Task 1); `PersistenceNotice` (Task 2); `setIdentity(storage, weaveId, who, extra?)`, `readWeaveEntry`, `hasIdentity` (Task 3).

Produces:
```ts
// src/web/src/name.ts
export const NAME_RE: RegExp;                       // /^[A-Za-z0-9_.-]{1,32}$/
export function isValidName(name: string): boolean;
/** `dana` → `dana-2`, `dana-2` → `dana-3`; never longer than 32 characters. */
export function suggestName(taken: string): string;

// src/web/src/components/main/JoinLobbyForm.tsx
/**
 * The one Join-the-Lobby form. Rendered by the main page and by the router's unjoined-Lobby fork,
 * so every way into the Lobby runs the same persistence branch.
 */
export function JoinLobbyForm(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  lobby: { weaveId: string; title: string };
  /** Called when the credential persisted: the caller may safely leave this JS context. */
  onJoined: (weaveId: string) => void;
  /** Called when it did not: the caller must render the Lobby here, without navigating. */
  onJoinedInPlace: (weaveId: string) => void;
}): JSX.Element;
```

**No `WeavesSignal` here, deliberately.** Both callbacks replace the page this form is on: on the
main page `onJoined` navigates to `/lobby` and `onJoinedInPlace` switches the route to the Lobby, so
`MainPage` — and with it My Weaves — unmounts either way; on the router's unjoined-Lobby fork (Task
7) My Weaves is not mounted at all. A join therefore never changes a list that stays on screen, and
a `weaves` prop here would be a prop nothing reads. The **creation** form is the opposite case (§4.5
does not navigate), which is why Task 10 does take one.

- [ ] **Step 1: Failing tests** in `main-page.test.tsx`. Build the injected client with a stubbed `fetch` (`new LoomClient({ baseUrl: "http://loom.test", allowInsecure: true, fetch: stub })`) so every case is a table of URL → response, and pass `onJoined`/`onJoinedInPlace` as `vi.fn()` spies — the form never touches `location`.
  - The form renders whatever the caller mounts it with; deciding *whether* to mount it is `hasIdentity`'s job at the two call sites, and the form asserts nothing about it.
  - Name validation at the boundaries: `a` valid, 32 chars valid, 33 chars invalid, `"a b"` invalid, `"a@b"` invalid; submit disabled while invalid.
  - The request body is `{ name, kind: "human" }` — `kind` is not a field on the form.
  - `name_taken` (409) renders the two-case message, keeps the typed name in the field, and offers a suggestion button whose click fills the field with `dana-2` **without** submitting (the stub `fetch` was called exactly once).
  - `validation` (400) renders the server's message verbatim; `weave_not_found` (404) renders "This instance has no Lobby yet."; a rejected fetch renders "Could not reach the server." and keeps the typed name.
  - A **durable** join calls `onJoined(lobbyWeaveId)` and not `onJoinedInPlace`, and the entry holds `token`, `participantId` and `title`.
  - A **non-durable** join (`localStorage.setItem` throwing, over a real `browserStorage()`) calls `onJoinedInPlace` and **not** `onJoined`, `notice.degraded()` is true, and the entry is still readable through that storage instance.
  - `suggestName` unit table: `dana` → `dana-2`; `dana-2` → `dana-3`; a 32-character name → a suggestion still ≤ 32 characters.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** `name.ts` holds the one copy of core's rule (`src/core/src/names.ts` `NAME_RE`), and `NamePrompt.tsx` line 3 imports it instead of declaring its own. The submit handler:
```ts
    const j = await client.joinLobby({ name, kind: "human" });
    // One write, before anything that could destroy this JS context, and its verdict decides
    // whether leaving is safe at all (spec §3.1).
    const result = setIdentity(storage, j.weaveId, { token: j.token, participantId: j.participant.id },
      { title: j.weave.title, lastOpenedAt: new Date().toISOString() });
    notice.note(result);
    (result === "durable" ? onJoined : onJoinedInPlace)(j.weaveId);
```
  The `name_taken` block renders the message from the spec verbatim and a suggestion button wired to `suggestName(name)`.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): the Join-the-Lobby form, with the name rule shared with NamePrompt`

---

### Task 7: Router, `WeaveView`, and the unjoined-Lobby fork

Spec §2.7, §3.1, §3.3. (Was Task 6; it now consumes Task 6's form.)

**Files:** Modify `src/web/src/app.tsx` (whole file); Create `src/web/src/components/WeaveView.tsx`; Test `src/web/test/components.test.tsx` (modify), `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `SessionTarget`, `SessionState`, `Session`, `useSession` (Task 4); `AppDeps`, `PersistenceNotice`, `WeavesSignal` (Task 2); `JoinLobbyForm` with its `onJoined`/`onJoinedInPlace` contract (Task 6); `readWeaveEntry`, `hasIdentity` (Task 3).

Produces:
```ts
// app.tsx
export type Route =
  | { kind: "main" } | { kind: "lobby" }
  | { kind: "weave"; weaveId: string } | { kind: "secret"; secret: string } | { kind: "unknown" };
export function routeOf(pathname: string): Route;
export function App(deps: AppDeps): JSX.Element;

// components/WeaveView.tsx
export function WeaveView(props: {
  session: Session; state: SessionState;
  /** Rendered above the Weave: the persistence bar, and nothing else today. */
  banner?: JSX.Element | null;
  /** Rendered instead of the generic explanation when `status` is `"no-credential"`. */
  noCredential?: JSX.Element | null;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests.** In `components.test.tsx`:
  - `routeOf` table: `/` → main; `/lobby` and `/lobby/` → lobby; `/weave/<uuid>` and `/weave/<uuid>/` → weave with the id; `/w/<43 chars>` → secret; `/weave/nope`, `/x` → unknown.
  - `WeaveView` with `status: "no-credential"` and no `noCredential` prop renders the generic explanation and a link to `/`, and no composer.
  - `WeaveView` with `status: "no-credential"` and a `noCredential` element renders **that** instead.
  - `WeaveView` with `readOnlyReason: "secret-fallback"` renders the "your identity in this Weave is no longer valid" line and a **Join** button, and no composer until a join.
  - `WeaveView` with `status: "ready"` and a normal `me` is unchanged (the existing Weave-page assertions keep passing).

  In `main-page.test.tsx`, over a stubbed client whose `GET /api/lobby` answers `{ weaveId: LOBBY, title: "Lobby" }` and whose `GET /api/weaves/<LOBBY>` answers a real-shaped `WeaveInfo`:
  - **`/lobby` with no credential** renders the Join-the-Lobby form, not the generic explanation.
  - **`/weave/<LOBBY>` with no credential** renders the same form — a direct link carries no discovery of its own, so this branch resolves `getLobby()` itself.
  - **`/weave/<otherId>` with no credential** renders the generic explanation, and `getLobby()` answered without matching.
  - **A durable join from `/lobby`** leaves a loaded, writable Lobby session: `status: "ready"`, `state.me` set.
  - **A non-durable join from `/lobby`** (`setItem` throwing) leaves the same loaded, writable session **in place**: `state.me` is set, `location.pathname` is unchanged and `history.pushState` was never called (spy on it). The `state.me` half is the point — "no navigation was attempted" would pass against a credential-less page.
  - The same two cases from `/weave/<LOBBY>`.
  - `getLobby()` rejecting with `weave_not_found` on `/lobby` renders "This instance has no Lobby yet."; rejecting otherwise renders the error card.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/components.test.tsx test/main-page.test.tsx`.
- [ ] **Step 3: Implement `WeaveView`.** Move today's `Weave` function (app.tsx lines 25–100) into `components/WeaveView.tsx` as `WeaveView({ session, state, banner, noCredential })` — the body is unchanged except that it no longer calls `useSession`, it renders `{banner}` first, and it gains two branches before the existing `status` checks:
```tsx
  if (state.status === "no-credential") return noCredential ?? <NoCredential state={state} />;
```
  and, inside the layout, above `<MessageList/>`:
```tsx
  {state.readOnlyReason === "secret-fallback" && (
    <div class="banner">
      Your identity in this Weave is no longer valid — you are reading with the Weave link.{" "}
      <button onClick={() => setAskName(true)}>Join</button>
    </div>
  )}
```
  (`askName` is local state that renders the existing `<NamePrompt/>`; keep the existing `pending`/`needsName` logic as it is).
- [ ] **Step 4: Implement the router.**
```tsx
const SECRET_RE = /^\/w\/([A-Za-z0-9_-]{43})\/?$/;
const WEAVE_RE = /^\/weave\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function routeOf(pathname: string): Route {
  if (pathname === "/") return { kind: "main" };
  if (pathname === "/lobby" || pathname === "/lobby/") return { kind: "lobby" };
  const w = WEAVE_RE.exec(pathname);
  if (w) return { kind: "weave", weaveId: w[1]! };
  const s = SECRET_RE.exec(pathname);
  if (s) return { kind: "secret", secret: s[1]! };
  return { kind: "unknown" };
}

export function App({ client, storage, notice, weaves }: AppDeps) {
  // The route is state, not just a parsed path: a join or a creation whose credential could not be
  // persisted switches the view here, in this JS context, rather than navigating away from the only
  // copy of that credential (spec §3.1). The URL is deliberately left alone — a pushed /lobby would
  // be an address this browser cannot honour after a reload.
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
  const openInPlace = (weaveId: string) => setRoute({ kind: "weave", weaveId });
  const deps = { client, storage, notice, openInPlace };
  switch (route.kind) {
    // `weaves` goes to the main page only: it is the one place a list of stored Weaves stays on
    // screen while something writes to storage. A Weave page never renders one.
    case "main":   return <MainPage {...deps} weaves={weaves} />;
    case "lobby":  return <WeaveRoute {...deps} lobbyRoute />;
    case "weave":  return <WeaveRoute {...deps} target={{ kind: "id", weaveId: route.weaveId }} />;
    case "secret": return <WeaveRoute {...deps} target={{ kind: "secret", secret: route.secret }} />;
    default:       return <div class="center"><h1>Loom</h1><p>No such page. <a href="/">Go to the main page</a>.</p></div>;
  }
}
```
  `WeaveRoute` is the one place a Weave page is mounted, and it owns the Lobby fork:
  - With `lobbyRoute`, it resolves `client.getLobby()` first and renders `Loading…` meanwhile; `weave_not_found` → "This instance has no Lobby yet." with a link to `/`; any other failure → the error card. Then it mounts `useSession({ kind: "id", weaveId }, { client, storage, onWrite: notice.note })`.
  - With a `target`, it mounts the session straight away.
  - **The fork (spec §3.3).** When the session reports `status: "no-credential"` the page must know whether this id *is* the Lobby, because joining the Lobby needs no secret and every other Weave does. The `lobbyRoute` path already knows. The `/weave/<id>` path resolves `client.getLobby()` **on that branch only** — a page that loaded fine never makes the call — and when the ids match it passes:
```tsx
      noCredential={
        <JoinLobbyForm client={client} storage={storage} notice={notice}
          lobby={{ weaveId, title }}
          onJoined={() => setReloadKey((n) => n + 1)}
          onJoinedInPlace={() => setReloadKey((n) => n + 1)} />
      }
```
    and `undefined` (the generic explanation) when they do not.
  - Both callbacks stay in this JS context: `reloadKey` is part of `useSession`'s memo key, so the session is rebuilt over the **same** storage instance and picks up the identity just written. A durable join could reload the page instead, but there is no reason to — the session it would rebuild is the one it already has, and one code path is easier to be sure of than two.
- [ ] **Step 5: Stub the rest.** `MainPage` and `PersistenceBar` arrive in Task 8; until then stub them as one-line components rendering their heading, so this task compiles and its tests run. The `MainPage` stub already takes `weaves: WeavesSignal` in its props type (Task 8 gives it the exact signature), so the prop is typed from the moment it is passed.
- [ ] **Step 6: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 7: Commit** — `feat(web): route /, /lobby and /weave/<id>, and offer the join form on an unjoined Lobby`

---

### Task 8: The main page shell, the persistence notice, guidelines and the Lobby summary

Spec §4 intro, §4.3, §4.4, §6 (the notice). (Was Task 7.)

**Files:** Create `src/web/src/components/main/MainPage.tsx`, `InstanceGuidelines.tsx`, `LobbySummary.tsx`, `src/web/src/components/PersistenceBar.tsx`; Modify `src/web/src/styles.css`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `AppDeps`, `PersistenceNotice`, `WeavesSignal` (Task 2); `storedWeaves`, `readWeaveEntry`, `hasIdentity`, `migrateLegacy(storage, notice, lookup, onChanged?)` (Task 3); `JoinLobbyForm` (Task 6); `openInPlace` (Task 7).

Produces:
```ts
export function MainPage(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
  openInPlace: (weaveId: string) => void;
}): JSX.Element;
export function PersistenceBar(props: { notice: PersistenceNotice }): JSX.Element | null;
export function InstanceGuidelines(props: { client: LoomClient }): JSX.Element | null;
export function LobbySummary(props: {
  client: LoomClient; storage: KeyValueStorage;
  lobby?: { weaveId: string; title: string }; error?: string;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests** (extend `main-page.test.tsx`):
  - The four cells render independently: a `GET /api/guidelines` that rejects leaves the Lobby summary and the rest on screen.
  - `InstanceGuidelines` renders Markdown through `markdown.ts`, collapses past 12 lines behind a "Show all" control, and renders **nothing** for empty text.
  - `LobbySummary` with no usable Lobby identity shows the title and the one-line explanation and makes **no** `getWeave`/`listRequests` call.
  - `LobbySummary` with one shows the participant count, the listener count (participants whose `capabilities` is non-null) and the open-request count, read with the stored token.
  - `getLobby()` answering `weave_not_found` renders "This instance has no Lobby yet" and no join affordance.
  - `PersistenceBar` renders nothing while `notice.degraded()` is false, renders once after a `note("memory")`, does **not** render a second bar after a second `note("memory")`, disappears on dismiss, and its text names neither "quota" nor "localStorage".
  - `MainPage` runs `migrateLegacy` once on mount with `lookup = (s) => client.lookupWeave(s)` and `onChanged = () => weaves.bump()`: with a stub `lookup` that resolves after the first paint, the injected `weaves` spy records a `bump()` it did not have at mount.
  - `MainPage` starts migration **once per page load, not once per render**: a `weaves.bump()` and a resolving guidelines cell both re-render it, and the `lookup` spy is still called once per legacy entry in total.
  - (`MainPage` passing `notice.note` as `MyWeaves`' `onWrite` and the **same** `weaves` object to `MyWeaves` and `CreateWeaveForm` is asserted where those components are real: Task 9's "an invalidation that cannot persist raises this page's one bar" and Task 10's "the created Weave appears in the list". Here it is the typecheck on the stubs' props — not a test against a stub, which would only prove the stub.)
  - `MainPage` shows `JoinLobbyForm` when there is no usable Lobby identity and **Open the Lobby** (a link to `/lobby`, naming the participant) when there is; an entry marked `identity: "invalid"` shows the form, with a line saying the previous identity stopped working.
  - A non-durable join from the main page calls `openInPlace` and does not navigate.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** `MainPage` owns four independent async cells, each `loading → value | error`, and renders in order: `<PersistenceBar/>`, the instance title and `<InstanceGuidelines/>`, `<LobbySummary/>` + `<JoinLobbyForm/>` (or **Open the Lobby**), `<MyWeaves/>` (Task 9) and `<CreateWeaveForm/>` (Task 10) — stub those two as headings so this task is green on its own, with the props they will take in Tasks 9 and 10 already declared and passed:

```tsx
  <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={notice.note} lobbyWeaveId={lobby?.weaveId} />
  <CreateWeaveForm client={client} storage={storage} notice={notice} weaves={weaves}
                   defaultName={joinedAs} openInPlace={openInPlace} navigate={navigate} />
```

  (`navigate = (path: string) => { location.href = path; }`, the one full-page-load helper this component owns; `joinedAs` is the Lobby entry's participant name when there is a usable Lobby identity, else `undefined`.) `notice.note` is the only `onWrite` anywhere (Global Constraints), so every failed write on this page — join, creation, migration, or a row refresh — reaches the one bar this component renders.

  Migration is started here, once per page load, and says so as it goes:

```tsx
  // Once per page load, not once per render: a bump re-renders My Weaves and can re-render this
  // component, and a second pass would re-walk keys the first is still writing. `onChanged` is what
  // turns a legacy row on screen into a resolved one without the human doing anything (spec §4.2).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void migrateLegacy(storage, notice, (s) => client.lookupWeave(s), () => weaves.bump());
  }, []);
```

  The join form's callbacks here are `onJoined={() => navigate("/lobby")}` and `onJoinedInPlace={openInPlace}` — both leave this page, which is why the join form takes no `weaves` (Task 6). The notice bar's wording: *"This browser is not saving anything for this site, so Weaves you join or create here will be gone when you close the tab. Copy any Weave link you want to keep, or allow this site to store data."* `PersistenceBar` subscribes to the notice with `useEffect` and a `useState` counter.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): the main page shell with instance guidelines, the Lobby summary and the persistence notice`

---


### Task 9: My Weaves

Spec §4.2.

**Files:** Create `src/web/src/components/main/MyWeaves.tsx`; Modify `src/web/src/components/main/MainPage.tsx`, `src/web/src/styles.css`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `KeyValueStorage`, `WriteResult` (Task 1); `WeavesSignal` (Task 2); `StoredWeave`, `WeaveEntry`, `storedWeaves`, `readWeaveEntry`, `forgetWeave`, `saveWeaveEntry`, `invalidateIdentity`, `hasIdentity`, `readerFor`, `ReaderChoice`, `isCredentialFailure` (Task 3).

Produces:
```ts
export type WeaveRow = {
  weaveId?: string; secret?: string; title: string;
  state: "joined" | "read-only" | "identity-invalid" | "unavailable";
  joinedAs?: string; isLobby: boolean; archived: boolean; lastOpenedAt?: string;
  /** What the stored entry alone already says (e.g. an unresolved legacy row's unknown title). The
   *  refresh's own markers live in component state keyed by `rowKey`, because they are not in
   *  storage and must survive a re-derive; a row renders `notes[rowKey(row)] ?? row.note`. */
  note?: string;
};
/** Folds a legacy entry into an id entry when their `secret` matches, else when their `token` does. */
export function foldRows(stored: StoredWeave[], lobbyWeaveId?: string): WeaveRow[];
/** A row's identity across a re-derive: its Weave id, or its secret while it is still unresolved. */
export function rowKey(row: WeaveRow): string;
export function MyWeaves(props: {
  client: LoomClient; storage: KeyValueStorage; weaves: WeavesSignal;
  /** Every write this list makes reports its verdict here. Always `notice.note` (Task 8). */
  onWrite: (r: WriteResult) => void;
  lobbyWeaveId?: string;
}): JSX.Element;
```

A row is refreshed with **`readerFor`** (Task 3) — the same credential choice the session makes — and
never with an assumed token: the list deliberately holds rows for Weaves this browser has read but
not joined, and rows whose identity has been invalidated, and both of those have no token at all.

Two rules this component exists to honour, both from spec §4.2:

- **It follows storage.** Rows are re-derived from `foldRows(storedWeaves(storage), lobbyWeaveId)` on
  every `weaves.bump()`, never captured once at mount. Everything that writes an entry while this
  list is on screen bumps: `migrateLegacy` (Task 8), this component's own refresh, its invalidation,
  its `Forget`, and `CreateWeaveForm` (Task 10). The subscription is torn down on unmount.
- **It reports its writes.** `saveWeaveEntry` and `invalidateIdentity` here both hand their
  `WriteResult` to `onWrite`. `Forget` does not, and cannot: `forgetWeave` calls `remove`, which
  returns `void`. That is safe rather than an oversight — §2.4b makes a removal that did not reach
  `localStorage` read as absent for the rest of the page (the tombstone) and drop out of `keys()`, so
  the row goes and stays gone; the whole cost of a failed removal is that the entry is back after a
  reload, and no credential was created that could be lost.

- [ ] **Step 1: Failing tests:**
  - The list renders from storage **with no fetch at all** (the stub `fetch` is not called during the first paint).
  - Ordering by `lastOpenedAt` descending, ties by title.
  - `foldRows` folds a legacy and an id entry sharing a `secret` into one row, and one sharing only a `token` into one row; the id entry wins.
  - Each row state of §4.2 renders its own text: usable identity → "joined as `dana`"; `secret` and no identity → "read-only — not joined"; `identity: "invalid"` with a secret → "your identity here stopped working — open to rejoin"; `identity: "invalid"` with no secret → greyed, not a link, with **Forget**; a 404 refresh → "this Weave is gone" with **Forget**; a network failure → the cached title with a quiet marker and still a link.
  - **Forget** removes the entry and the row; nothing else removes a row.
  - **Copy link** appears only where the entry carries a `secret`, and the row links to `/weave/<id>` — never to `/w/<secret>`.
  - The Lobby row carries a Lobby badge; an archived row an archived badge.
  - The refresh is bounded: with 30 rendered rows, at most 6 `getWeave` calls are in flight at once (count concurrent stub invocations), and rows behind "Show more" are not fetched at all.
  - The filter box appears only past 8 rows and narrows by title, case-insensitively.
  - **A `secret`-only row refreshes through its secret**: the entry has a `secret` and no identity, and the `getWeave` call carries the **secret** as its bearer; the row's cached `title` is updated from the answer.
  - **An `identity: "invalid"` row with a secret refreshes through the secret**, the same way.
  - **A token read answering `401`** invalidates the stored identity: afterwards the entry has no `token`/`participantId`, reads `identity: "invalid"`, still holds its `secret`, and the row has moved to the "your identity here stopped working" state. Then the refresh **retries once with the secret** and the title is updated from that answer.
  - **A token read answering `401` with no stored secret**: the entry is invalidated, the row shows the unavailable state with **Forget**, and no retry is made.
  - **A row with neither a usable identity nor a secret is not fetched at all** (the stub records no call for its id).

  Then the change-signal group. Each of these mounts `MyWeaves` with an injected `createWeavesSignal()` and asserts the screen changed **with no user action** — no click, no re-mount, just the bump the writer makes:
  - **A migration that finishes after the first paint resolves its row.** Seed one legacy entry only; mount; assert the row renders unresolved (the "title unknown" legacy row). Then run `migrateLegacy(storage, notice, lookup, () => weaves.bump())` with a `lookup` that resolves on a later tick, and assert the row is now the id row for that Weave (its cached title, a link to `/weave/<id>`). This is the regression test for the gap: without the signal the row stays unresolved until a reload.
  - **A refresh result appears by itself**: a `getWeave` stub answering a **new** title and `archivedAt` set → after the refresh settles, the row shows the new title and the archived badge, with nothing clicked.
  - **An invalidation from a 401 changes the row by itself**: a token row whose `getWeave` answers `401` → the row moves to "your identity here stopped working", again with nothing clicked.
  - **Forget still removes the row** (it bumps like every other writer), and removes the entry.
  - **A bump does not re-fetch a row already refreshed**: let the first pass settle (N stub calls), then `weaves.bump()` and flush — the stub call count is **unchanged**. The rendered slice is re-derived, but rows already fetched are remembered by key.
  - **A bump during an in-flight refresh does not duplicate it**: with a `getWeave` that never settles for one row, bump twice, then resolve — exactly one call was made for that row.
  - **Unmount unsubscribes**: wrap the signal so `subscribe` records the teardown it returns; after `unmount()` that teardown has been called and a later `bump()` reaches no listener.

  Then the reported-writes group, mounting `MyWeaves` with `onWrite={notice.note}` beside a `<PersistenceBar notice={notice}/>` (Task 8), over a real `browserStorage()` on the fake `localStorage` of Task 1:
  - **An invalidation that cannot persist is not silent**: `setItem` throws for that entry's key, a token read answers `401` → the row shows the invalid-identity state (the override layer of §2.4b keeps it true for this page), `notice.degraded()` is `true`, and **one** persistence bar is on screen. Without `onWrite` here the page would say "invalid" while `localStorage` still held the old token, and say nothing about it.
  - **A title write that cannot persist raises the same one notice**, and the row still shows the **new** title.
  - **With durable writes the notice stays quiet**: the same refresh over a working store leaves `notice.degraded()` false and renders no bar.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** Rows are **derived on every render**, never captured: the component subscribes to the signal, and a bump re-runs the derivation against storage.

```ts
export function MyWeaves({ client, storage, weaves, onWrite, lobbyWeaveId }: {
  client: LoomClient; storage: KeyValueStorage; weaves: WeavesSignal;
  onWrite: (r: WriteResult) => void; lobbyWeaveId?: string;
}) {
  // Anything that writes an entry bumps the signal; this is the one place that listens. Storage
  // itself stays a plain KeyValueStorage (spec §4.2) — the session and every test inject it.
  const [version, setVersion] = useState(0);
  useEffect(() => weaves.subscribe(() => setVersion((n) => n + 1)), [weaves]);   // unmount unsubscribes
  const rows = useMemo(() => foldRows(storedWeaves(storage), lobbyWeaveId), [storage, lobbyWeaveId, version]);
  // Per-row facts that are *not* in storage: "could not refresh", "this Weave is gone". Keyed by the
  // row, so a re-derive after a bump does not lose them and does not mix them up.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const markRow = (row: WeaveRow, e: unknown) =>
    setNotes((n) => ({ ...n, [rowKey(row)]:
      e instanceof LoomClientError && e.code === "weave_not_found" ? "this Weave is gone" : "could not refresh" }));
  // Below, in this order: the sort, the filter box, the slice (`visible`), the refresh effect, the
  // row list, and the Copy link / Forget actions — all of them reading `rows`, `notes` and `visible`.
}

/** A row's identity across a re-derive. An unresolved legacy row has no id yet, only its secret. */
export function rowKey(row: WeaveRow): string {
  return row.weaveId ?? `legacy:${row.secret ?? ""}`;
}
```

  Sorting, the filter box and the slice to 25 with "Show more" are unchanged by any of this and run over `rows`; their result is `visible` — the rows this render actually puts on screen, in order. Refresh is a `useEffect` over that **rendered slice** — the rendered rows are the definition of "on screen", not an `IntersectionObserver` — through a pool of 6, with its own memory of which rows it has already fetched:

```ts
/** At most `n` refreshes in flight, taken in the order the slice renders them. */
async function pool<T>(n: number, items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await run(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Which rows have been fetched (or are in flight) this page, by row key rather than by position —
// a bump re-derives the whole list, and this must survive that. A ref, not state: changing it must
// not itself cause a render.
const fetched = useRef(new Set<string>());
useEffect(() => {
  // Runs on every render, which is cheap and correct: `pending` is empty unless a row entered the
  // slice ("Show more", a filter cleared, or a legacy row that migration has just resolved into a
  // row with an id — which is a new key and genuinely does want one fetch).
  const pending = visible.filter((r) => !fetched.current.has(rowKey(r)));
  if (pending.length === 0) return;
  for (const r of pending) fetched.current.add(rowKey(r));   // claimed *before* awaiting, so a bump
  void pool(6, pending, refreshRow);                          // mid-flight cannot start a second one
}, [visible]);
```

  Each row picks its credential exactly as the session does, and every write it makes reports its verdict:

```ts
/** One row's refresh. `readerFor` is the shared rule, so a row is never read with a credential the
 *  page itself would not have used — most rows have a token, but an unjoined or invalidated one
 *  has only a secret, and a `withToken(undefined)` call would simply 401. */
const refreshRow = async (row: WeaveRow): Promise<void> => {
  if (!row.weaveId) return;
  const choice = readerFor(client, readWeaveEntry(storage, row.weaveId));
  if (!choice) return;                                   // nothing to read with: keep the cache as it is
  try {
    const info = await choice.reader.getWeave(row.weaveId);
    // The verdict goes to the notice like every other write on this page: a title that reached only
    // memory is the same degraded browser a join or a creation would have found (spec §4.2, §6).
    onWrite(saveWeaveEntry(storage, row.weaveId, { title: info.weave.title, archived: !!info.weave.archivedAt }));
    weaves.bump();                                       // the stored row changed: re-derive the list
  } catch (e) {
    if (choice.withToken && isCredentialFailure(e)) {
      // Exactly what the session does (spec §2.6): the identity goes, the secret stays, and a
      // stored secret gets one more try — so a dead token costs a row its identity, not its title.
      // Reported, and never silent: an invalidation that reached only memory leaves this page saying
      // the identity is dead while `localStorage` still holds the old token, which the human is told
      // about once. The bump is immediate, so the row changes state before the retry even starts.
      onWrite(invalidateIdentity(storage, row.weaveId));
      weaves.bump();
      const again = readerFor(client, readWeaveEntry(storage, row.weaveId));
      if (again) return await refreshRow(row);
    }
    markRow(row, e);                                     // 404 → "this Weave is gone"; otherwise the quiet marker
  }
};
```
  `isCredentialFailure` is the same two-code test the session uses (`invalid_token`, `forbidden`); export it from `weaves-store.ts` beside `readerFor` so there is one copy. The recursion is bounded: the retry only happens when `choice.withToken` was true, and after `invalidateIdentity` it never can be again — and it does **not** go back through the effect, so `fetched` is untouched by it. Nothing is deleted anywhere in this path.

  `Forget` is the last writer: `forgetWeave(storage, weaveId); weaves.bump();` — and nothing is reported, because `remove` returns no verdict and a removal that did not reach `localStorage` still reads as absent for this page (§2.4b's tombstone). Say so in a comment where it is called, so the asymmetry with the two `onWrite` calls above reads as a decision rather than an omission.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): My Weaves — every Weave this browser holds, rendered from cache`

---

### Task 10: Create a Weave

Spec §4.5.

**Files:** Create `src/web/src/components/main/CreateWeaveForm.tsx`; Modify `src/web/src/components/main/MainPage.tsx`, `src/web/src/styles.css`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `NAME_RE`, `isValidName` (Task 6); `setIdentity(storage, weaveId, who, extra?)`, `readWeaveEntry` (Task 3); `PersistenceNotice`, `WeavesSignal` (Task 2); `openInPlace` (Task 7).

Produces:
```ts
export function CreateWeaveForm(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
  /** Prefills the name field when this browser already has a Lobby identity. */
  defaultName?: string;
  openInPlace: (weaveId: string) => void;
  navigate: (path: string) => void;
}): JSX.Element;
```

**This form does take a `WeavesSignal`, unlike the join form.** §4.5 deliberately does **not**
navigate on success — the save-this-link panel replaces the form and the main page stays on screen,
My Weaves included — so the Weave that was just created has to appear in that list without a reload.

- [ ] **Step 1: Failing tests:**
  - Fields: `title` (1–200, submit disabled outside), `your name` (the shared `NAME_RE`, prefilled from `defaultName`), an optional opener, guidelines behind a "more" disclosure; the request body carries `kind: "human"`.
  - A `403 forbidden` renders "This instance only lets keepers create Weaves." in place of the form.
  - A `201` renders the save-this-link panel: the full `/w/<secret>` URL, a **Copy** control, the warning naming that the link cannot be rotated or revoked, and **Open the Weave**.
  - **The entry is written before the panel appears**: at the moment the panel is first rendered, `readWeaveEntry(storage, id)` already holds `token`, `participantId`, `secret` and `title` (assert inside the render assertion, not after a tick).
  - **Open the Weave** points at `/weave/<id>` (durable case) — never `/w/<secret>`.
  - **The whole entry is one write**: a counting storage double records exactly **one** `set` call for the created Weave, and the value it received already contains `token`, `participantId`, `secret`, `title` and `lastOpenedAt`.
  - **A size-threshold store** — `setItem` accepts values under N characters and throws above, so a bare identity would persist while the full entry does not — yields the **hardened** panel: the dismiss control is disabled until the link is copied or acknowledged, and **Open the Weave** calls `openInPlace`, not `navigate`. This is the case that a two-write version passes wrongly, by branching on the small write's verdict.
  - **Blocked storage on create**: with `setItem` always throwing, the same hardened panel, and **Open the Weave** yields a Weave where this browser **is the keeper** (`state.me.participant.role === "keeper"`).
  - **All-durable**: the ordinary panel, dismissable, and **Open the Weave** calls `navigate("/weave/<id>")`.
  - **The new Weave appears in My Weaves without a reload**: mount `CreateWeaveForm` and `MyWeaves` over the **same** storage and the same `createWeavesSignal()`, create, and assert the new title is in the list once the panel renders — the page does not navigate here, so the bump is the only thing that puts it there.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** One write, and the panel branches on **its** verdict:
```ts
    const r = await client.createWeave({ title, opener, creator: { name, kind: "human" }, guidelines });
    // The complete entry in a single `set`. Two writes would let the identity persist while the
    // secret beside it did not — near a quota limit the small one fits and the large one does not —
    // and the panel would then branch on the verdict of the write that was never at risk. The
    // secret is the part that cannot be recovered, so it is the part the verdict must cover.
    const result = setIdentity(storage, r.weave.id, { token: r.token, participantId: r.participant.id },
      { secret: r.secret, title: r.weave.title, lastOpenedAt: new Date().toISOString() });
    notice.note(result);
    // The panel keeps this page on screen (§4.5), so the list beside it has to learn about the new
    // entry: the one signal, bumped like every other writer that changes what My Weaves shows.
    weaves.bump();
    setCreated({ weave: r.weave, secret: r.secret, durable: result === "durable" });
```
  `durable` chooses the warning text, whether the dismiss control is enabled, and whether **Open the Weave** calls `navigate(\`/weave/${id}\`)` or `openInPlace(id)`. A fresh Weave id cannot already carry an `identity: "invalid"` marker, so `setIdentity`'s clearing of it is a no-op here — it is used for the single-write guarantee, not for the marker.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): create a Weave from the main page, with the save-this-link moment`

---

### Task 11: Docs and totals

Spec §8.

**Files:** Modify `docs/ARCHITECTURE.md` (§9), `docs/SECURITY.md` (§8, §9.9, §4a/§9), `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `README.md`, `docs/superpowers/specs/v2-notes.md`.

- [ ] **ARCHITECTURE §9**: the route table (`/`, `/lobby`, `/weave/<id>`, `/w/<secret>`); the `target` union and where the read credential comes from (stored token, else stored secret); the `loom:weave:<weaveId>` key and the entry's fields; `WriteResult` **and** the read-precedence rule; the one storage instance created in `main.tsx` and passed to `App`/`useSession`, and the one change signal beside it that every entry writer bumps and My Weaves subscribes to (the store itself is not observable); "no router" becomes "no router library — path matching in `app.tsx`, with one in-place switch when a credential did not persist"; rewrite the existing "degrades to memory when storage throws" sentence so the degradation reads as observable rather than silent.
- [ ] **SECURITY §8**: new key shape; an entry may carry a Weave secret; a secret outlives an invalidated identity; a token proven dead by a 401/403 is deleted. **§9.9**: narrow to `/w/<secret>` links, and note that token-loaded pages carry a uuid, which is not a credential. **§4a or §9**: a public landing page makes the public Lobby join discoverable, which sharpens §9.1 (no rate limiting).
- [ ] **TESTING.md**: the `web` and `server` coverage cells; a fifth manual smoke test — from a clean browser profile open `/`, join the Lobby by name, confirm the address bar never shows a secret, open a request from the Lobby page, create a Weave from `/`, copy the link, reopen `/` in a new tab and confirm My Weaves lists both; then repeat the join and the creation in a **private window with site data blocked** and confirm the notice appears, the page does not navigate, and the created Weave's link is still on screen.
- [ ] **KNOWN-ISSUES.md**: rewrite the `src/web/test` row to drop the "test tsconfig lists individual source files instead of a glob" half (Task 7 widened it) and keep the two untested branches; add any row the implementation actually leaves behind.
- [ ] **README.md**: opening the instance URL is the way in, beside `/w/<secret>`.
- [ ] **v2-notes.md**: mark the web-main-page idea **shipped**, in the shape the Lobby entry uses.
- [ ] Run `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`; put the **real** totals and the last code commit's hash into `docs/TESTING.md`.
- [ ] **Commit** — `docs: the web main page across architecture, security, testing and the README`

---

## Self-review against the spec

- **§2.1–2.3** (what the session does today, token sufficiency, the `target` union) → Task 4. The §2.2 claim that every read works with a participant token is proven by Task 4's "loads a Weave from a stored token" and "the Lobby board with a Lobby token" tests.
- **§2.4** interface, entry, coexistence/migration → Tasks 1 and 3; the **id entry is authoritative** merge rule is Task 3's `mergeLegacy`, used by both migration paths, and the `/w/<secret>` trigger is Task 4's `migrateLegacyOne`. **§2.4a** single instance → Task 2 (guard test) and Task 4 (`useSession` takes it). **§2.4b** precedence, tombstones, `keys()`, clear-on-next-success, no background retry, the three-valued `peek`, cross-tab → Task 1.
- **§2.5** `targets()` skipping entries with no usable identity → Task 4, Step 4.
- **§2.6** every table row, the rejoin self-heal, the three asymmetries → Task 4 (store tests) and Task 7 (`WeaveView` branches); the same rule applied to a list row → Task 9's `refreshRow`.
- **§2.7** convergence on one `<WeaveView/>` → Task 7.
- **§3.1** routes, full page loads, the one exception, the URL deliberately unchanged → Task 7; the durable/in-place branch at each call site → Tasks 6 (join), 8 (main page) and 10 (create). **§3.2** server paths, no catch-all, API-only → Task 5. **§3.3** the three-way fork → Task 4 (credential resolution, including the secret fallback) and Task 7 (the Lobby fork on both `/lobby` and `/weave/<lobbyId>`, the generic explanation otherwise).
- **§4.1** → Task 6 (the form) and Task 8 (where the main page puts it); **§4.2** → Task 9, including the two rules of the second review round: *the list follows storage* (the `WeavesSignal` of Task 2, bumped by Task 8's `migrateLegacy(… , onChanged)`, by Task 9's refresh, invalidation and Forget, and by Task 10's creation; subscribed and unsubscribed in `MyWeaves`) and *every write reports its verdict* (`onWrite` = `notice.note`, wired in Task 8, on both of Task 9's writes, with Forget's `remove` reporting nothing and §2.4b's tombstone being why that is safe). **§4.3**, **§4.4** → Task 8; **§4.5** → Task 10, one write, the panel branching on its verdict, and the bump that puts the new Weave in the list beside it.
- **§5** security: nothing new is written, so the review lands in docs → Task 11 (SECURITY §8, §9.9, §4a). The "a Weave title must go through JSX, never the Markdown renderer" rule is enforced by Task 9's row rendering and Task 8's guidelines-only use of `markdown.ts`.
- **§6** no new error code; `no-credential` + `readOnlyReason` → Task 4; four independent cells and the never-crashing degraded mode → Task 8; the one-time notice → Task 8 (`PersistenceBar`), latched by Task 2's `PersistenceNotice`, and fed by **every** write on the page: the join (Task 6), the creation (Task 10), migration (Task 8) and My Weaves' title write and invalidation (Task 9's `onWrite`).
- **§7 test by test**: one storage instance + `useSession` keeps it → Task 2. Durable-write result (6 cases) and read precedence (7 cases), plus the 3 inaccessible-storage cases → Task 1. Storage entry unit cases, the `mergeLegacy` and `readerFor` tables, the one-write `setIdentity` → Task 3. Migration (6 cases, including the conflicting duplicate and the invalid-marked entry) → Task 3. Store: token load, secret-vs-id equality, Lobby board, no entry, network failure, mutations, `needsName`, and the three bookmarked-`/w/<secret>` cases → Task 4. Invalid identity (7 cases incl. the two non-durable ones) → Task 4. DOM: name boundaries, `name_taken` + suggestion, the durable/non-durable join → Task 6; `routeOf`, the `WeaveView` branches, the unjoined Lobby on both routes, the blocked-storage join ending in a writable session → Task 7; the notice, the cells, the Lobby summary, Open-the-Lobby vs the form, migration started once with its `onChanged` → Task 8; the row states, the four refresh-credential cases, the seven change-signal cases (delayed migration, refresh result, invalidation, Forget, no re-fetch after a bump, no duplicate mid-flight, unmount unsubscribes) and the three reported-write cases → Task 9; create 403/201, the single write, the size-threshold and all-blocked panels → Task 10. Server (3 cases) → Task 5. Manual smoke → Task 11.
- **§8** docs list → Task 11, item for item.
- **§9** implementation order followed, with one deliberate change: the spec's step 8 (Join the Lobby) runs **before** the router, because §3.3's unjoined-Lobby fork renders that form and a task may not consume what no earlier task produced. Everything else is in the spec's order; 11 tasks plus Task 0 for the branch.
- **§10** assumptions: 9 (an entry written on a `/w/<secret>` load before any join) is Task 4 Step 3's `saveWeaveEntry` after a successful metadata read, with `migrateLegacyOne` before it for a browser that joined under the old key; 10 (nothing deleted automatically) is Task 9's Forget-only rule and the never-delete-a-secret rule in Tasks 3, 4 and 9; 12 (the instance is a prop, not a singleton) is Task 2; 13 (page-lifetime overrides, no cross-tab sync) is Task 1.
- **Type consistency**: `WriteResult` is the return of `set`, `saveWeaveEntry`, `setIdentity`, `invalidateIdentity` and `migrateLegacyOne`, and the parameter of `PersistenceNotice.note`, of the session's `onWrite` and of `MyWeaves`' `onWrite`, everywhere — and `notice.note` is the only function ever passed as an `onWrite`; `WeavesSignal` is `{ bump(): void; subscribe(fn: () => void): () => void }` in Task 2, in `AppDeps`, in `MainPage`, in `MyWeaves` and in `CreateWeaveForm`, and `migrateLegacy`'s fourth parameter is a plain `onChanged?: () => void` so `weaves-store.ts` stays free of it; `JoinLobbyForm` deliberately has no `weaves` prop (Task 6 says why); `setIdentity(storage, weaveId, who, extra?)` has that one signature in Tasks 3, 4, 6 and 10; `readerFor(client, entry)` and `isCredentialFailure(e)` are defined once in `weaves-store.ts` and consumed by the session (Task 4) and My Weaves (Task 9); `mergeLegacy` is the only merge rule, reached through `migrateLegacyOne` from both triggers; `WeaveEntry` is the stored shape and `StoredWeave` the listed one, never swapped; `SessionTarget` has the same two members in `createSession`, `useSession` and `app.tsx`; `hasIdentity(e)` is the single test for "usable identity"; `JoinLobbyForm`'s `onJoined`/`onJoinedInPlace` pair is the same contract in Tasks 6, 7 and 8. Placeholder scan: no "TBD", no "similar to Task N", no "add error handling"; every symbol a task consumes is produced by an earlier task's **Produces** block.
