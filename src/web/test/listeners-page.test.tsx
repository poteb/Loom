// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient, type Listener, type ListenersPage } from "@loom/client";
import { App, routeOf } from "../src/app.js";
import { ListenersRoute } from "../src/components/listeners/ListenersRoute.js";
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
