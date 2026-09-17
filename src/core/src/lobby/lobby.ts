import { eq } from "drizzle-orm";
import type { Db, Queryable, Tx } from "../db/index.js";
import { settings, threads, weaves } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { newId, newSecret } from "../ids.js";
import { appendInTx } from "../events.js";
import { assertInstanceKeeperFresh } from "../actors.js";
import { getLobbyWeaveId, getSettings } from "../settings.js";
import { generalThreadOf } from "../threads.js";
import { joinWeave, type JoinResult, type JoinWeaveOptions } from "../weaves.js";
import type { Actor, Kind } from "../types.js";

export type Lobby = {
  weaveId: string; title: string;
  /**
   * The Lobby's own Weave secret — the read credential for its web page, `/w/<secret>`. Present
   * only for an instance keeper: the Lobby is created by the instance rather than by a person, so
   * without this surface its secret is in no answer any command or route gives, and the page it
   * opens can be reached from nowhere.
   */
  secret?: string;
};

/**
 * A Weave nobody created: an ordinary Weave with its own secret and a General thread, but no
 * founding participant and no opener message. The Lobby is the only one so far.
 */
async function createSystemWeave(tx: Tx, title: string): Promise<{ weaveId: string; secret: string }> {
  const weaveId = newId();
  const threadId = newId();
  const [w] = await tx.insert(weaves).values({ id: weaveId, secret: newSecret(), title }).returning();
  await tx.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: "system" });
  // Same payload shape as any other thread.created, so a reader never has to special-case the Lobby.
  await appendInTx(tx, w!, [{ threadId, type: "thread.created", actor: "system", payload: { threadId, name: "General", url: null } }]);
  return { weaveId, secret: w!.secret };
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
export async function ensureLobby(db: Db, opts: EnsureLobbyOptions = {}): Promise<{ weaveId: string; created: boolean; secret: string }> {
  await getSettings(db);                                   // make sure the singleton row exists
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
    // The secret is handed back unconditionally here, unlike from `getLobby`: the only caller is the
    // boot that owns the database anyway, and it is what lets the server print the Lobby's own URL.
    if (row!.lobbyWeaveId) {
      const [w] = await tx.select({ secret: weaves.secret }).from(weaves).where(eq(weaves.id, row!.lobbyWeaveId));
      if (!w) throw errors.weaveNotFound();
      return { weaveId: row!.lobbyWeaveId, created: false, secret: w.secret };
    }
    const { weaveId, secret } = await createSystemWeave(tx, row!.lobbyTitle);
    if (opts.afterCreate) await opts.afterCreate();
    await tx.update(settings).set({ lobbyWeaveId: weaveId }).where(eq(settings.id, 1));
    return { weaveId, created: true, secret };
  });
}

/**
 * The Lobby pointer, or `weave_not_found` before the first boot created it.
 *
 * Anonymous-safe, because an agent has to learn where the Lobby is before it holds anything to
 * identify itself with. An instance keeper gets the Lobby's secret with it — see `Lobby.secret`;
 * the standing is re-checked against a fresh `keepers` row, as everywhere else keepership decides.
 */
export async function getLobby(db: Queryable, actor?: Actor): Promise<Lobby> {
  const lobbyWeaveId = await getLobbyWeaveId(db);
  if (!lobbyWeaveId) throw errors.weaveNotFound();
  const [w] = await db.select({ id: weaves.id, title: weaves.title, secret: weaves.secret })
    .from(weaves).where(eq(weaves.id, lobbyWeaveId));
  if (!w) throw errors.weaveNotFound();
  if (actor?.kind !== "keeper") return { weaveId: w.id, title: w.title };
  await assertInstanceKeeperFresh(db, actor);
  return { weaveId: w.id, title: w.title, secret: w.secret };
}

/**
 * The Lobby's General thread: where profile changes and unaddressed Lobby business are logged.
 * Selected by its flag rather than by age, because every request opens a Thread of its own here.
 */
export async function lobbyGeneralThreadId(db: Queryable, lobbyId: string): Promise<string> {
  return (await generalThreadOf(db, lobbyId)).id;
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
