import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string { return randomUUID(); }

/** 32 random bytes, base64url without padding (43 chars). Used for weave secrets and tokens. */
export function newSecret(): string { return randomBytes(32).toString("base64url"); }
