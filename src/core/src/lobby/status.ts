/*
 * Listener status, current work and cadence (spec 2026-09-27 §4), computed at read time from
 * `last_seen_at`, `seen_history` and the acceptances: never stored and never an event.
 */

export type Cadence = {
  /** The median gap between consecutive stored check-ins, in ms; null with fewer than two. */
  typicalGapMs: number | null;
  /** The longest of those gaps, in ms; null with fewer than two. */
  longestGapMs: number | null;
  /** How many check-ins are stored: 0 to 20. */
  samples: number;
};

/**
 * §4.4. The gaps are only those **between** stored check-ins, in stored order: the time since the
 * last one is not a gap. The median of an even count is the mean of the two middle gaps, rounded
 * down to a whole millisecond. `samples` counts check-ins, not gaps.
 */
export function cadenceOf(history: Date[] | null): Cadence {
  const h = history ?? [];
  if (h.length < 2) return { typicalGapMs: null, longestGapMs: null, samples: h.length };
  const gaps = h.slice(1).map((d, i) => d.getTime() - h[i]!.getTime()).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const typicalGapMs = gaps.length % 2 === 1 ? gaps[mid]! : Math.floor((gaps[mid - 1]! + gaps[mid]!) / 2);
  return { typicalGapMs, longestGapMs: gaps.at(-1)!, samples: h.length };
}
