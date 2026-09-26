import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import { events, readPositions as positions, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { assertParticipantOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor } from "./types.js";

/*
 * Read positions (spec 2026-09-26 §4): the highest seq of the Weave's log a participant has read in
 * a Thread. A read is not news: nothing here appends an event, takes a Weave lock or publishes on the
 * bus, and the row is independent of the log. Every call is the actor's own; no participant id is
 * ever taken, so nobody reads or writes another participant's positions.
 */

export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
/** The actor's positions in one Weave, by Thread id, and the seq of its own `participant.joined`. */
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };

/** The Weave a read-position call names: `weave_not_found` for a malformed or unknown id, before any authority check. */
export async function weaveForRead(q: Queryable, weaveId: string): Promise<{ id: string; lastSeq: number }> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const [w] = await q.select({ id: weaves.id, lastSeq: weaves.lastSeq })
    .from(weaves).where(eq(weaves.id, weaveId)).limit(1);
  if (!w) throw errors.weaveNotFound();
  return w;
}

/** The one write rule (§4.1 step 5): insert, or raise the stored seq when the new one is greater. Never lower it. */
function upsertPositions(db: Db, rows: { participantId: string; threadId: string; seq: number }[]) {
  return db.insert(positions).values(rows).onConflictDoUpdate({
    target: [positions.participantId, positions.threadId],
    set: { seq: sql`excluded.seq`, updatedAt: sql`now()` },
    setWhere: sql`${positions.seq} < excluded.seq`,
  });
}

/** §4.1. A closed Thread, and a Thread of an archived Weave, may be marked read. Answers the stored seq, which may be greater than `seq`. */
export async function markRead(db: Db, actor: Actor, threadId: string, seq: number): Promise<MarkReadResult> {
  const t = await getThread(db, threadId);
  const me = assertParticipantOf(actor, t.weaveId);
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) throw errors.validation("seq must be a non-negative integer");
  const w = await weaveForRead(db, t.weaveId);
  if (seq > w.lastSeq) throw errors.validation("seq is past the Weave's newest event");
  const [raised] = await upsertPositions(db, [{ participantId: me.id, threadId, seq }]).returning({ seq: positions.seq });
  if (raised) return { threadId, seq: raised.seq };
  // The stored position was already at least `seq`, so the update was skipped: answer what stands.
  const [kept] = await db.select({ seq: positions.seq }).from(positions)
    .where(and(eq(positions.participantId, me.id), eq(positions.threadId, threadId))).limit(1);
  return { threadId, seq: kept!.seq };
}

/**
 * §4.2. Allowed on an archived Weave. One statement, so one snapshot and one implicit transaction:
 * `last_seq` and the Weave's Threads, open and closed, are sampled together, and every one of those
 * Threads is raised to that `last_seq` by the rule of `upsertPositions`. A Thread is therefore never
 * counted at a seq taken before it existed. `afterChecks` is a test seam, run after the authority
 * checks and before the sample.
 */
export async function markAllRead(db: Db, actor: Actor, weaveId: string,
  opts: { afterChecks?: () => Promise<void> } = {}): Promise<MarkAllReadResult> {
  await weaveForRead(db, weaveId);
  const me = assertParticipantOf(actor, weaveId);
  if (opts.afterChecks) await opts.afterChecks();
  const [row] = await db.execute<{ seq: number; threads: number }>(sql`
    WITH w AS (SELECT last_seq FROM weaves WHERE id = ${weaveId}),
    t AS (SELECT id FROM threads WHERE weave_id = ${weaveId}),
    raised AS (
      INSERT INTO read_positions (participant_id, thread_id, seq)
      SELECT ${me.id}::uuid, t.id, w.last_seq FROM t, w
      ON CONFLICT (participant_id, thread_id)
      DO UPDATE SET seq = excluded.seq, updated_at = now() WHERE read_positions.seq < excluded.seq
    )
    SELECT w.last_seq AS seq, (SELECT count(*) FROM t)::int AS threads FROM w`);
  return { seq: row!.seq, threads: row!.threads };
}

/** §4.3. Allowed on an archived Weave. A participant belongs to one Weave, so its rows are that Weave's. */
export async function readPositions(db: Db, actor: Actor, weaveId: string): Promise<ReadPositions> {
  await weaveForRead(db, weaveId);
  const me = assertParticipantOf(actor, weaveId);
  const rows = await db.select({ threadId: positions.threadId, seq: positions.seq }).from(positions)
    .where(eq(positions.participantId, me.id));
  const [joined] = await db.select({ seq: events.seq }).from(events)
    .where(and(eq(events.weaveId, weaveId), eq(events.type, "participant.joined"),
      sql`${events.payload}->>'participantId' = ${me.id}`))
    .orderBy(asc(events.seq)).limit(1);
  return { joinedSeq: joined?.seq ?? 0, threads: Object.fromEntries(rows.map((r) => [r.threadId, r.seq])) };
}
