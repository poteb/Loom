import { asc, eq } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import { settings, threads, weaves } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf } from "./actors.js";
import { toPublicWeave } from "./weaves.js";
import { getSettings } from "./settings.js";
import type { Actor, PublicWeave } from "./types.js";

export const MAX_GUIDELINES_LENGTH = 4000;
export const INSTANCE_HEADING = "## Loom guidelines";
export const WEAVE_HEADING = "## Guidelines for this Weave";

/** The one rule for both layers: trimmed Markdown, at most MAX_GUIDELINES_LENGTH characters; whitespace-only clears. */
export function validateGuidelines(text: string): string {
  const t = text.trim();
  if (t.length > MAX_GUIDELINES_LENGTH) throw errors.validation(`guidelines must be at most ${MAX_GUIDELINES_LENGTH} characters`);
  return t;
}

/** What an agent should read: the layers present, each under its heading. Adapters insert this; they never compose it. */
export function guidelinesFor(instance: string, weave?: { guidelines: string }): string {
  const parts: string[] = [];
  if (instance) parts.push(`${INSTANCE_HEADING}\n${instance}`);
  if (weave?.guidelines) parts.push(`${WEAVE_HEADING}\n${weave.guidelines}`);
  return parts.join("\n\n");
}

/** Public read: the text is handed to a connection before it has any credential, and conduct rules are not secrets. */
export async function getInstanceGuidelines(db: Queryable): Promise<string> {
  const [row] = await db.select({ guidelines: settings.guidelines }).from(settings).where(eq(settings.id, 1));
  if (row) return row.guidelines;
  return (await getSettings(db)).guidelines;   // creates the row on first use
}

export type SetGuidelinesOptions = {
  /** Test seam: runs after the pre-lock authority check, so a test can revoke it before the lock. */
  afterAuth?: () => Promise<void>;
};

/**
 * Sets the Weave's guidelines. Weave keeper or instance keeper only; idempotent — text equal to what
 * is stored appends nothing and reports `seq: null`. The appended event carries both the new and the
 * previous text, so the event log is the full history of the rules a Weave ran under.
 */
export async function setWeaveGuidelines(
  db: Db, bus: EventBus, actor: Actor, weaveId: string, text: string, opts: SetGuidelinesOptions = {},
): Promise<{ weave: PublicWeave; seq: number | null }> {
  assertIsKeeperOf(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const next = validateGuidelines(text);
  if (opts.afterAuth) await opts.afterAuth();
  const [general] = await db.select({ id: threads.id }).from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  // Explicit type argument: inference would otherwise narrow T to the first branch's `seq: null`.
  return withWeaveLock<{ weave: PublicWeave; seq: number | null }>(db, bus, weaveId, async (tx, weave) => {
    await assertStillKeeperOf(tx, actor, weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    if (weave.guidelines === next) return { result: { weave: toPublicWeave(weave), seq: null }, events: [] };
    const [updated] = await tx.update(weaves).set({ guidelines: next }).where(eq(weaves.id, weaveId)).returning();
    // appendInTx runs after this callback returns and gives the single event weave.lastSeq + 1;
    // report that seq, and describe the Weave as it will be once the event is committed.
    const seq = weave.lastSeq + 1;
    return {
      result: { weave: toPublicWeave({ ...updated!, lastSeq: seq }), seq },
      events: [{ threadId: general.id, type: "weave.guidelines_changed" as const, actor: actorId(actor), payload: { guidelines: next, previous: weave.guidelines } }],
    };
  });
}
