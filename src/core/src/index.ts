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
import { setRole } from "./participants.js";
import { exportWeave } from "./export.js";
import { getSettings, updateSettings } from "./settings.js";
import * as keepers from "./keepers.js";
import * as agentsMod from "./agents.js";
import type { Actor, Kind, Role, Settings } from "./types.js";

export type Core = ReturnType<typeof createCore>;

export function createCore(db: Db) {
  const bus = new EventBus();
  /** Thread-addressed operations: map an agent actor through the Thread's Weave. */
  const forThread = async (actor: Actor, threadId: string) =>
    actor.kind === "agent" ? resolveInWeave(db, actor, (await threads.getThread(db, threadId)).weaveId) : actor;
  return {
    db, bus,
    resolveCredential: (credential: string) => resolveCredential(db, credential),
    createWeave: (input: weaves.CreateWeaveInput, actor?: Actor) => weaves.createWeave(db, bus, input, actor),
    getWeave: async (actor: Actor, weaveId: string) => weaves.getWeave(db, await resolveInWeave(db, actor, weaveId), weaveId),
    joinWeave: (secret: string, who: { name: string; kind: Kind }, actor?: Actor) => weaves.joinWeave(db, bus, secret, who, actor),
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
export { KEEPER_TOKEN_RE } from "./ids.js";
export { EventBus } from "./bus.js";
export type { CreateWeaveInput, CreateWeaveResult, WeaveInfo, JoinResult } from "./weaves.js";
export type { PublicKeeper } from "./keepers.js";
export type * from "./types.js";
