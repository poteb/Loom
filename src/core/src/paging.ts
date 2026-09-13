import { errors } from "./errors.js";

/**
 * The largest page any paged core read will return. One constant, exported, because every adapter
 * that wants to quote the bound in a description or a help string must quote this number — a
 * second copy is how the REST schema and the MCP schema came to disagree.
 */
export const MAX_PAGE_LIMIT = 1000;

/** Forward pagination: `since` is the last seq already processed, `limit` the page size. */
export type PageOptions = { since?: number; limit?: number };

/**
 * Rejects a page the caller cannot have meant. The rule lives here rather than in the adapters:
 * the REST query schema used to carry `.int().min(...)` and the MCP tool schemas carried nothing,
 * so `read_events(limit: 0)` was a 400 over HTTP and a silently clamped one-event page over MCP —
 * the same request answered differently depending on who asked. Clamping is worse than rejecting
 * for a cursor-shaped API: a caller that asks for 5000 and gets 1000 has no way to tell that its
 * page was truncated on purpose, and one that asks for 0 gets an event it never asked for.
 *
 * Adapters may still pre-validate for their own ergonomics (the CLI turns these into usage errors
 * before a request is made); they must not be the only place the check happens.
 */
export function validatePage(opts: PageOptions, maxLimit: number = MAX_PAGE_LIMIT): void {
  if (opts.since !== undefined && (!Number.isInteger(opts.since) || opts.since < 0)) {
    throw errors.validation("since must be an integer >= 0");
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > maxLimit)) {
    throw errors.validation(`limit must be an integer between 1 and ${maxLimit}`);
  }
}
