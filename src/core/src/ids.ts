import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string { return randomUUID(); }

/** 32 random bytes, base64url without padding (43 chars). Used for weave secrets and tokens. */
export function newSecret(): string { return randomBytes(32).toString("base64url"); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 hex uuid. Guards ids before they reach a uuid column (postgres 22P02). */
export function isUuid(s: string): boolean { return typeof s === "string" && UUID_RE.test(s); }
