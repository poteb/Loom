import { asc, eq } from "drizzle-orm";
import type { Db, Queryable, Tx } from "../db/index.js";
import { settings, threads, weaves } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { newId, newSecret } from "../ids.js";
import { appendInTx } from "../events.js";
import { getLobbyWeaveId, getSettings } from "../settings.js";
import { joinWeave, type JoinResult, type JoinWeaveOptions } from "../weaves.js";
import type { Actor, Kind } from "../types.js";

export type Lobby = { weaveId: string; title: string };

/**
 * A Weave nobody created: an ordinary Weave with its own secret and a General thread, but no
 * founding participant and no opener message. The Lobby is the only one so far.
 */
async function createSystemWeave(tx: Tx, title: string): Promise<string> {
  const weaveId = newId();
  const threadId = newId();
  const [w] = await tx.insert(weaves).values({ id: weaveId, secret: newSecret(), title }).returning();
  await tx.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: "system" });
  // Same payload shape as any other thread.created, so a reader never has to special-case the Lobby.
  await appendInTx(tx, w!, [{ threadId, type: "thread.created", actor: "system", payload: { threadId, name: "General", url: null } }]);
  return weaveId;
}

export type EnsureLobbyOptions = {
  /** Test seam: runs after the Weave is created, so a throw there proves the whole creation rolls back. */
  afterCreate?: () => Promise<void>;
};

/**
 * Creates the instance's one Lobby, or reports the one already there.
 *
 * One serialized transaction, because two concurrent boots would otherwise both read a null
 * pointer, create two Lobbies and overwrite each other's pointer: the `FOR UPDATE` on the settings
 * row makes the second boot wait and then see the first one's Lobby.
 */
export async function ensureLobby(db: Db, opts: EnsureLobbyOptions = {}): Promise<{ weaveId: string; created: boolean }> {
  await getSettings(db);                                   // make sure the singleton row exists
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
    if (row!.lobbyWeaveId) return { weaveId: row!.lobbyWeaveId, created: false };
    const weaveId = await createSystemWeave(tx, row!.lobbyTitle);
    if (opts.afterCreate) await opts.afterCreate();
    await tx.update(settings).set({ lobbyWeaveId: weaveId }).where(eq(settings.id, 1));
    return { weaveId, created: true };
  });
}

/** The Lobby pointer, or `weave_not_found` before the first boot created it. */
export async function getLobby(db: Queryable): Promise<Lobby> {
  const lobbyWeaveId = await getLobbyWeaveId(db);
  if (!lobbyWeaveId) throw errors.weaveNotFound();
  const [w] = await db.select({ id: weaves.id, title: weaves.title }).from(weaves).where(eq(weaves.id, lobbyWeaveId));
  if (!w) throw errors.weaveNotFound();
  return { weaveId: w.id, title: w.title };
}

/** The Lobby's General thread: where profile changes and unaddressed Lobby business are logged. */
export async function lobbyGeneralThreadId(db: Queryable, lobbyId: string): Promise<string> {
  const [general] = await db.select({ id: threads.id }).from(threads)
    .where(eq(threads.weaveId, lobbyId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  return general.id;
}

/**
 * Joining the Lobby needs no secret: anyone who can reach the instance may join, as they would a
 * server. The secret is read from the row and handed to the ordinary join, so every rule that
 * governs joining a Weave governs this too.
 */
export async function joinLobby(db: Db, bus: EventBus, who: { name?: string; kind: Kind }, actor?: Actor, opts: JoinWeaveOptions = {}): Promise<JoinResult> {
  const { weaveId } = await getLobby(db);
  const [w] = await db.select({ secret: weaves.secret }).from(weaves).where(eq(weaves.id, weaveId));
  if (!w) throw errors.weaveNotFound();
  return joinWeave(db, bus, w.secret, who, actor, opts);
}
