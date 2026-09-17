import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Queryable } from "./db/index.js";
import { settings } from "./db/schema.js";
import { errors } from "./errors.js";
import { assertInstanceKeeperFresh } from "./actors.js";
import { validateGuidelines } from "./guidelines.js";
import type { Actor, Settings } from "./types.js";

const patchSchema = z.object({
  instanceName: z.string().trim().min(1).max(64).optional(),
  maxMessageLength: z.number().int().min(1).max(1_000_000).optional(),
  openWeaveCreation: z.boolean().optional(),
  guidelines: z.string().transform(validateGuidelines).optional(),
}).strict();

function toSettings(r: typeof settings.$inferSelect): Settings {
  return { instanceName: r.instanceName, maxMessageLength: r.maxMessageLength, openWeaveCreation: r.openWeaveCreation,
    guidelines: r.guidelines };
}

export async function getSettings(db: Queryable): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (row) return toSettings(row);
  const [created] = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return toSettings(created);
  const [again] = await db.select().from(settings).where(eq(settings.id, 1));
  return toSettings(again!);
}

/**
 * The Lobby pointer, read on its own: it is a link between rows rather than a knob an operator
 * turns, so it stays off the public `Settings` shape that `readSettings` and the REST patch use.
 * `settings.lobby_title` is off it for the same reason — `ensureLobby` reads the column directly.
 */
export async function getLobbyWeaveId(db: Queryable): Promise<string | null> {
  const [row] = await db.select({ lobbyWeaveId: settings.lobbyWeaveId }).from(settings).where(eq(settings.id, 1));
  return row?.lobbyWeaveId ?? null;
}

export async function updateSettings(db: Db, actor: Actor, patch: Partial<Settings>): Promise<Settings> {
  await assertInstanceKeeperFresh(db, actor);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) throw errors.validation(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const current = await getSettings(db);          // also creates the row on first use
  if (Object.keys(updates).length === 0) return current;
  const [row] = await db.update(settings).set(updates).where(eq(settings.id, 1)).returning();
  return toSettings(row!);
}
