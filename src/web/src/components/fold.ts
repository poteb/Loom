import type { LoomEvent } from "@loom/client";

/**
 * One entry of the stream as it is drawn: a message, a system event on its own line, or a run of
 * two or more consecutive system events folded into one row. `key` is the first event's seq, so a
 * run that grows while it is on screen keeps its key, and with it whether it is expanded.
 */
export type StreamItem =
  | { kind: "message"; key: number; event: LoomEvent }
  | { kind: "system"; key: number; event: LoomEvent }
  | { kind: "run"; key: number; events: LoomEvent[] };

/**
 * The stream, grouped. With `fold` on, consecutive system events become one run and a message ends
 * a run; a lone system event stays as it is. With `fold` off, every event is its own item.
 * Order and membership are the events' own: grouping never drops or reorders one.
 */
export function foldStream(events: readonly LoomEvent[], fold: boolean): StreamItem[] {
  const items: StreamItem[] = [];
  let pending: LoomEvent[] = [];
  const flush = () => {
    if (pending.length === 1) items.push({ kind: "system", key: pending[0]!.seq, event: pending[0]! });
    else if (pending.length > 1) items.push({ kind: "run", key: pending[0]!.seq, events: pending });
    pending = [];
  };
  for (const e of events) {
    if (e.type === "message") { flush(); items.push({ kind: "message", key: e.seq, event: e }); continue; }
    if (!fold) { items.push({ kind: "system", key: e.seq, event: e }); continue; }
    pending.push(e);
  }
  flush();
  return items;
}

/** How a run counts one kind of event: a fixed phrase after the number, or a noun with its plural. */
type Words = string | [one: string, many: string];
const WORDS: Partial<Record<string, Words>> = {
  "participant.joined": "joined",
  "participant.role_changed": ["role change", "role changes"],
  "participant.capabilities_changed": ["profile update", "profile updates"],
  "thread.created": ["thread created", "threads created"],
  "thread.closed": ["thread closed", "threads closed"],
  "thread.invited": "invited",
  "thread.removed": "removed",
  "thread.url_changed": ["link change", "link changes"],
  "weave.archived": "weave archived",
  "weave.guidelines_changed": ["guidelines change", "guidelines changes"],
  "weave.invited": "invited to a Weave",
  "request.opened": ["request opened", "requests opened"],
  "request.offered": ["offer", "offers"],
  "request.accepted": ["acceptance", "acceptances"],
  "request.closed": ["request closed", "requests closed"],
  "request.completed": "finished",
  "request.overdue": "overdue",
};

/**
 * A run in words, one part per kind of event in the order each kind first appears:
 * `["3 joined", "10 profile updates", "1 invited"]`. A kind with no words here is named by its type.
 */
export function runSummary(events: readonly LoomEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => {
    const w = WORDS[type] ?? type;
    return `${n} ${typeof w === "string" ? w : n === 1 ? w[0] : w[1]}`;
  });
}

/** When a run happened: `first-last` in the given clock, or one time when both ends read the same. */
export function timeRange(events: readonly LoomEvent[], clock: (iso: string) => string = (iso) => new Date(iso).toLocaleTimeString()): string {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return "";
  const a = clock(first.at);
  const b = clock(last.at);
  return a === b ? a : `${a}-${b}`;
}
