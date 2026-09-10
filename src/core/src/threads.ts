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

export async function createThread(db: Db, bus: EventBus, actor: Actor, weaveId: string, name: string): Promise<PublicThread> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) throw errors.validation("Thread name must be 1-100 characters");
  const threadId = newId();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: trimmed, createdBy: me.id }).returning();
    return {
      result: toPublicThread(t!),
      events: [{ threadId, type: "thread.created" as const, actor: me.id, payload: { threadId, name: trimmed } }],
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
