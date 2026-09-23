import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { freshDb, closeTestDb } from "./helpers.js";
import { newId } from "../src/ids.js";

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
    expect(agents.map((r: Record<string, unknown>) => r.column_name)).toEqual(["created_at", "id", "key_hash", "name", "owner", "revoked_at"]);
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

  // The index's existence says nothing about whether anything uses it. This is the test that fails
  // if a listener predicate is ever written against `capabilities->'tools'` instead of
  // `capabilities` itself: a GIN index serves only the expression it indexes, so the plan would
  // quietly become a scan with a filter and every functional test would still pass.
  it("plans the listener filters through participants_capabilities_idx", async () => {
    const db = await freshDb();
    const weaveId = newId();
    await db.execute(sql`insert into weaves (id, secret, title) values (${weaveId}, 'plan-test-secret', 'Plan')`);
    // `pad` makes a profile the size a real one is (up to 4000 characters, `MAX_PROFILE_LENGTH`),
    // which is what makes the heap the cost of the alternative plan: reading every listener of the
    // Lobby through the `(weave_id, …)` btree and testing containment per row.
    await db.execute(sql`
      insert into participants (id, weave_id, name, kind, token, capabilities)
      select gen_random_uuid(), ${weaveId}, 'p' || g, 'agent', 'plan-test-token-' || g,
             jsonb_build_object(
               'owner', 'o' || (g % 50),
               'runtime', 'rt' || (g % 17),
               'pad', repeat('x', 1200),
               'tools', jsonb_build_array('t' || (g % 19), 'shell'),
               'models', jsonb_build_array(jsonb_build_object('model', 'm' || (g % 23), 'effort', 'high')))
      from generate_series(1, 3000) g`);
    const predicates = [
      sql`p.capabilities @> '{"tools":["t7"]}'::jsonb`,
      sql`p.capabilities @> '{"models":[{"model":"m5"}]}'::jsonb`,
      sql`p.capabilities @> '{"runtime":"rt3"}'::jsonb`,
    ];
    await db.transaction(async (tx) => {
      // `ANALYZE` so the planner has statistics rather than defaults, and `SET LOCAL enable_seqscan`
      // so a planner that *could* use the index must — both revert with the transaction. The
      // assertion is on the plan text, never on a duration, so this is not a performance test.
      await tx.execute(sql`analyze participants`);
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const predicate of predicates) {
        const plan = await tx.execute<Record<string, string>>(sql`
          explain select p.id from participants p
          where p.weave_id = ${weaveId} and p.capabilities is not null and ${predicate}`);
        expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("participants_capabilities_idx");
      }
    });
  });
});
