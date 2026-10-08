import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/index.js";
import { events, participants, requests, threads, weaveInvitations, weaves } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { isUuid, newId, newSecret } from "../ids.js";
import { validateName } from "../names.js";
import { withWeaveLock, withWeaveLocks, type NewEvent } from "../events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "../actors.js";
import { getInstanceGuidelines, guidelinesFor } from "../guidelines.js";
import { isNameTakenViolation, toPublicWeave, type JoinResult } from "../weaves.js";
import { generalThreadOf } from "../threads.js";
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
 * never carries the target Weave's secret is stated in one place. The payload carries the request id
 * (null for a direct invitation), so an accepted agent knows which request to complete.
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
      targetWeaveTitle: draft.targetWeaveTitle, requestId: draft.requestId },
  };
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

/** One invitation into a Weave that is neither redeemed nor withdrawn (spec 2026-10-08 §5.1). */
export type PendingInvitation = {
  invitationId: string;
  /** The invitee's Lobby participant. */
  participantId: string;
  /** Its Lobby name. */
  inviteeName: string;
  targetThreadId: string;
  targetThreadName: string;
  /** ISO. */
  createdAt: string;
  /** The recorded principal, as stored: a participant id or `keeper:<id>`. */
  createdBy: string;
  /** `Keeper` for an instance keeper, the participant's name for a uuid a row resolves, else null. */
  createdByName: string | null;
  /** Null for a direct invitation, the only kind that can be withdrawn. */
  requestId: string | null;
};

/**
 * The invitations into `targetWeaveId` still pending (spec 2026-10-08 §5): neither redeemed nor
 * withdrawn, oldest first. Keepers of that Weave and the instance keeper only. A request's
 * invitations are listed with their `requestId`, so a keeper sees every way in that is still open;
 * an archived Weave or a closed Thread hides no row, since each is still withdrawable. A read: no
 * lock, no event.
 */
export async function listInvitations(db: Db, actor: Actor, targetWeaveId: string): Promise<PendingInvitation[]> {
  if (!isUuid(targetWeaveId)) throw errors.weaveNotFound();
  assertIsKeeperOf(actor, targetWeaveId);
  const [target] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.id, targetWeaveId));
  if (!target) throw errors.weaveNotFound();
  const rows = await db.select({
    invitationId: weaveInvitations.id, participantId: weaveInvitations.inviteeParticipantId, inviteeName: participants.name,
    targetThreadId: weaveInvitations.targetThreadId, targetThreadName: threads.name, createdAt: weaveInvitations.createdAt,
    createdBy: weaveInvitations.createdBy, requestId: weaveInvitations.requestId,
  })
    .from(weaveInvitations)
    .innerJoin(threads, eq(threads.id, weaveInvitations.targetThreadId))
    .innerJoin(participants, eq(participants.id, weaveInvitations.inviteeParticipantId))
    .where(and(eq(weaveInvitations.targetWeaveId, targetWeaveId), isNull(weaveInvitations.redeemedAt), isNull(weaveInvitations.revokedAt)))
    .orderBy(asc(weaveInvitations.createdAt), asc(weaveInvitations.id));
  // One extra read for the page's distinct principals: an inviting keeper lives in the target, a
  // request's requester in the Lobby, and `keeper:<id>` in no participants row at all.
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((id) => isUuid(id)))];
  const named = ids.length > 0
    ? await db.select({ id: participants.id, name: participants.name }).from(participants).where(inArray(participants.id, ids))
    : [];
  const nameOf = new Map(named.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    invitationId: r.invitationId, participantId: r.participantId, inviteeName: r.inviteeName,
    targetThreadId: r.targetThreadId, targetThreadName: r.targetThreadName, createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy, createdByName: r.createdBy.startsWith("keeper:") ? "Keeper" : (nameOf.get(r.createdBy) ?? null),
    requestId: r.requestId ?? null,
  }));
}

/** What a withdrawal answers (spec 2026-10-08 §4.1). `withdrawnAt` is the row's `revoked_at`, ISO. */
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };

export type WithdrawOptions = {
  /** Test seam: runs after the checks made outside the lock and before the locks are taken. */
  beforeLock?: () => Promise<void>;
};

const NO_SUCH_INVITATION = "No such invitation in this Weave";
const BELONGS_TO_REQUEST = "This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)";
const ALREADY_REDEEMED = "This invitation was already redeemed: take the participant off the Thread with remove_participant instead";

/**
 * Withdraws a direct invitation into `targetWeaveId` before it is redeemed (spec 2026-10-08 §4): the
 * row's `revoked_at` is set and the invitee is told with `weave.invitation_withdrawn` on the Lobby's
 * General Thread, beside the `weave.invited` it undoes; a later redemption answers "This invitation
 * was withdrawn". The authority is `inviteToWeave`'s exactly, checked before anything about the
 * invitation is read and again inside the target's lock. A request's invitation is refused (the
 * removal from its Thread withdraws it), and so is a redeemed one; one already withdrawn answers
 * the original withdrawal's seq with `created: false` and writes nothing. An archived target is no
 * obstacle: a withdrawal only removes access.
 *
 * The Lobby's lock, then the target's, then the row `FOR UPDATE`: the order every cross-Weave flow
 * uses. `redeemInvitation` takes the target's lock and then the row, never the Lobby's, so the two
 * are serialised on the target and exactly one of them wins.
 */
export async function withdrawInvitation(
  db: Db, bus: EventBus, actor: Actor, targetWeaveId: string, invitationId: string, opts: WithdrawOptions = {},
): Promise<WithdrawResult> {
  const { weaveId: lobbyId } = await getLobby(db);
  if (!isUuid(targetWeaveId)) throw errors.weaveNotFound();
  // The authority before anything is read about the invitation: a non-keeper learns nothing of the id.
  assertIsKeeperOf(actor, targetWeaveId);
  // No invitation can target the Lobby (inviteToWeave refuses it), and withWeaveLocks must not be
  // asked for the same row twice.
  if (targetWeaveId === lobbyId || !isUuid(invitationId)) throw errors.notFound(NO_SUCH_INVITATION);
  if (opts.beforeLock) await opts.beforeLock();
  return withWeaveLocks<WithdrawResult>(db, bus, [lobbyId, targetWeaveId], async (tx, byId) => {
    const lobby = byId[lobbyId]!;
    const target = byId[targetWeaveId]!;
    // The role the actor carries was captured when its credential was resolved; it may have been
    // taken away since. No archived check (spec §4.3).
    await assertStillKeeperOf(tx, actor, targetWeaveId);
    const [inv] = await tx.select().from(weaveInvitations).where(eq(weaveInvitations.id, invitationId)).for("update");
    if (!inv || inv.targetWeaveId !== targetWeaveId) throw errors.notFound(NO_SUCH_INVITATION);
    // Before the two state checks, so a request's invitation answers the same whatever its state.
    if (inv.requestId !== null) throw errors.validation(BELONGS_TO_REQUEST);
    if (inv.revokedAt) {
      // Only this function withdraws a direct invitation, and always writes its event in the same
      // transaction, so the newest event naming the id is that withdrawal (spec §4.4); 0 when none
      // is found, the "none" value lastRemovalSeq uses.
      const [withdrawal] = await tx.select({ seq: events.seq }).from(events)
        .where(and(eq(events.weaveId, lobbyId), eq(events.type, "weave.invitation_withdrawn"),
          sql`${events.payload}->>'invitationId' = ${invitationId}`))
        .orderBy(desc(events.seq)).limit(1);
      return { result: { invitationId, seq: withdrawal?.seq ?? 0, withdrawnAt: inv.revokedAt.toISOString(), created: false }, events: {} };
    }
    if (inv.redeemedAt) throw errors.validation(ALREADY_REDEEMED);
    const now = new Date();
    await tx.update(weaveInvitations).set({ revokedAt: now }).where(eq(weaveInvitations.id, invitationId));
    const by = actorId(actor);
    // A Lobby reader cannot resolve `by` (a target-Weave id, or keeper:<id>), so the name travels too.
    const byName = actor.kind === "participant" ? actor.participant.name : "Keeper";
    const event: NewEvent = {
      threadId: await lobbyGeneralThreadId(tx, lobbyId), type: "weave.invitation_withdrawn", actor: by,
      payload: { invitationId, participantId: inv.inviteeParticipantId, targetWeaveTitle: target.title, withdrawnBy: by, withdrawnByName: byName },
    };
    return { result: { invitationId, seq: lobby.lastSeq + 1, withdrawnAt: now.toISOString(), created: true }, events: { [lobbyId]: [event] } };
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
 *
 * Both events land on the invitation's Thread, so `participant.joined` is announced where the work
 * is rather than in the target's General as an ordinary `joinWeave` announces it: whoever is
 * waiting in that Thread sees the newcomer arrive beside the invite that asked for it.
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
      if (inv.revokedAt) throw errors.forbidden("This invitation was withdrawn");
      const isInvitee = (actor.kind === "participant" && actor.participant.id === inv.inviteeParticipantId)
        || (actor.kind === "agent" && inv.inviteeAgentId !== null && actor.agent.id === inv.inviteeAgentId);
      if (!isInvitee) throw errors.forbidden("This invitation is addressed to someone else");
      if (weave.archivedAt) throw errors.weaveArchived();
      const [thread] = await tx.select().from(threads).where(eq(threads.id, inv.targetThreadId));
      if (!thread || thread.weaveId !== weave.id) throw errors.threadNotFound();
      if (thread.closedAt) throw errors.threadClosed();
      const [invitee] = await tx.select().from(participants).where(eq(participants.id, inv.inviteeParticipantId));
      if (!invitee) throw errors.validation("The invitee is no longer a participant of the Lobby");
      // The agent behind the identity is the **invitation's**, not the credential's: redeeming with
      // the invitee's Lobby participant token must reach the same identity in the target Weave that
      // redeeming with its agent key would, and leave it linked to that key.
      const agentId = actor.kind === "agent" ? actor.agent.id : inv.inviteeAgentId;
      // An agent owns at most one participant per Weave: redeeming into a Weave it is already in is
      // an adoption of that identity, not a second one.
      const [mine] = agentId
        ? await tx.select().from(participants)
          .where(and(eq(participants.weaveId, weave.id), eq(participants.agentId, agentId))).limit(1)
        : [undefined];
      const out: NewEvent[] = [];
      let p = mine;
      if (!p) {
        const name = validateName(who.name ?? invitee.name);
        attempted = name;
        [p] = await tx.insert(participants).values({ id: newId(), weaveId: weave.id, name, kind: invitee.kind,
          role: "member", token: newSecret(), agentId }).returning();
        out.push({ threadId: thread.id, type: "participant.joined", actor: p!.id,
          payload: { participantId: p!.id, name: p!.name, kind: p!.kind, role: p!.role } });
      }
      out.push({ threadId: thread.id, type: "thread.invited", actor: inv.createdBy,
        payload: { threadId: thread.id, invitedBy: inv.createdBy, participantId: p!.id } });
      await tx.update(weaveInvitations).set({ redeemedAt: new Date(), redeemedParticipantId: p!.id })
        .where(eq(weaveInvitations.id, inviteId));
      const general = await generalThreadOf(tx, weave.id);
      return {
        result: {
          weaveId: weave.id, weave: toPublicWeave({ ...weave, lastSeq: weave.lastSeq + out.length }),
          generalThreadId: general.id, participant: toPublicParticipant(p!), token: p!.token,
          alreadyJoined: !!mine, guidelines: guidelinesFor(await getInstanceGuidelines(tx), weave),
        },
        events: out,
      };
    });
  } catch (e) {
    // The per-Weave unique name index is what decides a collision, exactly as in `joinWeave`; the
    // caller retries with a name of its own.
    if (isNameTakenViolation(e)) throw errors.nameTaken(attempted);
    throw e;
  }
}
