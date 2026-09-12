import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { agents } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid, newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { assertInstanceKeeperFresh } from "./actors.js";
import { hashKey, toPublicAgent } from "./agent-keys.js";
import type { Actor, PublicAgent } from "./types.js";

export { hashKey, toPublicAgent } from "./agent-keys.js";

export async function addAgent(db: Db, actor: Actor, name: string): Promise<{ agent: PublicAgent; key: string }> {
  await assertInstanceKeeperFresh(db, actor);
  const clean = validateName(name);
  const key = newSecret();
  const [row] = await db.insert(agents).values({ id: newId(), name: clean, keyHash: hashKey(key) }).returning();
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
