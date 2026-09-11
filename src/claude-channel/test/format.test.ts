import { describe, it, expect } from "vitest";
import { formatEvent, shouldWake } from "../src/format.js";

const weave = { id: "w1", title: "PR 42" };
const names = { threads: new Map([["g", "General"], ["d", "Design"]]), participants: new Map([["p1", { name: "Claude", kind: "agent" }], ["p2", { name: "Paw", kind: "human" }]]) };
const ev = (over: Partial<Parameters<typeof formatEvent>[0]>) => ({ weaveId: "w1", seq: 5, threadId: "g", type: "message" as const, actor: "p2", at: "2026-09-11T10:00:00.000Z", payload: { text: "hi @Claude", mentions: ["p1"] }, ...over });

describe("formatEvent", () => {
  it("formats a message with full meta", () => {
    const r = formatEvent(ev({}), weave, names);
    expect(r.content).toBe("hi @Claude");
    expect(r.meta).toEqual({ weave: "w1", weave_title: "PR 42", thread: "g", thread_name: "General", seq: "5", type: "message", from: "Paw", from_kind: "human", ts: "2026-09-11T10:00:00.000Z", mentions: "p1" });
  });
  it("describes system events", () => {
    expect(formatEvent(ev({ type: "participant.joined", payload: { participantId: "p2", name: "Paw", kind: "human", role: "member" } }), weave, names).content).toBe("Paw joined the Weave");
    expect(formatEvent(ev({ type: "thread.created", threadId: "d", payload: { threadId: "d", name: "Design" } }), weave, names).content).toBe('Thread "Design" created by Paw');
    expect(formatEvent(ev({ type: "thread.closed", threadId: "d", payload: { threadId: "d" } }), weave, names).content).toBe('Thread "Design" closed by Paw');
    expect(formatEvent(ev({ type: "participant.role_changed", payload: { participantId: "p1", role: "keeper" } }), weave, names).content).toBe("Claude is now keeper");
    expect(formatEvent(ev({ type: "weave.archived", payload: {} }), weave, names).content).toBe("Weave archived by Paw");
    expect(formatEvent(ev({ actor: "keeper:abc", type: "weave.archived", payload: {} }), weave, names).meta.from).toBe("Keeper");
  });
  it("escapes tag-breaking characters in meta values", () => {
    const r = formatEvent(ev({ threadId: "x" }), { id: "w1", title: 'Weird "title" <tag>' }, { ...names, threads: new Map([["x", 'a"b>c']]) });
    expect(r.meta.weave_title).not.toMatch(/["<>]/);
    expect(r.meta.thread_name).not.toMatch(/["<>]/);
  });
});

describe("shouldWake", () => {
  const me = { participantId: "p1", wake: "all" as const };
  it("never wakes for own events", () => { expect(shouldWake(ev({ actor: "p1" }), me)).toBe(false); });
  it("all: wakes for others' messages and system events", () => {
    expect(shouldWake(ev({}), me)).toBe(true);
    expect(shouldWake(ev({ type: "thread.created", payload: { threadId: "d", name: "D" } }), me)).toBe(true);
  });
  it("mentions: only messages mentioning me", () => {
    const m = { participantId: "p1", wake: "mentions" as const };
    expect(shouldWake(ev({}), m)).toBe(true);
    expect(shouldWake(ev({ payload: { text: "hi", mentions: [] } }), m)).toBe(false);
    expect(shouldWake(ev({ type: "participant.joined", payload: {} }), m)).toBe(false);
  });
});
