// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/preact";
import { render as paint } from "preact";
import { LoomClient } from "@loom/client";
import { App } from "../src/app.js";
import { JoinLobbyForm } from "../src/components/main/JoinLobbyForm.js";
import { isValidName, suggestName } from "../src/name.js";
import { browserStorage, memoryStorage, type KeyValueStorage, type WriteResult } from "../src/storage.js";
import { createPersistenceNotice, type PersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal, type WeavesSignal } from "../src/weaves-signal.js";
import { CLOSED_REQUESTS_PAGE } from "../src/session.js";
import {
  legacyKey, migrateLegacy, readWeaveEntry, saveWeaveEntry, setIdentity, weaveKey,
  type StoredWeave, type WeaveEntry,
} from "../src/weaves-store.js";
import { MyWeaves, foldRows, rowKey } from "../src/components/main/MyWeaves.js";
import { CreateWeaveForm } from "../src/components/main/CreateWeaveForm.js";
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

/**
 * A localStorage that refuses the writes `refuses` picks out — every write by default — so a
 * non-durable write is reachable over a real store. The per-key form exists for My Weaves, where
 * one entry has to fail to persist while the fixture around it was seeded normally; the value is
 * passed as well, for the quota-shaped store of §4.5 that keeps small entries and refuses big ones.
 */
let restoreLocalStorage: (() => void) | undefined;
function installLocalStorage(refuses: (key: string, value: string) => boolean = () => true) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const raw = new Map<string, string>();
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => { if (refuses(k, v)) throw new Error("QuotaExceededError"); raw.set(k, v); },
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
const installThrowingLocalStorage = () => installLocalStorage();
/**
 * What a store near its quota actually looks like: a small value still fits, a larger one does not.
 * It is the store that tells a one-write creation from a two-write one — a bare identity persists
 * under it while the identity *and the secret* together do not, so a creation that branched on the
 * small write's verdict would relax exactly where the secret was lost (spec §4.5).
 */
const installSizeLimitedLocalStorage = (limit: number) =>
  installLocalStorage((_k, v) => v.length > limit);

/**
 * A `navigator.clipboard` for one test, or — with `writeText` omitted — none at all, which is what
 * an insecure origin looks like: a self-hosted Loom reached over plain http on a LAN has no
 * clipboard API, and My Weaves must answer the click there too.
 */
let restoreClipboard: (() => void) | undefined;
function installClipboard(writeText?: () => unknown) {
  const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText: vi.fn(writeText) },
    configurable: true, writable: true,
  });
  restoreClipboard = () => {
    if (prior) Object.defineProperty(navigator, "clipboard", prior);
    else Reflect.deleteProperty(navigator as object, "clipboard");
  };
}
afterEach(() => { restoreClipboard?.(); restoreClipboard = undefined; });
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

function mountApp(opts: { path: string; routes?: Routes; storage?: KeyValueStorage; weaves?: WeavesSignal;
  notice?: PersistenceNotice }) {
  history.replaceState(null, "", opts.path);
  const fetchStub = stubFetch({ ...INSTANCE, ...opts.routes });
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  // Page-scoped and latching, so a test can hand in one that has already seen a failed write —
  // which is the state a Weave page reached through an in-place transition is in.
  const notice = opts.notice ?? createPersistenceNotice();
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
      // The bar as well as the session: this is the path §6 is most likely to be lost on, because
      // the join replaces the page the notice was raised on with the one it has to be seen on.
      expect([v.iAm(), v.writable(), v.container.querySelectorAll(".persistence-bar").length])
        .toEqual(["dana", true, 1]);
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

  it("says so on /w/<secret> when the stored identity is one the Weave no longer knows", async () => {
    // §2.6: the read succeeds with the link, but the identity behind it is gone — so the page is
    // read-only, says why, and offers the Join that is the way back.
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { token: "stale-token", participantId: "p-gone", name: "dana", secret: SECRET });
    const v = mountApp({ path: `/w/${SECRET}`, storage, routes: {
      [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: OTHER }),
      ...weaveRoutes(OTHER, "Test Weave"),
    } });
    await settle();
    expect([v.container.querySelector(".banner")?.textContent?.includes("no longer valid"),
      !!screen.queryByRole("button", { name: "Join" }), v.writable(), v.iAm()])
      .toEqual([true, true, false, null]);
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

/**
 * Every Weave page's way back to `/` (spec §3.1), and the mirror of the in-place exception: when
 * this session's credentials would not survive leaving the JS context, the header switches the
 * route here instead of navigating, and is a **button** rather than an anchor — an anchor can be
 * middle-clicked or opened in a new tab, which is the same full page load.
 */
describe("the way back to the main page from a Weave page (spec §3.1)", () => {
  const OTHER_ROUTES = weaveRoutes(OTHER, "Test Weave");
  const SECRET_ROUTES: Routes = { [`${BASE}/api/weaves/${SECRET}/lookup`]: () => json({ weaveId: OTHER }), ...OTHER_ROUTES };
  /** A browser that keeps what it is given, already holding the identity both Weaves need. */
  const durable = () => {
    const storage = memoryStorage();
    const who = { token: "participant-token", participantId: "p-dana", name: "dana" };
    setIdentity(storage, LOBBY.weaveId, who, { title: "Lobby" });
    setIdentity(storage, OTHER, who, { title: "Test Weave", secret: SECRET });
    return storage;
  };
  const homeLink = () => screen.queryByRole("link", { name: "Loom" });
  const homeButton = () => screen.queryByRole("button", { name: "Loom" });

  const paths: [string, string, Routes][] = [
    ["/lobby", "/lobby", {}],
    ["/weave/<id>", `/weave/${OTHER}`, OTHER_ROUTES],
    ["/w/<secret>", `/w/${SECRET}`, SECRET_ROUTES],
  ];
  for (const [label, path, routes] of paths) {
    it(`offers an ordinary link to / on ${label} when this browser persists what it writes`, async () => {
      const v = mountApp({ path, storage: durable(), routes });
      await settle();
      expect([v.iAm(), homeLink()?.getAttribute("href"), homeButton()]).toEqual(["dana", "/", null]);
    });
  }

  it("is a button with no href once this Weave's credential has reached only memory", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    expect([v.iAm(), homeLink(), !!homeButton()]).toEqual(["dana", null, true]);
  });

  // The broader half of the rule: the notice latches for the *page*, and the main page this button
  // leads to lists every entry the page holds — so once any write here has failed, leaving the JS
  // context is what costs something, whatever this one entry's verdict says.
  it("is a button too when some other write on this page did not persist", async () => {
    const notice = createPersistenceNotice();
    notice.note("memory");
    const v = mountApp({ path: "/lobby", storage: durable(), notice });
    await settle();
    expect([v.iAm(), homeLink(), !!homeButton()]).toEqual(["dana", null, true]);
  });

  it("renders the main page in place from that button, with the URL unchanged", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    await settle();
    await v.joinAs("dana");
    fireEvent.click(homeButton()!);
    await settle();
    expect([!!v.container.querySelector(".main-page"), location.pathname,
      pushed.mock.calls.length, replaced.mock.calls.length]).toEqual([true, "/lobby", 0, 0]);
  });

  it("shows that main page this page's own in-memory identity, and offers the Lobby in place", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    fireEvent.click(homeButton()!);
    await settle();
    expect([v.container.querySelector(".lobby-open")!.textContent,
      !!v.container.querySelector("button.lobby-open-inplace")]).toEqual(["You are in the Lobby as dana. Open the Lobby", true]);
  });

  it("goes back into the Lobby from there into the same writable session", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    fireEvent.click(homeButton()!);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open the Lobby" }));
    await settle();
    expect([v.iAm(), v.writable()]).toEqual(["dana", true]);
  });

  // The screens that replace the header are where a browser refusing to store anything is most
  // likely to end up: an identity invalidated on load, whose invalidation itself did not persist,
  // and no stored secret to fall back to. `/weave/<other>` is not the Lobby, so the fork's answer
  // leaves the generic explanation on screen — with the way back that matters.
  const DEAD: Routes = {
    [`${BASE}/api/weaves/${OTHER}`]: () => json({ code: "invalid_token", message: "gone" }, 401),
    [`${BASE}/api/weaves/${OTHER}/events?since=0&limit=1000`]: () => json({ code: "invalid_token", message: "gone" }, 401),
  };
  const heldNoSecret = (storage: KeyValueStorage) => {
    setIdentity(storage, OTHER, { token: "dead-token", participantId: "p-gone", name: "dana" }, { title: "Test Weave" });
    return storage;
  };

  it("offers an in-place button on the no-credential screen when nothing here persisted", async () => {
    installThrowingLocalStorage();
    mountApp({ path: `/weave/${OTHER}`, storage: heldNoSecret(browserStorage()), routes: DEAD });
    await settle();
    expect([!!screen.queryByText("This browser holds no key for this Weave."),
      screen.queryByRole("link", { name: "Go to the main page" }),
      !!screen.queryByRole("button", { name: "Go to the main page" })]).toEqual([true, null, true]);
  });

  it("renders the main page in place from there, with the URL unchanged", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: `/weave/${OTHER}`, storage: heldNoSecret(browserStorage()), routes: DEAD });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Go to the main page" }));
    await settle();
    expect([!!v.container.querySelector(".main-page"), location.pathname]).toEqual([true, `/weave/${OTHER}`]);
  });

  it("leaves that same screen an ordinary link when this browser does persist", async () => {
    mountApp({ path: `/weave/${OTHER}`, storage: heldNoSecret(memoryStorage()), routes: DEAD });
    await settle();
    expect([!!screen.queryByText("This browser holds no key for this Weave."),
      screen.getByRole("link", { name: "Go to the main page" }).getAttribute("href")]).toEqual([true, "/"]);
  });

  it("keeps exactly one not-persisting bar across the whole round trip", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/lobby", storage: browserStorage() });
    await settle();
    await v.joinAs("dana");
    const bars = [v.container.querySelectorAll(".persistence-bar").length];
    fireEvent.click(homeButton()!);
    await settle();
    bars.push(v.container.querySelectorAll(".persistence-bar").length);
    fireEvent.click(screen.getByRole("button", { name: "Open the Lobby" }));
    await settle();
    bars.push(v.container.querySelectorAll(".persistence-bar").length);
    expect(bars).toEqual([1, 1, 1]);
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

  // The §2.6 corner the bar used to be invisible in: the token is dead, there is no secret behind
  // it, and the invalidation that recorded that reached memory alone. The page ends at
  // `no-credential`, which is a state the bar has to survive or nobody is ever told.
  it("warns on a no-credential page whose invalidation reached memory alone", async () => {
    installThrowingLocalStorage();
    const storage = browserStorage();
    saveWeaveEntry(storage, OTHER, { token: "dead-token", participantId: "p-gone" });
    const refused = () => json({ code: "invalid_token", message: "Credential is not valid" }, 401);
    const v = mountApp({ path: `/weave/${OTHER}`, storage, routes: {
      ...weaveRoutes(OTHER, "Test Weave"),
      [`${BASE}/api/weaves/${OTHER}/events?since=0&limit=1000`]: refused,
      [weaveUrl(OTHER)]: refused,
    } });
    await settle();
    expect([bars(v.container), !!screen.queryByText("Your identity in this Weave is no longer valid")])
      .toEqual([1, true]);
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

// --- My Weaves (spec §4.2) --------------------------------------------------

const weaveUrl = (id: string) => `${BASE}/api/weaves/${id}`;
/** A usable identity, in the shape `saveWeaveEntry` takes it. */
const HELD = { token: "participant-token", participantId: "p-dana" };

/** The `WeaveInfo` a refresh reads, with an `archivedAt` a test can set. */
function weaveAnswer(id: string, title: string, archivedAt: string | null = null) {
  const info = weaveInfo(id, title);
  return { ...info, weave: { ...info.weave, archivedAt } };
}

type FetchStub = ReturnType<typeof stubFetch>;

/**
 * Lets the asynchronous half of My Weaves run to quiescence: a refresh answers, its write bumps the
 * signal, the re-render computes a new slice, and *that* render's effect may start the next request.
 * Preact flushes effects on its own animation-frame path outside `act`, so each round is an `act`
 * that first lets the pending promises land and then runs the effects they scheduled.
 */
const settleRows = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await settle(); }); };

function mountWeaves(opts: {
  storage?: KeyValueStorage; weaves?: WeavesSignal; lobbyWeaveId?: string;
  routes?: Routes; fetchStub?: FetchStub; onWrite?: (r: WriteResult) => void; notice?: PersistenceNotice;
} = {}) {
  const fetchStub = opts.fetchStub ?? stubFetch(opts.routes ?? {});
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const weaves = opts.weaves ?? createWeavesSignal();
  const notice = opts.notice ?? createPersistenceNotice();
  const onWrite = vi.fn(opts.onWrite ?? ((_r: WriteResult) => {}));
  const openInPlace = vi.fn();
  const view = render(
    <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={onWrite} notice={notice}
      openInPlace={openInPlace} lobbyWeaveId={opts.lobbyWeaveId} />,
  );
  const rows = () => [...view.container.querySelectorAll(".weave-row")];
  return {
    ...view, fetchStub, storage, weaves, notice, onWrite, openInPlace, rows,
    titles: () => rows().map((r) => r.querySelector(".weave-row-title")!.textContent),
    dead: (i: number) => rows()[i]!.classList.contains("weave-row-dead"),
    href: (i: number) => rows()[i]!.querySelector("a")?.getAttribute("href") ?? null,
  };
}

describe("My Weaves renders from storage (spec §4.2)", () => {
  it("paints every row it holds from the cache, before a single request", () => {
    // Rendered through Preact directly: @testing-library's `render` runs inside `act`, which flushes
    // the refresh effect, and what this asserts is the *first paint* — which §4.2 requires to need
    // no network at all, so that a browser with 300 entries paints instantly.
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Cached Weave" });
    const fetchStub = stubFetch({});
    const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
    const host = document.createElement("div");
    document.body.appendChild(host);
    paint(<MyWeaves client={client} storage={storage} weaves={createWeavesSignal()} onWrite={() => {}}
      notice={createPersistenceNotice()} openInPlace={() => {}} />, host);
    const painted = [host.textContent?.includes("Cached Weave"), fetchStub.mock.calls.length];
    paint(null, host);      // unmounted before the effect could be flushed: nothing is left behind
    host.remove();
    expect(painted).toEqual([true, 0]);
  });

  it("puts the most recently opened Weave first", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, "w-old", { title: "Old", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
    saveWeaveEntry(storage, "w-new", { title: "New", lastOpenedAt: "2026-02-01T00:00:00.000Z" });
    expect(mountWeaves({ storage }).titles()).toEqual(["New", "Old"]);
  });

  it("breaks a tie on the title", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, "w-b", { title: "Beta", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
    saveWeaveEntry(storage, "w-a", { title: "Alpha", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
    expect(mountWeaves({ storage }).titles()).toEqual(["Alpha", "Beta"]);
  });
});

describe("folding a legacy entry into an id entry (spec §2.4, §4.2)", () => {
  const idEntry = (extra: Partial<WeaveEntry> = {}): StoredWeave => ({ kind: "id", weaveId: OTHER, title: "Test Weave", ...extra });
  const legacyEntry = (secret = SECRET, token = "legacy-token"): StoredWeave => ({ kind: "legacy", secret, token });

  it("folds the two into one row when they share a secret", () => {
    expect(foldRows([idEntry({ secret: SECRET }), legacyEntry()]).length).toBe(1);
  });

  it("folds them when only the token matches", () => {
    expect(foldRows([idEntry({ token: "legacy-token", participantId: "p" }), legacyEntry("z".repeat(43))]).length).toBe(1);
  });

  it("lets the id entry win that fold", () => {
    const [row] = foldRows([idEntry({ secret: SECRET }), legacyEntry()]);
    expect([row!.weaveId, row!.title]).toEqual([OTHER, "Test Weave"]);
  });

  it("keeps a legacy entry nothing has resolved as a row of its own", () => {
    const [row] = foldRows([legacyEntry()]);
    expect([row!.weaveId, row!.secret]).toEqual([undefined, SECRET]);
  });

  it("gives that row a state of its own rather than borrowing one that renders nothing", () => {
    expect(foldRows([legacyEntry()])[0]!.state).toBe("unresolved");
  });

  it("identifies a row by its Weave id, or by its secret while it has none", () => {
    const [resolved] = foldRows([idEntry()]);
    const [unresolved] = foldRows([legacyEntry()]);
    expect([rowKey(resolved!), rowKey(unresolved!)]).toEqual([OTHER, `legacy:${SECRET}`]);
  });
});

describe("My Weaves row states (spec §4.2)", () => {
  const held = (entry: Partial<WeaveEntry>) => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { title: "Test Weave", ...entry });
    return storage;
  };

  it("says who this browser is joined as", () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { ...HELD, name: "dana" }, { title: "Test Weave" });
    mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect(screen.getByText("joined as dana")).toBeTruthy();
  });

  it("says a Weave this browser only holds a link for is read-only", () => {
    mountWeaves({ storage: held({ secret: SECRET }), routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect(screen.getByText("read-only — not joined")).toBeTruthy();
  });

  it("offers a rejoin where the identity died but the link survived", () => {
    mountWeaves({ storage: held({ identity: "invalid", secret: SECRET }),
      routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect(screen.getByText("your identity here stopped working — open to rejoin")).toBeTruthy();
  });

  it("greys a row with no credential left, offering only Forget", () => {
    const v = mountWeaves({ storage: held({ identity: "invalid" }) });
    expect([v.dead(0), v.href(0), !!screen.queryByRole("button", { name: /^Forget/ })]).toEqual([true, null, true]);
  });

  it("says a Weave the server no longer has is gone, and offers to forget it", async () => {
    const v = mountWeaves({ storage: held(HELD),
      routes: { [weaveUrl(OTHER)]: () => json({ code: "weave_not_found", message: "gone" }, 404) } });
    await settleRows();
    expect([!!screen.queryByText("this Weave is gone"), v.dead(0), !!screen.queryByRole("button", { name: /^Forget/ })])
      .toEqual([true, true, true]);
  });

  it("offers no Copy link on a Weave that is gone, whose link leads nowhere either", async () => {
    mountWeaves({ storage: held({ ...HELD, secret: SECRET }),
      routes: { [weaveUrl(OTHER)]: () => json({ code: "weave_not_found", message: "gone" }, 404) } });
    await settleRows();
    expect(screen.queryByRole("button", { name: /^Copy link/ })).toBeNull();
  });

  it("keeps the cached title and the link when a refresh fails on the network", async () => {
    const v = mountWeaves({ storage: held(HELD),
      routes: { [weaveUrl(OTHER)]: () => Promise.reject(new TypeError("fetch failed")) } });
    await settleRows();
    expect([v.titles(), !!screen.queryByText("could not refresh"), v.href(0)])
      .toEqual([["Test Weave"], true, `/weave/${OTHER}`]);
  });
});

/**
 * One rule, both directions (spec §3.1, §4.2). A row asked only about **its own** entry, so on a
 * page that has already failed a write, a durable row's `<a>` was a full page load that would have
 * destroyed every *other* memory-only entry this browser holds — the very loss the header's own
 * link refuses to risk. `leavingIsSafe` is now the one question, asked the same way on both sides.
 */
describe("My Weaves and the one rule for leaving (spec §3.1, §4.2)", () => {
  const durableRow = () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { ...HELD, name: "dana" }, { title: "Test Weave" });
    return storage;
  };
  const routes: Routes = { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) };

  it("leaves a durable row an ordinary link while every write on this page has persisted", () => {
    const v = mountWeaves({ storage: durableRow(), routes });
    expect([v.container.querySelector(".weave-row-title")!.tagName, v.href(0)]).toEqual(["A", `/weave/${OTHER}`]);
  });

  it("opens even a durable row in place once some write on this page has not", () => {
    const notice = createPersistenceNotice();
    notice.note("memory");
    const v = mountWeaves({ storage: durableRow(), routes, notice });
    const title = v.container.querySelector(".weave-row-title")!;
    fireEvent.click(title);
    expect([title.tagName, title.getAttribute("href"), v.openInPlace.mock.calls])
      .toEqual(["BUTTON", null, [[OTHER]]]);
  });

  it("still opens a memory-only row in place on a page whose other writes were fine", () => {
    installLocalStorage((k) => k === weaveKey(OTHER));
    const storage = browserStorage();
    setIdentity(storage, OTHER, { ...HELD, name: "dana" }, { title: "Test Weave" });
    const v = mountWeaves({ storage, routes });
    expect(v.container.querySelector(".weave-row-title")!.tagName).toBe("BUTTON");
  });
});

describe("My Weaves row actions (spec §4.2, §5)", () => {
  it("removes the entry and the row when Forget is clicked", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { identity: "invalid", title: "Test Weave" });
    const v = mountWeaves({ storage });
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }));
    await flush();
    expect([v.rows().length, readWeaveEntry(storage, OTHER)]).toEqual([0, undefined]);
  });

  it("names each row's buttons after the row they belong to", () => {
    // A list of 25 rows is 25 identically named buttons otherwise, which is no help to anyone
    // reaching them by name — a screen reader, or a test.
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Test Weave" });
    saveWeaveEntry(storage, "w-dead", { identity: "invalid", title: "Dead Weave" });
    mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect([!!screen.queryByRole("button", { name: "Copy link to Test Weave" }),
      !!screen.queryByRole("button", { name: "Forget Dead Weave" })]).toEqual([true, true]);
  });

  it("offers Copy link where the entry carries a secret", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Test Weave" });
    mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect(!!screen.queryByRole("button", { name: /^Copy link/ })).toBe(true);
  });

  it("offers none where it does not", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Test Weave" });
    mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect(screen.queryByRole("button", { name: /^Copy link/ })).toBeNull();
  });

  it("links the row to the Weave id and never puts the secret in the markup", () => {
    // §5: the address bar must not gain a secret it did not already have, so a row that knows one
    // still links to `/weave/<id>`.
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, secret: SECRET, title: "Test Weave" });
    const v = mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    expect([v.href(0), v.container.innerHTML.includes(SECRET)]).toEqual([`/weave/${OTHER}`, false]);
  });

  it("badges the Lobby row", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { title: "Test Weave" });
    mountWeaves({ storage, lobbyWeaveId: OTHER });
    expect(!!screen.queryByText("Lobby")).toBe(true);
  });

  it("badges an archived row", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { title: "Test Weave", archived: true });
    mountWeaves({ storage });
    expect(!!screen.queryByText("Archived")).toBe(true);
  });
});

describe("Copy link always answers (spec §4.2, §5)", () => {
  const LINK = () => `${location.origin}/w/${SECRET}`;
  function mountWithSecret() {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Test Weave" });
    return mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
  }
  const clickCopy = () => fireEvent.click(screen.getByRole("button", { name: /^Copy link/ }));
  const field = (v: { container: Element }) => v.container.querySelector(".weave-row-link") as HTMLInputElement | null;

  it("says so when the clipboard took the link", async () => {
    installClipboard(async () => {});
    const v = mountWithSecret();
    clickCopy();
    await flush();
    expect([!!screen.queryByText("Copied"), field(v)]).toEqual([true, null]);
  });

  it("keeps the secret out of the markup on that path", async () => {
    // §5 still holds where the copy worked: only the fallback below may show it, and only after a
    // click on that row. The field is asserted absent as well as the markup checked — Preact sets
    // an input's `value` as a property, so `innerHTML` alone would not see it.
    installClipboard(async () => {});
    const v = mountWithSecret();
    clickCopy();
    await flush();
    expect([v.container.innerHTML.includes(SECRET), field(v)]).toEqual([false, null]);
  });

  it("shows the same fallback when the clipboard throws instead of rejecting", async () => {
    // Some implementations throw synchronously — an unfocused document, a denied permission —
    // rather than answering with a rejected promise.
    installClipboard(() => { throw new Error("document is not focused"); });
    const v = mountWithSecret();
    clickCopy();
    await flush();
    expect(field(v)?.value).toBe(LINK());
  });

  it("shows the link to copy by hand where the browser has no clipboard at all", async () => {
    // A self-hosted Loom reached over plain http on a LAN is an insecure origin, where
    // `navigator.clipboard` does not exist: the button must not be a silent no-op there.
    installClipboard(undefined);
    const v = mountWithSecret();
    clickCopy();
    await flush();
    expect(field(v)?.value).toBe(LINK());
  });

  it("shows the same fallback when the clipboard refuses", async () => {
    installClipboard(async () => { throw new Error("denied"); });
    const v = mountWithSecret();
    const rejected = await whileIgnoringRejections(async () => { clickCopy(); await settle(); });
    expect([field(v)?.value, rejected]).toEqual([LINK(), []]);
  });

  it("hides the fallback, and the secret with it, when Hide is clicked", async () => {
    // The field's only other exits are a filter keystroke, "Show more", Forget and unmount — and a
    // list of eight rows or fewer has no filter box at all, so without this the link stays legible
    // until the page is left.
    installClipboard(undefined);
    const v = mountWithSecret();
    clickCopy();
    await flush();
    const shown = field(v)?.value;
    fireEvent.click(screen.getByRole("button", { name: /^Hide/ }));
    await flush();
    expect([shown, field(v), v.container.innerHTML.includes(SECRET)]).toEqual([LINK(), null, false]);
  });

  it("closes one row's fallback when another row's is opened", async () => {
    const OTHER_SECRET = "z".repeat(43);
    installClipboard(undefined);
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Alpha" });
    saveWeaveEntry(storage, "w-beta", { secret: OTHER_SECRET, title: "Beta" });
    const v = mountWeaves({ storage, routes: {
      [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Alpha")),
      [weaveUrl("w-beta")]: () => json(weaveAnswer("w-beta", "Beta")) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy link to Alpha" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy link to Beta" }));
    await flush();
    expect([v.container.querySelectorAll(".weave-row-link").length, field(v)?.value])
      .toEqual([1, `${location.origin}/w/${OTHER_SECRET}`]);
  });

  it("clears the marker on the next interaction with the list", async () => {
    installClipboard(async () => {});
    const storage = memoryStorage();
    // Nine rows, so the filter box is on screen; only the first carries a secret, so only that one
    // row asks the server anything.
    for (let i = 0; i < 9; i++) saveWeaveEntry(storage, `w-${pad(i)}`, { title: `Weave ${pad(i)}` });
    saveWeaveEntry(storage, "w-00", { secret: SECRET });
    const v = mountWeaves({ storage, routes: { [weaveUrl("w-00")]: () => json(weaveAnswer("w-00", "Weave 00")) } });
    fireEvent.click(screen.getByRole("button", { name: /^Copy link/ }));
    await flush();
    const copied = !!screen.queryByText("Copied");
    fireEvent.input(screen.getByLabelText("Filter"), { target: { value: "Weave 0" } });
    await flush();
    expect([copied, !!screen.queryByText("Copied"), v.rows().length > 0]).toEqual([true, false, true]);
  });
});

/** Thirty-two id rows, each with a cached title equal to its id, so ordering and the filter are
 *  both readable straight off the fixture. */
const pad = (i: number) => String(i).padStart(2, "0");
const BOUND_IDS = Array.from({ length: 32 }, (_, i) => `weave-${pad(i)}`);
/** The row a migration adds mid-flight; it sorts between `weave-00` and `weave-01`. */
const MIGRATED = "weave-00a";

function boundStorage(count = BOUND_IDS.length, inner: KeyValueStorage = memoryStorage()) {
  for (const id of BOUND_IDS.slice(0, count)) saveWeaveEntry(inner, id, { ...HELD, title: id });
  return inner;
}

/**
 * A `getWeave` that never answers on its own: it records the id, counts what is in flight, keeps a
 * running maximum, and hands back a promise the test releases. The running maximum is the point —
 * no test has to guess the instant at which to look at the bound.
 */
function heldWeaves() {
  const held = new Map<string, (r: Response) => void>();
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchStub = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const id = String(input).slice(`${BASE}/api/weaves/`.length);
    calls.push(id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return await new Promise<Response>((resolve) => {
      held.set(id, (r) => { inFlight -= 1; held.delete(id); resolve(r); });
    });
  });
  const releaseAll = async () => {
    for (let turn = 0; turn < 24 && held.size > 0; turn++) {
      await act(async () => {
        for (const [id, release] of [...held]) release(json(weaveAnswer(id, id)));
        await settle();
      });
    }
  };
  return { fetchStub, calls, releaseAll, maxInFlight: () => maxInFlight };
}

/** Two fresh slices while the first six are still unanswered: a filter typed and cleared, then
 *  "Show more". With a scheduler built per render, this is where the seventh request starts. */
async function changeTheSliceWhileBlocked() {
  await flush();
  const box = () => screen.getByLabelText("Filter") as HTMLInputElement;
  fireEvent.input(box(), { target: { value: "weave-2" } });
  await flush();
  fireEvent.input(box(), { target: { value: "" } });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await flush();
}

describe("the My Weaves filter box (spec §4.2)", () => {
  /** Title-only entries: this browser holds no credential for any of them, so the list is long
   *  without a single request to get in the way of what these tests are about. */
  function titlesOnly(names: string[]) {
    const storage = memoryStorage();
    for (const [i, title] of names.entries()) saveWeaveEntry(storage, `w-${pad(i)}`, { title });
    return storage;
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) => `Weave ${pad(i)}`);

  it("offers no filter box for a list short enough to read", () => {
    mountWeaves({ storage: titlesOnly(many(8)) });
    expect(screen.queryByLabelText("Filter")).toBeNull();
  });

  it("offers one past eight rows", () => {
    mountWeaves({ storage: titlesOnly(many(9)) });
    expect(!!screen.queryByLabelText("Filter")).toBe(true);
  });

  it("narrows by title, whatever case it is typed in", async () => {
    const v = mountWeaves({ storage: titlesOnly([...many(8), "Alpha"]) });
    fireEvent.input(screen.getByLabelText("Filter"), { target: { value: "ALPHA" } });
    await flush();
    expect(v.titles()).toEqual(["Alpha"]);
  });

  it("says so rather than showing an empty list when nothing matches", async () => {
    const v = mountWeaves({ storage: titlesOnly(many(9)) });
    fireEvent.input(screen.getByLabelText("Filter"), { target: { value: "nothing like this" } });
    await flush();
    expect([v.rows().length, !!screen.queryByText("No Weave matches.")]).toEqual([0, true]);
  });

  it("keeps the box while a filter is typed, however short the list gets", async () => {
    // Forgetting down to eight rows would otherwise take the box away with the filter still in
    // force, leaving "No Weave matches." and no control to clear it.
    const storage = titlesOnly(many(9));
    for (let i = 0; i < 9; i++) saveWeaveEntry(storage, `w-${pad(i)}`, { identity: "invalid" });
    mountWeaves({ storage });
    fireEvent.input(screen.getByLabelText("Filter"), { target: { value: "Weave" } });
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: /^Forget/ })[0]!);
    await flush();
    expect([!!screen.queryByLabelText("Filter"), screen.getAllByRole("listitem").length]).toEqual([true, 8]);
  });
});

describe("the refresh bound is total across renders (spec §4.2)", () => {
  it("starts the first six rows of the slice, and only those", async () => {
    const f = heldWeaves();
    mountWeaves({ storage: boundStorage(), fetchStub: f.fetchStub });
    await flush();
    expect([f.calls, f.maxInFlight()]).toEqual([BOUND_IDS.slice(0, 6), 6]);
  });

  it("starts nothing new for the slices the filter and Show more bring on screen", async () => {
    const f = heldWeaves();
    mountWeaves({ storage: boundStorage(), fetchStub: f.fetchStub });
    await changeTheSliceWhileBlocked();
    expect([f.calls.length, f.maxInFlight()]).toEqual([6, 6]);
  });

  it("starts nothing new for a row a bump adds while those six are blocked", async () => {
    const f = heldWeaves();
    const storage = boundStorage();
    const weaves = createWeavesSignal();
    const v = mountWeaves({ storage, weaves, fetchStub: f.fetchStub });
    await changeTheSliceWhileBlocked();
    saveWeaveEntry(storage, MIGRATED, { ...HELD, title: MIGRATED });
    await act(() => { weaves.bump(); });
    expect([f.calls.length, f.maxInFlight(), v.titles().includes(MIGRATED)]).toEqual([6, 6, true]);
  });

  it("drains every row exactly once, never more than six at a time", async () => {
    const f = heldWeaves();
    const storage = boundStorage();
    const weaves = createWeavesSignal();
    mountWeaves({ storage, weaves, fetchStub: f.fetchStub });
    await changeTheSliceWhileBlocked();
    saveWeaveEntry(storage, MIGRATED, { ...HELD, title: MIGRATED });
    await act(() => { weaves.bump(); });
    await f.releaseAll();
    await settleRows();
    const expected = [...BOUND_IDS, MIGRATED].sort();
    expect([[...new Set(f.calls)].sort(), f.calls.length, f.maxInFlight()])
      .toEqual([expected, expected.length, 6]);
  });

  it("asks for nothing that is behind Show more", async () => {
    const f = heldWeaves();
    mountWeaves({ storage: boundStorage(30), fetchStub: f.fetchStub });
    await f.releaseAll();
    await settleRows();
    expect([f.calls.includes("weave-24"), f.calls.includes("weave-25")]).toEqual([true, false]);
  });
});

describe("My Weaves refreshes one row (spec §4.2, §2.6)", () => {
  /** Answers `401` to the stored token and the real thing to the stored secret — the two credentials
   *  §2.6 distinguishes, told apart by the header they arrive in. */
  const tokenIsDead = (id: string, title: string) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== weaveUrl(id)) throw new Error(`no stub for ${String(input)}`);
    const auth = ((init?.headers ?? {}) as Record<string, string>)["authorization"];
    return auth === `Bearer ${SECRET}`
      ? json(weaveAnswer(id, title))
      : json({ code: "invalid_token", message: "dead" }, 401);
  });

  it("reads a row this browser only holds a link for with that link's secret", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Old" });
    const v = mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New")) } });
    await settleRows();
    expect(headersOf(v.fetchStub, weaveUrl(OTHER))["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("updates that row's cached title from the answer", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { secret: SECRET, title: "Old" });
    const v = mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New")) } });
    await settleRows();
    expect(v.titles()).toEqual(["New"]);
  });

  it("reads an invalidated row through the secret it kept", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { identity: "invalid", secret: SECRET, title: "Old" });
    const v = mountWeaves({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New")) } });
    await settleRows();
    expect(headersOf(v.fetchStub, weaveUrl(OTHER))["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("deletes the identity a 401 proved dead, and keeps the secret beside it", async () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p", name: "dana" }, { secret: SECRET, title: "Old" });
    mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    const e = readWeaveEntry(storage, OTHER);
    expect([e?.token, e?.participantId, e?.name, e?.identity, e?.secret])
      .toEqual([undefined, undefined, undefined, "invalid", SECRET]);
  });

  it("moves that row to the identity-stopped-working state", async () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { secret: SECRET, title: "Old" });
    mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    expect(!!screen.queryByText("your identity here stopped working — open to rejoin")).toBe(true);
  });

  it("retries once with the secret, and takes the title from that answer", async () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { secret: SECRET, title: "Old" });
    const v = mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    expect([v.fetchStub.mock.calls.length, v.titles()]).toEqual([2, ["New"]]);
  });

  it("makes no second attempt for a dead token with no secret behind it", async () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { title: "Old" });
    const v = mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    expect(v.fetchStub.mock.calls.length).toBe(1);
  });

  it("leaves that row unavailable, with Forget", async () => {
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { title: "Old" });
    const v = mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    expect([v.dead(0), !!screen.queryByRole("button", { name: /^Forget/ })]).toEqual([true, true]);
  });

  it("explains that row by what the entry now says, not as something that might work next time", async () => {
    // The 401 ended the row: the entry itself explains it. Falling through to the refresh's own
    // "could not refresh" would mask that sentence with a transient-sounding one.
    const storage = memoryStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { title: "Old" });
    mountWeaves({ storage, fetchStub: tokenIsDead(OTHER, "New") });
    await settleRows();
    expect([!!screen.queryByText("your identity here stopped working, and this browser has no link for it"),
      !!screen.queryByText("could not refresh")]).toEqual([true, false]);
  });

  it("asks for nothing at all for a row with neither an identity nor a secret", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { title: "Test Weave" });
    const v = mountWeaves({ storage });
    await settleRows();
    expect(v.fetchStub.mock.calls.length).toBe(0);
  });
});

describe("My Weaves follows storage (spec §4.2)", () => {
  const legacyStorage = () => {
    const storage = memoryStorage();
    storage.set(legacyKey(SECRET), JSON.stringify({ token: "legacy-token", participantId: "p-old" }));
    return storage;
  };

  it("shows a legacy entry nothing has resolved as a Weave whose title it does not know", () => {
    expect(mountWeaves({ storage: legacyStorage() }).titles()).toEqual(["(title unknown)"]);
  });

  it("resolves that row by itself once a migration lands, with nothing clicked", async () => {
    // The regression test for the gap the change signal closes: without it the row stays unresolved
    // until the human reloads the page.
    const storage = legacyStorage();
    const weaves = createWeavesSignal();
    const v = mountWeaves({ storage, weaves, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "Test Weave")) } });
    void migrateLegacy(storage, createPersistenceNotice(), async () => { await flush(); return OTHER; }, () => weaves.bump());
    await settleRows();
    expect([v.titles(), v.href(0)]).toEqual([["Test Weave"], `/weave/${OTHER}`]);
  });

  it("shows a refreshed title and its archived badge with nothing clicked", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Old" });
    const v = mountWeaves({ storage, routes: {
      [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New", "2026-01-01T00:00:00.000Z")) } });
    await settleRows();
    expect([v.titles(), !!screen.queryByText("Archived")]).toEqual([["New"], true]);
  });

  it("does not re-read a row a later bump re-derives", async () => {
    const storage = boundStorage(3);
    const weaves = createWeavesSignal();
    const v = mountWeaves({ storage, weaves, routes: Object.fromEntries(
      BOUND_IDS.slice(0, 3).map((id) => [weaveUrl(id), () => json(weaveAnswer(id, id))])) });
    await settleRows();
    const once = v.fetchStub.mock.calls.length;
    await act(() => { weaves.bump(); });
    await settleRows();
    expect([once, v.fetchStub.mock.calls.length]).toEqual([3, 3]);
  });

  it("does not let a forgotten Weave come back born dead", async () => {
    // The refresh markers are not in storage, so Forget has to drop them itself: a Weave forgotten
    // after a 404 and re-acquired in the same page (a creation, or a join) is a new row, and must
    // be read once more rather than inherit "this Weave is gone".
    const storage = memoryStorage();
    const weaves = createWeavesSignal();
    let gone = true;
    const v = mountWeaves({ storage, weaves, routes: { [weaveUrl(OTHER)]: () =>
      gone ? json({ code: "weave_not_found", message: "gone" }, 404) : json(weaveAnswer(OTHER, "Back")) } });
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Test Weave" });
    await act(() => { weaves.bump(); });
    await settleRows();
    const wasGone = !!screen.queryByText("this Weave is gone");
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }));
    await flush();
    gone = false;
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Test Weave" });
    await act(() => { weaves.bump(); });
    await settleRows();
    expect([wasGone, screen.queryByText("this Weave is gone"), v.titles()]).toEqual([true, null, ["Back"]]);
  });

  it("does not start a second read for a row still in flight", async () => {
    const f = heldWeaves();
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Old" });
    const weaves = createWeavesSignal();
    mountWeaves({ storage, weaves, fetchStub: f.fetchStub });
    await act(() => { weaves.bump(); });
    await act(() => { weaves.bump(); });
    await f.releaseAll();
    await settleRows();
    expect(f.calls).toEqual([OTHER]);
  });
});

describe("My Weaves lets go on unmount (spec §4.2)", () => {
  /** A signal that records what its subscription handed back, and who is still listening. */
  function watchedSignal() {
    const inner = createWeavesSignal();
    let torn = 0;
    let notified = 0;
    const signal: WeavesSignal = {
      bump: inner.bump,
      subscribe: (fn) => {
        const off = inner.subscribe(() => { notified += 1; fn(); });
        return () => { torn += 1; off(); };
      },
    };
    return { signal, torn: () => torn, notified: () => notified };
  }

  /** A store that counts the writes made through it, so "touched nothing" is observable. */
  function countingStorage() {
    const inner = memoryStorage();
    let sets = 0;
    const store: KeyValueStorage = { ...inner, set: (k, v) => { sets += 1; return inner.set(k, v); } };
    return { store, sets: () => sets };
  }

  it("calls the teardown its subscription returned", () => {
    const w = watchedSignal();
    mountWeaves({ weaves: w.signal }).unmount();
    expect(w.torn()).toBe(1);
  });

  it("leaves no listener behind for a later bump", () => {
    const w = watchedSignal();
    mountWeaves({ weaves: w.signal }).unmount();
    w.signal.bump();
    expect(w.notified()).toBe(0);
  });

  it("starts nothing further, and touches nothing, once it is gone", async () => {
    const f = heldWeaves();
    const counted = countingStorage();
    const v = mountWeaves({ storage: boundStorage(BOUND_IDS.length, counted.store), fetchStub: f.fetchStub });
    await flush();
    const started = f.calls.length;
    const writes = counted.sets();
    v.unmount();
    const rejected = await whileIgnoringRejections(async () => { await f.releaseAll(); await settle(); });
    expect([started, f.calls.length, counted.sets() - writes, v.onWrite.mock.calls.length, rejected])
      .toEqual([6, 6, 0, 0, []]);
  });
});

describe("My Weaves reports its writes (spec §4.2, §6)", () => {
  function mountWithBar(opts: { storage: KeyValueStorage; routes?: Routes; fetchStub?: FetchStub }) {
    const fetchStub = opts.fetchStub ?? stubFetch(opts.routes ?? {});
    const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
    const notice = createPersistenceNotice();
    const view = render(
      <>
        <PersistenceBar notice={notice} />
        <MyWeaves client={client} storage={opts.storage} weaves={createWeavesSignal()} onWrite={notice.note}
          notice={notice} openInPlace={() => {}} />
      </>,
    );
    return {
      ...view, notice, fetchStub,
      bars: () => view.container.querySelectorAll(".persistence-bar").length,
      titles: () => [...view.container.querySelectorAll(".weave-row-title")].map((e) => e.textContent),
    };
  }

  const tokenIsDead = (id: string) => vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) !== weaveUrl(id)) throw new Error(`no stub for ${String(input)}`);
    return json({ code: "invalid_token", message: "dead" }, 401);
  });

  it("is not silent about an invalidation that could not persist", async () => {
    // Without this the page would say the identity is dead while `localStorage` still held the old
    // token, and say nothing about the disagreement.
    installLocalStorage();
    const storage = browserStorage();
    setIdentity(storage, OTHER, { token: "dead", participantId: "p" }, { secret: SECRET, title: "Old" });
    const v = mountWithBar({ storage, fetchStub: tokenIsDead(OTHER) });
    await settleRows();
    expect([!!screen.queryByText("your identity here stopped working — open to rejoin"),
      v.notice.degraded(), v.bars()]).toEqual([true, true, 1]);
  });

  it("raises the same one notice for a title write that could not persist", async () => {
    installLocalStorage();
    const storage = browserStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Old" });
    const v = mountWithBar({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New")) } });
    await settleRows();
    expect([v.bars(), v.titles()]).toEqual([1, ["New"]]);
  });

  it("stays quiet while the writes are persisting", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, OTHER, { ...HELD, title: "Old" });
    const v = mountWithBar({ storage, routes: { [weaveUrl(OTHER)]: () => json(weaveAnswer(OTHER, "New")) } });
    await settleRows();
    expect([v.notice.degraded(), v.bars()]).toEqual([false, 0]);
  });
});

// --- Create a Weave (spec §4.5) ---------------------------------------------

const CREATE_URL = `${BASE}/api/weaves`;
const CREATED = "33333333-3333-4333-8333-333333333333";
/** The secret the creation answers with — the one credential that lets anyone else in (§5). */
const NEW_SECRET = "c".repeat(43);
/** How long a stored entry may be under the quota-shaped store below: comfortably above a bare
 *  identity (~65 characters) and comfortably below the whole creation entry (~180). */
const ENTRY_LIMIT = 120;

/** The `CreateWeaveResult` a successful `POST /api/weaves` answers with. */
const CREATED_RESULT = {
  weave: { id: CREATED, title: "Test Weave", createdAt: "", archivedAt: null, lastSeq: 3, guidelines: "" },
  secret: NEW_SECRET,
  participant: { id: "p-creator", weaveId: CREATED, name: "dana", kind: "human", role: "keeper", joinedAt: "", agentId: null, capabilities: null },
  token: "keeper-token",
  generalThread: { id: "g-new", weaveId: CREATED, name: "General", isGeneral: true, createdBy: "p-creator", createdAt: "", closedAt: null, url: null },
  guidelines: "",
};
const CREATE_OK: Routes = {
  [CREATE_URL]: () => json(CREATED_RESULT, 201),
  [weaveUrl(CREATED)]: () => json(weaveAnswer(CREATED, "Test Weave")),
};
const CREATE_CLOSED: Routes = {
  [CREATE_URL]: () => json({ code: "forbidden", message: "Weave creation is restricted to keepers" }, 403),
};

function mountCreate(opts: {
  routes?: Routes; storage?: KeyValueStorage; weaves?: WeavesSignal; defaultName?: string; withList?: boolean;
} = {}) {
  const fetchStub = stubFetch({ ...CREATE_OK, ...opts.routes });
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = createPersistenceNotice();
  const weaves = opts.weaves ?? createWeavesSignal();
  const openInPlace = vi.fn();
  const navigate = vi.fn();
  const view = render(
    <>
      <CreateWeaveForm client={client} storage={storage} notice={notice} weaves={weaves}
        defaultName={opts.defaultName} openInPlace={openInPlace} navigate={navigate} />
      {opts.withList && <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={notice.note}
        notice={notice} openInPlace={openInPlace} />}
    </>,
  );
  const titleField = () => screen.getByLabelText("Title") as HTMLInputElement;
  const nameField = () => screen.getByLabelText("Your name") as HTMLInputElement;
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const fill = (title: string, name: string) => {
    fireEvent.input(titleField(), { target: { value: title } });
    fireEvent.input(nameField(), { target: { value: name } });
  };
  const send = () => fireEvent.submit(titleField().closest("form")!);
  return {
    ...view, fetchStub, storage, notice, weaves, openInPlace, navigate, titleField, nameField, button, fill, send,
    createButton: () => button("Create"),
    panel: () => view.container.querySelector(".create-saved"),
    link: () => view.container.querySelector(".create-link") as HTMLInputElement | null,
    bodyOf: (i: number) => JSON.parse(String(fetchStub.mock.calls[i]![1]!.body)) as unknown,
    create: async (title = "Test Weave", name = "dana") => { fill(title, name); send(); await settle(); },
  };
}

describe("the create form (spec §4.5)", () => {
  it("sends the typed fields as a human — `kind` is not a field on the form", async () => {
    const v = mountCreate();
    await v.create();
    expect(v.bodyOf(0)).toEqual({ title: "Test Weave", opener: "", creator: { name: "dana", kind: "human" } });
  });

  it("carries the first message the form offers beside the title", async () => {
    const v = mountCreate();
    v.fill("Test Weave", "dana");
    fireEvent.input(screen.getByLabelText("First message"), { target: { value: "hello" } });
    v.send();
    await settle();
    expect((v.bodyOf(0) as { opener: string }).opener).toBe("hello");
  });

  it("keeps the Weave guidelines behind a disclosure, and sends what is typed there", async () => {
    const v = mountCreate();
    const hidden = screen.queryByLabelText("Weave guidelines");
    fireEvent.click(v.button("More options"));
    v.fill("Test Weave", "dana");
    fireEvent.input(screen.getByLabelText("Weave guidelines"), { target: { value: "be kind" } });
    v.send();
    await settle();
    expect([hidden, (v.bodyOf(0) as { guidelines?: string }).guidelines]).toEqual([null, "be kind"]);
  });

  it("prefills the name from the Lobby identity this browser already has", () => {
    expect(mountCreate({ defaultName: "dana" }).nameField().value).toBe("dana");
  });

  it("refuses an empty title", () => {
    const v = mountCreate();
    v.fill("", "dana");
    expect(v.createButton().disabled).toBe(true);
  });

  it("refuses a title past 200 characters", () => {
    const v = mountCreate();
    v.fill("t".repeat(201), "dana");
    expect(v.createButton().disabled).toBe(true);
  });

  it("refuses a name the shared rule refuses", () => {
    const v = mountCreate();
    v.fill("Test Weave", "no spaces here");
    expect(v.createButton().disabled).toBe(true);
  });

  it("disables Create while the creation is in flight, so one form cannot become two Weaves", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const v = mountCreate({ routes: { [CREATE_URL]: async () => { await gate; return json(CREATED_RESULT, 201); } } });
    v.fill("Test Weave", "dana");
    v.send();
    await flush();
    const during = v.createButton().disabled;
    release();
    await settle();
    expect(during).toBe(true);
  });

  it("says so in place when this instance only lets keepers create Weaves", async () => {
    const v = mountCreate({ routes: CREATE_CLOSED });
    await v.create();
    expect(!!screen.queryByText("This instance only lets keepers create Weaves.")).toBe(true);
  });

  it("keeps the typed title after that refusal", async () => {
    const v = mountCreate({ routes: CREATE_CLOSED });
    await v.create();
    expect(v.titleField().value).toBe("Test Weave");
  });

  // The `403` is the instance's standing answer, not this attempt's: the form cannot be accepted
  // again, so it stops taking input rather than looking ready for a retry it would have to refuse.
  it("disables every field after that refusal, with what was typed still on screen", async () => {
    const v = mountCreate({ routes: CREATE_CLOSED });
    fireEvent.click(v.button("More options"));
    fireEvent.input(screen.getByLabelText("First message"), { target: { value: "hello" } });
    fireEvent.input(screen.getByLabelText("Weave guidelines"), { target: { value: "be kind" } });
    await v.create();
    const fields = ["Title", "Your name", "First message", "Weave guidelines"]
      .map((label) => (screen.getByLabelText(label) as HTMLInputElement).disabled);
    expect([fields, v.button("More options").disabled, v.titleField().value,
      (screen.getByLabelText("First message") as HTMLTextAreaElement).value])
      .toEqual([[true, true, true, true], true, "Test Weave", "hello"]);
  });

  it("creates nothing more after it, however the form is submitted", async () => {
    // The Create button is gone, but a submit can still be raised — by Enter in a field, or by a
    // test. The guard, not the missing button, is what makes the closed answer stick.
    const v = mountCreate({ routes: CREATE_CLOSED });
    await v.create();
    const afterRefusal = v.fetchStub.mock.calls.length;
    v.send();
    await settle();
    expect([afterRefusal, v.fetchStub.mock.calls.length]).toEqual([1, 1]);
  });

  it("shows the server's own words for a validation failure", async () => {
    const message = "Title must be 1-200 characters";
    const v = mountCreate({ routes: { [CREATE_URL]: () => json({ code: "validation", message }, 400) } });
    await v.create();
    expect(!!screen.queryByText(message)).toBe(true);
  });
});

describe("the save-this-link panel (spec §4.5, §5)", () => {
  it("shows the whole link, with a way to copy it", async () => {
    const v = mountCreate();
    await v.create();
    expect([v.link()?.value, !!screen.queryByRole("button", { name: "Copy" })])
      .toEqual([`${location.origin}/w/${NEW_SECRET}`, true]);
  });

  // The form is replaced in place, with no navigation and no heading change a reader would notice,
  // so the one moment the secret is on screen would otherwise pass in silence.
  it("announces itself as a live region, without re-reading the secret on every later change", async () => {
    // `aria-atomic="false"` on purpose: `role="status"` implies atomic, which would read the whole
    // panel — the 43-character link included — again the moment "Copied" appears beside it.
    const v = mountCreate();
    await v.create();
    expect([v.panel()!.getAttribute("role"), v.panel()!.getAttribute("aria-atomic")]).toEqual(["status", "false"]);
  });

  it("takes focus to its heading, so a reader lands on the panel rather than where the form was", async () => {
    const v = mountCreate();
    await v.create();
    expect([document.activeElement?.tagName, document.activeElement?.textContent]).toEqual(["H2", "Save this link"]);
  });

  it("says what the link is, in the words that say it cannot be taken back", async () => {
    const v = mountCreate();
    await v.create();
    expect(v.panel()!.textContent).toContain(
      "Anyone with this link can read the whole Weave and join it. It cannot be rotated or revoked — "
      + "archiving the Weave is the only way to contain it.");
  });

  it("has already written the entry by the time it is on screen", async () => {
    // Asserted in the same breath as the panel: "the secret is stored" and "the panel is up" are one
    // fact, and a panel that appeared first would be a panel that could be dismissed first.
    const v = mountCreate();
    await v.create();
    const e = readWeaveEntry(v.storage, CREATED);
    expect([!!v.panel(), e?.token, e?.participantId, e?.secret, e?.title])
      .toEqual([true, "keeper-token", "p-creator", NEW_SECRET, "Test Weave"]);
  });

  it("writes that whole entry in one `set`, secret included", async () => {
    // The one-write rule of §4.5: a second, smaller write would persist where the whole entry does
    // not, and the panel would then relax on a verdict that never covered the secret.
    const inner = memoryStorage();
    const writes: string[] = [];
    const storage: KeyValueStorage = { ...inner, set: (k, val) => { writes.push(k); return inner.set(k, val); } };
    const v = mountCreate({ storage });
    await v.create();
    const stored = JSON.parse(storage.get(weaveKey(CREATED))!) as WeaveEntry;
    expect([writes.filter((k) => k === weaveKey(CREATED)).length,
      [stored.token, stored.participantId, stored.secret, stored.title, typeof stored.lastOpenedAt]])
      .toEqual([1, ["keeper-token", "p-creator", NEW_SECRET, "Test Weave", "string"]]);
  });

  it("names this browser in that entry, so the row reads `joined as dana`", async () => {
    const v = mountCreate();
    await v.create();
    expect(readWeaveEntry(v.storage, CREATED)?.name).toBe("dana");
  });

  it("opens the Weave at its id, never at the link that carries the secret", async () => {
    const v = mountCreate();
    await v.create();
    fireEvent.click(v.button("Open the Weave"));
    expect([v.navigate.mock.calls, v.openInPlace.mock.calls]).toEqual([[[`/weave/${CREATED}`]], []]);
  });

  it("puts the secret nowhere but that one field", async () => {
    const v = mountCreate();
    await v.create();
    const hrefs = [...v.container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect([v.container.innerHTML.includes(NEW_SECRET), hrefs.some((h) => h.includes(NEW_SECRET)),
      location.pathname.includes(NEW_SECRET)]).toEqual([false, false, false]);
  });

  it("lets a durable creation be dismissed, and puts the form back", async () => {
    const v = mountCreate();
    await v.create();
    const enabled = !v.button("Done").disabled;
    fireEvent.click(v.button("Done"));
    await flush();
    expect([enabled, v.panel(), v.titleField().value]).toEqual([true, null, ""]);
  });

  it("shows the new Weave in My Weaves with nothing clicked and no reload", async () => {
    // The page stays on screen after a creation (§4.5), so the bump is the only thing that can put
    // the new row in the list beside the panel.
    const v = mountCreate({ withList: true });
    await v.create();
    expect([...v.container.querySelectorAll(".weave-row-title")].map((e) => e.textContent))
      .toEqual(["Test Weave"]);
  });
});

describe("the save-this-link panel hardens when nothing was saved (spec §3.1, §4.5)", () => {
  /** A store that keeps a bare identity and refuses the whole entry — the case a two-write creation
   *  gets wrong, by branching on the verdict of the write that was never at risk. */
  const sized = () => { installSizeLimitedLocalStorage(ENTRY_LIMIT); return browserStorage(); };

  it("keeps a bare identity under that store, which is what makes the case a real one", () => {
    const storage = sized();
    expect(setIdentity(storage, CREATED, { token: "keeper-token", participantId: "p-creator", name: "dana" }))
      .toBe("durable");
  });

  it("hardens the panel when the whole entry would not fit", async () => {
    const v = mountCreate({ storage: sized() });
    await v.create();
    expect([!!v.container.querySelector(".create-saved-hardened"), v.button("Done").disabled])
      .toEqual([true, true]);
  });

  it("renders that Weave here rather than navigating to it", async () => {
    const v = mountCreate({ storage: sized() });
    await v.create();
    fireEvent.click(v.button("Open the Weave"));
    expect([v.openInPlace.mock.calls, v.navigate.mock.calls]).toEqual([[[CREATED]], []]);
  });

  it("hardens the same way when the store keeps nothing at all", async () => {
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    expect([!!v.container.querySelector(".create-saved-hardened"), v.button("Done").disabled])
      .toEqual([true, true]);
  });

  it("takes focus to its heading in this variant too, which is the one that must not be missed", async () => {
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    expect([document.activeElement?.tagName, document.activeElement?.textContent]).toEqual(["H2", "Save this link"]);
  });

  it("says why this link is the only copy there is", async () => {
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    expect(v.panel()!.textContent).toContain(
      "This browser is not saving anything for this site, so this link is the only copy of it "
      + "anywhere. Close this tab without saving it and this Weave is gone for good: Loom has no "
      + "recovery, no rotation and no deletion.");
  });

  it("lets it be dismissed once the link has been acknowledged", async () => {
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    fireEvent.click(v.button("I have saved this link"));
    await flush();
    fireEvent.click(v.button("Done"));
    await flush();
    expect(v.panel()).toBeNull();
  });

  it("takes a successful copy as that acknowledgement", async () => {
    installClipboard(async () => {});
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    fireEvent.click(v.button("Copy"));
    await flush();
    expect(v.button("Done").disabled).toBe(false);
  });

  it("does not take a refused copy as one", async () => {
    installClipboard(undefined);
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    fireEvent.click(v.button("Copy"));
    await flush();
    expect(v.button("Done").disabled).toBe(true);
  });

  it("reports that verdict to the one notice this page has", async () => {
    installThrowingLocalStorage();
    const v = mountCreate({ storage: browserStorage() });
    await v.create();
    expect(v.notice.degraded()).toBe(true);
  });
});

describe("a creation on the main page (spec §3.1, §4.5)", () => {
  /** What the created Weave answers when its own page loads: the creator is in it, as its keeper. */
  const createdRoutes: Routes = {
    ...CREATE_OK,
    ...weaveRoutes(CREATED, "Test Weave"),
    [weaveUrl(CREATED)]: () => json({ ...weaveAnswer(CREATED, "Test Weave"), participants: [CREATED_RESULT.participant] }),
  };
  const createOnPage = async () => {
    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Test Weave" } });
    fireEvent.input(screen.getByLabelText("Your name"), { target: { value: "dana" } });
    fireEvent.submit((screen.getByLabelText("Title") as HTMLInputElement).closest("form")!);
    await settle();
  };

  it("leaves a creation whose entry did not persist in a Weave this browser keeps", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage(), routes: createdRoutes });
    await settle();
    await createOnPage();
    fireEvent.click(screen.getByRole("button", { name: "Open the Weave" }));
    await settle();
    expect([v.iAm(), v.container.querySelector(".header-right")?.textContent?.includes("(keeper)"), v.writable()])
      .toEqual(["dana", true, true]);
  });

  it("leaves the URL alone doing it", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage(), routes: createdRoutes });
    const pushed = vi.spyOn(history, "pushState");
    await settle();
    await createOnPage();
    fireEvent.click(screen.getByRole("button", { name: "Open the Weave" }));
    await settle();
    expect([location.pathname, pushed.mock.calls.length, v.container.innerHTML.includes(NEW_SECRET)])
      .toEqual(["/", 0, false]);
  });

  // My Weaves shows the new Weave the instant it is created, beside the panel whose own Open is
  // careful about this (§4.5). A row that was an anchor undid that care: a click — or a
  // middle-click, or "open in a new tab" — is a full page load, and a fresh JS context has neither
  // the token nor the secret this one is the only holder of.
  it("offers the new row as a button, not a link, while its credentials live only in memory", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage(), routes: createdRoutes });
    await settle();
    await createOnPage();
    const title = v.container.querySelector(".weave-row-title")!;
    expect([title.tagName, title.getAttribute("href"), v.container.querySelector(`a[href="/weave/${CREATED}"]`)])
      .toEqual(["BUTTON", null, null]);
  });

  it("opens that row in place, in a loaded writable session, with the URL untouched", async () => {
    installThrowingLocalStorage();
    const v = mountApp({ path: "/", storage: browserStorage(), routes: createdRoutes });
    const pushed = vi.spyOn(history, "pushState");
    await settle();
    await createOnPage();
    fireEvent.click(v.container.querySelector(".weave-row-title") as HTMLButtonElement);
    await settle();
    expect([v.iAm(), v.writable(), location.pathname, pushed.mock.calls.length]).toEqual(["dana", true, "/", 0]);
  });

  it("leaves a durable creation's row an ordinary link: a full page load is still the rule", async () => {
    const v = mountApp({ path: "/", routes: createdRoutes });
    await settle();
    await createOnPage();
    const title = v.container.querySelector(".weave-row-title")!;
    expect([title.tagName, title.getAttribute("href")]).toEqual(["A", `/weave/${CREATED}`]);
  });

  it("offers a button under the store that keeps a bare identity and refuses the whole entry", async () => {
    // The quota-shaped store of §4.5: the row is judged on the entry as it stands, which is the
    // one that did not fit, not on some earlier write that did.
    installSizeLimitedLocalStorage(ENTRY_LIMIT);
    const v = mountApp({ path: "/", storage: browserStorage(), routes: createdRoutes });
    await settle();
    await createOnPage();
    expect(v.container.querySelector(".weave-row-title")!.tagName).toBe("BUTTON");
  });

  // The same rule on the main page's own onward link: the Lobby entry here is perfectly durable,
  // and it is the *creation* that did not persist — leaving would lose that, so nothing on this
  // page may be an anchor.
  it("opens the Lobby in place too once some write on this page has not persisted", async () => {
    const notice = createPersistenceNotice();
    notice.note("memory");
    const storage = memoryStorage();
    setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana", name: "dana" });
    const v = mountApp({ path: "/", storage, notice });
    await settle();
    const open = v.container.querySelector(".lobby-open button, .lobby-open a")!;
    expect([open.tagName, open.getAttribute("href")]).toEqual(["BUTTON", null]);
  });

  it("opens the Lobby in place too when the identity for it lives only in memory", async () => {
    installThrowingLocalStorage();
    const storage = browserStorage();
    setIdentity(storage, LOBBY.weaveId, { token: "participant-token", participantId: "p-dana", name: "dana" });
    const v = mountApp({ path: "/", storage });
    await settle();
    const open = v.container.querySelector(".lobby-open button, .lobby-open a")!;
    fireEvent.click(open);
    await settle();
    expect([open.tagName, open.getAttribute("href"), v.iAm(), v.writable(), location.pathname])
      .toEqual(["BUTTON", null, "dana", true, "/"]);
  });
});
