import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { Db, Queryable, Tx } from "../db/index.js";
import { events, keepers, participants, requestOffers, requests, threads, weaves } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { errors } from "../errors.js";
import { isUuid, newId } from "../ids.js";
import { withWeaveLock, withWeaveLocks, type NewEvent } from "../events.js";
import { actorId, assertCanRead, assertIsKeeperOf, assertParticipantOf, assertStillKeeperOf } from "../actors.js";
import { getThread, validateThreadUrl } from "../threads.js";
import { validatePage } from "../paging.js";
import { getLobby } from "./lobby.js";
import { invitationRowAndEvent } from "./invitations.js";
import { eligible as isEligible, validateRequirements, type Profile, type Requirements } from "./matching.js";
import type { Actor } from "../types.js";

/** How many helpers one request may ask for. */
const MIN_WANTED = 1, MAX_WANTED = 20, DEFAULT_WANTED = 1;
/** A minute to a day; an hour when the requester names none. */
const MIN_TIMEOUT_MS = 60_000, MAX_TIMEOUT_MS = 86_400_000, DEFAULT_TIMEOUT_MS = 3_600_000;
/** How many requests one requester may have open at once, so a runaway agent cannot flood the Lobby. */
const MAX_OPEN_REQUESTS = 5;
const MAX_NOTE = 1000;
/** Page size when the caller names none. The maximum it may name is core's MAX_PAGE_LIMIT. */
const DEFAULT_REQUESTS_PAGE = 100;

export type RequestStatus = "open" | "filled" | "expired" | "cancelled";
/** Why a request closed. The reason and the stored status are the same word. */
export type CloseReason = Exclude<RequestStatus, "open">;

export type PublicOffer = {
  requestId: string; participantId: string; model: string | null; effort: string | null;
  note: string | null; accepted: boolean; createdAt: string;
};

export type PublicRequest = {
  id: string; threadId: string; requesterId: string; owner: string; requirements: Requirements;
  wanted: number; targetWeaveId: string; targetWeaveTitle: string; targetThreadId: string;
  url: string | null; status: RequestStatus; expiresAt: string; closedAt: string | null;
  lastEventSeq: number; createdAt: string;
  /** The listeners the request was addressed to, snapshotted when it opened. */
  eligible?: string[];
  offers: PublicOffer[];
};

export type OpenRequestInput = {
  title: string; requirements: unknown; wanted?: number; timeoutMs?: number;
  targetWeaveId: string; targetThreadId: string; url?: string | null;
};

export type AcceptOptions = {
  /**
   * Test seam: runs after the request row is read and **before either Weave row is locked**, so a
   * test can drive an ordinary `setRole` / `archiveWeave` / `closeThread` — each of which takes the
   * target lock itself — and have it commit before `accept` gets there. Nothing runs between
   * acquiring the locks and the authority check below.
   */
  beforeLock?: () => Promise<void>;
  /** Test seam: runs inside the transaction, after the offers are marked and the invitations inserted. */
  afterMutation?: () => Promise<void>;
};

type RequestRow = typeof requests.$inferSelect;
type OfferRow = typeof requestOffers.$inferSelect;

function toPublicOffer(o: OfferRow): PublicOffer {
  return { requestId: o.requestId, participantId: o.participantId, model: o.model ?? null,
    effort: o.effort ?? null, note: o.note ?? null, accepted: o.accepted, createdAt: o.createdAt.toISOString() };
}

/**
 * The status a reader sees. A row still marked `open` past its deadline reads `expired`, so no
 * client ever acts on a stale `open` while the sweeper is between passes.
 */
export function computedStatus(row: { status: string; expiresAt: Date }, now: Date): RequestStatus {
  if (row.status === "open" && now.getTime() >= row.expiresAt.getTime()) return "expired";
  return row.status as RequestStatus;
}

/**
 * The seq `appendInTx` will give the last **request** event in `news`: it assigns
 * `weave.lastSeq + 1 ..` in order, in the same transaction as the row write beside it. Reading it
 * ahead lets the request row carry its own version without a second write after the append.
 */
function versionOf(weave: { lastSeq: number }, news: NewEvent[]): number {
  const idx = news.reduce((last, e, i) => (e.type.startsWith("request.") ? i : last), -1);
  return weave.lastSeq + idx + 1;
}

async function requestRow(db: Queryable, requestId: string): Promise<RequestRow> {
  if (!isUuid(requestId)) throw errors.validation("No such request");
  const [r] = await db.select().from(requests).where(eq(requests.id, requestId));
  if (!r) throw errors.validation("No such request");
  return r;
}

/**
 * The eligibility snapshot lives in the `request.opened` payload rather than in a column: it is
 * decided once, at open time, and never recomputed, so the log is its own record of who was asked.
 */
async function eligibleByThread(db: Queryable, lobbyId: string, threadIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (threadIds.length === 0) return out;
  const rows = await db.select({ threadId: events.threadId, payload: events.payload }).from(events)
    .where(and(eq(events.weaveId, lobbyId), eq(events.type, "request.opened"), inArray(events.threadId, threadIds)));
  for (const r of rows) out.set(r.threadId, ((r.payload as { eligible?: string[] }).eligible ?? []));
  return out;
}

async function hydrate(db: Queryable, lobbyId: string, rows: RequestRow[], now: Date): Promise<PublicRequest[]> {
  if (rows.length === 0) return [];
  const titles = new Map((await db.select({ id: weaves.id, title: weaves.title }).from(weaves)
    .where(inArray(weaves.id, rows.map((r) => r.targetWeaveId)))).map((w) => [w.id, w.title]));
  // Indexed by request once rather than re-scanned per row: a page of requests each carrying a
  // handful of offers turned the join into rows × offers comparisons.
  const offersByRequest = new Map<string, PublicOffer[]>();
  for (const o of await db.select().from(requestOffers)
    .where(inArray(requestOffers.requestId, rows.map((r) => r.id))).orderBy(asc(requestOffers.createdAt))) {
    const list = offersByRequest.get(o.requestId);
    if (list) list.push(toPublicOffer(o)); else offersByRequest.set(o.requestId, [toPublicOffer(o)]);
  }
  const eligible = await eligibleByThread(db, lobbyId, rows.map((r) => r.threadId));
  return rows.map((r) => ({
    id: r.id, threadId: r.threadId, requesterId: r.requesterId, owner: r.owner,
    requirements: r.requirements as Requirements, wanted: r.wanted,
    targetWeaveId: r.targetWeaveId, targetWeaveTitle: titles.get(r.targetWeaveId) ?? "",
    targetThreadId: r.targetThreadId, url: r.url ?? null, status: computedStatus(r, now),
    expiresAt: r.expiresAt.toISOString(), closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    lastEventSeq: r.lastEventSeq, createdAt: r.createdAt.toISOString(),
    eligible: eligible.get(r.threadId) ?? [],
    offers: offersByRequest.get(r.id) ?? [],
  }));
}

const onePublic = async (db: Queryable, lobbyId: string, row: RequestRow, now: Date): Promise<PublicRequest> =>
  (await hydrate(db, lobbyId, [row], now))[0]!;

/**
 * The target credential must be a credential **for the target Weave**: a keeper participant there,
 * or an instance keeper. One scoped to another Weave — the caller's own Lobby token, say — is not a
 * target credential at all and gets the same answer a missing one gets (`invalid_token`), while a
 * genuine target credential that is merely a member is refused as `forbidden`.
 */
function assertTargetAuthority(targetActor: Actor, targetWeaveId: string): void {
  if (targetActor.kind === "keeper") return;
  const scoped = targetActor.kind === "participant" ? targetActor.participant.weaveId
    : targetActor.kind === "secret" ? targetActor.weaveId : null;
  if (scoped !== targetWeaveId) throw errors.invalidToken();
  assertIsKeeperOf(targetActor, targetWeaveId);
}

/** The requester, or a Lobby keeper acting on its behalf (spec 2). */
function assertRequesterOrLobbyKeeper(actor: Actor, lobbyId: string, requesterId: string): boolean {
  const isRequester = actor.kind === "participant" && actor.participant.weaveId === lobbyId
    && actor.participant.id === requesterId;
  if (!isRequester) assertIsKeeperOf(actor, lobbyId);
  return isRequester;
}

/**
 * Closes a request and its Thread inside an open transaction, and returns the two events that say
 * so. `to` addresses the requester — the sweeper or a cancelling keeper may have caused this — and
 * every offerer whose offer was not accepted, so it stops waiting; accepted ones already have their
 * `request.accepted` and `weave.invited`, and eligible listeners who never offered are not told.
 */
async function closeInTx(tx: Tx, row: RequestRow, reason: CloseReason, actor: string, now: Date): Promise<NewEvent[]> {
  const offers = await tx.select().from(requestOffers)
    .where(eq(requestOffers.requestId, row.id)).orderBy(asc(requestOffers.createdAt));
  const accepted = offers.filter((o) => o.accepted).map((o) => o.participantId);
  const to = [row.requesterId, ...offers.filter((o) => !o.accepted).map((o) => o.participantId)];
  await tx.update(requests).set({ status: reason, closedAt: now }).where(eq(requests.id, row.id));
  await tx.update(threads).set({ closedAt: now }).where(eq(threads.id, row.threadId));
  return [
    { threadId: row.threadId, type: "request.closed", actor,
      payload: { requestId: row.id, requesterId: row.requesterId, to, reason, accepted } },
    // Carries requestId, which is what marks it a request Thread's companion: it wakes nobody.
    { threadId: row.threadId, type: "thread.closed", actor, payload: { threadId: row.threadId, requestId: row.id } },
  ];
}

/**
 * Opens a request: a Thread in the Lobby, a row, and one addressed announcement to the listeners
 * whose profile the requirements and the serving policy admit.
 *
 * Two credentials, because a request spans two Weaves: `actor` is the caller's Lobby identity (who
 * is asking, and for which owner) and `targetActor` its authority in the Weave the helpers will be
 * invited into. The authority is recorded on the row and re-checked from the database at every
 * issuance, so no second credential is ever needed again and no self-declared label is trusted.
 */
export async function openRequest(
  db: Db, bus: EventBus, actor: Actor, targetActor: Actor, input: OpenRequestInput, now = new Date(),
): Promise<PublicRequest> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);

  if (!isUuid(input.targetWeaveId)) throw errors.weaveNotFound();
  // The helpers are pulled *out* of the Lobby into somewhere else. A request pointing back at the
  // Lobby would also be unacceptable in the literal sense: `accept` locks the Lobby row and then the
  // target row, and they would be the same row.
  if (input.targetWeaveId === lobbyId) throw errors.validation("A request cannot target the Lobby");
  assertTargetAuthority(targetActor, input.targetWeaveId);
  const [targetWeave] = await db.select().from(weaves).where(eq(weaves.id, input.targetWeaveId));
  if (!targetWeave) throw errors.weaveNotFound();
  if (targetWeave.archivedAt) throw errors.weaveArchived();
  const targetThread = await getThread(db, input.targetThreadId);
  if (targetThread.weaveId !== input.targetWeaveId) throw errors.threadNotFound();
  if (targetThread.closedAt) throw errors.threadClosed();

  const requirements = validateRequirements(input.requirements);
  const wanted = input.wanted ?? DEFAULT_WANTED;
  if (!Number.isInteger(wanted) || wanted < MIN_WANTED || wanted > MAX_WANTED) {
    throw errors.validation(`wanted must be ${MIN_WANTED}-${MAX_WANTED}`);
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw errors.validation(`timeoutMs must be ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}`);
  }
  const title = (input.title ?? "").trim();
  if (title.length === 0 || title.length > 100) throw errors.validation("Request title must be 1-100 characters");
  const url = validateThreadUrl(input.url);

  const requestId = newId();
  const threadId = newId();
  const expiresAt = new Date(now.getTime() + timeoutMs);
  // `assertTargetAuthority` has already refused every other kind, so this is a keeper participant
  // of the target or an instance keeper — the principal every later issuance is re-checked against.
  const targetLink = targetActor.kind === "keeper"
    ? { requesterTargetParticipantId: null, requesterTargetKeeperId: targetActor.keeperId }
    : { requesterTargetParticipantId: assertParticipantOf(targetActor, input.targetWeaveId).id, requesterTargetKeeperId: null };

  return withWeaveLock(db, bus, lobbyId, async (tx, lobby) => {
    // Counted inside the lock, which serializes every open: a pre-lock count would let five
    // concurrent opens all see four. "Open" is the computed status, not the stored one, so a
    // crossed but unswept request does not count against the cap any more than it shows up in
    // the open list.
    const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(requests)
      .where(and(eq(requests.requesterId, me.id), eq(requests.status, "open"), gt(requests.expiresAt, now)));
    if (open!.n >= MAX_OPEN_REQUESTS) throw errors.validation(`Too many open requests (at most ${MAX_OPEN_REQUESTS})`);
    const ps = await tx.select().from(participants).where(eq(participants.weaveId, lobbyId))
      .orderBy(asc(participants.joinedAt), asc(participants.id));
    const mine = ps.find((p) => p.id === me.id);
    if (!mine) throw errors.forbidden("Join the Lobby to do this");
    // ADR 0001: the owner is the requester's own declaration, read fresh from its profile. A
    // requester without a profile has owner "", whom only `serves: "anyone"` admits.
    const owner = (mine.capabilities as Profile | null)?.owner ?? "";
    const eligible = ps
      .filter((p) => p.id !== me.id && isEligible((p.capabilities as Profile | null) ?? null, requirements, owner))
      .map((p) => p.id);

    await tx.insert(threads).values({ id: threadId, weaveId: lobbyId, name: title, createdBy: me.id, url, requestId });
    const news: NewEvent[] = [
      // Same shape as any other thread.created, plus the requestId that marks it a request's.
      { threadId, type: "thread.created", actor: me.id, payload: { threadId, name: title, url, requestId } },
      { threadId, type: "request.opened", actor: me.id,
        payload: { requestId, requesterId: me.id, requirements, wanted, expiresAt: expiresAt.toISOString(),
          owner, targetWeaveTitle: targetWeave.title, eligible } },
    ];
    const [row] = await tx.insert(requests).values({
      id: requestId, threadId, requesterId: me.id, owner, ...targetLink,
      requirements, wanted, targetWeaveId: input.targetWeaveId, targetThreadId: input.targetThreadId,
      url, expiresAt, lastEventSeq: versionOf(lobby, news),
    }).returning();
    // `eligible` is handed over from the array above rather than read back through `hydrate`: the
    // snapshot lives in the `request.opened` payload, and that event is appended only once this
    // callback returns, so a re-derivation here would find nothing and answer with an empty list.
    return { result: { ...await onePublic(tx, lobbyId, row!, now), eligible }, events: news };
  });
}

/**
 * Says "I can take this". Availability is expressed by offering — matching wakes, never assigns —
 * so a second offer is the same answer, not a second one.
 */
export async function offer(
  db: Db, bus: EventBus, actor: Actor, requestId: string,
  input: { model?: string; effort?: string; note?: string },
): Promise<PublicOffer> {
  const { weaveId: lobbyId } = await getLobby(db);
  const me = assertParticipantOf(actor, lobbyId);
  const row = await requestRow(db, requestId);
  const now = new Date();
  if (computedStatus(row, now) !== "open") throw errors.requestClosed();

  const eligible = (await eligibleByThread(db, lobbyId, [row.threadId])).get(row.threadId) ?? [];
  if (!eligible.includes(me.id)) throw errors.forbidden("This request is not addressed to you");

  const note = input.note?.trim() ? input.note.trim() : null;
  if (note !== null && note.length > MAX_NOTE) throw errors.validation(`note must be at most ${MAX_NOTE} characters`);
  const model = input.model?.trim() ? input.model.trim() : null;
  const effort = input.effort?.trim() ? input.effort.trim() : null;
  if (model !== null || effort !== null) {
    const [mine] = await db.select({ capabilities: participants.capabilities }).from(participants).where(eq(participants.id, me.id));
    const own = ((mine?.capabilities as Profile | null)?.models ?? []);
    const ok = own.some((m) => (model === null || m.model === model) && (effort === null || m.effort === effort));
    if (!ok) throw errors.validation("model and effort must name one of your own profile models");
  }

  return withWeaveLock(db, bus, lobbyId, async (tx, lobby) => {
    const [fresh] = await tx.select().from(requests).where(eq(requests.id, requestId));
    if (computedStatus(fresh!, now) !== "open") throw errors.requestClosed();
    const [existing] = await tx.select().from(requestOffers)
      .where(and(eq(requestOffers.requestId, requestId), eq(requestOffers.participantId, me.id)));
    if (existing) return { result: toPublicOffer(existing), events: [] };
    const [created] = await tx.insert(requestOffers)
      .values({ requestId, participantId: me.id, model, effort, note }).returning();
    const news: NewEvent[] = [{ threadId: row.threadId, type: "request.offered", actor: me.id,
      payload: { requestId, participantId: me.id, model, effort, note, to: row.requesterId } }];
    await tx.update(requests).set({ lastEventSeq: versionOf(lobby, news) }).where(eq(requests.id, requestId));
    return { result: toPublicOffer(created!), events: news };
  });
}

/**
 * Accepts offers and hands each accepted listener a way into the target Weave.
 *
 * One transaction under the Lobby row and then the target row, in that order. The authority used is
 * always the **requester's recorded** one, never the accepting actor's: a Lobby keeper acting on the
 * requester's behalf is not thereby a keeper of the target. It is re-checked here from the database,
 * because the requester may have been demoted, or the target archived or its Thread closed, since
 * the request opened — and then nothing at all is accepted.
 */
export async function accept(
  db: Db, bus: EventBus, actor: Actor, requestId: string, participantIds: string[], opts: AcceptOptions = {},
): Promise<{ request: PublicRequest; invitationIds: string[] }> {
  const { weaveId: lobbyId } = await getLobby(db);
  const row = await requestRow(db, requestId);
  const isRequester = assertRequesterOrLobbyKeeper(actor, lobbyId, row.requesterId);
  if (!Array.isArray(participantIds) || participantIds.length === 0) throw errors.validation("participantIds must name at least one participant");
  if (new Set(participantIds).size !== participantIds.length) throw errors.validation("participantIds must be distinct");
  for (const id of participantIds) if (!isUuid(id)) throw errors.validation("No such participant in this Lobby");
  const now = new Date();
  if (computedStatus(row, now) !== "open") throw errors.requestClosed();

  if (opts.beforeLock) await opts.beforeLock();

  const invitationIds = participantIds.map(() => newId());
  return withWeaveLocks(db, bus, [lobbyId, row.targetWeaveId], async (tx, byId) => {
    const lobby = byId[lobbyId]!;
    const targetWeave = byId[row.targetWeaveId]!;
    if (!isRequester) await assertStillKeeperOf(tx, actor, lobbyId);
    const [fresh] = await tx.select().from(requests).where(eq(requests.id, requestId));
    if (computedStatus(fresh!, now) !== "open") throw errors.requestClosed();

    // The requester's recorded target authority, re-read: a demotion, a removed instance keeper, an
    // archived Weave or a closed Thread each mean nothing is accepted and the requester must ask again.
    if (fresh!.requesterTargetParticipantId) {
      const [p] = await tx.select({ weaveId: participants.weaveId, role: participants.role })
        .from(participants).where(eq(participants.id, fresh!.requesterTargetParticipantId));
      if (!p || p.weaveId !== fresh!.targetWeaveId || p.role !== "keeper") {
        throw errors.forbidden("The requester is no longer a keeper of the target Weave");
      }
    } else if (fresh!.requesterTargetKeeperId) {
      const [k] = await tx.select({ id: keepers.id }).from(keepers).where(eq(keepers.id, fresh!.requesterTargetKeeperId));
      if (!k) throw errors.forbidden("The requester's target authority no longer exists");
    } else {
      throw errors.forbidden("The request records no target authority");
    }
    if (targetWeave.archivedAt) throw errors.weaveArchived();
    const [targetThread] = await tx.select().from(threads).where(eq(threads.id, fresh!.targetThreadId));
    if (!targetThread || targetThread.closedAt) throw errors.threadClosed();

    const offers = await tx.select().from(requestOffers).where(eq(requestOffers.requestId, requestId));
    for (const id of participantIds) {
      const o = offers.find((x) => x.participantId === id);
      if (!o) throw errors.validation("That participant has not offered on this request");
      if (o.accepted) throw errors.validation("That offer has already been accepted");
    }
    const already = offers.filter((o) => o.accepted).length;
    if (already + participantIds.length > fresh!.wanted) throw errors.validation(`This request wants at most ${fresh!.wanted}`);

    await tx.update(requestOffers).set({ accepted: true })
      .where(and(eq(requestOffers.requestId, requestId), inArray(requestOffers.participantId, participantIds)));

    const invitees = await tx.select({ id: participants.id, agentId: participants.agentId })
      .from(participants).where(inArray(participants.id, participantIds));
    const by = actorId(actor);
    const news: NewEvent[] = [{ threadId: fresh!.threadId, type: "request.accepted", actor: by,
      payload: { requestId, requesterId: fresh!.requesterId, participantIds, targetWeaveTitle: targetWeave.title } }];
    for (const [i, id] of participantIds.entries()) {
      const invitee = invitees.find((p) => p.id === id);
      if (!invitee) throw errors.validation("No such participant in this Lobby");
      // Through the shared writer, so an accepted offer's invitation and a direct `inviteToWeave`
      // are the same row and the same event, described in one place.
      news.push(await invitationRowAndEvent(tx, {
        invitationId: invitationIds[i]!, targetWeaveId: fresh!.targetWeaveId, targetThreadId: fresh!.targetThreadId,
        targetWeaveTitle: targetWeave.title, inviteeParticipantId: id, inviteeAgentId: invitee.agentId ?? null,
        requestId, createdBy: by, threadId: fresh!.threadId,
      }));
    }

    if (opts.afterMutation) await opts.afterMutation();

    if (already + participantIds.length === fresh!.wanted) news.push(...await closeInTx(tx, fresh!, "filled", by, now));
    await tx.update(requests).set({ lastEventSeq: versionOf(lobby, news) }).where(eq(requests.id, requestId));
    const [updated] = await tx.select().from(requests).where(eq(requests.id, requestId));
    return {
      result: { request: await onePublic(tx, lobbyId, updated!, now), invitationIds },
      events: { [lobbyId]: news },
    };
  });
}

/** The requester gives up, or a Lobby keeper does it for them. The Lobby row is the only lock needed. */
export async function cancelRequest(db: Db, bus: EventBus, actor: Actor, requestId: string): Promise<PublicRequest> {
  const { weaveId: lobbyId } = await getLobby(db);
  const row = await requestRow(db, requestId);
  const isRequester = assertRequesterOrLobbyKeeper(actor, lobbyId, row.requesterId);
  const now = new Date();
  if (computedStatus(row, now) !== "open") throw errors.requestClosed();
  return withWeaveLock(db, bus, lobbyId, async (tx, lobby) => {
    if (!isRequester) await assertStillKeeperOf(tx, actor, lobbyId);
    const [fresh] = await tx.select().from(requests).where(eq(requests.id, requestId));
    if (computedStatus(fresh!, now) !== "open") throw errors.requestClosed();
    const news = await closeInTx(tx, fresh!, "cancelled", actorId(actor), now);
    await tx.update(requests).set({ lastEventSeq: versionOf(lobby, news) }).where(eq(requests.id, requestId));
    const [updated] = await tx.select().from(requests).where(eq(requests.id, requestId));
    return { result: await onePublic(tx, lobbyId, updated!, now), events: news };
  });
}

export async function getRequest(db: Db, actor: Actor, requestId: string, now = new Date()): Promise<PublicRequest> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  return onePublic(db, lobbyId, await requestRow(db, requestId), now);
}

/**
 * The computed status as a predicate the database can answer. `computedStatus` is the same rule in
 * TypeScript — a row still stored `open` past its deadline reads `expired` — expressed here so the
 * filter costs one indexed scan instead of every request row the Lobby has ever held.
 */
function statusCondition(status: RequestStatus, now: Date) {
  if (status === "open") return and(eq(requests.status, "open"), gt(requests.expiresAt, now));
  if (status === "expired") {
    return or(eq(requests.status, "expired"), and(eq(requests.status, "open"), lte(requests.expiresAt, now)));
  }
  return eq(requests.status, status);          // filled and cancelled are stored exactly as read
}

export async function listRequests(
  db: Db, actor: Actor, opts: { status?: RequestStatus; limit?: number } = {}, now = new Date(),
): Promise<PublicRequest[]> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  if (opts.status !== undefined && !["open", "filled", "expired", "cancelled"].includes(opts.status)) {
    throw errors.validation("status must be open, filled, expired or cancelled");
  }
  validatePage({ limit: opts.limit });
  const rows = await db.select().from(requests)
    .where(opts.status ? statusCondition(opts.status, now) : undefined)
    .orderBy(desc(requests.createdAt)).limit(opts.limit ?? DEFAULT_REQUESTS_PAGE);
  return hydrate(db, lobbyId, rows, now);
}

/**
 * Closes the requests whose deadline has passed, one transaction each, and reports how many. The
 * server calls it on an interval; a test calls it with the `now` it wants. Each row's status is
 * re-read inside the lock, so two sweeps racing close it once.
 */
export async function sweepRequests(db: Db, bus: EventBus, now = new Date()): Promise<number> {
  const { weaveId: lobbyId } = await getLobby(db);
  const due = await db.select({ id: requests.id }).from(requests)
    .where(and(eq(requests.status, "open"), lte(requests.expiresAt, now))).orderBy(asc(requests.createdAt));
  let closed = 0;
  for (const { id } of due) {
    const didClose = await withWeaveLock(db, bus, lobbyId, async (tx, lobby) => {
      const [fresh] = await tx.select().from(requests).where(eq(requests.id, id));
      if (!fresh || fresh.status !== "open") return { result: false, events: [] };
      const news = await closeInTx(tx, fresh, "expired", "system", now);
      await tx.update(requests).set({ lastEventSeq: versionOf(lobby, news) }).where(eq(requests.id, id));
      return { result: true, events: news };
    });
    if (didClose) closed++;
  }
  return closed;
}
