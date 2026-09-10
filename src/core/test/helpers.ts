import { sql } from "drizzle-orm";
import { createDb, runMigrations, closeDb, type Db } from "../src/db/index.js";

let db: Db | undefined;
let migrated = false;

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set (global setup missing?)");
  db ??= createDb(url);
  if (!migrated) { await runMigrations(db); migrated = true; }
  await db.execute(sql`truncate events, participants, threads, weaves, keepers, settings restart identity cascade`);
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
