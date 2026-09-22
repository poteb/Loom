import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  assertPendingTransactionSafe, assertTransactionSafe, closeDb, createDb, migrationStatus,
  migrationsFolder, runMigrations, type Db,
} from "@loom/core";
import { startPgContainer } from "./pg-container.js";

/**
 * Spec §11.1 cases 1 to 12: what `migrationStatus` reports, what it calls drift, and what
 * `assertTransactionSafe` refuses.
 *
 * The container is this suite's own (`./pg-container.ts`), because the first cases need a database
 * with NO migrations applied and the shared global-setup one is migrated by `freshDb()`. **Every
 * case that needs a fresh database gets one by `create database` off the container's admin
 * connection** — this file never drops or recreates schemas — and the names end in `_test` so they
 * would satisfy the truncate guard's allow-list if they ever met it.
 *
 * HONESTY NOTE, for whoever adds the next case: these cases pin the LEXICAL states of spec §5.1 and
 * passing them does not make the guard a PostgreSQL parser. A `DO` block that issues `COMMIT`
 * through `EXECUTE`, a statement assembled from a table, an include directive — none of those are
 * seen, and none of them are meant to be. This is a guard against accidents.
 */

let container: StartedPostgreSqlContainer;
/** The container's own database: used to `create database`, and as the handle for cases that read none. */
let admin: Db;
const openDbs: Db[] = [];
const tempFolders: string[] = [];
let dbSeq = 0;

beforeAll(async () => {
  container = await startPgContainer();
  admin = createDb(container.getConnectionUri());
  openDbs.push(admin);
}, 180_000);

afterAll(async () => {
  // A rejecting closeDb must not strand the container or the temp folders: the cleanup that costs
  // something outside this process runs whatever the handles do.
  try {
    for (const db of openDbs) await closeDb(db);
  } finally {
    await container?.stop();
    for (const dir of tempFolders) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A database of this container's own with nothing applied to it. */
async function freshDatabase(): Promise<Db> {
  const name = `migrations${++dbSeq}_test`;
  await admin.execute(sql.raw(`create database "${name}"`));
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  openDbs.push(db);
  return db;
}

/**
 * A migrations folder of the test's own: `meta/_journal.json` plus one `.sql` per entry, in the
 * shape drizzle-kit produces. `runMigrations` and `migrationStatus` both take a folder since this
 * change (spec §11.1), which is the only reason a case can describe a journal that the repository
 * would never contain. The directory is remembered so `afterAll` can remove it.
 */
function writeFolder(entries: ReadonlyArray<{ tag: string; when: number; sql: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-migrations-"));
  tempFolders.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "postgresql",
    entries: entries.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })),
  }));
  for (const e of entries) fs.writeFileSync(path.join(dir, `${e.tag}.sql`), e.sql);
  return dir;
}

/**
 * A journal and a set of `.sql` files written INDEPENDENTLY of each other. `fileTags` is exactly
 * the set of files that exist; each holds valid DDL, because what these cases are about is the
 * folder disagreeing with its journal and nothing else.
 */
function writeFolderRaw(
  entries: ReadonlyArray<{ tag: string; when: number }>,
  fileTags: readonly string[],
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-migrations-"));
  tempFolders.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "postgresql",
    entries: entries.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })),
  }));
  for (const tag of fileTags) fs.writeFileSync(path.join(dir, `${tag}.sql`), `create table t_${tag} (id int);`);
  return dir;
}

/** The real journal, as written on disk. */
const JOURNAL_ENTRIES: ReadonlyArray<{ tag: string; when: number }> = (
  JSON.parse(fs.readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as
    { entries: ReadonlyArray<{ tag: string; when: number }> }
).entries;

/** The real journal's tags, in the journal's order. */
const JOURNAL_TAGS: readonly string[] = JOURNAL_ENTRIES.map((e) => e.tag);

/**
 * The real migrations folder with its last `drop` entries removed: the same `.sql` bytes and the
 * same journal stamps, so the rows a full `runMigrations` inserted stay a valid prefix of it and
 * the only difference is that the database holds MORE rows than the journal has entries.
 */
function writeTruncatedRealFolder(drop: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-migrations-"));
  tempFolders.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  const kept = JOURNAL_ENTRIES.slice(0, JOURNAL_ENTRIES.length - drop);
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({
    version: "7", dialect: "postgresql",
    entries: kept.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })),
  }));
  for (const e of kept) {
    fs.copyFileSync(path.join(migrationsFolder(), `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

async function regclass(db: Db, name: string): Promise<string | null> {
  const rows = await db.execute(sql`select to_regclass(${name}) as present`);
  return (rows as unknown as Array<{ present: string | null }>)[0]?.present ?? null;
}

async function migrationRows(db: Db): Promise<Array<{ hash: string; created_at: string }>> {
  return (await db.execute(
    sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
  )) as unknown as Array<{ hash: string; created_at: string }>;
}

/** The message of an expected rejection; fails the test when the call resolves instead. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection, but the call resolved");
}

/** The file name every unit case of the guard reports against. */
const FILE = "0006_x.sql";

/** The message of an expected refusal; fails the test when the guard accepts instead. */
function refusal(text: string): string {
  try {
    assertTransactionSafe(text, FILE);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`assertTransactionSafe accepted ${JSON.stringify(text)}`);
}

/** Asserts the guard accepts `text`, which is how the look-alike cases are written. */
function accepts(text: string): void {
  expect(() => assertTransactionSafe(text, FILE)).not.toThrow();
}

describe("migrationStatus against the real migrations", () => {
  it("case 1: a fresh database lists every journal entry as pending and nothing as applied", async () => {
    const db = await freshDatabase();
    const status = await migrationStatus(db);
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual(JOURNAL_TAGS);
    // The probe of §5.1 answering: this is the "nothing applied" branch, not an empty table.
    expect(await regclass(db, "drizzle.__drizzle_migrations")).toBeNull();
  });

  it("case 2: applying moves every journal entry across", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    const status = await migrationStatus(db);
    expect(status.applied).toEqual(JOURNAL_TAGS);
    expect(status.pending).toEqual([]);
  });

  it("case 3: a second run applies nothing", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    const before = (await migrationRows(db)).length;
    await runMigrations(db);
    expect((await migrationStatus(db)).pending).toEqual([]);
    expect((await migrationRows(db)).length).toBe(before);
  });

  it("case 4: a clean prefix reports the remaining tags applied and the deleted one pending", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    // Deleted, not inserted: the rows that REMAIN carry drizzle's own created_at and hash, so a
    // passing case proves migrationStatus computes the same pair drizzle inserted.
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`);
    const status = await migrationStatus(db);
    expect(status.applied).toEqual(JOURNAL_TAGS.slice(0, -1));
    expect(status.pending).toEqual(JOURNAL_TAGS.slice(-1));
  });

  it("case 6a: a row whose hash is not the journal file's is drift, named at its position", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`);
    const rows = await migrationRows(db);
    const bogus = "a".repeat(64);
    await db.execute(sql`update drizzle.__drizzle_migrations set hash = ${bogus} where created_at = ${rows[2]!.created_at}`);
    const message = await rejectionMessage(migrationStatus(db));
    expect(message).toContain("position 2");
    expect(message).toContain(JOURNAL_TAGS[2]!);
    expect(message).toContain(bogus);
  });

  it("case 6b: a gap in the middle is drift, named at the first mismatching position", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`);
    const rows = await migrationRows(db);
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${rows[1]!.created_at}`);
    const message = await rejectionMessage(migrationStatus(db));
    expect(message).toContain("position 1");
    expect(message).toContain(JOURNAL_TAGS[1]!);
    // What the row at that position actually held: entry 2's stamp, now sitting at position 1.
    expect(message).toContain(String(rows[2]!.created_at));
  });

  it("a database ahead of the journal is drift, and the message carries the remedy", async () => {
    const db = await freshDatabase();
    await runMigrations(db);
    // The checkout an older branch would give: every applied row is still a valid prefix, there are
    // simply more of them than the journal has entries.
    const folder = writeTruncatedRealFolder(1);
    const message = await rejectionMessage(migrationStatus(db, folder));
    expect(message).toContain(`the database holds ${JOURNAL_TAGS.length} rows for ${JOURNAL_TAGS.length - 1} journal entries`);
    expect(message).toContain("The database is ahead of this checkout");
    expect(message).toContain("pull or merge the branch that added them");
    expect(message).toContain(`fix the repository, not the database (CONTRIBUTING.md, "Migrations")`);
  });
});

describe("a journal that disagrees with itself or with its folder", () => {
  it("case 5: a backdated entry appended after a newer one is drift, and runMigrations applies nothing", async () => {
    const folder = writeFolder([
      { tag: "0000_y", when: 200, sql: "create table t_y (id int);" },
      { tag: "0001_x", when: 150, sql: "create table t_x (id int);" },
    ]);
    const db = await freshDatabase();
    const message = await rejectionMessage(migrationStatus(db, folder));
    expect(message).toContain("0000_y");
    expect(message).toContain("200");
    expect(message).toContain("0001_x");
    expect(message).toContain("150");
    await rejectionMessage(runMigrations(db, folder));
    expect(await regclass(db, "public.t_y")).toBeNull();
    expect(await regclass(db, "public.t_x")).toBeNull();
  });

  it("case 7: a duplicate when is drift, naming both entries", async () => {
    const folder = writeFolder([
      { tag: "0000_a", when: 100, sql: "create table t_a (id int);" },
      { tag: "0001_b", when: 100, sql: "create table t_b (id int);" },
    ]);
    // No database is read: the journal is a property of the repository.
    const message = await rejectionMessage(migrationStatus(admin, folder));
    expect(message).toContain("0000_a");
    expect(message).toContain("0001_b");
  });

  it("case 12a: an orphan .sql file with no journal entry is drift, and nothing is applied", async () => {
    const folder = writeFolderRaw([{ tag: "0000_a", when: 100 }], ["0000_a", "0001_orphan"]);
    const db = await freshDatabase();
    expect(await rejectionMessage(migrationStatus(db, folder))).toContain("0001_orphan");
    expect(await rejectionMessage(runMigrations(db, folder))).toContain("0001_orphan");
    expect(await regclass(db, "public.t_0000_a")).toBeNull();
  });

  it("case 12b: a journal entry with no .sql file is drift, refused by this check rather than by drizzle", async () => {
    const folder = writeFolderRaw([{ tag: "0000_a", when: 100 }, { tag: "0001_b", when: 200 }], ["0000_a"]);
    const db = await freshDatabase();
    const message = await rejectionMessage(migrationStatus(db, folder));
    expect(message).toContain("0001_b");
    expect(message).toContain("disagrees with its journal");
    const runMessage = await rejectionMessage(runMigrations(db, folder));
    expect(runMessage).toContain("0001_b");
    expect(runMessage).toContain("disagrees with its journal");
    // Not drizzle's "No file <path> found in <folder> folder", which names neither the journal nor
    // the remedy.
    expect(runMessage).not.toContain("No file");
    expect(await regclass(db, "public.t_0000_a")).toBeNull();
  });
});

describe("what a run applies, and what it refuses to start", () => {
  it("case 8: a failing migration leaves the schema unchanged", async () => {
    const folder = writeFolder([
      { tag: "0000_good", when: 100, sql: "create table t_good (id int);" },
      {
        tag: "0001_bad", when: 200, sql: `create table t_bad (id int);
select nonexistent_function();`,
      },
    ]);
    const db = await freshDatabase();
    await rejectionMessage(runMigrations(db, folder));
    expect(await regclass(db, "public.t_good")).toBeNull();
    expect(await regclass(db, "public.t_bad")).toBeNull();
    // The migrator creates the schema and the table BEFORE the transaction opens, so that table is
    // allowed to exist; what must not exist is a row for either entry.
    const stamps = (await regclass(db, "drizzle.__drizzle_migrations")) === null
      ? []
      : (await migrationRows(db)).map((r) => String(r.created_at));
    expect(stamps).not.toContain("100");
    expect(stamps).not.toContain("200");
  });

  it("case 9: assertTransactionSafe accepts every real migration file", () => {
    const folder = migrationsFolder();
    expect(fs.existsSync(folder)).toBe(true);
    const files = fs.readdirSync(folder).filter((name) => name.endsWith(".sql"));
    // Discovered rather than listed, so a migration merged next month is covered; non-empty, so a
    // resolution bug cannot make this case pass by testing nothing.
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      assertTransactionSafe(fs.readFileSync(path.join(folder, name), "utf8"), name);
    }
  });

  it("case 9: runMigrations refuses the whole pending set before it applies anything", async () => {
    const folder = writeFolder([
      { tag: "0000_first", when: 100, sql: "create table t_first (id int);" },
      {
        tag: "0001_commits", when: 200, sql: `create table t_two (id int);
COMMIT;
create table t_three (id int);`,
      },
    ]);
    const db = await freshDatabase();
    const message = await rejectionMessage(runMigrations(db, folder));
    expect(message).toContain("0001_commits.sql");
    expect(message).toContain("may not contain COMMIT");
    expect(await regclass(db, "public.t_first")).toBeNull();
  });

  it("case 10: the enclosing transaction holds over a file the guard accepted", async () => {
    const folder = writeFolder([{
      tag: "0000_enclosed", when: 100, sql: `create table t_enclosed (id int);
select nonexistent_function();`,
    }]);
    const db = await freshDatabase();
    await rejectionMessage(runMigrations(db, folder));
    expect(await regclass(db, "public.t_enclosed")).toBeNull();
  });

  it("case 10: the same file with an ABORT is refused before anything runs", async () => {
    const folder = writeFolder([{
      tag: "0000_enclosed", when: 100, sql: `create table t_enclosed (id int);
ABORT;
select nonexistent_function();`,
    }]);
    const db = await freshDatabase();
    const message = await rejectionMessage(runMigrations(db, folder));
    expect(message).toContain("0000_enclosed.sql");
    expect(message).toContain("may not contain ABORT");
    expect(await regclass(db, "public.t_enclosed")).toBeNull();
  });
});

/**
 * Spec §5.1's table, one entry per spelling, with the keyword the message must name. The list is
 * taken from the table rather than from the implementation, so the test and the guard name the same
 * string.
 */
const REJECTED: ReadonlyArray<{ statement: string; keyword: string }> = [
  { statement: "BEGIN;", keyword: "BEGIN" },
  { statement: "BEGIN WORK;", keyword: "BEGIN" },
  { statement: "BEGIN TRANSACTION;", keyword: "BEGIN" },
  { statement: "START TRANSACTION;", keyword: "START TRANSACTION" },
  { statement: "COMMIT;", keyword: "COMMIT" },
  { statement: "COMMIT WORK;", keyword: "COMMIT" },
  { statement: "COMMIT TRANSACTION;", keyword: "COMMIT" },
  { statement: "END;", keyword: "END" },
  { statement: "END WORK;", keyword: "END" },
  { statement: "END TRANSACTION;", keyword: "END" },
  { statement: "ROLLBACK;", keyword: "ROLLBACK" },
  { statement: "ROLLBACK WORK;", keyword: "ROLLBACK" },
  { statement: "ROLLBACK TRANSACTION;", keyword: "ROLLBACK" },
  { statement: "ABORT;", keyword: "ABORT" },
  { statement: "ROLLBACK TO s1;", keyword: "ROLLBACK" },
  { statement: "ROLLBACK TO SAVEPOINT s1;", keyword: "ROLLBACK" },
  { statement: "SAVEPOINT s1;", keyword: "SAVEPOINT" },
  { statement: "RELEASE SAVEPOINT s1;", keyword: "RELEASE" },
  { statement: "PREPARE TRANSACTION 'gid';", keyword: "PREPARE TRANSACTION" },
  { statement: "COMMIT PREPARED 'gid';", keyword: "COMMIT" },
  { statement: "ROLLBACK PREPARED 'gid';", keyword: "ROLLBACK" },
  { statement: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;", keyword: "SET TRANSACTION" },
  { statement: "SET TRANSACTION SNAPSHOT '000003A1-1';", keyword: "SET TRANSACTION" },
  { statement: "DISCARD ALL;", keyword: "DISCARD" },
  { statement: "DISCARD PLANS;", keyword: "DISCARD" },
  { statement: "CREATE INDEX CONCURRENTLY i ON t (c);", keyword: "CONCURRENTLY" },
  { statement: "DROP INDEX CONCURRENTLY i;", keyword: "CONCURRENTLY" },
  { statement: "REINDEX INDEX CONCURRENTLY i;", keyword: "CONCURRENTLY" },
  { statement: "REFRESH MATERIALIZED VIEW CONCURRENTLY mv;", keyword: "CONCURRENTLY" },
  { statement: "ALTER TABLE t DETACH PARTITION p CONCURRENTLY;", keyword: "CONCURRENTLY" },
  { statement: "VACUUM;", keyword: "VACUUM" },
  { statement: "CREATE DATABASE d;", keyword: "CREATE DATABASE" },
  { statement: "DROP DATABASE d;", keyword: "DROP DATABASE" },
  { statement: "ALTER SYSTEM SET work_mem = '4MB';", keyword: "ALTER SYSTEM" },
  { statement: "CREATE TABLESPACE ts LOCATION '/x';", keyword: "CREATE TABLESPACE" },
  { statement: "ALTER TYPE mood ADD VALUE 'ok';", keyword: "ALTER TYPE ADD VALUE" },
];

describe("case 10: assertTransactionSafe rejects each form on §5.1's table", () => {
  it.each(REJECTED)("refuses $statement naming $keyword", ({ statement, keyword }) => {
    // The four shapes a real file would carry it in: as written, in the other casing, after leading
    // whitespace and a comment, and after drizzle's own statement-breakpoint marker.
    const shapes = [
      statement,
      statement.toLowerCase(),
      `  -- a preceding comment
  ${statement}`,
      `create table t (id int);
--> statement-breakpoint
${statement}`,
    ];
    for (const shape of shapes) {
      const message = refusal(shape);
      expect(message).toContain(FILE);
      expect(message).toContain(`may not contain ${keyword}`);
    }
  });
});

describe("case 10: the look-alikes the guard must not refuse", () => {
  it("accepts CASE ... END, a DO block, comments, literals and quoted identifiers", () => {
    accepts("SELECT CASE WHEN x THEN 1 ELSE 2 END FROM t;");
    accepts("DO $$ BEGIN RAISE NOTICE 'x'; END $$;");
    accepts("-- commit this later");
    accepts("/* BEGIN */");
    accepts("INSERT INTO t (c) VALUES ('commit');");
    accepts("CREATE INDEX i ON t (c);");
    accepts(`ALTER TABLE t RENAME COLUMN "end" TO c;`);
    accepts(`CREATE TABLE "commit" (id int);`);
  });

  it("accepts the two CONCURRENTLY forms' look-alikes, which carry no CONCURRENTLY", () => {
    accepts("REFRESH MATERIALIZED VIEW mv;");
    accepts("ALTER TABLE t DETACH PARTITION p;");
  });

  it("accepts a quoted form holding a comment opener when nothing follows it", () => {
    accepts("INSERT INTO t(c) VALUES ('-- commit');");
    accepts("SELECT $$ commit; $$;");
  });
});

/**
 * A comment opener inside a quoted form is CONTENT: a scan that treated it as a comment would
 * delete the statement the guard exists to find. Both openers, all four quoted forms.
 */
const COMMENT_OPENER_IN_A_LITERAL: readonly string[] = [
  "INSERT INTO t(c) VALUES ('--'); COMMIT; DROP TABLE events;",
  "INSERT INTO t(c) VALUES ('/*'); COMMIT; DROP TABLE events;",
  `ALTER TABLE t RENAME COLUMN "--" TO c; COMMIT; DROP TABLE events;`,
  `ALTER TABLE t RENAME COLUMN "/*" TO c; COMMIT; DROP TABLE events;`,
  "SELECT $$--$$; COMMIT; DROP TABLE events;",
  "SELECT $$/*$$; COMMIT; DROP TABLE events;",
  "SELECT $tag$--$tag$; COMMIT; DROP TABLE events;",
  "SELECT $tag$/*$tag$; COMMIT; DROP TABLE events;",
];

describe("case 10: a comment opener inside a quoted form hides nothing", () => {
  it.each(COMMENT_OPENER_IN_A_LITERAL)("still refuses the COMMIT in %s", (statement) => {
    const message = refusal(statement);
    expect(message).toContain(FILE);
    expect(message).toContain("may not contain COMMIT");
  });
});

/** The quoting edges the scanner's states exist for, each immediately before a COMMIT. */
const QUOTING_EDGES: readonly string[] = [
  `INSERT INTO t(c) VALUES ('it''s --'); COMMIT; DROP TABLE events;`,
  `INSERT INTO t(c) VALUES (E'a\\'b --'); COMMIT; DROP TABLE events;`,
  `ALTER TABLE t RENAME COLUMN "a""b --" TO c; COMMIT; DROP TABLE events;`,
  `SELECT $body$ a $$ b --$body$; COMMIT; DROP TABLE events;`,
];

describe("case 10: the quoting edges", () => {
  it.each(QUOTING_EDGES)("still refuses the COMMIT in %s", (statement) => {
    const message = refusal(statement);
    expect(message).toContain(FILE);
    expect(message).toContain("may not contain COMMIT");
  });
});

describe("case 10: nested block comments", () => {
  it("leaves the scan inside the outer comment when an inner one closes", () => {
    const message = refusal("/* outer /* inner */ COMMIT; */ BEGIN;");
    expect(message).toContain("may not contain BEGIN");
    expect(message).not.toContain("may not contain COMMIT");
  });

  it("does not swallow what follows a closed comment", () => {
    expect(refusal("/* a */ COMMIT;")).toContain("may not contain COMMIT");
  });
});

/** Case 11: PostgreSQL reads a comment as whitespace, so the two keywords either side are two. */
const SEPARATED_BY_A_COMMENT: ReadonlyArray<{ statement: string; keyword: string }> = [
  { statement: "COMMIT/**/WORK;", keyword: "COMMIT" },
  { statement: "ROLLBACK/* x */TO SAVEPOINT s;", keyword: "ROLLBACK" },
  { statement: "END/**/TRANSACTION;", keyword: "END" },
  { statement: "CREATE INDEX/**/CONCURRENTLY i ON t (c);", keyword: "CONCURRENTLY" },
  {
    statement: `ABORT--x
WORK;`, keyword: "ABORT",
  },
];

describe("case 11: a comment between two keywords does not join them", () => {
  it.each(SEPARATED_BY_A_COMMENT)("refuses $statement naming $keyword", ({ statement, keyword }) => {
    const message = refusal(statement);
    expect(message).toContain(FILE);
    expect(message).toContain(`may not contain ${keyword}`);
  });

  it("accepts a comment inside a statement whose leading keyword is not on the table", () => {
    accepts("ALTER TABLE t/* comment */RENAME COLUMN a TO b;");
    accepts("INSERT INTO t(c)/**/VALUES ('commit');");
    accepts("SELECT CASE WHEN x THEN 1 ELSE 2 END/**/FROM t;");
  });
});

describe("the located first line is the offending statement's own", () => {
  it("names the statement, not drizzle's breakpoint marker or a preceding comment", () => {
    // Every drizzle-generated file separates statements with this marker, so a locator that started
    // at the previous `;` would print the marker on almost every real refusal.
    expect(refusal(`create table t (id int);
--> statement-breakpoint
COMMIT;`)).toContain("First line of the offending statement: COMMIT;");
    expect(refusal(`  -- a preceding comment
  COMMIT;`)).toContain("First line of the offending statement: COMMIT;");
  });
});

describe("assertPendingTransactionSafe over a folder's pending files", () => {
  it("refuses the pending set, naming the unsafe file", () => {
    const folder = writeFolder([
      { tag: "0000_safe", when: 100, sql: "create table t_safe (id int);" },
      { tag: "0001_unsafe", when: 200, sql: "create table t_two (id int);\nCOMMIT;" },
    ]);
    let message: string | undefined;
    try {
      assertPendingTransactionSafe(["0000_safe", "0001_unsafe"], folder);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, "assertPendingTransactionSafe accepted an unsafe pending set").toBeDefined();
    expect(message).toContain("0001_unsafe.sql");
    expect(message).toContain("may not contain COMMIT");
    expect(message).not.toContain("0000_safe.sql");
  });

  it("returns when every pending file is safe", () => {
    const folder = writeFolder([
      { tag: "0000_safe", when: 100, sql: "create table t_safe (id int);" },
      { tag: "0001_also_safe", when: 200, sql: "create index i on t_safe (id);" },
    ]);
    expect(() => assertPendingTransactionSafe(["0000_safe", "0001_also_safe"], folder)).not.toThrow();
  });
});
