// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { ThreadList } from "../src/components/ThreadList.js";
import { MessageList } from "../src/components/MessageList.js";
import { InviteBanner } from "../src/components/InviteBanner.js";
import { GuidelinesPanel, GUIDELINES_MAX } from "../src/components/GuidelinesPanel.js";
import { MAX_GUIDELINES_LENGTH } from "@loom/core";
import type { Session, SessionState } from "../src/session.js";

const me = { id: "p1", weaveId: "w1", name: "Paw", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null };
const bot = { id: "p2", weaveId: "w1", name: "Bot", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: "a1", capabilities: null };
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
  it("is a navigation landmark, not a second complementary one inside the sidebar aside", () => {
    // app.tsx wraps this in <aside class="sidebar">; an <aside> here would nest two
    // complementary landmarks, and a screen reader announces the inner one as unnamed context.
    const { container } = render(<ThreadList state={state()} session={session()} onError={() => {}} />);
    expect(container.querySelector(".threads")!.tagName).toBe("NAV");
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

  it("names the actor and renders the new text beneath a guidelines change, and says cleared for an empty one", () => {
    const change = { weaveId: "w1", seq: 3, threadId: "t1", type: "weave.guidelines_changed" as const, actor: "p1",
      at: new Date().toISOString(), payload: { guidelines: "Be **kind**", previous: "" } };
    const { container, rerender } = render(<MessageList state={state({ currentThreadId: "t1", events: [change] })} />);
    expect(screen.getByText(/Paw changed the Weave guidelines/)).toBeTruthy();
    expect(container.querySelector(".system-body strong")!.textContent).toBe("kind");
    const cleared = { ...change, seq: 4, payload: { guidelines: "", previous: "Be **kind**" } };
    rerender(<MessageList state={state({ currentThreadId: "t1", events: [cleared] })} />);
    expect(screen.getByText(/Paw cleared the Weave guidelines/)).toBeTruthy();
    expect(container.querySelector(".system-body")).toBeNull();
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
