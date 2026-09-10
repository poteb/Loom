import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/index.js";
import { settings } from "./db/schema.js";
import { errors } from "./errors.js";
import { assertInstanceKeeper } from "./actors.js";
import type { Actor, Settings } from "./types.js";

const patchSchema = z.object({
  instanceName: z.string().trim().min(1).max(64).optional(),
  maxMessageLength: z.number().int().min(1).max(1_000_000).optional(),
  openWeaveCreation: z.boolean().optional(),
}).strict();

function toSettings(r: typeof settings.$inferSelect): Settings {
  return { instanceName: r.instanceName, maxMessageLength: r.maxMessageLength, openWeaveCreation: r.openWeaveCreation };
}

export async function getSettings(db: Db): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (row) return toSettings(row);
  const [created] = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return toSettings(created);
  const [again] = await db.select().from(settings).where(eq(settings.id, 1));
  return toSettings(again!);
}

export async function updateSettings(db: Db, actor: Actor, patch: Partial<Settings>): Promise<Settings> {
  assertInstanceKeeper(actor);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) throw errors.validation(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const current = await getSettings(db);          // also creates the row on first use
  if (Object.keys(updates).length === 0) return current;
  const [row] = await db.update(settings).set(updates).where(eq(settings.id, 1)).returning();
  return toSettings(row!);
}
