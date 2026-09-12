import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import type { Tx } from "./events.js";
import { participants, keepers, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import type { Actor, PublicParticipant } from "./types.js";

export function toPublicParticipant(p: typeof participants.$inferSelect): PublicParticipant {
  return { id: p.id, weaveId: p.weaveId, name: p.name, kind: p.kind, role: p.role, joinedAt: p.joinedAt.toISOString() };
}

/** Resolves a bearer credential: participant token, keeper token, or weave secret. */
export async function resolveCredential(db: Db, credential: string): Promise<Actor> {
  if (!credential) throw errors.invalidToken();
  const [p] = await db.select().from(participants).where(eq(participants.token, credential)).limit(1);
  if (p) return { kind: "participant", participant: toPublicParticipant(p) };
  const [k] = await db.select().from(keepers).where(eq(keepers.token, credential)).limit(1);
  if (k) return { kind: "keeper", keeperId: k.id, name: k.name };
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, credential)).limit(1);
  if (w) return { kind: "secret", weaveId: w.id };
  throw errors.invalidToken();
}

/** Attribution string stored in events. */
export function actorId(actor: Actor): string {
  if (actor.kind === "participant") return actor.participant.id;
  if (actor.kind === "keeper") return `keeper:${actor.keeperId}`;
  throw errors.forbidden("A Weave secret only grants read access; join to write");
}

export function assertCanRead(actor: Actor, weaveId: string): void {
  if (actor.kind === "keeper") return;
  // An agent key is not Weave-scoped; it grants nothing until it is mapped to a participant.
  if (actor.kind === "agent") throw errors.forbidden("Credential does not belong to this Weave");
  const scoped = actor.kind === "participant" ? actor.participant.weaveId : actor.weaveId;
  if (scoped !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
}

export function assertParticipantOf(actor: Actor, weaveId: string): PublicParticipant {
  if (actor.kind !== "participant") throw errors.forbidden("Join the Weave to do this");
  if (actor.participant.weaveId !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
  return actor.participant;
}

export function assertIsKeeperOf(actor: Actor, weaveId: string): void {
  if (actor.kind === "keeper") return;
  if (actor.kind === "participant" && actor.participant.weaveId === weaveId && actor.participant.role === "keeper") return;
  throw errors.forbidden("Only a keeper of this Weave can do this");
}

/**
 * Instance-keeper check against a fresh `keepers` row: an Actor carries the authority captured
 * when its credential was resolved, and the keeper may have been removed since.
 */
export async function assertInstanceKeeperFresh(db: Db, actor: Actor): Promise<void> {
  if (actor.kind !== "keeper") throw errors.forbidden("Instance keeper required");
  const [k] = await db.select({ id: keepers.id }).from(keepers).where(eq(keepers.id, actor.keeperId)).limit(1);
  if (!k) throw errors.invalidToken();
}

/**
 * Re-checks keeper authority against fresh rows inside the Weave lock: an Actor carries the
 * role captured when its credential was resolved and may since have been demoted or removed.
 */
export async function assertStillKeeperOf(tx: Tx, actor: Actor, weaveId: string): Promise<void> {
  if (actor.kind === "participant") {
    const [p] = await tx.select({ weaveId: participants.weaveId, role: participants.role })
      .from(participants).where(eq(participants.id, actor.participant.id)).limit(1);
    if (!p || p.weaveId !== weaveId || p.role !== "keeper") throw errors.forbidden("Only a keeper of this Weave can do this");
    return;
  }
  if (actor.kind === "keeper") {
    const [k] = await tx.select({ id: keepers.id }).from(keepers).where(eq(keepers.id, actor.keeperId)).limit(1);
    if (!k) throw errors.invalidToken();
    return;
  }
  throw errors.forbidden("Only a keeper of this Weave can do this");
}
