import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/index.js";
import { participants, requests, threads, weaveInvitations } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { isUuid, newId, newSecret } from "../ids.js";
import { validateName } from "../names.js";
import { withWeaveLock, withWeaveLocks, type NewEvent } from "../events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "../actors.js";
import { getInstanceGuidelines, guidelinesFor } from "../guidelines.js";
import { isNameTakenViolation, toPublicWeave, type JoinResult } from "../weaves.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby.js";
import type { Actor, Kind } from "../types.js";

/** Everything one cross-Weave invitation is made of, whoever is issuing it. */
export type InvitationDraft = {
  invitationId: string; targetWeaveId: string; targetThreadId: string; targetWeaveTitle: string;
  inviteeParticipantId: string; inviteeAgentId: string | null;
  requestId: string | null; createdBy: string;
  /** The Lobby Thread the invitee is addressed in: the request's, or the Lobby General. */
  threadId: string;
};

/**
 * Writes the invitation row and returns the `weave.invited` event that announces it. `accept` and
 * `inviteToWeave` both go through here, so the payload has one source — and so the rule that it
 * never carries the target Weave's secret is stated in one place.
 */
export async function invitationRowAndEvent(tx: Tx, draft: InvitationDraft): Promise<NewEvent> {
  await tx.insert(weaveInvitations).values({
    id: draft.invitationId, targetWeaveId: draft.targetWeaveId, targetThreadId: draft.targetThreadId,
    inviteeParticipantId: draft.inviteeParticipantId, inviteeAgentId: draft.inviteeAgentId,
    requestId: draft.requestId, createdBy: draft.createdBy,
  });
  // Never the secret: the invitation id is the whole way in, and it is single-use.
  return {
    threadId: draft.threadId, type: "weave.invited", actor: draft.createdBy,
    payload: { invitationId: draft.invitationId, participantId: draft.inviteeParticipantId,
      targetWeaveTitle: draft.targetWeaveTitle },
  };
}

/**
 * The Weave's General thread. Every Weave has exactly one, flagged at creation; selected by the flag
 * rather than by age because a Weave may have Threads older than nothing but itself.
 */
async function generalThreadOf(tx: Tx, weaveId: string): Promise<{ id: string }> {
  const [general] = await tx.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.weaveId, weaveId), eq(threads.isGeneral, true))).limit(1);
  if (!general) throw errors.weaveNotFound();
  return general;
}

/**
 * Hands a Lobby participant a single-use way into another Weave. Usable on its own, without a
 * request: a keeper of the target Weave may invite anyone standing in the Lobby.
 *
 * Both rows are locked, Lobby first and then the target, the one order every cross-Weave flow uses
 * (see `withWeaveLocks`): the invitee is read from the Lobby, the authority and the Thread from the
 * target, and the announcement is appended to the Lobby, all in one transaction.
 */
export async function inviteToWeave(
  db: Db, bus: EventBus, actor: Actor, participantId: string, targetWeaveId: string,
  targetThreadId: string, requestId?: string,
): Promise<{ invitationId: string; seq: number }> {
  const { weaveId: lobbyId } = await getLobby(db);
  if (!isUuid(targetWeaveId)) throw errors.weaveNotFound();
  assertIsKeeperOf(actor, targetWeaveId);
  // The invitation pulls someone *out* of the Lobby; one pointing back at it would also ask
  // `withWeaveLocks` to take the same row twice.
  if (targetWeaveId === lobbyId) throw errors.validation("An invitation cannot target the Lobby");
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Lobby");
  if (!isUuid(targetThreadId)) throw errors.threadNotFound();
  if (requestId !== undefined && !isUuid(requestId)) throw errors.validation("No such request");

  const invitationId = newId();
  return withWeaveLocks(db, bus, [lobbyId, targetWeaveId], async (tx, byId) => {
    const lobby = byId[lobbyId]!;
    const target = byId[targetWeaveId]!;
    // The role the actor carries was captured when its credential was resolved; it may have been
    // taken away since, so it is re-checked here, inside the target's lock.
    await assertStillKeeperOf(tx, actor, targetWeaveId);
    if (target.archivedAt) throw errors.weaveArchived();
    const [thread] = await tx.select().from(threads).where(eq(threads.id, targetThreadId));
    if (!thread || thread.weaveId !== targetWeaveId) throw errors.threadNotFound();
    if (thread.closedAt) throw errors.threadClosed();
    const [invitee] = await tx.select({ id: participants.id, agentId: participants.agentId })
      .from(participants).where(and(eq(participants.id, participantId), eq(participants.weaveId, lobbyId)));
    if (!invitee) throw errors.validation("No such participant in this Lobby");

    // Addressed where the invitee is already being spoken to: the request's Thread when this
    // invitation belongs to one, the Lobby's General when it stands on its own.
    let threadId = await lobbyGeneralThreadId(tx, lobbyId);
    if (requestId !== undefined) {
      const [row] = await tx.select({ threadId: requests.threadId }).from(requests).where(eq(requests.id, requestId));
      if (!row) throw errors.validation("No such request");
      threadId = row.threadId;
    }
    const event = await invitationRowAndEvent(tx, {
      invitationId, targetWeaveId, targetThreadId, targetWeaveTitle: target.title,
      inviteeParticipantId: invitee.id, inviteeAgentId: invitee.agentId ?? null,
      requestId: requestId ?? null, createdBy: actorId(actor), threadId,
    });
    return { result: { invitationId, seq: lobby.lastSeq + 1 }, events: { [lobbyId]: [event] } };
  });
}

/**
 * Redeems an invitation: the invitee lands in the target Weave with the Thread invite that says
 * where its input is wanted, and the invitation is spent.
 *
 * **One transaction under the target Weave's lock**, rather than the ordinary `joinWeave`: that
 * call's already-joined shortcut returns *before* any lock is taken, so an agent already present in
 * the target would skip both the Thread invite and the consumption; and a `redeemedAt` check made
 * before waiting for the lock lets two concurrent redeemers both pass it. Validation, identity
 * reuse or creation, the Thread invite and the consumption therefore all happen inside it.
 */
export async function redeemInvitation(
  db: Db, bus: EventBus, actor: Actor, inviteId: string, who: { name?: string; kind: Kind },
): Promise<JoinResult> {
  if (!isUuid(inviteId)) throw errors.forbidden("Unknown invitation");
  // Read once outside the lock only to learn which Weave row to lock; nothing is decided on it.
  const [peek] = await db.select().from(weaveInvitations).where(eq(weaveInvitations.id, inviteId));
  if (!peek) throw errors.forbidden("Unknown invitation");
  // The name the insert below attempts, kept for the error the unique index may raise.
  let attempted = "";
  try {
    return await withWeaveLock(db, bus, peek.targetWeaveId, async (tx, weave) => {
      const [inv] = await tx.select().from(weaveInvitations).where(eq(weaveInvitations.id, inviteId)).for("update");
      if (!inv || inv.redeemedAt) throw errors.forbidden("Invitation already redeemed");
      const isInvitee = (actor.kind === "participant" && actor.participant.id === inv.inviteeParticipantId)
        || (actor.kind === "agent" && inv.inviteeAgentId !== null && actor.agent.id === inv.inviteeAgentId);
      if (!isInvitee) throw errors.forbidden("This invitation is addressed to someone else");
      if (weave.archivedAt) throw errors.weaveArchived();
      const [thread] = await tx.select().from(threads).where(eq(threads.id, inv.targetThreadId));
      if (!thread || thread.weaveId !== weave.id) throw errors.threadNotFound();
      if (thread.closedAt) throw errors.threadClosed();
      const [invitee] = await tx.select().from(participants).where(eq(participants.id, inv.inviteeParticipantId));
      const agentId = actor.kind === "agent" ? actor.agent.id : null;
      // An agent owns at most one participant per Weave: redeeming into a Weave it is already in is
      // an adoption of that identity, not a second one.
      const [mine] = agentId
        ? await tx.select().from(participants)
          .where(and(eq(participants.weaveId, weave.id), eq(participants.agentId, agentId))).limit(1)
        : [undefined];
      const events: NewEvent[] = [];
      let p = mine;
      if (!p) {
        const name = validateName(who.name ?? invitee!.name);
        attempted = name;
        [p] = await tx.insert(participants).values({ id: newId(), weaveId: weave.id, name, kind: invitee!.kind,
          role: "member", token: newSecret(), agentId }).returning();
        events.push({ threadId: thread.id, type: "participant.joined", actor: p!.id,
          payload: { participantId: p!.id, name: p!.name, kind: p!.kind, role: p!.role } });
      }
      events.push({ threadId: thread.id, type: "thread.invited", actor: inv.createdBy,
        payload: { threadId: thread.id, invitedBy: inv.createdBy, participantId: p!.id } });
      await tx.update(weaveInvitations).set({ redeemedAt: new Date(), redeemedParticipantId: p!.id })
        .where(eq(weaveInvitations.id, inviteId));
      const general = await generalThreadOf(tx, weave.id);
      return {
        result: {
          weaveId: weave.id, weave: toPublicWeave({ ...weave, lastSeq: weave.lastSeq + events.length }),
          generalThreadId: general.id, participant: toPublicParticipant(p!), token: p!.token,
          alreadyJoined: !!mine, guidelines: guidelinesFor(await getInstanceGuidelines(tx), weave),
        },
        events,
      };
    });
  } catch (e) {
    // The per-Weave unique name index is what decides a collision, exactly as in `joinWeave`; the
    // caller retries with a name of its own.
    if (isNameTakenViolation(e)) throw errors.nameTaken(attempted);
    throw e;
  }
}
