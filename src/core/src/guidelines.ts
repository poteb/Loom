import { eq } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import { settings } from "./db/schema.js";
import { errors } from "./errors.js";
import { getSettings } from "./settings.js";

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
  return (await getSettings(db as Db)).guidelines;   // creates the row on first use
}
