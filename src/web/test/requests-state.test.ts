import { describe, it, expect } from "vitest";
import type { LoomEvent, LoomRequest, Offer, RequestStatus } from "@loom/client";
import { acceptedIds, applyEvent, applySnapshot, changesWork, displayStatus, isRequestEvent, type Requests } from "../src/requests-state.js";

const EXPIRES = "2026-09-16T14:00:00.000Z";
const BEFORE = Date.parse("2026-09-16T13:30:00.000Z");
const AFTER = Date.parse("2026-09-16T14:00:01.000Z");

function req(over: Partial<LoomRequest> = {}): LoomRequest {
  return {
    id: "r1", threadId: "th1", requesterId: "p1", owner: "paw",
    requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }] }, wanted: 2,
    targetWeaveId: "w2", targetWeaveTitle: "Loom session", targetThreadId: "t2", url: null,
    status: "open", expiresAt: EXPIRES, closedAt: null, lastEventSeq: 5,
    createdAt: "2026-09-16T13:00:00.000Z", eligible: ["p2", "p3"], offers: [], acceptances: [], ...over,
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

describe("deadlines, completion and removal", () => {
  it("working is not closed and completed is terminal", () => {
    const working = applySnapshot({}, req({ status: "working", lastEventSeq: 5 }));
    expect(displayStatus(working.r1!, AFTER)).toBe("working");       // past expiresAt, and still not expired
    const offered = applyEvent(working, ev(6, "request.offered", { requestId: "r1", participantId: "p2" }));
    expect(offered.r1!.offers.map((o) => o.participantId)).toEqual(["p2"]);
    const completed = applySnapshot(offered, req({ status: "completed", lastEventSeq: 9, closedAt: EXPIRES }));
    expect(displayStatus(completed.r1!, BEFORE)).toBe("completed");
  });

  it("a completed snapshot cannot be reopened by an older working one", () => {
    const completed = applySnapshot({}, req({ status: "completed", lastEventSeq: 9, closedAt: EXPIRES }));
    expect(applySnapshot(completed, req({ status: "working", lastEventSeq: 7 })).r1!.status).toBe("completed");
    expect(applySnapshot(completed, req({ status: "working", lastEventSeq: 9 })).r1!.status).toBe("completed");
  });

  it("applyEvent handles request.completed and request.overdue and advances the version", () => {
    let r = accept(two(), 6, ["p2"]);
    expect(r.r1!.status).toBe("working");
    r = applyEvent(r, ev(7, "request.overdue", { requestId: "r1", participantId: "p2", dueAt: EXPIRES, lastSeenAt: null, to: "p1" }));
    expect(r.r1!.version).toBe(7);
    expect(r.r1!.acceptances.find((a) => a.participantId === "p2")).toMatchObject({ overdue: true, overdueNotifiedAt: expect.any(String) });
    r = applyEvent(r, ev(8, "request.completed", { requestId: "r1", participantId: "p2", note: "done", to: "p1" }));
    expect(r.r1!.version).toBe(8);
    expect(r.r1!.acceptances.find((a) => a.participantId === "p2")).toMatchObject({ completedAt: expect.any(String), note: "done", overdue: false });
  });

  it("applyEvent marks the acceptance removed on a thread.removed that carries a requestId, and advances the version", () => {
    let r = accept(two(), 6, ["p2"]);
    r = applyEvent(r, ev(9, "thread.removed", { threadId: "th1", participantId: "p2", removedBy: "p1", requestId: "r1" }));
    expect(r.r1!.version).toBe(9);
    expect(r.r1!.acceptances.find((a) => a.participantId === "p2")).toMatchObject({ removed: true, removedAt: expect.any(String) });
    // Without a requestId it is a Thread's own event and no request's business.
    expect(applyEvent(r, ev(10, "thread.removed", { threadId: "t9", participantId: "p3", removedBy: "p1" }))).toBe(r);
  });

  it("a request snapshot fetched before a removal cannot overwrite the applied removal", () => {
    let r = accept(two(), 6, ["p2"]);
    r = applyEvent(r, ev(9, "thread.removed", { threadId: "th1", participantId: "p2", removedBy: "p1", requestId: "r1" }));
    const stale = req({
      status: "working", lastEventSeq: 6, offers: [offer("p2", { accepted: true }), offer("p3")],
      acceptances: [{ participantId: "p2", dueAt: EXPIRES, completedAt: null, note: null, removed: false, removedAt: null, overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "idle" }],
    });
    expect(applySnapshot(r, stale).r1!.acceptances.find((a) => a.participantId === "p2")!.removed).toBe(true);
  });

  it("an acceptance folded from a request.accepted event has no listener status until a request read supplies one; a known one is kept", () => {
    expect(accept(two(), 6, ["p2"]).r1!.acceptances.map((a) => [a.participantId, a.listenerStatus])).toEqual([["p2", undefined]]);
    // Accepted before, removed, and read as offline: a re-accept keeps what the last read said.
    const known = applySnapshot({}, req({ lastEventSeq: 5, offers: [offer("p2", { accepted: true })], acceptances: [{
      participantId: "p2", dueAt: EXPIRES, completedAt: null, note: null, removed: true, removedAt: EXPIRES,
      overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "offline" }] }));
    expect(accept(known, 6, ["p2"]).r1!.acceptances.map((a) => [a.participantId, a.removed, a.listenerStatus])).toEqual([["p2", false, "offline"]]);
  });

  // The read the session makes after a request event (spec 2026-09-27 §6.6): its acceptances replace
  // the held ones, so the server's status lands on an acceptance the event folded in without one.
  it("a request read after the event fills in the status of an acceptance folded from it", () => {
    const folded = accept(two(), 6, ["p2"]);
    const read = applySnapshot(folded, req({
      status: "working", lastEventSeq: 6, offers: [offer("p2", { accepted: true }), offer("p3")],
      acceptances: [{ participantId: "p2", dueAt: null, completedAt: null, note: null, removed: false, removedAt: null, overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "idle" }],
    }));
    expect(read.r1!.acceptances.map((a) => [a.participantId, a.listenerStatus])).toEqual([["p2", "idle"]]);
  });

  it("a request read replaces a held acceptance's status with the server's newer one", () => {
    const held = applySnapshot({}, req({ status: "working", lastEventSeq: 5, offers: [offer("p2", { accepted: true })], acceptances: [{
      participantId: "p2", dueAt: EXPIRES, completedAt: null, note: null, removed: false, removedAt: null,
      overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "working" }] }));
    const read = applySnapshot(held, req({ status: "working", lastEventSeq: 5, offers: [offer("p2", { accepted: true })], acceptances: [{
      participantId: "p2", dueAt: EXPIRES, completedAt: null, note: null, removed: false, removedAt: null,
      overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "offline" }] }));
    expect(read.r1!.acceptances.map((a) => a.listenerStatus)).toEqual(["offline"]);
  });
});

describe("request.offer_withdrawn (spec 2026-09-30 §9.1)", () => {
  const withdrawn = (seq: number, participantId: string) =>
    ev(seq, "request.offer_withdrawn", { requestId: "r1", participantId, reason: "offline", to: "p1" });

  it("applyEvent removes that unaccepted offer and steps the version", () => {
    const r = applyEvent(two(), withdrawn(6, "p2"));
    expect([r.r1!.offers.map((o) => o.participantId), r.r1!.version]).toEqual([["p3"], 6]);
  });

  it("an older replay changes nothing", () => {
    const held = two();
    expect(applyEvent(held, withdrawn(5, "p2"))).toBe(held);
  });

  it("a held offer marked accepted is kept", () => {
    const r = applyEvent(accept(two(), 6, ["p2"]), withdrawn(7, "p2"));
    expect([r.r1!.offers.find((o) => o.participantId === "p2")?.accepted, r.r1!.version]).toEqual([true, 7]);
  });

  it("it is a request event and not a work event", () => {
    expect([isRequestEvent(withdrawn(6, "p2")), changesWork(withdrawn(6, "p2"))]).toEqual([true, false]);
  });
});
