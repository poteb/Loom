/** Returns participant ids mentioned as @name (case-insensitive, word-bounded), deduped, in order of first appearance. */
export function parseMentions(text: string, participants: { id: string; name: string }[]): string[] {
  const byName = new Map(participants.map((p) => [p.name.toLowerCase(), p.id]));
  const out: string[] = [];
  // '@' must not be preceded by a name char (avoids emails); name is longest run of name chars.
  const re = /(?<![A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g;
  for (const m of text.matchAll(re)) {
    // Trailing dots are punctuation, not part of the name, unless the full run matches a name.
    let candidate = m[1]!;
    let id = byName.get(candidate.toLowerCase());
    while (!id && candidate.endsWith(".")) {
      candidate = candidate.slice(0, -1);
      id = byName.get(candidate.toLowerCase());
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
