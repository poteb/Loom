# Loom — Web Main Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web client a front door at `/` — join the Lobby by name without a secret, see the Weaves this browser holds, read the instance guidelines, create a Weave — backed by a session that can load a Weave from `(weaveId, participant token)` instead of from a secret.

**Architecture:** The web session gains a `target` union (`{ kind: "secret" }` or `{ kind: "id" }`) and picks its read credential from it — the secret when there is one, the stored participant token otherwise, the stored secret as a read-only fallback when an identity has been invalidated. Storage moves from `loom:<secret>` to `loom:weave:<weaveId>` through a lazy, never-destructive migration, and reports whether each write actually persisted, so a credential that reached only memory is never navigated away from. The server gains static routes and nothing else: no core rule and no route authorization changes.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Preact 10 + `@preact/preset-vite`, Vite 7, Hono, Vitest 4 (node environment for store/unit tests against a real server and Postgres, happy-dom via a `// @vitest-environment happy-dom` docblock for DOM tests), `@testing-library/preact` 3.

**Spec:** `docs/superpowers/specs/2026-09-17-loom-web-main-page-design.md` (read it whole before any task). Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`.

## Global Constraints

- **No core rule change and no route authorization change.** `src/core` is not touched at all. `src/server` gains static `index.html` routes and one boot log line — nothing else. Any task that finds itself editing a `core` rule or an auth check has misread the spec.
- **Storage key** `loom:weave:<weaveId>`; entry `{ token?, participantId?, identity?: "invalid", secret?, title?, archived?, lastOpenedAt? }`. `token`/`participantId` are the **identity**; `secret` is an **independent credential**; `title`/`archived` are a display cache; `lastOpenedAt` orders My Weaves.
- **`WriteResult = "durable" | "memory"`**, returned by `KeyValueStorage.set`. `browserStorage().set` attempts `localStorage.setItem` and then **verifies by reading back from `localStorage` itself**, never through `get` — `"durable"` when `localStorage.getItem(k) === v`, `"memory"` otherwise. `memoryStorage({ durable })` defaults to `"durable"`; `browserStorage`'s internal fallback is `memoryStorage({ durable: false })`.
- **One storage instance (§2.4a invariant):** `browserStorage()` is called exactly once in the whole web package, in `src/web/src/main.tsx`, and the instance is passed to `App` → the main-page forms, My Weaves/`storedWeaves()`, and `useSession`/`createSession`. `RequestsPanel` needs no plumbing: it reaches storage only through `session.targets()`. A guard test asserts `browserStorage(` appears exactly once in `src/web/src` outside `storage.ts`. Tests keep injecting `memoryStorage()`.
- **Read precedence (§2.4b):** a key whose last write or removal did not reach `localStorage` carries a pending override — the value, or a **tombstone** for a failed removal — and `get` answers from that override first (tombstone → `null`), ahead of `localStorage`; every other key keeps `localStorage` first, then the memory fallback. `keys()` = today's union **plus** override keys **minus** tombstoned keys. **Invariant: whatever verdict a write returns, the value it just wrote is what `get` returns for the rest of this page.** An override is cleared **only** by a later successful `set` or `remove` of that same key — no background retry, no timer, `get` stays side-effect-free. Overrides live for the page; a reload starts from `localStorage` alone. No cross-tab sync.
- **Legacy coexistence:** `loom:<secret>` entries stay readable forever. Migration is lazy (a `/w/<secret>` load, or the main page resolving them through the **public** `GET /api/weaves/:secret/lookup`), the id-keyed entry is written **first**, and the legacy key is removed **only** on a `"durable"` verdict. A `"memory"` verdict stops migration for the rest of the page. A failed lookup leaves the legacy entry alone. My Weaves folds a legacy and an id entry into one row when their `secret` matches, else when their `token` matches.
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
| `src/web/src/weaves-store.ts` (new) | `WeaveEntry`, `StoredWeave`, key helpers, `readWeaveEntry`, `saveWeaveEntry`, `setIdentity`, `invalidateIdentity`, `forgetWeave`, `hasIdentity`, `storedWeaves`, `migrateLegacy` — every rule about what is stored per Weave |
| `src/web/src/persistence.ts` (new) | `createPersistenceNotice()`: the page-scoped "a write did not persist" latch the notice bar and `migrateLegacy` both read |
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
```

- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/storage.test.ts`. Expect failures: `set` returns `undefined` (not `"durable"`), the silent-store case reports nothing, the failed-update case reads `"old"`.
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
  /** What `localStorage` holds, or `undefined` when it cannot be consulted at all. */
  const peek = (k: string): string | null | undefined => { try { return ls()?.getItem(k) ?? null; } catch { return undefined; } };
  return {
    get: (k) => {
      const o = overrides.get(k);
      if (o !== undefined) return o === TOMBSTONE ? null : o;
      const stored = peek(k);
      if (stored !== undefined && stored !== null) return stored;
      return fallback.get(k);
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

**Files:** Modify `src/web/src/main.tsx` (all 5 lines), `src/web/src/app.tsx` (lines 19–26: `App` takes props, `Weave` keeps its own signature for now), `src/web/src/useSession.ts` (all 18 lines); Create `src/web/src/persistence.ts`; Test `src/web/test/one-storage-instance.test.ts` (new).

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

// src/web/src/useSession.ts — `secret` becomes a `target` in Task 4; `deps` is final.
export function useSession(
  secret: string,
  deps: { client: LoomClient; storage: KeyValueStorage; onWrite?: (r: WriteResult) => void },
): { session: Session; state: SessionState };

// src/web/src/app.tsx
export type AppDeps = { client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice };
export function App(deps: AppDeps): JSX.Element;
```

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

- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/one-storage-instance.test.ts`. Expect `["useSession.ts"]` from the guard and a missing-module error for `persistence.js`.
- [ ] **Step 3: Implement `persistence.ts`:**

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

- [ ] **Step 4: Implement the composition root.** `src/web/src/main.tsx` becomes:

```tsx
import { render } from "preact";
import { LoomClient } from "@loom/client";
import { App } from "./app.js";
import { browserStorage } from "./storage.js";
import { createPersistenceNotice } from "./persistence.js";
import "./styles.css";

// The one storage instance in the package (spec §2.4a). Every session, form and list shares it, so
// a credential that could only be written to memory is still there after an in-place transition.
render(
  <App
    client={new LoomClient({ baseUrl: location.origin, allowInsecure: location.protocol === "http:" })}
    storage={browserStorage()}
    notice={createPersistenceNotice()}
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

  `App` in `app.tsx` takes `{ client, storage, notice }` and threads `client`/`storage` into `useSession`; `notice` is unused until Task 7 (no dead prop — pass it to nothing yet, but accept it, and say so in a comment). `createSession` gains an optional `onWrite?: (r: WriteResult) => void` that it calls after each storage write (today: the one `storage.set` in `join()`).

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
/** Writes an identity and clears `identity: "invalid"`. The one writer for join/create/rejoin. */
export function setIdentity(storage: KeyValueStorage, weaveId: string, who: { token: string; participantId: string }): WriteResult;
/** Deletes `token`/`participantId`, sets `identity: "invalid"`. Keeps `secret` and the display cache. */
export function invalidateIdentity(storage: KeyValueStorage, weaveId: string): WriteResult;
export function forgetWeave(storage: KeyValueStorage, weaveId: string): void;
export function hasIdentity(e: WeaveEntry | undefined): e is WeaveEntry & { token: string; participantId: string };
export function storedWeaves(storage: KeyValueStorage): StoredWeave[];
export async function migrateLegacy(
  storage: KeyValueStorage, notice: PersistenceNotice, lookup: (secret: string) => Promise<string>,
): Promise<void>;
```

- [ ] **Step 1: Failing tests** in `src/web/test/weaves-store.test.ts` (node environment, `memoryStorage()` unless a durability rule is under test), one rule each:
  - `storedWeaves` returns `{ kind: "id" }` for `loom:weave:<uuid>` and `{ kind: "legacy" }` for `loom:<43-char secret>` — the discriminator is the colon in the remainder.
  - A key that is neither (`other:x`, `loom:weave:` with an empty id, a legacy value with no `token`) is skipped.
  - A corrupt JSON value is skipped, not fatal.
  - `saveWeaveEntry` merges: `{ title: "A" }` then `{ lastOpenedAt: "t" }` leaves both; `undefined` values in the patch change nothing.
  - `setIdentity` writes `token`/`participantId` **and removes** an existing `identity: "invalid"`.
  - `invalidateIdentity` deletes `token` and `participantId`, sets `identity: "invalid"`, and keeps `secret`, `title`, `archived`, `lastOpenedAt`.
  - `hasIdentity` is false for `{}`, false for `{ token, participantId, identity: "invalid" }`, true for `{ token, participantId }`.
  - `forgetWeave` removes the key; `storedWeaves` no longer lists it.
  - Migration, durable: a legacy entry + a `lookup` returning an id → the id entry holds `token`, `participantId` and `secret`, and the legacy key is **gone**.
  - Migration, non-durable (`installLocalStorage()` from Task 1 in `silent` mode, over a real `browserStorage()`): the id entry is **readable on this page**, the legacy key is **still in `localStorage`**, and a *second* `browserStorage()` over the same raw map (a reload) still yields the legacy entry with its token.
  - Migration stops after a `"memory"` verdict: with two legacy entries and a `lookup` spy, the spy is called at most once more after the first failed write, and the second legacy key is untouched.
  - A `lookup` that rejects leaves that legacy entry alone and moves on to the next.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/weaves-store.test.ts`.
- [ ] **Step 3: Implement** `weaves-store.ts`. The load-bearing parts:

```ts
export function saveWeaveEntry(storage: KeyValueStorage, weaveId: string, patch: Partial<WeaveEntry>): WriteResult {
  const next: WeaveEntry = { ...(readWeaveEntry(storage, weaveId) ?? {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return storage.set(weaveKey(weaveId), JSON.stringify(next));
}

export function setIdentity(storage: KeyValueStorage, weaveId: string, who: { token: string; participantId: string }): WriteResult {
  // Spread-minus, not `saveWeaveEntry`: a rejoin has to *clear* `identity`, and a merge cannot.
  const { identity: _dropped, ...rest } = readWeaveEntry(storage, weaveId) ?? {};
  return storage.set(weaveKey(weaveId), JSON.stringify({ ...rest, token: who.token, participantId: who.participantId }));
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
 */
export async function migrateLegacy(
  storage: KeyValueStorage, notice: PersistenceNotice, lookup: (secret: string) => Promise<string>,
): Promise<void> {
  for (const w of storedWeaves(storage)) {
    if (w.kind !== "legacy") continue;
    if (notice.degraded()) return;
    let weaveId: string;
    try { weaveId = await lookup(w.secret); } catch { continue; }   // unreachable: leave it alone
    const result = saveWeaveEntry(storage, weaveId, { token: w.token, participantId: w.participantId, secret: w.secret });
    notice.note(result);
    if (result === "durable") storage.remove(legacyKey(w.secret));
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

Consumes: `KeyValueStorage`, `WriteResult` (Task 1); `PersistenceNotice` (Task 2); `WeaveEntry`, `readWeaveEntry`, `saveWeaveEntry`, `setIdentity`, `invalidateIdentity`, `hasIdentity`, `storedWeaves` (Task 3).

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
  - `onWrite` is called with the verdict of every storage write the session makes (join, invalidate).
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
  const pickReader = (): { reader: LoomClient; withToken: boolean; readOnlyReason?: "secret-fallback" } | undefined => {
    if (target.kind === "secret") return { reader: client.withToken(secret!), withToken: false };
    const e = entry();
    secret ??= e?.secret;
    if (hasIdentity(e) && e.identity !== "invalid") return { reader: client.withToken(e.token), withToken: true };
    if (secret) return { reader: client.withToken(secret), withToken: false, readOnlyReason: "secret-fallback" };
    return undefined;
  };

  /** A 401/403 on a read: this credential is provably unusable, unlike a network failure. */
  const isCredentialFailure = (e: unknown) =>
    e instanceof LoomClientError && (e.code === "invalid_token" || e.code === "forbidden");
```

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
- [ ] **Step 4: Implement `join()` and `targets()`.** `join(name)` joins with `secret` (the target's, or the entry's on the fallback path) and throws `new LoomClientError("validation", "This session has no way to join")` when there is none; on success it calls `setIdentity(storage, weaveId!, { token: j.token, participantId: j.participant.id })`, reports the verdict through `onWrite`, and keeps the rest of today's body (optimistic participant list, `deriveInvites`, `scheduleRefresh`) plus `readOnlyReason: undefined`. `targets()` iterates `storedWeaves(storage)`:
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

### Task 6: Router, `WeaveView`, and the in-place transition

Spec §2.7, §3.1, §3.3.

**Files:** Modify `src/web/src/app.tsx` (whole file); Create `src/web/src/components/WeaveView.tsx`; Test `src/web/test/components.test.tsx` (modify).

**Interfaces:**

Consumes: `SessionTarget`, `SessionState`, `Session`, `useSession` (Task 4); `AppDeps`, `PersistenceNotice` (Task 2).

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
}): JSX.Element;
```

- [ ] **Step 1: Failing tests** in `components.test.tsx`:
  - `routeOf` table: `/` → main; `/lobby` and `/lobby/` → lobby; `/weave/<uuid>` and `/weave/<uuid>/` → weave with the id; `/w/<43 chars>` → secret; `/weave/nope`, `/x` → unknown.
  - `WeaveView` with `status: "no-credential"` and a non-Lobby weave renders the explanation and a link to `/`, and renders **no** composer.
  - `WeaveView` with `readOnlyReason: "secret-fallback"` renders the "your identity in this Weave is no longer valid" line and a **Join** button, and the composer is absent until a join.
  - `WeaveView` with `status: "ready"` and a normal `me` is unchanged from today (the existing Weave-page assertions keep passing).
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/components.test.tsx`.
- [ ] **Step 3: Implement.** Move today's `Weave` function (app.tsx lines 25–100) into `components/WeaveView.tsx` as `WeaveView({ session, state, banner })` — the body is unchanged except that it no longer calls `useSession`, it renders `{banner}` first, and it gains two branches before the existing `status` checks:
```tsx
  if (state.status === "no-credential") return <NoCredential state={state} />;
```
  and, inside the layout, above `<MessageList/>`:
```tsx
  {state.readOnlyReason === "secret-fallback" && (
    <div class="banner">
      Your identity in this Weave is no longer valid — you are reading with the Weave link.{" "}
      <button onClick={() => session.dismissNamePrompt() /* opens the prompt via needsName below */}>Join</button>
    </div>
  )}
```
  (the Join button sets a local `askName` state that renders the existing `<NamePrompt/>`; keep the existing `pending`/`needsName` logic as it is).

  `app.tsx` becomes the router:
```tsx
const SECRET_RE = /^\/w\/([A-Za-z0-9_-]{43})\/?$/;
const WEAVE_RE = /^\/weave\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function routeOf(pathname: string): Route {
  if (pathname === "/" ) return { kind: "main" };
  if (pathname === "/lobby" || pathname === "/lobby/") return { kind: "lobby" };
  const w = WEAVE_RE.exec(pathname);
  if (w) return { kind: "weave", weaveId: w[1]! };
  const s = SECRET_RE.exec(pathname);
  if (s) return { kind: "secret", secret: s[1]! };
  return { kind: "unknown" };
}

export function App({ client, storage, notice }: AppDeps) {
  // The route is state, not just a parsed path: a join or a creation whose credential could not be
  // persisted switches the view here, in this JS context, rather than navigating away from the only
  // copy of that credential (spec §3.1). The URL is deliberately left alone — a pushed /lobby would
  // be an address this browser cannot honour after a reload.
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
  const openInPlace = (weaveId: string) => setRoute({ kind: "weave", weaveId });
  switch (route.kind) {
    case "main":   return <MainPage client={client} storage={storage} notice={notice} openInPlace={openInPlace} />;
    case "lobby":  return <LobbyRoute client={client} storage={storage} notice={notice} />;
    case "weave":  return <WeaveRoute target={{ kind: "id", weaveId: route.weaveId }} client={client} storage={storage} notice={notice} />;
    case "secret": return <WeaveRoute target={{ kind: "secret", secret: route.secret }} client={client} storage={storage} notice={notice} />;
    default:       return <div class="center"><h1>Loom</h1><p>No such page. <a href="/">Go to the main page</a>.</p></div>;
  }
}
```
  `WeaveRoute` calls `useSession(target, { client, storage, onWrite: notice.note })` and renders `<WeaveView session state banner={<PersistenceBar notice={notice} />} />`. `LobbyRoute` resolves the id first: `client.getLobby()` → `"Loading…"` while in flight, `weave_not_found` → "This instance has no Lobby yet." with a link to `/`, any other failure → the same error card `WeaveView` uses, then renders `<WeaveRoute target={{ kind: "id", weaveId }} … />`. `MainPage` and `PersistenceBar` arrive in Task 7; until then stub them as one-line components that render their heading, so this task compiles and its tests run.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): route /, /lobby and /weave/<id>, with an in-place switch when a credential did not persist`

---

### Task 7: The main page shell, the persistence notice, guidelines and the Lobby summary

Spec §4 intro, §4.3, §4.4, §6 (the notice).

**Files:** Create `src/web/src/components/main/MainPage.tsx`, `InstanceGuidelines.tsx`, `LobbySummary.tsx`, `src/web/src/components/PersistenceBar.tsx`; Modify `src/web/src/styles.css`, `src/web/tsconfig.test.json` (widen `include` to `["src/**/*.ts", "src/**/*.tsx", "test", "../server/test/helpers.ts", "../core/test/helpers.ts"]`); Test `src/web/test/main-page.test.tsx` (new, first line `// @vitest-environment happy-dom`).

**Interfaces:**

Consumes: `AppDeps`, `PersistenceNotice` (Task 2); `storedWeaves`, `readWeaveEntry`, `hasIdentity`, `migrateLegacy` (Task 3).

Produces:
```ts
export function MainPage(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  openInPlace: (weaveId: string) => void;
}): JSX.Element;
export function PersistenceBar(props: { notice: PersistenceNotice }): JSX.Element | null;
export function InstanceGuidelines(props: { client: LoomClient }): JSX.Element | null;
export function LobbySummary(props: {
  client: LoomClient; storage: KeyValueStorage;
  lobby?: { weaveId: string; title: string }; error?: string;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests** in `main-page.test.tsx`. Build the injected client with a stubbed `fetch` (`new LoomClient({ baseUrl: "http://loom.test", allowInsecure: true, fetch: stub })`) so every case is a table of URL → response:
  - The four cells render independently: a `GET /api/guidelines` that rejects leaves the Lobby summary and the rest on screen.
  - `InstanceGuidelines` renders Markdown through `markdown.ts`, collapses past 12 lines behind a "Show all" control, and renders **nothing** for empty text.
  - `LobbySummary` with no stored Lobby identity shows the title and the one-line explanation and makes **no** `getWeave`/`listRequests` call.
  - `LobbySummary` with a stored Lobby identity shows the participant count, the listener count (participants whose `capabilities` is non-null) and the open-request count, read with the stored token.
  - `getLobby()` answering `weave_not_found` renders "This instance has no Lobby yet" and no join affordance.
  - `PersistenceBar` renders nothing while `notice.degraded()` is false, renders once after a `note("memory")`, does **not** re-render a second bar after a second `note("memory")`, disappears on dismiss, and its text names neither "quota" nor "localStorage".
  - `MainPage` runs `migrateLegacy` once on mount with `lookup = (s) => client.lookupWeave(s)`.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** `MainPage` owns four independent async cells, each `loading → value | error`, and renders in order: `<PersistenceBar/>`, the instance title and `<InstanceGuidelines/>`, `<LobbySummary/>` + `<JoinLobbyForm/>` (Task 8), `<MyWeaves/>` (Task 9), `<CreateWeaveForm/>` (Task 10) — stub the three not yet written as headings so this task is green on its own. The notice bar's wording: *"This browser is not saving anything for this site, so Weaves you join or create here will be gone when you close the tab. Copy any Weave link you want to keep, or allow this site to store data."* `PersistenceBar` subscribes to the notice with `useEffect` and a `useState` counter.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): the main page shell with instance guidelines, the Lobby summary and the persistence notice`

---

### Task 8: Join the Lobby

Spec §4.1, plus the durable/in-place branch of §3.1.

**Files:** Create `src/web/src/name.ts`, `src/web/src/components/main/JoinLobbyForm.tsx`; Modify `src/web/src/components/NamePrompt.tsx` (line 3), `src/web/src/components/main/MainPage.tsx`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `setIdentity`, `saveWeaveEntry`, `readWeaveEntry`, `hasIdentity` (Task 3); `PersistenceNotice` (Task 2); `openInPlace` (Task 6).

Produces:
```ts
// src/web/src/name.ts
export const NAME_RE: RegExp;                       // /^[A-Za-z0-9_.-]{1,32}$/
export function isValidName(name: string): boolean;
/** `dana` → `dana-2`, `dana-2` → `dana-3`; never longer than 32 characters. */
export function suggestName(taken: string): string;

export function JoinLobbyForm(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  lobby: { weaveId: string; title: string };
  openInPlace: (weaveId: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests** (extend `main-page.test.tsx`):
  - The form is shown when there is no entry for the Lobby id, when the entry has no identity, and when it is marked `identity: "invalid"`; **Open the Lobby** (a link to `/lobby`) is shown instead when the entry has a usable identity, naming the participant.
  - Name validation at the boundaries: `a` valid, 32 chars valid, 33 chars invalid, `"a b"` invalid, `"a@b"` invalid; the submit button is disabled while invalid.
  - `name_taken` (409) renders the two-case message, keeps the typed name in the field, and offers a suggestion button whose click fills the field with `dana-2` **without** submitting (assert the stub `fetch` was called exactly once).
  - `validation` (400) renders the server's message verbatim; `weave_not_found` renders "This instance has no Lobby yet."; a rejected fetch renders "Could not reach the server." and keeps the typed name.
  - A **durable** join writes the entry and navigates (assert through an injected `navigate` prop spy, so the test never touches `location`).
  - **Blocked storage on join**: with `localStorage.setItem` throwing, the join succeeds and the destination is **loaded and writable** — `openInPlace` was called with the Lobby id, `navigate` was **not**, and rendering `<WeaveRoute>` over the same storage instance reaches `status: "ready"` with `state.me` set (drive this one through a small in-file harness that renders `App` with a stubbed client whose `/api/weaves/<lobbyId>` answers a real-shaped `WeaveInfo`).
  - `suggestName` unit table: `dana` → `dana-2`; `dana-2` → `dana-3`; a 32-character name → a suggestion still ≤ 32.
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** `name.ts` holds the one copy of core's rule (`src/core/src/names.ts` `NAME_RE`); `NamePrompt.tsx` line 3 imports it instead of declaring its own. The submit handler:
```ts
    const j = await client.joinLobby({ name, kind: "human" });
    // Persist before anything that could destroy this JS context, and let the verdict decide whether
    // navigating is safe at all (spec §3.1).
    const result = setIdentity(storage, j.weaveId, { token: j.token, participantId: j.participant.id });
    saveWeaveEntry(storage, j.weaveId, { title: j.weave.title, lastOpenedAt: new Date().toISOString() });
    notice.note(result);
    if (result === "durable") navigate("/lobby"); else openInPlace(j.weaveId);
```
  The `name_taken` block renders the message from the spec verbatim and a suggestion button wired to `suggestName(name)`.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): join the Lobby from the main page, without a secret`

---

### Task 9: My Weaves

Spec §4.2.

**Files:** Create `src/web/src/components/main/MyWeaves.tsx`; Modify `src/web/src/components/main/MainPage.tsx`, `src/web/src/styles.css`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `StoredWeave`, `storedWeaves`, `forgetWeave`, `saveWeaveEntry`, `hasIdentity` (Task 3).

Produces:
```ts
export type WeaveRow = {
  weaveId?: string; secret?: string; title: string;
  state: "joined" | "read-only" | "identity-invalid" | "unavailable";
  joinedAs?: string; isLobby: boolean; archived: boolean; lastOpenedAt?: string;
  note?: string;                      // "could not refresh", "this Weave is gone", …
};
/** Folds a legacy entry into an id entry when their `secret` matches, else when their `token` does. */
export function foldRows(stored: StoredWeave[], lobbyWeaveId?: string): WeaveRow[];
export function MyWeaves(props: {
  client: LoomClient; storage: KeyValueStorage; lobbyWeaveId?: string;
}): JSX.Element;
```

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
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** Rows come from `foldRows(storedWeaves(storage), lobbyWeaveId)`, sorted, filtered, then sliced to 25 with a "Show more" that raises the slice. Refresh is a `useEffect` over the **rendered slice** — the rendered rows are the definition of "on screen", not an `IntersectionObserver` — running `client.withToken(token).getWeave(id)` through a pool of 6 and writing `{ title, archived }` back with `saveWeaveEntry`. A 401/403/404 sets the row's state and note; nothing is deleted.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): My Weaves — every Weave this browser holds, rendered from cache`

---

### Task 10: Create a Weave

Spec §4.5.

**Files:** Create `src/web/src/components/main/CreateWeaveForm.tsx`; Modify `src/web/src/components/main/MainPage.tsx`, `src/web/src/styles.css`; Test `src/web/test/main-page.test.tsx` (extend).

**Interfaces:**

Consumes: `NAME_RE`, `isValidName` (Task 8); `setIdentity`, `saveWeaveEntry` (Task 3); `PersistenceNotice` (Task 2); `openInPlace` (Task 6).

Produces:
```ts
export function CreateWeaveForm(props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice;
  /** Prefills the name field when this browser already has a Lobby identity. */
  defaultName?: string;
  openInPlace: (weaveId: string) => void;
  navigate: (path: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests:**
  - Fields: `title` (1–200, submit disabled outside), `your name` (the shared `NAME_RE`, prefilled from `defaultName`), an optional opener, guidelines behind a "more" disclosure; the request body carries `kind: "human"`.
  - A `403 forbidden` renders "This instance only lets keepers create Weaves." in place of the form.
  - A `201` renders the save-this-link panel: the full `/w/<secret>` URL, a **Copy** control, the warning naming that the link cannot be rotated or revoked, and **Open the Weave**.
  - **The entry is written before the panel appears**: at the moment the panel is first rendered, `readWeaveEntry(storage, id)` already holds `token`, `participantId`, `secret` and `title` (assert inside the render assertion, not after a tick).
  - **Open the Weave** points at `/weave/<id>` (durable case) — never `/w/<secret>`.
  - **Blocked storage on create**: with `setItem` throwing, the panel appears with the hardened warning, cannot be dismissed until the link is copied or acknowledged, and **Open the Weave** calls `openInPlace` (not `navigate`) and yields a Weave where this browser **is the keeper** (`state.me.participant.role === "keeper"`).
- [ ] **Step 2: RED** — `cd src/web && npx vitest run test/main-page.test.tsx`.
- [ ] **Step 3: Implement.** The submit handler mirrors Task 8's ordering — `createWeave` → `setIdentity` + `saveWeaveEntry({ secret, title, lastOpenedAt })` → `notice.note(result)` → render the panel — and the panel's props carry `durable: result === "durable"`, which chooses the warning text, whether the dismiss control is enabled, and whether **Open the Weave** navigates or switches in place.
- [ ] **Step 4: GREEN** — `cd src/web && npx vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** — `feat(web): create a Weave from the main page, with the save-this-link moment`

---

### Task 11: Docs and totals

Spec §8.

**Files:** Modify `docs/ARCHITECTURE.md` (§9), `docs/SECURITY.md` (§8, §9.9, §4a/§9), `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `README.md`, `docs/superpowers/specs/v2-notes.md`.

- [ ] **ARCHITECTURE §9**: the route table (`/`, `/lobby`, `/weave/<id>`, `/w/<secret>`); the `target` union and where the read credential comes from (stored token, else stored secret); the `loom:weave:<weaveId>` key and the entry's fields; `WriteResult` **and** the read-precedence rule; the one storage instance created in `main.tsx` and passed to `App`/`useSession`; "no router" becomes "no router library — path matching in `app.tsx`, with one in-place switch when a credential did not persist"; rewrite the existing "degrades to memory when storage throws" sentence so the degradation reads as observable rather than silent.
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
- **§2.4** interface, entry, coexistence/migration → Tasks 1 and 3. **§2.4a** single instance → Task 2 (guard test) and Task 4 (`useSession` takes it). **§2.4b** precedence, tombstones, `keys()`, clear-on-next-success, no background retry, cross-tab → Task 1.
- **§2.5** `targets()` skipping entries with no usable identity → Task 4, Step 4.
- **§2.6** every table row, the rejoin self-heal, the three asymmetries → Task 4 (store tests) and Task 6 (`WeaveView` branches).
- **§2.7** convergence on one `<WeaveView/>` → Task 6.
- **§3.1** routes, full page loads, the one exception, the URL deliberately unchanged → Task 6; the durable/in-place branch at each call site → Tasks 8 and 10. **§3.2** server paths, no catch-all, API-only → Task 5. **§3.3** the three-way fork → Tasks 4 (credential resolution) and 6 (rendering).
- **§4.1** → Task 8; **§4.2** → Task 9; **§4.3**, **§4.4** → Task 7; **§4.5** → Task 10.
- **§5** security: nothing new is written, so the review lands in docs → Task 11 (SECURITY §8, §9.9, §4a). The "a Weave title must go through JSX, never the Markdown renderer" rule is enforced by Task 9's row rendering and Task 7's guidelines-only use of `markdown.ts`.
- **§6** no new error code; `no-credential` + `readOnlyReason` → Task 4; four independent cells and the never-crashing degraded mode → Task 7; the one-time notice → Task 7 (`PersistenceBar`).
- **§7 test by test**: one storage instance + `useSession` keeps it → Task 2. Durable-write result (6 cases) → Task 1. Read precedence (7 cases) → Task 1. Storage entry unit cases → Task 3. Migration (4 cases) → Task 3. Store: token load, secret-vs-id equality, Lobby board, no entry, network failure, mutations, `needsName` → Task 4. Invalid identity (7 cases incl. the two non-durable ones) → Task 4. DOM: join/Open-the-Lobby/invalid-identity, name boundaries, `name_taken` + suggestion, blocked storage on join, blocked storage on create, the notice, My Weaves states, Lobby summary, create 403/201, `/weave/<id>` forks → Tasks 6–10. Server (3 cases) → Task 5. Manual smoke → Task 11.
- **§8** docs list → Task 11, item for item.
- **§9** implementation order followed exactly, 11 steps to 11 tasks, with Task 0 for the branch.
- **§10** assumptions: 9 (an entry written on a `/w/<secret>` load before any join) is Task 4 Step 3's `saveWeaveEntry` after a successful metadata read; 10 (nothing deleted automatically) is Task 9's Forget-only rule; 12 (the instance is a prop, not a singleton) is Task 2; 13 (page-lifetime overrides, no cross-tab sync) is Task 1.
- **Type consistency**: `WriteResult` is the return of `set`, `saveWeaveEntry`, `setIdentity` and `invalidateIdentity` and the parameter of `PersistenceNotice.note` and `onWrite` everywhere; `WeaveEntry` is the stored shape and `StoredWeave` the listed one, never swapped; `SessionTarget` has the same two members in `createSession`, `useSession` and `app.tsx`; `hasIdentity(e)` is the single test for "usable identity" in the session, `targets()`, My Weaves and the join form; `notice.note` is the only `onWrite` passed to `useSession`. Placeholder scan: no "TBD", no "similar to Task N", no "add error handling"; every symbol a task consumes is produced by an earlier task's **Produces** block.
