/**
 * "The stored Weaves changed." One instance per page, created beside the one storage instance, so
 * anything that writes an entry can say so and My Weaves can re-read storage (§4.2).
 *
 * My Weaves renders from storage, and a `KeyValueStorage` says nothing when it is written — so
 * without this a finished migration, a refreshed title or an invalidated identity would sit in
 * storage while the screen kept the values it read at mount.
 *
 * Deliberately not an observable storage: the store is injected into the session and into every
 * test, and only this one list wants the events. Deliberately not latching either — unlike
 * `PersistenceNotice`, every bump is news.
 */
export type WeavesSignal = {
  /** Say that the stored entries changed. Synchronous; every subscriber is called once. */
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
