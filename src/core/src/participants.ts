import { and, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";
import { generalThreadOf } from "./threads.js";
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
