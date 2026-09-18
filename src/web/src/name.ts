/**
 * The web package's one copy of core's participant-name rule
 * ([`src/core/src/names.ts`](../../core/src/names.ts)): `A-Z a-z 0-9 _ . -`, 1–32 characters.
 *
 * One exported constant, shared by every form that asks for a name — the join form, the create form
 * and `NamePrompt`. Two hand-copied regexes for one core rule is exactly the drift CONTRIBUTING
 * warns about, and the drift would show up as a client refusing what the server accepts, or the
 * reverse.
 */
export const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

const NAME_MAX = 32;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * The next name to try after `name_taken`: `dana` → `dana-2`, `dana-2` → `dana-3`.
 *
 * A plain client-side first-free-suffix guess (spec §4.1) — it asks the server nothing, so a guess
 * that turns out to be taken too simply re-runs the same error, which costs one request and stays
 * honest. The suffix is kept inside the 32-character limit by trimming the stem, never by
 * overflowing it: a suggestion the rule itself would refuse is worse than no suggestion at all.
 */
export function suggestName(taken: string): string {
  const m = /^(.*?)-(\d+)$/.exec(taken);
  const n = m ? Number(m[2]) : 1;
  // A digit run too long to count as a number is not a counter — treat the whole name as the stem
  // rather than resuming from an imprecise value.
  const counting = m !== null && Number.isSafeInteger(n);
  const stem = counting ? m![1]! : taken;
  const suffix = `-${(counting ? n : 1) + 1}`;
  return `${stem.slice(0, Math.max(0, NAME_MAX - suffix.length))}${suffix}`;
}
