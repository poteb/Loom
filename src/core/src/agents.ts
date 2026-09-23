import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { agents } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid, newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { assertInstanceKeeperFresh } from "./actors.js";
import { validateOwner } from "./lobby/profile.js";
import { hashKey, toPublicAgent } from "./agent-keys.js";
import type { Actor, PublicAgent } from "./types.js";

export { hashKey, toPublicAgent } from "./agent-keys.js";

export async function addAgent(db: Db, actor: Actor, name: string, owner?: string): Promise<{ agent: PublicAgent; key: string }> {
  await assertInstanceKeeperFresh(db, actor);
  const clean = validateName(name);
  const cleanOwner = owner === undefined ? null : validateOwner(owner);
  const key = newSecret();
  const [row] = await db.insert(agents).values({ id: newId(), name: clean, keyHash: hashKey(key), owner: cleanOwner }).returning();
  return { agent: toPublicAgent(row!), key };
}

export async function listAgents(db: Db, actor: Actor): Promise<PublicAgent[]> {
  await assertInstanceKeeperFresh(db, actor);
  return (await db.select().from(agents).orderBy(agents.createdAt)).map(toPublicAgent);
}

/** Revocation stops the key from authenticating; the agent's participants and their history stay. */
export async function revokeAgent(db: Db, actor: Actor, id: string): Promise<void> {
  await assertInstanceKeeperFresh(db, actor);
  if (!isUuid(id)) throw errors.validation("No such agent");
  const [a] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!a) throw errors.validation("No such agent");
  if (a.revokedAt) throw errors.validation("Agent is already revoked");
  await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, id));
}

/**
 * Sets (or replaces) the owner an instance keeper stamps on a key (spec §6.7, D5). It changes the
 * key only: an existing Lobby profile keeps its stored `owner` until the agent next calls
 * `set_capabilities`, which then takes it from the key. There is no way to clear an owner. A
 * malformed, unknown or revoked id is `not_found`; `revokeAgent` keeps its `validation` answer.
 */
export async function setAgentOwner(db: Db, actor: Actor, id: string, owner: string): Promise<PublicAgent> {
  await assertInstanceKeeperFresh(db, actor);
  if (!isUuid(id)) throw errors.notFound("No such agent");
  const clean = validateOwner(owner);
  const [row] = await db.update(agents).set({ owner: clean })
    .where(and(eq(agents.id, id), isNull(agents.revokedAt))).returning();
  if (!row) throw errors.notFound("No such agent");
  return toPublicAgent(row);
}
