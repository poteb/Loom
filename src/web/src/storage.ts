export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}

/** localStorage when available; every call is guarded because some contexts throw on access. */
export function browserStorage(): KeyValueStorage {
  const fallback = memoryStorage();
  const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
  return {
    get: (k) => { try { return ls()?.getItem(k) ?? fallback.get(k); } catch { return fallback.get(k); } },
    set: (k, v) => { try { ls()?.setItem(k, v); } catch { /* quota or blocked */ } fallback.set(k, v); },
    remove: (k) => { try { ls()?.removeItem(k); } catch { /* ignore */ } fallback.remove(k); },
  };
}
