import { describe, it, expect } from "vitest";
import type { LoomEvent } from "@loom/client";
import { firstNewSeq, mergePositions, newestSeqIn, unreadCounts } from "../src/unread.js";

const ev = (seq: number, threadId: string, type: LoomEvent["type"], actor: string): LoomEvent =>
  ({ weaveId: "w1", seq, threadId, type, actor, at: "2026-09-26T10:00:00.000Z", payload: type === "message" ? { text: `m${seq}` } : {} });

// Thread A has a stored position of 4; Thread B has none, so it reads from joinedSeq 2.
const events = [
  ev(1, "B", "message", "bob"),            // at or before joinedSeq: read
  ev(3, "A", "message", "bob"),            // at or before A's position: read
  ev(5, "A", "message", "bob"),            // unread
  ev(6, "A", "message", "me"),             // my own: never counts
  ev(7, "A", "thread.invited", "bob"),     // a system event: never counts
  ev(8, "B", "message", "bob"),            // unread
  ev(9, "B", "participant.joined", "bob"), // a system event
  ev(10, "B", "message", "keeper:k1"),     // a keeper is someone else too: unread
  ev(11, "C", "thread.created", "bob"),    // no message at all
];

describe("unreadCounts (spec 2026-09-26 §4.4)", () => {
  it("counts only others' message events after the position; uses joinedSeq when a Thread has no position; own messages and system events never count", () => {
    expect(unreadCounts(events, "me", { A: 4 }, 2)).toEqual({ A: 1, B: 2 });
    expect(unreadCounts(events, "me", { A: 11, B: 11, C: 11 }, 2)).toEqual({});
  });
});

describe("the other pure read helpers", () => {
  it("firstNewSeq is the first message by someone else after the position, or null", () => {
    expect(firstNewSeq(events, "A", 4, "me")).toBe(5);
    expect(firstNewSeq(events, "A", 5, "me")).toBeNull();
    expect(firstNewSeq(events, "B", 2, "me")).toBe(8);
  });
  it("newestSeqIn is a Thread's highest loaded seq, or 0", () => {
    expect([newestSeqIn(events, "A"), newestSeqIn(events, "Z")]).toEqual([7, 0]);
  });
  it("mergePositions keeps the greater position, Thread by Thread", () => {
    expect(mergePositions({ A: 4, B: 9 }, { A: 6, B: 3, C: 1 })).toEqual({ A: 6, B: 9, C: 1 });
  });
});
