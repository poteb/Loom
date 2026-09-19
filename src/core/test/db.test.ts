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

  it("v2 columns and tables exist after migration", async () => {
    const db = await freshDb();
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'threads' and column_name = 'url'`);
    expect(cols.length).toBe(1);
    const agents = await db.execute(sql`select column_name from information_schema.columns where table_name = 'agents' order by column_name`);
    expect(agents.map((r: Record<string, unknown>) => r.column_name)).toEqual(["created_at", "id", "key_hash", "name", "revoked_at"]);
    const pcol = await db.execute(sql`select column_name from information_schema.columns where table_name = 'participants' and column_name = 'agent_id'`);
    expect(pcol.length).toBe(1);
  });

  // Existence alone would pass just as happily on the wrong operator class or a full index: the
  // listeners query is planned against `capabilities @> …`, which only `jsonb_path_ops` serves, and
  // the partial predicate is what keeps the index to the listeners.
  it("indexes participants.capabilities with a partial jsonb_path_ops GIN index", async () => {
    const db = await freshDb();
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'participants' and indexname = 'participants_capabilities_idx'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.indexdef).toContain("USING gin");
    expect(rows[0]!.indexdef).toContain("jsonb_path_ops");
    expect(rows[0]!.indexdef).toContain("WHERE (capabilities IS NOT NULL)");
  });
});
