import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../db/index.js";
import { participants, requestOffers, requests, threads } from "../db/schema.js";
import { isLive, type Profile } from "./matching.js";

/*
 * Listener status, current work and cadence (spec 2026-09-27 §4), computed at read time from
 * `last_seen_at`, `seen_history` and the acceptances: never stored and never an event, so a status is
 * true as of the `now` of the read that computed it. The status rule is written twice: here in
 * TypeScript (`listenerStatus`, what a row carries) and in SQL (`statusSql`, what the directory's
 * status filter and counts read). `status.test.ts` asserts the two agree across every boundary.
 */

export type ListenerStatus = "working" | "idle" | "offline";
/** Q2: the interval assumed for a listener that declares none. Offline after twice this. */
export const DEFAULT_POLL_INTERVAL_MS = 900_000;
/** The directory's three per-status counts: always all three words, zeros included. */
export type StatusCounts = { working: number; idle: number; offline: number };

export type CurrentWork = {
  requestId: string;
  /** The request's title: the name of its Lobby Thread. */
  title: string;
  /** The request's Thread in the Lobby. */
  threadId: string;
  /** How many other active work items the listener holds. */
  more: number;
};

export type Cadence = {
  /** The median gap between consecutive stored check-ins, in ms; null with fewer than two. */
  typicalGapMs: number | null;
  /** The longest of those gaps, in ms; null with fewer than two. */
  longestGapMs: number | null;
  /** How many check-ins are stored: 0 to 20. */
  samples: number;
};

/** One active work item (§4.2 step 2): what `workFor` reads, ordered as `currentWork` picks. */
export type WorkItem = { requestId: string; threadId: string; title: string; dueAt: Date | null; createdAt: Date };

/** The three fields a directory row and a `find_agents` result carry beside the profile. */
export type ListenerFacts = { status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence };

/** The declared interval when it is a number, the default otherwise (no profile, no key, or not a number). */
const intervalOf = (profile: Profile | null): number =>
  profile !== null && typeof profile.pollIntervalMs === "number" ? profile.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;

/**
 * Online by §4.2 step 1: seen within twice the declared `pollIntervalMs`, the 15 minute default when
 * none is declared (so exactly twice is still online); never seen is not online. The status rule's
 * first step, shared with the offline-removal rule (spec 2026-09-30 §3.2 condition 3).
 */
export function isOnline(profile: Profile | null, lastSeenAt: Date | null, now: Date): boolean {
  return isLive({ pollIntervalMs: intervalOf(profile) }, { lastSeenAt, now });
}

/** §4.2, in TypeScript: offline unless `isOnline`, and offline wins over working. */
export function listenerStatus(profile: Profile | null, lastSeenAt: Date | null, holdsWork: boolean, now: Date): ListenerStatus {
  if (!isOnline(profile, lastSeenAt, now)) return "offline";
  return holdsWork ? "working" : "idle";
}

/** `intervalOf` in SQL: a JSON number, which is the TypeScript `typeof === "number"` test, or the default. */
const intervalSql = sql`(CASE WHEN jsonb_typeof(${participants.capabilities}->'pollIntervalMs') = 'number'
  THEN (${participants.capabilities}->>'pollIntervalMs')::numeric ELSE ${sql.raw(String(DEFAULT_POLL_INTERVAL_MS))} END)`;

/** §4.2 step 2 in SQL: the participant on the row holds at least one active work item. */
const holdsWorkSql = sql`EXISTS (SELECT 1 FROM ${requestOffers}
  INNER JOIN ${requests} ON ${requests.id} = ${requestOffers.requestId}
  WHERE ${requestOffers.participantId} = ${participants.id} AND ${requestOffers.accepted}
    AND ${requestOffers.removedAt} IS NULL AND ${requestOffers.completedAt} IS NULL
    AND ${requests.status} = 'working')`;

/**
 * `!isOnline` in SQL, over one `participants` row: never seen, or seen more than twice the interval
 * before `now`. `now` is the same `Date` the TypeScript side of the read uses, as a bind parameter,
 * never Postgres's `now()`. The elapsed time is compared in exact milliseconds, on the millisecond
 * value a JavaScript `Date` holds (`date_trunc`), so the boundary is the one `isLive` draws. The
 * status rule's offline arm, and the offline-removal candidate query's condition 3 (spec 2026-09-30
 * §3.2; external review round 1, S3).
 */
export function offlineSql(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`(${participants.lastSeenAt} IS NULL
    OR EXTRACT(EPOCH FROM (${at} - date_trunc('milliseconds', ${participants.lastSeenAt}))) * 1000 > 2 * ${intervalSql})`;
}

/** §4.2, in SQL: a CASE over one `participants` row yielding `'offline'`, `'working'` or `'idle'`. */
export function statusSql(now: Date): SQL {
  return sql`(CASE
    WHEN ${offlineSql(now)} THEN 'offline'
    WHEN ${holdsWorkSql} THEN 'working'
    ELSE 'idle' END)`;
}

/**
 * §4.3: every active work item of each participant, in one query, ordered `due_at ASC NULLS LAST`,
 * then the request's `created_at`, then its id. Only participants holding at least one appear.
 */
export async function workFor(db: Queryable, participantIds: string[]): Promise<Map<string, WorkItem[]>> {
  const out = new Map<string, WorkItem[]>();
  if (participantIds.length === 0) return out;
  const rows = await db.select({
    participantId: requestOffers.participantId, requestId: requests.id, threadId: requests.threadId,
    title: threads.name, dueAt: requestOffers.dueAt, createdAt: requests.createdAt,
  }).from(requestOffers)
    .innerJoin(requests, eq(requests.id, requestOffers.requestId))
    .innerJoin(threads, eq(threads.id, requests.threadId))
    // One array bind parameter, not one per id: `findAgents` passes every matching listener, and a
    // parameter per id fails past the protocol's 65,535 (whole-branch review F4).
    .where(and(sql`${requestOffers.participantId} = ANY(${sql.param(participantIds)}::uuid[])`,
      eq(requestOffers.accepted, true),
      isNull(requestOffers.removedAt), isNull(requestOffers.completedAt), eq(requests.status, "working")))
    .orderBy(sql`${requestOffers.dueAt} ASC NULLS LAST`, asc(requests.createdAt), asc(requests.id));
  for (const { participantId, ...item } of rows) {
    const list = out.get(participantId);
    if (list) list.push(item); else out.set(participantId, [item]);
  }
  return out;
}

/**
 * The first of a participant's ordered items, and how many others. Computed from the items alone,
 * never from the status: an offline listener still shows its work (Q3). Names the request and its
 * Lobby Thread only, never the target Weave's Thread, name or title (§4.3, security).
 */
export function currentWorkOf(items: WorkItem[] | undefined): CurrentWork | null {
  const first = items?.[0];
  return first ? { requestId: first.requestId, title: first.title, threadId: first.threadId, more: items!.length - 1 } : null;
}

/**
 * §4.4. The gaps are only those **between** stored check-ins, in stored order: the time since the
 * last one is not a gap. The median of an even count is the mean of the two middle gaps, rounded
 * down to a whole millisecond. `samples` counts check-ins, not gaps.
 */
export function cadenceOf(history: Date[] | null): Cadence {
  const h = history ?? [];
  if (h.length < 2) return { typicalGapMs: null, longestGapMs: null, samples: h.length };
  const gaps = h.slice(1).map((d, i) => d.getTime() - h[i]!.getTime()).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const typicalGapMs = gaps.length % 2 === 1 ? gaps[mid]! : Math.floor((gaps[mid - 1]! + gaps[mid]!) / 2);
  return { typicalGapMs, longestGapMs: gaps.at(-1)!, samples: h.length };
}

/** The three fields of one participant row, with its work items from `workFor`, at `now`. */
export function listenerFacts(
  row: { capabilities: unknown; lastSeenAt: Date | null; seenHistory: Date[] | null },
  items: WorkItem[] | undefined, now: Date,
): ListenerFacts {
  return {
    status: listenerStatus((row.capabilities as Profile | null) ?? null, row.lastSeenAt, (items?.length ?? 0) > 0, now),
    currentWork: currentWorkOf(items),
    cadence: cadenceOf(row.seenHistory),
  };
}
