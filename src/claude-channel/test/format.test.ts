import { describe, it, expect } from "vitest";
import { formatEvent, shouldWake, withPreamble } from "../src/format.js";

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
  const me = { participantId: "p1", wake: "all" as const, invites: true, requests: true };
  it("never wakes for own events", () => { expect(shouldWake(ev({ actor: "p1" }), me)).toBe(false); });
  it("all: wakes for others' messages and system events", () => {
    expect(shouldWake(ev({}), me)).toBe(true);
    expect(shouldWake(ev({ type: "thread.created", payload: { threadId: "d", name: "D" } }), me)).toBe(true);
  });
  it("mentions: only messages mentioning me", () => {
    const m = { participantId: "p1", wake: "mentions" as const, invites: true, requests: true };
    expect(shouldWake(ev({}), m)).toBe(true);
    expect(shouldWake(ev({ payload: { text: "hi", mentions: [] } }), m)).toBe(false);
    expect(shouldWake(ev({ type: "participant.joined", payload: {} }), m)).toBe(false);
  });
});

describe("invites", () => {
  const invite = (to: string, by = "p9") => ev({ type: "thread.invited", actor: by, payload: { threadId: "t1", participantId: to, invitedBy: by } });
  it("an invite to me wakes in both modes unless invites are off", () => {
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: true, requests: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: true, requests: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: false, requests: true })).toBe(false);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: false, requests: true })).toBe(false);
  });
  it("someone else's invite is an ordinary system event: delivered in all, suppressed in mentions", () => {
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "all", invites: true, requests: true })).toBe(true);
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "mentions", invites: true, requests: true })).toBe(false);
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

describe("weave.guidelines_changed", () => {
  const changed = (guidelines: string, over: Partial<Parameters<typeof formatEvent>[0]> = {}) =>
    ev({ type: "weave.guidelines_changed", actor: "p2", payload: { guidelines, previous: "" }, ...over });
  it("renders the new text as the body, and says who cleared them when there is none", () => {
    const r = formatEvent(changed("be brief"), weave, names, "p1");
    expect(r.content).toBe("be brief");
    expect(r.meta).toMatchObject({ type: "weave.guidelines_changed", from: "Paw" });
    expect(formatEvent(changed(""), weave, names, "p1").content).toBe("Guidelines cleared by Paw");
  });
  it("wakes a mentions-only session with invites off — a rules change concerns every participant", () => {
    expect(shouldWake(changed("x"), { participantId: "p1", wake: "mentions", invites: false, requests: true })).toBe(true);
    expect(shouldWake(changed("x"), { participantId: "p1", wake: "all", invites: true, requests: true })).toBe(true);
  });
  it("does not wake the session that made the change", () => {
    expect(shouldWake(changed("x", { actor: "p1" }), { participantId: "p1", wake: "mentions", invites: true, requests: true })).toBe(false);
  });
});

describe("Lobby events", () => {
  const ME = "p1";
  /** The Lobby's own names: the request Thread is named after the request's title. */
  const lobbyNames = {
    threads: new Map([["r1", { name: "Review PR 14", url: null }], ["g1", { name: "General", url: null }]]),
    participants: new Map([["p1", { name: "Claude", kind: "agent" }], ["p2", { name: "Paw", kind: "human" }], ["p3", { name: "ChatGPT", kind: "agent" }]]),
  };
  const lobby = { id: "L", title: "Lobby" };
  /** Built from local clock parts, so `until 14:00` holds in every timezone the suite runs in. */
  const AT_14 = new Date(2026, 8, 17, 14, 0).toISOString();
  const opened = (over: Record<string, unknown> = {}) => ev({ type: "request.opened", actor: "p2", threadId: "r1",
    payload: { requestId: "req1", requesterId: "p2", requirements: {}, wanted: 2, expiresAt: AT_14, owner: "paw", targetWeaveTitle: "Loom session", eligible: [ME], ...over } });
  const offered = (over: Record<string, unknown> = {}) => ev({ type: "request.offered", actor: "p3", threadId: "r1",
    payload: { requestId: "req1", participantId: "p3", model: "gpt-5.6-sol", effort: "high", note: "can start now", to: ME, ...over } });
  const accepted = (over: Record<string, unknown> = {}) => ev({ type: "request.accepted", actor: "p2", threadId: "r1",
    payload: { requestId: "req1", requesterId: "p2", participantIds: [ME], targetWeaveTitle: "Loom session", ...over } });
  const closed = (over: Record<string, unknown> = {}) => ev({ type: "request.closed", actor: "system", threadId: "r1",
    payload: { requestId: "req1", requesterId: ME, to: [ME], reason: "filled", accepted: ["p3"], ...over } });
  const invited = (over: Record<string, unknown> = {}) => ev({ type: "weave.invited", actor: "p2", threadId: "r1",
    payload: { invitationId: "inv1", participantId: ME, targetWeaveTitle: "Loom session", ...over } });
  const caps = (over: Record<string, unknown> = {}) => ev({ type: "participant.capabilities_changed", actor: "p3", threadId: "g1",
    payload: { participantId: "p3", capabilities: { owner: "bob" }, ...over } });
  const requestThread = (type: "thread.created" | "thread.closed") => ev({ type, actor: "p2", threadId: "r1", payload: { threadId: "r1", name: "Review PR 14", requestId: "req1" } });

  const modes = [{ wake: "all" as const }, { wake: "mentions" as const }];
  const p = (over: Partial<{ wake: "all" | "mentions"; invites: boolean; requests: boolean }> = {}) =>
    ({ participantId: ME, wake: "all" as const, invites: true, requests: true, ...over });

  describe("shouldWake", () => {
    it("request.opened wakes an eligible session in both wake modes and nobody else", () => {
      for (const m of modes) {
        expect(shouldWake(opened(), p(m))).toBe(true);
        expect(shouldWake(opened({ eligible: ["p3"] }), p(m))).toBe(false);
        expect(shouldWake(opened({ eligible: [] }), p(m))).toBe(false);
      }
    });
    it("requests: false silences request.opened in both wake modes", () => {
      for (const m of modes) expect(shouldWake(opened(), p({ ...m, requests: false }))).toBe(false);
    });
    it("requests: false leaves the events of a request I am party to alone", () => {
      const off = p({ requests: false });
      expect(shouldWake(offered(), off)).toBe(true);
      expect(shouldWake(accepted(), off)).toBe(true);
      expect(shouldWake(closed(), off)).toBe(true);
    });
    it("request.offered wakes only the requester it is addressed to, in both wake modes", () => {
      for (const m of modes) {
        expect(shouldWake(offered(), p(m))).toBe(true);
        expect(shouldWake(offered({ to: "p2" }), p(m))).toBe(false);
      }
    });
    it("request.accepted wakes only a participant it names, in both wake modes", () => {
      for (const m of modes) {
        expect(shouldWake(accepted(), p(m))).toBe(true);
        expect(shouldWake(accepted({ participantIds: ["p3"] }), p(m))).toBe(false);
      }
    });
    it("request.closed wakes only someone in `to` — the requester or an unaccepted offerer", () => {
      for (const m of modes) {
        expect(shouldWake(closed(), p(m))).toBe(true);
        expect(shouldWake(closed({ to: ["p2", "p3"] }), p(m))).toBe(false);
      }
    });
    it("weave.invited wakes the invitee in both modes and obeys the invites pref", () => {
      for (const m of modes) {
        expect(shouldWake(invited(), p(m))).toBe(true);
        expect(shouldWake(invited(), p({ ...m, invites: false }))).toBe(false);
        expect(shouldWake(invited({ participantId: "p3" }), p(m))).toBe(false);
      }
    });
    it("participant.capabilities_changed never wakes, not even in all-events mode", () => {
      for (const m of modes) expect(shouldWake(caps(), p(m))).toBe(false);
    });
    it("a request Thread's thread.created/thread.closed never wake, while an ordinary Thread's still do", () => {
      for (const m of modes) {
        expect(shouldWake(requestThread("thread.created"), p(m))).toBe(false);
        expect(shouldWake(requestThread("thread.closed"), p(m))).toBe(false);
      }
      expect(shouldWake(ev({ type: "thread.created", actor: "p2", payload: { threadId: "d", name: "D" } }), p())).toBe(true);
    });
    it("never wakes for a Lobby event this session caused itself", () => {
      expect(shouldWake(opened({ eligible: [ME] }), p())).toBe(true);
      expect(shouldWake(ev({ ...opened(), actor: ME }), p())).toBe(false);
    });
  });

  describe("formatEvent", () => {
    it("renders an opened request as one line naming the deadline and how to offer", () => {
      const r = formatEvent(opened(), lobby, lobbyNames, ME);
      expect(r.content).toBe('Request "Review PR 14": wants 2, until 14:00 — you are eligible; offer with offer(req1)');
      expect(r.meta).toMatchObject({ type: "request.opened", request: "req1", thread_name: "Review PR 14", from: "Paw" });
    });
    it("renders an offer with the model, effort and note", () => {
      expect(formatEvent(offered(), lobby, lobbyNames, ME).content).toBe('Offer from ChatGPT (gpt-5.6-sol/high): "can start now"');
      expect(formatEvent(offered({ model: null, effort: null, note: null }), lobby, lobbyNames, ME).content).toBe("Offer from ChatGPT");
    });
    it("renders an acceptance naming me as the way into the target Weave", () => {
      expect(formatEvent(accepted(), lobby, lobbyNames, ME).content).toBe('Accepted: you were invited to "Loom session" — the invitation id arrives on the weave.invited event beside this (or from inbox); redeem with join_weave({ inviteId })');
    });
    it("renders a closure with its reason and who was accepted", () => {
      expect(formatEvent(closed(), lobby, lobbyNames, ME).content).toBe('Request "Review PR 14" filled: accepted ChatGPT');
      expect(formatEvent(closed({ reason: "expired", accepted: [] }), lobby, lobbyNames, ME).content).toBe('Request "Review PR 14" expired: nobody accepted');
    });
    it("renders an invitation carrying the invitation id, in the body and in meta", () => {
      const r = formatEvent(invited(), lobby, lobbyNames, ME);
      expect(r.content).toBe('Invited to "Loom session" — join_weave({ inviteId: "inv1" })');
      expect(r.meta).toMatchObject({ type: "weave.invited", invitation: "inv1" });
      expect(r.meta.request).toBeUndefined();
      expect(formatEvent(invited({ participantId: "p3" }), lobby, lobbyNames, ME).content).toBe('ChatGPT was invited to "Loom session"');
    });
    it("renders a profile change as a one-liner, set or cleared", () => {
      expect(formatEvent(caps(), lobby, lobbyNames, ME).content).toBe("ChatGPT updated their Lobby profile");
      expect(formatEvent(caps({ capabilities: null }), lobby, lobbyNames, ME).content).toBe("ChatGPT cleared their Lobby profile");
    });
  });
});

describe("withPreamble", () => {
  it("folds the guidelines and the event into one notification marked preamble=guidelines", () => {
    const n = { content: "hi", meta: { type: "message", seq: "5" } };
    const r = withPreamble(n, "## Loom guidelines\nbe brief");
    expect(r.content).toBe("## Loom guidelines\nbe brief\n\n---\n\nhi");
    expect(r.meta).toEqual({ type: "message", seq: "5", preamble: "guidelines" });
    expect(n.meta).toEqual({ type: "message", seq: "5" });  // the caller's meta is not mutated
  });
  it("returns the notification untouched when there are no guidelines", () => {
    const n = { content: "hi", meta: { type: "message" } };
    expect(withPreamble(n, "")).toBe(n);
  });
});
