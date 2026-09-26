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
