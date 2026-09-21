// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { LoomClient } from "@loom/client";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { App } from "../src/app.js";
import { memoryStorage } from "../src/storage.js";
import { setIdentity } from "../src/weaves-store.js";
import { createPersistenceNotice } from "../src/persistence.js";
import { createWeavesSignal } from "../src/weaves-signal.js";

let s: TestServer;

/**
 * The page's own URL, and the whole of this file's transport. happy-dom's `fetch` is same-origin, so
 * a document left on its default origin cannot reach the server at all; given the server's origin it
 * reaches it, and `globalThis.WebSocket` opens a real stream to it. Nothing here injects a `fetch`
 * and nothing swaps a global.
 */
const setURL = (path: string) =>
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(s.baseUrl + path);

beforeAll(async () => { s = await startTestServer(); setURL("/lobby"); await s.core.ensureLobby(); });
// Also this file's reset of `location` between tests, in place of the stubbed suite's
// `history.replaceState(null, "", "/")`: a test that pushed `/lobby/listeners` starts the next one
// back on `/lobby`, on the origin every request needs.
beforeEach(() => { setURL("/lobby"); });
afterAll(async () => { await s.close(); });

/**
 * The file's own poller, copied from `session.test.ts` rather than imported (that file exports
 * nothing). Real timers throughout, and this file never calls `vi.useFakeTimers()`: a state change
 * made from **outside** Preact's `act` — a WebSocket message is exactly that — has its effects
 * flushed on the next animation frame, which is a timer too and would never come on a stopped clock.
 */
function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
/**
 * **One server, one database, one Lobby for the whole file** — unmounting clears the DOM, never the
 * database. So every fixture takes a fresh number, and **every assertion below is about this
 * fixture's own names**: its own listener among whatever rows earlier tests left behind, and a Thread
 * title no other test has used. A count of rows, or a fixed title like "Design", would be answered by
 * an earlier test's leftovers — the row wait would never reach 1, and the Thread would be "there"
 * before this test's event had been made.
 */
let fixtureN = 0;

/**
 * A real Lobby with three participants: **this browser** (a joined identity in a durable
 * `memoryStorage()`, so nothing degrades the notice and no persistence bar rides the page), a
 * **listener** with a profile, so the directory has a row of its own to still be showing, and a
 * **second participant** whose client is the one that makes the event this file is about.
 */
async function lobbyFixture() {
  const n = ++fixtureN;
  const anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true });
  const { weaveId } = await anon.getLobby();
  const me = await anon.joinLobby({ name: `Dana-${n}`, kind: "human" });
  const listener = await anon.joinLobby({ name: `Helper-${n}`, kind: "agent" });
  await anon.withToken(listener.token).setCapabilities({ models: [MODEL], tools: [], serves: "anyone", owner: `bob-${n}` });
  const other = await anon.joinLobby({ name: `Other-${n}`, kind: "agent" });
  const storage = memoryStorage();
  setIdentity(storage, weaveId, { token: me.token, participantId: me.participant.id, name: me.participant.name });
  // `createThread` asks only that the actor be a participant of the Weave (`core/src/threads.ts:58`),
  // so this ordinary Lobby member may make the event, and it is made on a connection of its own.
  return { weaveId, storage, listener: `Helper-${n}`, thread: `Design-${n}`, other: anon.withToken(other.token) };
}

/** The page as a browser loads it, with the real session and its real stream underneath. */
function mountLobby(f: Awaited<ReturnType<typeof lobbyFixture>>) {
  // `location` is already `<server>/lobby`: `beforeEach` put it there, and that is both this file's
  // reset and the origin every request needs. So the page's path is the real one a browser loaded.
  let asked = 0;
  const client = new LoomClient({
    baseUrl: s.baseUrl, allowInsecure: true,
    // A counter around the ambient `fetch`, and nothing more — the transport itself is happy-dom's.
    // The **directory's** queries are told from the session's count read by `limit=0`, exactly as the
    // stubbed suite tells them apart: they share a pathname, and a counter on the pathname alone
    // would move on every refresh and prove nothing.
    fetch: (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/api/lobby/listeners" && url.searchParams.get("limit") !== "0") asked++;
      return globalThis.fetch(url.toString(), init);
    },
  });
  const view = render(<App client={client} storage={f.storage} notice={createPersistenceNotice()} weaves={createWeavesSignal()} />);
  return {
    ...view,
    asked: () => asked,
    line: () => screen.queryByRole("button", { name: /^Listeners/ }),
    /** The stream's own state as the header prints it: the DOM's proof of a socket. */
    connection: () => view.container.querySelector(".conn")?.textContent,
    threads: () => [...view.container.querySelectorAll(".thread-pick")].map((e) => e.textContent),
    rows: () => [...view.container.querySelectorAll(".profile-name")].map((e) => e.textContent),
    directory: () => !!screen.queryByRole("heading", { level: 2, name: "Listeners" }),
    composerSlot: () => view.container.querySelector(".composer-slot") as HTMLElement | null,
  };
}

/**
 * Loads the page, waits for the stream to be **open** — everything below is asserted against a live
 * socket, which is this file's whole reason to exist — and opens the directory by pressing the
 * sidebar line. The line is on screen because the Lobby gate is true on the real Lobby; the row is on
 * screen because the fixture put a listener in it.
 */
async function openDirectory(f: Awaited<ReturnType<typeof lobbyFixture>>) {
  const v = mountLobby(f);
  await waitFor(() => v.connection() === "open");
  fireEvent.click(v.line()!);
  // This fixture's own listener, not a row count: the Lobby is shared by the file, so the directory
  // also lists every earlier test's `Helper-N`. Fewer than 50 of them, so the first page holds ours.
  await waitFor(() => v.rows().includes(f.listener));
  return v;
}

describe("the directory over a live stream (spec §12.13)", () => {
  it("leaves the stream open with the directory on screen", async () => {
    const v = await openDirectory(await lobbyFixture());
    expect([v.connection(), v.directory()]).toEqual(["open", true]);
    v.unmount();
  });

  it("brings a Thread another client creates into the sidebar while the directory stays open", async () => {
    const f = await lobbyFixture();
    const v = await openDirectory(f);
    const rowsBefore = v.rows();                         // the baseline: earlier tests' listeners are in it too
    expect(v.threads()).not.toContain(f.thread);         // it arrives on the stream, not with the page
    await f.other.createThread(f.weaveId, f.thread);
    await waitFor(() => v.threads().includes(f.thread));
    // "while it stays open" is the other half of the rule, so it is asserted here and not elsewhere:
    // the same rows as before the event — compared with the captured baseline, never with a literal
    // list — this fixture's listener among them, and the composer still hidden.
    expect([v.directory(), v.rows(), v.rows().includes(f.listener), v.composerSlot()!.hasAttribute("hidden")])
      .toEqual([true, rowsBefore, true, true]);
    v.unmount();
  });

  it("costs the directory no query of its own to do it", async () => {
    const f = await lobbyFixture();
    const v = await openDirectory(f);
    const before = v.asked();
    expect(v.threads()).not.toContain(f.thread);         // a title of this test's own, so the wait below
    await f.other.createThread(f.weaveId, f.thread);     // cannot be satisfied by an earlier test's Thread
    await waitFor(() => v.threads().includes(f.thread));
    // A **delta**, never an absolute count: `thread.created` schedules a refresh, and that refresh
    // makes the Lobby's two side reads, one of which shares this pathname. What must not move is the
    // directory's own query — the directory did not remount and did not re-ask.
    expect(v.asked()).toBe(before);
    v.unmount();
  });
});
