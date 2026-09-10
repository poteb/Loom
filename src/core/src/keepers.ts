import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { keepers } from "./db/schema.js";
import { errors } from "./errors.js";
import { KEEPER_TOKEN_RE, isUuid, newId, newSecret } from "./ids.js";
import { assertInstanceKeeperFresh } from "./actors.js";
import type { Actor } from "./types.js";

export type PublicKeeper = { id: string; name: string; createdAt: string };

function toPublic(k: typeof keepers.$inferSelect): PublicKeeper {
  return { id: k.id, name: k.name, createdAt: k.createdAt.toISOString() };
}

/**
 * Bootstraps the keeper store from the configured tokens. Only ever runs against an empty table:
 * after first boot keepers are managed through the admin API, and a removed one must stay removed
 * across restarts. Malformed tokens are ignored rather than seeded.
 */
export async function seedKeepers(db: Db, tokens: string[]): Promise<void> {
  const clean = tokens.map((t) => t.trim()).filter((t) => KEEPER_TOKEN_RE.test(t));
  if (clean.length === 0) return;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: keepers.id }).from(keepers).limit(1);
    if (existing) return;
    await tx.insert(keepers)
      .values(clean.map((token, i) => ({ id: newId(), name: `seed-${i + 1}`, token })))
      .onConflictDoNothing({ target: keepers.token });
  });
}

export async function listKeepers(db: Db, actor: Actor): Promise<PublicKeeper[]> {
  await assertInstanceKeeperFresh(db, actor);
  return (await db.select().from(keepers).orderBy(keepers.createdAt)).map(toPublic);
}

export async function addKeeper(db: Db, actor: Actor, name: string): Promise<{ keeper: PublicKeeper; token: string }> {
  await assertInstanceKeeperFresh(db, actor);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) throw errors.validation("Keeper name must be 1-64 characters");
  const token = newSecret();
  const [row] = await db.insert(keepers).values({ id: newId(), name: trimmed, token }).returning();
  return { keeper: toPublic(row!), token };
}

export async function removeKeeper(db: Db, actor: Actor, id: string): Promise<void> {
  await assertInstanceKeeperFresh(db, actor);
  if (actor.kind === "keeper" && actor.keeperId === id) throw errors.validation("A keeper cannot remove itself");
  if (!isUuid(id)) throw errors.validation("No such keeper");
  const deleted = await db.delete(keepers).where(eq(keepers.id, id)).returning({ id: keepers.id });
  if (deleted.length === 0) throw errors.validation("No such keeper");
}
