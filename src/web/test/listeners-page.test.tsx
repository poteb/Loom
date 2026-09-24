// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/preact";
import { LoomClient, type Listener, type ListenersPage } from "@loom/client";
import { App, routeOf } from "../src/app.js";
import { ListenersLink } from "../src/components/ListenersLink.js";
import type { SessionState } from "../src/session.js";
import { memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice, type PersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";
import { readWeaveEntry, setIdentity, weaveKey } from "../src/weaves-store.js";

// `http://loom.test` is refused by the client's own URL policy (http is allowed on loopback only,
// `src/client/src/url.ts`), so the stubbed instance speaks https to the same host: no request leaves
// the process either way.
const BASE = "https://loom.test";
const LOBBY = { weaveId: "11111111-1111-4111-8111-111111111111", title: "Lobby" };
const LOBBY_URL = `${BASE}/api/lobby`;
const JOIN = `${BASE}/api/lobby/join`;
/** The listeners route. Stubs match on the **path**: every query the page makes is this path with a
 *  different query string, and what each one asked for is asserted on its own (`queries()`). */
const LISTENERS = `${BASE}/api/lobby/listeners`;
/** The session's own count read (spec §5.1) shares this path with the directory's query and is told
 *  apart by `limit=0`. It gets a row of its own in the table, so an ordinary `[LISTENERS]` row still
 *  means "what the directory is answered with" and every `inTurn` script keeps its call numbering. */
const COUNT = `${LISTENERS}?limit=0`;
const LISTENERS_PATH = new URL(LISTENERS).pathname;
const isCount = (url: URL) => url.pathname === LISTENERS_PATH && url.searchParams.get("limit") === "0";
/** The three paths the no-remount test counts, and the two `POST`s the Lobby page can make. */
const WEAVE = `${BASE}/api/weaves/${LOBBY.weaveId}`;
const EVENTS = `${WEAVE}/events`;
const TICKET = `${BASE}/api/auth/ws-ticket`;
/** `POST` only, and no row of its own in `INSTANCE`: creating a Thread is something four tests do
 *  deliberately, each with the answer its own rule needs. */
const THREADS = `${WEAVE}/threads`;
/** The send. `postMessage` answers with the event it made, which the session applies through
 *  `onEvent` — the row cannot echo the posted text (a stub row sees the URL, not the body), and it
 *  does not have to: what these tests assert is the **request**, read off `fetchStub.mock.calls`. */
const MESSAGES = `${BASE}/api/threads/g1/messages`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (code: string, message: string, status: number) => () => json({ code, message }, status);

/** The `JoinResult` a successful `POST /api/lobby/join` answers with. */
const JOINED = {
  weaveId: LOBBY.weaveId,
  weave: { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
  generalThreadId: "g1",
  participant: { id: "p-dana", weaveId: LOBBY.weaveId, name: "dana", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null, lastSeenAt: null },
  token: "participant-token",
  guidelines: "",
};

const listener = (name: string, owner: string): Listener => ({
  participant: { ...JOINED.participant, kind: "agent" as const, id: `p-${name}`, name },
  capabilities: { owner, models: [{ model: "opus-5", effort: "high" }], tools: ["shell"], runtime: "node" },
});

/** A `ListenersPage` with its facets, as the route answers one. */
function directory(listeners: Listener[] = [], over: Partial<ListenersPage> = {}): ListenersPage {
  return {
    total: listeners.length, matched: listeners.length, listeners,
    facets: {
      models: { values: [{ model: "opus-5", count: listeners.length, efforts: [], moreEfforts: false }], more: false },
      tools: { values: [{ value: "shell", count: listeners.length }], more: false },
      runtimes: { values: [{ value: "node", count: listeners.length }], more: false },
      serves: { values: [{ value: "anyone", count: 0 }, { value: "owner", count: listeners.length }, { value: "list", count: 0 }], more: false },
    },
    ...over,
  };
}

/** The `General` thread the Lobby's Weave carries. Its id is `g1`, because the send posts to its path. */
const GENERAL = { id: "g1", weaveId: LOBBY.weaveId, name: "General", isGeneral: true, createdBy: "p-dana", createdAt: "", closedAt: null, url: null };
/** A second Thread, for the one test that needs a switch: a switch cannot be made against a list of one. */
const DESIGN = { ...GENERAL, id: "t2", name: "Design", isGeneral: false };
/**
 * What `getWeave` answers for the Lobby: the shape it really uses now, with no profile per
 * participant at all (spec §3.1), which is why the sidebar counts instead. Two tests override it —
 * one needs a second Thread, one needs this browser to be a keeper.
 */
const weaveBody = (over: Record<string, unknown> = {}) => ({
  weave: { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
  threads: [GENERAL],
  participants: [JOINED.participant],
  ...over,
});

type Routes = Record<string, (url: URL) => Response | Promise<Response>>;

/**
 * Every case is a table of path → what the server answers; an unstubbed path is a test bug, loudly.
 * The **path** is the key, not the whole URL: this page sends the same path with a different query
 * string for every control change, and a table keyed on the URL would need a row per view.
 */
function stubFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[isCount(url) ? COUNT : `${url.origin}${url.pathname}`];
    if (!route) throw new Error(`no stub for ${url.pathname}`);
    return route(url);
  });
}

/** Answers a scripted sequence, one per call: what supersession and retry tests are written with. */
function inTurn(...answers: Array<(url: URL) => Response | Promise<Response>>) {
  let i = 0;
  return (url: URL) => {
    const answer = answers[i++];
    if (!answer) throw new Error(`the listeners route was called ${i} times; ${answers.length} answers were scripted`);
    return answer(url);
  };
}

/** A promise the test hands back by hand, so an intermediate state can be asserted. */
function gated(body: () => Response) {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return { answer: async () => { await gate; return body(); }, release: () => release() };
}

/**
 * Everything the **Lobby page** reads while it loads, the two side reads included; an unstubbed path
 * is a test bug, loudly. The directory is one view of that page now, so its own query is a row here
 * beside the Weave, its events, the guidelines, the request board and the count read.
 */
const INSTANCE: Routes = {
  [LOBBY_URL]: () => json(LOBBY),
  [LISTENERS]: () => json(directory([listener("ada", "ada@example.com")])),
  /** A Lobby that answers a count of its own, so the number beside the sidebar line names this table. */
  [COUNT]: () => json(directory([], { total: 12 })),
  [JOIN]: () => json(JOINED),
  [EVENTS]: () => json({ events: [] }),
  [WEAVE]: () => json(weaveBody()),
  [`${BASE}/api/guidelines`]: () => json({ guidelines: "" }),
  [`${BASE}/api/requests`]: () => json({ requests: [] }),
  [`${BASE}/api/lobby/participants/me`]: () => json(JOINED.participant),
  [MESSAGES]: () => json({ weaveId: LOBBY.weaveId, seq: 1, threadId: "g1", type: "message",
    actor: JOINED.participant.id, at: "", payload: { text: "" } }),
  // A *fatal* ticket failure is what leaves no socket and no reconnect timer behind, so nothing of
  // this page outlives the test that mounted it.
  [TICKET]: () => json({ code: "forbidden", message: "no stream in tests" }, 403),
};

/** Several macrotask turns: the pointer resolving, the first query landing, and a rebuilt one after. */
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
/**
 * The same turns with the clock in the test's hands, for the debounce (`vi.useFakeTimers`). It
 * advances by a slice rather than by nothing because a state change made from *outside* Preact's
 * `act` — a timer callback is exactly that — has its effects flushed on the next animation frame,
 * which is a timer too and would never come on a clock that never moves.
 */
const settleFake = async () => { for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(50); };

type MountOpts = { path?: string; routes?: Routes; storage?: KeyValueStorage; notice?: PersistenceNotice };

/** The instance, the client and the readers over what it answered: shared by both ways to mount. */
function harness(opts: MountOpts) {
  history.replaceState(null, "", opts.path ?? "/lobby/listeners");
  const fetchStub = stubFetch({ ...INSTANCE, ...opts.routes });
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = opts.notice ?? createPersistenceNotice();
  const to = (url: string) => fetchStub.mock.calls.filter((c) => new URL(String(c[0])).pathname === new URL(url).pathname);
  const directoryCalls = () => to(LISTENERS).filter((c) => new URL(String(c[0])).searchParams.get("limit") !== "0");
  const h = {
    fetchStub, client, storage, notice,
    calls: (url: string) => to(url).length,
    /** What each **directory** query asked for, in order. The count read is not one of them. */
    queries: () => directoryCalls().map((c) => new URL(String(c[0])).searchParams),
    /** How many directory queries have been made. Replaces `calls(LISTENERS)`, which now also counts
     *  the session's two-side-reads-per-refresh. */
    asked: () => h.queries().length,
    /** The credential the n-th **directory** query was made with. */
    authOf: (n: number) => (directoryCalls()[n]?.[1]?.headers as Record<string, string> | undefined)?.authorization,
    heading: () => !!screen.queryByRole("heading", { level: 2, name: "Listeners" }),
    /** The names on the cards, in the order the grid renders them. */
    names: () => [...document.querySelectorAll(".profile-name")].map((e) => e.textContent),
  };
  return h;
}

function mountApp(opts: MountOpts = {}) {
  const h = harness(opts);
  const view = render(<App client={h.client} storage={h.storage} notice={h.notice} weaves={createWeavesSignal()} />);
  const field = () => screen.getByLabelText("Name") as HTMLInputElement;
  return {
    ...view, ...h,
    joinAs: async (name: string) => {
      fireEvent.input(field(), { target: { value: name } });
      fireEvent.submit(field().closest("form")!);
      await settle();
    },
  };
}

/**
 * The Lobby page, with the directory open or closed. The path is the *real* one this browser loaded,
 * so `/lobby/listeners` is a deep link — the directory is on screen as soon as the session is ready,
 * because `initialView` seeded it — and `/lobby` is a Lobby whose directory is reached by pressing
 * the sidebar line. **The deep link is the default**, and that is a rule and not a convenience: a
 * directory opened by `toggle()` from `/lobby` leaves `location.pathname` at `/lobby` until the app
 * learns to push, and `writeSearch` then correctly refuses to write — so every test that reads or
 * asserts a query string must be standing on the path that owns it. Only a test about the
 * transition itself starts at `/lobby`.
 */
function mountLobby(opts: MountOpts = {}) {
  const v = mountApp({ storage: joined(), ...opts, path: opts.path ?? "/lobby/listeners" });
  const line = (): HTMLElement | null => screen.queryByRole("button", { name: /^View all/ });
  return {
    ...v,
    line,
    /**
     * Presses the sidebar line and lets the query that follows land. `settling` is the parameter that
     * keeps this usable under `vi.useFakeTimers()`: awaiting the real-timer `settle()` on a clock the
     * test owns never returns, so a fake-timer test calls `await v.toggle(settleFake)`.
     */
    toggle: async (settling: () => Promise<void> = settle) => { fireEvent.click(line()!); await settling(); },
    directory: () => !!v.container.querySelector(".listeners"),
    composerSlot: () => v.container.querySelector(".composer-slot") as HTMLElement | null,
  };
}

/** A browser that has already joined the Lobby: the directory's ordinary starting point. */
function joined(): KeyValueStorage {
  const storage = memoryStorage();
  setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana" });
  return storage;
}

/** The same identity, written where it cannot be kept: leaving this JS context would lose it. */
function joinedInMemory(): KeyValueStorage {
  const storage = memoryStorage({ durable: false });
  setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana" });
  return storage;
}

/** An identity and a Weave secret beside it: what a 401 falls back to (spec §5.5). */
function joinedWithSecret(): KeyValueStorage {
  const storage = memoryStorage();
  setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana", name: "dana" },
    { secret: "lobby-secret" });
  return storage;
}

const INVALID = fail("invalid_token", "Unknown or expired credential", 401);
const chip = (label: RegExp | string) => screen.getByRole("button", { name: label });
/** The body of the one `POST` to `MESSAGES` this page made: what a send test actually asserts. */
const posted = (v: { fetchStub: ReturnType<typeof stubFetch> }) =>
  JSON.parse(String(v.fetchStub.mock.calls.find((c) => String(c[0]) === MESSAGES)![1]!.body));
/** `?filter={"tools":["shell"]}`, the one filter the fixture's facets can answer for. */
const FILTERED = `filter=${encodeURIComponent(JSON.stringify({ tools: ["shell"] }))}`;

// `location` is reset too: from this task on a test can leave the address bar somewhere else, and
// `replaceState` rather than a push, so the reset itself adds no entry.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); history.replaceState(null, "", "/"); });

describe("the Lobby's two addresses (spec §4.1)", () => {
  it("reads /lobby/listeners as the Lobby with the directory open", () => {
    expect(routeOf("/lobby/listeners")).toEqual({ kind: "lobby", view: "listeners" });
  });

  it("reads its trailing slash the same way, as the server serves both", () => {
    expect(routeOf("/lobby/listeners/")).toEqual({ kind: "lobby", view: "listeners" });
  });

  it("leaves /lobby the Lobby with no view of its own", () => {
    expect(routeOf("/lobby")).toEqual({ kind: "lobby" });
  });

  it("makes no page of a near miss", () => {
    expect(routeOf("/lobby/listenersx")).toEqual({ kind: "unknown" });
  });
});

/**
 * Spec §3.2, asserted by counting requests and never by inspecting internals. This is the one
 * **absolute** request count in the suite, and it is one legitimately: the `ws-ticket` row answers a
 * fatal `403`, so this harness opens no stream, has no reconnect and therefore schedules no refresh
 * — nothing but a remount can ask for the Weave or its events a second time, which is the claim.
 */
describe("the session does not remount on a view flip (spec §3.2)", () => {
  it("asks for the Weave, its events and a stream ticket once across three flips", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    await v.toggle();
    await v.toggle();
    await v.toggle();
    expect([v.calls(WEAVE), v.calls(EVENTS), v.calls(TICKET)]).toEqual([1, 1, 1]);
  });
});

describe("the sidebar line is the toggle (spec §8)", () => {
  it("is a button, with no href a middle click could turn into a page load", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    expect([v.line()!.tagName, v.line()!.getAttribute("href")]).toEqual(["BUTTON", null]);
  });

  it("is marked current only while the directory is on screen", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    const closed = v.line()!.getAttribute("aria-current");
    await v.toggle();
    const open = v.line()!.getAttribute("aria-current");
    await v.toggle();
    expect([closed, open, v.line()!.getAttribute("aria-current")]).toEqual([null, "true", null]);
  });

  it("closes the directory when it is pressed again", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    await v.toggle();
    await v.toggle();
    expect(v.directory()).toBe(false);
  });
});

/**
 * Spec §8, as amended on 2026-09-21 after the first run of smoke test 6 on `main`: with the
 * directory on screen the Thread list marked "General" beside the sidebar line's own mark, so two
 * entries claimed to be the one being looked at. Only the **mark** is withheld — the selection is
 * kept, which is the third test here.
 */
describe("the Thread list marks nothing while the directory is open (spec §8)", () => {
  const thread = () => screen.getByRole("button", { name: "General" });

  it("while the directory is open no Thread is marked", async () => {
    const v = mountLobby();
    await settle();
    expect([
      v.container.querySelector(".threads li.active"),
      v.container.querySelector("button.thread-pick[aria-current]"),
      v.line()!.getAttribute("aria-current"),
    ]).toEqual([null, null, "true"]);
  });

  it("the mark returns when a Thread is shown again", async () => {
    const v = mountLobby();
    await settle();
    fireEvent.click(thread());                       // the Thread list is in the sidebar in both views
    await settle();
    expect([thread().getAttribute("aria-current"), thread().closest("li")!.classList.contains("active"),
      v.line()!.getAttribute("aria-current")]).toEqual(["true", true, null]);
  });

  // Coming back through the **sidebar line** presses no Thread at all, so a mark that reappears can
  // only be the selection this page has held all along. The DOM is the way this is asserted because
  // the harness mounts the `App`, which owns its session and hands no reference back.
  it("the selection is kept, not cleared", async () => {
    const v = mountLobby();
    await settle();
    await v.toggle();
    expect([v.directory(), thread().getAttribute("aria-current")]).toEqual([false, "true"]);
  });

  it("the Lobby page renders no link to /join-loom.md", async () => {
    const v = mountLobby();
    await settle();
    const hrefs = [...v.container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => h.endsWith("/join-loom.md"))).toEqual([]);
  });
});

describe("the deep link (spec §4.3)", () => {
  it("mounts the Lobby with the directory open and the box seeded from the link", async () => {
    const v = mountLobby({ path: "/lobby/listeners?q=ada" });
    await settle();
    expect([v.directory(), (screen.getByLabelText("Search") as HTMLInputElement).value]).toEqual([true, "ada"]);
  });

  it("asks for exactly that one query", async () => {
    const v = mountLobby({ path: "/lobby/listeners?q=ada" });
    await settle();
    expect([v.queries().length, v.queries()[0]!.get("q")]).toEqual([1, "ada"]);
  });
});

/**
 * What the browser does on Back, in the order it does it: happy-dom implements `pushState`,
 * `replaceState` and `location`, but `history.back()` dispatches no `popstate`. So the address bar is
 * moved without adding an entry, and then the event is dispatched. The listener reads
 * `location.pathname` and never `event.state`, so a plain `new Event("popstate")` would do as well.
 */
const pop = async (to: string, settling: () => Promise<void> = settle) => {
  history.replaceState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await settling();
};

/**
 * "Did this push?" is asked of a spy and never of `history.length`: happy-dom carries a pushed entry
 * into the next test, so the stack's length is a property of the file and not of the test. Installed
 * once the mount has settled and cleared with it, so what each one counts is what the test did next;
 * `vi.restoreAllMocks()` in the `afterEach` takes both off again.
 */
const spies = () => {
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  push.mockClear();
  replace.mockClear();
  /** The paths pushed, in order: a pushed entry carries no query string, so this is the whole of it. */
  return { push, replace, pushed: () => push.mock.calls.map((c) => c[2]) };
};

/** Types a name into `ThreadList`'s own form and submits it. The form is on screen because
 *  **New thread** is, which `ThreadList` renders for every unarchived Weave. */
const createThread = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "New thread" }));
  const box = screen.getByPlaceholderText("Thread name");
  fireEvent.input(box, { target: { value: name } });
  fireEvent.submit(box.closest("form")!);
};

describe("the push, from /lobby on a durable browser (spec §4.2)", () => {
  it("pushes the directory's address when the directory opens", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    const s = spies();
    await v.toggle();
    expect([s.pushed(), location.pathname]).toEqual([["/lobby/listeners"], "/lobby/listeners"]);
  });

  // The entry belongs to the view; the filters belong to the entry, which the directory rewrites in
  // place. So the push carries no query string, and the chip adds no second entry to go back through.
  it("rewrites that entry's query string for a chip, and pushes nothing for it", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    const s = spies();
    await v.toggle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([s.pushed(), s.replace.mock.calls.length]).toEqual([["/lobby/listeners"], 1]);
  });

  it("pushes the bare /lobby when a Thread is picked from the open directory", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    await v.toggle();
    const s = spies();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await settle();
    expect([s.pushed(), location.pathname]).toEqual([["/lobby"], "/lobby"]);
  });
});

/**
 * Spec §4.2's change test. `onView` is `ThreadList`'s `onPick` too, called on every selection and
 * every successful creation (§3.4), so a handler that pushed unconditionally would fill Back with
 * duplicate `/lobby` entries for ordinary Thread navigation — a page whose Back button walks through
 * a human's Thread clicks. The directory stays **closed** through the first two.
 */
describe("a view that does not change is not a history entry (spec §4.2)", () => {
  it("records nothing when a Thread is picked with the directory closed", async () => {
    mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    const s = spies();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await settle();
    expect(s.pushed()).toEqual([]);
  });

  it("records nothing when a Thread is created with the directory closed", async () => {
    mountLobby({ path: "/lobby", storage: joined(), routes: { [THREADS]: () => json(DESIGN) } });
    await settle();
    const s = spies();
    createThread("Design");
    await settle();
    expect(s.pushed()).toEqual([]);
  });

  // And the other half of the rule, which stops the guard being written as "never push from
  // `onPick`": the close **is** a view change, and it is recorded like any other.
  it("records one entry per real change, the close included", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    const s = spies();
    await v.toggle();
    await v.toggle();
    expect(s.pushed()).toEqual(["/lobby/listeners", "/lobby"]);
  });
});

/**
 * Spec §4.2's "re-read per click". `ThreadList.submit` calls `onPick` **after** `await
 * session.createThread(…)`, so the handler that decides the push is the one a render before the
 * request made — and the write that degrades this browser lands **inside** that await. Applied
 * before the click, any implementation would pass and the test would prove nothing.
 */
describe("the permission is the one that holds when the handler runs (spec §4.2)", () => {
  async function degradedInsideTheAwait() {
    const createAnswer = gated(() => json(DESIGN));
    const v = mountLobby({ path: "/lobby", storage: joined(), routes: { [THREADS]: createAnswer.answer } });
    await settle();
    await v.toggle();                    // the one push this page was still allowed to make
    const s = spies();
    createThread("Design");              // parks inside `session.createThread`, holding this `onPick`
    await settle();
    v.notice.note("memory");             // …and persistence fails while it is parked
    await settle();
    createAnswer.release();
    await settle();
    return { v, s };
  }

  it("makes no entry for a change whose permission expired inside the await", async () => {
    const { s } = await degradedInsideTheAwait();
    expect(s.pushed()).toEqual([]);
  });

  it("changes the view all the same: only the history write is withheld", async () => {
    const { v } = await degradedInsideTheAwait();
    expect([v.directory(), screen.getByRole("button", { name: /^Design/ }).getAttribute("aria-current")])
      .toEqual([false, "true"]);
  });

  it("leaves the address bar where the push put it, disagreeing with the view (spec §4.5)", async () => {
    await degradedInsideTheAwait();
    expect(location.pathname).toBe("/lobby/listeners");
  });
});

/**
 * Spec §4.2's lifetime amendment. A Create submitted before a join resolves after it — the POST
 * carries no `AbortSignal`, so disposing the old session cannot cancel it — and calls the **retired**
 * mount's `onView`. That mount's ref stopped updating when it came off screen, while `setView` lives
 * above `key={reloadKey}` and is still pointed at the page on screen: without the lifetime guard the
 * human's directory vanishes because of a button pressed before the join. The directory's script has
 * exactly two answers on purpose — a third query would mean the retired handler took the page
 * somewhere and the page queried its way back, and `inTurn` reports that rather than absorbing it.
 */
describe("a handler a join has retired does nothing at all (spec §4.2)", () => {
  async function retiredByAJoin() {
    const createAnswer = gated(() => json(DESIGN));
    const v = mountLobby({ path: "/lobby", storage: joined(), routes: {
      [LISTENERS]: inTurn(INVALID, () => json(directory([listener("ada", "a")]))),
      [THREADS]: createAnswer.answer,
    } });
    await settle();
    createThread("Design");              // parked, holding the old mount's `onPick`
    await settle();
    await v.toggle();                    // one push; the first query refuses, and there is no secret
    await v.joinAs("dana");              // the join retires that mount; the view crosses the key
    const s = spies();
    createAnswer.release();              // the old `await` resolves, into the old `onView("thread")`
    await settle();
    return { v, s };
  }

  it("records no history entry for the page it no longer belongs to", async () => {
    const { s } = await retiredByAJoin();
    expect(s.pushed()).toEqual([]);
  });

  it("leaves the live page's directory exactly where the human left it", async () => {
    const { v } = await retiredByAJoin();
    expect(v.directory()).toBe(true);
  });

  it("leaves the address bar on the directory it is showing", async () => {
    await retiredByAJoin();
    expect(location.pathname).toBe("/lobby/listeners");
  });
});

/** Spec §4.4: Back leaves the directory, Forward comes back to it, and the entry Forward landed on
 *  is what the directory seeds itself from — one fresh query, not the one it had before. */
describe("Back and Forward (spec §4.4)", () => {
  /** The two entries Back walks: the `/lobby` the page opened on, and the pushed listeners entry the
   *  chip then rewrote in place. */
  async function twoEntries() {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    await v.toggle();
    fireEvent.click(chip(/^shell/));
    await settle();
    return v;
  }
  /** An entry carrying both halves, so "seeded from **that** entry" is something to see. */
  const FORWARD = `/lobby/listeners?q=ada&${FILTERED}`;

  it("leaves the directory when Back returns to /lobby", async () => {
    const v = await twoEntries();
    await pop("/lobby");
    expect([v.directory(), !!v.container.querySelector(".messages")]).toEqual([false, true]);
  });

  it("brings it back seeded from the entry Forward landed on", async () => {
    const v = await twoEntries();
    await pop("/lobby");
    await pop(FORWARD);
    expect([v.directory(), chip(/^shell/).getAttribute("aria-pressed"),
      (screen.getByLabelText("Search") as HTMLInputElement).value]).toEqual([true, "true", "ada"]);
  });

  // A **delta**, snapshotted immediately before the `pop`: the page behind this one has been
  // querying since it mounted.
  it("makes exactly one fresh query, carrying that entry's filter", async () => {
    const v = await twoEntries();
    await pop("/lobby");
    const before = v.asked();
    await pop(FORWARD);
    expect([v.asked() - before, v.queries().at(-1)!.get("filter")]).toEqual([1, '{"tools":["shell"]}']);
  });
});

/**
 * Spec §4.5: on the Lobby's other two addresses the path is not this page's at all, so the directory
 * opens and filters and **nothing whatever** is written — not an entry, and not a query string.
 */
describe("the Lobby under an address that is not its own (spec §4.5)", () => {
  const SECRET = "s".repeat(43);
  const LOOKUP = `${BASE}/api/weaves/${SECRET}/lookup`;

  async function openAndFilter(path: string) {
    const v = mountLobby({ path, storage: joined(),
      routes: { [LOOKUP]: () => json({ weaveId: LOBBY.weaveId }) } });
    await settle();
    const s = spies();
    await v.toggle();
    fireEvent.click(chip(/^shell/));
    await settle();
    return { v, s };
  }

  for (const [name, path] of [
    ["/weave/<lobby id>", `/weave/${LOBBY.weaveId}`],
    ["/w/<lobby secret>", `/w/${SECRET}`],
  ] as const) {
    it(`opens and filters the directory on ${name}`, async () => {
      const { v } = await openAndFilter(path);
      expect([v.directory(), v.queries().at(-1)!.get("filter")]).toEqual([true, '{"tools":["shell"]}']);
    });

    it(`touches neither half of the history API on ${name}`, async () => {
      const { s } = await openAndFilter(path);
      expect([s.push.mock.calls.length, s.replace.mock.calls.length]).toEqual([0, 0]);
    });
  }
});

/** Spec §4.5: a `/lobby` this browser could not load again keeps its view flip and loses its URL. */
describe("a memory-only /lobby never moves the address bar (spec §4.5)", () => {
  async function memoryOnly() {
    const notice = createPersistenceNotice();
    notice.note("memory");               // a write has already failed: this page may not be left
    const v = mountLobby({ path: "/lobby", storage: joinedInMemory(), notice });
    await settle();
    const s = spies();
    await v.toggle();
    fireEvent.click(chip(/^shell/));
    await settle();
    return { v, s };
  }

  it("switches the view and filters it all the same", async () => {
    const { v } = await memoryOnly();
    expect([v.directory(), v.queries().at(-1)!.get("filter")]).toEqual([true, '{"tools":["shell"]}']);
  });

  it("writes neither an entry nor a query string", async () => {
    const { s } = await memoryOnly();
    expect([s.push.mock.calls.length, s.replace.mock.calls.length, location.pathname, location.search])
      .toEqual([0, 0, "/lobby", ""]);
  });
});

/**
 * Spec §4.5's two cases, which are the two the path test alone got wrong: a browser that may not
 * push can be standing on `/lobby/listeners` because it was deep-linked there, or because the push
 * was made while it was still durable and persistence failed afterwards. In both, the query string
 * is still this page's own to keep honest.
 */
describe("one history rule, in the two cases the path test alone got wrong (spec §4.5)", () => {
  it("rewrites a deep-linked memory-only page's query string, and pushes for nothing at all", async () => {
    const v = mountLobby({ path: "/lobby/listeners", storage: joinedInMemory() });
    await settle();
    const s = spies();
    fireEvent.click(chip(/^shell/));                                  // the filter
    await settle();
    await v.toggle();                                                 // the sidebar line
    fireEvent.click(screen.getByRole("button", { name: "General" })); // and a Thread
    await settle();
    expect([new URLSearchParams(location.search).get("filter"), s.replace.mock.calls.length, s.pushed()])
      .toEqual(['{"tools":["shell"]}', 1, []]);
  });

  it("keeps rewriting, and stops pushing, when persistence fails after the push", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    await v.toggle();                    // the push this browser was still durable enough to make
    const s = spies();
    v.notice.note("memory");
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    await v.toggle();                    // the close, which is no longer anything to come back to
    expect([s.replace.mock.calls.length, s.pushed(), location.pathname, v.directory(),
      !!v.container.querySelector(".messages")])
      .toEqual([1, [], "/lobby/listeners", false, true]);
  });
});

/**
 * Spec §3.4 and §3.5. The controls pressed here are the sidebar's own, which `INSTANCE` puts on
 * screen: the `General` thread button comes from the Weave row's one thread, **New thread** from
 * `ThreadList`'s own head, and the composer from `JOINED.participant` being a writable member.
 */
describe("picking a Thread, and the composer (spec §3.4, §3.5)", () => {
  it("closes the directory when a Thread is picked", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    await v.toggle();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await settle();
    expect(v.directory()).toBe(false);
  });

  // Creating one selects it (`session.ts:831`), and leaving the human on the directory would hide
  // what they just made.
  it("closes it when a Thread is created", async () => {
    const v = mountLobby({ path: "/lobby", routes: { [THREADS]: () => json(DESIGN) } });
    await settle();
    await v.toggle();
    createThread("Design");
    await settle();
    expect(v.directory()).toBe(false);
  });

  // The attribute, deliberately, and not `queryByRole("textbox")`: happy-dom's handling of the UA
  // `[hidden]` rule is not something this suite should depend on.
  it("keeps the composer mounted and undrawn while the directory is open", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    await v.toggle();
    expect([v.composerSlot()!.hasAttribute("hidden"), !!v.composerSlot()!.querySelector("textarea")])
      .toEqual([true, true]);
  });
});

/**
 * Spec §6.1: a rejection nobody is waiting for must not spend the page's one credential recovery.
 * The default deep-link mount, whose one query is the gated one.
 */
describe("a 401 that lands too late (spec §6.1)", () => {
  const entryOf = (s: KeyValueStorage) => s.get(weaveKey(LOBBY.weaveId));

  it("writes nothing when it lands after the directory was closed", async () => {
    const held = gated(INVALID);
    const v = mountLobby({ storage: joinedWithSecret(), routes: { [LISTENERS]: held.answer } });
    await settle();
    fireEvent.click(v.line()!);                  // the view closes; the query nobody wants is still out
    await settle();
    const before = entryOf(v.storage);
    held.release();
    await settle();
    expect([entryOf(v.storage), !!screen.queryByRole("heading", { name: "Join the Lobby" })])
      .toEqual([before, false]);
  });

  it("writes nothing when it lands after the whole page has gone", async () => {
    const held = gated(INVALID);
    const v = mountLobby({ storage: joinedWithSecret(), routes: { [LISTENERS]: held.answer } });
    await settle();
    const before = entryOf(v.storage);
    v.unmount();
    held.release();
    await settle();
    expect([entryOf(v.storage), !!screen.queryByRole("heading", { name: "Join the Lobby" })])
      .toEqual([before, false]);
  });
});

describe("the draft survives the round trip (spec §3.5)", () => {
  const TYPED = "half a message";
  const composer = () => screen.getByPlaceholderText(/^Message #/) as HTMLTextAreaElement;

  it("keeps the text and the caret across a look at the directory", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    fireEvent.input(composer(), { target: { value: TYPED } });
    const caret = composer().selectionStart;
    await v.toggle();
    await v.toggle();
    expect([composer().value, composer().selectionStart]).toEqual([TYPED, caret]);
  });

  it("sends exactly that text when the Thread comes back", async () => {
    const v = mountLobby({ path: "/lobby" });
    await settle();
    fireEvent.input(composer(), { target: { value: TYPED } });
    await v.toggle();
    await v.toggle();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(posted(v)).toEqual({ text: TYPED });
  });

  // Unchanged behaviour, pinned here so the next change cannot move it by accident: the composer is
  // not keyed on the Thread, so a draft follows the human into the next one.
  it("carries the draft across a Thread switch, exactly as it does today", async () => {
    const v = mountLobby({ path: "/lobby",
      routes: { [WEAVE]: () => json(weaveBody({ threads: [GENERAL, DESIGN] })) } });
    await settle();
    fireEvent.input(composer(), { target: { value: TYPED } });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    await settle();
    expect(composer().value).toBe(TYPED);
  });
});

/**
 * Spec §3.3: `reportError` is the failure channel of the header and of all three sidebar panels,
 * every one of which stays live while the directory is open.
 */
describe("a mutation failure is visible while the directory is open (spec §3.3)", () => {
  const bar = (v: { container: Element }) => v.container.querySelector(".error-bar")?.textContent;

  it("says so when creating a Thread from the sidebar fails", async () => {
    const v = mountLobby({ path: "/lobby", routes: { [THREADS]: fail("internal", "boom", 500) } });
    await settle();
    await v.toggle();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const box = screen.getByPlaceholderText("Thread name");
    fireEvent.input(box, { target: { value: "Design" } });
    fireEvent.submit(box.closest("form")!);
    await settle();
    expect([bar(v), v.directory()]).toEqual(["boom", true]);
  });

  // `GuidelinesPanel` renders **Edit** only for `session.canModerate()`, so this test alone makes
  // this browser a keeper — which is what `doLoad` builds `state.me` from.
  it("says so when saving the guidelines fails", async () => {
    const v = mountLobby({ path: "/lobby", routes: {
      [WEAVE]: () => json(weaveBody({ participants: [{ ...JOINED.participant, role: "keeper" }] })),
      [`${WEAVE}/guidelines`]: fail("internal", "boom", 500),
    } });
    await settle();
    await v.toggle();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Weave guidelines");
    fireEvent.input(box, { target: { value: "be kind" } });
    fireEvent.submit(box.closest("form")!);
    await settle();
    expect([bar(v), v.directory()]).toEqual(["boom", true]);
  });
});

/**
 * Spec §3.1: the view lives above `key={reloadKey}`, so a join rebuilds the page under it without
 * resetting which part of the page the human was looking at. Both halves script the directory's
 * query as refused once and answered after the join: a row that refused *every* query would refuse
 * the credential the join has just written too, and what "came back" would be the fork again.
 */
describe("a rejoin restores the view (spec §3.1)", () => {
  const refusedThenAda = () => inTurn(INVALID, () => json(directory([listener("ada", "a")])));

  it("comes back to the directory on a browser whose address bar names it", async () => {
    const v = mountLobby({ path: "/lobby/listeners", storage: joined(),
      routes: { [LISTENERS]: refusedThenAda() } });
    await settle();
    await v.joinAs("dana");
    expect([v.directory(), v.names(), location.pathname]).toEqual([true, ["ada"], "/lobby/listeners"]);
  });

  // The open never touched the URL here, so the view is the only record there is.
  it("comes back to it on a memory-only browser whose address bar never left /lobby", async () => {
    const v = mountLobby({ path: "/lobby", storage: joinedInMemory(),
      routes: { [LISTENERS]: refusedThenAda() } });
    await settle();
    await v.toggle();
    await v.joinAs("dana");
    expect([v.directory(), v.names(), location.pathname]).toEqual([true, ["ada"], "/lobby"]);
  });
});

/**
 * Spec §12.19. `LobbyRoute`'s own discovery answers; the session's first one fails transiently, which
 * settles the load with `lobbyKnown` false; and the one `retryLobbyData` makes after its 250 ms sleep
 * is held — which is why this block runs on the test's own clock.
 */
describe("a delayed discovery leaves the Thread writable (spec §5)", () => {
  const composer = () => screen.getByPlaceholderText(/^Message #/) as HTMLTextAreaElement;

  async function held() {
    vi.useFakeTimers();
    const gate = gated(() => json(LOBBY));
    let n = 0;
    const v = mountLobby({ routes: { [LOBBY_URL]: () => {
      n += 1;
      if (n === 1) return json(LOBBY);
      if (n === 2) return Promise.reject(new Error("simulated network failure"));
      return gate.answer();
    } } });
    await settleFake();
    return { v, gate };
  }

  it("renders a Thread, and no directory at all, while the retry is still out", async () => {
    const { v } = await held();
    expect([!!v.container.querySelector(".messages"), v.heading(), v.line()]).toEqual([true, false, null]);
  });

  it("leaves the composer drawn there, and a message typed into it sends", async () => {
    const { v } = await held();
    expect(v.composerSlot()!.hasAttribute("hidden")).toBe(false);
    fireEvent.input(composer(), { target: { value: "still writable" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settleFake();
    expect(posted(v)).toEqual({ text: "still writable" });
  });

  it("opens the directory by itself once the pointer settles, with no further input", async () => {
    const { v, gate } = await held();
    gate.release();
    await settleFake();
    expect([v.heading(), v.composerSlot()!.hasAttribute("hidden"), v.line()!.getAttribute("aria-current")])
      .toEqual([true, true, "true"]);
  });

  // A **delta** rather than the absolute triple above: this page settled its pointer late, and
  // `retryLobbyData` makes side reads of its own.
  it("remounts nothing to get there", async () => {
    const { v, gate } = await held();
    const before = [v.calls(WEAVE), v.calls(EVENTS), v.calls(TICKET)];
    gate.release();
    await settleFake();
    expect([v.calls(WEAVE), v.calls(EVENTS), v.calls(TICKET)]).toEqual(before);
  });
});

/** Spec §12.20: a Lobby with no pointer is still a writable Thread, which is the rule. */
describe("a failed or absent Lobby still leaves the Thread writable (spec §5)", () => {
  const composer = () => screen.getByPlaceholderText(/^Message #/) as HTMLTextAreaElement;
  /** `LobbyRoute`'s own discovery answers; every call the session makes gets the second answer. */
  const afterTheFirst = (answer: () => Response | Promise<Response>) => {
    let n = 0;
    return () => (++n === 1 ? json(LOBBY) : answer());
  };
  const send = async (text: string) => {
    fireEvent.input(composer(), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
  };

  it("sends a message on a page whose pointer could not be read at all", async () => {
    const v = mountLobby({ routes: {
      [LOBBY_URL]: afterTheFirst(() => Promise.reject(new Error("simulated network failure"))),
    } });
    await settle();
    expect([!!v.container.querySelector(".messages"), v.heading()]).toEqual([true, false]);
    await send("still writable");
    expect(posted(v)).toEqual({ text: "still writable" });
  });

  // That answer settles the question and starts no retry, so nothing ever opens the directory.
  it("sends a message on an instance that answers that it has no Lobby, and opens nothing", async () => {
    const v = mountLobby({ routes: {
      [LOBBY_URL]: afterTheFirst(fail("weave_not_found", "No Lobby", 404)),
    } });
    await settle();
    await send("still writable");
    await settle();
    expect([posted(v), v.directory()]).toEqual([{ text: "still writable" }, false]);
  });
});

describe("the directory grid and its counts (spec §5.3)", () => {
  const two = [listener("ada", "ada@example.com"), listener("bo", "bo@example.com")];

  it("renders one card per listener", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory(two)) } });
    await settle();
    expect(v.names()).toEqual(["ada", "bo"]);
  });

  it("collapses the counts line when nothing has been filtered out", async () => {
    mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory(two)) } });
    await settle();
    expect(!!screen.queryByText("Showing 2 of 2 listeners")).toBe(true);
  });

  it("names both numbers when a filter has narrowed the Lobby", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => listener(`a${i}`, "owner"));
    mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory(rows, { matched: 87, total: 1204 })) } });
    await settle();
    // Locale-formatted, so the expectation is built the same way rather than pinning one locale's
    // thousands separator.
    expect(!!screen.queryByText(`Showing 50 of 87 matches (out of ${(1204).toLocaleString()} listeners)`)).toBe(true);
  });

  it("says the Lobby is empty rather than that nothing matched, when nothing is there", async () => {
    mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory([])) } });
    await settle();
    expect([!!screen.queryByText("Nobody has declared a profile yet."),
      !!screen.queryByText("No listener matches these filters.")]).toEqual([true, false]);
  });

  it("says nothing matched when the Lobby is not empty but the filters exclude everyone", async () => {
    mountLobby({ path: `/lobby/listeners?${FILTERED}`, storage: joined(),
      routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    await settle();
    expect(!!screen.queryByText("No listener matches these filters.")).toBe(true);
  });

  it("clears the filters and asks again when Clear filters is clicked", async () => {
    const v = mountLobby({ path: `/lobby/listeners?${FILTERED}`, storage: joined(),
      routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await settle();
    expect(v.queries().map((q) => q.has("filter"))).toEqual([true, false]);
  });
});

/**
 * CR2, word for word, in the spec's own numbers: `of` before `matched` and `out of` before `total`,
 * because three numbers in one sentence need the two relations spelled differently (spec §9).
 * Locale-formatted, so both expectations are built the same way rather than pinning one locale.
 */
describe("the counts line names both relations (spec §9, CR2)", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => listener(`a${i}`, "owner"));
  const n = (v: number) => v.toLocaleString();

  it("names the Lobby alone where nothing has been filtered out", async () => {
    mountLobby({ storage: joined(),
      routes: { [LISTENERS]: () => json(directory(rows(50), { matched: 62, total: 62 })) } });
    await settle();
    expect(!!screen.queryByText(`Showing ${n(50)} of ${n(62)} listeners`)).toBe(true);
  });

  it("names the matches and the Lobby they came out of where a filter has narrowed it", async () => {
    mountLobby({ storage: joined(),
      routes: { [LISTENERS]: () => json(directory(rows(11), { matched: 11, total: 62 })) } });
    await settle();
    expect(!!screen.queryByText(`Showing ${n(11)} of ${n(11)} matches (out of ${n(62)} listeners)`)).toBe(true);
  });
});

/**
 * CR5. The control is always on the page, and `disabled` is the whole of "there is nothing to
 * clear" — so a test that presses it mounts on a link that is already off the defaults, a disabled
 * button being no control at all. The two that make it live press the **search box**, which is on
 * screen in every state of this page because it is rendered above the facets and waits for no
 * answer (spec §9).
 */
describe("Clear filters (spec §9, CR5)", () => {
  const clearFilters = () => screen.getByRole("button", { name: "Clear filters" }) as HTMLButtonElement;

  it("is on the page and disabled where everything is at its default", async () => {
    mountLobby({ storage: joined() });                            // the bare /lobby/listeners
    await settle();
    expect(clearFilters().disabled).toBe(true);
  });

  it("is live from the first keystroke, before the 250 ms window closes", async () => {
    vi.useFakeTimers();
    mountLobby({ storage: joined() });                            // the bare /lobby/listeners
    await settleFake();
    // The clock is not advanced past the debounce: what makes the control live is the draft, not
    // the view a query has yet to carry.
    fireEvent.input(screen.getByLabelText("Search"), { target: { value: "a" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(clearFilters().disabled).toBe(false);
  });

  it("counts a single typed space, the draft being read raw and never trimmed", async () => {
    vi.useFakeTimers();
    mountLobby({ storage: joined() });                            // the bare /lobby/listeners
    await settleFake();
    fireEvent.input(screen.getByLabelText("Search"), { target: { value: " " } });
    await vi.advanceTimersByTimeAsync(0);
    expect(clearFilters().disabled).toBe(false);
  });

  it("puts the sort and the direction back too", async () => {
    // Off its defaults from the first render, which is what makes the button pressable here.
    const v = mountLobby({ path: "/lobby/listeners?sort=owner&dir=desc", storage: joined() });
    await settle();
    fireEvent.click(clearFilters());
    await settle();
    const last = v.queries().at(-1)!;
    expect([
      (screen.getByLabelText("sort") as HTMLSelectElement).value,
      (screen.getByLabelText("direction") as HTMLSelectElement).value,
      last.get("sort"), last.get("dir"),
    ]).toEqual(["name", "asc", "name", "asc"]);
  });

  it("leaves the address bar at a bare /lobby/listeners", async () => {
    mountLobby({ path: "/lobby/listeners?q=ada", storage: joined() });
    await settle();
    fireEvent.click(clearFilters());
    await settle();
    expect([location.pathname, location.search]).toEqual(["/lobby/listeners", ""]);
  });
});

describe("the controls and the query string (spec §5.4)", () => {
  it("seeds every control from the link it was opened with", async () => {
    mountLobby({ path: `/lobby/listeners?q=fable&${FILTERED}&sort=owner&dir=desc`, storage: joined() });
    await settle();
    expect([
      (screen.getByLabelText("Search") as HTMLInputElement).value,
      (screen.getByLabelText("sort") as HTMLSelectElement).value,
      (screen.getByLabelText("direction") as HTMLSelectElement).value,
      chip(/^shell/).getAttribute("aria-pressed"),
    ]).toEqual(["fable", "owner", "desc", "true"]);
  });

  it("asks for exactly what that link described", async () => {
    const v = mountLobby({ path: `/lobby/listeners?q=fable&${FILTERED}&sort=owner&dir=desc`, storage: joined() });
    await settle();
    const q = v.queries()[0]!;
    expect([q.get("q"), q.get("filter"), q.get("sort"), q.get("dir"), q.get("limit")])
      .toEqual(["fable", '{"tools":["shell"]}', "owner", "desc", "50"]);
  });

  it("rewrites its own query string in place, and never pushes a history entry", async () => {
    mountLobby({ storage: joined() });
    await settle();
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([new URLSearchParams(location.search).get("filter"), replaced.mock.calls.length, pushed.mock.calls.length])
      .toEqual(['{"tools":["shell"]}', 1, 0]);
  });

  it("sends the filter the chip turned on", async () => {
    const v = mountLobby({ storage: joined() });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.queries().map((q) => q.get("filter"))).toEqual([null, '{"tools":["shell"]}']);
  });

  it("renders the directory for a link it could not read whole, with a note", async () => {
    const v = mountLobby({ path: "/lobby/listeners?filter=not-json", storage: joined() });
    await settle();
    expect([v.heading(), !!screen.queryByText("Part of this link was not understood, so it was ignored.")])
      .toEqual([true, true]);
  });

  it("sends none of what it could not read", async () => {
    const v = mountLobby({ path: "/lobby/listeners?filter=not-json", storage: joined() });
    await settle();
    expect(v.queries()[0]!.has("filter")).toBe(false);
  });

  // A stored tool may carry a tab — `validateProfile` accepts one and Postgres stores it — so the
  // facets really do hand this page such a chip. The chip has to work, and the link it writes has
  // to come back the same (PR #20 review round 1).
  it("sends a facet value carrying a tab when its chip is clicked", async () => {
    const tabbed = "a\tb";
    const page = directory([listener("ada", "ada@example.com")]);
    page.facets!.tools.values = [{ value: tabbed, count: 1 }];
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(page) } });
    await settle();
    fireEvent.click([...document.querySelectorAll(".chip")].find((c) => c.textContent!.includes(tabbed))!);
    await settle();
    expect(v.queries().map((q) => q.get("filter")))
      .toEqual([null, JSON.stringify({ tools: [tabbed] })]);
  });

  it("waits for the typing to stop: three keystrokes inside the window are one request", async () => {
    vi.useFakeTimers();
    const v = mountLobby({ storage: joined() });
    await settleFake();
    const box = screen.getByLabelText("Search");
    for (const s of ["f", "fa", "fab"]) fireEvent.input(box, { target: { value: s } });
    await vi.advanceTimersByTimeAsync(250);
    await settleFake();
    expect(v.asked()).toBe(2);
  });

  it("and that one request carries the last thing typed", async () => {
    vi.useFakeTimers();
    const v = mountLobby({ storage: joined() });
    await settleFake();
    const box = screen.getByLabelText("Search");
    for (const s of ["f", "fa", "fab"]) fireEvent.input(box, { target: { value: s } });
    await vi.advanceTimersByTimeAsync(250);
    await settleFake();
    expect(v.queries()[1]!.get("q")).toBe("fab");
  });
});

/**
 * The debounce is a *delay on the search box*, not a delayed snapshot of the whole page. A chip, a
 * sort or Clear filters pressed inside the 250 ms window is the newer intent: it supersedes the
 * keystroke that has not fired yet and carries its text along, rather than being quietly reverted
 * when the timer wakes up holding the view as it was before the click.
 */
describe("a control pressed while the typing has not settled (spec §5.3)", () => {
  /** Types `fab` without letting the window close, does `act`, then lets the clock run past it. */
  async function typingThen(act: () => void, opts: MountOpts = {}) {
    vi.useFakeTimers();
    const v = mountLobby({ storage: joined(), ...opts });
    await settleFake();
    fireEvent.input(screen.getByLabelText("Search"), { target: { value: "fab" } });
    act();
    await settleFake();                  // 600 ms: well past the window the keystroke asked for
    return v;
  }

  it("keeps the chip's filter once that window closes", async () => {
    const v = await typingThen(() => fireEvent.click(chip(/^shell/)));
    expect(v.queries().at(-1)!.get("filter")).toBe('{"tools":["shell"]}');
  });

  it("carries the typed text in the chip's own query", async () => {
    const v = await typingThen(() => fireEvent.click(chip(/^shell/)));
    expect(v.queries().at(-1)!.get("q")).toBe("fab");
  });

  it("asks once for the two of them together, not twice", async () => {
    const v = await typingThen(() => fireEvent.click(chip(/^shell/)));
    expect(v.asked()).toBe(2);
  });

  it("leaves the filter in the address bar too", async () => {
    await typingThen(() => fireEvent.click(chip(/^shell/)));
    expect(new URLSearchParams(location.search).get("filter")).toBe('{"tools":["shell"]}');
  });

  it("supersedes it with a sort change the same way", async () => {
    const v = await typingThen(() =>
      fireEvent.change(screen.getByLabelText("sort"), { target: { value: "owner" } }));
    const last = v.queries().at(-1)!;
    expect([last.get("sort"), last.get("q"), v.asked()]).toEqual(["owner", "fab", 2]);
  });

  it("lets Clear filters cancel it rather than be undone by it 250 ms later", async () => {
    const v = await typingThen(
      () => fireEvent.click(screen.getByRole("button", { name: "Clear filters" })),
      { path: `/lobby/listeners?${FILTERED}`, routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    const last = v.queries().at(-1)!;
    expect([last.has("filter"), last.has("q"), v.asked()]).toEqual([false, false, 2]);
  });
});

describe("one query at a time (spec §7)", () => {
  /** Two control changes with the answers held: the older is released last, and must not paint. */
  async function twoInFlight(older: () => Response) {
    const first = gated(older);
    const second = gated(() => json(directory([listener("cy", "cy@example.com")])));
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(() => json(directory([listener("ada", "ada@example.com")])), first.answer, second.answer),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    fireEvent.click(chip(/^node/));
    await settle();
    second.release();
    await settle();
    // Snapshotted here, after the round trip that legitimately wrote this entry — the session's own
    // load does (`saveWeaveEntry`) — and before the superseded 401 is let go. What the block asserts
    // is that the late rejection moves nothing, never that nothing was ever written.
    const entryBefore = v.storage.get(weaveKey(LOBBY.weaveId));
    first.release();
    await settle();
    return { ...v, entryBefore };
  }

  it("paints the newest answer and never the one it superseded", async () => {
    const v = await twoInFlight(() => json(directory([listener("bo", "bo@example.com")])));
    expect(v.names()).toEqual(["cy"]);
  });

  it("keeps the rows on screen while the next answer is still coming", async () => {
    const held = gated(() => json(directory([listener("bo", "bo@example.com")])));
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(() => json(directory([listener("ada", "ada@example.com")])), held.answer),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.names()).toEqual(["ada"]);
  });

  // The guard runs before every side effect, on the failure path as much as on the success path: a
  // request nobody is waiting for any more must not paint an error, and certainly must not delete a
  // credential.
  it("drops a superseded query's rejection as silently as its answer", async () => {
    const v = await twoInFlight(INVALID);
    expect([v.names(), !!screen.queryByText("Unknown or expired credential")]).toEqual([["cy"], false]);
  });

  it("writes nothing to storage for a superseded query's 401", async () => {
    const v = await twoInFlight(INVALID);
    expect(v.storage.get(weaveKey(LOBBY.weaveId))).toBe(v.entryBefore);
  });

  it("stays on the directory for a superseded query's 401, rather than falling back to the join form", async () => {
    const v = await twoInFlight(INVALID);
    expect([v.heading(), !!screen.queryByRole("heading", { name: "Join the Lobby" })]).toEqual([true, false]);
  });
});

describe("Show more (spec §5.3)", () => {
  const page1 = () => json(directory([listener("ada", "a"), listener("bo", "b")], { nextCursor: "c1", total: 3, matched: 3 }));

  it("sends the cursor the last answer gave it", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.queries()[1]!.get("cursor")).toBe("c1");
  });

  it("appends the next page below the rows already on screen, in order", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.names()).toEqual(["ada", "bo", "cy"]);
  });

  it("keeps the rows and the button when the next page fails, with the error beside it", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect([v.names(), !!screen.queryByRole("button", { name: "Show more" }), !!screen.queryByText("boom")])
      .toEqual([["ada", "bo"], true, true]);
  });

  it("offers nothing more to show when the answer carried no cursor", async () => {
    mountLobby({ storage: joined() });
    await settle();
    expect(!!screen.queryByRole("button", { name: "Show more" })).toBe(false);
  });

  // The facets describe the *filters*, which an appended page does not change, and §6 names the
  // facet pass the most expensive read this query makes.
  it("asks for no facets: appending a page cannot change them", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.queries()[1]!.get("facets")).toBe("false");
  });

  it("keeps the chips the facet-free answer did not carry", async () => {
    const appended = { ...directory([listener("cy", "c")], { total: 3, matched: 3 }), facets: undefined };
    mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, () => json(appended)) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(!!screen.queryByRole("button", { name: /^shell/ })).toBe(true);
  });
});

/**
 * Spec §5.3/§2.5: a control change starts a **fresh** query, and the cursor belongs to the query
 * that answered with it. Left on screen while the new query runs, "Show more" would send the old
 * view's cursor with the new view, win the generation race, and splice a page of one query onto the
 * rows of another — "Showing 60 of 12 matches", from two different questions.
 */
describe("a control change drops the cursor (spec §5.3)", () => {
  const page1 = () => json(directory([listener("ada", "a"), listener("bo", "b")], { nextCursor: "c1", total: 3, matched: 3 }));

  it("takes the button away while the fresh query is still loading", async () => {
    const slow = gated(() => json(directory([listener("cy", "c")], { nextCursor: "c2" })));
    mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, slow.answer) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(!!screen.queryByRole("button", { name: "Show more" })).toBe(false);
    slow.release();
    await settle();
  });

  it("leaves it away when the fresh query fails, with the old rows and the reason", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([!!screen.queryByRole("button", { name: "Show more" }), v.names(), !!screen.queryByText("boom")])
      .toEqual([false, ["ada", "bo"], true]);
  });

  it("brings it back on the new query's own cursor", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { nextCursor: "c2", total: 3, matched: 3 })),
        () => json(directory([listener("di", "d")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.queries()[2]!.get("cursor")).toBe("c2");
  });
});

/**
 * Core's bounds are the page's bounds. A control that lets a human compose a query core will
 * answer with `validation` turns an ordinary click or keystroke into an error line — so the box
 * stops at `q`'s hundred characters and the chip rows stop at 20 model alternatives and 50 tools.
 * A **selected** chip is never disabled: at the cap, taking one off is the only useful move left.
 */
describe("the controls stop at core's bounds", () => {
  /** A directory whose one chip row is the named values, all at a count of one. */
  const facetOf = (over: (f: NonNullable<ListenersPage["facets"]>) => NonNullable<ListenersPage["facets"]>) => {
    const d = directory([listener("ada", "a")]);
    return () => json({ ...d, facets: over(d.facets!) });
  };
  const modelNames = Array.from({ length: 21 }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const toolNames = Array.from({ length: 51 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const withModels = (names: string[]) => facetOf((f) => ({ ...f,
    models: { values: names.map((model) => ({ model, count: 1, efforts: [], moreEfforts: false })), more: false } }));
  const withTools = (names: string[]) => facetOf((f) => ({ ...f,
    tools: { values: names.map((value) => ({ value, count: 1 })), more: false } }));
  const at = (filter: unknown, route: () => Response) => mountLobby({ storage: joined(),
    path: `/lobby/listeners?filter=${encodeURIComponent(JSON.stringify(filter))}`,
    routes: { [LISTENERS]: route } });
  const disabled = (label: RegExp) => (chip(label) as HTMLButtonElement).disabled;

  it("bounds the search box at the hundred characters core accepts", async () => {
    mountLobby({ storage: joined() });
    await settle();
    expect((screen.getByLabelText("Search") as HTMLInputElement).maxLength).toBe(100);
  });

  it("stops offering a twenty-first model once twenty alternatives are picked", async () => {
    at({ models: modelNames.slice(0, 20).map((model) => ({ model })) }, withModels(modelNames));
    await settle();
    expect(disabled(/^m20/)).toBe(true);
  });

  it("says why, rather than leaving a dead chip", async () => {
    at({ models: modelNames.slice(0, 20).map((model) => ({ model })) }, withModels(modelNames));
    await settle();
    expect(chip(/^m20/).getAttribute("title")).toBeTruthy();
  });

  it("leaves a picked model removable at the cap", async () => {
    at({ models: modelNames.slice(0, 20).map((model) => ({ model })) }, withModels(modelNames));
    await settle();
    expect(disabled(/^m00/)).toBe(false);
  });

  it("leaves every model clickable one short of the cap", async () => {
    at({ models: modelNames.slice(0, 19).map((model) => ({ model })) }, withModels(modelNames));
    await settle();
    expect(disabled(/^m20/)).toBe(false);
  });

  it("stops offering a fifty-first tool once fifty are picked", async () => {
    at({ tools: toolNames.slice(0, 50) }, withTools(toolNames));
    await settle();
    expect(disabled(/^t50/)).toBe(true);
  });

  it("leaves a picked tool removable at the cap", async () => {
    at({ tools: toolNames.slice(0, 50) }, withTools(toolNames));
    await settle();
    expect(disabled(/^t00/)).toBe(false);
  });

  it("leaves every tool clickable one short of the cap", async () => {
    at({ tools: toolNames.slice(0, 49) }, withTools(toolNames));
    await settle();
    expect(disabled(/^t50/)).toBe(false);
  });
});

/**
 * Spec §7's last rule: core answers a malformed or stale-format cursor with `validation`, and a
 * cursor the server refuses must not wedge the page. Offering the button again would send the same
 * refused cursor for as long as the human keeps pressing it.
 */
describe("a cursor the Lobby refuses (spec §7)", () => {
  const page1 = () => json(directory([listener("ada", "a"), listener("bo", "b")], { nextCursor: "c1", total: 3, matched: 3 }));
  const REFUSED = fail("validation", "cursor is malformed", 400);
  const after = async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, REFUSED) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    return v;
  };

  it("stops offering it rather than sending the same refused cursor again", async () => {
    await after();
    expect(!!screen.queryByRole("button", { name: "Show more" })).toBe(false);
  });

  it("keeps the rows that were on screen and says what happened", async () => {
    const v = await after();
    expect([v.names(), !!screen.queryByText("cursor is malformed")]).toEqual([["ada", "bo"], true]);
  });

  // The cursor is gone; the view is not. A control change starts a fresh first page as it always has.
  it("leaves the next control change working", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, REFUSED, () => json(directory([listener("cy", "c")]))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([v.names(), v.queries()[2]!.has("cursor")]).toEqual([["cy"], false]);
  });
});

describe("a failed query is never an empty directory (spec §7)", () => {
  const ada = () => json(directory([listener("ada", "a")]));

  it("keeps the rows that were on screen", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([v.names(), !!screen.queryByText("boom")]).toEqual([["ada"], true]);
  });

  it("does not claim that nothing matched", async () => {
    mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(!!screen.queryByText("No listener matches these filters.")).toBe(false);
  });

  it("says nothing in the counts line rather than saying zero", async () => {
    mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(screen.queryByText(/^Showing /)).toBe(null);
  });
});

describe("the chips (spec §5.3)", () => {
  /** The filter is on and matches nobody: the chip that produced the empty result, at zero. */
  const emptyUnderFilter = { path: `/lobby/listeners?${FILTERED}`, storage: joined(),
    routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } };

  it("keeps a selected chip on screen at a count of zero, which is the only chip that may show one", async () => {
    mountLobby(emptyUnderFilter);
    await settle();
    expect([chip(/^shell/).getAttribute("aria-pressed"), chip(/^shell/).textContent]).toEqual(["true", "shell 0"]);
  });

  it("clears that filter when the zero chip is clicked", async () => {
    const v = mountLobby(emptyUnderFilter);
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.queries().map((q) => q.has("filter"))).toEqual([true, false]);
  });

  it("says in words that the model chips are any-of and the tool chips all-of", async () => {
    mountLobby({ storage: joined() });
    await settle();
    expect([!!screen.queryByText("any of these"), !!screen.queryByText("all of these")]).toEqual([true, true]);
  });

  it("offers the model's efforts once that model is selected", async () => {
    const withEfforts = directory([listener("ada", "a")]);
    withEfforts.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    const v = mountLobby({ routes: { [LISTENERS]: () => json(withEfforts) } });
    await settle();
    const before = !!screen.queryByRole("button", { name: /^high/ });
    fireEvent.click(chip(/^opus-5/));
    await settle();
    expect([before, !!screen.queryByRole("button", { name: /^high/ })]).toEqual([false, true]);
  });

  it("turns the selected model into an exact pair when an effort is chosen", async () => {
    const withEfforts = directory([listener("ada", "a")]);
    withEfforts.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    const v = mountLobby({ routes: { [LISTENERS]: () => json(withEfforts) } });
    await settle();
    fireEvent.click(chip(/^opus-5/));
    await settle();
    fireEvent.click(chip(/^high/));
    await settle();
    expect(v.queries()[2]!.get("filter")).toBe('{"models":[{"model":"opus-5","effort":"high"}]}');
  });

  it("clears the serving policy when its own chip is clicked again", async () => {
    const v = mountLobby();
    await settle();
    fireEvent.click(chip(/^anyone/));
    await settle();
    fireEvent.click(chip(/^anyone/));
    await settle();
    expect(v.queries().map((q) => q.get("filter"))).toEqual([null, '{"serves":"anyone"}', null]);
  });

  it("says a facet was cut at twenty when the answer says it was", async () => {
    const cut = directory([listener("ada", "a")]);
    cut.facets!.tools.more = true;
    mountLobby({ routes: { [LISTENERS]: () => json(cut) } });
    await settle();
    expect(!!screen.queryByText("20 most common")).toBe(true);
  });

  it("says an effort row was cut at ten when the answer says it was", async () => {
    const cut = directory([listener("ada", "a")]);
    cut.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    cut.facets!.models.values[0]!.moreEfforts = true;
    mountLobby({ routes: { [LISTENERS]: () => json(cut) } });
    await settle();
    fireEvent.click(chip(/^opus-5/));
    await settle();
    expect(!!screen.queryByText("10 most common")).toBe(true);
  });

  it("chooses one serving policy at a time", async () => {
    const v = mountLobby();
    await settle();
    fireEvent.click(chip(/^anyone/));
    await settle();
    fireEvent.click(chip(/^its owner/));
    await settle();
    expect(v.queries().map((q) => q.get("filter")))
      .toEqual([null, '{"serves":"anyone"}', '{"serves":"owner"}']);
  });
});

describe("the list changed while you were reading it (spec §5.5)", () => {
  const CHANGED = "The list has changed since you loaded it.";

  it("says nothing about a list that has not changed", async () => {
    mountLobby({ storage: joined() });
    await settle();
    expect(!!screen.queryByText(CHANGED)).toBe(false);
  });

  it("says so when a later answer counts the Lobby differently", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(
      () => json(directory([listener("ada", "a")], { total: 3 })),
      () => json(directory([listener("ada", "a")], { total: 4 })),
    ) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([!!screen.queryByText(CHANGED), v.heading()]).toEqual([true, true]);
  });
});

/**
 * Spec §6.3, and the reason the count read has a row of its own: the directory's own query is the
 * one that is refused here, and the session's `limit=0` read answers normally beside it. The default
 * deep-link mount throughout, so nothing has to push for any of it.
 */
describe("a live 401 recovers, exactly once (spec §6.3)", () => {
  /** Refused once, answered after the recovery — which is the whole state machine of these tests. */
  const thenAda = () => inTurn(INVALID, () => json(directory([listener("ada", "a")])));

  // No control is pressed: query 1 is the mount's own, its 401 is reported, and the recovery's
  // `loading` → `ready` takes the directory through a fresh mount whose first query is query 2.
  // By the entry's **content**, which no later no-op write can fake, and not by a count of writes:
  // the recovery's own `doLoad()` writes the entry again through `saveWeaveEntry`, as does the load
  // before it, so the three fields that carry the rule are what is asserted.
  it("invalidates the identity, keeping the secret beside it", async () => {
    const v = mountLobby({ storage: joinedWithSecret(), routes: { [LISTENERS]: thenAda() } });
    await settle();
    const entry = readWeaveEntry(v.storage, LOBBY.weaveId)!;
    expect([entry.secret, entry.identity, entry.token]).toEqual(["lobby-secret", "invalid", undefined]);
  });

  it("makes the next query on that stored secret, and the rows come back", async () => {
    const v = mountLobby({ storage: joinedWithSecret(), routes: { [LISTENERS]: thenAda() } });
    await settle();
    expect([v.authOf(1), v.names()]).toEqual(["Bearer lobby-secret", ["ada"]]);
  });

  // With every answer a rejection there are no rows, no facets and therefore no chips: the only
  // thing on screen is the join fork, with the layout gone. The sentence is asserted with it,
  // because a join form that appears unannounced is the failure this fork is drawn to avoid: it is
  // the session's own `state.error`, the same one the generic no-credential card prints.
  it("settles at the join fork when there is no secret to fall back to", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }), v.directory(),
      !!screen.queryByText("Your identity in this Weave is no longer valid")])
      .toEqual([true, false, true]);
  });

  it("reports a write it could not keep", async () => {
    const notice = createPersistenceNotice();
    mountLobby({ storage: joinedInMemory(), notice, routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(notice.degraded()).toBe(true);
  });

  /**
   * The one case that presses something, so the script gives it something to press. Query 1 is
   * refused and recovers; query 2 is the re-mounted directory's and answers rows **and facets**,
   * which is what puts the chips on screen; only then is there a chip to press, and pressing it
   * makes query 3, which is refused again. Reading with the secret, that 401 is an ordinary query
   * error with nothing left to retire — so nothing more is written.
   */
  it("writes nothing more when a second query is refused on the secret", async () => {
    const storage = joinedWithSecret();
    const v = mountLobby({ storage, routes: {
      [LISTENERS]: inTurn(INVALID, () => json(directory([listener("ada", "a")])), INVALID),
    } });
    await settle();
    expect(v.names()).toEqual(["ada"]);           // the fresh query landed on the secret
    const set = vi.spyOn(storage, "set");
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(set).not.toHaveBeenCalled();
  });
});

/**
 * A grid that changes under a human who is not looking at it has to say so. `CreateWeaveForm`'s
 * saved panel sets the precedent (`role="status"`): the page announces what it is doing rather than
 * relying on the eye catching a line of muted text.
 */
describe("the states this page says out loud (spec §5.3)", () => {
  it("announces a failed query as an alert", async () => {
    mountLobby({ storage: joined(), routes: { [LISTENERS]: fail("internal", "boom", 500) } });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("announces a failed Show more beside its button", async () => {
    const page1 = () => json(directory([listener("ada", "a")], { nextCursor: "c1", total: 2, matched: 2 }));
    mountLobby({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("announces the refresh that is keeping the old rows on screen", async () => {
    const held = gated(() => json(directory([listener("bo", "b")])));
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: inTurn(() => json(directory([listener("ada", "a")])), held.answer),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    // Scoped to the directory: the header's connection pill is a status region of its own.
    expect(within(v.container.querySelector(".listeners") as HTMLElement).getByRole("status").textContent).toBe("updating…");
  });

  it("announces the first load, which has no rows to keep", async () => {
    const held = gated(() => json(directory([])));
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: held.answer } });
    await settle();
    expect(within(v.container.querySelector(".listeners") as HTMLElement).getByRole("status").textContent).toBe("Loading…");
  });
});

/**
 * The Lobby sidebar's line (spec §5.1), where `ProfileCards` used to stack a card per listener.
 * Every one of these hands the component a state, because the four states §5.1 words differently
 * are facts about two state cells and nothing else. Which element the line is, and when it is
 * marked current, is a rule about the page around it and is pinned on the real Lobby below.
 */
describe("the Lobby sidebar's listeners line (spec §5.1)", () => {
  const LOBBY_WEAVE = { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" };
  /**
   * A loaded Lobby page's state, in the shapes the session actually produces: `getWeave` carries no
   * Lobby profile at all now (spec §3.1), so every participant here has `capabilities: null` and
   * the count beside the line is the only thing that knows how many listeners there are.
   */
  const lobbyState = (over: Partial<SessionState> = {}): SessionState => ({
    status: "ready", weave: LOBBY_WEAVE, lobby: LOBBY,
    threads: [], participants: [JOINED.participant], events: [],
    me: { participant: JOINED.participant, token: "participant-token" },
    connection: "open", needsName: false, instanceGuidelines: "",
    invitesForMe: new Set(), invited: {}, requests: {}, requestsLoaded: true, closedRequestsPage: 25,
    ...over,
  });
  /** The line's whole text, so "and nothing else" is assertable. */
  const line = (container: Element) => container.textContent ?? "";

  it("shows how many listeners the Lobby holds", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCount: 3 })} />);
    expect(line(container)).toBe("ListenersView all 3");
  });

  // Before the first answer: no number, and not a word about a failure that has not happened.
  it("reads View all, with no number and nothing beside it, before the first count answers", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState()} />);
    expect(line(container)).toBe("ListenersView all");
  });

  // The whole text, so the rule that makes this worth having is asserted in the same breath: an
  // absent count is an absent number, never an invented `(0)`.
  it("says the count is unavailable when the read failed, and invents no zero", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCountError: true })} />);
    expect(line(container)).toBe("ListenersView allcount unavailable");
  });

  it("keeps the last known number when a later count read fails, and says nothing beside it", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCount: 7, listenerCountError: true })} />);
    expect(line(container)).toBe("ListenersView all 7");
  });

  it("drops that note again when a later count answers", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCount: 9, listenerCountError: false })} />);
    expect(line(container)).toBe("ListenersView all 9");
  });

  // A zero the server actually answered is a number like any other: what §5.1 forbids is inventing
  // one, not reporting one.
  it("shows a zero the Lobby really answered", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCount: 0, listenerCountError: false })} />);
    expect(line(container)).toBe("ListenersView all 0");
  });

  // A 401 on the own-profile read of a secret-link visit leaves the page ready with no `me` at all
  // (spec §3.3). The line needs none: it describes the Lobby, not the reader.
  it("works on a page that has fallen back to the Weave link and has no identity", () => {
    const { container } = render(
      <ListenersLink active={false} onToggle={() => {}} state={lobbyState({ me: undefined, readOnlyReason: "secret-fallback", listenerCount: 4 })} />,
    );
    expect(line(container)).toBe("ListenersView all 4");
  });

  it("renders nothing on a Weave that is not the Lobby", () => {
    const { container } = render(
      <ListenersLink active={false} onToggle={() => {}} state={lobbyState({ weave: { ...LOBBY_WEAVE, id: "22222222-2222-4222-8222-222222222222" }, listenerCount: 3 })} />,
    );
    expect(container.innerHTML).toBe("");
  });

  // A reload keeps the Weave and the pointer on screen while it runs, and neither count cell is
  // cleared by it: a page that is not actually showing the Lobby has no directory to offer.
  it("renders nothing while the page is loading, Lobby or not", () => {
    const { container } = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ status: "loading", listenerCount: 3 })} />);
    expect(container.innerHTML).toBe("");
  });
});

/**
 * The same line on the real Lobby page, where the number beside it comes from the session's own
 * count read and pressing it opens the directory in the main area rather than loading a page.
 */
describe("the listeners line on the Lobby page (spec §5.1)", () => {
  it("is in the Lobby's sidebar, carrying the number the Lobby answered", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    expect(v.container.querySelector(".sidebar")!.textContent).toContain("View all 12");
  });

  // The removal itself: the sidebar used to stack a card per listener, and there is no card and no
  // section left to hold one.
  it("stacks no profile card there any more", async () => {
    const v = mountLobby({ path: "/lobby", storage: joined() });
    await settle();
    expect([!!v.container.querySelector(".profiles"), !!v.container.querySelector(".profile-card")])
      .toEqual([false, false]);
  });

  it("renders the directory here when that button is clicked", async () => {
    const v = mountLobby({ path: "/lobby", storage: joinedInMemory(),
      routes: { [LISTENERS]: () => json(directory([listener("ada", "ada@example.com")], { total: 12 })) } });
    await settle();
    await v.toggle();
    expect([v.heading(), v.names()]).toEqual([true, ["ada"]]);
  });

  it("leaves the address bar alone when it does", async () => {
    const v = mountLobby({ path: "/lobby", storage: joinedInMemory() });
    await settle();
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    await v.toggle();
    expect([location.pathname, push.mock.calls.length, replace.mock.calls.length]).toEqual(["/lobby", 0, 0]);
  });
});
