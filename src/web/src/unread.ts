import type { LoomEvent } from "@loom/client";

/**
 * Unread, as spec 2026-09-26 §4.4 states it and nowhere else: for Thread T, with
 * `position = positions[T] ?? joinedSeq`, the `message` events of T by anyone but `meId` with a seq
 * past the position. Own posts and system events never count; a Thread at zero is left out.
 */
export function unreadCounts(events: readonly LoomEvent[], meId: string,
  positions: Readonly<Record<string, number>>, joinedSeq: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "message" || e.actor === meId) continue;
    if (e.seq <= (positions[e.threadId] ?? joinedSeq)) continue;
    out[e.threadId] = (out[e.threadId] ?? 0) + 1;
  }
  return out;
}

/** The highest seq among one Thread's loaded events, or 0 when it has none. */
export function newestSeqIn(events: readonly LoomEvent[], threadId: string): number {
  let top = 0;
  for (const e of events) if (e.threadId === threadId && e.seq > top) top = e.seq;
  return top;
}

/** Merges two position maps Thread by Thread, keeping the greater: a position never moves back. */
export function mergePositions(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out = { ...a };
  for (const [id, seq] of Object.entries(b)) if (seq > (out[id] ?? -1)) out[id] = seq;
  return out;
}

/**
 * Where the "New" divider goes (§6.4): the seq of the first `message` in the Thread by someone other
 * than `meId` with a seq past `after`, or null when there is none.
 */
export function firstNewSeq(events: readonly LoomEvent[], threadId: string, after: number, meId: string): number | null {
  for (const e of events) {
    if (e.threadId === threadId && e.type === "message" && e.actor !== meId && e.seq > after) return e.seq;
  }
  return null;
}

/** At most one automatic `markRead` per this many milliseconds while a Thread stays open (§6.2). */
export const READ_FLUSH_MS = 5000;

/** What the session hands positions to: it decides when each one reaches the server. */
export type ReadThrottle = {
  /** A position reached: sent now when the latest send is a full interval old, else held until it is. */
  advance(threadId: string, seq: number): void;
  /** Sends everything held, now: the Thread was left or opened, or the tab hid. It counts as the latest send. */
  flush(): void;
  /** Holds a position whose send failed, for the next send; arms nothing. */
  retry(threadId: string, seq: number): void;
  /** Drops everything held, unsent, and the interval: an identity change, or the session ending. */
  reset(): void;
};

/**
 * The §6.2 throttle: the latest position per Thread, and an automatic send only when the latest
 * **actual** send (automatic, or a flush) is at least `intervalMs` old, so a flush restarts the
 * interval. Flushes themselves are never delayed. A held position is only ever raised. `now` is
 * the clock; the fake timers of the tests fake `Date` as well. `visible` is the visibility rule:
 * while it answers false nothing is sent automatically (the timer that finds the tab hidden sends
 * nothing and stops), and what is held waits for the next visible send or a flush.
 */
export function createReadThrottle(send: (threadId: string, seq: number) => void, intervalMs: number = READ_FLUSH_MS,
  now: () => number = () => Date.now(), visible: () => boolean = () => true): ReadThrottle {
  let held = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  const hold = (threadId: string, seq: number) => { if (seq > (held.get(threadId) ?? -1)) held.set(threadId, seq); };
  const sendHeld = () => {
    if (held.size === 0) return;
    const out = [...held];
    held = new Map();
    lastSent = now();
    for (const [threadId, seq] of out) send(threadId, seq);
  };
  /** One timer at most, due a full interval after the latest send; it re-checks, because a flush may have moved that. */
  const schedule = () => {
    if (timer !== undefined || held.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (held.size === 0 || !visible()) return;
      if (now() - lastSent < intervalMs) { schedule(); return; }
      sendHeld();
    }, Math.max(0, lastSent + intervalMs - now()));
  };
  return {
    advance(threadId, seq) {
      hold(threadId, seq);
      if (visible() && now() - lastSent >= intervalMs) sendHeld(); else schedule();
    },
    flush() { sendHeld(); },
    retry(threadId, seq) { hold(threadId, seq); },
    reset() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      held = new Map();
      lastSent = Number.NEGATIVE_INFINITY;
    },
  };
}

/** Whether the tab is visible, and a way to hear when that changes: the session's seam for §6.2. */
export type Visibility = { visible(): boolean; onChange(fn: () => void): () => void };

/** The document's own visibility; without a document (the node test environment) always visible. */
export function documentVisibility(): Visibility {
  if (typeof document === "undefined") return { visible: () => true, onChange: () => () => {} };
  return {
    visible: () => document.visibilityState === "visible",
    onChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}
