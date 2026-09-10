import type { Db } from "./db/index.js";
import { EventBus } from "./bus.js";
import { resolveCredential, assertCanRead } from "./actors.js";
import { readEvents } from "./events.js";
import * as weaves from "./weaves.js";
import * as threads from "./threads.js";
import { postMessage } from "./messages.js";
import { setRole } from "./participants.js";
import { exportWeave } from "./export.js";
import { getSettings, updateSettings } from "./settings.js";
import * as keepers from "./keepers.js";
import type { Actor, Kind, Role, Settings } from "./types.js";

export type Core = ReturnType<typeof createCore>;

export function createCore(db: Db) {
  const bus = new EventBus();
  return {
    db, bus,
    resolveCredential: (credential: string) => resolveCredential(db, credential),
    createWeave: (input: weaves.CreateWeaveInput, actor?: Actor) => weaves.createWeave(db, bus, input, actor),
    getWeave: (actor: Actor, weaveId: string) => weaves.getWeave(db, actor, weaveId),
    joinWeave: (secret: string, who: { name: string; kind: Kind }) => weaves.joinWeave(db, bus, secret, who),
    archiveWeave: (actor: Actor, weaveId: string) => weaves.archiveWeave(db, bus, actor, weaveId),
    listWeaves: (actor: Actor) => weaves.listWeaves(db, actor),
    readEvents: async (actor: Actor, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) => {
      assertCanRead(actor, weaveId);
      return readEvents(db, weaveId, opts);
    },
    createThread: (actor: Actor, weaveId: string, name: string) => threads.createThread(db, bus, actor, weaveId, name),
    closeThread: (actor: Actor, threadId: string) => threads.closeThread(db, bus, actor, threadId),
    getThreadWeaveId: async (threadId: string) => (await threads.getThread(db, threadId)).weaveId,
    postMessage: (actor: Actor, threadId: string, text: string) => postMessage(db, bus, actor, threadId, text),
    setRole: (actor: Actor, weaveId: string, participantId: string, role: Role) => setRole(db, bus, actor, weaveId, participantId, role),
    exportWeave: (actor: Actor, weaveId: string, format: "md" | "json") => exportWeave(db, actor, weaveId, format),
    getSettings: () => getSettings(db),
    updateSettings: (actor: Actor, patch: Partial<Settings>) => updateSettings(db, actor, patch),
    seedKeepers: (tokens: string[]) => keepers.seedKeepers(db, tokens),
    listKeepers: (actor: Actor) => keepers.listKeepers(db, actor),
    addKeeper: (actor: Actor, name: string) => keepers.addKeeper(db, actor, name),
    removeKeeper: (actor: Actor, id: string) => keepers.removeKeeper(db, actor, id),
  };
}

export { LoomError, errors, type ErrorCode } from "./errors.js";
export { createDb, runMigrations, closeDb, type Db } from "./db/index.js";
export { EventBus } from "./bus.js";
export type { CreateWeaveInput, CreateWeaveResult, WeaveInfo } from "./weaves.js";
export type { PublicKeeper } from "./keepers.js";
export type * from "./types.js";
