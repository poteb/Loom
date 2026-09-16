import { and, asc, eq, gt } from "drizzle-orm";
import type { Db, Queryable, Tx } from "./db/index.js";
import { events, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { validatePage } from "./paging.js";
import type { EventBus } from "./bus.js";
import type { EventType, LoomEvent } from "./types.js";

/** Page size when the caller names none. The maximum it may name is core's MAX_PAGE_LIMIT. */
const DEFAULT_EVENTS_PAGE = 500;

export type NewEvent = { threadId: string; type: EventType; actor: string; payload: Record<string, unknown> };
export type WeaveRow = typeof weaves.$inferSelect;
export type { Tx };

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
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
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

/**
 * The two-Weave variant of `withWeaveLock`: locks each row **in the given order**, runs `fn`, then
 * appends each Weave's events (keyed by weave id) in that same order and publishes after commit.
 *
 * The order is the deadlock discipline, not a detail: every flow that needs both rows takes them
 * Lobby first, then target, and flows that need one row take only that one, so no cycle exists.
 * Two ids naming the same Weave would take the same row twice and are refused rather than risked.
 */
export async function withWeaveLocks<T>(
  db: Db, bus: EventBus, weaveIds: [string, string],
  fn: (tx: Tx, weavesById: Record<string, WeaveRow>) => Promise<{ result: T; events: Record<string, NewEvent[]> }>,
): Promise<T> {
  for (const id of weaveIds) if (!isUuid(id)) throw errors.weaveNotFound();
  if (weaveIds[0] === weaveIds[1]) throw errors.validation("withWeaveLocks needs two distinct Weaves");
  const { result, committed } = await db.transaction(async (tx) => {
    const byId: Record<string, WeaveRow> = {};
    for (const id of weaveIds) {
      const [weave] = await tx.select().from(weaves).where(eq(weaves.id, id)).for("update");
      if (!weave) throw errors.weaveNotFound();
      byId[id] = weave;
    }
    const out = await fn(tx, byId);
    const committed: LoomEvent[] = [];
    for (const id of weaveIds) committed.push(...await appendInTx(tx, byId[id]!, out.events[id] ?? []));
    return { result: out.result, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function readEvents(
  db: Queryable, weaveId: string, opts: { since?: number; threadId?: string; limit?: number },
): Promise<LoomEvent[]> {
  // `events.thread_id` is a uuid column: an unguarded filter would reach Postgres as 22P02, an
  // untyped driver error that the MCP adapter reports as `internal` with the query in it. Every
  // other id entry point guards the same way, and REST already answered 404 here by accident.
  if (opts.threadId !== undefined && !isUuid(opts.threadId)) throw errors.threadNotFound();
  validatePage(opts);
  const conds = [eq(events.weaveId, weaveId)];
  if (opts.since !== undefined) conds.push(gt(events.seq, opts.since));
  if (opts.threadId) conds.push(eq(events.threadId, opts.threadId));
  const limit = opts.limit ?? DEFAULT_EVENTS_PAGE;
  const rows = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit);
  return rows.map(toEvent);
}
