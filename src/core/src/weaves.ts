import { and, asc, eq } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import { weaves, threads, participants } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid, newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { parseMentions } from "./mentions.js";
import { getLobbyWeaveId, getSettings } from "./settings.js";
import { getInstanceGuidelines, guidelinesFor, validateGuidelines } from "./guidelines.js";
import { appendInTx, withWeaveLock } from "./events.js";
import { generalThreadOf } from "./threads.js";
import { actorId, assertCanRead, assertInstanceKeeperFresh, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";
import type { Actor, Kind, PublicParticipant, PublicThread, PublicWeave } from "./types.js";

export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind }; guidelines?: string };
// `guidelines` on these three results is the combined text an agent should read (instance layer
// then Weave layer); `weave.guidelines` beside it is this Weave's layer alone.
export type CreateWeaveResult = {
  weave: PublicWeave; secret: string; participant: PublicParticipant; token: string; generalThread: PublicThread;
  guidelines: string;
};
export type WeaveInfo = { weave: PublicWeave; threads: PublicThread[]; participants: PublicParticipant[]; guidelines: string };
export type JoinResult = {
  weaveId: string; weave: PublicWeave; generalThreadId: string; participant: PublicParticipant;
  token: string; alreadyJoined?: boolean; guidelines: string;
};

export function toPublicWeave(w: typeof weaves.$inferSelect): PublicWeave {
  return { id: w.id, title: w.title, createdAt: w.createdAt.toISOString(),
    archivedAt: w.archivedAt ? w.archivedAt.toISOString() : null, lastSeq: w.lastSeq,
    guidelines: w.guidelines };
}
export function toPublicThread(t: typeof threads.$inferSelect): PublicThread {
  return { id: t.id, weaveId: t.weaveId, name: t.name, isGeneral: t.isGeneral, createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(), closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    url: t.url ?? null };
}

function isUniqueViolationOn(e: unknown, constraint: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  return (err.code ?? err.cause?.code) === "23505"
    && (err.constraint_name ?? err.cause?.constraint_name) === constraint;
}

/** True only for the per-Weave unique participant-name index; any other unique violation is a bug, not a taken name. */
export function isNameTakenViolation(e: unknown): boolean {
  return isUniqueViolationOn(e, "participants_weave_name_idx");
}

/** True only for the per-Weave unique participant-agent index: this key lost a concurrent first join. */
export function isAgentAlreadyJoinedViolation(e: unknown): boolean {
  return isUniqueViolationOn(e, "participants_weave_agent_idx");
}

export async function createWeave(db: Db, bus: EventBus, input: CreateWeaveInput, actor?: Actor): Promise<CreateWeaveResult> {
  const settings = await getSettings(db);
  if (!settings.openWeaveCreation) {
    if (!actor || actor.kind === "agent") throw errors.forbidden("Weave creation is restricted to keepers");
    await assertInstanceKeeperFresh(db, actor);
  }
  const agentId = actor?.kind === "agent" ? actor.agent.id : null;
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) throw errors.validation("Title must be 1-200 characters");
  const name = validateName(input.creator.name);
  if (input.creator.kind !== "human" && input.creator.kind !== "agent") throw errors.validation("kind must be human or agent");
  const opener = input.opener ?? "";
  if (opener.length > settings.maxMessageLength) throw errors.messageTooLong(settings.maxMessageLength);
  // A blank opener is not a message. `postMessage` refuses text that is empty once trimmed, so an
  // unconditional third event here is the one way a message no participant could have posted gets
  // into a log — a header with nothing under it. Every caller may omit the opener (the CLI's
  // `--opener` defaults to `""`, the web form makes the first message optional), so a Weave created
  // without one is born with two events and `lastSeq` 2. A non-blank opener is stored as given,
  // untrimmed, exactly as `postMessage` stores a message that passes the same check.
  //
  // One deliberate asymmetry with `postMessage`: it *rejects* `"   "` as `validation`, while here a
  // whitespace-only opener is dropped silently. A creation is not a post — every adapter defaults
  // the field, so the caller usually did not write anything at all, and failing a Weave's creation
  // over the blank it was handed would be a worse answer than making the Weave without a first
  // message.
  const hasOpener = opener.trim().length > 0;
  // Creation is the event: the Weave is born with these rules, so no weave.guidelines_changed.
  const guidelines = validateGuidelines(input.guidelines ?? "");

  const secret = newSecret();
  const token = newSecret();
  const weaveId = newId(); const threadId = newId(); const participantId = newId();

  const { result, committed } = await db.transaction(async (tx) => {
    const [w] = await tx.insert(weaves).values({ id: weaveId, secret, title, guidelines }).returning();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: participantId }).returning();
    const [p] = await tx.insert(participants).values({ id: participantId, weaveId, name, kind: agentId ? "agent" : input.creator.kind, role: "keeper", token, agentId }).returning();
    const pub = toPublicParticipant(p!);
    const committed = await appendInTx(tx, w!, [
      // `url: null` so every thread.created payload has the same shape, General included.
      { threadId, type: "thread.created", actor: participantId, payload: { threadId, name: "General", url: null } },
      { threadId, type: "participant.joined", actor: participantId, payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } },
      ...(hasOpener
        ? [{ threadId, type: "message" as const, actor: participantId, payload: { text: opener, mentions: parseMentions(opener, [pub]) } }]
        : []),
    ]);
    return { result: { weave: toPublicWeave(w!), secret, participant: pub, token, generalThread: toPublicThread(t!),
      guidelines: guidelinesFor(settings.guidelines, w!) }, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function getWeave(db: Queryable, actor: Actor, weaveId: string): Promise<WeaveInfo> {
  assertCanRead(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const [w] = await db.select().from(weaves).where(eq(weaves.id, weaveId));
  if (!w) throw errors.weaveNotFound();
  const ts = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt));
  const ps = await db.select().from(participants).where(eq(participants.weaveId, weaveId)).orderBy(asc(participants.joinedAt));
  return { weave: toPublicWeave(w), threads: ts.map(toPublicThread), participants: ps.map(toPublicParticipant),
    guidelines: guidelinesFor(await getInstanceGuidelines(db), w) };
}

export type JoinWeaveOptions = {
  /** Test seam: runs after the pre-lock reads, so a test can commit a change before the lock is taken. */
  beforeLock?: () => Promise<void>;
  /**
   * Redeem a cross-Weave invitation instead of presenting a secret: the facade routes a join
   * carrying one to `redeemInvitation`, which is a dedicated atomic path and not this function
   * (see the comment there). `secret` is then ignored and may be `""`.
   */
  inviteId?: string;
};

export async function joinWeave(db: Db, bus: EventBus, secret: string, who: { name?: string; kind: Kind }, actor?: Actor, opts: JoinWeaveOptions = {}): Promise<JoinResult> {
  // On an agent connection the name is optional (spec 2): the agent's registered name is the
  // default, so a remote client with only a key in its URL can join with nothing else.
  const wanted = who.name?.trim() ? who.name : actor?.kind === "agent" ? actor.agent.name : undefined;
  if (wanted === undefined) throw errors.validation("name is required");
  const name = validateName(wanted);
  if (who.kind !== "human" && who.kind !== "agent") throw errors.validation("kind must be human or agent");
  const [found] = await db.select().from(weaves).where(eq(weaves.secret, secret));
  if (!found) throw errors.weaveNotFound();
  const general = await generalThreadOf(db, found.id);
  const agentId = actor?.kind === "agent" ? actor.agent.id : null;
  // The participant this agent already owns here, read raw: the caller needs its token, so
  // `participantForAgent` (which returns the public shape) is not enough.
  const myParticipant = async () => {
    if (!agentId) return undefined;
    const [mine] = await db.select().from(participants)
      .where(and(eq(participants.agentId, agentId), eq(participants.weaveId, found.id))).limit(1);
    return mine;
  };
  // Both layers are read here rather than up with the other pre-lock reads: `found` was read
  // before the lookup -- and, on the collision path below, before a competing join committed -- so
  // a keeper's setWeaveGuidelines landing in that window would otherwise hand this caller the rules
  // of a moment earlier. No lock is needed: these paths append no event, so what is owed is an
  // answer current as of the moment it is given, not atomicity with a write.
  const asAlreadyJoined = async (p: typeof participants.$inferSelect): Promise<JoinResult> => {
    const [w] = await db.select().from(weaves).where(eq(weaves.id, found.id));
    if (!w) throw errors.weaveNotFound();
    return {
      weaveId: w.id, weave: toPublicWeave(w), generalThreadId: general.id,
      participant: toPublicParticipant(p), token: p.token, alreadyJoined: true,
      guidelines: guidelinesFor(await getInstanceGuidelines(db), w),
    };
  };
  // An agent owns at most one participant per Weave: joining again is a lookup, not a new identity.
  const existing = await myParticipant();
  if (existing) return await asAlreadyJoined(existing);
  if (opts.beforeLock) await opts.beforeLock();
  const token = newSecret();
  const participantId = newId();
  try {
    // Both layers are read from inside the lock: `found` and the instance text were read before
    // it, so a keeper's setWeaveGuidelines -- or an instance keeper's settings patch -- committing
    // in between would leave a new participant holding the rules of a moment earlier. `lastSeq` is
    // advanced by the one event appendInTx is about to write, describing the Weave as it will be
    // once this join commits -- the same shape setWeaveGuidelines reports.
    const { participant, weave, guidelines } = await withWeaveLock(db, bus, found.id, async (tx, weave) => {
      if (weave.archivedAt) throw errors.weaveArchived();
      const [p] = await tx.insert(participants).values({ id: participantId, weaveId: weave.id, name, kind: agentId ? "agent" : who.kind, role: "member", token, agentId }).returning();
      const pub = toPublicParticipant(p!);
      return { result: { participant: pub, weave: { ...weave, lastSeq: weave.lastSeq + 1 },
          guidelines: guidelinesFor(await getInstanceGuidelines(tx), weave) },
        events: [{ threadId: general.id, type: "participant.joined" as const, actor: participantId,
          payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } }] };
    });
    // Everything a client needs to act right away, so the credential never has to be held
    // unsaved while a second (failable) metadata request runs.
    return { weaveId: found.id, weave: toPublicWeave(weave), generalThreadId: general.id, participant, token, guidelines };
  } catch (e) {
    // The lookup above runs outside the Weave lock, so two concurrent first joins by one key can
    // both miss it. The loser trips a unique index -- which one depends on the names: the agent
    // index when they differ, the name index when they are the same -- so either violation means
    // "check whether I already own a participant here" and, if so, adopt the winner's identity,
    // the same idempotent answer a later join would have got. A genuine clash with someone else's
    // name finds no owned participant and falls through to name_taken below.
    if (agentId && (isAgentAlreadyJoinedViolation(e) || isNameTakenViolation(e))) {
      const winner = await myParticipant();
      if (winner) return await asAlreadyJoined(winner);
    }
    if (isNameTakenViolation(e)) throw errors.nameTaken(name);
    throw e;
  }
}

export async function archiveWeave(db: Db, bus: EventBus, actor: Actor, weaveId: string): Promise<void> {
  assertIsKeeperOf(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  // The instance has one Lobby and no way to make another: archiving it would shut every agent
  // out of the only room they all share.
  if (weaveId === await getLobbyWeaveId(db)) throw errors.forbidden("The Lobby cannot be archived");
  const general = await generalThreadOf(db, weaveId);
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
