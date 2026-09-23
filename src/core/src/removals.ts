import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Queryable, Tx } from "./db/index.js";
import { events, participants, requestOffers, requests, threads, weaveInvitations } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock, withWeaveLocks, type NewEvent, type WeaveRow } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf } from "./actors.js";
import { getThread } from "./threads.js";
import { recordedAttribution, recordedAuthorityHolds, versionOf, type RequestRow } from "./lobby/requests.js";
import type { Actor } from "./types.js";

export type RemovalResult = { seq: number; created: boolean; acceptanceRemoved: boolean; targetRemoved: boolean };
type Marker = { type: "thread.invited" | "thread.removed"; seq: number };

/**
 * A participant's latest marker in a Thread (spec §6.5): the highest-seq `thread.invited` or
 * `thread.removed` naming it there. `postMessage`, `inviteParticipant` and `removeParticipant`
 * read it, so that a removal blocks posting until the next invite, and an invite after a removal
 * is a new one.
 */
export async function latestMarker(q: Queryable, threadId: string, participantId: string): Promise<Marker | undefined> {
  const [m] = await q.select({ type: events.type, seq: events.seq }).from(events)
    .where(and(eq(events.threadId, threadId), inArray(events.type, ["thread.invited", "thread.removed"]),
      sql`${events.payload}->>'participantId' = ${participantId}`))
    .orderBy(desc(events.seq)).limit(1);
  return m ? { type: m.type as Marker["type"], seq: m.seq } : undefined;
}

/** The seq of the latest `thread.removed` naming the participant in the Thread, or 0 when none. */
export async function lastRemovalSeq(q: Queryable, threadId: string, participantId: string): Promise<number> {
  const [m] = await q.select({ seq: events.seq }).from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "thread.removed"),
      sql`${events.payload}->>'participantId' = ${participantId}`))
    .orderBy(desc(events.seq)).limit(1);
  return m?.seq ?? 0;
}

async function assertParticipantOfWeave(tx: Tx, weaveId: string, participantId: string): Promise<void> {
  const [p] = await tx.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).limit(1);
  if (!p) throw errors.validation("No such participant in this Weave");
}

const unchanged = (seq: number): RemovalResult => ({ seq, created: false, acceptanceRemoved: false, targetRemoved: false });

/**
 * Takes a participant off a Thread (spec §6.5): it is told with `thread.removed` and cannot post
 * there until it is invited again. The Thread's creator or a keeper of its Weave; never the General
 * Thread; never oneself. Idempotent while the latest marker is already a removal. Nothing is
 * deleted, and the participant may be invited or accepted again later.
 *
 * On a Lobby request's Thread, given the Lobby participant id of an accepted agent, it also removes
 * that acceptance, withdraws its unredeemed invitations and, under the request's recorded target
 * authority, removes the agent from the work Thread it redeemed into: one transaction under the
 * Lobby lock and then the target's, the order every cross-Weave flow uses.
 */
export async function removeParticipant(db: Db, bus: EventBus, actor: Actor, threadId: string, participantId: string): Promise<RemovalResult> {
  const t = await getThread(db, threadId);
  const isCreator = actor.kind === "participant" && actor.participant.weaveId === t.weaveId && actor.participant.id === t.createdBy;
  if (!isCreator) assertIsKeeperOf(actor, t.weaveId);
  if (t.isGeneral) throw errors.validation("Nobody is removed from the General Thread");
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Weave");
  const me = actorId(actor);
  if (me === participantId) throw errors.validation("You cannot remove yourself");
  if (t.requestId) return removeFromRequestThread(db, bus, actor, isCreator, t, participantId, me);

  return withWeaveLock<RemovalResult>(db, bus, t.weaveId, async (tx, weave) => {
    if (!isCreator) await assertStillKeeperOf(tx, actor, t.weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    await assertParticipantOfWeave(tx, t.weaveId, participantId);
    const marker = await latestMarker(tx, threadId, participantId);
    if (marker?.type === "thread.removed") return { result: unchanged(marker.seq), events: [] };
    return {
      result: { seq: weave.lastSeq + 1, created: true, acceptanceRemoved: false, targetRemoved: false },
      events: [{ threadId, type: "thread.removed", actor: me, payload: { threadId, participantId, removedBy: me } }],
    };
  });
}

/** The target half runs only under all four conditions of spec §6.5 step 8. */
async function targetHalfMayRun(tx: Tx, req: RequestRow, target: WeaveRow): Promise<boolean> {
  if (!await recordedAuthorityHolds(tx, req)) return false;
  if (target.archivedAt) return false;
  const [work] = await tx.select().from(threads).where(eq(threads.id, req.targetThreadId));
  // A request may target a Weave's General Thread, and nobody is removed from a General Thread.
  return !!work && work.closedAt === null && !work.isGeneral;
}

async function removeFromRequestThread(
  db: Db, bus: EventBus, actor: Actor, isCreator: boolean, t: { id: string; weaveId: string }, participantId: string, me: string,
): Promise<RemovalResult> {
  const [req] = await db.select().from(requests).where(eq(requests.threadId, t.id));
  if (!req) throw errors.threadNotFound();
  return withWeaveLocks<RemovalResult>(db, bus, [t.weaveId, req.targetWeaveId], async (tx, byId) => {
    const lobby = byId[t.weaveId]!;
    const target = byId[req.targetWeaveId]!;
    const now = new Date();
    if (!isCreator) await assertStillKeeperOf(tx, actor, t.weaveId);
    if (lobby.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, t.id));
    if (fresh!.closedAt) throw errors.threadClosed();
    await assertParticipantOfWeave(tx, t.weaveId, participantId);
    const [offerRow] = await tx.select().from(requestOffers)
      .where(and(eq(requestOffers.requestId, req.id), eq(requestOffers.participantId, participantId)));
    const active = !!offerRow && offerRow.accepted && offerRow.removedAt === null;
    const marker = await latestMarker(tx, t.id, participantId);
    if (marker?.type === "thread.removed" && !active) return { result: unchanged(marker.seq), events: {} };

    const targetEvents: NewEvent[] = [];
    if (active) {
      await tx.update(requestOffers).set({ removedAt: now })
        .where(and(eq(requestOffers.requestId, req.id), eq(requestOffers.participantId, participantId)));
      const invitations = await tx.select().from(weaveInvitations)
        .where(and(eq(weaveInvitations.requestId, req.id), eq(weaveInvitations.inviteeParticipantId, participantId)));
      const unredeemed = invitations.filter((i) => i.redeemedAt === null && i.revokedAt === null).map((i) => i.id);
      if (unredeemed.length > 0) await tx.update(weaveInvitations).set({ revokedAt: now }).where(inArray(weaveInvitations.id, unredeemed));
      const redeemed = [...new Set(invitations.map((i) => i.redeemedParticipantId).filter((id): id is string => id !== null))];
      if (redeemed.length > 0 && await targetHalfMayRun(tx, req, target)) {
        const by = recordedAttribution(req);
        for (const inTarget of redeemed) {
          if ((await latestMarker(tx, req.targetThreadId, inTarget))?.type === "thread.removed") continue;
          targetEvents.push({ threadId: req.targetThreadId, type: "thread.removed", actor: by,
            payload: { threadId: req.targetThreadId, participantId: inTarget, removedBy: by, requestId: req.id } });
        }
      }
    }
    const lobbyEvents: NewEvent[] = [{ threadId: t.id, type: "thread.removed", actor: me,
      payload: { threadId: t.id, participantId, removedBy: me, requestId: req.id } }];
    // A thread.removed carrying a requestId is a request mutation, so the row's version follows it.
    await tx.update(requests).set({ lastEventSeq: versionOf(lobby, lobbyEvents) }).where(eq(requests.id, req.id));
    return {
      result: { seq: lobby.lastSeq + 1, created: true, acceptanceRemoved: active, targetRemoved: targetEvents.length > 0 },
      events: { [t.weaveId]: lobbyEvents, [req.targetWeaveId]: targetEvents },
    };
  });
}
