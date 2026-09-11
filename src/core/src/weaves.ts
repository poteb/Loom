import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { weaves, threads, participants } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid, newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { parseMentions } from "./mentions.js";
import { getSettings } from "./settings.js";
import { appendInTx, withWeaveLock } from "./events.js";
import { actorId, assertCanRead, assertInstanceKeeperFresh, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";
import type { Actor, Kind, PublicParticipant, PublicThread, PublicWeave } from "./types.js";

export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind } };
export type CreateWeaveResult = {
  weave: PublicWeave; secret: string; participant: PublicParticipant; token: string; generalThread: PublicThread;
};
export type WeaveInfo = { weave: PublicWeave; threads: PublicThread[]; participants: PublicParticipant[] };

export function toPublicWeave(w: typeof weaves.$inferSelect): PublicWeave {
  return { id: w.id, title: w.title, createdAt: w.createdAt.toISOString(),
    archivedAt: w.archivedAt ? w.archivedAt.toISOString() : null, lastSeq: w.lastSeq };
}
export function toPublicThread(t: typeof threads.$inferSelect): PublicThread {
  return { id: t.id, weaveId: t.weaveId, name: t.name, isGeneral: t.isGeneral, createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(), closedAt: t.closedAt ? t.closedAt.toISOString() : null };
}

/** True only for the per-Weave unique participant-name index; any other unique violation is a bug, not a taken name. */
export function isNameTakenViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const code = err.code ?? err.cause?.code;
  const constraint = err.constraint_name ?? err.cause?.constraint_name;
  return code === "23505" && constraint === "participants_weave_name_idx";
}

export async function createWeave(db: Db, bus: EventBus, input: CreateWeaveInput, actor?: Actor): Promise<CreateWeaveResult> {
  const settings = await getSettings(db);
  if (!settings.openWeaveCreation) {
    if (!actor) throw errors.forbidden("Weave creation is restricted to keepers");
    await assertInstanceKeeperFresh(db, actor);
  }
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) throw errors.validation("Title must be 1-200 characters");
  const name = validateName(input.creator.name);
  if (input.creator.kind !== "human" && input.creator.kind !== "agent") throw errors.validation("kind must be human or agent");
  const opener = input.opener ?? "";
  if (opener.length > settings.maxMessageLength) throw errors.messageTooLong(settings.maxMessageLength);

  const secret = newSecret();
  const token = newSecret();
  const weaveId = newId(); const threadId = newId(); const participantId = newId();

  const { result, committed } = await db.transaction(async (tx) => {
    const [w] = await tx.insert(weaves).values({ id: weaveId, secret, title }).returning();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: participantId }).returning();
    const [p] = await tx.insert(participants).values({ id: participantId, weaveId, name, kind: input.creator.kind, role: "keeper", token }).returning();
    const pub = toPublicParticipant(p!);
    const committed = await appendInTx(tx, w!, [
      { threadId, type: "thread.created", actor: participantId, payload: { threadId, name: "General" } },
      { threadId, type: "participant.joined", actor: participantId, payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } },
      { threadId, type: "message", actor: participantId, payload: { text: opener, mentions: parseMentions(opener, [pub]) } },
    ]);
    return { result: { weave: toPublicWeave(w!), secret, participant: pub, token, generalThread: toPublicThread(t!) }, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function getWeave(db: Db, actor: Actor, weaveId: string): Promise<WeaveInfo> {
  assertCanRead(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const [w] = await db.select().from(weaves).where(eq(weaves.id, weaveId));
  if (!w) throw errors.weaveNotFound();
  const ts = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt));
  const ps = await db.select().from(participants).where(eq(participants.weaveId, weaveId)).orderBy(asc(participants.joinedAt));
  return { weave: toPublicWeave(w), threads: ts.map(toPublicThread), participants: ps.map(toPublicParticipant) };
}

export async function joinWeave(db: Db, bus: EventBus, secret: string, who: { name: string; kind: Kind }) {
  const name = validateName(who.name);
  if (who.kind !== "human" && who.kind !== "agent") throw errors.validation("kind must be human or agent");
  const [found] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, secret));
  if (!found) throw errors.weaveNotFound();
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, found.id)).orderBy(asc(threads.createdAt)).limit(1);
  const token = newSecret();
  const participantId = newId();
  try {
    const participant = await withWeaveLock(db, bus, found.id, async (tx, weave) => {
      if (weave.archivedAt) throw errors.weaveArchived();
      const [p] = await tx.insert(participants).values({ id: participantId, weaveId: weave.id, name, kind: who.kind, role: "member", token }).returning();
      const pub = toPublicParticipant(p!);
      return { result: pub, events: [{ threadId: general!.id, type: "participant.joined" as const, actor: participantId,
        payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } }] };
    });
    return { weaveId: found.id, participant, token };
  } catch (e) {
    if (isNameTakenViolation(e)) throw errors.nameTaken(name);
    throw e;
  }
}

export async function archiveWeave(db: Db, bus: EventBus, actor: Actor, weaveId: string): Promise<void> {
  assertIsKeeperOf(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  await withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    await assertStillKeeperOf(tx, actor, weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    await tx.update(weaves).set({ archivedAt: new Date() }).where(eq(weaves.id, weaveId));
    return { result: undefined, events: [{ threadId: general.id, type: "weave.archived" as const, actor: actorId(actor), payload: {} }] };
  });
}

export async function lookupWeaveIdBySecret(db: Db, secret: string): Promise<string> {
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, secret));
  if (!w) throw errors.weaveNotFound();
  return w.id;
}

export async function listWeaves(db: Db, actor: Actor): Promise<PublicWeave[]> {
  await assertInstanceKeeperFresh(db, actor);
  return (await db.select().from(weaves).orderBy(asc(weaves.createdAt))).map(toPublicWeave);
}
