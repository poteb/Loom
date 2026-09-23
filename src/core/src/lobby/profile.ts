import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { agents, participants } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { withWeaveLock } from "../events.js";
import { assertCanRead, assertParticipantOf, toPublicParticipant } from "../actors.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby.js";
import { admits, isLive, matches, validateRequirements, MAX_INTERVAL_MS, MIN_INTERVAL_MS, type Profile, type Requirements } from "./matching.js";
import type { Actor, PublicParticipant } from "../types.js";

/** The whole profile, serialised, may not exceed this. It is data an agent publishes, not a document. */
export const MAX_PROFILE_LENGTH = 4000;

// Loose, not strict: unknown keys are a listener's own business and are stored and returned as
// given. `serves` is left absent when absent — `admits` already reads that as "owner" — so a
// profile comes back the way it was written.
const profileSchema = z.looseObject({
  models: z.array(z.strictObject({
    model: z.string().trim().min(1).max(100),
    effort: z.string().trim().min(1).max(32),
  })).max(20).optional(),
  tools: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  runtime: z.string().trim().min(1).max(64).optional(),
  spawnsSubagents: z.boolean().optional(),
  owner: z.string().trim().min(1).max(64).optional(),
  serves: z.union([
    z.literal("owner"), z.literal("anyone"),
    z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  ]).optional(),
  // How often this listener checks its inbox (spec §6.8). Requests that ask `maxResponseMs` read it.
  pollIntervalMs: z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS).optional(),
});

/**
 * The one rule for a capability profile. `null` and `{}` both mean "no profile"; anything else must
 * name its `owner`, because a profile without one can only ever be served by `serves: "anyone"`
 * requests and would otherwise look like a working registration.
 */
export function validateProfile(p: unknown): Profile | null {
  if (p === null || p === undefined) return null;
  if (typeof p !== "object" || Array.isArray(p)) throw errors.validation("Profile must be an object");
  if (Object.keys(p).length === 0) return null;
  const parsed = profileSchema.safeParse(p);
  if (!parsed.success) throw errors.validation(parsed.error.issues.map((i) => `capabilities.${i.path.join(".")}: ${i.message}`).join("; "));
  const profile = parsed.data as Profile;
  if (profile.owner === undefined) throw errors.validation("capabilities.owner is required when any other key is present");
  if (JSON.stringify(profile).length > MAX_PROFILE_LENGTH) throw errors.validation(`Profile must be at most ${MAX_PROFILE_LENGTH} characters serialised`);
  return profile;
}

/**
 * The one rule for an owner name, shared by a profile's `owner` and an agent key's (spec §6.7):
 * trimmed, 1 to 64 characters. Returns the trimmed value.
 */
export function validateOwner(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 1 || s.length > 64) throw errors.validation("owner must be 1-64 characters");
  return s;
}

/**
 * The owner an instance keeper stamped on the agent key behind this participant, or null for a
 * participant with no agent, or an agent with no owner. Read fresh on every call, and keyed on the
 * participant's `agent_id`, so a Lobby participant token is held to the same owner as its key.
 */
async function keyOwnerOf(db: Db, participantId: string): Promise<string | null> {
  const [row] = await db.select({ owner: agents.owner }).from(participants)
    .innerJoin(agents, eq(agents.id, participants.agentId))
    .where(eq(participants.id, participantId)).limit(1);
  return row?.owner ?? null;
}

/**
 * ADR 0001 addendum (spec §6.7): a keyed agent with an owner may leave `owner` out, and it is
 * filled from the key; it may give exactly that value; any other value is refused. Clearing
 * (`null` or `{}`) and a profile that is not an object pass through for `validateProfile` to judge.
 */
function withKeyOwner(profile: unknown, keyOwner: string | null): unknown {
  if (keyOwner === null) return profile;
  if (profile === null || profile === undefined || typeof profile !== "object" || Array.isArray(profile)) return profile;
  if (Object.keys(profile).length === 0) return profile;
  const given = (profile as Record<string, unknown>).owner;
  if (given === undefined) return { ...profile, owner: keyOwner };
  if (typeof given === "string" && given.trim() === keyOwner) return profile;
  throw errors.validation(`owner is fixed by your agent key: ${keyOwner}`);
}

/**
 * Sets (or, with `null`, clears) the caller's own Lobby profile. A client that stops listening
 * clears it before dropping its credential, so no eligible profile is left with nobody behind it.
 */
export async function setCapabilities(db: Db, bus: EventBus, actor: Actor, profile: unknown | null): Promise<PublicParticipant> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);
  const clean = validateProfile(withKeyOwner(profile, await keyOwnerOf(db, me.id)));
  const generalThreadId = await lobbyGeneralThreadId(db, lobbyId);
  return withWeaveLock(db, bus, lobbyId, async (tx) => {
    const [updated] = await tx.update(participants).set({ capabilities: clean })
      .where(eq(participants.id, me.id)).returning();
    return {
      result: toPublicParticipant(updated!),
      // Profiles are data, never an instruction: this event says what changed and wakes nobody.
      events: [{ threadId: generalThreadId, type: "participant.capabilities_changed" as const, actor: me.id,
        payload: { participantId: me.id, capabilities: clean } }],
    };
  });
}

/**
 * The caller's own Lobby participant, profile included. The one way to read your own profile now
 * that `getWeave` carries none: authorised as `setCapabilities` is, by being that participant — a
 * Weave secret and an instance keeper own no profile and are refused.
 */
export async function getMyLobbyParticipant(db: Db, actor: Actor): Promise<PublicParticipant> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);
  // Re-read rather than returning the actor's copy: it was captured when the credential resolved,
  // and a profile set from another client a second ago would not be on it.
  const [row] = await db.select().from(participants).where(eq(participants.id, me.id));
  if (!row) throw errors.invalidToken();
  return toPublicParticipant(row);
}

/** A `requirements` filter, plus the owner whose requests the agent would have to serve. */
export type AgentFilter = Requirements & { owner?: string };
export type FoundAgent = { participant: PublicParticipant; capabilities: Profile };

/**
 * The Lobby participants whose profile satisfies `filter`. Matching happens in memory: a profile is
 * a small open-ended document, and the rules that read it are the same pure functions `eligible`
 * uses, so what `find_agents` lists and what a request wakes can never drift apart.
 */
export async function findAgents(db: Db, actor: Actor, filter: AgentFilter): Promise<FoundAgent[]> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  const { owner, ...rest } = filter ?? {};
  if (owner !== undefined && (typeof owner !== "string" || owner.trim().length === 0 || owner.length > 64)) {
    throw errors.validation("owner must be 1-64 characters");
  }
  const req = validateRequirements(rest);
  const rows = await db.select().from(participants)
    .where(and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities)))
    .orderBy(asc(participants.joinedAt));
  // One clock read for the whole list, and the same liveness rule a request's snapshot applies.
  const now = new Date();
  return rows
    .filter((p) => {
      const capabilities = p.capabilities as Profile;
      return matches(capabilities, req) && (owner === undefined || admits(capabilities, owner.trim()))
        && (req.maxResponseMs === undefined || isLive(capabilities, { lastSeenAt: p.lastSeenAt, now }));
    })
    .map((p) => ({ participant: toPublicParticipant(p), capabilities: p.capabilities as Profile }));
}
