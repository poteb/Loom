// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { ThreadList } from "../src/components/ThreadList.js";
import { MessageList } from "../src/components/MessageList.js";
import { InviteBanner } from "../src/components/InviteBanner.js";
import type { Session, SessionState } from "../src/session.js";

const me = { id: "p1", weaveId: "w1", name: "Paw", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null };
const bot = { id: "p2", weaveId: "w1", name: "Bot", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: "a1" };
const general = { id: "g1", weaveId: "w1", name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null, url: null };
const pr = { id: "t1", weaveId: "w1", name: "PR 12", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: "https://github.com/poteb/Loom/pull/12" };

function state(over: Partial<SessionState> = {}): SessionState {
  return { status: "ready", weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "" }, threads: [general, pr], participants: [me, bot],
    events: [], me: { participant: me, token: "t" }, currentThreadId: "g1", connection: "open", needsName: false, invitesForMe: new Set(), invited: {},
    instanceGuidelines: "", ...over };
}
function session(over: Partial<Session> = {}): Session {
  return { getState: () => state(), subscribe: () => () => {}, load: async () => {}, join: async () => {}, selectThread: vi.fn(), post: async () => {},
    createThread: vi.fn(async () => {}), setThreadUrl: vi.fn(async () => {}), invite: vi.fn(async () => {}), closeThread: async () => {}, archive: async () => {}, setGuidelines: vi.fn(async () => {}),
    canModerate: () => false, canEditThread: (t) => t.createdBy === "p1", markSeen: () => {}, dismissNamePrompt: () => {}, dispose: () => {}, ...over };
}

describe("ThreadList", () => {
  it("shows a thread's url as a truncated link and highlights a thread with an unread invite", () => {
    render(<ThreadList state={state({ invitesForMe: new Set(["t1"]) })} session={session()} onError={() => {}} />);
    const link = screen.getByRole("link", { name: /github.com\/poteb\/Loom\/pull\/12/ });
    expect(link.getAttribute("href")).toBe(pr.url);
    expect(screen.getByText("PR 12").closest("li")!.className).toContain("invited");
    expect(screen.getByText(/invited/i)).toBeTruthy();
  });
  it("renders a non-http url as plain text, never as a link", () => {
    const evil = { ...pr, url: "javascript:alert(1)" };
    render(<ThreadList state={state({ threads: [general, evil] })} session={session()} onError={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
  });
  it("new-thread form sends the url; invite button only for creator/keeper and only for others", async () => {
    const s = session();
    render(<ThreadList state={state({ currentThreadId: "t1" })} session={s} onError={() => {}} />);
    fireEvent.click(screen.getByText("New thread"));
    fireEvent.input(screen.getByPlaceholderText("Thread name"), { target: { value: "PR 13" } });
    fireEvent.input(screen.getByPlaceholderText("Artefact URL (optional)"), { target: { value: "https://e.com/13" } });
    fireEvent.submit(screen.getByPlaceholderText("Thread name").closest("form")!);
    await Promise.resolve();
    expect(s.createThread).toHaveBeenCalledWith("PR 13", "https://e.com/13");
    const inviteButtons = screen.getAllByRole("button", { name: /^invite /i });
    expect(inviteButtons.map((b) => b.textContent)).toEqual(["invite Bot"]);   // not myself
    fireEvent.click(inviteButtons[0]!);
    expect(s.invite).toHaveBeenCalledWith("t1", "p2");
  });
  it("shows a check mark instead of the invite button for someone already invited; no invite controls for a plain member", () => {
    render(<ThreadList state={state({ currentThreadId: "t1", invited: { t1: new Set(["p2"]) } })} session={session()} onError={() => {}} />);
    expect(screen.queryByRole("button", { name: /^invite /i })).toBeNull();
    expect(screen.getByTitle("invited")).toBeTruthy();
    render(<ThreadList state={state({ currentThreadId: "t1" })} session={session({ canEditThread: () => false })} onError={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /^invite /i })).toHaveLength(0);
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
    render(<MessageList state={state({ currentThreadId: "t1", events })} />);
    expect(screen.getByText(/Bot invited by Paw/)).toBeTruthy();
    expect(screen.getByText(/now links to https:\/\/e.com\/x/)).toBeTruthy();
  });
});
