import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import type { EventBus } from "./bus.js";
import type { EventType, LoomEvent } from "./types.js";

export type NewEvent = { threadId: string; type: EventType; actor: string; payload: Record<string, unknown> };
export type WeaveRow = typeof weaves.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function toEvent(r: typeof events.$inferSelect): LoomEvent {
  return {
    weaveId: r.weaveId, seq: r.seq, threadId: r.threadId, type: r.type as EventType,
    actor: r.actor, at: r.at.toISOString(), payload: r.payload as Record<string, unknown>,
  };
}

/**
 * Appends events for a weave whose row is already locked in `tx`.
 * Assigns seq = weave.lastSeq+1.. and advances weaves.last_seq. Mutates weave.lastSeq.
 */
export async function appendInTx(tx: Tx, weave: { id: string; lastSeq: number }, news: NewEvent[]): Promise<LoomEvent[]> {
  if (news.length === 0) return [];
  const rows = news.map((n, i) => ({
    weaveId: weave.id, seq: weave.lastSeq + i + 1, threadId: n.threadId,
    type: n.type, actor: n.actor, payload: n.payload,
  }));
  const inserted = await tx.insert(events).values(rows).returning();
  weave.lastSeq += news.length;
  await tx.update(weaves).set({ lastSeq: weave.lastSeq }).where(eq(weaves.id, weave.id));
  return inserted.sort((a, b) => a.seq - b.seq).map(toEvent);
}

/**
 * Runs `fn` in a transaction holding a row lock on the weave (SELECT ... FOR UPDATE),
 * appends the returned events, commits, then publishes them in seq order.
 */
export async function withWeaveLock<T>(
  db: Db, bus: EventBus, weaveId: string,
  fn: (tx: Tx, weave: WeaveRow) => Promise<{ result: T; events: NewEvent[] }>,
): Promise<T> {
  const { result, committed } = await db.transaction(async (tx) => {
    const [weave] = await tx.select().from(weaves).where(eq(weaves.id, weaveId)).for("update");
    if (!weave) throw errors.weaveNotFound();
    const out = await fn(tx, weave);
    const committed = await appendInTx(tx, weave, out.events);
    return { result: out.result, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function readEvents(
  db: Db, weaveId: string, opts: { since?: number; threadId?: string; limit?: number },
): Promise<LoomEvent[]> {
  const conds = [eq(events.weaveId, weaveId)];
  if (opts.since !== undefined) conds.push(gt(events.seq, opts.since));
  if (opts.threadId) conds.push(eq(events.threadId, opts.threadId));
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit);
  return rows.map(toEvent);
}
