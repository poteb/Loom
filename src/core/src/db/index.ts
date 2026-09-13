import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

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

export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../drizzle",
  );
  await migrate(db, { migrationsFolder });
}

export async function closeDb(db: Db): Promise<void> {
  await (db.$client as ReturnType<typeof postgres>).end();
}

export { schema };
