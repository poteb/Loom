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
