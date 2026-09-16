import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, threads } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { assertParticipantOf } from "./actors.js";
import { validatePage } from "./paging.js";
import type { Actor, EventType, InboxItem } from "./types.js";

/** Page size when the caller names none. The maximum it may name is core's MAX_PAGE_LIMIT. */
const DEFAULT_INBOX_PAGE = 100;

/**
 * What is addressed to the acting participant: invites naming it, messages mentioning it and the
 * Lobby events that name it — a request it is eligible for, an offer or a close addressed to it, an
 * acceptance or a cross-Weave invitation naming it — excluding its own events, always oldest-first.
 *
 * Pure read with an explicit `since`: the caller keeps a dedicated inbox cursor per Weave — the seq
 * of the last inbox item it processed — and passes that. It is not the last seq the caller saw: a
 * cursor advanced from `readEvents` or from the seq its own `postMessage` returned skips anything
 * addressed to it in between, since those seqs run ahead of the inbox. An empty page leaves the
 * cursor where it was. A caller with no cursor yet omits `since` and gets the most recent
 * addressed events.
 */
export async function inbox(db: Db, actor: Actor, weaveId: string, opts: { since?: number; limit?: number }): Promise<InboxItem[]> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  validatePage(opts);
  const limit = opts.limit ?? DEFAULT_INBOX_PAGE;
  const conds = [
    eq(events.weaveId, weaveId),
    ne(events.actor, me.id),
    or(
      and(eq(events.type, "thread.invited"), sql`${events.payload}->>'participantId' = ${me.id}`),
      and(eq(events.type, "message"), sql`${events.payload}->'mentions' ? ${me.id}`),
      // The Lobby's addressed events. Each names its audience in its own payload key, and nothing
      // else in the Lobby reaches anyone: these events wake nobody through a Weave's all-events mode.
      and(eq(events.type, "request.opened"), sql`${events.payload}->'eligible' ? ${me.id}`),
      // `request.offered.to` is one participant (the requester) and `request.closed.to` a list, so
      // both forms are asked for rather than normalising one of them in the log.
      and(inArray(events.type, ["request.offered", "request.closed"]),
        sql`(${events.payload}->>'to' = ${me.id} OR ${events.payload}->'to' ? ${me.id})`),
      and(eq(events.type, "request.accepted"), sql`${events.payload}->'participantIds' ? ${me.id}`),
      and(eq(events.type, "weave.invited"), sql`${events.payload}->>'participantId' = ${me.id}`),
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
