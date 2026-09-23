import { createHash } from "node:crypto";
import type { agents } from "./db/schema.js";
import type { PublicAgent } from "./types.js";

/** Only the SHA-256 of an agent key is stored; the key itself is shown once when minted. */
export function hashKey(key: string): string { return createHash("sha256").update(key, "utf8").digest("hex"); }

export function toPublicAgent(a: typeof agents.$inferSelect): PublicAgent {
  return { id: a.id, name: a.name, createdAt: a.createdAt.toISOString(), revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null, owner: a.owner ?? null };
}
