import type { KeyValueStorage, WriteResult } from "./storage.js";

/**
 * Whether anything this page wrote failed to persist, and whether the human has been told.
 * Page-scoped and latching: one notice per page load, and `migrateLegacy` reads the same latch to
 * stop rewriting entries once the store has proven it will not keep them.
 */
export type PersistenceNotice = {
  /** Latches "degraded" the first time a write reports `"memory"`. Idempotent. */
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
  const emit = () => { for (const l of [...listeners]) l(); };
  return {
    note: (r) => { if (r === "memory" && !degraded) { degraded = true; emit(); } },
    degraded: () => degraded,
    dismissed: () => dismissed,
    dismiss: () => { if (!dismissed) { dismissed = true; emit(); } },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

/**
 * May this page be left — a full page load, a new tab, a middle click — without losing a credential
 * this JS context is the only holder of? The **one** question behind every in-place decision in the
 * app (spec §3.1), asked the same way on the way into a Weave (My Weaves' row titles, the main
 * page's Open the Lobby) and on the way back out of one (the header's wordmark, the no-credential
 * and error cards). Whoever answers `false` renders a button that switches the route in place
 * instead of an anchor, because an anchor can be middle-clicked or opened in a new tab and that is
 * the same page load.
 *
 * Two halves, and either one is enough to say no.
 *
 * `key` — when the caller has one destination in mind — is that entry's **pending override**: a
 * value `localStorage` refused, which exists nowhere but here. It is re-read on every render, so a
 * later write that does persist turns the control back into an ordinary link with nothing clicked.
 *
 * The notice is the page-scoped latch, and it **never clears** (`degraded` is set once): a browser
 * that has already refused one write is not trusted with a full page load again, whatever any one
 * entry's verdict says. That is deliberate, not an oversight — the destination of a navigation is
 * never only the one entry the caller was looking at. `MainPage` lists every entry this browser
 * holds; a Weave page may hold a Lobby identity written before an in-place transition. Losing the
 * whole in-memory store is what a page load costs on such a page, so one failed write settles it
 * for the life of the page.
 */
export function leavingIsSafe(storage: KeyValueStorage, notice: PersistenceNotice, key?: string): boolean {
  if (notice.degraded()) return false;
  return key === undefined || !storage.isPending(key);
}
