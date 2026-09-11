import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string { return randomUUID(); }

/**
 * 32 random bytes, base64url without padding (43 chars). Used for weave secrets and tokens.
 * Regenerates until the first character is not "-" so a secret can never be mistaken for a
 * CLI option by argument parsers (expected iterations ~1.016).
 */
export function newSecret(): string {
  let s: string;
  do {
    s = randomBytes(32).toString("base64url");
  } while (s.startsWith("-"));
  return s;
}

/** A well-formed keeper token: 32 random bytes as base64url, i.e. 43 unpadded chars. */
export const KEEPER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 hex uuid. Guards ids before they reach a uuid column (postgres 22P02). */
export function isUuid(s: string): boolean { return typeof s === "string" && UUID_RE.test(s); }
