import { sql } from "drizzle-orm";
import { createDb, runMigrations, closeDb, type Db } from "../src/db/index.js";
import { isProtectedDatabase } from "./db-guard.js";

let db: Db | undefined;
let migrated = false;

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set (global setup missing?)");
  // Belt-and-braces: freshDb() truncates every table, so never let it run against the real
  // application database. A developer who explicitly set TEST_DATABASE_URL themselves is trusted.
  if (isProtectedDatabase(url) && !process.env.LOOM_TEST_DATABASE_URL_USER_SET) {
    throw new Error(
      `refusing to run tests against protected database (TEST_DATABASE_URL=${url}); ` +
      "this looks like the compose application database, and freshDb() truncates every table. " +
      "Set TEST_DATABASE_URL explicitly if this is really what you want.",
    );
  }
  db ??= createDb(url);
  if (!migrated) { await runMigrations(db); migrated = true; }
  await db.execute(sql`truncate events, participants, threads, weaves, keepers, settings, agents restart identity cascade`);
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (db) { await closeDb(db); db = undefined; migrated = false; }
}

/**
 * A well-formed keeper token (43-char base64url, see KEEPER_TOKEN_RE) derived from `label`.
 * `seedKeepers` ignores anything that is not shaped like a real token.
 */
export function keeperToken(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, "-").padEnd(43, "0").slice(0, 43);
}
