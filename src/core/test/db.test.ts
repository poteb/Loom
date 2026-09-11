import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { freshDb, closeTestDb } from "./helpers.js";

afterAll(closeTestDb);

describe("migrations", () => {
  it("creates all tables", async () => {
    const db = await freshDb();
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["weaves", "threads", "participants", "keepers", "settings", "events"]) {
      expect(names).toContain(t);
    }
  });
});
