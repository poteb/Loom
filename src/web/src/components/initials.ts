/**
 * The letters on a round avatar: the first letter of each of the first two parts of a name, split
 * where core's name rule allows a separator (`_`, `.`, `-`), else the first two letters. Always
 * upper case, so `Paw_browser` reads `PB` and `dana` reads `DA`.
 */
export function initials(name: string): string {
  const parts = name.split(/[_.\-\s]+/).filter((p) => p.length > 0);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}
