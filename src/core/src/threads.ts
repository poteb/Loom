import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid, newId } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertParticipantOf, assertStillKeeperOf } from "./actors.js";
import { toPublicThread } from "./weaves.js";
import type { Actor, PublicThread } from "./types.js";

export async function getThread(db: Db, threadId: string) {
  if (!isUuid(threadId)) throw errors.threadNotFound();
  const [t] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!t) throw errors.threadNotFound();
  return t;
}

const MAX_URL = 2000;

/** null/undefined → null; otherwise a parsable http(s) URL of at most 2000 chars, trimmed. */
export function validateThreadUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_URL) throw errors.validation(`Thread url must be at most ${MAX_URL} characters`);
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw errors.validation("Thread url must be a valid http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw errors.validation("Thread url must use http or https");
  return trimmed;
}

/** Creator of the thread, or a keeper of its Weave (participant keeper or instance keeper). */
function assertCreatorOrKeeper(actor: Actor, t: { createdBy: string; weaveId: string }): void {
  if (actor.kind === "participant" && actor.participant.weaveId === t.weaveId && actor.participant.id === t.createdBy) return;
  assertIsKeeperOf(actor, t.weaveId);
}

export async function createThread(db: Db, bus: EventBus, actor: Actor, weaveId: string, name: string, url?: string | null): Promise<PublicThread> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) throw errors.validation("Thread name must be 1-100 characters");
  const cleanUrl = validateThreadUrl(url);
  const threadId = newId();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: trimmed, createdBy: me.id, url: cleanUrl }).returning();
    return {
      result: toPublicThread(t!),
      events: [{ threadId, type: "thread.created" as const, actor: me.id, payload: { threadId, name: trimmed, url: cleanUrl } }],
    };
  });
}

export async function setThreadUrl(db: Db, bus: EventBus, actor: Actor, threadId: string, url: string | null): Promise<PublicThread> {
  const t = await getThread(db, threadId);
  assertCreatorOrKeeper(actor, t);
  const cleanUrl = validateThreadUrl(url);
  return withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select().from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    if (actor.kind !== "participant" || actor.participant.id !== fresh!.createdBy) await assertStillKeeperOf(tx, actor, t.weaveId);
    if ((fresh!.url ?? null) === cleanUrl) return { result: toPublicThread(fresh!), events: [] };
    const [updated] = await tx.update(threads).set({ url: cleanUrl }).where(eq(threads.id, threadId)).returning();
    return {
      result: toPublicThread(updated!),
      events: [{ threadId, type: "thread.url_changed" as const, actor: actorId(actor), payload: { threadId, url: cleanUrl } }],
    };
  });
}

export async function closeThread(db: Db, bus: EventBus, actor: Actor, threadId: string): Promise<void> {
  const t = await getThread(db, threadId);
  assertIsKeeperOf(actor, t.weaveId);
  if (t.isGeneral) throw errors.validation("The General thread cannot be closed; archive the Weave instead");
  await withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    await assertStillKeeperOf(tx, actor, t.weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select().from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    await tx.update(threads).set({ closedAt: new Date() }).where(eq(threads.id, threadId));
    return { result: undefined, events: [{ threadId, type: "thread.closed" as const, actor: actorId(actor), payload: { threadId } }] };
  });
}
