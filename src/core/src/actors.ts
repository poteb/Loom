import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
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

export function assertInstanceKeeper(actor: Actor): void {
  if (actor.kind !== "keeper") throw errors.forbidden("Instance keeper required");
}
