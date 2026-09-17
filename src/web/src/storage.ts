export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key held, so the Weaves this browser has a token for can be listed (the target pickers). */
  keys(): string[];
};

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); }, keys: () => [...m.keys()] };
}

/** localStorage when available; every call is guarded because some contexts throw on access. */
export function browserStorage(): KeyValueStorage {
  const fallback = memoryStorage();
  const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
  return {
    get: (k) => { try { return ls()?.getItem(k) ?? fallback.get(k); } catch { return fallback.get(k); } },
    set: (k, v) => { try { ls()?.setItem(k, v); } catch { /* quota or blocked */ } fallback.set(k, v); },
    remove: (k) => { try { ls()?.removeItem(k); } catch { /* ignore */ } fallback.remove(k); },
    keys: () => {
      const seen = new Set(fallback.keys());
      try {
        const store = ls();
        for (let i = 0; i < (store?.length ?? 0); i++) { const k = store!.key(i); if (k !== null) seen.add(k); }
      } catch { /* blocked: the in-memory keys are all this context has */ }
      return [...seen];
    },
  };
}

/** The `/w/<secret>` identities this browser holds: one stored token per Weave it has joined. */
export function storedWeaves(storage: KeyValueStorage): { secret: string; token: string }[] {
  const out: { secret: string; token: string }[] = [];
  for (const key of storage.keys()) {
    if (!key.startsWith("loom:")) continue;
    const raw = storage.get(key);
    if (!raw) continue;
    try {
      const { token } = JSON.parse(raw) as { token?: string };
      if (token) out.push({ secret: key.slice("loom:".length), token });
    } catch { /* a corrupt entry is simply not a Weave this browser can offer */ }
  }
  return out;
}
