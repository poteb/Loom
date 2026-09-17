import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { participants } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { withWeaveLock } from "../events.js";
import { assertCanRead, assertParticipantOf, toPublicParticipant } from "../actors.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby.js";
import { admits, matches, validateRequirements, type Profile, type Requirements } from "./matching.js";
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
 * Sets (or, with `null`, clears) the caller's own Lobby profile. A client that stops listening
 * clears it before dropping its credential, so no eligible profile is left with nobody behind it.
 */
export async function setCapabilities(db: Db, bus: EventBus, actor: Actor, profile: unknown | null): Promise<PublicParticipant> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);
  const clean = validateProfile(profile);
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
  return rows
    .map((p) => ({ participant: toPublicParticipant(p), capabilities: p.capabilities as Profile }))
    .filter(({ capabilities }) => matches(capabilities, req) && (owner === undefined || admits(capabilities, owner.trim())));
}
