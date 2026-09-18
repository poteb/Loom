import { LoomClientError, type LoomClient } from "@loom/client";
import type { KeyValueStorage, WriteResult } from "./storage.js";
import type { PersistenceNotice } from "./persistence.js";

/**
 * What this browser holds for one Weave. `token` + `participantId` are the **identity**; `secret` is
 * an **independent credential** that no identity failure ever deletes; `title`/`archived` are a
 * display cache, and `lastOpenedAt` orders My Weaves.
 */
export type WeaveEntry = {
  token?: string; participantId?: string; identity?: "invalid";
  secret?: string; title?: string; archived?: boolean; lastOpenedAt?: string;
  /**
   * The name this browser is joined under in that Weave — a display cache like `title`, never a
   * credential and never sent anywhere. It is what lets "joined as `dana`" be rendered from storage
   * alone, with no request (spec §4.1, §4.2); it belongs to the identity, so it is written with it
   * and deleted with it.
   */
  name?: string;
};

/** Both stored shapes. Legacy `loom:<secret>` entries stay readable forever (spec §2.4). */
export type StoredWeave =
  | ({ kind: "id"; weaveId: string } & WeaveEntry)
  | { kind: "legacy"; secret: string; token: string; participantId?: string };

export const KEY_PREFIX = "loom:";
export const WEAVE_PREFIX = "loom:weave:";

export function weaveKey(weaveId: string): string { return `${WEAVE_PREFIX}${weaveId}`; }
export function legacyKey(secret: string): string { return `${KEY_PREFIX}${secret}`; }

export function readWeaveEntry(storage: KeyValueStorage, weaveId: string): WeaveEntry | undefined {
  const raw = storage.get(weaveKey(weaveId));
  if (!raw) return undefined;
  try { return JSON.parse(raw) as WeaveEntry; } catch { return undefined; }
}

/** Merges the defined keys of `patch` over what is stored. Never deletes a key. */
export function saveWeaveEntry(storage: KeyValueStorage, weaveId: string, patch: Partial<WeaveEntry>): WriteResult {
  const next: WeaveEntry = { ...(readWeaveEntry(storage, weaveId) ?? {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return storage.set(weaveKey(weaveId), JSON.stringify(next));
}

/**
 * Writes an identity and clears `identity: "invalid"`, in **one** write — `extra` carries whatever
 * else the same moment learned (`secret`, `title`, `lastOpenedAt`), so a caller never has to trust
 * the verdict of a small write to stand for a larger one. The one writer for join/create/rejoin.
 */
export function setIdentity(
  storage: KeyValueStorage, weaveId: string,
  who: { token: string; participantId: string; name?: string }, extra: Partial<WeaveEntry> = {},
): WriteResult {
  // Spread-minus, not `saveWeaveEntry`: a rejoin has to *clear* `identity`, and a merge cannot.
  // One write, `extra` included: two writes would let the credential persist while the secret beside
  // it did not (or the reverse), and leave the caller branching on the verdict of the wrong one.
  // `name` travels inside `who` rather than in `extra`, because it is part of the identity: it is
  // written with the token and deleted with it.
  const { identity: _dropped, ...rest } = readWeaveEntry(storage, weaveId) ?? {};
  const next: WeaveEntry = { ...rest, token: who.token, participantId: who.participantId };
  if (who.name !== undefined) next.name = who.name;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  return storage.set(weaveKey(weaveId), JSON.stringify(next));
}

/** Deletes `token`/`participantId`/`name`, sets `identity: "invalid"`. Keeps `secret` and the cache. */
export function invalidateIdentity(storage: KeyValueStorage, weaveId: string): WriteResult {
  // The secret is an independent credential: a dead token is no evidence against it (spec §2.6).
  // `name` goes with the token, because it names *that* identity — the Weave's own title, its
  // archived flag and when it was last opened are facts about the Weave and stay.
  const { token: _t, participantId: _p, name: _n, ...rest } = readWeaveEntry(storage, weaveId) ?? {};
  return storage.set(weaveKey(weaveId), JSON.stringify({ ...rest, identity: "invalid" as const }));
}

/** The only thing that deletes an entry: `Forget`. A failed removal leaves a tombstone (§2.4b). */
export function forgetWeave(storage: KeyValueStorage, weaveId: string): void {
  storage.remove(weaveKey(weaveId));
}

export function hasIdentity(e: WeaveEntry | undefined): e is WeaveEntry & { token: string; participantId: string } {
  return !!e && !!e.token && !!e.participantId && e.identity !== "invalid";
}

export function storedWeaves(storage: KeyValueStorage): StoredWeave[] {
  const out: StoredWeave[] = [];
  for (const key of storage.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const rest = key.slice(KEY_PREFIX.length);
    const raw = storage.get(key);
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as WeaveEntry;
      if (rest.startsWith("weave:")) {
        const weaveId = rest.slice("weave:".length);
        if (weaveId) out.push({ kind: "id", weaveId, ...v });
      } else if (!rest.includes(":") && v.token) {
        out.push({ kind: "legacy", secret: rest, token: v.token, participantId: v.participantId });
      }
    } catch { /* a corrupt entry is simply not a Weave this browser can offer */ }
  }
  return out;
}

/**
 * How a legacy `loom:<secret>` entry folds into an id-keyed one. The **id entry is authoritative**:
 * duplicates are a supported state (a non-durable migration leaves one on purpose), so a leftover
 * legacy key must never undo a rejoin that happened since.
 *
 * An entry marked `identity: "invalid"` does not take the legacy identity either. Invalidation
 * deletes the dead token without recording it, so nothing here can tell whether the legacy token is
 * that very token; adopting it would march the session back into the 401 it just survived. The
 * secret is different — it is an independent credential — so it is carried over whenever the id
 * entry lacks one.
 */
export function mergeLegacy(
  existing: WeaveEntry | undefined,
  legacy: { secret: string; token: string; participantId?: string },
): WeaveEntry {
  const next: WeaveEntry = { ...(existing ?? {}) };
  next.secret ??= legacy.secret;
  const settled = hasIdentity(existing) || existing?.identity === "invalid";
  if (!settled) { next.token = legacy.token; if (legacy.participantId) next.participantId = legacy.participantId; }
  return next;
}

/** Migrates one known legacy key; `undefined` when there was nothing to migrate. */
export function migrateLegacyOne(storage: KeyValueStorage, weaveId: string, secret: string): WriteResult | undefined {
  const raw = storage.get(legacyKey(secret));
  if (!raw) return undefined;
  let legacy: WeaveEntry;
  try { legacy = JSON.parse(raw) as WeaveEntry; } catch { return undefined; }
  if (!legacy.token) return undefined;
  const merged = mergeLegacy(readWeaveEntry(storage, weaveId), { secret, token: legacy.token, participantId: legacy.participantId });
  // Written even when the merge changed nothing: it is the only way to learn whether the id entry
  // is durable, and the legacy key may not be dropped on anything less than that answer.
  const result = storage.set(weaveKey(weaveId), JSON.stringify(merged));
  if (result === "durable") storage.remove(legacyKey(secret));
  return result;
}

/**
 * Rewrites `loom:<secret>` entries to `loom:weave:<id>`, lazily and without ever losing one.
 *
 * The new entry is written first and the legacy key removed only once that write is confirmed
 * durable: dropping a durable key in favour of a copy that exists only in memory is the whole
 * failure this ordering exists to prevent. A `"memory"` verdict also stops the pass — the store has
 * just proven it will not keep anything, so rewriting the rest would be a storm with no benefit.
 *
 * `onChanged` fires per entry written, because the caller is usually a list on screen and a row that
 * has just resolved should not wait for the slowest lookup in the pass (spec §4.2).
 */
export async function migrateLegacy(
  storage: KeyValueStorage, notice: PersistenceNotice, lookup: (secret: string) => Promise<string>,
  onChanged: () => void = () => {},
): Promise<void> {
  for (const w of storedWeaves(storage)) {
    if (w.kind !== "legacy") continue;
    if (notice.degraded()) return;
    let weaveId: string;
    try { weaveId = await lookup(w.secret); } catch { continue; }   // unreachable: leave it alone
    const result = migrateLegacyOne(storage, weaveId, w.secret);    // merge rule and removal live there
    if (result) { notice.note(result); onChanged(); }               // the entry changed, durable or not
  }
}

/**
 * Which credential to read a Weave with, given what this browser holds for it (spec §2.3/§2.6).
 * The session and My Weaves both call it, so a row is never refreshed with a credential the page
 * itself would not have used. `undefined` means this browser holds nothing for that Weave.
 */
export type ReaderChoice = { reader: LoomClient; withToken: boolean; readOnlyReason?: "secret-fallback" };

export function readerFor(client: LoomClient, entry: WeaveEntry | undefined): ReaderChoice | undefined {
  if (hasIdentity(entry)) return { reader: client.withToken(entry.token), withToken: true };
  if (entry?.secret) return { reader: client.withToken(entry.secret), withToken: false, readOnlyReason: "secret-fallback" };
  return undefined;
}

/** A 401/403 on a read: this credential is provably unusable, unlike a network failure. */
export function isCredentialFailure(e: unknown): boolean {
  return e instanceof LoomClientError && (e.code === "invalid_token" || e.code === "forbidden");
}
