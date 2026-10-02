import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { participants, requestOffers, requests } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { withWeaveLock, type NewEvent } from "../events.js";
import { getSettings } from "../settings.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby.js";
import { stillRunning } from "./requests.js";
import { isOnline, offlineSql } from "./status.js";
import type { Profile } from "./matching.js";

/*
 * Removing offline Listeners (spec 2026-09-30): the sweep's third pass. A Listener is a Lobby
 * participant with a profile. One that has gone longer than the instance's
 * `removeOfflineListenersAfterMs` without a check-in, and also reads offline, loses its profile and
 * its open offers; its row, its history, its accepted work and the requests it opened stay, and it
 * comes back by setting its profile again. An action, not a status: until the moment of its removal
 * it reads offline exactly as before.
 */

/**
 * §3.2, pure. `limitMs` null is off. The row is a `participants` row as drizzle reads it. The
 * reference is the last check-in, or the join when it was never seen; exactly `limitMs` after it is
 * kept, one millisecond more is removable, and only while it reads offline (`isOnline`), so one that
 * declares a long `pollIntervalMs` is kept until twice that interval.
 */
export function isRemovable(
  row: { capabilities: unknown; lastSeenAt: Date | null; joinedAt: Date },
  limitMs: number | null, now: Date,
): boolean {
  if (limitMs === null || row.capabilities === null) return false;
  const reference = row.lastSeenAt ?? row.joinedAt;
  if (now.getTime() - reference.getTime() <= limitMs) return false;
  return !isOnline(row.capabilities as Profile, row.lastSeenAt, now);
}

export type RemovalOptions = {
  /** Test seam: runs after the candidates are read and before each one's transaction takes the lock. */
  beforeLock?: (participantId: string) => Promise<void>;
};

/**
 * §5.1. Reads the setting once (off: nothing else is read), then the candidates in one query without
 * a lock (all three conditions of §3.2 on the millisecond value a JavaScript `Date` holds, condition
 * 3 as `offlineSql`, so a Listener past the limit but still online is no candidate and costs no
 * Lobby-lock transaction: external review round 1, S3), then decides each one again with
 * `isRemovable` in its own transaction under the Lobby lock, on its participant row re-read
 * `FOR UPDATE`, which is the deciding check: a check-in that committed after the query is what the
 * re-read sees, and of two passes racing the second finds the profile already gone and writes nothing.
 * `stampSeen` takes no Weave lock and locks that one row, so no lock cycle exists. Returns how many
 * Listeners it removed.
 */
export async function sweepOfflineListeners(db: Db, bus: EventBus, now = new Date(), opts: RemovalOptions = {}): Promise<number> {
  const limit = (await getSettings(db)).removeOfflineListenersAfterMs;
  if (limit === null) return 0;
  const { weaveId: lobbyId } = await getLobby(db);
  const generalThreadId = await lobbyGeneralThreadId(db, lobbyId);
  const cutoff = new Date(now.getTime() - limit);
  // The truncation `statusSql` and `offlineSql` use, so the candidate test and the `Date` the
  // re-read hands `isRemovable` agree on a stored microsecond.
  const reference = sql`date_trunc('milliseconds', coalesce(${participants.lastSeenAt}, ${participants.joinedAt}))`;
  const candidates = await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities),
      sql`${reference} < ${cutoff.toISOString()}::timestamptz`, offlineSql(now)))
    .orderBy(asc(reference), asc(participants.id));
  let removed = 0;
  for (const { id } of candidates) {
    if (opts.beforeLock) await opts.beforeLock(id);
    const didRemove = await withWeaveLock<boolean>(db, bus, lobbyId, async (tx, lobby) => {
      const [row] = await tx.select().from(participants).where(eq(participants.id, id)).for("update");
      if (!row || row.capabilities === null || !isRemovable(row, limit, now)) return { result: false, events: [] };
      // §5.2: its unaccepted offers on requests still running, in offer order, then by request id.
      // Accepted rows (active, completed, or removed by a requester) are never touched (Q4).
      const open = (await tx.select({
        requestId: requestOffers.requestId, threadId: requests.threadId, requesterId: requests.requesterId,
        status: requests.status, expiresAt: requests.expiresAt,
      }).from(requestOffers).innerJoin(requests, eq(requests.id, requestOffers.requestId))
        .where(and(eq(requestOffers.participantId, id), eq(requestOffers.accepted, false)))
        .orderBy(asc(requestOffers.createdAt), asc(requestOffers.requestId)))
        .filter((o) => stillRunning(o, now));
      if (open.length > 0) {
        await tx.delete(requestOffers).where(and(eq(requestOffers.participantId, id), eq(requestOffers.accepted, false),
          inArray(requestOffers.requestId, open.map((o) => o.requestId))));
      }
      // Each request's version is its own withdrawal's seq: `listener.removed` takes lastSeq + 1.
      for (const [i, o] of open.entries()) {
        await tx.update(requests).set({ lastEventSeq: lobby.lastSeq + 2 + i }).where(eq(requests.id, o.requestId));
      }
      await tx.update(participants).set({ capabilities: null }).where(eq(participants.id, id));
      const news: NewEvent[] = [
        { threadId: generalThreadId, type: "listener.removed", actor: "system",
          payload: { participantId: id, reason: "offline", lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
            afterMs: limit, previous: row.capabilities as Profile, withdrawn: open.map((o) => o.requestId) } },
        // Addressed to the requester (Review F1 = A): it was told of the offer by request.offered.
        ...open.map((o): NewEvent => ({ threadId: o.threadId, type: "request.offer_withdrawn", actor: "system",
          payload: { requestId: o.requestId, participantId: id, reason: "offline", to: o.requesterId } })),
      ];
      return { result: true, events: news };
    });
    if (didRemove) removed++;
  }
  return removed;
}
