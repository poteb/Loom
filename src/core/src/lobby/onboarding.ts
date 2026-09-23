import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { events, requestOffers, requests, threads, weaveInvitations, weaves } from "../db/schema.js";
import { errors } from "../errors.js";
import { participantForAgent } from "../actors.js";
import { getLobby } from "./lobby.js";
import type { Actor } from "../types.js";

/**
 * What an agent's onboarding is decided from (spec §4.2, §6.9): who it is, where the Lobby is, its
 * own Lobby participant, and what is waiting for it. Core establishes the facts; which instruction
 * to show for them is `@loom/mcp-tools`' onboarding module, which declares the same shape.
 */
export type OnboardingFacts = {
  agent: { name: string; owner: string | null };
  lobby: { weaveId: string; title: string };
  /** The agent's own Lobby participant, or null before join_lobby. */
  me: { participantId: string; name: string; hasProfile: boolean } | null;
  /** Unredeemed, unrevoked invitations addressed to this agent that can still be redeemed. */
  invitations: { inviteId: string; weaveTitle: string; requestId: string | null }[];
  /** Requests whose offer window is open, that list me in `eligible`, that I did not open and have not offered on. */
  requests: { requestId: string; title: string; expiresAt: string }[];
};

export const GET_STARTED_NEEDS_AGENT = "get_started needs an agent-key connection: connect with ?agent=<key> on the /mcp URL";

/**
 * The onboarding facts of an agent key. The raw agent actor, never one mapped into the Lobby: the
 * point is to learn whether it has a Lobby participant at all. A read: it appends nothing and takes
 * no lock (the call that brought it here stamped liveness, like every call).
 */
export async function onboardingFacts(db: Db, actor: Actor, now: Date = new Date()): Promise<OnboardingFacts> {
  if (actor.kind !== "agent") throw errors.validation(GET_STARTED_NEEDS_AGENT);
  const lobby = await getLobby(db);
  const me = await participantForAgent(db, actor.agent.id, lobby.weaveId);
  return {
    agent: { name: actor.agent.name, owner: actor.agent.owner },
    lobby: { weaveId: lobby.weaveId, title: lobby.title },
    me: me ? { participantId: me.id, name: me.name, hasProfile: me.capabilities !== null } : null,
    invitations: await pendingInvitations(db, actor.agent.id, me?.id ?? null),
    requests: me ? await eligibleRequests(db, lobby.weaveId, me.id, now) : [],
  };
}

/** Oldest first. Addressed by the agent id or by its Lobby participant, whichever the issuer recorded. */
async function pendingInvitations(db: Db, agentId: string, meId: string | null): Promise<OnboardingFacts["invitations"]> {
  const invitee = meId === null
    ? eq(weaveInvitations.inviteeAgentId, agentId)
    : or(eq(weaveInvitations.inviteeAgentId, agentId), eq(weaveInvitations.inviteeParticipantId, meId));
  const rows = await db.select({ inviteId: weaveInvitations.id, weaveTitle: weaves.title, requestId: weaveInvitations.requestId })
    .from(weaveInvitations)
    .innerJoin(weaves, eq(weaves.id, weaveInvitations.targetWeaveId))
    .innerJoin(threads, eq(threads.id, weaveInvitations.targetThreadId))
    .where(and(invitee, isNull(weaveInvitations.redeemedAt), isNull(weaveInvitations.revokedAt),
      isNull(weaves.archivedAt), isNull(threads.closedAt)))
    .orderBy(asc(weaveInvitations.createdAt), asc(weaveInvitations.id));
  return rows.map((r) => ({ inviteId: r.inviteId, weaveTitle: r.weaveTitle, requestId: r.requestId ?? null }));
}

/** Oldest first. The offer window is §6.2's: stored open or working, and before expiresAt. */
async function eligibleRequests(db: Db, lobbyId: string, meId: string, now: Date): Promise<OnboardingFacts["requests"]> {
  const windowOpen = await db.select({ requestId: requests.id, threadId: requests.threadId, title: threads.name, expiresAt: requests.expiresAt })
    .from(requests).innerJoin(threads, eq(threads.id, requests.threadId))
    .where(and(inArray(requests.status, ["open", "working"]), gt(requests.expiresAt, now), ne(requests.requesterId, meId)))
    .orderBy(asc(requests.createdAt));
  if (windowOpen.length === 0) return [];
  // The eligibility snapshot lives in the request.opened payload, decided once at open time.
  const addressed = new Set((await db.select({ threadId: events.threadId }).from(events)
    .where(and(eq(events.weaveId, lobbyId), eq(events.type, "request.opened"),
      inArray(events.threadId, windowOpen.map((r) => r.threadId)), sql`${events.payload}->'eligible' ? ${meId}`)))
    .map((e) => e.threadId));
  const offered = new Set((await db.select({ requestId: requestOffers.requestId }).from(requestOffers)
    .where(and(eq(requestOffers.participantId, meId), inArray(requestOffers.requestId, windowOpen.map((r) => r.requestId)))))
    .map((o) => o.requestId));
  return windowOpen
    .filter((r) => addressed.has(r.threadId) && !offered.has(r.requestId))
    .map((r) => ({ requestId: r.requestId, title: r.title, expiresAt: r.expiresAt.toISOString() }));
}
