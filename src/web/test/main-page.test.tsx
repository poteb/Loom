// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient } from "@loom/client";
import { JoinLobbyForm } from "../src/components/main/JoinLobbyForm.js";
import { isValidName, suggestName } from "../src/name.js";
import { browserStorage, memoryStorage, type KeyValueStorage } from "../src/storage.js";
import { createPersistenceNotice } from "../src/persistence.js";
import { readWeaveEntry } from "../src/weaves-store.js";

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

function mount(opts: { routes?: Routes; storage?: KeyValueStorage } = {}) {
  const fetchStub = stubFetch(opts.routes ?? OK);
  const client = new LoomClient({ baseUrl: BASE, allowInsecure: true, fetch: fetchStub as unknown as typeof fetch });
  const storage = opts.storage ?? memoryStorage();
  const notice = createPersistenceNotice();
  const onJoined = vi.fn();
  const onJoinedInPlace = vi.fn();
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
    expect([entry?.token, entry?.participantId, entry?.title]).toEqual(["participant-token", "p-dana", "Lobby"]);
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
