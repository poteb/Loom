import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Db } from "./index.js";

/** One journal entry as `drizzle-kit generate` writes it. */
type JournalEntry = { readonly idx: number; readonly when: number; readonly tag: string };

export type MigrationStatus = {
  /** Journal tags already applied, oldest first. */
  readonly applied: readonly string[];
  /** Journal tags `runMigrations` would apply next, oldest first. */
  readonly pending: readonly string[];
};

/**
 * The migrations folder, resolved once and shared: `runMigrations` and `migrationStatus` must never
 * be able to read different folders. It lands on `src/core/drizzle` in a source tree and on
 * `/app/src/core/drizzle` in the image, because the Dockerfile copies that directory.
 */
export function migrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
}

function readJournal(folder: string): JournalEntry[] {
  const raw = fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries?: JournalEntry[] }).entries ?? [];
}

/** The journal, with drizzle's own hash for each entry, after all three repository-side checks. */
function expectedMigrations(folder: string): ReadonlyArray<{ tag: string; when: number; hash: string }> {
  const entries = readJournal(folder);
  // Property 3, checked FIRST because it needs nothing and because drizzle's reader cannot see half
  // of it: readMigrationFiles loops over the JOURNAL's entries (drizzle-orm@0.45.2's
  // migrator.js:12-28), so it returns one entry per journal entry and an orphan .sql file is
  // invisible both to it and to any comparison of its length with the journal's.
  const onDisk = fs.readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
  const tags = entries.map((e) => e.tag);
  const orphans = onDisk.filter((tag) => !tags.includes(tag));
  const missing = tags.filter((tag) => !onDisk.includes(tag));
  if (orphans.length > 0 || missing.length > 0) {
    throw new Error(
      `${folder} disagrees with its journal: ${orphans.length} .sql file(s) with no journal entry ` +
      `[${orphans.join(", ")}] and ${missing.length} journal entry/entries with no .sql file ` +
      `[${missing.join(", ")}]. A migration runs only when the journal names it AND the file is ` +
      `there, so either half of this disagreement is a migration that never runs while the branch ` +
      `that added it expects the schema to have changed. Fix the repository, not the database ` +
      `(CONTRIBUTING.md, "Migrations").`);
  }
  // Property 1: strictly increasing in FILE order. Equal or decreasing is drift, and it is a
  // property of the repository, so it is the same answer on every machine and needs no database.
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!, cur = entries[i]!;
    if (cur.when <= prev.when) {
      throw new Error(
        `migration journal is not strictly increasing: entry ${i - 1} ${prev.tag} (when ${prev.when}) ` +
        `is followed by entry ${i} ${cur.tag} (when ${cur.when}). Regenerate ${cur.tag} so its stamp ` +
        `is the newest in the journal: delete its .sql file, its meta/_journal.json entry AND its ` +
        `meta/<NNNN>_snapshot.json, then re-run drizzle-kit generate ` +
        `(CONTRIBUTING.md, "Migrations").`);
    }
  }
  // The hash is drizzle's own reader's, not a digest reimplemented here, so what this compares is
  // by construction what the migrator would have inserted. It is matched to the journal by
  // `folderMillis` === `when`. The length comparison an earlier draft made here is GONE: it could
  // never fail, for the reason the inventory above gives, and it read as a check that it was not.
  const files = readMigrationFiles({ migrationsFolder: folder });
  const hashes = new Map(files.map((f) => [f.folderMillis, f.hash]));
  return entries.map((e) => {
    const hash = hashes.get(e.when);
    // Unreachable once the inventory and property 1 have passed; kept because a Map lookup is typed
    // as possibly undefined and a non-null assertion here would hide a future bug rather than fail.
    if (hash === undefined) throw new Error(`journal entry ${e.tag} (when ${e.when}) has no migration file in ${folder}`);
    return { tag: e.tag, when: e.when, hash };
  });
}

/**
 * What this database has had, validated against the journal. Throws when the two DISAGREE — a
 * journal whose `when` values are not strictly increasing, or a `__drizzle_migrations` table that
 * is not an exact prefix of it — naming the first mismatch. There is no status to report in that
 * case, only drift to fix.
 */
export async function migrationStatus(db: Db, folder: string = migrationsFolder()): Promise<MigrationStatus> {
  const expected = expectedMigrations(folder);
  // A probe that answers is clearer than an exception that has to be classified, and a null answer
  // is NOT drift: an empty prefix is a prefix.
  const probe = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') as present`);
  const rows = (probe as unknown as Array<{ present: string | null }>)[0]?.present == null
    ? []
    : (await db.execute(
        sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
      )) as unknown as Array<{ hash: string; created_at: string | number | null }>;
  // Property 2: the rows, ordered by created_at, are an exact (created_at, hash) prefix of the
  // journal. Anything else is drift, and a drift state has no status to report.
  if (rows.length > expected.length) {
    throw new Error(
      `the applied migrations are not a prefix of the journal: the database holds ${rows.length} ` +
      `rows for ${expected.length} journal entries in ${folder}`);
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!, want = expected[i]!;
    const when = Number(row.created_at);
    if (when !== want.when || row.hash !== want.hash) {
      throw new Error(
        `the applied migrations are not a prefix of the journal: at position ${i} the journal has ` +
        `${want.tag} (when ${want.when}, hash ${want.hash}) but the database holds ` +
        `(created_at ${row.created_at}, hash ${row.hash}). Fix the repository, not the database ` +
        `(CONTRIBUTING.md, "Migrations").`);
    }
  }
  // By POSITION, not by comparing timestamps: on a clean prefix that is the same set drizzle's own
  // rule selects, because a strictly increasing journal makes the two lines the same line.
  return {
    applied: expected.slice(0, rows.length).map((e) => e.tag),
    pending: expected.slice(rows.length).map((e) => e.tag),
  };
}

/**
 * Leading-keyword sequences that are refused, longest first so the message names the longest match.
 * The group is PostgreSQL's own set of transaction-control statements taken WHOLE, plus the
 * statements it documents as not runnable inside a transaction block. The optional noise words
 * (WORK, TRANSACTION) need no entries of their own because the match is on leading keywords.
 */
const LEADING: ReadonlyArray<readonly string[]> = [
  ["START", "TRANSACTION"], ["PREPARE", "TRANSACTION"], ["SET", "TRANSACTION"],
  ["ALTER", "SYSTEM"], ["CREATE", "DATABASE"], ["DROP", "DATABASE"], ["CREATE", "TABLESPACE"],
  ["BEGIN"], ["COMMIT"], ["END"], ["ROLLBACK"], ["ABORT"],
  ["SAVEPOINT"], ["RELEASE"], ["DISCARD"], ["VACUUM"],
];

/** One statement's identity: its code-state words, and the first line of its source for the message. */
type Statement = { readonly words: readonly string[]; readonly firstLine: string };

function offendingKeyword(words: readonly string[]): string | undefined {
  for (const seq of LEADING) if (seq.every((w, k) => words[k] === w)) return seq.join(" ");
  // Not a leading keyword: PostgreSQL refuses these three INSIDE a transaction block, and the word
  // that makes them illegal is CONCURRENTLY rather than the verb.
  if ((words[0] === "CREATE" || words[0] === "DROP" || words[0] === "REINDEX") && words.includes("CONCURRENTLY")) {
    return "CONCURRENTLY";
  }
  // Legal since PG 12, and still refused: the new label cannot be USED in the same transaction, and
  // drizzle puts the whole run in one. The guard cannot see whether a use follows (spec §5.1).
  if (words[0] === "ALTER" && words[1] === "TYPE") {
    for (let k = 2; k + 1 < words.length; k++) if (words[k] === "ADD" && words[k + 1] === "VALUE") return "ALTER TYPE ADD VALUE";
  }
  return undefined;
}

/**
 * Splits `text` into statements, collecting for each one only the characters seen in the CODE
 * state. A comment is only a comment in the code state; a `;` only ends a statement in the code
 * state; and a quoted run contributes nothing at all, so a keyword inside a string, an identifier,
 * a dollar body or a comment can neither be matched nor removed. A comment contributes ONE SPACE,
 * because PostgreSQL reads it as whitespace and two keywords either side of it are two keywords.
 */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let code = "";
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const words = code.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? [];
    if (words.length > 0) {
      const firstLine = text.slice(start, end).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      out.push({ words, firstLine });
    }
    code = "";
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "-" && next === "-") {                       // line comment, to the newline
      // A comment is WHITESPACE to PostgreSQL, so skipping it must leave a separator behind: remove
      // it and `ABORT--x` + `WORK` become the single word ABORTWORK, which matches nothing. The
      // scan stops AT the newline, so that newline is added as ordinary code on the next pass too.
      code += " ";
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {                       // block comment, nesting
      code += " ";                                         // the same separator: COMMIT/**/WORK
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth += 1; i += 2; continue; }
        if (text[i] === "*" && text[i + 1] === "/") { depth -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }
    if (c === "'") {                                       // single-quoted string
      // An E'...' literal takes backslash escapes; an ordinary one does not, and reading `\'` as an
      // escape there would extend the string over whatever followed it.
      const prev = text[i - 1];
      const beforePrev = text[i - 2];
      const escapes = (prev === "E" || prev === "e")
        && (beforePrev === undefined || !/[A-Za-z0-9_$]/.test(beforePrev));
      i += 1;
      while (i < text.length) {
        if (escapes && text[i] === "\\") { i += 2; continue; }
        if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '"') {                                       // double-quoted identifier
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') { if (text[i + 1] === '"') { i += 2; continue; } i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "$") {                                       // dollar-quoted body, tag-matched
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (open) {
        const tag = open[0];
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
        continue;
      }
    }
    if (c === ";") { flush(i); i += 1; start = i; continue; }
    code += c;
    i += 1;
  }
  flush(text.length);                                      // a trailing statement with no semicolon
  return out;
}

/**
 * Throws if `sqlText` contains a statement that would escape the single transaction `runMigrations`
 * applies a run inside. `file` is named in the message. A guard against accidents, not a SQL parser.
 */
export function assertTransactionSafe(sqlText: string, file: string): void {
  for (const st of statements(sqlText)) {
    const bad = offendingKeyword(st.words);
    if (bad === undefined) continue;
    throw new Error(
      `${file}: a migration may not contain ${bad} — it would break the single transaction a ` +
      `migration run is applied inside (CONTRIBUTING.md, "Migrations"). ` +
      `First line of the offending statement: ${st.firstLine}`);
  }
}

/** `assertTransactionSafe` over every pending file, before a single statement is applied. */
export function assertPendingTransactionSafe(pending: readonly string[], folder: string = migrationsFolder()): void {
  for (const tag of pending) {
    assertTransactionSafe(fs.readFileSync(path.join(folder, `${tag}.sql`), "utf8"), `${tag}.sql`);
  }
}
