import { describe, it, expect } from "vitest";
import type { LoomEvent, LoomRequest, Offer, RequestStatus } from "@loom/client";
import { acceptedIds, applyEvent, applySnapshot, displayStatus, type Requests } from "../src/requests-state.js";

const EXPIRES = "2026-09-16T14:00:00.000Z";
const BEFORE = Date.parse("2026-09-16T13:30:00.000Z");
const AFTER = Date.parse("2026-09-16T14:00:01.000Z");

function req(over: Partial<LoomRequest> = {}): LoomRequest {
  return {
    id: "r1", threadId: "th1", requesterId: "p1", owner: "paw",
    requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }] }, wanted: 2,
    targetWeaveId: "w2", targetWeaveTitle: "Loom session", targetThreadId: "t2", url: null,
    status: "open", expiresAt: EXPIRES, closedAt: null, lastEventSeq: 5,
    createdAt: "2026-09-16T13:00:00.000Z", eligible: ["p2", "p3"], offers: [], ...over,
  };
}
function offer(participantId: string, over: Partial<Offer> = {}): Offer {
  return { requestId: "r1", participantId, model: "gpt-5.6-sol", effort: "high", note: null,
    accepted: false, createdAt: "2026-09-16T13:10:00.000Z", ...over };
}
function ev(seq: number, type: LoomEvent["type"], payload: Record<string, unknown>): LoomEvent {
  return { weaveId: "lobby", seq, threadId: "th1", type, actor: "p1", at: "2026-09-16T13:20:00.000Z", payload };
}
const two = () => applySnapshot({}, req({ lastEventSeq: 5, offers: [offer("p2"), offer("p3")] }));
const accept = (r: Requests, seq: number, ids: string[]) =>
  applyEvent(r, ev(seq, "request.accepted", { requestId: "r1", requesterId: "p1", participantIds: ids, targetWeaveTitle: "Loom session" }));

describe("requests-state", () => {
  it("takes a first snapshot's own lastEventSeq as the version it holds", () => {
    const r = applySnapshot({}, req({ lastEventSeq: 7 }));
    expect(r.r1!.version).toBe(7);
  });

  it("applies a snapshot at or past the version and moves the version up", () => {
    const r = applySnapshot(two(), req({ lastEventSeq: 9, offers: [offer("p2"), offer("p3"), offer("p4")] }));
    expect(r.r1!.offers.map((o) => o.participantId)).toEqual(["p2", "p3", "p4"]);
    expect(r.r1!.version).toBe(9);
  });

  it("a stale snapshot between two acceptances does not reduce the accepted set", () => {
    // The refresh was in flight when the first acceptance landed, so it answers from before it.
    let r = accept(two(), 10, ["p2"]);
    r = applySnapshot(r, req({ lastEventSeq: 5, offers: [offer("p2"), offer("p3")] }));
    expect(acceptedIds(r.r1!)).toEqual(["p2"]);
    expect(r.r1!.version).toBe(10);
    r = accept(r, 12, ["p3"]);
    expect(acceptedIds(r.r1!)).toEqual(["p2", "p3"]);
    expect(r.r1!.version).toBe(12);
  });

  it("ignores a replayed request event at or below the version", () => {
    const r = applyEvent(applySnapshot({}, req({ lastEventSeq: 10 })),
      ev(10, "request.offered", { requestId: "r1", participantId: "p2", model: "gpt-5.6-sol", effort: "high", note: "ready", to: "p1" }));
    expect(r.r1!.offers).toEqual([]);
    expect(r.r1!.version).toBe(10);
  });

  it("applies an event past the version and moves the version up", () => {
    const r = applyEvent(applySnapshot({}, req({ lastEventSeq: 5 })),
      ev(8, "request.offered", { requestId: "r1", participantId: "p2", model: "gpt-5.6-sol", effort: "high", note: "ready", to: "p1" }));
    expect(r.r1!.offers.map((o) => [o.participantId, o.note])).toEqual([["p2", "ready"]]);
    expect(r.r1!.version).toBe(8);
  });

  it("ignores an event for a request it has never seen, so the panel waits for the refresh", () => {
    expect(applyEvent({}, ev(8, "request.offered", { requestId: "r9", participantId: "p2", to: "p1" }))).toEqual({});
  });

  for (const reason of ["filled", "expired", "cancelled"] as const) {
    it(`no snapshot can reopen a ${reason} request or reduce its accepted set`, () => {
      const closed = applyEvent(accept(two(), 10, ["p2"]),
        ev(20, "request.closed", { requestId: "r1", requesterId: "p1", to: ["p1"], reason, accepted: ["p2"] }));
      expect(closed.r1!.status).toBe(reason);
      const r = applySnapshot(closed, req({ lastEventSeq: 25, status: "open", closedAt: null, offers: [offer("p2"), offer("p3")] }));
      expect(r.r1!.status).toBe(reason);
      expect(acceptedIds(r.r1!)).toEqual(["p2"]);
    });
  }

  it("no replayed event can reopen a closed request", () => {
    const closed = applyEvent(two(), ev(20, "request.closed", { requestId: "r1", requesterId: "p1", to: ["p1"], reason: "cancelled", accepted: [] }));
    const r = applyEvent(closed, ev(25, "request.offered", { requestId: "r1", participantId: "p4", model: "m", effort: "high", note: null, to: "p1" }));
    expect(r.r1!.status).toBe("cancelled");
  });

  it("reads an open request past its deadline as expired from the clock, without moving the version", () => {
    const r = two();
    expect(displayStatus(r.r1!, BEFORE)).toBe("open");
    expect(displayStatus(r.r1!, AFTER)).toBe<RequestStatus>("expired");
    expect(r.r1!.version).toBe(5);
  });

  it("reads a request as expired at the very instant of its deadline, as the countdown does", () => {
    expect(displayStatus(two().r1!, Date.parse(EXPIRES))).toBe("expired");
  });

  it("closes to cancelled when the reason names no state it knows", () => {
    const r = applyEvent(two(), ev(20, "request.closed", { requestId: "r1", requesterId: "p1", to: ["p1"], reason: "whatever", accepted: [] }));
    expect(r.r1!.status).toBe("cancelled");
  });

  it("the sweeper's later closure advances the version like any other mutation", () => {
    const r = applyEvent(two(), ev(20, "request.closed", { requestId: "r1", requesterId: "p1", to: ["p1"], reason: "expired", accepted: [] }));
    expect(r.r1!.version).toBe(20);
    expect(r.r1!.closedAt).toBe("2026-09-16T13:20:00.000Z");
    expect(displayStatus(r.r1!, BEFORE)).toBe("expired");
  });
});
