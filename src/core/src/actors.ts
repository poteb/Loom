import { and, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import type { Tx } from "./events.js";
import { participants, keepers, weaves, agents, settings } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { hashKey, toPublicAgent } from "./agent-keys.js";
import type { Profile } from "./lobby/matching.js";
import type { Actor, PublicParticipant } from "./types.js";

export function toPublicParticipant(p: typeof participants.$inferSelect): PublicParticipant {
  return { id: p.id, weaveId: p.weaveId, name: p.name, kind: p.kind, role: p.role,
    joinedAt: p.joinedAt.toISOString(), agentId: p.agentId ?? null,
    capabilities: (p.capabilities as Profile | null) ?? null,
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null, kickedAt: p.kickedAt ? p.kickedAt.toISOString() : null };
}

/** A participant's `last_seen_at` is written at most once per this many milliseconds (spec §6.6). */
export const SEEN_THROTTLE_MS = 10_000;

/**
 * A stamp is a new check-in in `seen_history` only when the history's last entry is at least this
 * many milliseconds before it (spec 2026-09-27 §4.1 as amended): one poll run makes several calls
 * seconds apart, and counts once, so the cadence measures the time between runs.
 */
export const CHECKIN_SPACING_MS = 60_000;

/**
 * Liveness (spec §6.6), and the check-in history (spec 2026-09-27 §4.1 as amended): sets
 * `last_seen_at = now` on the participants `which` selects, unless one was written ten seconds or
 * less before `now` (exactly ten seconds still skips), and in the **same statement** appends `now`
 * to `seen_history`, cut to its last 20 entries, oldest first, when the history is empty or its last
 * entry is `CHECKIN_SPACING_MS` or more before `now` (exactly 60 s appends); otherwise the history
 * stays as it was. The `WHERE` is unchanged (`which` and the throttle, no condition on the history),
 * so a skipped stamp appends nothing. The history's last element is therefore the last check-in,
 * which can be up to a minute older than `last_seen_at`. A row last stamped before 0007 has
 * `last_seen_at` and no history until its next stamp. It is not an event and takes no Weave lock,
 * so a poll neither grows the log nor wakes anyone. A stamp that fails fails the call, which was
 * about to use the same database anyway.
 */
export async function stampSeen(db: Db, which: SQL, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SEEN_THROTTLE_MS);
  const at = sql`${now.toISOString()}::timestamptz`;
  const spaced = sql`${new Date(now.getTime() - CHECKIN_SPACING_MS).toISOString()}::timestamptz`;
  const history = participants.seenHistory;
  await db.update(participants).set({
    lastSeenAt: now,
    // The last element of a null or empty array is null, so an empty history always appends. The
    // previous history plus `now`: n + 1 entries, of which the last 20 start at index n - 18
    // (Postgres arrays are 1-based, and an open upper bound runs to the end).
    seenHistory: sql`CASE WHEN coalesce(${history}[cardinality(${history})] <= ${spaced}, true)
      THEN (array_append(coalesce(${history}, '{}'), ${at}))[greatest(coalesce(cardinality(${history}), 0) - 18, 1):]
      ELSE ${history} END`,
  }).where(and(which, or(isNull(participants.lastSeenAt), lt(participants.lastSeenAt, cutoff))));
}

/** What a kicked participant's credential is answered with, on every surface (spec 2026-10-09 §7). */
export const REMOVED_FROM_WEAVE = "You were removed from this Weave";

/**
 * Resolves a bearer credential: participant token, keeper token, agent key, or weave secret. Every
 * authenticated call passes through here, so this is where liveness is stamped: a participant
 * token stamps that participant, an agent key its Lobby participant if it has one. A Weave secret
 * and an instance keeper token stand for no participant and stamp nothing.
 */
export async function resolveCredential(db: Db, credential: string, now: Date = new Date()): Promise<Actor> {
  if (!credential) throw errors.invalidToken();
  const [p] = await db.select().from(participants).where(eq(participants.token, credential)).limit(1);
  if (p) {
    // Kicked out of its Weave by a keeper (spec 2026-10-09 §7.2): refused before the stamp, so a
    // refused token checks nothing in. Every surface resolves its credential here.
    if (p.kickedAt) throw errors.forbidden(REMOVED_FROM_WEAVE);
    await stampSeen(db, eq(participants.id, p.id), now);
    // `p` was read before the stamp, so the actor's copy of lastSeenAt is one stamp stale. No rule
    // reads it from the actor; the reads that report lastSeenAt load the row again.
    return { kind: "participant", participant: toPublicParticipant(p) };
  }
  const [k] = await db.select().from(keepers).where(eq(keepers.token, credential)).limit(1);
  if (k) return { kind: "keeper", keeperId: k.id, name: k.name };
  const [a] = await db.select().from(agents).where(and(eq(agents.keyHash, hashKey(credential)), isNull(agents.revokedAt))).limit(1);
  if (a) {
    // The Lobby is where "is this agent listening" is read. Inside another Weave, resolveInWeave
    // stamps that Weave's participant when the call maps the key there.
    await stampSeen(db, sql`${participants.agentId} = ${a.id} and ${participants.weaveId} = (select ${settings.lobbyWeaveId} from ${settings} where ${settings.id} = 1)`, now);
    return { kind: "agent", agent: toPublicAgent(a) };
  }
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, credential)).limit(1);
  if (w) return { kind: "secret", weaveId: w.id };
  throw errors.invalidToken();
}

/** The participant an agent owns in a Weave, if it has joined. */
export async function participantForAgent(db: Db, agentId: string, weaveId: string): Promise<PublicParticipant | undefined> {
  const [p] = await db.select().from(participants)
    .where(and(eq(participants.agentId, agentId), eq(participants.weaveId, weaveId))).limit(1);
  return p ? toPublicParticipant(p) : undefined;
}

/**
 * An agent key is an instance-level identity; inside a Weave it acts as the participant it owns
 * there. Every Weave-scoped operation resolves through here first; non-agent actors pass through.
 */
export async function resolveInWeave(db: Db, actor: Actor, weaveId: string): Promise<Actor> {
  if (actor.kind !== "agent") return actor;
  // Guard before querying: `participants.weave_id` is a uuid column, so a malformed id would
  // surface as a raw Postgres error instead of a Loom one. Callers guard too, but they run later.
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = await participantForAgent(db, actor.agent.id, weaveId);
  if (!me) throw errors.forbidden("Join the Weave first");
  // The agent's participant there was kicked (spec 2026-10-09 §7.3): refused before the stamp.
  // participantForAgent itself answers what exists; its one direct caller reads the Lobby.
  if (me.kickedAt !== null) throw errors.forbidden(REMOVED_FROM_WEAVE);
  await stampSeen(db, eq(participants.id, me.id), new Date());
  return { kind: "participant", participant: me };
}

/** Attribution string stored in events. */
export function actorId(actor: Actor): string {
  if (actor.kind === "participant") return actor.participant.id;
  if (actor.kind === "keeper") return `keeper:${actor.keeperId}`;
  // A raw agent actor must have been resolved through resolveInWeave before reaching here.
  if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");
  throw errors.forbidden("A Weave secret only grants read access; join to write");
}

export function assertCanRead(actor: Actor, weaveId: string): void {
  // An agent key is not Weave-scoped; it grants nothing until it is mapped to a participant.
  if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");
  if (actor.kind === "keeper") return;
  const scoped = actor.kind === "participant" ? actor.participant.weaveId : actor.weaveId;
  if (scoped !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
}

export function assertParticipantOf(actor: Actor, weaveId: string): PublicParticipant {
  if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");
  if (actor.kind !== "participant") throw errors.forbidden("Join the Weave to do this");
  if (actor.participant.weaveId !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
  return actor.participant;
}

export function assertIsKeeperOf(actor: Actor, weaveId: string): void {
  if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");
  if (actor.kind === "keeper") return;
  if (actor.kind === "participant" && actor.participant.weaveId === weaveId && actor.participant.role === "keeper") return;
  throw errors.forbidden("Only a keeper of this Weave can do this");
}

/**
 * Instance-keeper check against a fresh `keepers` row: an Actor carries the authority captured
 * when its credential was resolved, and the keeper may have been removed since.
 */
export async function assertInstanceKeeperFresh(db: Queryable, actor: Actor): Promise<void> {
  if (actor.kind !== "keeper") throw errors.forbidden("Instance keeper required");
  const [k] = await db.select({ id: keepers.id }).from(keepers).where(eq(keepers.id, actor.keeperId)).limit(1);
  if (!k) throw errors.invalidToken();
}

/**
 * Re-checks keeper authority against fresh rows inside the Weave lock: an Actor carries the
 * role captured when its credential was resolved and may since have been demoted or removed.
 */
export async function assertStillKeeperOf(tx: Tx, actor: Actor, weaveId: string): Promise<void> {
  if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");
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
