import type { LoomEvent } from "./types.js";

type Listener = (e: LoomEvent) => void;

/** In-process pub/sub keyed by weave id. Single-instance v1; swap for pg NOTIFY when scaling out. */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(weaveId: string, fn: Listener): () => void {
    let set = this.listeners.get(weaveId);
    if (!set) { set = new Set(); this.listeners.set(weaveId, set); }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(weaveId);
    };
  }

  publish(e: LoomEvent): void {
    const set = this.listeners.get(e.weaveId);
    if (!set) return;
    for (const fn of set) {
      try { fn(e); } catch { /* a bad subscriber must not break publishing */ }
    }
  }
}
