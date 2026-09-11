const NAME_CHAR = /[A-Za-z0-9_.-]/;

/** If the caret sits at the end of an "@query" token, returns the query and the index of the "@". */
export function completeMention(text: string, caret: number, _names: string[]): { query: string; start: number } | null {
  let i = caret;
  while (i > 0 && NAME_CHAR.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  if (at > 0 && NAME_CHAR.test(text[at - 1]!)) return null; // email-like
  return { query: text.slice(i, caret), start: at };
}

/** Replaces text[start..caret) with "@name " and returns the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
