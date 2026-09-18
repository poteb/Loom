import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionTarget } from "../src/session.js";
import { browserStorage, memoryStorage, type KeyValueStorage, type WriteResult } from "../src/storage.js";
import { legacyKey, readWeaveEntry, saveWeaveEntry, setIdentity, weaveKey } from "../src/weaves-store.js";
import { DEFAULT_INSTANCE_GUIDELINES } from "@loom/core";

let s: TestServer;
let anon: LoomClient;
/** An instance keeper: the one credential the Lobby's own secret is told to. */
const KEEPER = keeperToken("web-session-keeper");
beforeAll(async () => {
  s = await startTestServer();
  anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true });
  await s.core.seedKeepers([KEEPER]);
  await s.core.ensureLobby();
});
afterAll(async () => { await s.close(); });

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

async function makeSession(target: SessionTarget, storage = memoryStorage(), over: { closedRequestsPage?: number } = {}): Promise<Session> {
  const session = createSession({ client: anon, target, storage, ...over });
  await session.load();
  return session;
}

describe("session", () => {
  it("loads by secret (read-only), streams live events, and requires a name to post", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = await makeSession({ kind: "secret", secret: r.secret });
    const st = session.getState();
    expect(st.status).toBe("ready");
    expect(st.weave?.title).toBe("T");
    expect(st.currentThreadId).toBe(r.generalThread.id);
    expect(st.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(st.me).toBeUndefined();

    await expect(session.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(session.getState().needsName).toBe(true);

    await waitFor(() => session.getState().connection === "open");
    await anon.withToken(r.token).postMessage(r.generalThread.id, "from claude");
    await waitFor(() => session.getState().events.length === 4);
    expect(session.getState().events[3]!.payload.text).toBe("from claude");
    session.dispose();
  });

  it("join stores the identity; a second session with the same storage skips joining; writes work", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    const a = await makeSession({ kind: "secret", secret: r.secret }, storage);
    let changes = 0; a.subscribe(() => changes++);
    await a.join("Paw");
    expect(a.getState().me?.participant.name).toBe("Paw");
    expect(a.getState().needsName).toBe(false);
    expect(changes).toBeGreaterThan(0);
    await a.post("hi @Claude");
    await waitFor(() => a.getState().events.some((e) => e.payload.text === "hi @Claude"));
    await a.createThread("Design");
    await waitFor(() => a.getState().threads.some((t) => t.name === "Design"));
    expect(a.canModerate()).toBe(false);
    a.dispose();

    const b = await makeSession({ kind: "secret", secret: r.secret }, storage);
    expect(b.getState().me?.participant.name).toBe("Paw");
    b.dispose();
  });

  it("join caches the name it joined under, beside the identity it just wrote", async () => {
    // My Weaves and the main page both say "joined as dana" from storage alone (spec §4.1, §4.2),
    // and only the join knows that name — nothing reads it back off the network to find out.
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    const a = await makeSession({ kind: "secret", secret: r.secret }, storage);
    await a.join("Paw");
    a.dispose();
    expect(readWeaveEntry(storage, r.weave.id)?.name).toBe("Paw");
  });

  it("join hands the verdict of its credential write to onWrite", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const verdicts: WriteResult[] = [];
    const a = createSession({ client: anon, target: { kind: "secret", secret: r.secret }, storage: memoryStorage({ durable: false }),
      onWrite: (v) => verdicts.push(v) });
    await a.load();
    await a.join("Paw");
    expect(verdicts.at(-1)).toBe("memory");
    a.dispose();
  });

  it("visiting a thread does not acknowledge invites that arrive later", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const a = await makeSession({ kind: "secret", secret: r.secret }, storage);
    await waitFor(() => a.getState().connection === "open");
    await a.createThread("PR 1");
    await waitFor(() => a.getState().threads.some((t) => t.name === "PR 1"));
    const t1 = a.getState().threads.find((t) => t.name === "PR 1")!;
    await a.createThread("PR 2");
    await waitFor(() => a.getState().threads.some((t) => t.name === "PR 2"));
    const t2 = a.getState().threads.find((t) => t.name === "PR 2")!;
    // Both threads have been opened already; "seen" must mean "seen up to seq N", not "seen ever".
    a.selectThread(t1.id);
    a.selectThread(t2.id);
    a.selectThread(r.generalThread.id);
    // Someone else with the right to invite: a second participant promoted to Weave keeper.
    const paw = await s.core.resolveCredential(r.token);
    const b = await anon.joinWeave(r.secret, { name: "Bot", kind: "agent" });
    await s.core.setRole(paw, r.weave.id, b.participant.id, "keeper");
    const bot = await s.core.resolveCredential(b.token);
    await s.core.inviteParticipant(bot, t1.id, r.participant.id);
    await waitFor(() => a.getState().invitesForMe.has(t1.id));
    await s.core.inviteParticipant(bot, t2.id, r.participant.id);
    await waitFor(() => a.getState().invitesForMe.has(t2.id));
    // markSeen clears only the thread it names...
    a.markSeen(t2.id);
    expect([...a.getState().invitesForMe]).toEqual([t1.id]);
    // ...and opening the other one clears that.
    a.selectThread(t1.id);
    expect([...a.getState().invitesForMe]).toEqual([]);
    a.dispose();
  });

  it("keeper can close threads and archive; archived weave is read-only", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const k = await makeSession({ kind: "secret", secret: r.secret }, storage);
    expect(k.getState().me?.participant.role).toBe("keeper");
    expect(k.canModerate()).toBe(true);
    await k.createThread("Tmp");
    await waitFor(() => k.getState().threads.length === 2);
    const tmp = k.getState().threads.find((t) => t.name === "Tmp")!;
    await k.closeThread(tmp.id);
    await waitFor(() => k.getState().threads.find((t) => t.id === tmp.id)?.closedAt != null);
    await k.archive();
    await waitFor(() => k.getState().weave?.archivedAt != null);
    expect(k.canModerate()).toBe(false);
    await expect(k.post("late")).rejects.toMatchObject({ code: "weave_archived" });
    k.dispose();
  });

  it("reports an error state for an unknown secret", async () => {
    const session = createSession({ client: anon, target: { kind: "secret", secret: "nope" }, storage: memoryStorage() });
    await session.load();
    expect(session.getState().status).toBe("error");
    expect(session.getState().error).toMatch(/not found/i);
  });

  it("anonymous writes always demand a name, whether or not the session has loaded", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });

    const unloaded = createSession({ client: anon, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    await expect(unloaded.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.createThread("Design")).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.closeThread(r.generalThread.id)).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.archive()).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);

    const loaded = await makeSession({ kind: "secret", secret: r.secret });
    await expect(loaded.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(loaded.getState().needsName).toBe(true);
    await expect(loaded.createThread("Design")).rejects.toMatchObject({ code: "no_identity" });
    expect(loaded.getState().needsName).toBe(true);
    await expect(loaded.closeThread(r.generalThread.id)).rejects.toMatchObject({ code: "no_identity" });
    expect(loaded.getState().needsName).toBe(true);
    await expect(loaded.archive()).rejects.toMatchObject({ code: "no_identity" });
    expect(loaded.getState().needsName).toBe(true);
    loaded.dispose();
  });

  it("load() called twice does not leak the first stream", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = createSession({ client: anon, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.getState().connection));
    await session.load();
    await session.load();
    await waitFor(() => session.getState().connection === "open");
    // The first load()'s stream must have reported "closed" (superseded by the second load()) rather
    // than leaking on unobserved: dispose() alone would also produce a trailing "closed", but here we
    // catch it before dispose, while the second stream is the one holding "open".
    expect(statuses).toContain("closed");
    session.dispose();
  });

  it("load() backfills events before fetching metadata, so a thread created mid-backfill is not lost", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    let raced = false;
    const racing = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const target = new URL(url);
        if (!raced && /^\/api\/weaves\/[^/]+\/events$/.test(target.pathname) && target.search.includes("since")) {
          raced = true;
          const actor = await s.core.resolveCredential(r.token);
          await s.core.createThread(actor, r.weave.id, "Raced");
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: racing, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    await session.load();
    expect(session.getState().threads.some((t) => t.name === "Raced")).toBe(true);
    expect(session.getState().events.some((e) => e.type === "thread.created" && (e.payload as { name?: string }).name === "Raced")).toBe(true);
    session.dispose();
  });

  it("retries a derived-state refresh that transiently fails", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const isGetWeave = /^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname);
        if (isGetWeave) {
          getWeaveCalls++;
          // Let the getWeave() inside load() through; fail only the next one (triggered by the
          // qualifying event below), which refreshInfo() must retry rather than give up on.
          if (getWeaveCalls === 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    await session.load();
    expect(getWeaveCalls).toBe(1);

    await anon.withToken(r.token).createThread(r.weave.id, "Design");
    await waitFor(() => session.getState().threads.some((t) => t.name === "Design"));
    expect(getWeaveCalls).toBeGreaterThanOrEqual(3);
    session.dispose();
  });

  it("never abandons a derived-state refresh: it falls back to a slow retry cadence and surfaces the failure", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const isGetWeave = /^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname);
        if (isGetWeave) {
          getWeaveCalls++;
          // Call 1 is the getWeave() inside load(); fail the next 6 (all 5 fast retries plus the
          // first slow-cadence retry) so the refresh must fall back to the slow cadence rather than
          // give up after the bounded fast retries are exhausted.
          if (getWeaveCalls >= 2 && getWeaveCalls <= 7) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({
      client: flaky, target: { kind: "secret", secret: r.secret }, storage: memoryStorage(),
      retry: { delaysMs: [5, 5, 5, 5, 5], slowMs: 20 },
    });
    await session.load();
    expect(getWeaveCalls).toBe(1);

    await anon.withToken(r.token).createThread(r.weave.id, "Design");
    await waitFor(() => session.getState().refreshError !== undefined);
    expect(session.getState().threads.some((t) => t.name === "Design")).toBe(false);

    await waitFor(() => session.getState().threads.some((t) => t.name === "Design"));
    expect(session.getState().refreshError).toBeUndefined();
    expect(getWeaveCalls).toBe(8);
    session.dispose();
  });

  it("join() succeeds and updates state locally even when the refresh right after it transiently fails", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const isGetWeave = /^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname);
        if (isGetWeave) {
          getWeaveCalls++;
          // Call 1 is the getWeave() inside load(); fail only the refresh triggered by join().
          if (getWeaveCalls === 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    await session.load();
    expect(getWeaveCalls).toBe(1);

    // Must resolve — the join already committed server-side, so a failing background refresh must
    // not read back as a failure of join() itself.
    await session.join("Paw");
    expect(session.getState().me?.participant.name).toBe("Paw");
    expect(session.getState().needsName).toBe(false);
    expect(session.getState().participants.filter((p) => p.name === "Paw")).toHaveLength(1);

    await waitFor(() => session.getState().refreshError === undefined && getWeaveCalls >= 3);
    expect(session.getState().participants.filter((p) => p.name === "Paw")).toHaveLength(1);
    session.dispose();
  });

  it("closeThread() succeeds and marks the thread closed locally even when the refresh right after it transiently fails", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    // Created before the flaky session loads, so this doesn't add an extra live thread.created
    // event (and extra scheduleRefresh) once the flaky session is streaming.
    const tmp = await anon.withToken(r.token).createThread(r.weave.id, "Tmp");
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const isGetWeave = /^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname);
        if (isGetWeave) {
          getWeaveCalls++;
          if (getWeaveCalls === 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: r.secret }, storage });
    await session.load();
    expect(getWeaveCalls).toBe(1);

    await session.closeThread(tmp.id);
    expect(session.getState().threads.find((t) => t.id === tmp.id)?.closedAt).not.toBeNull();

    await waitFor(() => session.getState().refreshError === undefined && getWeaveCalls >= 3);
    expect(session.getState().threads.find((t) => t.id === tmp.id)?.closedAt).not.toBeNull();
    session.dispose();
  });

  it("archive() succeeds and marks the weave archived locally even when the refresh right after it transiently fails", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const isGetWeave = /^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname);
        if (isGetWeave) {
          getWeaveCalls++;
          if (getWeaveCalls === 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: r.secret }, storage });
    await session.load();
    expect(getWeaveCalls).toBe(1);

    await session.archive();
    expect(session.getState().weave?.archivedAt).not.toBeNull();

    await waitFor(() => session.getState().refreshError === undefined && getWeaveCalls >= 3);
    expect(session.getState().weave?.archivedAt).not.toBeNull();
    session.dispose();
  });

  it("an archive that lands while a metadata refresh is in flight is not undone by the stale response", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const gate = makeGate();
    let getWeaveCalls = 0;
    const gated = new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (/^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname)) {
          getWeaveCalls++;
          // Call 1 belongs to load(). Call 2 is the refresh this test suspends: the server answers
          // it now — while the Weave is still unarchived — and the session only sees that answer
          // after the archive has already been applied.
          if (getWeaveCalls === 2) {
            const captured = await fetch(url, init);
            gate.markEntered();
            await gate.released;
            return captured;
          }
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: gated, target: { kind: "secret", secret: r.secret }, storage });
    await session.load();
    await waitFor(() => session.getState().connection === "open");
    expect(session.canModerate()).toBe(true);

    // A participant joining starts a metadata refresh, which parks holding pre-archive metadata.
    await anon.joinWeave(r.secret, { name: "Other", kind: "human" });
    await gate.entered;

    // The archive commits and reaches the session over the stream while that refresh is suspended.
    await s.core.archiveWeave(await s.core.resolveCredential(r.token), r.weave.id);
    await waitFor(() => session.getState().weave?.archivedAt != null);
    expect(session.canModerate()).toBe(false);

    gate.release();
    // Call 3 is the refresh the archive itself scheduled: it only runs once the stale one settled,
    // so waiting for it also waits for the stale response to have been merged.
    await waitFor(() => getWeaveCalls >= 3);
    await waitFor(() => session.getState().participants.some((p) => p.name === "Other"));
    expect(session.getState().weave?.archivedAt).not.toBeNull();
    expect(session.canModerate()).toBe(false);
    session.dispose();
  });
});

/** One-shot rendezvous: the test learns the gated request arrived, the request waits for release. */
function makeGate() {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => { markEntered = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { entered, released, markEntered, release };
}

/** Counts the WebSockets a session actually opens, so "exactly one live stream" is observable. */
function trackSockets() {
  const Real = globalThis.WebSocket;
  const created: WebSocket[] = [];
  globalThis.WebSocket = class extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      created.push(this);
    }
  } as unknown as typeof WebSocket;
  return {
    live: () => created.filter((w) => w.readyState === Real.CONNECTING || w.readyState === Real.OPEN).length,
    restore: () => { globalThis.WebSocket = Real; },
  };
}

/** A client whose first events request parks on `gate` until the test releases it. */
function gatedClient(baseUrl: string, gate: ReturnType<typeof makeGate>): LoomClient {
  let gated = false;
  return new LoomClient({
    baseUrl, allowInsecure: true,
    fetch: async (target, init) => {
      const url = typeof target === "string" ? target : target.toString();
      if (!gated && /\/events$/.test(new URL(url).pathname)) {
        gated = true;
        gate.markEntered();
        await gate.released;
      }
      return fetch(url, init);
    },
  });
}

describe("session lifecycle", () => {
  it("a superseded load() closes its own stream and never touches state", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const gate = makeGate();
    const sockets = trackSockets();
    try {
      const session = createSession({ client: gatedClient(s.baseUrl, gate), target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
      const first = session.load();
      await gate.entered;
      // The second load() supersedes the first while the first is parked mid-backfill.
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      gate.release();
      await first;
      await new Promise((res) => setTimeout(res, 100));
      // The stale load must clean up after itself rather than leak a second socket (or overwrite
      // the live handle, which would make dispose() close the wrong stream).
      expect(sockets.live()).toBe(1);

      await anon.withToken(r.token).postMessage(r.generalThread.id, "live");
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "live"));
      expect(session.getState().status).toBe("ready");

      session.dispose();
      await new Promise((res) => setTimeout(res, 100));
      expect(sockets.live()).toBe(0);
    } finally { sockets.restore(); }
  });

  it("dispose() during a load() leaves no stream and no state changes after disposal", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const gate = makeGate();
    const sockets = trackSockets();
    try {
      const session = createSession({ client: gatedClient(s.baseUrl, gate), target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
      const loading = session.load();
      await gate.entered;
      session.dispose();
      // set() replaces the state object, so identity is the sharpest "nothing changed" assertion.
      const snapshot = session.getState();
      gate.release();
      await loading;
      await new Promise((res) => setTimeout(res, 100));
      expect(sockets.live()).toBe(0);
      expect(session.getState()).toBe(snapshot);

      await anon.withToken(r.token).postMessage(r.generalThread.id, "after dispose");
      await new Promise((res) => setTimeout(res, 300));
      expect(session.getState()).toBe(snapshot);
      expect(session.getState().events).toHaveLength(0);
    } finally { sockets.restore(); }
  });

  it("a re-load() announces itself: status goes back to loading and stale errors are cleared", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = createSession({ client: anon, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    await session.load();
    expect(session.getState().status).toBe("ready");
    // Read synchronously, before load() has awaited anything: a reload must publish "loading"
    // (and drop any error left by a previous attempt) rather than sit on stale ready state.
    const again = session.load();
    expect(session.getState().status).toBe("loading");
    expect(session.getState().error).toBeUndefined();
    expect(session.getState().refreshError).toBeUndefined();
    await again;
    expect(session.getState().status).toBe("ready");
    session.dispose();
  });

  it("dispose() cancels a pending retry sleep instead of leaving a timer behind", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: (target, init) => {
        const url = typeof target === "string" ? target : target.toString();
        if (/^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname)) {
          getWeaveCalls++;
          if (getWeaveCalls >= 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    // A retry delay far longer than the test: if dispose() did not cancel it, the timer would
    // outlive the session (and the suite would have to wait it out).
    const session = createSession({
      client: flaky, target: { kind: "secret", secret: r.secret }, storage: memoryStorage(),
      retry: { delaysMs: [600_000], slowMs: 600_000 },
    });
    await session.load();

    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await anon.withToken(r.token).createThread(r.weave.id, "Design");
      await waitFor(() => session.getState().refreshError !== undefined);
      await new Promise((res) => setTimeout(res, 20));
      const idx = setSpy.mock.calls.findIndex((c) => c[1] === 600_000);
      expect(idx).toBeGreaterThanOrEqual(0);
      const timerId = setSpy.mock.results[idx]!.value;
      session.dispose();
      expect(clearSpy).toHaveBeenCalledWith(timerId);
    } finally { setSpy.mockRestore(); clearSpy.mockRestore(); session.dispose(); }
  });

  it("dismissNamePrompt() clears the name demand raised by an anonymous write", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = await makeSession({ kind: "secret", secret: r.secret });
    await expect(session.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(session.getState().needsName).toBe(true);
    session.dismissNamePrompt();
    expect(session.getState().needsName).toBe(false);
    session.dispose();
  });
});

/**
 * A client whose first history page is answered *before* `after()` runs, so the `getWeave` that
 * load() issues next sees a Weave that has moved on: history stops at the old last seq while the
 * snapshot carries the newer one, and the stream then replays the events in between.
 */
function racingHistoryClient(baseUrl: string, after: () => Promise<void>): LoomClient {
  let raced = false;
  return new LoomClient({
    baseUrl, allowInsecure: true,
    fetch: async (target, init) => {
      const url = typeof target === "string" ? target : target.toString();
      if (!raced && /\/events$/.test(new URL(url).pathname)) {
        raced = true;
        const captured = await fetch(url, init);
        await after();
        return captured;
      }
      return fetch(url, init);
    },
  });
}

/** A client whose second getWeave (the first refresh after load()) is answered now but delivered on release. */
function staleSnapshotClient(baseUrl: string, gate: ReturnType<typeof makeGate>): LoomClient {
  let calls = 0;
  return new LoomClient({
    baseUrl, allowInsecure: true,
    fetch: async (target, init) => {
      const url = typeof target === "string" ? target : target.toString();
      if (/^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname)) {
        calls++;
        if (calls === 2) {
          const captured = await fetch(url, init);
          gate.markEntered();
          await gate.released;
          return captured;
        }
      }
      return fetch(url, init);
    },
  });
}

describe("session guidelines", () => {
  it("loads the instance guidelines beside the Weave's own, and a keeper's change lands in state and in the log", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    // The instance layer is the shipped default until a keeper edits it; this Weave has none of its own.
    expect(session.getState().instanceGuidelines).toBe(DEFAULT_INSTANCE_GUIDELINES);
    expect(session.getState().weave?.guidelines).toBe("");
    await waitFor(() => session.getState().connection === "open");

    await session.setGuidelines("r");
    expect(session.getState().weave?.guidelines).toBe("r");
    await waitFor(() => session.getState().events.some((e) => e.type === "weave.guidelines_changed" && e.payload.guidelines === "r"));
    session.dispose();
  });

  it("a guidelines change that lands while a metadata refresh is in flight is not undone by the stale snapshot", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" }, guidelines: "old" });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const gate = makeGate();
    const session = createSession({ client: staleSnapshotClient(s.baseUrl, gate), target: { kind: "secret", secret: r.secret }, storage });
    // The request the gate suspends is still parked until release(): without this, a failed
    // assertion below would hang the suite on teardown instead of reporting the failure.
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      expect(session.getState().weave?.guidelines).toBe("old");

      // A participant joining starts a metadata refresh, which parks holding pre-change metadata.
      await anon.joinWeave(r.secret, { name: "Other", kind: "human" });
      await gate.entered;

      await s.core.setWeaveGuidelines(await s.core.resolveCredential(r.token), r.weave.id, "new");
      await waitFor(() => session.getState().weave?.guidelines === "new");

      // Every state the panel goes through from here must already be the new text: a momentary
      // revert to "old" is exactly the flicker the watermark exists to prevent.
      const panel: string[] = [];
      session.subscribe(() => panel.push(session.getState().weave?.guidelines ?? "<none>"));
      gate.release();
      await waitFor(() => session.getState().participants.some((p) => p.name === "Other"));
      expect(panel).not.toContain("old");
      expect(session.getState().weave?.guidelines).toBe("new");
    } finally { gate.release(); session.dispose(); }
  });

  it("a clear that lands while a metadata refresh is in flight is not undone by the stale snapshot", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" }, guidelines: "old" });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const gate = makeGate();
    const session = createSession({ client: staleSnapshotClient(s.baseUrl, gate), target: { kind: "secret", secret: r.secret }, storage });
    // The request the gate suspends is still parked until release(): without this, a failed
    // assertion below would hang the suite on teardown instead of reporting the failure.
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      expect(session.getState().weave?.guidelines).toBe("old");

      await anon.joinWeave(r.secret, { name: "Other", kind: "human" });
      await gate.entered;

      await s.core.setWeaveGuidelines(await s.core.resolveCredential(r.token), r.weave.id, "");
      await waitFor(() => session.getState().weave?.guidelines === "");

      const panel: string[] = [];
      session.subscribe(() => panel.push(session.getState().weave?.guidelines ?? "<none>"));
      gate.release();
      await waitFor(() => session.getState().participants.some((p) => p.name === "Other"));
      expect(panel).not.toContain("old");
      expect(session.getState().weave?.guidelines).toBe("");
    } finally { gate.release(); session.dispose(); }
  });

  it("older replayed guidelines events after a newer snapshot stay in history but do not touch the panel", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const keeper = await s.core.resolveCredential(r.token);
    const client = racingHistoryClient(s.baseUrl, async () => {
      await s.core.setWeaveGuidelines(keeper, r.weave.id, "A");   // seq 4
      await s.core.setWeaveGuidelines(keeper, r.weave.id, "B");   // seq 5, the one the snapshot carries
    });
    const session = createSession({ client, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    const panel: string[] = [];
    session.subscribe(() => {
      const st = session.getState();
      if (st.events.some((e) => e.seq === 4)) panel.push(st.weave?.guidelines ?? "<none>");
    });
    await session.load();
    expect(session.getState().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(session.getState().weave?.guidelines).toBe("B");

    await waitFor(() => session.getState().events.some((e) => e.seq === 5));
    expect(session.getState().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // Both replayed changes are in the log, and the panel never showed the older text.
    expect(panel.length).toBeGreaterThan(0);
    expect([...new Set(panel)]).toEqual(["B"]);
    expect(session.getState().weave?.guidelines).toBe("B");
    session.dispose();
  });

  it("a replayed older change after a snapshot that cleared the guidelines does not bring the old text back", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const keeper = await s.core.resolveCredential(r.token);
    const client = racingHistoryClient(s.baseUrl, async () => {
      await s.core.setWeaveGuidelines(keeper, r.weave.id, "A");   // seq 4
      await s.core.setWeaveGuidelines(keeper, r.weave.id, "");    // seq 5: the clear the snapshot sees
    });
    const session = createSession({ client, target: { kind: "secret", secret: r.secret }, storage: memoryStorage() });
    const panel: string[] = [];
    session.subscribe(() => {
      const st = session.getState();
      if (st.events.some((e) => e.seq === 4)) panel.push(st.weave?.guidelines ?? "<none>");
    });
    await session.load();
    // The snapshot is ahead of the history the backfill saw: the replay below is what closes the gap.
    expect(session.getState().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(session.getState().weave?.guidelines).toBe("");

    await waitFor(() => session.getState().events.some((e) => e.seq === 5));
    expect(session.getState().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(panel.length).toBeGreaterThan(0);
    expect([...new Set(panel)]).toEqual([""]);
    expect(session.getState().weave?.guidelines).toBe("");
    session.dispose();
  });
});

/** The Lobby's own secret — the browser's read credential for `/w/<secret>` — which the instance
 *  keeper's credential is the only one to bring back. */
async function lobbySecret(): Promise<string> {
  const { secret } = await anon.withToken(KEEPER).getLobby();
  if (!secret) throw new Error("the keeper credential did not bring back the Lobby secret");
  return secret;
}

/** Names and owners are shared across the one Lobby, so every fixture takes a fresh one. */
let fixtureN = 0;
const MODEL = { model: "gpt-5.6-sol", effort: "high" };

/**
 * A Lobby with a requester, an eligible helper and a target Weave the requester keeps: enough for a
 * request to be opened, offered on, accepted and cancelled.
 */
async function lobbyFixture() {
  const n = ++fixtureN;
  const requester = await anon.joinLobby({ name: `Paw-${n}`, kind: "human" });
  const helper = await anon.joinLobby({ name: `Helper-${n}`, kind: "agent" });
  // `serves: "anyone"` because the requester declares no owner, and only that policy admits "".
  await anon.withToken(helper.token).setCapabilities({ models: [MODEL], tools: [], serves: "anyone", owner: `bob-${n}` });
  const target = await anon.createWeave({ title: `Target ${n}`, opener: "hello", creator: { name: "Paw", kind: "human" } });
  const open = () => anon.withToken(requester.token).openRequest({
    title: `Review PR ${n}`, requirements: { models: [MODEL] }, wanted: 2, timeoutMs: 3_600_000,
    targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id, targetCredential: target.token,
  });
  const storage = memoryStorage();
  const secret = await lobbySecret();
  storage.set(`loom:${secret}`, JSON.stringify({ token: requester.token, participantId: requester.participant.id }));
  storage.set(`loom:${target.secret}`, JSON.stringify({ token: target.token, participantId: target.participant.id }));
  return { secret, storage, requester, helper, target, open };
}

describe("session requests", () => {
  it("on the Lobby, load() records the pointer and every request at its own version", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      expect(session.getState().lobby?.weaveId).toBe((await s.core.getLobby()).weaveId);
      expect(session.getState().requests[r.id]?.version).toBe(r.lastEventSeq);
      expect(session.getState().requests[r.id]?.eligible).toContain(f.helper.participant.id);
    } finally { session.dispose(); }
  });

  // The board is paged, newest first. Reading it as one page would drop an open request older than
  // that page — which is exactly what a Lobby that has closed a few hundred requests looks like.
  it("loads every open request even when the closed page is full", async () => {
    const f = await lobbyFixture();
    const older = await f.open();                       // opened first, so the newest page is all closed
    const requester = anon.withToken(f.requester.token);
    for (let i = 0; i < 3; i++) await requester.cancelRequest((await f.open()).id);
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage, { closedRequestsPage: 2 });
    try {
      const held = Object.values(session.getState().requests);
      expect(held.map((r) => r.id)).toContain(older.id);
      // And the closed history really is capped: three were cancelled, a page of two came back.
      expect(held.filter((r) => r.status === "cancelled")).toHaveLength(2);
    } finally { session.dispose(); }
  });

  it("a live offer event updates the request it names", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).offer(r.id, { model: MODEL.model, effort: MODEL.effort, note: "ready" });
      await waitFor(() => (session.getState().requests[r.id]?.offers.length ?? 0) === 1);
      const held = session.getState().requests[r.id]!;
      expect(held.offers[0]!.participantId).toBe(f.helper.participant.id);
      expect(held.version).toBeGreaterThan(r.lastEventSeq);
    } finally { session.dispose(); }
  });

  it("accept() applies the snapshot it gets back", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    await anon.withToken(f.helper.token).offer(r.id, { model: MODEL.model, effort: MODEL.effort });
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await session.accept(r.id, [f.helper.participant.id]);
      const held = session.getState().requests[r.id]!;
      expect(held.offers.filter((o) => o.accepted).map((o) => o.participantId)).toEqual([f.helper.participant.id]);
      expect(held.version).toBeGreaterThan(r.lastEventSeq);
    } finally { session.dispose(); }
  });

  it("openRequest() adds the new request, and cancel() closes it", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      const r = await session.openRequest({
        title: "From the browser", requirements: { models: [MODEL] }, wanted: 1, timeoutMs: 3_600_000,
        targetWeaveId: f.target.weave.id, targetThreadId: f.target.generalThread.id, targetCredential: f.target.token,
      });
      expect(session.getState().requests[r.id]?.status).toBe("open");
      await session.cancel(r.id);
      expect(session.getState().requests[r.id]?.status).toBe("cancelled");
    } finally { session.dispose(); }
  });

  it("offer() records the offer it just made", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    const storage = memoryStorage();
    storage.set(`loom:${f.secret}`, JSON.stringify({ token: f.helper.token, participantId: f.helper.participant.id }));
    const session = await makeSession({ kind: "secret", secret: f.secret }, storage);
    try {
      await session.offer(r.id, { model: MODEL.model, effort: MODEL.effort, note: "can start now" });
      const held = session.getState().requests[r.id]!;
      expect(held.offers.map((o) => [o.participantId, o.note])).toEqual([[f.helper.participant.id, "can start now"]]);
    } finally { session.dispose(); }
  });

  it("a profile declared after load lands on the participant it belongs to", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().connection === "open");
      const late = await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "agent" });
      // The join's own refresh has landed before the profile exists: only the capabilities event
      // itself can bring it in, which is what the panel and the Offer form read.
      await waitFor(() => session.getState().participants.some((p) => p.id === late.participant.id));
      await anon.withToken(late.token).setCapabilities({ models: [MODEL], serves: "anyone", owner: `late-${fixtureN}` });
      await waitFor(() => session.getState().participants.find((p) => p.id === late.participant.id)?.capabilities != null);
    } finally { session.dispose(); }
  });

  /** A client whose `status=open` listing fails on exactly the calls named, and works otherwise. */
  const flakyListing = (failOn: number[]) => {
    let calls = 0;
    return new LoomClient({
      baseUrl: s.baseUrl,
      allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const parsed = new URL(url);
        if (parsed.pathname === "/api/requests" && parsed.searchParams.get("status") === "open") {
          if (failOn.includes(++calls)) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
  };
  const FAST_RETRY = { delaysMs: [5, 5, 5, 5, 5], slowMs: 20 };

  // The opening event is already in history when the session loads, so nothing will ever be replayed
  // to bring the request in: only a retried read can, and until it lands the panel must say so.
  it("shows a failed initial request read as an error, then retries it until it lands", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    const session = createSession({ client: flakyListing([1]), target: { kind: "secret", secret: f.secret }, storage: f.storage, retry: FAST_RETRY });
    await session.load();
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().requestsError).toBeDefined();
      expect(session.getState().requestsLoaded).toBe(false);
      expect(session.getState().requests[r.id]).toBeUndefined();

      const events = session.getState().events.length;
      await waitFor(() => session.getState().requests[r.id] !== undefined);
      expect(session.getState().requestsError).toBeUndefined();
      expect(session.getState().requestsLoaded).toBe(true);
      expect(session.getState().events.length).toBe(events);      // no new event brought it in
    } finally { session.dispose(); }
  });

  it("keeps the requests it holds when a refresh read fails, and retries that read", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    // Call 1 is the read inside load(); call 2 is the refresh the join below triggers.
    const session = createSession({ client: flakyListing([2]), target: { kind: "secret", secret: f.secret }, storage: f.storage, retry: FAST_RETRY });
    await session.load();
    try {
      expect(session.getState().requests[r.id]).toBeDefined();
      await waitFor(() => session.getState().connection === "open");

      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "agent" });
      await waitFor(() => session.getState().requestsError !== undefined);
      expect(session.getState().requests[r.id]).toBeDefined();     // the held row survives the failure

      await waitFor(() => session.getState().requestsError === undefined);
      expect(session.getState().requestsLoaded).toBe(true);
      expect(session.getState().requests[r.id]).toBeDefined();
    } finally { session.dispose(); }
  });

  // The retry belongs to the load that started it. A second load() retires the first one's loop, so
  // a guard that only asks "is some loop running?" would let the old loop's exit stand for the new
  // load's retry and leave the board unread for good.
  it("retries again for a second load() started while the first load's retry is pending", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    // Call 1 is the first load's read, call 2 the second load's; the first backoff is long enough
    // that the second load starts while the first retry is still sleeping.
    const session = createSession({
      client: flakyListing([1, 2]), target: { kind: "secret", secret: f.secret }, storage: f.storage,
      retry: { delaysMs: [800, 5, 5, 5, 5], slowMs: 20 },
    });
    await session.load();
    try {
      expect(session.getState().requestsError).toBeDefined();

      await session.load();
      expect(session.getState().requestsError).toBeDefined();

      await waitFor(() => session.getState().requests[r.id] !== undefined);
      expect(session.getState().requestsError).toBeUndefined();
      expect(session.getState().requestsLoaded).toBe(true);
    } finally { session.dispose(); }
  });

  /** A client whose fetch is intercepted: `hook` answers a request, or null to let it through. */
  const clientWith = (hook: (url: URL) => Promise<Response> | null) => new LoomClient({
    baseUrl: s.baseUrl,
    allowInsecure: true,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      return hook(new URL(url)) ?? fetch(url, init);
    },
  });

  // Where the Lobby is is a public read like any other, and it can fail. Taken for "this instance
  // has no Lobby" it hides the requests panel and the profile cards for the life of the page: every
  // one of them gates on `state.lobby`, and nothing else ever reads the pointer again.
  it("retries a failed Lobby discovery instead of hiding the panels for good", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    let lobbyCalls = 0;
    const flaky = clientWith((url) => url.pathname === "/api/lobby" && ++lobbyCalls === 1
      ? Promise.reject(new Error("simulated network failure")) : null);
    const session = createSession({ client: flaky, target: { kind: "secret", secret: f.secret }, storage: f.storage, retry: FAST_RETRY });
    await session.load();
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().lobby).toBeUndefined();
      // Not "there is nothing to load": it is not yet known whether this page has a board at all.
      expect(session.getState().requestsLoaded).toBe(false);
      expect(session.getState().requests[r.id]).toBeUndefined();

      const events = session.getState().events.length;
      await waitFor(() => session.getState().lobby !== undefined);
      await waitFor(() => session.getState().requests[r.id] !== undefined);
      expect(session.getState().lobby?.weaveId).toBe((await s.core.getLobby()).weaveId);
      expect(session.getState().requestsLoaded).toBe(true);
      expect(session.getState().requestsError).toBeUndefined();
      expect(session.getState().events.length).toBe(events);     // no event was needed
    } finally { session.dispose(); }
  });

  it("settles the pointer on an ordinary Weave page without reading any requests", async () => {
    const f = await lobbyFixture();
    await f.open();
    let lobbyCalls = 0; let requestReads = 0;
    const flaky = clientWith((url) => {
      if (url.pathname === "/api/requests") requestReads++;
      return url.pathname === "/api/lobby" && ++lobbyCalls === 1
        ? Promise.reject(new Error("simulated network failure")) : null;
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: f.target.secret }, storage: f.storage, retry: FAST_RETRY });
    await session.load();
    try {
      expect(session.getState().lobby).toBeUndefined();
      await waitFor(() => session.getState().lobby !== undefined);
      expect(session.getState().weave?.id).not.toBe(session.getState().lobby?.weaveId);
      expect(session.getState().requests).toEqual({});
      expect(requestReads).toBe(0);                              // the pointer was the whole job
      expect(session.getState().requestsLoaded).toBe(true);
      expect(session.getState().requestsError).toBeUndefined();
    } finally { session.dispose(); }
  });

  it("takes weave_not_found for a settled answer: no Lobby, and nothing to retry", async () => {
    const f = await lobbyFixture();
    let lobbyCalls = 0;
    const absent = clientWith((url) => {
      if (url.pathname !== "/api/lobby") return null;
      lobbyCalls++;
      return Promise.resolve(new Response(JSON.stringify({ code: "weave_not_found", message: "No Lobby on this instance" }),
        { status: 404, headers: { "content-type": "application/json" } }));
    });
    const session = createSession({ client: absent, target: { kind: "secret", secret: f.secret }, storage: f.storage, retry: FAST_RETRY });
    await session.load();
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().lobby).toBeUndefined();
      expect(session.getState().requestsLoaded).toBe(true);      // settled: there is nothing to load
      expect(session.getState().requestsError).toBeUndefined();
      expect(lobbyCalls).toBe(1);
      await new Promise((done) => setTimeout(done, 150));        // many backoffs of FAST_RETRY
      expect(lobbyCalls).toBe(1);                                // no loop is running
    } finally { session.dispose(); }
  });

  it("a Weave that is not the Lobby carries no requests", async () => {
    const f = await lobbyFixture();
    await f.open();
    const session = await makeSession({ kind: "secret", secret: f.target.secret }, f.storage);
    try {
      expect(session.getState().weave?.id).not.toBe(session.getState().lobby?.weaveId);
      expect(session.getState().requests).toEqual({});
    } finally { session.dispose(); }
  });

  it("targets() offers the Weaves this browser holds a token for, never the Lobby", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      const targets = await session.targets();
      expect(targets.map((t) => t.weaveId)).toEqual([f.target.weave.id]);
      expect(targets[0]!.threads.map((t) => t.id)).toEqual([f.target.generalThread.id]);
      expect(targets[0]!.token).toBe(f.target.token);
    } finally { session.dispose(); }
  });

  it("targets() offers id entries and legacy entries alike, and skips an entry with no usable identity", async () => {
    const f = await lobbyFixture();
    const byId = await anon.createWeave({ title: "By id", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    setIdentity(f.storage, byId.weave.id, { token: byId.token, participantId: byId.participant.id });
    // A secret is not a target credential (`assertIsKeeperOf` refuses it), so an entry whose
    // identity died is not something this browser can offer — with or without a secret beside it.
    const dead = await anon.createWeave({ title: "Dead", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    saveWeaveEntry(f.storage, dead.weave.id, { identity: "invalid", secret: dead.secret, title: "Dead" });
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      const targets = await session.targets();
      expect(targets.map((t) => t.weaveId).sort()).toEqual([f.target.weave.id, byId.weave.id].sort());
    } finally { session.dispose(); }
  });
});

// ---------------------------------------------------------------------------------------------
// A session whose target is a Weave id: the credential comes from storage, and a dead identity
// falls back to a stored secret (spec §2.3, §2.6).

/** A participant id that is in no Weave: a stored identity that names nobody. */
const GONE = "00000000-0000-4000-8000-000000000000";

type Mode = "ok" | "silent";

/** A localStorage that can accept every write and keep nothing, so a failed write is observable. */
function installLocalStorage() {
  const raw = new Map<string, string>();
  let mode: Mode = "ok";
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => { if (mode === "ok") raw.set(k, v); },
    removeItem: (k: string) => { if (mode === "ok") raw.delete(k); },
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() { return raw.size; },
    clear: () => raw.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true, writable: true });
  return { raw, setMode: (m: Mode) => { mode = m; } };
}
afterEach(() => { Reflect.deleteProperty(globalThis as object, "localStorage"); });

/** A client that counts every HTTP call, so "no request was made" is observable rather than hoped for. */
function countingClient(): { client: LoomClient; calls: () => number } {
  let calls = 0;
  const client = new LoomClient({
    baseUrl: s.baseUrl, allowInsecure: true,
    fetch: (input, init) => { calls++; return fetch(typeof input === "string" ? input : input.toString(), init); },
  });
  return { client, calls: () => calls };
}

/** A Weave plus a second participant's identity: what a browser that has joined actually holds. */
async function joinedWeave(name: string) {
  const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
  const j = await anon.joinWeave(r.secret, { name, kind: "human" });
  return { r, j };
}

/** An entry whose identity is stored by Weave id, with no secret anywhere near it. */
function storedIdentity(weaveId: string, j: { token: string; participant: { id: string } }, extra: { secret?: string } = {}) {
  const storage = memoryStorage();
  setIdentity(storage, weaveId, { token: j.token, participantId: j.participant.id }, extra);
  return storage;
}

describe("session by weave id", () => {
  it("loads a Weave from a stored participant token, with no secret in play", async () => {
    const { r, j } = await joinedWeave("Paw");
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storedIdentity(r.weave.id, j));
    try {
      const st = session.getState();
      expect(st.status).toBe("ready");
      expect(st.weave?.title).toBe("T");
      expect(st.threads.map((t) => t.id)).toEqual([r.generalThread.id]);
      expect(st.participants.map((p) => p.name)).toContain("Paw");
      expect(st.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(st.me?.participant.id).toBe(j.participant.id);

      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(r.token).postMessage(r.generalThread.id, "from claude");
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "from claude"));
    } finally { session.dispose(); }
  });

  it("caches the name of the identity a load resolved, for a browser that joined before it was kept", async () => {
    // The display cache is written on every successful load anyway (spec §2.4); carrying the name in
    // that same patch is what gives an entry written by an older build — or adopted from a legacy key
    // — its "joined as" line, without a write of its own.
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j);
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    session.dispose();
    expect(readWeaveEntry(storage, r.weave.id)?.name).toBe("Paw");
  });

  it("reads the same Weave whether it is opened by secret or by id", async () => {
    const { r, j } = await joinedWeave("Paw");
    const byId = await makeSession({ kind: "id", weaveId: r.weave.id }, storedIdentity(r.weave.id, j));
    const bySecret = await makeSession({ kind: "secret", secret: r.secret });
    try {
      expect(byId.getState().weave).toEqual(bySecret.getState().weave);
      expect(byId.getState().threads).toEqual(bySecret.getState().threads);
      expect(byId.getState().participants).toEqual(bySecret.getState().participants);
    } finally { byId.dispose(); bySecret.dispose(); }
  });

  it("loads the Lobby's requests board with a stored Lobby participant token", async () => {
    const f = await lobbyFixture();
    const r = await f.open();
    const lobbyId = (await s.core.getLobby()).weaveId;
    const session = await makeSession({ kind: "id", weaveId: lobbyId }, storedIdentity(lobbyId, f.requester));
    try {
      expect(session.getState().lobby?.weaveId).toBe(lobbyId);
      expect(session.getState().requestsLoaded).toBe(true);
      expect(session.getState().requests[r.id]?.version).toBe(r.lastEventSeq);
    } finally { session.dispose(); }
  });

  it("makes no request at all when this browser holds nothing for the Weave", async () => {
    const c = countingClient();
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: GONE }, storage: memoryStorage() });
    await session.load();
    expect(session.getState().status).toBe("no-credential");
    expect(c.calls()).toBe(0);
    session.dispose();
  });

  it("leaves the entry untouched when a token load fails for a transient reason", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j, { secret: r.secret });
    const before = storage.get(weaveKey(r.weave.id));
    const dead = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: () => Promise.reject(new Error("simulated network failure")),
    });
    const session = createSession({ client: dead, target: { kind: "id", weaveId: r.weave.id }, storage });
    await session.load();
    expect(session.getState().status).toBe("error");
    expect(storage.get(weaveKey(r.weave.id))).toBe(before);
    session.dispose();
  });

  it("writes with the stored token: post and createThread succeed", async () => {
    const { r, j } = await joinedWeave("Paw");
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storedIdentity(r.weave.id, j));
    try {
      await session.post("hi @Claude");
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "hi @Claude"));
      await session.createThread("Design");
      await waitFor(() => session.getState().threads.some((t) => t.name === "Design"));
    } finally { session.dispose(); }
  });

  it("never asks for a name: a token only exists because this browser already joined", async () => {
    const { r, j } = await joinedWeave("Paw");
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storedIdentity(r.weave.id, j));
    try {
      expect(session.getState().me?.participant.name).toBe("Paw");
      expect(session.getState().needsName).toBe(false);
      await session.post("x");
      expect(session.getState().needsName).toBe(false);
    } finally { session.dispose(); }
  });

  it("falls back to the stored secret when the token no longer resolves, and invalidates the identity", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret, title: "T" });
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(session.getState().me).toBeUndefined();
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect(e.identity).toBe("invalid");
      expect(e.token).toBeUndefined();
      expect(e.participantId).toBeUndefined();
      expect(e.secret).toBe(r.secret);
      expect(e.title).toBe("T");
      expect(e.lastOpenedAt).toBeDefined();
    } finally { session.dispose(); }
  });

  it("a rejoin from the secret fallback writes a fresh identity and restores writing", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      await session.join("Dana");
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect(e.token).toBe(session.getState().me?.token);
      expect(e.participantId).toBe(session.getState().me?.participant.id);
      expect(e.identity).toBeUndefined();
      expect(e.secret).toBe(r.secret);
      expect(session.getState().readOnlyReason).toBeUndefined();
      await session.post("back in");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "back in"));
    } finally { session.dispose(); }
  });

  it("treats a stored participant that is in nobody's list as a dead identity", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: j.token, participantId: GONE, secret: r.secret });
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(readWeaveEntry(storage, r.weave.id)).toMatchObject({ identity: "invalid", secret: r.secret });
      await session.join("Dana");
      expect(readWeaveEntry(storage, r.weave.id)?.identity).toBeUndefined();
      await session.post("back in");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "back in"));
    } finally { session.dispose(); }
  });

  it("keeps the row, with its cached title, when a dead identity has no secret to fall back to", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, GONE, { token: "not-a-real-token", participantId: GONE, title: "Cached" });
    const session = await makeSession({ kind: "id", weaveId: GONE }, storage);
    try {
      expect(session.getState().status).toBe("no-credential");
      expect(session.getState().error).toMatch(/no longer valid/i);
      expect(readWeaveEntry(storage, GONE)).toMatchObject({ identity: "invalid", title: "Cached" });
    } finally { session.dispose(); }
  });

  it("treats a token that belongs to another Weave exactly like one that no longer resolves", async () => {
    const mine = await anon.createWeave({ title: "Mine", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const other = await anon.createWeave({ title: "Other", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, mine.weave.id, { token: other.token, participantId: other.participant.id, secret: mine.secret });
    const session = await makeSession({ kind: "id", weaveId: mine.weave.id }, storage);
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(readWeaveEntry(storage, mine.weave.id)).toMatchObject({ identity: "invalid", secret: mine.secret });
    } finally { session.dispose(); }
  });

  it("falls back to the secret even when the invalidation itself cannot be persisted", async () => {
    const ls = installLocalStorage();
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = browserStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    ls.setMode("silent");                                   // accepts every write and keeps nothing
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      // The dead token must not read back for the rest of this page, durable or not (§2.4b).
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect(e.identity).toBe("invalid");
      expect(e.token).toBeUndefined();
      expect(e.secret).toBe(r.secret);
    } finally { session.dispose(); }
  });

  it("reads back a rejoin's fresh token even when that write cannot be persisted", async () => {
    const ls = installLocalStorage();
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = browserStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    ls.setMode("silent");
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      await session.join("Dana");
      expect(readWeaveEntry(storage, r.weave.id)?.token).toBe(session.getState().me?.token);
      await session.post("back in");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "back in"));
    } finally { session.dispose(); }
  });

  // Spec §2.6 row 2 on its own: never joined from this browser, but the secret was kept — which is
  // what a `/w/<secret>` visit leaves behind and what Task 7 renders as "reading with the link".
  it("reads with a stored secret alone, and a join is what makes the page writable", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { secret: r.secret, title: "T" });
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(session.getState().me).toBeUndefined();
      // Never joined is not a dead identity: nothing is marked invalid.
      expect(readWeaveEntry(storage, r.weave.id)?.identity).toBeUndefined();

      await session.join("Dana");
      expect(session.getState().readOnlyReason).toBeUndefined();
      await session.post("hello");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "hello"));
    } finally { session.dispose(); }
  });

  it("leaves the entry byte for byte when the Weave itself is gone", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, GONE, { token: "a-token", participantId: GONE, secret: "a-secret", title: "Cached" });
    const before = storage.get(weaveKey(GONE));
    const absent = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        if (url.pathname.startsWith(`/api/weaves/${GONE}`)) {
          return Promise.resolve(new Response(JSON.stringify({ code: "weave_not_found", message: "Weave not found" }),
            { status: 404, headers: { "content-type": "application/json" } }));
        }
        return fetch(url.toString(), init);
      },
    });
    const session = createSession({ client: absent, target: { kind: "id", weaveId: GONE }, storage });
    await session.load();
    try {
      expect(session.getState().status).toBe("error");
      expect(session.getState().error).toMatch(/not found/i);
      // A missing Weave is no evidence against the credential: nothing is invalidated, nothing written.
      expect(storage.get(weaveKey(GONE))).toBe(before);
    } finally { session.dispose(); }
  });

  it("clears the read-only reason when a later load fails", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    let down = false;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: (input, init) => down
        ? Promise.reject(new Error("simulated network failure"))
        : fetch(typeof input === "string" ? input : input.toString(), init),
    });
    const session = createSession({ client: flaky, target: { kind: "id", weaveId: r.weave.id }, storage });
    await session.load();
    try {
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      down = true;
      await session.load();
      expect(session.getState().status).toBe("error");
      // The reason belongs to the read that is on screen; an error is not read-only with a secret.
      expect(session.getState().readOnlyReason).toBeUndefined();
    } finally { session.dispose(); }
  });

  it("joins with the entry's secret before the first load has run", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { secret: r.secret });
    const session = createSession({ client: anon, target: { kind: "id", weaveId: r.weave.id }, storage });
    try {
      await session.join("Dana");
      expect(session.getState().me?.participant.name).toBe("Dana");
      expect(readWeaveEntry(storage, r.weave.id)).toMatchObject({
        token: session.getState().me!.token, participantId: session.getState().me!.participant.id, secret: r.secret,
      });
    } finally { session.dispose(); }
  });

  it("gives a rejoined identity its own one fallback", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    const session = await makeSession({ kind: "id", weaveId: r.weave.id }, storage);
    try {
      await session.join("Dana");
      // The rejoined identity dies in its turn: one fallback per identity, not one per session.
      saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token-either" });
      await session.load();
      expect(session.getState().status).toBe("ready");
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(readWeaveEntry(storage, r.weave.id)?.identity).toBe("invalid");
    } finally { session.dispose(); }
  });
});

describe("session legacy identities", () => {
  it("a bookmarked /w/<secret> keeps an identity that was only ever stored under the legacy key", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    storage.set(legacyKey(r.secret), JSON.stringify({ token: j.token, participantId: j.participant.id }));
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect(session.getState().me?.participant.id).toBe(j.participant.id);
      expect(session.getState().needsName).toBe(false);
      await session.post("still me");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "still me"));
      expect(readWeaveEntry(storage, r.weave.id)).toMatchObject({
        token: j.token, participantId: j.participant.id, secret: r.secret,
      });
      expect(storage.get(legacyKey(r.secret))).toBeNull();          // durable: the copy is safe to drop
    } finally { session.dispose(); }
  });

  it("keeps the legacy key when the migrated entry only reached memory, and is joined all the same", async () => {
    const ls = installLocalStorage();
    const { r, j } = await joinedWeave("Paw");
    const storage = browserStorage();
    storage.set(legacyKey(r.secret), JSON.stringify({ token: j.token, participantId: j.participant.id }));
    ls.setMode("silent");
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect(session.getState().me?.participant.id).toBe(j.participant.id);
      // Nothing was traded away for a copy that would not survive a reload.
      expect(storage.get(legacyKey(r.secret))).not.toBeNull();
      expect(ls.raw.has(legacyKey(r.secret))).toBe(true);
    } finally { session.dispose(); }
  });

  it("prefers the id entry's identity over a leftover legacy one", async () => {
    const { r, j } = await joinedWeave("Old");
    const newer = await anon.joinWeave(r.secret, { name: "New", kind: "human" });
    const storage = memoryStorage();
    storage.set(legacyKey(r.secret), JSON.stringify({ token: j.token, participantId: j.participant.id }));
    setIdentity(storage, r.weave.id, { token: newer.token, participantId: newer.participant.id });
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect(session.getState().me?.participant.name).toBe("New");
    } finally { session.dispose(); }
  });

  it("hands the verdict of every entry write it makes to onWrite", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage({ durable: false });
    saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token", participantId: GONE, secret: r.secret });
    const verdicts: WriteResult[] = [];
    const session = createSession({
      client: anon, target: { kind: "id", weaveId: r.weave.id }, storage, onWrite: (v) => verdicts.push(v),
    });
    await session.load();
    try {
      await session.join("Dana");
      // The invalidation, the display cache the successful re-load writes, and the rejoin.
      expect(verdicts).toEqual(["memory", "memory", "memory"]);
    } finally { session.dispose(); }
  });
});
