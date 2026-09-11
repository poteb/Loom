import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { getSettings } from "./settings.js";
import { parseMentions } from "./mentions.js";
import { withWeaveLock, readEvents } from "./events.js";
import { assertParticipantOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor, LoomEvent } from "./types.js";

export async function postMessage(db: Db, bus: EventBus, actor: Actor, threadId: string, text: string): Promise<LoomEvent> {
  const t = await getThread(db, threadId);
  const me = assertParticipantOf(actor, t.weaveId);
  if (text.trim().length === 0) throw errors.validation("Message text is empty");
  const settings = await getSettings(db);
  if (text.length > settings.maxMessageLength) throw errors.messageTooLong(settings.maxMessageLength);

  // The lock callback returns the seq the message will get (weave.lastSeq + 1 at lock time).
  const seq = await withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    const ps = await tx.select({ id: participants.id, name: participants.name })
      .from(participants).where(eq(participants.weaveId, t.weaveId));
    const mentions = parseMentions(text, ps);
    return {
      result: weave.lastSeq + 1,
      events: [{ threadId, type: "message" as const, actor: me.id, payload: { text, mentions } }],
    };
  });
  // Re-read the committed row so `at` carries the database timestamp.
  const [row] = await readEvents(db, t.weaveId, { since: seq - 1, limit: 1 });
  return row!;
}
