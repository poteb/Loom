import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, toPublicParticipant } from "./actors.js";
import type { Actor, PublicParticipant, Role } from "./types.js";

export async function setRole(db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, role: Role): Promise<PublicParticipant> {
  assertIsKeeperOf(actor, weaveId);
  if (role !== "member" && role !== "keeper") throw errors.validation("role must be member or keeper");
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
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
