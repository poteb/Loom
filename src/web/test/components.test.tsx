// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { ThreadList } from "../src/components/ThreadList.js";
import { MessageList } from "../src/components/MessageList.js";
import { InviteBanner } from "../src/components/InviteBanner.js";
import { GuidelinesPanel, GUIDELINES_MAX } from "../src/components/GuidelinesPanel.js";
import { RequestsPanel } from "../src/components/RequestsPanel.js";
import { ProfileCard } from "../src/components/ProfileCard.js";
import { WeaveView } from "../src/components/WeaveView.js";
import { routeOf } from "../src/app.js";
import { MAX_GUIDELINES_LENGTH } from "@loom/core";
import type { Offer } from "@loom/client";
import { CLOSED_REQUESTS_PAGE, type Session, type SessionState } from "../src/session.js";
import type { VersionedRequest } from "../src/requests-state.js";

const me = { id: "p1", weaveId: "w1", name: "Paw", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null };
const bot = { id: "p2", weaveId: "w1", name: "Bot", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: "a1", capabilities: null };
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
    targets: vi.fn(async () => []), ...over };
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
    eligible: ["p2"], offers: [], version: 5, ...over };
}
const anOffer = (participantId: string, over: Partial<Offer> = {}): Offer =>
  ({ requestId: "r1", participantId, model: "gpt-5.6-sol", effort: "high", note: "ready", accepted: false, createdAt: "", ...over });

/** The Lobby page: `state.lobby` points at the Weave on screen. */
function lobbyState(over: Partial<SessionState> = {}): SessionState {
  return state({ lobby: { weaveId: "w1", title: "Lobby" }, threads: [general, reqThread], participants: [me, helper],
    requests: { r1: request() }, ...over });
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

  it("renders every request event as one system line in the request Thread", () => {
    const base = { weaveId: "w1", threadId: "th1", actor: "p1", at: new Date().toISOString() };
    const events = [
      { ...base, seq: 1, type: "request.opened" as const, payload: { requestId: "r1", requesterId: "p1", wanted: 2, expiresAt: "2026-09-16T14:00:00.000Z", owner: "paw", targetWeaveTitle: "Loom session", eligible: ["p2"] } },
      { ...base, seq: 2, type: "request.offered" as const, actor: "p2", payload: { requestId: "r1", participantId: "p2", model: "gpt-5.6-sol", effort: "high", note: "ready", to: "p1" } },
      { ...base, seq: 3, type: "request.accepted" as const, payload: { requestId: "r1", requesterId: "p1", participantIds: ["p2"], targetWeaveTitle: "Loom session" } },
      { ...base, seq: 4, type: "weave.invited" as const, payload: { invitationId: "i1", participantId: "p2", targetWeaveTitle: "Loom session" } },
      { ...base, seq: 5, type: "request.closed" as const, payload: { requestId: "r1", requesterId: "p1", to: ["p1"], reason: "filled", accepted: ["p2"] } },
    ];
    const { container } = render(<MessageList state={lobbyState({ currentThreadId: "th1", events })} />);
    expect(container.querySelectorAll(".system")).toHaveLength(5);
    expect(screen.getByText(/request "Review PR 14" opened by Paw: wants 2/)).toBeTruthy();
    expect(screen.getByText(/Helper offered \(gpt-5\.6-sol\/high\): "ready"/)).toBeTruthy();
    expect(screen.getByText(/Helper accepted for "Loom session"/)).toBeTruthy();
    expect(screen.getByText(/Helper invited to "Loom session"/)).toBeTruthy();
    expect(screen.getByText(/request filled: accepted Helper/)).toBeTruthy();
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

  it("accepts an offer through the session", async () => {
    const sn = session();
    render(<RequestsPanel state={lobbyState({ requests: { r1: request({ offers: [anOffer("p2")] }) } })} session={sn} onError={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "accept Helper" }));
    await Promise.resolve();
    expect(sn.accept).toHaveBeenCalledWith("r1", ["p2"]);
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
