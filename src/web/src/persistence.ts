import type { WriteResult } from "./storage.js";

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
