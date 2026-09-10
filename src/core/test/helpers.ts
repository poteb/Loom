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
