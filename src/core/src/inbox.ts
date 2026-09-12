import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, threads } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { assertParticipantOf } from "./actors.js";
import type { Actor, EventType, InboxItem } from "./types.js";

/**
 * What is addressed to the acting participant: invites naming it and messages mentioning it,
 * excluding its own events, always oldest-first. Pure read with an explicit `since`: remote agents
 * with no local state pass the last seq they saw, or omit it for the most recent addressed events.
 */
export async function inbox(db: Db, actor: Actor, weaveId: string, opts: { since?: number; limit?: number }): Promise<InboxItem[]> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const conds = [
    eq(events.weaveId, weaveId),
    ne(events.actor, me.id),
    or(
      and(eq(events.type, "thread.invited"), sql`${events.payload}->>'participantId' = ${me.id}`),
      and(eq(events.type, "message"), sql`${events.payload}->'mentions' ? ${me.id}`),
    ),
  ];
  if (opts.since !== undefined) conds.push(gt(events.seq, opts.since));
  // With `since` this is forward pagination: the oldest unseen page. Without one the caller has no
  // cursor and wants what it just missed, so take the newest `limit` rows and hand them back in the
  // same ascending order.
  const q = db.select().from(events).where(and(...conds));
  const rows = opts.since === undefined
    ? (await q.orderBy(desc(events.seq)).limit(limit)).reverse()
    : await q.orderBy(asc(events.seq)).limit(limit);
  // One extra read for the distinct Threads on this page: an invite is only actionable with the
  // Thread's name and the artefact it links to, and a remote agent should not need a second call.
  const ids = [...new Set(rows.map((r) => r.threadId))];
  const ts = ids.length
    ? await db.select({ id: threads.id, name: threads.name, url: threads.url }).from(threads).where(inArray(threads.id, ids))
    : [];
  const byId = new Map(ts.map((t) => [t.id, t]));
  return rows.map((r) => ({
    weaveId: r.weaveId, seq: r.seq, threadId: r.threadId, type: r.type as EventType,
    actor: r.actor, at: r.at.toISOString(), payload: r.payload as Record<string, unknown>,
    threadName: byId.get(r.threadId)?.name ?? r.threadId,
    threadUrl: byId.get(r.threadId)?.url ?? null,
  }));
}
