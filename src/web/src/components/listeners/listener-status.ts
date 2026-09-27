import type { Cadence, Profile } from "@loom/client";

/**
 * A duration as the directory writes it (spec 2026-09-27 §6.3): under 90 s whole seconds, under 90
 * minutes whole minutes, otherwise whole hours, each `Math.round`ed (halves up). Every gap exceeds
 * the 10 s throttle and a declared interval is at least a minute, so nothing reads `0`.
 */
export function durationText(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/**
 * The rate beside Last seen: the measured part (`every ~<typical>`, or `rate unknown` with fewer
 * than two check-ins), the declared part in parentheses, then `, longest <longest>` when measured.
 */
export function rateText(cadence: Cadence, profile: Profile): string {
  const declared = typeof profile.pollIntervalMs === "number"
    ? ` (declares ${durationText(profile.pollIntervalMs)})` : " (no declared interval)";
  if (cadence.typicalGapMs === null || cadence.longestGapMs === null) return `rate unknown${declared}`;
  return `every ~${durationText(cadence.typicalGapMs)}${declared}, longest ${durationText(cadence.longestGapMs)}`;
}
