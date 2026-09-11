import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

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
