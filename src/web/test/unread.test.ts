import { describe, it, expect, afterEach, vi } from "vitest";
import type { LoomEvent } from "@loom/client";
import { createReadThrottle, firstNewSeq, mergePositions, newestSeqIn, READ_FLUSH_MS, unreadCounts } from "../src/unread.js";

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

describe("createReadThrottle (spec 2026-09-26 §6.2)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("while visible, arrivals advance the position with at most one markRead per READ_FLUSH_MS, and leaving the Thread flushes the pending position", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.advance("T", 5);                          // nothing sent lately: at once
    expect(sent).toEqual([["T", 5]]);
    t.advance("T", 6);
    t.advance("T", 7);
    vi.advanceTimersByTime(READ_FLUSH_MS - 1);
    expect(sent).toEqual([["T", 5]]);
    vi.advanceTimersByTime(1);                  // the interval ends: the latest position, once
    expect(sent).toEqual([["T", 5], ["T", 7]]);
    t.advance("T", 8);                          // held again
    expect(sent).toHaveLength(2);
    t.flush();                                  // the Thread is left
    expect(sent).toEqual([["T", 5], ["T", 7], ["T", 8]]);
    vi.advanceTimersByTime(READ_FLUSH_MS * 3);
    expect(sent).toHaveLength(3);
  });

  it("holds a failed position for the next send without arming anything, and reset drops what it holds", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.retry("T", 5);
    vi.advanceTimersByTime(READ_FLUSH_MS * 2);
    expect(sent).toEqual([]);
    t.flush();
    expect(sent).toEqual([["T", 5]]);
    vi.advanceTimersByTime(READ_FLUSH_MS);      // a full interval since that send
    t.advance("T", 6);                          // at once
    t.advance("T", 7);                          // held
    t.reset();
    vi.advanceTimersByTime(READ_FLUSH_MS * 2);
    t.flush();
    expect(sent).toEqual([["T", 5], ["T", 6]]);
  });

  it("sends nothing on its timer while the tab is hidden; a flush still sends, and the next visible send carries what it held", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    let visible = true;
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); }, READ_FLUSH_MS, () => Date.now(), () => visible);
    t.advance("T", 5);                          // at once
    t.advance("T", 6);                          // held, the timer armed
    visible = false;
    t.flush();                                  // the tab hides: the flush sends
    expect(sent).toEqual([["T", 5], ["T", 6]]);
    t.retry("T", 6);                            // that send failed, and its rejection landed while hidden
    vi.advanceTimersByTime(READ_FLUSH_MS * 3);
    expect(sent).toEqual([["T", 5], ["T", 6]]);  // nothing automatic while hidden
    visible = true;
    t.advance("T", 7);                          // the next send, visible, carries the highest held
    expect(sent).toEqual([["T", 5], ["T", 6], ["T", 7]]);
  });

  it("switching Threads just before the interval ends restarts the interval from the opening mark", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.advance("A", 5); t.flush();               // t=0: opening A, its mark at once
    vi.advanceTimersByTime(100);
    t.advance("A", 6);                          // t=100: an arrival in A, held
    vi.advanceTimersByTime(READ_FLUSH_MS - 200);
    t.flush();                                  // t=4900: leaving A flushes it
    t.advance("B", 7); t.flush();               // t=4900: opening B, its mark at once
    expect(sent).toEqual([["A", 5], ["A", 6], ["B", 7]]);
    t.advance("B", 8);                          // t=4900: an arrival in B, held
    vi.advanceTimersByTime(100);                // t=5000: A's old deadline passes, and nothing goes
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(READ_FLUSH_MS - 101);
    expect(sent).toHaveLength(3);               // t=9899
    vi.advanceTimersByTime(1);                  // t=9900: a full interval after B's opening mark
    expect(sent).toEqual([["A", 5], ["A", 6], ["B", 7], ["B", 8]]);
  });
});
