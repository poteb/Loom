import type { LoomEvent, LoomRequest, Offer, RequestStatus } from "@loom/client";

/**
 * A request plus the **version** the session holds for it: the `lastEventSeq` of the newest mutation
 * this browser has applied (spec 2 and 6). Every snapshot and every event is judged against it, so a
 * refresh that answers from before a mutation — or a replayed event from before one — cannot drag
 * the panel backwards.
 */
export type VersionedRequest = LoomRequest & { version: number };
export type Requests = Record<string, VersionedRequest>;

const REQUEST_EVENTS = ["request.opened", "request.offered", "request.accepted", "request.closed"] as const;

/** The Lobby events that carry a request's own mutations; `weave.invited` is a consequence, not one. */
export function isRequestEvent(e: LoomEvent): boolean {
  return (REQUEST_EVENTS as readonly string[]).includes(e.type);
}

/** Terminal states are one-way: nothing may reopen a request that has closed. */
const isClosed = (status: RequestStatus): boolean => status !== "open";

export const acceptedIds = (r: LoomRequest): string[] => r.offers.filter((o) => o.accepted).map((o) => o.participantId);

/**
 * What the panel shows: an open request whose deadline has passed reads `expired` from the clock,
 * before the sweeper has persisted anything. This is display state and never a version step — the
 * sweeper's later `request.closed` advances the version like any other mutation.
 */
export function displayStatus(r: LoomRequest, nowMs: number): RequestStatus {
  if (isClosed(r.status)) return r.status;
  // The deadline itself is past: core counts a request open only while `expiresAt > now`, and the
  // panel's countdown says "expired" at exactly zero, so all three agree on the same instant.
  return nowMs >= Date.parse(r.expiresAt) ? "expired" : "open";
}

/**
 * The offers of the incoming version, with every acceptance this session already knows of kept: a
 * snapshot may be missing an acceptance it predates, and the accepted set must never shrink.
 */
function mergeOffers(held: Offer[], incoming: Offer[]): Offer[] {
  const out = incoming.map((o) => {
    const before = held.find((h) => h.participantId === o.participantId);
    return before?.accepted ? { ...o, accepted: true } : o;
  });
  for (const h of held) {
    if (h.accepted && !out.some((o) => o.participantId === h.participantId)) out.push(h);
  }
  return out;
}

/**
 * Applies a snapshot — from `listRequests`, `getRequest`, or the one a mutation returns — when its
 * `lastEventSeq` is at least the version held. A terminal state it does not know about is kept, as
 * is every acceptance, so an older-but-admissible answer cannot reopen or un-accept anything.
 */
export function applySnapshot(reqs: Requests, snap: LoomRequest): Requests {
  const held = reqs[snap.id];
  if (!held) return { ...reqs, [snap.id]: { ...snap, version: snap.lastEventSeq } };
  if (snap.lastEventSeq < held.version) return reqs;
  const closedBefore = isClosed(held.status);
  return {
    ...reqs,
    [snap.id]: {
      ...snap,
      status: closedBefore && !isClosed(snap.status) ? held.status : snap.status,
      closedAt: closedBefore ? (held.closedAt ?? snap.closedAt) : snap.closedAt,
      // `eligible` is decided once, when the request opens; a snapshot that omits it keeps it.
      eligible: snap.eligible ?? held.eligible,
      offers: mergeOffers(held.offers, snap.offers),
      version: Math.max(snap.lastEventSeq, held.version),
    },
  };
}

/**
 * Applies a request event when its `seq` is past the version held; an older replay belongs in the
 * log and the thread view, never in the panel. An event for a request this session has never seen
 * changes nothing — the refresh it triggers brings the whole row in.
 */
export function applyEvent(reqs: Requests, e: LoomEvent): Requests {
  if (!isRequestEvent(e)) return reqs;
  const id = String(e.payload.requestId ?? "");
  const held = reqs[id];
  if (!held || e.seq <= held.version) return reqs;
  const next: VersionedRequest = { ...held, version: e.seq };
  switch (e.type) {
    // The event that created the request: nothing to change on a row that already has it.
    case "request.opened": break;
    case "request.offered": {
      if (isClosed(held.status)) break;
      const participantId = String(e.payload.participantId ?? "");
      const made: Offer = { requestId: id, participantId, model: str(e.payload.model), effort: str(e.payload.effort),
        note: str(e.payload.note), accepted: false, createdAt: e.at };
      next.offers = mergeOffers(held.offers, [...held.offers.filter((o) => o.participantId !== participantId), made]);
      break;
    }
    case "request.accepted": {
      const ids = list(e.payload.participantIds);
      next.offers = held.offers.map((o) => (ids.includes(o.participantId) ? { ...o, accepted: true } : o));
      break;
    }
    case "request.closed": {
      // The reason and the stored status are the same word (core), so it is the status this closes
      // to — but only a word that names a terminal state; anything else still closes the row.
      next.status = closedStatus(e.payload.reason);
      next.closedAt = e.at;
      const accepted = list(e.payload.accepted);
      next.offers = held.offers.map((o) => (accepted.includes(o.participantId) ? { ...o, accepted: true } : o));
      break;
    }
  }
  return { ...reqs, [id]: next };
}

const CLOSED_STATUSES: RequestStatus[] = ["filled", "expired", "cancelled"];
const closedStatus = (v: unknown): RequestStatus =>
  CLOSED_STATUSES.find((s) => s === v) ?? "cancelled";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
