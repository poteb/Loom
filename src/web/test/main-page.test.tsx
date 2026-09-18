// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient } from "@loom/client";
import { App } from "../src/app.js";
import { JoinLobbyForm } from "../src/components/main/JoinLobbyForm.js";
import { isValidName, suggestName } from "../src/name.js";
import { browserStorage, memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal, type WeavesSignal } from "../src/weaves-signal.js";
import { CLOSED_REQUESTS_PAGE } from "../src/session.js";
import { legacyKey, readWeaveEntry, saveWeaveEntry, setIdentity } from "../src/weaves-store.js";
import { PersistenceBar } from "../src/components/PersistenceBar.js";
import { InstanceGuidelines } from "../src/components/main/InstanceGuidelines.js";
import { LobbySummary } from "../src/components/main/LobbySummary.js";

// `http://loom.test` is refused by the client's own URL policy (http is allowed on loopback only,
// `src/client/src/url.ts`), so the stubbed instance speaks https to the same host: the scheme is
// nothing this form can observe, and no request leaves the process.
const BASE = "https://loom.test";
const JOIN = `${BASE}/api/lobby/join`;
const LOBBY = { weaveId: "11111111-1111-4111-8111-111111111111", title: "Lobby" };

/** The `JoinResult` a successful `POST /api/lobby/join` answers with. */
const JOINED = {
  weaveId: LOBBY.weaveId,
  weave: { id: LOBBY.weaveId, title: "Lobby", createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
  generalThreadId: "g1",
  participant: { id: "p-dana", weaveId: LOBBY.weaveId, name: "dana", kind: "human", role: "member", joinedAt: "", agentId: null, capabilities: null },
  token: "participant-token",
  guidelines: "",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Routes = Record<string, () => Response | Promise<Response>>;
const OK: Routes = { [JOIN]: () => json(JOINED) };
const TAKEN: Routes = { [JOIN]: () => json({ code: "name_taken", message: "Name already taken" }, 409) };

/** Every case is a table of URL → what the server answers; an unstubbed URL is a test bug, loudly. */
function stubFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`no stub for ${url}`);
    return route();
  });
}

/** A macrotask turn: it drains the join's await chain *and* Preact's microtask-scheduled rerender. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A localStorage that can refuse writes, so a non-durable join is reachable over a real store. */
let restoreLocalStorage: (() => void) | undefined;
function installThrowingLocalStorage() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const raw = new Map<string, string>();
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: (k: string) => { raw.delete(k); },
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() { return raw.size; },
    clear: () => raw.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true, writable: true });
  restoreLocalStorage = () => {
    if (prior) Object.defineProperty(globalThis, "localStorage", prior);
    else Reflect.deleteProperty(globalThis as object, "localStorage");
  };
}
afterEach(() => { restoreLocalStorage?.(); restoreLocalStorage = undefined; });

function mount(opts: { routes?: Routes; storage?: KeyValueStorage;
  onJoined?: (weaveId: string) => void; onJoinedInPlace?: (weaveId: string) => void } = {}) {
  const fetchStub = stubFetch(opts.routes ?? OK);
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = createPersistenceNotice();
  const onJoined = vi.fn(opts.onJoined);
  const onJoinedInPlace = vi.fn(opts.onJoinedInPlace);
  const view = render(
    <JoinLobbyForm client={client} storage={storage} notice={notice} lobby={LOBBY}
      onJoined={onJoined} onJoinedInPlace={onJoinedInPlace} />,
  );
  const field = () => screen.getByLabelText("Name") as HTMLInputElement;
  const joinButton = () => screen.getByRole("button", { name: "Join" }) as HTMLButtonElement;
  return {
    ...view, fetchStub, storage, notice, onJoined, onJoinedInPlace, field, joinButton,
    fill: (v: string) => fireEvent.input(field(), { target: { value: v } }),
    send: () => fireEvent.submit(field().closest("form")!),
    bodyOf: (i: number) => JSON.parse(String(fetchStub.mock.calls[i]![1]!.body)) as unknown,
  };
}

describe("the name rule (spec §4.1)", () => {
  for (const [label, name, ok] of [
    ["one character", "a", true],
    ["32 characters", "a".repeat(32), true],
    ["33 characters", "a".repeat(33), false],
    ["a space", "a b", false],
    ["an @", "a@b", false],
  ] as const) {
    it(`${ok ? "allows" : "refuses"} ${label}`, () => {
      const v = mount();
      v.fill(name);
      expect(v.joinButton().disabled).toBe(!ok);
    });
  }

  it("refuses an empty field, so Join is disabled before anything is typed", () => {
    expect(mount().joinButton().disabled).toBe(true);
  });
});

describe("suggestName (spec §4.1)", () => {
  it("offers the first free suffix", () => {
    expect(suggestName("dana")).toBe("dana-2");
  });

  it("counts up from a name that already carries one", () => {
    expect(suggestName("dana-2")).toBe("dana-3");
  });

  it("keeps the suggestion inside the rule it is a suggestion for", () => {
    const suggestion = suggestName("d".repeat(32));
    expect([suggestion.length <= 32, isValidName(suggestion)]).toEqual([true, true]);
  });
});

describe("JoinLobbyForm submit (spec §4.1)", () => {
  it("sends the typed name as a human — `kind` is not a field on the form", async () => {
    const v = mount();
    v.fill("dana");
    v.send();
    await flush();
    expect(v.bodyOf(0)).toEqual({ name: "dana", kind: "human" });
  });

  it("disables Join while the join is in flight, so one form cannot become two participants", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const v = mount({ routes: { [JOIN]: async () => { await gate; return json(JOINED); } } });
    v.fill("dana");
    v.send();
    await flush();
    expect(v.joinButton().disabled).toBe(true);
    release();
    await flush();
  });
});

describe("JoinLobbyForm persistence branch (spec §3.1, §4.1)", () => {
  it("hands a durable join to the caller that may navigate away", async () => {
    const v = mount();
    v.fill("dana");
    v.send();
    await flush();
    expect([v.onJoined.mock.calls, v.onJoinedInPlace.mock.calls]).toEqual([[[LOBBY.weaveId]], []]);
  });

  it("writes the identity with the display cache the join itself returned", async () => {
    const v = mount();
    v.fill("dana");
    v.send();
    await flush();
    const entry = readWeaveEntry(v.storage, LOBBY.weaveId);
    expect([entry?.token, entry?.participantId, entry?.name, entry?.title])
      .toEqual(["participant-token", "p-dana", "dana", "Lobby"]);
  });

  it("keeps a join whose credential did not persist in this JS context", async () => {
    installThrowingLocalStorage();
    const v = mount({ storage: browserStorage() });
    v.fill("dana");
    v.send();
    await flush();
    expect([v.onJoinedInPlace.mock.calls, v.onJoined.mock.calls]).toEqual([[[LOBBY.weaveId]], []]);
  });

  it("raises the persistence notice for that same join", async () => {
    installThrowingLocalStorage();
    const v = mount({ storage: browserStorage() });
    v.fill("dana");
    v.send();
    await flush();
    expect(v.notice.degraded()).toBe(true);
  });

  it("leaves the credential readable through the instance it was written to", async () => {
    // The whole point of the in-place branch: the destination is rendered against this very store,
    // so the token that never reached localStorage is still the one the Lobby session reads.
    installThrowingLocalStorage();
    const storage = browserStorage();
    const v = mount({ storage });
    v.fill("dana");
    v.send();
    await flush();
    expect(readWeaveEntry(storage, LOBBY.weaveId)?.token).toBe("participant-token");
  });
});

/**
 * Runs `fn` with vitest's own unhandled-rejection reporter detached, and answers with whatever was
 * rejected while it ran. The one test below deliberately throws out of a caller's callback, and the
 * point of that test is that the form neither catches it nor dresses it up as a failed join — so the
 * rejection has to land somewhere, and "somewhere" must not be the run's error list. Node crashes
 * the worker when no `unhandledRejection` listener is registered at all, hence a replacement one.
 *
 * `rawListeners`, not `listeners`: it answers with the wrappers, so a `once` listener put back below
 * is still a `once` listener (the wrapper removes itself when it fires) rather than a permanent one.
 * The reporter is detached process-wide while `fn` runs, so this assumes nothing else in this file
 * runs concurrently with it — which is this suite's setup (no `describe.concurrent`).
 */
async function whileIgnoringRejections(fn: () => Promise<void>): Promise<string[]> {
  const prior = process.rawListeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const seen: string[] = [];
  process.on("unhandledRejection", (e) => seen.push(e instanceof Error ? e.message : String(e)));
  try { await fn(); } finally {
    process.removeAllListeners("unhandledRejection");
    for (const l of prior) process.on("unhandledRejection", l as (e: unknown) => void);
  }
  return seen;
}

describe("JoinLobbyForm hand-over (spec §3.1, §4.1)", () => {
  it("never reports a join that succeeded as failed, whatever the caller's callback does", async () => {
    // The callback is picked inside the join's `try` and invoked outside it: an exception from the
    // destination is the destination's, and showing it here would invite a retry of a join that has
    // already happened — which answers `name_taken`.
    let v!: ReturnType<typeof mount>;
    const rejected = await whileIgnoringRejections(async () => {
      v = mount({ onJoined: () => { throw new Error("callback exploded"); } });
      v.fill("dana");
      v.send();
      await flush();
    });
    expect([v.container.querySelector(".error"), v.container.querySelector(".join-taken"),
      readWeaveEntry(v.storage, LOBBY.weaveId)?.token, rejected]).toEqual([null, null, "participant-token", ["callback exploded"]]);
  });
});

describe("JoinLobbyForm errors (spec §4.1, §6)", () => {
  it("covers both ways a name can already be in the Lobby", async () => {
    const v = mount({ routes: TAKEN });
    v.fill("dana");
    v.send();
    await flush();
    expect(v.container.querySelector(".join-taken")!.textContent).toContain(
      "dana is already in the Lobby. If that was you from a browser that did not save its key, "
      + "that identity cannot be recovered — pick another name.");
  });

  it("keeps the typed name in the field after name_taken", async () => {
    const v = mount({ routes: TAKEN });
    v.fill("dana");
    v.send();
    await flush();
    expect(v.field().value).toBe("dana");
  });

  it("fills the field from the suggestion without submitting it", async () => {
    const v = mount({ routes: TAKEN });
    v.fill("dana");
    v.send();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Try dana-2?" }));
    expect([v.field().value, v.fetchStub.mock.calls.length]).toEqual(["dana-2", 1]);
  });

  it("shows the server's own words for a validation failure", async () => {
    const message = "Name must be 1-32 characters of A-Z, a-z, 0-9, _ . -";
    const v = mount({ routes: { [JOIN]: () => json({ code: "validation", message }, 400) } });
    v.fill("dana");
    v.send();
    await flush();
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("says the instance has no Lobby yet when there is none", async () => {
    const v = mount({ routes: { [JOIN]: () => json({ code: "weave_not_found", message: "No lobby" }, 404) } });
    v.fill("dana");
    v.send();
    await flush();
    expect(screen.getByText("This instance has no Lobby yet.")).toBeTruthy();
  });

  it("says the server could not be reached when the request never lands", async () => {
    const v = mount({ routes: { [JOIN]: () => Promise.reject(new TypeError("fetch failed")) } });
    v.fill("dana");
    v.send();
    await flush();
    expect(screen.getByText("Could not reach the server.")).toBeTruthy();
  });

  it("keeps the typed name after a network failure, so the retry costs nothing", async () => {
    const v = mount({ routes: { [JOIN]: () => Promise.reject(new TypeError("fetch failed")) } });
    v.fill("dana");
    v.send();
    await flush();
    expect(v.field().value).toBe("dana");
  });
});

// --- The router (spec §3.1, §3.3) -------------------------------------------

const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "s".repeat(43);

/** The `WeaveInfo` shape `GET /api/weaves/:id` answers with; `p-dana` is the joined participant. */
const weaveInfo = (id: string, title: string) => ({
  weave: { id, title, createdAt: "", archivedAt: null, lastSeq: 0, guidelines: "" },
  threads: [{ id: "g1", weaveId: id, name: "General", isGeneral: true, createdBy: "p-dana", createdAt: "", closedAt: null, url: null }],
  participants: [JOINED.participant],
});

/** Everything one Weave page reads while it loads. */
function weaveRoutes(id: string, title: string): Routes {
  return {
    [`${BASE}/api/weaves/${id}`]: () => json(weaveInfo(id, title)),
    [`${BASE}/api/weaves/${id}/events?since=0&limit=1000`]: () => json({ events: [] }),
    [`${BASE}/api/guidelines`]: () => json({ guidelines: "" }),
    [`${BASE}/api/requests?status=open&limit=1000`]: () => json({ requests: [] }),
    ...Object.fromEntries(["filled", "expired", "cancelled"].map((s) =>
      [`${BASE}/api/requests?status=${s}&limit=${CLOSED_REQUESTS_PAGE}`, () => json({ requests: [] })])),
    // No WebSocket in these tests: a *fatal* ticket failure closes the stream once and leaves no
    // reconnect timer behind, and the page it belongs to renders exactly as it otherwise would.
    [`${BASE}/api/auth/ws-ticket`]: () => json({ code: "forbidden", message: "no stream in tests" }, 403),
  };
}
const LOBBY_URL = `${BASE}/api/lobby`;
const INSTANCE: Routes = { ...OK, [LOBBY_URL]: () => json(LOBBY), ...weaveRoutes(LOBBY.weaveId, "Lobby") };

/** Several macrotask turns: a route resolving, a session loading, and a rebuilt one loading again. */
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

function mountApp(opts: { path: string; routes?: Routes; storage?: KeyValueStorage; weaves?: WeavesSignal }) {
  history.replaceState(null, "", opts.path);
  const fetchStub = stubFetch({ ...INSTANCE, ...opts.routes });
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = createPersistenceNotice();
  const weaves = opts.weaves ?? createWeavesSignal();
  const view = render(<App client={client} storage={storage} notice={notice} weaves={weaves} />);
  const field = () => screen.getByLabelText("Name") as HTMLInputElement;
  return {
    ...view, fetchStub, storage, notice, weaves,
    calls: (url: string) => fetchStub.mock.calls.filter((c) => String(c[0]) === url).length,
    /** Who the page says I am, which is `state.me` and nothing else. */
    iAm: () => view.container.querySelector(".header-right strong")?.textContent ?? null,
    writable: () => !!view.container.querySelector(".composer"),
    joinAs: async (name: string) => {
      fireEvent.input(field(), { target: { value: name } });
      fireEvent.submit(field().closest("form")!);
      await settle();
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the unjoined Lobby (spec §3.3)", () => {
  it("offers the join form at /lobby when this browser holds no credential", async () => {
    mountApp({ path: "/lobby" });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }),
      !!screen.queryByText("This browser holds no key for this Weave.")]).toEqual([true, false]);
  });

  it("offers the same form at /weave/<lobbyId>, which carries no discovery of its own", async () => {
    const v = mountApp({ path: `/weave/${LOBBY.weaveId}` });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }), v.calls(LOBBY_URL)]).toEqual([true, 1]);
  });

  it("explains itself at /weave/<otherId>, where joining needs a credential this browser lacks", async () => {
    mountApp({ path: `/weave/${OTHER}` });
    await settle();
    expect([!!screen.queryByText("This browser holds no key for this Weave."),
      !!screen.queryByRole("heading", { name: "Join the Lobby" })]).toEqual([true, false]);
  });

  it("says so while it is still asking whether a credential-less link is the Lobby", async () => {
    // The whole duration of that request is a page with no card of its own: the generic explanation
    // would be the wrong one for the single Weave that needs no credential to join (spec §3.3).
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mountApp({ path: `/weave/${LOBBY.weaveId}`, routes: { [LOBBY_URL]: async () => { await gate; return json(LOBBY); } } });
    await flush();
    const seen = [!!screen.queryByText("Loading…"), !!screen.queryByText("This browser holds no key for this Weave.")];
    release();
    await settle();
    expect(seen).toEqual([true, false]);
  });

  it("offers the join form as soon as that answer arrives", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mountApp({ path: `/weave/${LOBBY.weaveId}`, routes: { [LOBBY_URL]: async () => { await gate; return json(LOBBY); } } });
    await flush();
    release();
    await settle();
    expect(!!screen.queryByRole("heading", { name: "Join the Lobby" })).toBe(true);
  });

  it("falls through to the explanation when where the Lobby is cannot be read at all", async () => {
    mountApp({ path: `/weave/${LOBBY.weaveId}`, routes: { [LOBBY_URL]: () => json({ code: "internal", message: "boom" }, 500) } });
    await settle();
    expect([!!screen.queryByText("This browser holds no key for this Weave."), !!screen.queryByText("Loading…")])
      .toEqual([true, false]);
  });

  it("asked where the Lobby is before saying so, and was answered", async () => {
    const v = mountApp({ path: `/weave/${OTHER}` });
    await settle();
    expect(v.calls(LOBBY_URL)).toBe(1);
  });

  it("asks nothing extra on a page that loaded with a stored token", async () => {
    // The fork's `getLobby()` belongs to the `no-credential` branch alone; the one call here is the
    // session's own discovery, which every load has always made.
    const storage = memoryStorage();
    setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana" });
    const v = mountApp({ path: `/weave/${LOBBY.weaveId}`, storage });
    await settle();
    expect([v.iAm(), v.calls(LOBBY_URL)]).toEqual(["dana", 1]);
  });
});

describe("joining from an unjoined Lobby page (spec §3.1, §3.3)", () => {
  for (const [label, path] of [["/lobby", "/lobby"], ["/weave/<lobbyId>", `/weave/${LOBBY.weaveId}`]] as const) {
    it(`leaves a durable join from ${label} in a loaded, writable Lobby session`, async () => {
      const v = mountApp({ path });
      await settle();
      await v.joinAs("dana");
      expect([v.iAm(), v.writable()]).toEqual(["dana", true]);
    });

    it(`leaves a non-durable join from ${label} in the same loaded, writable session, in place`, async () => {
      installThrowingLocalStorage();
      const v = mountApp({ path, storage: browserStorage() });
      await settle();
      await v.joinAs("dana");
      expect([v.iAm(), v.writable()]).toEqual(["dana", true]);
    });
  }

  it("leaves the URL alone after a join whose credential did not persist", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    await settle();
    await v.joinAs("dana");
    expect([location.pathname, pushed.mock.calls.length, replaced.mock.calls.length]).toEqual(["/lobby", 0, 0]);
  });
});

describe("the Lobby route (spec §3.1)", () => {
  it("says so while it is still finding out where the Lobby is", async () => {
    mountApp({ path: "/lobby", routes: { [LOBBY_URL]: () => new Promise<Response>(() => {}) } });
    await flush();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("says the instance has no Lobby yet when it has none", async () => {
    mountApp({ path: "/lobby", routes: { [LOBBY_URL]: () => json({ code: "weave_not_found", message: "No lobby" }, 404) } });
    await settle();
    expect(screen.getByText("This instance has no Lobby yet.")).toBeTruthy();
  });

  it("shows the error card when the Lobby pointer could not be read at all", async () => {
    const v = mountApp({ path: "/lobby", routes: { [LOBBY_URL]: () => json({ code: "internal", message: "boom" }, 500) } });
    await settle();
    expect(v.container.querySelector(".center.error")!.textContent).toContain("boom");
  });
});

describe("the other routes (spec §3.1)", () => {
  it("renders /w/<secret> exactly as before: the Weave, read as a guest", async () => {
    const v = mountApp({ path: `/w/${SECRET}`, routes: {
      [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: OTHER }),
      ...weaveRoutes(OTHER, "Test Weave"),
    } });
    await settle();
    expect([v.container.querySelector(".header h1")!.textContent, v.iAm(), v.writable()]).toEqual(["Test Weave", null, true]);
  });

  it("mounts no session on the main page", async () => {
    // The main page has two public reads of its own now, so "no request at all" is no longer the
    // rule — but the exact set is, and it still fails the moment a session (or anything else) adds
    // a call. An anonymous visitor asks for the guidelines and where the Lobby is, and nothing else.
    const v = mountApp({ path: "/" });
    await settle();
    expect([...new Set(v.fetchStub.mock.calls.map((c) => String(c[0])))].sort())
      .toEqual([`${BASE}/api/guidelines`, `${BASE}/api/lobby`]);
  });

  it("offers the main page from a path that is no page at all", async () => {
    const v = mountApp({ path: "/nope" });
    await settle();
    expect([v.container.textContent, v.container.querySelector("a")!.getAttribute("href")])
      .toEqual(["LoomNo such page. Go to the main page.", "/"]);
  });
});

// --- The main page (spec §4, §6) --------------------------------------------

const GUIDELINES_URL = `${BASE}/api/guidelines`;
const LOBBY_WEAVE_URL = `${BASE}/api/weaves/${LOBBY.weaveId}`;
const OPEN_REQUESTS_URL = `${BASE}/api/requests?status=open&limit=1000`;
const LEGACY_LOOKUP = `${BASE}/api/weaves/${SECRET}/lookup`;

/** The request headers the stub was called with for one URL — how "read with the stored token" is
 *  observed, rather than inferred from the answer coming back. */
function headersOf(stub: ReturnType<typeof stubFetch>, url: string): Record<string, string> {
  const call = stub.mock.calls.find((c) => String(c[0]) === url);
  return (call?.[1]?.headers ?? {}) as Record<string, string>;
}

describe("the persistence notice (spec §6)", () => {
  function mountBar() {
    const notice = createPersistenceNotice();
    const view = render(<PersistenceBar notice={notice} />);
    return { ...view, notice, bars: () => view.container.querySelectorAll(".persistence-bar").length };
  }

  it("stays out of the way while writes are persisting", () => {
    expect(mountBar().bars()).toBe(0);
  });

  it("appears the first time a write reports that nothing is being saved", async () => {
    const v = mountBar();
    v.notice.note("memory");
    await flush();
    expect(v.bars()).toBe(1);
  });

  it("is one bar per page load, however many later writes fail", async () => {
    const v = mountBar();
    v.notice.note("memory");
    await flush();
    v.notice.note("memory");
    await flush();
    expect(v.bars()).toBe(1);
  });

  it("goes away when it is dismissed", async () => {
    const v = mountBar();
    v.notice.note("memory");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await flush();
    expect(v.bars()).toBe(0);
  });

  it("says what is happening in the human's terms, never in the browser's", async () => {
    const v = mountBar();
    v.notice.note("memory");
    await flush();
    const text = v.container.textContent ?? "";
    expect([/quota/i.test(text), /localstorage/i.test(text),
      text.includes("This browser is not saving anything for this site")]).toEqual([false, false, true]);
  });
});

describe("the instance guidelines (spec §4.3)", () => {
  const RULES = Array.from({ length: 20 }, (_, i) => `rule ${i + 1}`).join("\n");
  function mountGuidelines(text: string) {
    const fetchStub = stubFetch({ [GUIDELINES_URL]: () => json({ guidelines: text }) });
    const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
    return { ...render(<InstanceGuidelines client={client} />), fetchStub };
  }

  it("renders the text as Markdown, through the renderer that escapes HTML", async () => {
    const v = mountGuidelines("**house rules**");
    await flush();
    expect(v.container.querySelector("strong")?.textContent).toBe("house rules");
  });

  it("collapses a long text at twelve lines", async () => {
    const v = mountGuidelines(RULES);
    await flush();
    const text = v.container.textContent ?? "";
    expect([text.includes("rule 12"), text.includes("rule 13")]).toEqual([true, false]);
  });

  it("shows the rest once Show all is clicked", async () => {
    const v = mountGuidelines(RULES);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await flush();
    expect(v.container.textContent).toContain("rule 20");
  });

  it("offers no Show all for a text that fits", async () => {
    mountGuidelines("rule 1\nrule 2");
    await flush();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("renders nothing at all when the instance has no guidelines", async () => {
    const v = mountGuidelines("");
    await flush();
    expect(v.container.innerHTML).toBe("");
  });
});

describe("the Lobby summary (spec §4.4)", () => {
  /** Three participants, two of them carrying a profile — the "listeners" of §4.4. */
  const people = (n: number, listeners: number) => Array.from({ length: n }, (_, i) => ({
    ...JOINED.participant, id: `p${i}`, name: `p${i}`, capabilities: i < listeners ? { runtime: "claude-code" } : null,
  }));
  const COUNTS: Routes = {
    [LOBBY_WEAVE_URL]: () => json({ ...weaveInfo(LOBBY.weaveId, "Lobby"), participants: people(3, 2) }),
    [OPEN_REQUESTS_URL]: () => json({ requests: [{ id: "r1" }] }),
  };
  function mountSummary(opts: { routes?: Routes; storage?: KeyValueStorage } = {}) {
    const fetchStub = stubFetch(opts.routes ?? {});
    const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
    const storage = opts.storage ?? memoryStorage();
    return { ...render(<LobbySummary client={client} storage={storage} lobby={LOBBY} />), fetchStub, storage };
  }
  function joinedStorage() {
    const storage = memoryStorage();
    setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p0", name: "dana" });
    return storage;
  }

  it("shows the title and what the Lobby is, and reads nothing, without a Lobby identity", async () => {
    const v = mountSummary();
    await settle();
    expect([v.container.textContent?.includes("Lobby"),
      !!screen.queryByText("Every agent on this instance is here; join to see who and what is being asked for."),
      v.fetchStub.mock.calls.length]).toEqual([true, true, 0]);
  });

  it("says so while the counts it is entitled to are still in flight", async () => {
    // A cell with a credential and no answer yet is `loading`, not empty (spec §6): a browser that
    // holds a token must not be shown the same nothing as one that holds none.
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const v = mountSummary({ storage: joinedStorage(), routes: {
      ...COUNTS, [LOBBY_WEAVE_URL]: async () => { await gate; return json(weaveInfo(LOBBY.weaveId, "Lobby")); } } });
    await flush();
    const seen = v.container.querySelector(".lobby-summary")!.textContent ?? "";
    release();
    await settle();
    expect(seen).toContain("Loading…");
  });

  it("counts participants, listeners and open requests once this browser holds a Lobby token", async () => {
    const v = mountSummary({ storage: joinedStorage(), routes: COUNTS });
    await settle();
    expect([...v.container.querySelectorAll(".lobby-counts li")].map((li) => li.textContent))
      .toEqual(["3 participants", "2 listeners", "1 open request"]);
  });

  it("reads those counts with the stored token", async () => {
    const v = mountSummary({ storage: joinedStorage(), routes: COUNTS });
    await settle();
    expect(headersOf(v.fetchStub, LOBBY_WEAVE_URL)["authorization"]).toBe("Bearer participant-token");
  });
});

describe("the main page (spec §4)", () => {
  function legacyStore() {
    const storage = memoryStorage();
    storage.set(legacyKey(SECRET), JSON.stringify({ token: "legacy-token", participantId: "p-old" }));
    return storage;
  }
  /** The page's own signal, plus a count of the bumps its writers made through it. */
  function countingSignal() {
    const inner = createWeavesSignal();
    let bumps = 0;
    const signal: WeavesSignal = { bump: () => { bumps++; inner.bump(); }, subscribe: inner.subscribe };
    return { signal, bumps: () => bumps };
  }

  it("keeps the rest of the page when the guidelines cannot be read", async () => {
    const v = mountApp({ path: "/", routes: { [GUIDELINES_URL]: () => json({ code: "internal", message: "boom" }, 500) } });
    await settle();
    expect([v.container.querySelector(".lobby-summary")?.textContent?.includes("Lobby"),
      !!screen.queryByRole("heading", { name: "Join the Lobby" })]).toEqual([true, true]);
  });

  it("says the instance has no Lobby yet, and offers no way in", async () => {
    mountApp({ path: "/", routes: { [LOBBY_URL]: () => json({ code: "weave_not_found", message: "No lobby" }, 404) } });
    await settle();
    expect([!!screen.queryByText("This instance has no Lobby yet."),
      !!screen.queryByRole("heading", { name: "Join the Lobby" }),
      !!screen.queryByRole("link", { name: "Open the Lobby" })]).toEqual([true, false, false]);
  });

  it("says it in the instance's own voice, not as a failed read", async () => {
    // "There is no Lobby" is this instance's answer (spec §4.4), not something that went wrong, and
    // the page must not dress it in the colour it uses for failures.
    const v = mountApp({ path: "/", routes: { [LOBBY_URL]: () => json({ code: "weave_not_found", message: "No lobby" }, 404) } });
    await settle();
    expect(v.container.querySelector(".lobby-summary .error")).toBeNull();
  });

  it("offers the join form to a browser that holds no Lobby identity", async () => {
    mountApp({ path: "/" });
    await settle();
    expect(!!screen.queryByRole("heading", { name: "Join the Lobby" })).toBe(true);
  });

  it("offers Open the Lobby, naming the participant, to a browser that already joined", async () => {
    const storage = memoryStorage();
    setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana", name: "dana" });
    const v = mountApp({ path: "/", storage });
    await settle();
    expect([screen.queryByRole("link", { name: "Open the Lobby" })?.getAttribute("href"),
      v.container.querySelector(".lobby-open")?.textContent,
      !!screen.queryByRole("heading", { name: "Join the Lobby" })])
      .toEqual(["/lobby", "You are in the Lobby as dana. Open the Lobby", false]);
  });

  it("offers the form again, and says why, for a Lobby identity that stopped working", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, LOBBY.weaveId, { identity: "invalid", title: "Lobby" });
    mountApp({ path: "/", storage });
    await settle();
    expect([!!screen.queryByRole("heading", { name: "Join the Lobby" }),
      !!screen.queryByText("The identity this browser had in the Lobby stopped working — join again.")])
      .toEqual([true, true]);
  });

  it("resolves the legacy entries this browser still holds, and says so per entry written", async () => {
    const w = countingSignal();
    mountApp({ path: "/", storage: legacyStore(), weaves: w.signal,
      routes: { [LEGACY_LOOKUP]: () => json({ weaveId: OTHER }) } });
    const atMount = w.bumps();
    await settle();
    expect([atMount, w.bumps()]).toEqual([0, 1]);
  });

  it("starts that pass once per page load, not once per render", async () => {
    // A bump re-renders this page, and a second pass would re-walk keys the first is still writing.
    // The lookup is held open on purpose, so the legacy key is still there for a second pass to find.
    let release: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => { release = r; });
    const w = countingSignal();
    const v = mountApp({ path: "/", storage: legacyStore(), weaves: w.signal, routes: { [LEGACY_LOOKUP]: () => gate } });
    await flush();
    w.signal.bump();
    await flush();
    w.signal.bump();
    await flush();
    const during = v.calls(LEGACY_LOOKUP);
    release(json({ weaveId: OTHER }));
    await settle();
    expect([during, v.calls(LEGACY_LOOKUP)]).toEqual([1, 1]);
  });

  it("renders the Lobby in place after a join from here whose credential did not persist", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    expect([v.iAm(), v.writable(), location.pathname]).toEqual(["dana", true, "/"]);
  });
});

describe("the not-persisting notice follows the page (spec §6)", () => {
  const bars = (c: ParentNode) => c.querySelectorAll(".persistence-bar").length;
  /** A Weave page reached by its own link, which writes its §10.9 entry as it loads. */
  const secretRoutes: Routes = {
    [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: OTHER }),
    ...weaveRoutes(OTHER, "Test Weave"),
  };

  it("warns on the Lobby the in-place join just rendered — the page the warning is about", async () => {
    // The join is the flow §4.1 raises the notice for, and it is also the flow that replaces the
    // main page: the bar has to exist on the destination or nobody is ever told.
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    expect(bars(v.container)).toBe(1);
  });

  it("lets that warning be dismissed where it is shown", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await flush();
    expect(bars(v.container)).toBe(0);
  });

  it("warns on a /w/<secret> page whose own entry write did not persist", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: `/w/${SECRET}`, storage: browserStorage(), routes: secretRoutes });
    await settle();
    expect(bars(v.container)).toBe(1);
  });

  it("stays quiet on a Weave page whose writes persisted", async () => {
    const v = mountApp({ path: `/w/${SECRET}`, routes: secretRoutes });
    await settle();
    expect(bars(v.container)).toBe(0);
  });

  it("is one notice for the page: dismissed on the main page, it does not come back on the Weave", async () => {
    // Every route is handed the same notice and only one is mounted at a time, so the latch — not a
    // count of components — is what makes it one bar and one dismissal per page load.
    installThrowingLocalStorage();
    const storage = browserStorage();
    storage.set(legacyKey(SECRET), JSON.stringify({ token: "legacy-token" }));
    const v = mountApp({ path: "/", storage, routes: { [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: OTHER }) } });
    await settle();                       // the migration's non-durable write raises it on `/`
    const onMain = bars(v.container);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await flush();
    await v.joinAs("dana");
    expect([onMain, bars(v.container)]).toEqual([1, 0]);
  });
});
