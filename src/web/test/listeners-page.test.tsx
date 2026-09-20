// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient, type Listener, type ListenersPage } from "@loom/client";
import { App, routeOf } from "../src/app.js";
import { memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice, type PersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";
import { setIdentity } from "../src/weaves-store.js";

// `http://loom.test` is refused by the client's own URL policy (http is allowed on loopback only,
// `src/client/src/url.ts`), so the stubbed instance speaks https to the same host: no request leaves
// the process either way.
const BASE = "https://loom.test";
const LOBBY = { weaveId: "11111111-1111-4111-8111-111111111111", title: "Lobby" };
const LOBBY_URL = `${BASE}/api/lobby`;
const JOIN = `${BASE}/api/lobby/join`;
/** The bare path the client sends when the page asks for the first page with no controls set. */
const LISTENERS = `${BASE}/api/lobby/listeners`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

type Routes = Record<string, () => Response | Promise<Response>>;

/** Every case is a table of URL → what the server answers; an unstubbed URL is a test bug, loudly. */
function stubFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`no stub for ${url}`);
    return route();
  });
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

function mountApp(opts: { path?: string; routes?: Routes; storage?: KeyValueStorage;
  notice?: PersistenceNotice } = {}) {
  history.replaceState(null, "", opts.path ?? "/lobby/listeners");
  const fetchStub = stubFetch({ ...INSTANCE, ...opts.routes });
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = opts.notice ?? createPersistenceNotice();
  const view = render(<App client={client} storage={storage} notice={notice} weaves={createWeavesSignal()} />);
  const field = () => screen.getByLabelText("Name") as HTMLInputElement;
  return {
    ...view, fetchStub, storage, notice,
    calls: (url: string) => fetchStub.mock.calls.filter((c) => String(c[0]) === url).length,
    heading: () => !!screen.queryByRole("heading", { name: "Listeners" }),
    joinAs: async (name: string) => {
      fireEvent.input(field(), { target: { value: name } });
      fireEvent.submit(field().closest("form")!);
      await settle();
    },
  };
}

/** A browser that has already joined the Lobby: the directory's ordinary starting point. */
function joined(): KeyValueStorage {
  const storage = memoryStorage();
  setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana" });
  return storage;
}

afterEach(() => { vi.restoreAllMocks(); });

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
    const v = mountApp({ storage: joined(),
      routes: { [LISTENERS]: () => json({ code: "internal", message: "boom" }, 500) } });
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
    mountApp({ storage: joined(),
      routes: { [LOBBY_URL]: () => json({ code: "weave_not_found", message: "No Lobby" }, 404) } });
    await settle();
    expect([!!screen.queryByText("This instance has no Lobby yet."),
      screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")]).toEqual([true, "/"]);
  });

  it("shows the server's own message when where the Lobby is cannot be read at all", async () => {
    mountApp({ storage: joined(), routes: { [LOBBY_URL]: () => json({ code: "internal", message: "boom" }, 500) } });
    await settle();
    expect([!!screen.queryByText("boom"), !!screen.queryByText("This instance has no Lobby yet.")])
      .toEqual([true, false]);
  });
});
