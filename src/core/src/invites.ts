import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor } from "./types.js";

/**
 * Invites a participant of the Weave into a Thread: a targeted "your input is wanted here", never an
 * access change (every participant can already read every Thread). Allowed for the Thread's creator
 * or a keeper of the Weave. Idempotent: a participant already invited to the Thread gets the original
 * event's seq back and no new event.
 */
export async function inviteParticipant(db: Db, bus: EventBus, actor: Actor, threadId: string, participantId: string): Promise<{ seq: number; created: boolean }> {
  const t = await getThread(db, threadId);
  const isCreator = actor.kind === "participant" && actor.participant.weaveId === t.weaveId && actor.participant.id === t.createdBy;
  if (!isCreator) assertIsKeeperOf(actor, t.weaveId);
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Weave");
  const me = actorId(actor);
  if (me === participantId) throw errors.validation("You cannot invite yourself");
  // Explicit type argument: inference would otherwise narrow T to the first branch's `created: false`.
  return withWeaveLock<{ seq: number; created: boolean }>(db, bus, t.weaveId, async (tx, weave) => {
    if (!isCreator) await assertStillKeeperOf(tx, actor, t.weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    const [invitee] = await tx.select({ id: participants.id }).from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, t.weaveId))).limit(1);
    if (!invitee) throw errors.validation("No such participant in this Weave");
    const [existing] = await tx.select({ seq: events.seq }).from(events)
      .where(and(eq(events.threadId, threadId), eq(events.type, "thread.invited"), sql`${events.payload}->>'participantId' = ${participantId}`))
      .orderBy(asc(events.seq)).limit(1);
    if (existing) return { result: { seq: existing.seq, created: false }, events: [] };
    return {
      result: { seq: weave.lastSeq + 1, created: true },
      events: [{ threadId, type: "thread.invited" as const, actor: me, payload: { threadId, participantId, invitedBy: me } }],
    };
  });
}
