import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/index.js";
import { events, participants, requests, weaveInvitations } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock, withWeaveLocks, type NewEvent } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";
import { generalThreadOf } from "./threads.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby/lobby.js";
import type { Actor, PublicParticipant, Role } from "./types.js";

export async function setRole(db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, role: Role): Promise<PublicParticipant> {
  assertIsKeeperOf(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  if (role !== "member" && role !== "keeper") throw errors.validation("role must be member or keeper");
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Weave");
  const general = await generalThreadOf(db, weaveId);
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    await assertStillKeeperOf(tx, actor, weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [p] = await tx.update(participants).set({ role })
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).returning();
    if (!p) throw errors.validation("No such participant in this Weave");
    return {
      result: toPublicParticipant(p),
      events: [{ threadId: general.id, type: "participant.role_changed" as const, actor: actorId(actor), payload: { participantId, role } }],
    };
  });
}

/**
 * What a kick answers (spec 2026-10-09 §4.1). `kickedAt` is the row's `kicked_at`, ISO. `withdrawn`
 * is the ids of the invitations this call withdrew (§4.6), oldest first; empty when there were none
 * and on a repeat.
 */
export type KickResult = {
  participantId: string; name: string; seq: number; kickedAt: string; created: boolean; withdrawn: string[];
};

export type KickOptions = {
  /** Test seam: runs after the checks made outside the lock and before the lock is taken. */
  beforeLock?: () => Promise<void>;
};

const NO_SUCH_PARTICIPANT = "No such participant in this Weave";

/**
 * Kicks a participant out of a Weave (spec 2026-10-09 §4): its `kicked_at` is set and its role is
 * `member` from then on, so its token is refused on every surface, an agent key's mapping there is
 * refused, and every keeper re-check that reads a fresh row reads it as no keeper. The row stays, so
 * the history keeps its name. A keeper of the Weave or the instance keeper token, re-checked inside
 * the lock; never oneself; never in the Lobby; an archived Weave is no obstacle, since a kick only
 * removes access. One `participant.kicked` lands on the Weave's General Thread. A repeat writes
 * nothing and answers the newest kick's seq with `created: false`.
 *
 * The kick also withdraws the kicked agent's invitations into this Weave still pending, direct or a
 * request's, each told to its invitee with `weave.invitation_withdrawn` (§4.6): an invitation pending
 * at the kick would otherwise readmit it. No clock is compared. Every flow that writes or redeems an
 * invitation holds this Weave's lock, so at this commit every invitation that could adopt the kicked
 * row is withdrawn, spent, or not yet written; one redeemable afterwards was issued after the kick.
 *
 * The Lobby's lock, then the Weave's, always: the withdrawals append to the Lobby's log, whether
 * there are any can only be known inside the Weave's lock, and that order is the one every
 * cross-Weave flow uses, so no deadlock is added.
 */
export async function kickParticipant(
  db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, opts: KickOptions = {},
): Promise<KickResult> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  // The authority before anything is read about the participant: a non-keeper learns nothing of the id.
  assertIsKeeperOf(actor, weaveId);
  const { weaveId: lobbyId } = await getLobby(db);
  // A Listener leaves the Lobby's directory by clearing its own profile; and withWeaveLocks must not
  // be asked for the same row twice.
  if (weaveId === lobbyId) throw errors.validation("Nobody is kicked from the Lobby");
  if (!isUuid(participantId)) throw errors.validation(NO_SUCH_PARTICIPANT);
  // An agent key reaches here already mapped to its participant by the facade; an instance keeper
  // has no participant row and cannot meet this.
  if (actor.kind === "participant" && actor.participant.id === participantId) throw errors.validation("You cannot kick yourself");
  const general = await generalThreadOf(db, weaveId);
  if (opts.beforeLock) await opts.beforeLock();
  return withWeaveLocks<KickResult>(db, bus, [lobbyId, weaveId], async (tx, byId) => {
    const weave = byId[weaveId]!;
    // The role the actor carries was captured when its credential was resolved; it may have been
    // taken away since. No archived check (§4.3).
    await assertStillKeeperOf(tx, actor, weaveId);
    const [p] = await tx.select().from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).for("update");
    if (!p) throw errors.validation(NO_SUCH_PARTICIPANT);
    if (p.kickedAt) {
      // Only this function sets kicked_at, and always writes its event in the same transaction, so
      // the newest participant.kicked naming the id is the kick that holds (§4.4); 0 when none is
      // found, the "none" value lastRemovalSeq uses. A repeat withdraws nothing: an invitation
      // pending now was issued after the first kick, by a keeper who meant to readmit.
      const [kick] = await tx.select({ seq: events.seq }).from(events)
        .where(and(eq(events.weaveId, weaveId), eq(events.type, "participant.kicked"),
          sql`${events.payload}->>'participantId' = ${participantId}`))
        .orderBy(desc(events.seq)).limit(1);
      return {
        result: { participantId, name: p.name, seq: kick?.seq ?? 0, kickedAt: p.kickedAt.toISOString(), created: false, withdrawn: [] },
        events: {},
      };
    }
    // One clock read: the row's kicked_at and every withdrawal's revoked_at. Shown, never compared (§3).
    const now = new Date();
    // role member in the same statement: every keeper re-check reads role, so a kicked keeper loses
    // keepership at this commit in every in-flight path (§3).
    await tx.update(participants).set({ kickedAt: now, role: "member" }).where(eq(participants.id, participantId));
    const by = actorId(actor);
    // A reader whose names miss either principal still names both from the payload (§5.1).
    const byName = actor.kind === "participant" ? actor.participant.name : "Keeper";
    const lobbyNews = p.agentId ? await withdrawPending(tx, lobbyId, weaveId, weave.title, p.agentId, now, by, byName) : [];
    const kicked: NewEvent = {
      threadId: general.id, type: "participant.kicked", actor: by,
      payload: { participantId, name: p.name, kickedBy: by, kickedByName: byName },
    };
    return {
      result: {
        participantId, name: p.name, seq: weave.lastSeq + 1, kickedAt: now.toISOString(), created: true,
        withdrawn: lobbyNews.map((e) => String(e.payload.invitationId)),
      },
      // withWeaveLocks appends and publishes the Lobby's events first, then the Weave's.
      events: { [lobbyId]: lobbyNews, [weaveId]: [kicked] },
    };
  });
}

/**
 * Withdraws the kicked agent's invitations into `weaveId` still pending (spec 2026-10-09 §4.6): only
 * these can adopt its row, because `redeemInvitation` adopts the participant whose `agent_id` is the
 * invitation's `invitee_agent_id`, whichever credential redeems it. Returns one
 * `weave.invitation_withdrawn` per row, oldest first, on the Thread its `weave.invited` landed on: the
 * Lobby's General for a direct invitation, the request's Thread for a request's. The payload is
 * `withdrawInvitation`'s exactly.
 */
async function withdrawPending(
  tx: Tx, lobbyId: string, weaveId: string, weaveTitle: string, agentId: string, now: Date, by: string, byName: string,
): Promise<NewEvent[]> {
  const rows = await tx.update(weaveInvitations).set({ revokedAt: now })
    .where(and(eq(weaveInvitations.targetWeaveId, weaveId), eq(weaveInvitations.inviteeAgentId, agentId),
      isNull(weaveInvitations.redeemedAt), isNull(weaveInvitations.revokedAt)))
    .returning({ id: weaveInvitations.id, participantId: weaveInvitations.inviteeParticipantId,
      requestId: weaveInvitations.requestId, createdAt: weaveInvitations.createdAt });
  // For a stable event order only; nothing is decided on it.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: NewEvent[] = [];
  for (const r of rows) {
    let threadId: string;
    if (r.requestId === null) {
      threadId = await lobbyGeneralThreadId(tx, lobbyId);
    } else {
      // A request's Thread may be closed; appendInTx does not look at closed_at, and a closed Thread
      // refuses posts, not system events.
      const [req] = await tx.select({ threadId: requests.threadId }).from(requests).where(eq(requests.id, r.requestId));
      threadId = req!.threadId;
    }
    out.push({ threadId, type: "weave.invitation_withdrawn", actor: by,
      payload: { invitationId: r.id, participantId: r.participantId, targetWeaveTitle: weaveTitle, withdrawnBy: by, withdrawnByName: byName } });
  }
  return out;
}
