import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { weaves as weavesTable } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { EventBus } from "./bus.js";
import { resolveCredential, assertCanRead, assertInstanceKeeperFresh, resolveInWeave } from "./actors.js";
import { readEvents } from "./events.js";
import * as weaves from "./weaves.js";
import * as threads from "./threads.js";
import { postMessage } from "./messages.js";
import { inviteParticipant } from "./invites.js";
import { inbox } from "./inbox.js";
import { setRole } from "./participants.js";
import { exportWeave } from "./export.js";
import { getSettings, updateSettings } from "./settings.js";
import { getInstanceGuidelines, setWeaveGuidelines } from "./guidelines.js";
import * as lobby from "./lobby/lobby.js";
import { findAgents, getMyLobbyParticipant, setCapabilities, type AgentFilter } from "./lobby/profile.js";
import * as listeners from "./lobby/listeners.js";
import type { ListenersQuery } from "./lobby/listeners-input.js";
import * as requests from "./lobby/requests.js";
import * as invitations from "./lobby/invitations.js";
import * as keepers from "./keepers.js";
import * as agentsMod from "./agents.js";
import type { Actor, Kind, Role, Settings } from "./types.js";

export type Core = ReturnType<typeof createCore>;

export function createCore(db: Db) {
  const bus = new EventBus();
  /** Lobby operations: map an agent actor through the Lobby. */
  const resolveInLobby = async (actor: Actor) =>
    actor.kind === "agent" ? resolveInWeave(db, actor, (await lobby.getLobby(db)).weaveId) : actor;
  /** Thread-addressed operations: map an agent actor through the Thread's Weave. */
  const forThread = async (actor: Actor, threadId: string) =>
    actor.kind === "agent" ? resolveInWeave(db, actor, (await threads.getThread(db, threadId)).weaveId) : actor;
  return {
    db, bus,
    resolveCredential: (credential: string) => resolveCredential(db, credential),
    createWeave: (input: weaves.CreateWeaveInput, actor?: Actor) => weaves.createWeave(db, bus, input, actor),
    getWeave: async (actor: Actor, weaveId: string) => weaves.getWeave(db, await resolveInWeave(db, actor, weaveId), weaveId),
    // With an `inviteId` this is the secret-less redemption path, not the ordinary join: the actor
    // is passed through as it stands (a Lobby participant token or the agent key that owns it),
    // because the check is against the invitation's recorded invitee, not membership of any Weave.
    joinWeave: async (secret: string, who: { name?: string; kind: Kind }, actor?: Actor, opts: weaves.JoinWeaveOptions = {}) => {
      if (opts.inviteId === undefined) return weaves.joinWeave(db, bus, secret, who, actor, opts);
      if (!actor) throw errors.invalidToken();
      return invitations.redeemInvitation(db, bus, actor, opts.inviteId, who);
    },
    lookupWeaveIdBySecret: (secret: string) => weaves.lookupWeaveIdBySecret(db, secret),
    archiveWeave: async (actor: Actor, weaveId: string) => weaves.archiveWeave(db, bus, await resolveInWeave(db, actor, weaveId), weaveId),
    listWeaves: (actor: Actor) => weaves.listWeaves(db, actor),
    readEvents: async (actor: Actor, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) => {
      const a = await resolveInWeave(db, actor, weaveId);
      assertCanRead(a, weaveId);
      if (!isUuid(weaveId)) throw errors.weaveNotFound();
      const [w] = await db.select({ id: weavesTable.id }).from(weavesTable).where(eq(weavesTable.id, weaveId)).limit(1);
      if (!w) throw errors.weaveNotFound();
      return readEvents(db, weaveId, opts);
    },
    inbox: async (actor: Actor, weaveId: string, opts: { since?: number; limit?: number }) => inbox(db, await resolveInWeave(db, actor, weaveId), weaveId, opts),
    createThread: async (actor: Actor, weaveId: string, name: string, url?: string | null) => threads.createThread(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, name, url),
    setThreadUrl: async (actor: Actor, threadId: string, url: string | null) => threads.setThreadUrl(db, bus, await forThread(actor, threadId), threadId, url),
    closeThread: async (actor: Actor, threadId: string) => threads.closeThread(db, bus, await forThread(actor, threadId), threadId),
    getThreadWeaveId: async (threadId: string) => (await threads.getThread(db, threadId)).weaveId,
    postMessage: async (actor: Actor, threadId: string, text: string) => postMessage(db, bus, await forThread(actor, threadId), threadId, text),
    inviteParticipant: async (actor: Actor, threadId: string, participantId: string) => inviteParticipant(db, bus, await forThread(actor, threadId), threadId, participantId),
    setRole: async (actor: Actor, weaveId: string, participantId: string, role: Role) => setRole(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, participantId, role),
    exportWeave: async (actor: Actor, weaveId: string, format: "md" | "json") => exportWeave(db, await resolveInWeave(db, actor, weaveId), weaveId, format),
    // No unauthenticated getSettings on the facade: adapters go through readSettings, which
    // re-checks instance-keeper standing against the database on every call.
    readSettings: async (actor: Actor) => { await assertInstanceKeeperFresh(db, actor); return getSettings(db); },
    updateSettings: (actor: Actor, patch: Partial<Settings>) => updateSettings(db, actor, patch),
    // Public on purpose: the instance guidelines are handed to a connection before it has a credential.
    getInstanceGuidelines: () => getInstanceGuidelines(db),
    setWeaveGuidelines: async (actor: Actor, weaveId: string, text: string) => setWeaveGuidelines(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, text),
    ensureLobby: (opts?: lobby.EnsureLobbyOptions) => lobby.ensureLobby(db, opts),
    // Anonymous-safe on purpose (an agent must find the Lobby before it holds a credential); an
    // instance keeper's actor also brings back the Lobby's own secret, which no other surface gives.
    getLobby: (actor?: Actor) => lobby.getLobby(db, actor),
    joinLobby: (who: { name?: string; kind: Kind }, actor?: Actor, opts?: weaves.JoinWeaveOptions) => lobby.joinLobby(db, bus, who, actor, opts),
    // Every Lobby operation resolves an agent key against the Lobby first, exactly as the Weave
    // operations above do: without it the registration flow join → set profile → find would need a
    // participant token the agent never asked for.
    setCapabilities: async (actor: Actor, profile: unknown | null) =>
      setCapabilities(db, bus, await resolveInLobby(actor), profile),
    findAgents: async (actor: Actor, filter: AgentFilter) => findAgents(db, await resolveInLobby(actor), filter),
    // The read half of `setCapabilities`, and the only way to read your own profile: `getWeave`
    // carries none in the Lobby, for the caller as for everyone else.
    getMyLobbyParticipant: async (actor: Actor) => getMyLobbyParticipant(db, await resolveInLobby(actor)),
    listListeners: async (actor: Actor, query: ListenersQuery = {}) =>
      listeners.listListeners(db, await resolveInLobby(actor), query),
    // Two credentials, resolved before anything is authorized: the Lobby identity in the Lobby, the
    // target authority in the target Weave. An agent key is one actor everywhere, so it stands for
    // both when the caller gives no separate target credential.
    openRequest: async (actor: Actor, targetActor: Actor | undefined, input: requests.OpenRequestInput) =>
      requests.openRequest(db, bus, await resolveInLobby(actor),
        await resolveInWeave(db, targetActor ?? actor, input.targetWeaveId), input),
    offer: async (actor: Actor, requestId: string, input: { model?: string; effort?: string; note?: string }) =>
      requests.offer(db, bus, await resolveInLobby(actor), requestId, input),
    acceptRequest: async (actor: Actor, requestId: string, participantIds: string[]) =>
      requests.accept(db, bus, await resolveInLobby(actor), requestId, participantIds),
    cancelRequest: async (actor: Actor, requestId: string) =>
      requests.cancelRequest(db, bus, await resolveInLobby(actor), requestId),
    // Resolved against the **target** Weave, not the Lobby: the authority an invitation needs is
    // keepership there, so an agent key stands for the participant it owns in the target.
    inviteToWeave: async (actor: Actor, participantId: string, targetWeaveId: string, targetThreadId: string) =>
      invitations.inviteToWeave(db, bus, await resolveInWeave(db, actor, targetWeaveId), participantId, targetWeaveId, targetThreadId),
    getRequest: async (actor: Actor, requestId: string) => requests.getRequest(db, await resolveInLobby(actor), requestId),
    listRequests: async (actor: Actor, opts: { status?: requests.RequestStatus; limit?: number } = {}) =>
      requests.listRequests(db, await resolveInLobby(actor), opts),
    sweepRequests: (now?: Date) => requests.sweepRequests(db, bus, now),
    seedKeepers: (tokens: string[]) => keepers.seedKeepers(db, tokens),
    listKeepers: (actor: Actor) => keepers.listKeepers(db, actor),
    addKeeper: (actor: Actor, name: string) => keepers.addKeeper(db, actor, name),
    removeKeeper: (actor: Actor, id: string) => keepers.removeKeeper(db, actor, id),
    addAgent: (actor: Actor, name: string) => agentsMod.addAgent(db, actor, name),
    listAgents: (actor: Actor) => agentsMod.listAgents(db, actor),
    revokeAgent: (actor: Actor, id: string) => agentsMod.revokeAgent(db, actor, id),
    resolveInWeave: (actor: Actor, weaveId: string) => resolveInWeave(db, actor, weaveId),
  };
}

export { LoomError, errors, type ErrorCode } from "./errors.js";
export { assertCanRead } from "./actors.js";
export { createDb, runMigrations, closeDb, type Db } from "./db/index.js";
export { migrationsFolder, migrationStatus, assertTransactionSafe, assertPendingTransactionSafe, type MigrationStatus } from "./db/migrations.js";
export { KEEPER_TOKEN_RE } from "./ids.js";
export { MAX_PAGE_LIMIT, validatePage, type PageOptions } from "./paging.js";
export { DEFAULT_INSTANCE_GUIDELINES } from "./guidelines-default.js";
export { MAX_GUIDELINES_LENGTH, INSTANCE_HEADING, WEAVE_HEADING, validateGuidelines, guidelinesFor, type SetGuidelinesOptions } from "./guidelines.js";
export { EventBus } from "./bus.js";
export type { CreateWeaveInput, CreateWeaveResult, WeaveInfo, JoinResult } from "./weaves.js";
export type { PublicKeeper, SeedKeepersResult } from "./keepers.js";
export type { Lobby } from "./lobby/lobby.js";
export { validateProfile, MAX_PROFILE_LENGTH, type AgentFilter, type FoundAgent } from "./lobby/profile.js";
export { validateRequirements, matches, admits, eligible, type Profile, type ModelSpec, type Requirements } from "./lobby/matching.js";
// The listeners query's types live beside its validation, so an adapter has one place to import from.
export { type Listener, type ListenersFacets, type ListenersPage, type ListenersQuery, type ListenersSort, type ServesKind, type FacetValue, type ModelFacet } from "./lobby/listeners-input.js";
export { type InvitationDraft } from "./lobby/invitations.js";
export { computedStatus, type PublicRequest, type PublicOffer, type OpenRequestInput, type RequestStatus, type CloseReason, type AcceptOptions } from "./lobby/requests.js";
export type * from "./types.js";
