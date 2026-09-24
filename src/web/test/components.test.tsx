// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { ThreadList } from "../src/components/ThreadList.js";
import { ThreadDetails } from "../src/components/ThreadDetails.js";
import { ThreadHeader } from "../src/components/ThreadHeader.js";
import { Header } from "../src/components/Header.js";
import { initials } from "../src/components/initials.js";
import { MessageList } from "../src/components/MessageList.js";
import { Composer } from "../src/components/Composer.js";
import { InviteBanner } from "../src/components/InviteBanner.js";
import { GuidelinesPanel, GUIDELINES_MAX } from "../src/components/GuidelinesPanel.js";
import { RequestsPanel } from "../src/components/RequestsPanel.js";
import { ProfileCard } from "../src/components/ProfileCard.js";
import { WeaveView } from "../src/components/WeaveView.js";
import { App, routeOf } from "../src/app.js";
import { MAX_GUIDELINES_LENGTH } from "@loom/core";
import { LoomClient, type Acceptance, type Offer, type Thread } from "@loom/client";
import { CLOSED_REQUESTS_PAGE, type Session, type SessionState } from "../src/session.js";
import type { VersionedRequest } from "../src/requests-state.js";
import { memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";
import { setIdentity } from "../src/weaves-store.js";

const me = { id: "p1", weaveId: "w1", name: "Paw", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null, lastSeenAt: null };
const bot = { id: "p2", weaveId: "w1", name: "Bot", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: "a1", capabilities: null, lastSeenAt: null };
const general = { id: "g1", weaveId: "w1", name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null, url: null };
const pr = { id: "t1", weaveId: "w1", name: "PR 12", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: "https://github.com/poteb/Loom/pull/12" };

function state(over: Partial<SessionState> = {}): SessionState {
  return { status: "ready", weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "" }, threads: [general, pr], participants: [me, bot],
    events: [], me: { participant: me, token: "t" }, currentThreadId: "g1", connection: "open", needsName: false, invitesForMe: new Set(), invited: {},
    instanceGuidelines: "", requests: {}, requestsLoaded: true, closedRequestsPage: CLOSED_REQUESTS_PAGE, ...over };
}
function session(over: Partial<Session> = {}): Session {
  return { getState: () => state(), subscribe: () => () => {}, load: async () => {}, join: async () => {}, selectThread: vi.fn(), post: async () => {},
    createThread: vi.fn(async () => {}), setThreadUrl: vi.fn(async () => {}), invite: vi.fn(async () => {}), closeThread: async () => {}, archive: async () => {}, setGuidelines: vi.fn(async () => {}),
    canModerate: () => false, canEditThread: (t) => t.createdBy === "p1", markSeen: () => {}, dismissNamePrompt: () => {}, dispose: () => {},
    openRequest: vi.fn(async () => request()), offer: vi.fn(async () => {}), accept: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    targets: vi.fn(async () => []),
    listListeners: vi.fn(() => ({ issue: { generation: 0 }, page: Promise.resolve({ total: 0, matched: 0, listeners: [] }) })),
    reportCredentialFailure: vi.fn(), ...over };
}

// --- Lobby fixtures ---------------------------------------------------------
const PROFILE = { models: [{ model: "gpt-5.6-sol", effort: "high" }, { model: "gpt-5.6-sol", effort: "low" }],
  tools: ["github"], runtime: "codex", spawnsSubagents: true, owner: "bob", serves: "anyone" as const };
const helper = { ...bot, name: "Helper", capabilities: PROFILE };
const reqThread = { id: "th1", weaveId: "w1", name: "Review PR 14", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: null };
const NOW = Date.parse("2026-09-16T13:30:00.000Z");

function request(over: Partial<VersionedRequest> = {}): VersionedRequest {
  return { id: "r1", threadId: "th1", requesterId: "p1", owner: "paw",
    requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }], tools: ["github"] }, wanted: 2,
    targetWeaveId: "w2", targetWeaveTitle: "Loom session", targetThreadId: "t2", url: null,
    status: "open", expiresAt: "2026-09-16T14:00:00.000Z", closedAt: null, lastEventSeq: 5, createdAt: "",
    eligible: ["p2"], offers: [], acceptances: [], version: 5, ...over };
}
const anOffer = (participantId: string, over: Partial<Offer> = {}): Offer =>
  ({ requestId: "r1", participantId, model: "gpt-5.6-sol", effort: "high", note: "ready", accepted: false, createdAt: "", ...over });

/** The Lobby page: `state.lobby` points at the Weave on screen. */
function lobbyState(over: Partial<SessionState> = {}): SessionState {
  return state({ lobby: { weaveId: "w1", title: "Lobby" }, threads: [general, reqThread], participants: [me, helper],
    requests: { r1: request() }, ...over });
}

describe("ThreadList", () => {
  it("tags a GitHub pull request thread PR <n> and highlights a thread with an unread invite", () => {
    render(<ThreadList state={state({ invitesForMe: new Set(["t1"]) })} session={session()} onError={() => {}} />);
    const row = screen.getByRole("button", { name: /^PR 12/ });
    expect(row.querySelector(".thread-tag")!.textContent).toBe("PR 12");
    expect(row.closest("li")!.className).toContain("invited");
    expect(screen.getByText(/invited/i)).toBeTruthy();
    // The artefact link itself lives in the thread header and the details panel now, not in the list.
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("tags any other http(s) artefact with its host", () => {
    const other = { ...pr, url: "https://docs.example.com/design/7" };
    render(<ThreadList state={state({ threads: [general, other] })} session={session()} onError={() => {}} />);
    expect(screen.getByRole("button", { name: /^PR 12/ }).querySelector(".thread-tag")!.textContent).toBe("docs.example.com");
  });
  it("is a navigation landmark, not a second complementary one inside the sidebar aside", () => {
    // app.tsx wraps this in <aside class="sidebar">; an <aside> here would nest two
    // complementary landmarks, and a screen reader announces the inner one as unnamed context.
    const { container } = render(<ThreadList state={state()} session={session()} onError={() => {}} />);
    expect(container.querySelector(".threads")!.tagName).toBe("NAV");
  });

  it("gives a non-http url no link and no tag", () => {
    const evil = { ...pr, url: "javascript:alert(1)" };
    render(<ThreadList state={state({ threads: [general, evil] })} session={session()} onError={() => {}} />);
    expect([screen.queryByRole("link"), screen.getByRole("button", { name: /^PR 12/ }).querySelector(".thread-tag")])
      .toEqual([null, null]);
  });
  it("new-thread form sends the url", async () => {
    const s = session();
    render(<ThreadList state={state({ currentThreadId: "t1" })} session={s} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.input(screen.getByPlaceholderText("Thread name"), { target: { value: "PR 13" } });
    fireEvent.input(screen.getByPlaceholderText("Artefact URL (optional)"), { target: { value: "https://e.com/13" } });
    fireEvent.submit(screen.getByPlaceholderText("Thread name").closest("form")!);
    await Promise.resolve();
    expect(s.createThread).toHaveBeenCalledWith("PR 13", "https://e.com/13");
  });
  it("renders no close control in the list: closing a thread lives in the details panel", () => {
    render(<ThreadList state={state()} session={session({ canModerate: () => true })} onError={() => {}} />);
    expect(screen.queryByRole("button", { name: /^close( thread)?$/i })).toBeNull();
  });

  describe("the thread filter", () => {
    const closedA = { ...pr, id: "t2", name: "Old review", closedAt: "2026-09-20T10:00:00.000Z" };
    const closedB = { ...pr, id: "t3", name: "Expiry check", closedAt: "2026-09-20T11:00:00.000Z", url: null };
    const threeWay = (over: Partial<SessionState> = {}) => state({ threads: [general, pr, closedA, closedB], ...over });
    const names = (container: Element) => [...container.querySelectorAll(".thread-name")].map((e) => e.textContent);
    const tab = (name: RegExp) => screen.getByRole("button", { name });

    it("counts the open and the closed threads on its tabs", () => {
      render(<ThreadList state={threeWay()} session={session()} onError={() => {}} />);
      expect([tab(/^Open/).textContent, tab(/^Closed/).textContent, tab(/^All$/).textContent])
        .toEqual(["Open · 2", "Closed · 2", "All"]);
    });

    it("shows the open threads by default and hides the closed ones", () => {
      const { container } = render(<ThreadList state={threeWay()} session={session()} onError={() => {}} />);
      expect([names(container), tab(/^Open/).getAttribute("aria-pressed")]).toEqual([["General", "PR 12"], "true"]);
    });

    it("shows only the closed threads, and every thread under All", () => {
      const { container } = render(<ThreadList state={threeWay({ currentThreadId: "t2" })} session={session()} onError={() => {}} />);
      fireEvent.click(tab(/^Closed/));
      const closed = names(container);
      fireEvent.click(tab(/^All$/));
      expect([closed, names(container), tab(/^All$/).getAttribute("aria-pressed"), tab(/^Closed/).getAttribute("aria-pressed")])
        .toEqual([["Old review", "Expiry check"], ["General", "PR 12", "Old review", "Expiry check"], "true", "false"]);
    });

    it("always lists the current thread, even where the filter would hide it", () => {
      const { container } = render(<ThreadList state={threeWay({ currentThreadId: "t3" })} session={session()} onError={() => {}} />);
      expect(names(container)).toEqual(["General", "PR 12", "Expiry check"]);
    });

    it("keeps the current General thread on the Closed tab", () => {
      const { container } = render(<ThreadList state={threeWay({ currentThreadId: "g1" })} session={session()} onError={() => {}} />);
      fireEvent.click(tab(/^Closed/));
      expect(names(container)).toEqual(["General", "Old review", "Expiry check"]);
    });
  });
});

describe("ThreadDetails", () => {
  const at = "2026-09-24T13:07:00.000Z";
  const mine = { ...pr, createdAt: at };
  const details = (over: Partial<SessionState> = {}, s: Session = session(), thread: Thread = mine) =>
    render(<ThreadDetails thread={thread} state={state({ currentThreadId: thread.id, threads: [general, thread], ...over })} session={s} onError={() => {}} />);
  const fact = (container: Element, label: string) => {
    const dt = [...container.querySelectorAll(".facts dt")].find((e) => e.textContent === label);
    return dt?.nextElementSibling?.textContent ?? null;
  };

  it("is the complementary region named Thread details", () => {
    details();
    expect(screen.getByRole("complementary", { name: "Thread details" })).toBeTruthy();
  });

  it("states the thread's status, creator, link and message counts", () => {
    const msg = (seq: number) => ({ weaveId: "w1", seq, threadId: "t1", type: "message" as const, actor: "p1", at, payload: { text: "hi" } });
    const sys = (seq: number) => ({ weaveId: "w1", seq, threadId: "t1", type: "participant.joined" as const, actor: "p2", at, payload: { participantId: "p2" } });
    const elsewhere = { ...msg(9), threadId: "g1" };
    const { container } = details({ events: [msg(1), sys(2), sys(3), msg(4), elsewhere] });
    expect([fact(container, "Status"), fact(container, "Created")!.endsWith("· Paw"), fact(container, "Messages")])
      .toEqual(["open", true, "2 · 2 system events"]);
    const link = screen.getByRole("link", { name: /github.com\/poteb\/Loom\/pull\/12/ });
    expect(link.getAttribute("href")).toBe(pr.url);
  });

  it("says none when the thread links to no artefact, and closed for a closed thread", () => {
    const { container } = details({}, session(), { ...mine, url: null, closedAt: at });
    expect([fact(container, "Linked artefact"), fact(container, "Status")]).toEqual(["none", "closed"]);
  });

  it("renders a non-http url as plain text, never as a link", () => {
    details({}, session(), { ...mine, url: "javascript:alert(1)" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
  });

  it("saves the artefact link for whoever may edit the thread", async () => {
    const s = session();
    details({}, s);
    const box = screen.getByLabelText("Artefact link") as HTMLInputElement;
    const before = box.value;
    fireEvent.input(box, { target: { value: " https://e.com/99 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save link" }));
    await Promise.resolve();
    expect([before, (s.setThreadUrl as ReturnType<typeof vi.fn>).mock.calls]).toEqual([pr.url, [["t1", "https://e.com/99"]]]);
  });

  it("offers no link form to someone who may not edit the thread", () => {
    details({}, session({ canEditThread: () => false }));
    expect([screen.queryByLabelText("Artefact link"), screen.queryByRole("button", { name: "Save link" })]).toEqual([null, null]);
  });

  it("offers Close thread to a keeper on an open thread that is not General, and closes it", async () => {
    const closeThread = vi.fn(async () => {});
    details({}, session({ canModerate: () => true, closeThread }));
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await Promise.resolve();
    expect(closeThread).toHaveBeenCalledWith("t1");
  });

  it("offers no Close thread on General, on a closed thread, or to a member", () => {
    details({}, session({ canModerate: () => true }), { ...general, createdAt: at });
    details({}, session({ canModerate: () => true }), { ...mine, closedAt: at });
    details({}, session());
    expect(screen.queryAllByRole("button", { name: "Close thread" })).toHaveLength(0);
  });

  it("lists who is in the Weave, with me marked as you and agents in mono", () => {
    const { container } = details();
    const rows = [...container.querySelectorAll(".people li")].map((li) => [li.querySelector(".person-name")!.textContent,
      li.querySelector(".person-role")!.textContent, li.querySelector(".person-name")!.classList.contains("mono")]);
    expect([screen.getByText("In this Weave · 2").tagName, rows])
      .toEqual(["SPAN", [["Paw", "you · member", false], ["Bot", "member", true]]]);
  });

  it("invite button only for creator/keeper and only for others", () => {
    const s = session();
    details({}, s);
    const inviteButtons = screen.getAllByRole("button", { name: /^invite /i });
    expect(inviteButtons.map((b) => b.getAttribute("aria-label"))).toEqual(["invite Bot"]);   // not myself
    fireEvent.click(inviteButtons[0]!);
    expect(s.invite).toHaveBeenCalledWith("t1", "p2");
  });

  it("shows an invited mark instead of the invite button for someone already invited; no invite controls for a plain member", () => {
    details({ invited: { t1: new Set(["p2"]) } });
    expect(screen.queryByRole("button", { name: /^invite /i })).toBeNull();
    expect(screen.getByTitle("invited")).toBeTruthy();
    details({}, session({ canEditThread: () => false }));
    expect(screen.queryAllByRole("button", { name: /^invite /i })).toHaveLength(0);
  });
});

describe("ThreadHeader", () => {
  const header = (thread: Thread = pr, fold = true, open = false) => {
    const onFold = vi.fn();
    const onToggleDetails = vi.fn();
    const r = render(<ThreadHeader thread={thread} fold={fold} onFold={onFold} detailsOpen={open} onToggleDetails={onToggleDetails} />);
    return { ...r, onFold, onToggleDetails };
  };

  it("names the thread with its status pill", () => {
    header();
    expect([screen.getByRole("heading", { level: 2 }).textContent, screen.getByText("open").className])
      .toEqual(["# PR 12", "pill pill-open"]);
  });

  it("calls General the Weave-wide thread", () => {
    header(general);
    expect(screen.getByText("Weave-wide thread")).toBeTruthy();
  });

  it("links an http(s) artefact under the name, and shows nothing for any other url", () => {
    header();
    const href = screen.getByRole("link").getAttribute("href");
    header({ ...pr, id: "t9", url: "javascript:alert(1)" });
    expect([href, screen.getAllByRole("link").length, screen.queryByText(/javascript/)]).toEqual([pr.url, 1, null]);
  });

  it("reports the fold checkbox", () => {
    const { onFold } = header();
    const box = screen.getByRole("checkbox", { name: "Fold system events" }) as HTMLInputElement;
    const was = box.checked;
    fireEvent.click(box);
    expect([was, onFold.mock.calls]).toEqual([true, [[false]]]);
  });

  it("says whether the details panel is open on its toggle", () => {
    const { onToggleDetails } = header();
    const closed = screen.getByRole("button", { name: "Thread details" });
    const was = closed.getAttribute("aria-expanded");
    fireEvent.click(closed);
    header(pr, true, true);
    const all = screen.getAllByRole("button", { name: "Thread details" }).map((b) => b.getAttribute("aria-expanded"));
    expect([was, all, onToggleDetails.mock.calls.length]).toEqual(["false", ["false", "true"], 1]);
  });
});

describe("Header", () => {
  const pill = () => screen.getByRole("status");

  for (const [connection, text] of [
    ["open", "Connected"], ["connecting", "Connecting…"], ["reconnecting", "Reconnecting…"], ["closed", "Disconnected"],
  ] as const) {
    it(`says ${text} while the stream is ${connection}`, () => {
      render(<Header state={state({ connection })} session={session()} onError={() => {}} />);
      expect([pill().textContent, pill().classList.contains("conn"), pill().classList.contains(`conn-${connection}`)])
        .toEqual([text, true, true]);
    });
  }

  it("shows who I am as initials, name and role", () => {
    const { container } = render(<Header state={state({ me: { participant: { ...me, name: "Paw_browser" }, token: "t" } })}
      session={session()} onError={() => {}} />);
    expect([container.querySelector(".avatar")!.textContent, container.querySelector(".header-right strong")!.textContent,
      container.querySelector(".who-role")!.textContent]).toEqual(["PB", "Paw_browser", "member"]);
  });

  it("says reading as guest without an identity", () => {
    const { container } = render(<Header state={state({ me: undefined })} session={session()} onError={() => {}} />);
    expect([screen.getByText("reading as guest").tagName, container.querySelector(".avatar")]).toEqual(["SPAN", null]);
  });

  it("offers Archive Weave to a keeper only", () => {
    render(<Header state={state()} session={session()} onError={() => {}} />);
    const member = screen.queryByRole("button", { name: "Archive Weave" });
    render(<Header state={state()} session={session({ canModerate: () => true })} onError={() => {}} />);
    expect([member, screen.getAllByRole("button", { name: "Archive Weave" }).length]).toEqual([null, 1]);
  });
});

describe("initials", () => {
  it("takes the first letters of the first two name parts, else the first two letters", () => {
    expect(["Paw_browser", "seed-14", "dana", "a", "x.y.z"].map(initials)).toEqual(["PB", "S1", "DA", "A", "XY"]);
  });
});

describe("InviteBanner", () => {
  const invite = (seq: number, actor: string) => ({ weaveId: "w1", seq, threadId: "t1", type: "thread.invited" as const,
    actor, at: new Date().toISOString(), payload: { threadId: "t1", participantId: "p1", invitedBy: actor } });

  it("names the inviter and the thread, and dismissing marks the thread seen", () => {
    const s = session({ markSeen: vi.fn() });
    render(<InviteBanner state={state({ invitesForMe: new Set(["t1"]), events: [invite(1, "p2")] })} session={s} />);
    expect(screen.getByText("Bot invited you to PR 12")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("dismiss"));
    expect(s.markSeen).toHaveBeenCalledWith("t1");
  });
  it("uses the latest invite addressed to me, and calls a keeper actor Keeper", () => {
    render(<InviteBanner state={state({ invitesForMe: new Set(["t1"]), events: [invite(1, "p2"), invite(2, "keeper:k1")] })} session={session()} />);
    expect(screen.getByText("Keeper invited you to PR 12")).toBeTruthy();
  });
  it("renders nothing without an unread invite", () => {
    const { container } = render(<InviteBanner state={state()} session={session()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("MessageList", () => {
  it("renders invite and url-change events as system lines", () => {
    const events = [
      { weaveId: "w1", seq: 1, threadId: "t1", type: "thread.invited" as const, actor: "p1", at: new Date().toISOString(), payload: { threadId: "t1", participantId: "p2", invitedBy: "p1" } },
      { weaveId: "w1", seq: 2, threadId: "t1", type: "thread.url_changed" as const, actor: "p1", at: new Date().toISOString(), payload: { threadId: "t1", url: "https://e.com/x" } },
    ];
    render(<MessageList state={state({ currentThreadId: "t1", events })} fold={false} />);
    expect(screen.getByText(/Bot invited by Paw/)).toBeTruthy();
    expect(screen.getByText(/now links to https:\/\/e.com\/x/)).toBeTruthy();
  });

  it("names the actor and renders the new text beneath a guidelines change, and says cleared for an empty one", () => {
    const change = { weaveId: "w1", seq: 3, threadId: "t1", type: "weave.guidelines_changed" as const, actor: "p1",
      at: new Date().toISOString(), payload: { guidelines: "Be **kind**", previous: "" } };
    const { container, rerender } = render(<MessageList state={state({ currentThreadId: "t1", events: [change] })} fold={true} />);
    expect(screen.getByText(/Paw changed the Weave guidelines/)).toBeTruthy();
    expect(container.querySelector(".system-body strong")!.textContent).toBe("kind");
    const cleared = { ...change, seq: 4, payload: { guidelines: "", previous: "Be **kind**" } };
    rerender(<MessageList state={state({ currentThreadId: "t1", events: [cleared] })} fold={true} />);
    expect(screen.getByText(/Paw cleared the Weave guidelines/)).toBeTruthy();
    expect(container.querySelector(".system-body")).toBeNull();
  });

  it("renders every request event as one system line in the request Thread", () => {
    const base = { weaveId: "w1", threadId: "th1", actor: "p1", at: new Date().toISOString() };
    const events = [
      { ...base, seq: 1, type: "request.opened" as const, payload: { requestId: "r1", requesterId: "p1", wanted: 2, expiresAt: "2026-09-16T14:00:00.000Z", owner: "paw", targetWeaveTitle: "Loom session", eligible: ["p2"] } },
      { ...base, seq: 2, type: "request.offered" as const, actor: "p2", payload: { requestId: "r1", participantId: "p2", model: "gpt-5.6-sol", effort: "high", note: "ready", to: "p1" } },
      { ...base, seq: 3, type: "request.accepted" as const, payload: { requestId: "r1", requesterId: "p1", participantIds: ["p2"], targetWeaveTitle: "Loom session" } },
      { ...base, seq: 4, type: "weave.invited" as const, payload: { invitationId: "i1", participantId: "p2", targetWeaveTitle: "Loom session" } },
      { ...base, seq: 5, type: "request.closed" as const, payload: { requestId: "r1", requesterId: "p1", to: ["p1"], reason: "filled", accepted: ["p2"] } },
    ];
    const { container } = render(<MessageList state={lobbyState({ currentThreadId: "th1", events })} fold={false} />);
    expect(container.querySelectorAll(".sysrow")).toHaveLength(5);
    expect(screen.getByText(/request "Review PR 14" opened by Paw: wants 2/)).toBeTruthy();
    expect(screen.getByText(/Helper offered \(gpt-5\.6-sol\/high\): "ready"/)).toBeTruthy();
    expect(screen.getByText(/Helper accepted for "Loom session"/)).toBeTruthy();
    expect(screen.getByText(/Helper invited to "Loom session"/)).toBeTruthy();
    expect(screen.getByText(/request filled: accepted Helper/)).toBeTruthy();
  });

  it("renders request.completed, request.overdue and thread.removed as system lines in the CLI's words", () => {
    const base = { weaveId: "w1", threadId: "th1", actor: "p2", at: new Date().toISOString() };
    const due = "2026-09-16T14:00:00.000Z";
    const seen = "2026-09-16T13:40:00.000Z";
    const events = [
      { ...base, seq: 1, type: "request.completed" as const, payload: { requestId: "r1", participantId: "p2", note: "done", to: "p1" } },
      { ...base, seq: 2, type: "request.overdue" as const, actor: "system", payload: { requestId: "r1", participantId: "p2", dueAt: due, lastSeenAt: seen, to: "p1" } },
      { ...base, seq: 3, type: "request.overdue" as const, actor: "system", payload: { requestId: "r1", participantId: "p2", dueAt: due, lastSeenAt: null, to: "p1" } },
      { ...base, seq: 4, type: "thread.removed" as const, actor: "p1", payload: { threadId: "th1", participantId: "p2", removedBy: "p1", requestId: "r1" } },
      { ...base, seq: 5, type: "thread.removed" as const, actor: "keeper:k1", payload: { threadId: "th1", participantId: "p2", removedBy: "keeper:k1" } },
    ];
    const { container } = render(<MessageList state={lobbyState({ currentThreadId: "th1", events })} fold={false} />);
    const lines = [...container.querySelectorAll(".sysrow .sys-text")].map((d) => d.textContent);
    const clock = (iso: string) => new Date(iso).toLocaleTimeString();
    expect(lines).toEqual([
      `Helper finished "Review PR 14"`,
      `Helper missed the deadline of "Review PR 14" (due ${clock(due)}, last seen ${clock(seen)})`,
      `Helper missed the deadline of "Review PR 14" (due ${clock(due)}, last seen never)`,
      "Helper was removed from this Thread by Paw",
      "Helper was removed from this Thread by Keeper",
    ]);
  });

  describe("a message", () => {
    const at = "2026-09-24T13:12:04.000Z";
    const said = (actor: string, seq = 1) => ({ weaveId: "w1", seq, threadId: "g1", type: "message" as const, actor, at, payload: { text: "hi **there**" } });
    const head = (el: Element) => ({
      avatar: el.querySelector(".msg-avatar")!.textContent, agentAvatar: el.querySelector(".msg-avatar")!.classList.contains("agent"),
      name: el.querySelector(".msg-name")!.textContent, pill: el.querySelector(".msg-head .pill")?.textContent ?? null,
      role: el.querySelector(".msg-role")?.textContent ?? null,
    });

    it("draws a human with initials, the name and the time, and the Markdown body", () => {
      const { container } = render(<MessageList state={state({ events: [said("p1")] })} fold={true} />);
      const msg = container.querySelector("article.msg")!;
      const time = msg.querySelector(".msg-head time")!;
      expect([head(msg), time.getAttribute("dateTime"), time.textContent, msg.querySelector(".msg-body strong")!.textContent])
        .toEqual([{ avatar: "PA", agentAvatar: false, name: "Paw", pill: null, role: null }, at, new Date(at).toLocaleTimeString(), "there"]);
    });

    it("marks an agent with an agent pill and the agent avatar", () => {
      const { container } = render(<MessageList state={state({ events: [said("p2")] })} fold={true} />);
      expect(head(container.querySelector("article.msg")!)).toEqual({ avatar: "BO", agentAvatar: true, name: "Bot", pill: "agent", role: null });
    });

    it("shows the role only for a keeper", () => {
      const keeper = { ...me, role: "keeper" as const };
      const { container } = render(<MessageList state={state({ participants: [keeper, bot], events: [said("p1"), said("p2", 2)] })} fold={true} />);
      expect([...container.querySelectorAll("article.msg")].map((m) => head(m).role)).toEqual(["keeper", null]);
    });

    it("calls a keeper actor Keeper, with K on the avatar", () => {
      const { container } = render(<MessageList state={state({ events: [said("keeper:k1")] })} fold={true} />);
      expect(head(container.querySelector("article.msg")!)).toEqual({ avatar: "K", agentAvatar: false, name: "Keeper", pill: null, role: null });
    });
  });

  describe("folding system events", () => {
    const sys = (seq: number, type: "participant.joined" | "participant.capabilities_changed", at: string) =>
      ({ weaveId: "w1", seq, threadId: "g1", type, actor: "p2", at, payload: { participantId: "p2", capabilities: {} } });
    const said = (seq: number) => ({ weaveId: "w1", seq, threadId: "g1", type: "message" as const, actor: "p1", at: "2026-09-24T13:08:00.000Z", payload: { text: "hi" } });
    const t1 = "2026-09-24T13:07:09.000Z"; const t3 = "2026-09-24T13:07:11.000Z";
    const run = [sys(1, "participant.joined", t1), sys(2, "participant.capabilities_changed", "2026-09-24T13:07:10.000Z"), sys(3, "participant.capabilities_changed", t3)];
    const rows = (c: Element) => [...c.querySelectorAll(".sysrow")];

    it("folds a run of system events into one row with a summary, the time range and a Show button", () => {
      const { container } = render(<MessageList state={state({ events: run })} fold={true} />);
      const row = rows(container)[0]!;
      const button = screen.getByRole("button", { name: "Show 3 events" });
      expect([rows(container).length, row.querySelector("strong")!.textContent, row.querySelector(".sys-text")!.textContent,
        row.querySelector("time.mono")!.textContent, button.getAttribute("aria-expanded"), row.contains(button)])
        .toEqual([1, "1 joined", "1 joined · 2 profile updates",
          `${new Date(t1).toLocaleTimeString()}-${new Date(t3).toLocaleTimeString()}`, "false", true]);
      expect(screen.queryByText(/Bot joined/)).toBeNull();
    });

    it("expands the run in place, and Hide folds it again", () => {
      const { container } = render(<MessageList state={state({ events: [...run, said(4)] })} fold={true} />);
      fireEvent.click(screen.getByRole("button", { name: "Show 3 events" }));
      const hide = screen.getByRole("button", { name: "Hide" });
      const open = [rows(container).length, hide.getAttribute("aria-expanded"), !!screen.getByText("Bot joined"),
        container.querySelector(".messages")!.lastElementChild!.previousElementSibling!.matches("article.msg")];
      fireEvent.click(hide);
      expect([open, rows(container).length, !!screen.getByRole("button", { name: "Show 3 events" })])
        .toEqual([[4, "true", true, true], 1, true]);
    });

    it("shows a single system event as it is", () => {
      const { container } = render(<MessageList state={state({ events: [said(1), sys(2, "participant.joined", t1), said(3)] })} fold={true} />);
      expect([rows(container).length, container.querySelector(".sysrow .sys-text")!.textContent, screen.queryByRole("button")])
        .toEqual([1, "Bot joined", null]);
    });

    it("draws every system event as its own row when folding is off", () => {
      const { container } = render(<MessageList state={state({ events: run })} fold={false} />);
      expect([[...container.querySelectorAll(".sysrow .sys-text")].map((e) => e.textContent), screen.queryByRole("button")])
        .toEqual([["Bot joined", "Bot updated their Lobby profile", "Bot updated their Lobby profile"], null]);
    });
  });

  describe("the connection row", () => {
    const conn = (c: Element) => {
      const row = c.querySelector(".sysrow-conn");
      return row && [row.textContent, row.querySelector(".conn-row-dot")!.classList.contains("warn") ? "warn" : "danger",
        row === c.querySelector(".messages")!.lastElementChild!.previousElementSibling];
    };

    it("is absent while the stream is open or first connecting", () => {
      const open = render(<MessageList state={state({ connection: "open" })} fold={true} />).container;
      const connecting = render(<MessageList state={state({ connection: "connecting" })} fold={true} />).container;
      expect([conn(open), conn(connecting)]).toEqual([null, null]);
    });

    it("says the connection is lost, with an amber dot, at the end of the stream while reconnecting", () => {
      const { container } = render(<MessageList state={state({ connection: "reconnecting" })} fold={true} />);
      expect(conn(container)).toEqual(["Connection lost. Reconnecting…", "warn", true]);
    });

    it("says Disconnected, with a red dot, once the stream has given up", () => {
      const { container } = render(<MessageList state={state({ connection: "closed" })} fold={true} />);
      expect(conn(container)).toEqual(["Disconnected.", "danger", true]);
    });
  });
});

describe("Composer", () => {
  const draw = (over: Partial<SessionState> = {}, onSend = vi.fn(async (_: string) => {})) => {
    render(<Composer state={state(over)} onSend={onSend} />);
    return { onSend, box: screen.getByRole("textbox", { name: /^Message #/ }) as HTMLTextAreaElement };
  };

  it("labels the box with the thread and says how to mention", () => {
    const { box } = draw();
    expect([screen.getByLabelText("Message #General"), box.placeholder]).toEqual([box, "Message #General, @name to mention"]);
  });

  it("says a closed thread is closed, and is disabled", () => {
    const { box } = draw({ threads: [general, { ...pr, closedAt: "2026-09-24T10:00:00.000Z" }], currentThreadId: "t1" });
    expect([box.placeholder, box.disabled]).toEqual(["This thread is closed", true]);
  });

  it("states the keys in its footer beside Send", () => {
    const { container } = render(<Composer state={state()} onSend={async () => {}} />);
    expect([container.querySelector(".composer-hint")!.textContent, [...container.querySelectorAll(".composer-hint .kbd")].map((k) => k.textContent),
      container.querySelector(".composer-foot button")!.textContent]).toEqual(["Markdown · Enter send · Shift Enter newline", ["Enter", "Shift Enter"], "Send"]);
  });

  it("sends the trimmed text on Enter and clears the box, but not on Shift Enter", async () => {
    const { box, onSend } = draw();
    fireEvent.input(box, { target: { value: "  hello  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    const before = onSend.mock.calls.length;
    fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => expect(box.value).toBe(""));
    expect([before, onSend.mock.calls]).toEqual([0, [["hello"]]]);
  });
});

describe("RequestsPanel", () => {
  const asHelper = (over: Partial<SessionState> = {}) => lobbyState({ me: { participant: helper, token: "t" }, ...over });

  // A read that failed is not an empty board: the panel must not say "no open requests" when what it
  // actually knows is that it could not find out.
  it("says the requests could not be loaded rather than claiming the board is empty", () => {
    const st = lobbyState({ requests: {}, requestsLoaded: false, requestsError: "simulated network failure" });
    render(<RequestsPanel state={st} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.getByText("Could not load requests — retrying…")).toBeTruthy();
    expect(screen.queryByText("No open requests.")).toBeNull();
  });

  it("says the board is empty once a read has actually come back empty", () => {
    const st = lobbyState({ requests: {} });
    render(<RequestsPanel state={st} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.getByText("No open requests.")).toBeTruthy();
  });

  it("renders nothing on a Weave that is not the Lobby", () => {
    const { container } = render(<RequestsPanel state={state()} session={session()} onError={() => {}} now={NOW} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists an open request with its title, requirements, accepted count, countdown and offers", () => {
    const st = lobbyState({ requests: { r1: request({ offers: [anOffer("p2")] }) } });
    const { container } = render(<RequestsPanel state={st} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.getByText("Review PR 14")).toBeTruthy();
    expect(container.querySelector(".req-needs")!.textContent).toBe("gpt-5.6-sol/high · github");
    expect(screen.getByText("0 of 2 accepted")).toBeTruthy();
    expect(screen.getByText("30m left")).toBeTruthy();
    expect(screen.getByText(/Helper \(gpt-5\.6-sol\/high\): "ready"/)).toBeTruthy();
  });

  it("collapses filled, expired and cancelled requests below the open ones", () => {
    const st = lobbyState({
      threads: [general, reqThread, { ...reqThread, id: "th2", name: "Old ask" }],
      requests: { r1: request(), r2: request({ id: "r2", threadId: "th2", status: "cancelled", closedAt: "2026-09-16T13:00:00.000Z", version: 9 }) },
    });
    const { container } = render(<RequestsPanel state={st} session={session()} onError={() => {}} now={NOW} />);
    expect(container.querySelectorAll(".request-list > li")).toHaveLength(1);
    const details = container.querySelector("details.closed-requests") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Closed (1)");
    expect(details.textContent).toContain("Old ask");
    expect(details.textContent).toContain("cancelled");
  });

  it("shows an open request past its deadline as expired before any closure arrives", () => {
    const st = lobbyState({ requests: { r1: request() } });
    render(<RequestsPanel state={st} session={session()} onError={() => {}} now={Date.parse("2026-09-16T14:00:01.000Z")} />);
    expect(screen.getByText("expired")).toBeTruthy();
    expect(screen.queryByText(/left$/)).toBeNull();
  });

  it("agrees with the countdown at the very instant of the deadline", () => {
    render(<RequestsPanel state={lobbyState()} session={session()} onError={() => {}} now={Date.parse("2026-09-16T14:00:00.000Z")} />);
    expect(screen.getByText("Closed (1)")).toBeTruthy();
    expect(screen.queryByText(/left$/)).toBeNull();
  });

  it("says so only when the closed section is a page rather than the whole history", () => {
    const past = Date.parse("2026-09-16T14:00:01.000Z");
    const full = lobbyState({ closedRequestsPage: 1, requests: { r1: request() } });
    const { rerender } = render(<RequestsPanel state={full} session={session()} onError={() => {}} now={past} />);
    expect(screen.getByText("Showing the newest 1 of each closed status.")).toBeTruthy();
    const room = lobbyState({ closedRequestsPage: 25, requests: { r1: request() } });
    rerender(<RequestsPanel state={room} session={session()} onError={() => {}} now={past} />);
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  });

  it("greys every Accept once `wanted` acceptances are in", () => {
    const offers = [anOffer("p2", { accepted: true }), anOffer("p3")];
    const others = [me, helper, { ...helper, id: "p3", name: "Other" }];
    const open = lobbyState({ participants: others, requests: { r1: request({ wanted: 2, offers }) } });
    const { rerender } = render(<RequestsPanel state={open} session={session()} onError={() => {}} now={NOW} />);
    expect((screen.getByRole("button", { name: "accept Other" }) as HTMLButtonElement).disabled).toBe(false);
    const full = lobbyState({ participants: others, requests: { r1: request({ wanted: 1, offers }) } });
    rerender(<RequestsPanel state={full} session={session()} onError={() => {}} now={NOW} />);
    expect((screen.getByRole("button", { name: "accept Other" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Accept sends deadlineMs, 3600000 unless the requester changes it", async () => {
    const sn = session();
    render(<RequestsPanel state={lobbyState({ requests: { r1: request({ offers: [anOffer("p2")] }) } })} session={sn} onError={() => {}} now={NOW} />);
    const deadline = screen.getByLabelText("Deadline (minutes)") as HTMLInputElement;
    expect(deadline.value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "accept Helper" }));
    await Promise.resolve();
    expect(sn.accept).toHaveBeenLastCalledWith("r1", ["p2"], 3_600_000);
    fireEvent.input(deadline, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "accept Helper" }));
    await Promise.resolve();
    expect(sn.accept).toHaveBeenLastCalledWith("r1", ["p2"], 1_800_000);
    // Fractional minutes send whole milliseconds: core takes an integer deadlineMs only.
    fireEvent.input(deadline, { target: { value: "1.00001" } });
    fireEvent.click(screen.getByRole("button", { name: "accept Helper" }));
    await Promise.resolve();
    expect(sn.accept).toHaveBeenLastCalledWith("r1", ["p2"], 60_001);
  });

  it("the Offer form is offered before expiresAt, and not at or after it", () => {
    // PR #32 round 3, F2. A working request with a standing offer from p3 and this browser (Helper, p2)
    // eligible with a profile and no offer of its own; only the clock differs between the renders.
    const expiresAt = "2026-09-16T14:00:00.000Z";
    const at = Date.parse(expiresAt);
    const working = request({ status: "working", wanted: 2, eligible: ["p2", "p3"], expiresAt, offers: [anOffer("p3")] });
    const st = asHelper({ requests: { r1: working } });
    const { rerender } = render(<RequestsPanel state={st} session={session()} onError={() => {}} now={at - 1} />);
    expect(screen.getByLabelText("Model")).toBeTruthy();
    rerender(<RequestsPanel state={st} session={session()} onError={() => {}} now={at} />);
    expect(screen.queryByLabelText("Model")).toBeNull();
    rerender(<RequestsPanel state={st} session={session()} onError={() => {}} now={at + 1} />);
    expect(screen.queryByLabelText("Model")).toBeNull();
    // The requester's Accept for the standing offer does not follow the window (spec 6.2).
    const asRequester = lobbyState({ me: { participant: me, token: "t" }, participants: [me, helper, { ...helper, id: "p3", name: "Other" }], requests: { r1: working } });
    rerender(<RequestsPanel state={asRequester} session={session()} onError={() => {}} now={at + 1} />);
    expect(screen.getByRole("button", { name: "accept Other" })).toBeTruthy();
  });

  it("the panel shows a working request's acceptances with due, completed, removed and overdue", () => {
    const acc = (participantId: string, over: Partial<Acceptance> = {}): Acceptance => ({
      participantId, dueAt: "2026-09-16T14:30:00.000Z", completedAt: null, note: null, removed: false, removedAt: null,
      overdue: false, overdueNotifiedAt: null, lastSeenAt: null, ...over,
    });
    const cast = [me, helper, { ...helper, id: "p3", name: "Other" }, { ...helper, id: "p4", name: "Fourth" }, { ...helper, id: "p5", name: "Fifth" }];
    const working = request({
      status: "working", wanted: 4, offers: ["p2", "p3", "p4", "p5"].map((p) => anOffer(p, { accepted: true })),
      acceptances: [
        acc("p2", { completedAt: "2026-09-16T13:20:00.000Z" }),
        acc("p3", { removed: true, removedAt: "2026-09-16T13:25:00.000Z" }),
        acc("p4", { dueAt: "2026-09-16T13:00:00.000Z" }),                // past NOW: overdue from the clock alone
        acc("p5"),
      ],
    });
    const { container } = render(<RequestsPanel state={lobbyState({ participants: cast, requests: { r1: working } })} session={session()} onError={() => {}} now={NOW} />);
    expect([...container.querySelectorAll(".acceptance")].map((li) => li.textContent)).toEqual([
      "Helper due 2026-09-16T14:30:00.000Z completed",
      "Other due 2026-09-16T14:30:00.000Z removed",
      "Fourth due 2026-09-16T13:00:00.000Z overdue",
      "Fifth due 2026-09-16T14:30:00.000Z working",
    ]);
    expect(container.querySelectorAll(".request-list > li")).toHaveLength(1);    // working is live, not closed
  });

  it("shows Cancel to the requester and to nobody else", () => {
    const sn = session();
    const { rerender } = render(<RequestsPanel state={lobbyState()} session={sn} onError={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sn.cancel).toHaveBeenCalledWith("r1");
    rerender(<RequestsPanel state={asHelper()} session={sn} onError={() => {}} now={NOW} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("offers the Offer form only to an eligible participant with a profile in this browser", () => {
    const { rerender } = render(<RequestsPanel state={asHelper()} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.getByLabelText("Model")).toBeTruthy();
    // Eligible, but this browser holds no profile for it: nothing to offer with.
    rerender(<RequestsPanel state={asHelper({ me: { participant: { ...helper, capabilities: null }, token: "t" } })} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.queryByLabelText("Model")).toBeNull();
    // A profile, but not among the listeners the request was addressed to.
    rerender(<RequestsPanel state={asHelper({ requests: { r1: request({ eligible: ["p9"] }) } })} session={session()} onError={() => {}} now={NOW} />);
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("offers only the models the profile in this browser declares, and sends the chosen one with the note", async () => {
    const sn = session();
    render(<RequestsPanel state={asHelper()} session={sn} onError={() => {}} now={NOW} />);
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["gpt-5.6-sol/high", "gpt-5.6-sol/low"]);
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.input(screen.getByPlaceholderText("Note (optional)"), { target: { value: "can start now" } });
    fireEvent.submit(select.closest("form")!);
    await Promise.resolve();
    expect(sn.offer).toHaveBeenCalledWith("r1", { model: "gpt-5.6-sol", effort: "low", note: "can start now" });
  });

  it("opens a request with the picked target Weave's own token as the target credential", async () => {
    const sn = session({ targets: vi.fn(async () => [{ weaveId: "w2", title: "Loom session", token: "target-token", threads: [{ id: "t2", name: "PR 14" }] }]) });
    render(<RequestsPanel state={lobbyState()} session={sn} onError={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Open a request" }));
    await screen.findByLabelText("Target Weave");
    fireEvent.input(screen.getByPlaceholderText("What do you need?"), { target: { value: "Review PR 15" } });
    fireEvent.input(screen.getByPlaceholderText("Model"), { target: { value: "claude-fable-5-1" } });
    fireEvent.input(screen.getByPlaceholderText("Effort"), { target: { value: "high" } });
    fireEvent.input(screen.getByPlaceholderText("Tools, comma separated"), { target: { value: "github, npm" } });
    fireEvent.submit(screen.getByPlaceholderText("What do you need?").closest("form")!);
    await Promise.resolve();
    expect(sn.openRequest).toHaveBeenCalledWith({
      title: "Review PR 15", requirements: { models: [{ model: "claude-fable-5-1", effort: "high" }], tools: ["github", "npm"] },
      wanted: 1, timeoutMs: 3_600_000, targetWeaveId: "w2", targetThreadId: "t2", targetCredential: "target-token",
    });
  });
});

/**
 * The Offer form on the Lobby's own routes (spec §3.3). What gates it is `me.capabilities`, and
 * `getWeave` carries none any more: the session reads the profile beside the page, with `me`'s own
 * token rather than with the page's reader. That is a rule about the *session*, so these mount the
 * real one over a stubbed instance instead of handing a state object in — on `/w/<lobby secret>`,
 * where the page reader owns no participant row at all, most of all.
 */
describe("the Offer form on the Lobby's routes (spec §3.3)", () => {
  const BASE = "https://loom.test";                 // http is refused off loopback by the client's own URL policy
  const LOBBY_ID = "11111111-1111-4111-8111-111111111111";
  const SECRET = "s".repeat(43);
  const ME = { id: "p-me", weaveId: LOBBY_ID, name: "dana", kind: "agent" as const, role: "member" as const,
    joinedAt: "", agentId: null, capabilities: null, lastSeenAt: null };
  const REQUESTER = { ...ME, id: "p-other", name: "Paw", kind: "human" as const };
  const MY_PROFILE = `${BASE}/api/lobby/participants/me`;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  type Routes = Record<string, (url: URL) => Response>;
  /** Everything a Lobby page reads, the two side reads included; an unstubbed path is a test bug. */
  const lobby = (over: Routes = {}): Routes => ({
    [`${BASE}/api/lobby`]: () => json({ weaveId: LOBBY_ID, title: "Lobby" }),
    [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: LOBBY_ID }),
    [`${BASE}/api/weaves/${LOBBY_ID}/events`]: () => json({ events: [] }),
    [`${BASE}/api/weaves/${LOBBY_ID}`]: () => json({
      weave: { id: LOBBY_ID, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
      threads: [general, reqThread], participants: [ME, REQUESTER],
    }),
    [`${BASE}/api/guidelines`]: () => json({ guidelines: "" }),
    [`${BASE}/api/requests`]: (url) => json({ requests: url.searchParams.get("status") === "open" ? [open] : [] }),
    // The stream is deliberately fatal here: a forbidden ticket leaves no socket and no reconnect
    // timer behind, so nothing of this page outlives the test that mounted it.
    [`${BASE}/api/auth/ws-ticket`]: () => json({ code: "forbidden", message: "no stream in tests" }, 403),
    [`${BASE}/api/lobby/listeners`]: () => json({ total: 1, matched: 1, listeners: [] }),
    [MY_PROFILE]: () => json({ ...ME, capabilities: PROFILE }),
    ...over,
  });
  /** An open request this browser is eligible for, with long enough left to be offered on. */
  const open = request({ requesterId: REQUESTER.id, eligible: [ME.id], expiresAt: "2099-01-01T00:00:00.000Z" });

  /** What a browser that has joined the Lobby holds: the identity, and the link beside it. */
  const joined = (): KeyValueStorage => {
    const storage = memoryStorage();
    setIdentity(storage, LOBBY_ID, { token: "participant-token", participantId: ME.id, name: "dana" }, { secret: SECRET });
    return storage;
  };

  function mount(path: string, routes: Routes) {
    history.replaceState(null, "", path);
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const route = routes[`${url.origin}${url.pathname}`];
      if (!route) throw new Error(`no stub for ${url.pathname}`);
      return route(url);
    });
    const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
    return render(<App client={client} storage={joined()} notice={createPersistenceNotice()} weaves={createWeavesSignal()} />);
  }

  /** Several macrotask turns: the lookup, the backfill, the metadata, the board and the side reads. */
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

  for (const [label, path] of [["opened by its secret link", `/w/${SECRET}`], ["on /lobby", "/lobby"]] as const) {
    it(`offers the form to an eligible listener on the Lobby ${label}`, async () => {
      mount(path, lobby());
      await settle();
      expect(screen.getByLabelText("Model")).toBeTruthy();
    });

    it(`offers none to a participant that has declared no profile, ${label}`, async () => {
      mount(path, lobby({ [MY_PROFILE]: () => json({ ...ME, capabilities: null }) }));
      await settle();
      expect(screen.queryByLabelText("Model")).toBeNull();
    });
  }

  // The identity is dead but the page is reading perfectly well with the link, so the Weave stays
  // on screen and the way back is a join (spec §3.3, the sibling rule).
  it("loses the form, and says the identity is no longer valid, when that read is refused", async () => {
    const { container } = mount(`/w/${SECRET}`,
      lobby({ [MY_PROFILE]: () => json({ code: "invalid_token", message: "Credential is not valid" }, 401) }));
    await settle();
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
    // Still the Weave, read with the link: the thread list and the board are where they were.
    expect([!!container.querySelector(".threads"), !!container.querySelector(".request-list")]).toEqual([true, true]);
  });
});

describe("ProfileCard", () => {
  it("shows the models, tools, runtime, owner and serving policy", () => {
    const { container } = render(<ProfileCard participant={helper} />);
    expect(screen.getByText("Helper")).toBeTruthy();
    expect(container.querySelector(".profile-models")!.textContent).toBe("gpt-5.6-sol/high, gpt-5.6-sol/low");
    expect(container.querySelector(".profile-tools")!.textContent).toBe("github");
    expect(container.querySelector(".profile-runtime")!.textContent).toBe("codex");
    expect(container.querySelector(".profile-owner")!.textContent).toBe("bob");
    expect(container.querySelector(".profile-serves")!.textContent).toBe("anyone");
  });

  it("renders nothing for a participant with no profile", () => {
    const { container } = render(<ProfileCard participant={bot} />);
    expect(container.innerHTML).toBe("");
  });

  it("ProfileCard shows 'seen N min ago' from lastSeenAt, and 'never seen' for null, under profile-seen", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    const { container, rerender } = render(<ProfileCard participant={{ ...helper, lastSeenAt: "2026-09-23T11:55:00.000Z" }} now={now} />);
    expect(container.querySelector(".profile-seen")!.textContent).toBe("seen 5 min ago");
    rerender(<ProfileCard participant={{ ...helper, lastSeenAt: null }} now={now} />);
    expect(container.querySelector(".profile-seen")!.textContent).toBe("never seen");
  });
});

describe("routeOf (spec §3.1)", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";
  const SECRET = "s".repeat(43);
  for (const [path, route] of [
    ["/", { kind: "main" }],
    ["/lobby", { kind: "lobby" }],
    ["/lobby/", { kind: "lobby" }],
    [`/weave/${UUID}`, { kind: "weave", weaveId: UUID }],
    [`/weave/${UUID}/`, { kind: "weave", weaveId: UUID }],
    [`/w/${SECRET}`, { kind: "secret", secret: SECRET }],
    [`/w/${SECRET}/`, { kind: "secret", secret: SECRET }],
    // Near misses: each of these is a path the server does not serve `index.html` for either.
    ["/weave", { kind: "unknown" }],
    ["/weave/a/b", { kind: "unknown" }],
    ["/weave/nope", { kind: "unknown" }],
    ["/lobbyx", { kind: "unknown" }],
    [`/w/${"s".repeat(42)}`, { kind: "unknown" }],
    [`/w/${"s".repeat(44)}`, { kind: "unknown" }],
    ["/x", { kind: "unknown" }],
  ] as const) {
    it(`reads ${path} as ${route.kind}`, () => {
      expect(routeOf(path)).toEqual(route);
    });
  }
});

describe("WeaveView (spec §2.6, §2.7, §3.3)", () => {
  const noCredentialState = (over: Partial<SessionState> = {}) =>
    state({ status: "no-credential", weave: undefined, me: undefined, connection: "closed", ...over });
  const readOnly = (over: Partial<SessionState> = {}) =>
    state({ readOnlyReason: "secret-fallback", me: undefined, ...over });

  it("renders the Weave for a ready session with an identity, exactly as the page did before", () => {
    const { container } = render(<WeaveView session={session()} state={state()} />);
    expect([container.querySelector(".header-right strong")?.textContent, !!container.querySelector(".composer"),
      !!container.querySelector(".banner")]).toEqual(["Paw", true, false]);
  });

  it("renders the banner above the Weave", () => {
    const { container } = render(<WeaveView session={session()} state={state()} banner={<div class="bar">note</div>} />);
    expect(container.querySelector(".layout")!.firstElementChild!.className).toBe("bar");
  });

  it("explains that this browser holds no key for the Weave", () => {
    render(<WeaveView session={session()} state={noCredentialState()} />);
    expect(screen.getByText("This browser holds no key for this Weave.")).toBeTruthy();
  });

  it("offers a way back to the main page from that explanation", () => {
    render(<WeaveView session={session()} state={noCredentialState()} />);
    expect(screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")).toBe("/");
  });

  it("offers no composer on a page this browser has no credential for", () => {
    const { container } = render(<WeaveView session={session()} state={noCredentialState()} />);
    expect(container.querySelector(".composer")).toBeNull();
  });

  it("says so when the identity that used to work is the reason there is no credential", () => {
    const st = noCredentialState({ error: "Your identity in this Weave is no longer valid" });
    render(<WeaveView session={session()} state={st} />);
    expect(screen.getByText("Your identity in this Weave is no longer valid")).toBeTruthy();
  });

  it("renders the caller's own element instead of the explanation on that branch", () => {
    render(<WeaveView session={session()} state={noCredentialState()} noCredential={<p>Join the Lobby here</p>} />);
    expect([screen.getByText("Join the Lobby here").tagName, screen.queryByText("This browser holds no key for this Weave.")])
      .toEqual(["P", null]);
  });

  it("says why a page read with the Weave link is read-only, and offers a Join", () => {
    const { container } = render(<WeaveView session={session()} state={readOnly()} />);
    expect(container.querySelector(".banner")!.textContent).toContain(
      "Your identity in this Weave is no longer valid — you are reading with the Weave link.");
    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
  });

  it("offers no composer on that page until the join", () => {
    const { container } = render(<WeaveView session={session()} state={readOnly()} />);
    expect(container.querySelector(".composer")).toBeNull();
  });

  it("opens the name prompt from that Join button", () => {
    render(<WeaveView session={session()} state={readOnly()} />);
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(screen.getByText("Choose a name")).toBeTruthy();
  });

  // The §6 bar is the caller's banner, and every state this view can return is a state the bar may
  // have to be seen in — a no-credential page whose invalidation only reached memory most of all.
  for (const [label, st] of [
    ["no-credential", noCredentialState()],
    ["loading", state({ status: "loading", weave: undefined, me: undefined })],
    ["error", state({ status: "error", error: "boom", weave: undefined, me: undefined })],
    ["ready", state()],
  ] as const) {
    it(`renders the banner on the ${label} page, exactly once`, () => {
      const { container } = render(<WeaveView session={session()} state={st} banner={<div class="bar">note</div>} />);
      expect(container.querySelectorAll(".bar").length).toBe(1);
    });
  }

  it("renders the banner above the caller's own no-credential element too", () => {
    const { container } = render(<WeaveView session={session()} state={noCredentialState()}
      banner={<div class="bar">note</div>} noCredential={<p>Join the Lobby here</p>} />);
    expect([container.firstElementChild!.className, container.querySelectorAll(".bar").length]).toEqual(["bar", 1]);
  });
});

/** The three-column shell around the Thread: the thread header, the details panel and the sidebar footer. */
describe("the Weave page shell", () => {
  const panel = () => screen.queryByRole("complementary", { name: "Thread details" });
  const toggle = () => screen.getByRole("button", { name: "Thread details" });

  it("draws the details panel closed below 1200px, and its toggle opens and closes it", () => {
    render(<WeaveView session={session()} state={state()} />);
    const closed = [toggle().getAttribute("aria-expanded"), panel()];
    fireEvent.click(toggle());
    const open = [toggle().getAttribute("aria-expanded"), !!panel()];
    fireEvent.click(toggle());
    expect([closed, open, [toggle().getAttribute("aria-expanded"), panel()]])
      .toEqual([["false", null], ["true", true], ["false", null]]);
  });

  it("opens the details panel by default at 1200px and wider", () => {
    const wide = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("1200px"), media: q } as MediaQueryList));
    try {
      render(<WeaveView session={session()} state={state()} />);
      expect([toggle().getAttribute("aria-expanded"), !!panel()]).toEqual(["true", true]);
    } finally { wide.mockRestore(); }
  });

  it("puts the invite buttons and the link form in the open panel, not in the sidebar", () => {
    const { container } = render(<WeaveView session={session()} state={state({ currentThreadId: "t1" })} />);
    const before = screen.queryAllByRole("button", { name: /^invite /i }).length;
    fireEvent.click(toggle());
    expect([before, screen.getAllByRole("button", { name: /^invite /i }).length, !!panel()!.querySelector("form.url-form"),
      !!container.querySelector(".sidebar form.url-form")]).toEqual([0, 1, true, false]);
  });

  it("starts with Fold system events on", () => {
    render(<WeaveView session={session()} state={state()} />);
    const box = screen.getByRole("checkbox", { name: "Fold system events" }) as HTMLInputElement;
    const was = box.checked;
    fireEvent.click(box);
    expect([was, box.checked]).toEqual([true, false]);
  });

  it("folds the stream while the checkbox is on, and unfolds it when it is turned off", () => {
    const joined = (seq: number) => ({ weaveId: "w1", seq, threadId: "g1", type: "participant.joined" as const, actor: "p2",
      at: "2026-09-24T13:07:09.000Z", payload: { participantId: "p2" } });
    const { container } = render(<WeaveView session={session()} state={state({ events: [joined(1), joined(2)] })} />);
    const folded = container.querySelectorAll(".messages .sysrow").length;
    fireEvent.click(screen.getByRole("checkbox", { name: "Fold system events" }));
    expect([folded, container.querySelectorAll(".messages .sysrow").length]).toEqual([1, 2]);
  });

  it("has one main landmark, the center column, holding the thread header, the stream and the composer", () => {
    const { container } = render(<WeaveView session={session()} state={state()} />);
    const mains = container.querySelectorAll("main");
    expect([mains.length, ...[".thread-header", ".messages", ".composer"].map((c) => !!mains[0]?.querySelector(c))])
      .toEqual([1, true, true, true]);
  });

  it("draws neither the thread header nor the details panel while the listeners directory is the main area", () => {
    const wide = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: true, media: q } as MediaQueryList));
    try {
      render(<WeaveView session={session()} state={lobbyState()} view="listeners" />);
      expect([screen.queryByRole("button", { name: "Thread details" }), panel(),
        screen.queryByRole("checkbox", { name: "Fold system events" })]).toEqual([null, null, null]);
    } finally { wide.mockRestore(); }
  });

  it("closes the sidebar with a footer line naming the Weave and its thread count", () => {
    const { container } = render(<WeaveView session={session()} state={state()} />);
    expect(container.querySelector(".sidebar-foot")!.textContent).toBe("Weave W · 2 threads");
  });

  it("adds the listener count to that line on the Lobby once it is known", () => {
    const { container } = render(<WeaveView session={session()} state={lobbyState({ listenerCount: 62 })} />);
    const known = container.querySelector(".sidebar-foot")!.textContent;
    render(<WeaveView session={session()} state={lobbyState()} />);
    expect([known, document.querySelectorAll(".sidebar-foot")[1]!.textContent])
      .toEqual(["Weave W · 2 threads · 62 listeners", "Weave W · 2 threads"]);
  });

  it("orders the Lobby sidebar Threads, Listeners, Requests, Guidelines", () => {
    const { container } = render(<WeaveView session={session()} state={lobbyState({ listenerCount: 3 })} />);
    const labels = [...container.querySelectorAll(".sidebar .sec")].map((e) => e.textContent);
    expect(labels).toEqual(["Threads", "Listeners", "Requests", "Guidelines"]);
  });
});

/**
 * The header's own way back to `/` (spec §3.1). Which element it is, is the whole rule: an anchor
 * can be middle-clicked or opened in a new tab, and both are the full page load that would drop a
 * session living only in this JS context. The route decides which case this is and hands the
 * in-place switch down; this view only renders what it was given.
 */
describe("the way back to the main page from a Weave page (spec §3.1)", () => {
  const noCredentialState = () => state({ status: "no-credential", weave: undefined, me: undefined, connection: "closed" });

  it("is an ordinary link to / when leaving this JS context costs nothing", () => {
    render(<WeaveView session={session()} state={state()} />);
    expect(screen.getByRole("link", { name: "Loom" }).getAttribute("href")).toBe("/");
  });

  it("is a button with no href when the session lives only in this page's memory", () => {
    render(<WeaveView session={session()} state={state()} openMainInPlace={() => {}} />);
    expect([screen.queryByRole("link", { name: "Loom" }),
      screen.getByRole("button", { name: "Loom" }).getAttribute("href")]).toEqual([null, null]);
  });

  it("switches the view in place from that button instead of navigating", () => {
    const openMainInPlace = vi.fn();
    render(<WeaveView session={session()} state={state()} openMainInPlace={openMainInPlace} />);
    fireEvent.click(screen.getByRole("button", { name: "Loom" }));
    expect(openMainInPlace.mock.calls).toEqual([[]]);
  });

  // The header is only on the *loaded* page, and the screens that replace it are exactly the ones a
  // browser refusing to store anything is most likely to end on: a §2.6 invalidation whose write
  // reached only memory ends at `no-credential`. Their "Go to the main page" link follows the same
  // rule as the wordmark, or the exception would have a hole where it matters most.
  const errorState = () => state({ status: "error", error: "boom", weave: undefined, me: undefined });

  it("offers the way back from the no-credential screen in place too", () => {
    const openMainInPlace = vi.fn();
    render(<WeaveView session={session()} state={noCredentialState()} openMainInPlace={openMainInPlace} />);
    const back = screen.getByRole("button", { name: "Go to the main page" });
    fireEvent.click(back);
    expect([back.getAttribute("href"), screen.queryByRole("link", { name: "Go to the main page" }),
      openMainInPlace.mock.calls]).toEqual([null, null, [[]]]);
  });

  it("offers a way back from the error card, which had none at all", () => {
    render(<WeaveView session={session()} state={errorState()} />);
    expect(screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")).toBe("/");
  });

  it("offers that one in place as well when leaving is not safe", () => {
    render(<WeaveView session={session()} state={errorState()} openMainInPlace={() => {}} />);
    expect([screen.queryByRole("link", { name: "Go to the main page" }),
      !!screen.queryByRole("button", { name: "Go to the main page" })]).toEqual([null, true]);
  });

  // Deliberate, and documented: a page still resolving what it is has nothing to say about itself
  // yet, and the wait is short. Every other state offers a way back.
  it("offers no way back while the page is still loading", () => {
    render(<WeaveView session={session()} state={state({ status: "loading", weave: undefined, me: undefined })}
      openMainInPlace={() => {}} />);
    expect(screen.queryByText("Go to the main page")).toBeNull();
  });
});

describe("GuidelinesPanel", () => {
  const keeperMe = { ...me, role: "keeper" as const };
  const keeperState = (over: Partial<SessionState> = {}) =>
    state({ me: { participant: keeperMe, token: "t" }, ...over });

  it("counts against the same limit core enforces", () => {
    // The counter and the Save gate are the only warning a keeper gets before the server refuses
    // the text; a literal here would drift silently the day core raises or lowers the limit.
    expect(GUIDELINES_MAX).toBe(MAX_GUIDELINES_LENGTH);
  });

  it("renders the Weave text as Markdown and offers no Edit button to a member", () => {
    render(<GuidelinesPanel state={state({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "Be **kind**" } })}
      session={session()} onError={() => {}} />);
    expect(screen.getByText("kind").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("shows the instance text collapsed under 'What agents are told', and nothing when there is none", () => {
    const { container, rerender } = render(<GuidelinesPanel state={state({ instanceGuidelines: "House **rules**" })} session={session()} onError={() => {}} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("What agents are told");
    expect(details.querySelector("strong")!.textContent).toBe("rules");
    rerender(<GuidelinesPanel state={state()} session={session()} onError={() => {}} />);
    expect(container.querySelector("details")).toBeNull();
  });

  it("says so when the Weave has no guidelines", () => {
    render(<GuidelinesPanel state={state()} session={session()} onError={() => {}} />);
    expect(screen.getByText("No Weave guidelines yet.")).toBeTruthy();
  });

  it("a keeper edits: prefilled textarea, live counter, Save disabled when unchanged, and the trimmed text is saved", async () => {
    const s = session({ canModerate: () => true });
    render(<GuidelinesPanel state={keeperState({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "Rules" } })}
      session={s} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Weave guidelines") as HTMLTextAreaElement;
    expect(box.value).toBe("Rules");
    expect(screen.getByText("5 / 4000")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(box, { target: { value: "  Be kind  " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(box.closest("form")!);
    await Promise.resolve();
    expect(s.setGuidelines).toHaveBeenCalledWith("Be kind");
  });

  it("marks the counter over the limit and disables Save past 4000 characters", () => {
    const s = session({ canModerate: () => true });
    render(<GuidelinesPanel state={keeperState()} session={s} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Weave guidelines") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "x".repeat(4001) } });
    const counter = screen.getByText("4001 / 4000");
    expect(counter.className).toContain("over");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(box, { target: { value: "x".repeat(4000) } });
    expect(screen.getByText("4000 / 4000").className).not.toContain("over");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not refuse 4000 characters followed by whitespace, since the trimmed text is what is sent", async () => {
    // The gate has to judge the value that travels: the panel sends `draft.trim()` and core
    // measures the trimmed text too, so trailing newlines must not disable a Save the server
    // would accept. The counter still counts what the textarea shows.
    const s = session({ canModerate: () => true });
    render(<GuidelinesPanel state={keeperState()} session={s} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Weave guidelines") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: `${"x".repeat(4000)}\n\n` } });
    const counter = screen.getByText("4002 / 4000");
    expect(counter.className).not.toContain("over");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(box.closest("form")!);
    await Promise.resolve();
    expect(s.setGuidelines).toHaveBeenCalledWith("x".repeat(4000));
  });

  it("offers no Edit button on an archived Weave", () => {
    render(<GuidelinesPanel state={keeperState({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: "2026-01-01T00:00:00.000Z", lastSeq: 3, guidelines: "Rules" } })}
      session={session({ canModerate: () => false })} onError={() => {}} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  for (const [label, lost] of [
    ["the Weave is archived", keeperState({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: "2026-01-01T00:00:00.000Z", lastSeq: 3, guidelines: "Rules" } })],
    ["this keeper is demoted", state({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "Rules" } })],
  ] as const) {
    it(`closes the open form and saves nothing when ${label} mid-edit`, () => {
      const s = session({ canModerate: () => true });
      const open = keeperState({ weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "Rules" } });
      const { rerender } = render(<GuidelinesPanel state={open} session={s} onError={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByLabelText("Weave guidelines")).toBeTruthy();
      const stale = session({ canModerate: () => false, setGuidelines: s.setGuidelines });
      rerender(<GuidelinesPanel state={lost} session={stale} onError={() => {}} />);
      expect(screen.queryByLabelText("Weave guidelines")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(screen.getByText("Rules")).toBeTruthy();
      expect(s.setGuidelines).not.toHaveBeenCalled();
    });
  }
});
