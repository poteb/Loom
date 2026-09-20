// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient, type Listener, type ListenersPage } from "@loom/client";
import { App, routeOf } from "../src/app.js";
import { ListenersLink } from "../src/components/ListenersLink.js";
import { ListenersRoute } from "../src/components/listeners/ListenersRoute.js";
import type { SessionState } from "../src/session.js";
import { memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice, type PersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";
import { readWeaveEntry, saveWeaveEntry, setIdentity, weaveKey } from "../src/weaves-store.js";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (code: string, message: string, status: number) => () => json({ code, message }, status);

/** The `JoinResult` a successful `POST /api/lobby/join` answers with. */
const JOINED = {
  weaveId: LOBBY.weaveId,
  weave: { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
  generalThreadId: "g1",
  participant: { id: "p-dana", weaveId: LOBBY.weaveId, name: "dana", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null, capabilities: null },
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

type Routes = Record<string, (url: URL) => Response | Promise<Response>>;

/**
 * Every case is a table of path → what the server answers; an unstubbed path is a test bug, loudly.
 * The **path** is the key, not the whole URL: this page sends the same path with a different query
 * string for every control change, and a table keyed on the URL would need a row per view.
 */
function stubFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[`${url.origin}${url.pathname}`];
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

/** What this page reads while it loads: where the Lobby is, and its first page of listeners. */
const INSTANCE: Routes = {
  [LOBBY_URL]: () => json(LOBBY),
  [LISTENERS]: () => json(directory([listener("ada", "ada@example.com")])),
  [JOIN]: () => json(JOINED),
  // The directory opens no WebSocket (spec §5.5), so nothing here asks for a ticket. Stubbed all the
  // same: a *fatal* ticket failure is what leaves no socket and no reconnect timer behind, so a test
  // that mounts a Weave page beside this one gets the same silence.
  [`${BASE}/api/auth/ws-ticket`]: () => json({ code: "forbidden", message: "no stream in tests" }, 403),
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
  return {
    fetchStub, client, storage, notice,
    calls: (url: string) => to(url).length,
    /** What each listeners request asked for, in order. */
    queries: () => to(LISTENERS).map((c) => new URL(String(c[0])).searchParams),
    /** The credential the n-th listeners request was made with. */
    authOf: (n: number) => (to(LISTENERS)[n]?.[1]?.headers as Record<string, string> | undefined)?.authorization,
    heading: () => !!screen.queryByRole("heading", { name: "Listeners" }),
    /** The names on the cards, in the order the grid renders them. */
    names: () => [...document.querySelectorAll(".profile-name")].map((e) => e.textContent),
  };
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
 * The route on its own, with the three in-place callbacks as spies. `openListenersInPlace` has no
 * caller until the sidebar arrives, so `inPlace` — and the two controls that ask where they may
 * send this browser — are reachable only from here.
 */
function mountRoute(opts: MountOpts & { inPlace?: boolean } = {}) {
  const h = harness({ storage: joined(), ...opts });
  const spies = { openInPlace: vi.fn(), openMainInPlace: vi.fn(), openListenersInPlace: vi.fn() };
  const view = render(<ListenersRoute client={h.client} storage={h.storage} notice={h.notice}
    {...spies} inPlace={opts.inPlace} />);
  return { ...view, ...h, ...spies };
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

/** The Weave secret and no identity: the credential a 401 has already fallen back to (spec §5.5). */
function secretOnly(): KeyValueStorage {
  const storage = memoryStorage();
  saveWeaveEntry(storage, LOBBY.weaveId, { secret: "lobby-secret" });
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
/** `?filter={"tools":["shell"]}`, the one filter the fixture's facets can answer for. */
const FILTERED = `filter=${encodeURIComponent(JSON.stringify({ tools: ["shell"] }))}`;

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("the listeners route (spec §5.2)", () => {
  it("matches /lobby/listeners", () => {
    expect(routeOf("/lobby/listeners")).toEqual({ kind: "listeners" });
  });

  it("matches it with a trailing slash, as the server serves both", () => {
    expect(routeOf("/lobby/listeners/")).toEqual({ kind: "listeners" });
  });

  it("leaves /lobby the Lobby: two exact matches, neither shadowing the other", () => {
    expect(routeOf("/lobby")).toEqual({ kind: "lobby" });
  });

  it("makes no page of a near miss", () => {
    expect(routeOf("/lobby/listenersx")).toEqual({ kind: "unknown" });
  });
});

describe("the listeners page (spec §5.5)", () => {
  it("renders the directory for a browser holding a Lobby identity", async () => {
    const v = mountApp({ storage: joined() });
    await settle();
    expect(v.heading()).toBe(true);
  });

  it("asks for the first page exactly once", async () => {
    const v = mountApp({ storage: joined() });
    await settle();
    expect(v.calls(LISTENERS)).toBe(1);
  });

  it("shows a failed query's message rather than an empty directory", async () => {
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: fail("internal", "boom", 500) } });
    await settle();
    expect([v.heading(), !!screen.queryByText("boom")]).toEqual([true, true]);
  });

  it("offers the join form when this browser holds no credential", async () => {
    mountApp();
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }), !!screen.queryByRole("heading", { name: "Listeners" })])
      .toEqual([true, false]);
  });

  it("renders the directory in place once that join lands", async () => {
    const v = mountApp();
    await settle();
    await v.joinAs("dana");
    expect(v.heading()).toBe(true);
  });

  it("asks for its first page once that join lands, and once only", async () => {
    const v = mountApp();
    await settle();
    await v.joinAs("dana");
    expect(v.calls(LISTENERS)).toBe(1);
  });

  it("navigates nowhere to do it: this route is the destination", async () => {
    const v = mountApp();
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    await settle();
    await v.joinAs("dana");
    expect([location.pathname, pushed.mock.calls.length, replaced.mock.calls.length])
      .toEqual(["/lobby/listeners", 0, 0]);
  });

  // The test above runs on a durable store, where navigating away would have been safe anyway. This
  // is the browser the in-place rule exists for: the identity it just wrote reached this tab's
  // memory and nothing else, so a navigation would have left with the only copy of it.
  it("renders the directory in place for a browser whose join reached memory alone", async () => {
    const v = mountApp({ storage: memoryStorage({ durable: false }) });
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    await settle();
    await v.joinAs("dana");
    expect([v.heading(), pushed.mock.calls.length, replaced.mock.calls.length]).toEqual([true, 0, 0]);
  });

  it("says so on that browser: the not-persisting bar rides the directory", async () => {
    const v = mountApp({ storage: memoryStorage({ durable: false }) });
    await settle();
    await v.joinAs("dana");
    expect(!!screen.queryByRole("button", { name: "Dismiss" })).toBe(true);
  });

  // `client.withToken` builds a *new* `LoomClient` every call, so a reader rebuilt on every render
  // is a new object every render and re-fires every effect keyed on it. Dismissing the bar above is
  // a render this page already has, and it must not cost a second query.
  it("keeps its reader across a re-render, so dismissing the bar is not a second query", async () => {
    const notice = createPersistenceNotice();
    const v = mountApp({ storage: joined(), notice });
    await settle();
    notice.note("memory");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(v.calls(LISTENERS)).toBe(1);
  });

  it("says so when the instance has no Lobby, with the way back to the main page", async () => {
    mountApp({ storage: joined(), routes: { [LOBBY_URL]: fail("weave_not_found", "No Lobby", 404) } });
    await settle();
    expect([!!screen.queryByText("This instance has no Lobby yet."),
      screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")]).toEqual([true, "/"]);
  });

  it("shows the server's own message when where the Lobby is cannot be read at all", async () => {
    mountApp({ storage: joined(), routes: { [LOBBY_URL]: fail("internal", "boom", 500) } });
    await settle();
    expect([!!screen.queryByText("boom"), !!screen.queryByText("This instance has no Lobby yet.")])
      .toEqual([true, false]);
  });
});

describe("the directory grid and its counts (spec §5.3)", () => {
  const two = [listener("ada", "ada@example.com"), listener("bo", "bo@example.com")];

  it("renders one card per listener", async () => {
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: () => json(directory(two)) } });
    await settle();
    expect(v.names()).toEqual(["ada", "bo"]);
  });

  it("collapses the counts line when nothing has been filtered out", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: () => json(directory(two)) } });
    await settle();
    expect(!!screen.queryByText("Showing 2 of 2 listeners")).toBe(true);
  });

  it("names both numbers when a filter has narrowed the Lobby", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => listener(`a${i}`, "owner"));
    mountApp({ storage: joined(), routes: { [LISTENERS]: () => json(directory(rows, { matched: 87, total: 1204 })) } });
    await settle();
    // Locale-formatted, so the expectation is built the same way rather than pinning one locale's
    // thousands separator.
    expect(!!screen.queryByText(`Showing 50 of 87 matches (${(1204).toLocaleString()} listeners)`)).toBe(true);
  });

  it("says the Lobby is empty rather than that nothing matched, when nothing is there", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: () => json(directory([])) } });
    await settle();
    expect([!!screen.queryByText("Nobody has declared a profile yet."),
      !!screen.queryByText("No listener matches these filters.")]).toEqual([true, false]);
  });

  it("says nothing matched when the Lobby is not empty but the filters exclude everyone", async () => {
    mountApp({ path: `/lobby/listeners?${FILTERED}`, storage: joined(),
      routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    await settle();
    expect(!!screen.queryByText("No listener matches these filters.")).toBe(true);
  });

  it("clears the filters and asks again when Clear filters is clicked", async () => {
    const v = mountApp({ path: `/lobby/listeners?${FILTERED}`, storage: joined(),
      routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await settle();
    expect(v.queries().map((q) => q.has("filter"))).toEqual([true, false]);
  });
});

describe("the controls and the query string (spec §5.4)", () => {
  it("seeds every control from the link it was opened with", async () => {
    mountApp({ path: `/lobby/listeners?q=fable&${FILTERED}&sort=owner&dir=desc`, storage: joined() });
    await settle();
    expect([
      (screen.getByLabelText("Search") as HTMLInputElement).value,
      (screen.getByLabelText("sort") as HTMLSelectElement).value,
      (screen.getByLabelText("direction") as HTMLSelectElement).value,
      chip(/^shell/).getAttribute("aria-pressed"),
    ]).toEqual(["fable", "owner", "desc", "true"]);
  });

  it("asks for exactly what that link described", async () => {
    const v = mountApp({ path: `/lobby/listeners?q=fable&${FILTERED}&sort=owner&dir=desc`, storage: joined() });
    await settle();
    const q = v.queries()[0]!;
    expect([q.get("q"), q.get("filter"), q.get("sort"), q.get("dir"), q.get("limit")])
      .toEqual(["fable", '{"tools":["shell"]}', "owner", "desc", "50"]);
  });

  it("rewrites its own query string in place, and never pushes a history entry", async () => {
    mountApp({ storage: joined() });
    await settle();
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([new URLSearchParams(location.search).get("filter"), replaced.mock.calls.length, pushed.mock.calls.length])
      .toEqual(['{"tools":["shell"]}', 1, 0]);
  });

  it("sends the filter the chip turned on", async () => {
    const v = mountApp({ storage: joined() });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.queries().map((q) => q.get("filter"))).toEqual([null, '{"tools":["shell"]}']);
  });

  it("filters just the same when it was rendered in place", async () => {
    const v = mountRoute({ inPlace: true });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.queries().map((q) => q.get("filter"))).toEqual([null, '{"tools":["shell"]}']);
  });

  it("leaves the address bar entirely alone when it was rendered in place", async () => {
    mountRoute({ inPlace: true });
    await settle();
    const replaced = vi.spyOn(history, "replaceState");
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([replaced.mock.calls.length, location.search]).toEqual([0, ""]);
  });

  // Rendered in place the page was not *opened* with this URL: the address bar still names whatever
  // page the browser really loaded, and its query string is that page's, not this one's.
  it("reads none of the address bar's query string when it was rendered in place", async () => {
    const v = mountRoute({ inPlace: true, path: `/lobby?q=fable&${FILTERED}` });
    await settle();
    const q = v.queries()[0]!;
    expect([q.has("q"), q.has("filter")]).toEqual([false, false]);
  });

  it("says nothing about a link it was not opened with", async () => {
    mountRoute({ inPlace: true, path: "/lobby?filter=not-json" });
    await settle();
    expect(!!screen.queryByText("Part of this link was not understood, so it was ignored.")).toBe(false);
  });

  it("renders the directory for a link it could not read whole, with a note", async () => {
    const v = mountApp({ path: "/lobby/listeners?filter=not-json", storage: joined() });
    await settle();
    expect([v.heading(), !!screen.queryByText("Part of this link was not understood, so it was ignored.")])
      .toEqual([true, true]);
  });

  it("sends none of what it could not read", async () => {
    const v = mountApp({ path: "/lobby/listeners?filter=not-json", storage: joined() });
    await settle();
    expect(v.queries()[0]!.has("filter")).toBe(false);
  });

  it("waits for the typing to stop: three keystrokes inside the window are one request", async () => {
    vi.useFakeTimers();
    const v = mountApp({ storage: joined() });
    await settleFake();
    const box = screen.getByLabelText("Search");
    for (const s of ["f", "fa", "fab"]) fireEvent.input(box, { target: { value: s } });
    await vi.advanceTimersByTimeAsync(250);
    await settleFake();
    expect(v.calls(LISTENERS)).toBe(2);
  });

  it("and that one request carries the last thing typed", async () => {
    vi.useFakeTimers();
    const v = mountApp({ storage: joined() });
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
    const v = mountApp({ storage: joined(), ...opts });
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
    expect(v.calls(LISTENERS)).toBe(2);
  });

  it("leaves the filter in the address bar too", async () => {
    await typingThen(() => fireEvent.click(chip(/^shell/)));
    expect(new URLSearchParams(location.search).get("filter")).toBe('{"tools":["shell"]}');
  });

  it("supersedes it with a sort change the same way", async () => {
    const v = await typingThen(() =>
      fireEvent.change(screen.getByLabelText("sort"), { target: { value: "owner" } }));
    const last = v.queries().at(-1)!;
    expect([last.get("sort"), last.get("q"), v.calls(LISTENERS)]).toEqual(["owner", "fab", 2]);
  });

  it("lets Clear filters cancel it rather than be undone by it 250 ms later", async () => {
    const v = await typingThen(
      () => fireEvent.click(screen.getByRole("button", { name: "Clear filters" })),
      { path: `/lobby/listeners?${FILTERED}`, routes: { [LISTENERS]: () => json(directory([], { total: 5, matched: 0 })) } });
    const last = v.queries().at(-1)!;
    expect([last.has("filter"), last.has("q"), v.calls(LISTENERS)]).toEqual([false, false, 2]);
  });
});

describe("one query at a time (spec §7)", () => {
  /** Two control changes with the answers held: the older is released last, and must not paint. */
  async function twoInFlight(older: () => Response) {
    const first = gated(older);
    const second = gated(() => json(directory([listener("cy", "cy@example.com")])));
    const v = mountApp({ storage: joined(), routes: {
      [LISTENERS]: inTurn(() => json(directory([listener("ada", "ada@example.com")])), first.answer, second.answer),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    fireEvent.click(chip(/^node/));
    await settle();
    second.release();
    await settle();
    first.release();
    await settle();
    return v;
  }

  it("paints the newest answer and never the one it superseded", async () => {
    const v = await twoInFlight(() => json(directory([listener("bo", "bo@example.com")])));
    expect(v.names()).toEqual(["cy"]);
  });

  it("keeps the rows on screen while the next answer is still coming", async () => {
    const held = gated(() => json(directory([listener("bo", "bo@example.com")])));
    const v = mountApp({ storage: joined(), routes: {
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
    const before = joined().get(weaveKey(LOBBY.weaveId));
    const v = await twoInFlight(INVALID);
    expect(v.storage.get(weaveKey(LOBBY.weaveId))).toBe(before);
  });

  it("stays on the directory for a superseded query's 401, rather than falling back to the join form", async () => {
    const v = await twoInFlight(INVALID);
    expect([v.heading(), !!screen.queryByRole("heading", { name: "Join the Lobby" })]).toEqual([true, false]);
  });
});

describe("Show more (spec §5.3)", () => {
  const page1 = () => json(directory([listener("ada", "a"), listener("bo", "b")], { nextCursor: "c1", total: 3, matched: 3 }));

  it("sends the cursor the last answer gave it", async () => {
    const v = mountApp({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.queries()[1]!.get("cursor")).toBe("c1");
  });

  it("appends the next page below the rows already on screen, in order", async () => {
    const v = mountApp({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.names()).toEqual(["ada", "bo", "cy"]);
  });

  it("keeps the rows and the button when the next page fails, with the error beside it", async () => {
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect([v.names(), !!screen.queryByRole("button", { name: "Show more" }), !!screen.queryByText("boom")])
      .toEqual([["ada", "bo"], true, true]);
  });

  it("offers nothing more to show when the answer carried no cursor", async () => {
    mountApp({ storage: joined() });
    await settle();
    expect(!!screen.queryByRole("button", { name: "Show more" })).toBe(false);
  });

  // The facets describe the *filters*, which an appended page does not change, and §6 names the
  // facet pass the most expensive read this query makes.
  it("asks for no facets: appending a page cannot change them", async () => {
    const v = mountApp({ storage: joined(), routes: {
      [LISTENERS]: inTurn(page1, () => json(directory([listener("cy", "c")], { total: 3, matched: 3 }))),
    } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(v.queries()[1]!.get("facets")).toBe("false");
  });

  it("keeps the chips the facet-free answer did not carry", async () => {
    const appended = { ...directory([listener("cy", "c")], { total: 3, matched: 3 }), facets: undefined };
    mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, () => json(appended)) } });
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
    mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, slow.answer) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(!!screen.queryByRole("button", { name: "Show more" })).toBe(false);
    slow.release();
    await settle();
  });

  it("leaves it away when the fresh query fails, with the old rows and the reason", async () => {
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([!!screen.queryByRole("button", { name: "Show more" }), v.names(), !!screen.queryByText("boom")])
      .toEqual([false, ["ada", "bo"], true]);
  });

  it("brings it back on the new query's own cursor", async () => {
    const v = mountApp({ storage: joined(), routes: {
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
  const at = (filter: unknown, route: () => Response) => mountApp({ storage: joined(),
    path: `/lobby/listeners?filter=${encodeURIComponent(JSON.stringify(filter))}`,
    routes: { [LISTENERS]: route } });
  const disabled = (label: RegExp) => (chip(label) as HTMLButtonElement).disabled;

  it("bounds the search box at the hundred characters core accepts", async () => {
    mountApp({ storage: joined() });
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
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, REFUSED) } });
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
    const v = mountApp({ storage: joined(), routes: {
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
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([v.names(), !!screen.queryByText("boom")]).toEqual([["ada"], true]);
  });

  it("does not claim that nothing matched", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(!!screen.queryByText("No listener matches these filters.")).toBe(false);
  });

  it("says nothing in the counts line rather than saying zero", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(ada, fail("internal", "boom", 500)) } });
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
    mountApp(emptyUnderFilter);
    await settle();
    expect([chip(/^shell/).getAttribute("aria-pressed"), chip(/^shell/).textContent]).toEqual(["true", "shell 0"]);
  });

  it("clears that filter when the zero chip is clicked", async () => {
    const v = mountApp(emptyUnderFilter);
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(v.queries().map((q) => q.has("filter"))).toEqual([true, false]);
  });

  it("says in words that the model chips are any-of and the tool chips all-of", async () => {
    mountApp({ storage: joined() });
    await settle();
    expect([!!screen.queryByText("any of these"), !!screen.queryByText("all of these")]).toEqual([true, true]);
  });

  it("offers the model's efforts once that model is selected", async () => {
    const withEfforts = directory([listener("ada", "a")]);
    withEfforts.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    const v = mountRoute({ routes: { [LISTENERS]: () => json(withEfforts) } });
    await settle();
    const before = !!screen.queryByRole("button", { name: /^high/ });
    fireEvent.click(chip(/^opus-5/));
    await settle();
    expect([before, !!screen.queryByRole("button", { name: /^high/ })]).toEqual([false, true]);
  });

  it("turns the selected model into an exact pair when an effort is chosen", async () => {
    const withEfforts = directory([listener("ada", "a")]);
    withEfforts.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    const v = mountRoute({ routes: { [LISTENERS]: () => json(withEfforts) } });
    await settle();
    fireEvent.click(chip(/^opus-5/));
    await settle();
    fireEvent.click(chip(/^high/));
    await settle();
    expect(v.queries()[2]!.get("filter")).toBe('{"models":[{"model":"opus-5","effort":"high"}]}');
  });

  it("clears the serving policy when its own chip is clicked again", async () => {
    const v = mountRoute();
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
    mountRoute({ routes: { [LISTENERS]: () => json(cut) } });
    await settle();
    expect(!!screen.queryByText("20 most common")).toBe(true);
  });

  it("says an effort row was cut at ten when the answer says it was", async () => {
    const cut = directory([listener("ada", "a")]);
    cut.facets!.models.values[0]!.efforts = [{ value: "high", count: 1 }];
    cut.facets!.models.values[0]!.moreEfforts = true;
    mountRoute({ routes: { [LISTENERS]: () => json(cut) } });
    await settle();
    fireEvent.click(chip(/^opus-5/));
    await settle();
    expect(!!screen.queryByText("10 most common")).toBe(true);
  });

  it("chooses one serving policy at a time", async () => {
    const v = mountRoute();
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
    mountApp({ storage: joined() });
    await settle();
    expect(!!screen.queryByText(CHANGED)).toBe(false);
  });

  it("says so when a later answer counts the Lobby differently", async () => {
    const v = mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(
      () => json(directory([listener("ada", "a")], { total: 3 })),
      () => json(directory([listener("ada", "a")], { total: 4 })),
    ) } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect([!!screen.queryByText(CHANGED), v.heading()]).toEqual([true, true]);
  });
});

describe("a credential the Lobby refuses (spec §5.5)", () => {
  it("invalidates the identity, keeping the secret beside it", async () => {
    const v = mountApp({ storage: joinedWithSecret(),
      routes: { [LISTENERS]: inTurn(INVALID, () => json(directory([listener("ada", "a")]))) } });
    await settle();
    expect(readWeaveEntry(v.storage, LOBBY.weaveId))
      .toEqual({ secret: "lobby-secret", identity: "invalid" });
  });

  it("reads on with that stored secret", async () => {
    const v = mountApp({ storage: joinedWithSecret(),
      routes: { [LISTENERS]: inTurn(INVALID, () => json(directory([listener("ada", "a")]))) } });
    await settle();
    expect([v.authOf(1), v.names()]).toEqual(["Bearer lobby-secret", ["ada"]]);
  });

  it("offers the join form, and says why, when there is no secret to fall back to", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }),
      !!screen.queryByText("Your identity in the Lobby is no longer valid.")]).toEqual([true, true]);
  });

  it("reports a write it could not keep", async () => {
    const notice = createPersistenceNotice();
    mountApp({ storage: joinedInMemory(), notice, routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(notice.degraded()).toBe(true);
  });
});

/**
 * The end of the fallback chain. Retrying a refused *secret* with the same secret is the same
 * request again, forever: there is no second credential behind it and — unlike an identity — there
 * is nothing in storage to retire either. So the page settles rather than loops (spec §5.5).
 */
describe("a Lobby secret the instance refuses (spec §5.5)", () => {
  it("asks once and stops, rather than sending the same refused secret again", async () => {
    const v = mountApp({ storage: secretOnly(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(v.calls(LISTENERS)).toBe(1);
  });

  it("writes nothing to storage for it: a secret reader has no identity to invalidate", async () => {
    const storage = secretOnly();
    const writes = vi.spyOn(storage, "set");
    mountApp({ storage, routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(writes.mock.calls.length).toBe(0);
  });

  it("settles on the join form, saying what the Lobby refused", async () => {
    mountApp({ storage: secretOnly(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }),
      !!screen.queryByText("The Lobby refused the link this browser holds.")]).toEqual([true, true]);
  });

  // That fork replaces the page whole, header included, so without one there is no way out but the
  // address bar — which an in-place browser does not have either.
  it("keeps a way off the page on that fork", async () => {
    mountApp({ storage: secretOnly(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")).toBe("/");
  });

  it("retries a refused identity with the secret exactly once: two queries, and no third", async () => {
    const v = mountApp({ storage: joinedWithSecret(), routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(v.calls(LISTENERS)).toBe(2);
  });

  it("retires that identity once, and writes nothing more when the secret is refused too", async () => {
    const storage = joinedWithSecret();
    const writes = vi.spyOn(storage, "set");
    mountApp({ storage, routes: { [LISTENERS]: INVALID } });
    await settle();
    expect(writes.mock.calls.length).toBe(1);
  });
});

/**
 * A grid that changes under a human who is not looking at it has to say so. `CreateWeaveForm`'s
 * saved panel sets the precedent (`role="status"`): the page announces what it is doing rather than
 * relying on the eye catching a line of muted text.
 */
describe("the states this page says out loud (spec §5.3)", () => {
  it("announces a failed query as an alert", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: fail("internal", "boom", 500) } });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("announces a failed Show more beside its button", async () => {
    const page1 = () => json(directory([listener("ada", "a")], { nextCursor: "c1", total: 2, matched: 2 }));
    mountApp({ storage: joined(), routes: { [LISTENERS]: inTurn(page1, fail("internal", "boom", 500)) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("announces the refresh that is keeping the old rows on screen", async () => {
    const held = gated(() => json(directory([listener("bo", "b")])));
    mountApp({ storage: joined(), routes: {
      [LISTENERS]: inTurn(() => json(directory([listener("ada", "a")])), held.answer),
    } });
    await settle();
    fireEvent.click(chip(/^shell/));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("updating…");
  });

  it("announces the first load, which has no rows to keep", async () => {
    const held = gated(() => json(directory([])));
    mountApp({ storage: joined(), routes: { [LISTENERS]: held.answer } });
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });
});

describe("the way out of the directory (spec §5.3)", () => {
  it("is a link to the Lobby for a browser that may leave this JS context", async () => {
    mountApp({ storage: joined() });
    await settle();
    expect(screen.getByRole("link", { name: "Back to the Lobby" }).getAttribute("href")).toBe("/lobby");
  });

  it("is a button that renders the Lobby here for a browser that may not", async () => {
    const v = mountRoute({ storage: joinedInMemory() });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to the Lobby" }));
    expect(v.openInPlace.mock.calls).toEqual([[LOBBY.weaveId]]);
  });

  // It is the only exit an in-place browser has, so it may not wait for an answer that never comes.
  it("is on screen while the first query is still in flight", async () => {
    const held = gated(() => json(directory([])));
    mountApp({ storage: joined(), routes: { [LISTENERS]: held.answer } });
    await settle();
    expect(!!screen.queryByRole("link", { name: "Back to the Lobby" })).toBe(true);
  });

  it("is on screen when that query failed", async () => {
    mountApp({ storage: joined(), routes: { [LISTENERS]: fail("internal", "boom", 500) } });
    await settle();
    expect(!!screen.queryByRole("link", { name: "Back to the Lobby" })).toBe(true);
  });

  it("carries the wordmark home beside it", async () => {
    mountApp({ storage: joined() });
    await settle();
    expect(screen.getByRole("link", { name: "Loom" }).getAttribute("href")).toBe("/");
  });
});

/**
 * The Lobby sidebar's line (spec §5.1), where `ProfileCards` used to stack a card per listener.
 * Most of these hand the component a state, because the four states §5.1 words differently are
 * facts about two state cells and nothing else; the ones about *which element* the line is mount
 * the real page, because that answer comes from the storage this browser holds.
 */
describe("the Lobby sidebar's listeners line (spec §5.1)", () => {
  const WEAVE = { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" };
  /**
   * A loaded Lobby page's state, in the shapes the session actually produces: `getWeave` carries no
   * Lobby profile at all now (spec §3.1), so every participant here has `capabilities: null` and
   * the count beside the line is the only thing that knows how many listeners there are.
   */
  const lobbyState = (over: Partial<SessionState> = {}): SessionState => ({
    status: "ready", weave: WEAVE, lobby: LOBBY,
    threads: [], participants: [JOINED.participant], events: [],
    me: { participant: JOINED.participant, token: "participant-token" },
    connection: "open", needsName: false, instanceGuidelines: "",
    invitesForMe: new Set(), invited: {}, requests: {}, requestsLoaded: true, closedRequestsPage: 25,
    ...over,
  });
  /** The line's whole text, so "and nothing else" is assertable. */
  const line = (container: Element) => container.textContent ?? "";

  it("shows how many listeners the Lobby holds", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCount: 3 })} />);
    expect(line(container)).toBe("Listeners (3)");
  });

  // Before the first answer: no number, and not a word about a failure that has not happened.
  it("reads Listeners, with nothing beside it, before the first count answers", () => {
    const { container } = render(<ListenersLink state={lobbyState()} />);
    expect(line(container)).toBe("Listeners");
  });

  it("says the count is unavailable when the read failed and there is no number", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCountError: true })} />);
    expect(line(container)).toBe("Listenerscount unavailable");
  });

  // The rule that makes the whole thing worth having: an absent count is an absent number.
  it("never invents a zero for a count that failed", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCountError: true })} />);
    expect(line(container)).not.toContain("(0)");
  });

  it("keeps the last known number when a later count read fails, and says nothing beside it", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCount: 7, listenerCountError: true })} />);
    expect(line(container)).toBe("Listeners (7)");
  });

  it("drops that note again when a later count answers", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCount: 9, listenerCountError: false })} />);
    expect(line(container)).toBe("Listeners (9)");
  });

  // A zero the server actually answered is a number like any other: what §5.1 forbids is inventing
  // one, not reporting one.
  it("shows a zero the Lobby really answered", () => {
    const { container } = render(<ListenersLink state={lobbyState({ listenerCount: 0, listenerCountError: false })} />);
    expect(line(container)).toBe("Listeners (0)");
  });

  // A 401 on the own-profile read of a secret-link visit leaves the page ready with no `me` at all
  // (spec §3.3). The line needs none: it describes the Lobby, not the reader.
  it("works on a page that has fallen back to the Weave link and has no identity", () => {
    const { container } = render(
      <ListenersLink state={lobbyState({ me: undefined, readOnlyReason: "secret-fallback", listenerCount: 4 })} />,
    );
    expect(line(container)).toBe("Listeners (4)");
  });

  it("renders nothing on a Weave that is not the Lobby", () => {
    const { container } = render(
      <ListenersLink state={lobbyState({ weave: { ...WEAVE, id: "22222222-2222-4222-8222-222222222222" }, listenerCount: 3 })} />,
    );
    expect(container.innerHTML).toBe("");
  });

  // A reload keeps the Weave and the pointer on screen while it runs, and neither count cell is
  // cleared by it: a page that is not actually showing the Lobby has no directory to offer.
  it("renders nothing while the page is loading, Lobby or not", () => {
    const { container } = render(<ListenersLink state={lobbyState({ status: "loading", listenerCount: 3 })} />);
    expect(container.innerHTML).toBe("");
  });

  it("is a link to the directory when this browser may leave the page", () => {
    render(<ListenersLink state={lobbyState({ listenerCount: 3 })} />);
    expect(screen.getByRole("link", { name: "Listeners (3)" }).getAttribute("href")).toBe("/lobby/listeners");
  });

  // Never an anchor with a handler: an anchor can be middle-clicked or opened in a new tab, and
  // either one is the full page load that loses an in-memory credential.
  it("is a button carrying no href when it may not", () => {
    render(<ListenersLink state={lobbyState({ listenerCount: 3 })} openListenersInPlace={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Listeners (3)" }).getAttribute("href")).toBeNull();
  });

  it("renders the directory here when that button is clicked", () => {
    const openListenersInPlace = vi.fn();
    render(<ListenersLink state={lobbyState({ listenerCount: 3 })} openListenersInPlace={openListenersInPlace} />);
    fireEvent.click(screen.getByRole("button", { name: "Listeners (3)" }));
    expect(openListenersInPlace.mock.calls.length).toBe(1);
  });
});

/**
 * The same line on the real Lobby page: which element it is comes from the storage this browser
 * holds, and it is asked on every render (`WeaveRoute`'s `canLeave`), so a later durable write puts
 * the ordinary link back.
 */
describe("the listeners line on the Lobby page (spec §5.1)", () => {
  /** Everything a Lobby page reads, the two side reads included; an unstubbed path is a test bug. */
  const LOBBY_PAGE: Routes = {
    [`${BASE}/api/weaves/${LOBBY.weaveId}/events`]: () => json({ events: [] }),
    [`${BASE}/api/weaves/${LOBBY.weaveId}`]: () => json({
      weave: { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
      threads: [{ id: "g1", weaveId: LOBBY.weaveId, name: "General", isGeneral: true, createdBy: "p-dana", createdAt: "", closedAt: null, url: null }],
      // The shape `getWeave` really answers with in the Lobby now: the profile per participant is
      // exactly what stopped travelling (spec §3.1), which is why this sidebar counts instead.
      participants: [JOINED.participant],
    }),
    [`${BASE}/api/guidelines`]: () => json({ guidelines: "" }),
    [`${BASE}/api/requests`]: () => json({ requests: [] }),
    [`${BASE}/api/lobby/participants/me`]: () => json(JOINED.participant),
  };
  /** A Lobby that answers a count of its own, so the number on screen names this test. */
  const counted: Routes = { [LISTENERS]: () => json(directory([], { total: 12 })) };
  const mountLobby = (opts: MountOpts = {}) =>
    mountApp({ ...opts, path: "/lobby", routes: { ...LOBBY_PAGE, ...opts.routes } });

  it("is in the Lobby's sidebar, carrying the number the Lobby answered", async () => {
    const v = mountLobby({ storage: joined(), routes: counted });
    await settle();
    expect(v.container.querySelector(".sidebar")!.textContent).toContain("Listeners (12)");
  });

  // The removal itself: the sidebar used to stack a card per listener, and there is no card and no
  // section left to hold one.
  it("stacks no profile card there any more", async () => {
    const v = mountLobby({ storage: joined() });
    await settle();
    expect([!!v.container.querySelector(".profiles"), !!v.container.querySelector(".profile-card")])
      .toEqual([false, false]);
  });

  it("is a link for a browser whose credential would survive leaving the page", async () => {
    mountLobby({ storage: joined(), routes: counted });
    await settle();
    expect(screen.getByRole("link", { name: "Listeners (12)" }).getAttribute("href")).toBe("/lobby/listeners");
  });

  it("is a button for one whose credential lives only in this JS context", async () => {
    mountLobby({ storage: joinedInMemory(), routes: counted });
    await settle();
    expect(!!screen.queryByRole("button", { name: "Listeners (12)" })).toBe(true);
  });

  it("renders the directory here when that button is clicked", async () => {
    const v = mountLobby({ storage: joinedInMemory(),
      routes: { [LISTENERS]: () => json(directory([listener("ada", "ada@example.com")], { total: 12 })) } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Listeners (12)" }));
    await settle();
    expect([v.heading(), v.names()]).toEqual([true, ["ada"]]);
  });

  it("leaves the address bar alone when it does", async () => {
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    mountLobby({ storage: joinedInMemory(), routes: counted });
    await settle();
    push.mockClear();
    replace.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Listeners (12)" }));
    await settle();
    expect([location.pathname, push.mock.calls.length, replace.mock.calls.length]).toEqual(["/lobby", 0, 0]);
  });
});
