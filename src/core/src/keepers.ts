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
 * What a seed run actually did, so the caller can say so instead of guessing from its own input.
 * `seeded` is rows inserted, `existing` the keepers already in the table (which is what makes the
 * run a no-op), and `ignored` the configured entries dropped as malformed or repeated.
 */
export type SeedKeepersResult = { seeded: number; existing: number; ignored: number };

/**
 * Bootstraps the keeper store from the configured tokens. Only ever runs against an empty table:
 * after first boot keepers are managed through the admin API, and a removed one must stay removed
 * across restarts. Malformed tokens are ignored rather than seeded, and repeated ones are seeded once.
 *
 * The counts are returned rather than kept quiet because the skip is invisible from outside: a new
 * token added to `.env` on a database that already has keepers does nothing at all, and the boot
 * log has to be able to say that (dogfood finding, 2026-09-15).
 */
export async function seedKeepers(db: Db, tokens: string[]): Promise<SeedKeepersResult> {
  // Deduplicated: the same token twice is one keeper, not one keeper and a dropped insert.
  const clean = [...new Set(tokens.map((t) => t.trim()).filter((t) => KEEPER_TOKEN_RE.test(t)))];
  const ignored = tokens.length - clean.length;
  return db.transaction(async (tx) => {
    // The whole (tiny) set, not `limit(1)`: the count is what the caller reports when it skips.
    const existing = await tx.select({ id: keepers.id }).from(keepers);
    if (existing.length > 0 || clean.length === 0) return { seeded: 0, existing: existing.length, ignored };
    const inserted = await tx.insert(keepers)
      .values(clean.map((token, i) => ({ id: newId(), name: `seed-${i + 1}`, token })))
      .onConflictDoNothing({ target: keepers.token })
      .returning({ id: keepers.id });
    return { seeded: inserted.length, existing: 0, ignored };
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

export type RemoveKeeperOptions = {
  /** Test seam: runs after the freshness check, before the removal transaction opens. */
  afterAuth?: () => Promise<void>;
};

export async function removeKeeper(db: Db, actor: Actor, id: string, opts: RemoveKeeperOptions = {}): Promise<void> {
  await assertInstanceKeeperFresh(db, actor);
  if (actor.kind === "keeper" && actor.keeperId === id) throw errors.validation("A keeper cannot remove itself");
  if (!isUuid(id)) throw errors.validation("No such keeper");
  if (opts.afterAuth) await opts.afterAuth();
  // Two removals that each passed their own freshness check delete different rows, so nothing in
  // the database conflicts and both can commit — leaving no keeper at all. That is worse than a
  // lockout: seedKeepers treats an empty table as a first boot, so the next restart re-seeds the
  // env tokens these keepers had replaced. Locking every keeper row serializes removals, and the
  // count is then read under that lock.
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: keepers.id }).from(keepers).for("update");
    // The pre-transaction freshness check can be stale by the time the lock is granted: with three
    // or more keepers the counts stay healthy, so a keeper revoked while its own removal waited for
    // the lock would otherwise still commit it. The locked rows are the authoritative keeper set,
    // so the actor's own row is re-checked against them and a revoked actor gets the same
    // `invalid_token` the pre-transaction check raises.
    if (actor.kind === "keeper" && !all.some((k) => k.id === actor.keeperId)) throw errors.invalidToken();
    if (!all.some((k) => k.id === id)) throw errors.validation("No such keeper");
    // Kept as an explicit invariant. With the actor re-check above it is unreachable — actor and
    // target are both in `all` and differ, so `all` holds at least two — but it is the guard that
    // states the rule, and it is what catches an emptied store if the self-check is ever relaxed.
    if (all.length <= 1) throw errors.validation("Cannot remove the last keeper");
    await tx.delete(keepers).where(eq(keepers.id, id));
  });
}
