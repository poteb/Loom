import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";
import { assertPendingTransactionSafe, migrationsFolder, migrationStatus } from "./migrations.js";

export type Db = ReturnType<typeof createDb>;
/** The handle `db.transaction(...)` hands its callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * Anything a read can run against: the connection pool, or an open transaction. Reads that a caller
 * may want inside one snapshot (the export) take this instead of `Db`.
 */
export type Queryable = Db | Tx;

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema, casing: "snake_case" });
}

/**
 * Applies whatever the database has not had, in ONE transaction, after refusing two things it must
 * never apply: a journal the database disagrees with (drizzle's own migrator would skip a
 * backdated entry silently) and a pending file that could break that transaction from inside.
 * `folder` is a parameter so a test can point both halves at a folder it wrote — every existing
 * caller passes nothing and is unchanged.
 */
export async function runMigrations(db: Db, folder: string = migrationsFolder()): Promise<void> {
  const status = await migrationStatus(db, folder);
  // Over the WHOLE pending set before anything is applied: a refusal halfway through a run is the
  // outcome the guard exists to prevent.
  assertPendingTransactionSafe(status.pending, folder);
  await migrate(db, { migrationsFolder: folder });
}

export async function closeDb(db: Db): Promise<void> {
  await (db.$client as ReturnType<typeof postgres>).end();
}

export { schema };
