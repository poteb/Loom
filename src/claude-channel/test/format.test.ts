import { describe, it, expect } from "vitest";
import { formatEvent, shouldWake } from "../src/format.js";

const weave = { id: "w1", title: "PR 42" };
const names = { threads: new Map([["t1", { name: "General", url: null }], ["d", { name: "Design", url: null }]]), participants: new Map([["p1", { name: "Claude", kind: "agent" }], ["p2", { name: "Paw", kind: "human" }]]) };
const ev = (over: Partial<Parameters<typeof formatEvent>[0]>) => ({ weaveId: "w1", seq: 5, threadId: "t1", type: "message" as const, actor: "p2", at: "2026-09-11T10:00:00.000Z", payload: { text: "hi @Claude", mentions: ["p1"] }, ...over });

describe("formatEvent", () => {
  it("formats a message with full meta", () => {
    const r = formatEvent(ev({}), weave, names, "p1");
    expect(r.content).toBe("hi @Claude");
    expect(r.meta).toEqual({ weave: "w1", weave_title: "PR 42", thread: "t1", thread_name: "General", seq: "5", type: "message", from: "Paw", from_kind: "human", ts: "2026-09-11T10:00:00.000Z", mentions: "p1" });
  });
  it("describes system events", () => {
    expect(formatEvent(ev({ type: "participant.joined", payload: { participantId: "p2", name: "Paw", kind: "human", role: "member" } }), weave, names, "p1").content).toBe("Paw joined the Weave");
    expect(formatEvent(ev({ type: "thread.created", threadId: "d", payload: { threadId: "d", name: "Design" } }), weave, names, "p1").content).toBe('Thread "Design" created by Paw');
    expect(formatEvent(ev({ type: "thread.closed", threadId: "d", payload: { threadId: "d" } }), weave, names, "p1").content).toBe('Thread "Design" closed by Paw');
    expect(formatEvent(ev({ type: "participant.role_changed", payload: { participantId: "p1", role: "keeper" } }), weave, names, "p1").content).toBe("Claude is now keeper");
    expect(formatEvent(ev({ type: "weave.archived", payload: {} }), weave, names, "p1").content).toBe("Weave archived by Paw");
    expect(formatEvent(ev({ actor: "keeper:abc", type: "weave.archived", payload: {} }), weave, names, "p1").meta.from).toBe("Keeper");
  });
  it("escapes tag-breaking characters in meta values", () => {
    const r = formatEvent(ev({ threadId: "x" }), { id: "w1", title: 'Weird "title" <tag>' }, { ...names, threads: new Map([["x", { name: 'a"b>c', url: null }]]) }, "p1");
    expect(r.meta.weave_title).not.toMatch(/["<>]/);
    expect(r.meta.thread_name).not.toMatch(/["<>]/);
  });
});

describe("shouldWake", () => {
  const me = { participantId: "p1", wake: "all" as const, invites: true };
  it("never wakes for own events", () => { expect(shouldWake(ev({ actor: "p1" }), me)).toBe(false); });
  it("all: wakes for others' messages and system events", () => {
    expect(shouldWake(ev({}), me)).toBe(true);
    expect(shouldWake(ev({ type: "thread.created", payload: { threadId: "d", name: "D" } }), me)).toBe(true);
  });
  it("mentions: only messages mentioning me", () => {
    const m = { participantId: "p1", wake: "mentions" as const, invites: true };
    expect(shouldWake(ev({}), m)).toBe(true);
    expect(shouldWake(ev({ payload: { text: "hi", mentions: [] } }), m)).toBe(false);
    expect(shouldWake(ev({ type: "participant.joined", payload: {} }), m)).toBe(false);
  });
});

describe("invites", () => {
  const invite = (to: string, by = "p9") => ev({ type: "thread.invited", actor: by, payload: { threadId: "t1", participantId: to, invitedBy: by } });
  it("an invite to me wakes in both modes unless invites are off", () => {
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: false })).toBe(false);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: false })).toBe(false);
  });
  it("someone else's invite is an ordinary system event: delivered in all, suppressed in mentions", () => {
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "all", invites: true })).toBe(true);
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "mentions", invites: true })).toBe(false);
  });
  it("formats invites and url changes, and adds thread_url to every event of a linked thread", () => {
    const names = { threads: new Map([["t1", { name: "PR 12", url: "https://e.com/12" }]]), participants: new Map([["p1", { name: "Me", kind: "agent" }], ["p9", { name: "Paw", kind: "human" }]]) };
    const mine = formatEvent(invite("p1"), { id: "w1", title: "W" }, names, "p1");
    expect(mine.content).toBe('You were invited to Thread "PR 12" by Paw\nhttps://e.com/12');
    expect(mine.meta).toMatchObject({ type: "thread.invited", thread_url: "https://e.com/12", from: "Paw" });
    const theirs = formatEvent(invite("p2"), { id: "w1", title: "W" }, names, "p1");
    expect(theirs.content).toBe('unknown was invited to Thread "PR 12" by Paw');
    const changed = formatEvent(ev({ type: "thread.url_changed", actor: "p9", payload: { threadId: "t1", url: "https://e.com/13" } }), { id: "w1", title: "W" }, names, "p1");
    expect(changed.content).toBe('Thread "PR 12" now links to https://e.com/13');
    const msg = formatEvent(ev({ actor: "p9", payload: { text: "hi" } }), { id: "w1", title: "W" }, names, "p1");
    expect(msg.meta.thread_url).toBe("https://e.com/12");
    const plain = formatEvent(ev({ actor: "p9", threadId: "g1", payload: { text: "hi" } }), { id: "w1", title: "W" }, { ...names, threads: new Map([["g1", { name: "General", url: null }]]) }, "p1");
    expect(plain.meta.thread_url).toBeUndefined();
  });
});
