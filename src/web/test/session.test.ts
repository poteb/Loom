import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionTarget } from "../src/session.js";
import { browserStorage, memoryStorage, type KeyValueStorage, type WriteResult } from "../src/storage.js";
import { invalidateIdentity, legacyKey, readWeaveEntry, saveWeaveEntry, setIdentity, weaveKey } from "../src/weaves-store.js";
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

  // What is left of the old "a profile declared after load lands on the participant it belongs to":
  // the participant list still converges on the stream. The profile half of that test is gone with
  // the rule it asserted (spec §3.1) — no other participant's profile is in session state at all
  // now — and lives on as the *own*-profile test below.
  it("a participant who joins after load appears in state.participants", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().connection === "open");
      const late = await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "agent" });
      await waitFor(() => session.getState().participants.some((p) => p.id === late.participant.id));
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
  // has no Lobby" it hides the requests panel and the listeners line for the life of the page: every
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

/**
 * A client whose reads with `token` are refused with `invalid_token` once `revoke()` is called —
 * what a keeper removing this participant looks like from a tab that is already open. The refusals
 * are counted, so "one fallback, and then nothing" is observed rather than hoped for.
 */
function revocableClient(token: string, opts: { refusalMs?: number } = {}): {
  client: LoomClient; revoke: () => void; denied: () => number;
  loadsWith: (credential: string) => number; metadataReadsWith: (credential: string) => number;
} {
  let revoked = false;
  let denied = 0;
  const seen: { path: string; auth: string | undefined }[] = [];
  const client = new LoomClient({
    baseUrl: s.baseUrl, allowInsecure: true,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      seen.push({ path: new URL(url).pathname, auth });
      if (revoked && auth === `Bearer ${token}`) {
        denied++;
        const refusal = () => new Response(JSON.stringify({ code: "invalid_token", message: "Credential is not valid" }),
          { status: 401, headers: { "content-type": "application/json" } });
        // Answered slowly when a test asks for it: a second event has to arrive while the failing
        // refresh is still in flight for `refreshDirty` to be set at all.
        return opts.refusalMs
          ? new Promise<Response>((done) => setTimeout(() => done(refusal()), opts.refusalMs))
          : Promise.resolve(refusal());
      }
      return fetch(url, init);
    },
  });
  return {
    client, revoke: () => { revoked = true; }, denied: () => denied,
    // A load backfills history exactly once (the page loop stops short of `PAGE`), so this counts
    // the loads made with that credential — "the fallback happened once" rather than "at all".
    loadsWith: (credential) => seen.filter((c) => c.path.endsWith("/events") && c.auth === `Bearer ${credential}`).length,
    // Weave metadata reads with that credential. A load makes exactly one — and so would a refresh
    // that restarted behind it, which is how a queued refresh racing the fallback is seen at all.
    metadataReadsWith: (credential: string) =>
      seen.filter((c) => /^\/api\/weaves\/[^/]+$/.test(c.path) && c.auth === `Bearer ${credential}`).length,
  };
}

/** Short enough that an endless retry shows up inside a test, rather than being waited out. */
const QUICK_RETRY = { delaysMs: [5, 5, 5, 5, 5], slowMs: 20 };

/**
 * A client that parks the `parkCall`-th Weave metadata read on `gate` — answered by the server
 * first, so what it delivers on release is genuinely the world as it was — and records the
 * credential of every such read, so "which generation made this one" is observable.
 */
function gatedMetadataClient(baseUrl: string, gate: ReturnType<typeof makeGate>, parkCall: number): {
  client: LoomClient; readsWith: (credential: string) => number;
} {
  const reads: (string | undefined)[] = [];
  const client = new LoomClient({
    baseUrl, allowInsecure: true,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname)) {
        reads.push((init?.headers as Record<string, string> | undefined)?.["authorization"]);
        if (reads.length === parkCall) {
          const captured = await fetch(url, init);
          gate.markEntered();
          await gate.released;
          return captured;
        }
      }
      return fetch(url, init);
    },
  });
  return { client, readsWith: (credential) => reads.filter((a) => a === `Bearer ${credential}`).length };
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

  // The whole §2.6 rule, on the reads a *loaded* session keeps making. Before `/weave/<id>` a
  // session read with a secret, which cannot be revoked; a stored token can die while the tab is
  // open, and treating that as a transient failure retries a credential that is provably dead.
  it("invalidates a token that dies mid-session and falls back to the stored secret, once", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j, { secret: r.secret });
    const c = revocableClient(j.token);
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage, retry: QUICK_RETRY });
    await session.load();
    try {
      expect(session.getState().me?.participant.name).toBe("Paw");
      await waitFor(() => session.getState().connection === "open");
      c.revoke();
      // Someone else's thread is what asks this session for the metadata read that is now refused.
      await anon.withToken(r.token).createThread(r.weave.id, "Design");
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback");
      expect(session.getState().status).toBe("ready");
      expect(session.getState().me).toBeUndefined();
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect([e.identity, e.token, e.participantId, e.secret]).toEqual(["invalid", undefined, undefined, r.secret]);
      const atFallback = c.denied();
      await new Promise((done) => setTimeout(done, 200));     // many backoffs of QUICK_RETRY
      expect([atFallback, c.denied()]).toEqual([1, 1]);       // one refusal, and no loop behind it
    } finally { session.dispose(); }
  });

  it("settles at no-credential when that token dies and no secret was stored", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j);
    const c = revocableClient(j.token);
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage, retry: QUICK_RETRY });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      c.revoke();
      await anon.withToken(r.token).createThread(r.weave.id, "Design");
      await waitFor(() => session.getState().status === "no-credential");
      expect(session.getState().error).toMatch(/no longer valid/i);
      expect(session.getState().refreshError).toBeUndefined();
      // The identity the page reports goes with the identity it just deleted: a session that says
      // it holds no credential must not still be naming the participant the dead token was.
      expect([session.getState().me, session.getState().readOnlyReason]).toEqual([undefined, undefined]);
      expect(readWeaveEntry(storage, r.weave.id)).toMatchObject({ identity: "invalid" });
      const atSettle = c.denied();
      await new Promise((done) => setTimeout(done, 200));
      expect([atSettle, c.denied()]).toEqual([1, 1]);
    } finally { session.dispose(); }
  });

  // A refresh that arrives while the failing one is in flight is only marked dirty, and the
  // `.finally` that drains that mark runs *after* the recovery has retired the loop. Without a
  // generation guard it starts a fresh loop on the credential the recovery just retired — which is
  // the endless retry all over again, now behind a page that says `no-credential`.
  it("drops a refresh queued behind the one that died, instead of restarting the retired loop", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j);
    const c = revocableClient(j.token, { refusalMs: 60 });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage, retry: QUICK_RETRY });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      c.revoke();
      // Two events back to back: the first starts the refresh, the second lands while it is in
      // flight and is the one that sets `refreshDirty`.
      const keeper = anon.withToken(r.token);
      await Promise.all([keeper.createThread(r.weave.id, "A"), keeper.createThread(r.weave.id, "B")]);
      await waitFor(() => session.getState().status === "no-credential");
      const atSettle = c.denied();
      await new Promise((done) => setTimeout(done, 200));
      expect([atSettle, c.denied(), session.getState().refreshError]).toEqual([1, 1, undefined]);
    } finally { session.dispose(); }
  });

  it("drops that queued refresh when a fallback load is what replaces the loop, and falls back once", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j, { secret: r.secret });
    const c = revocableClient(j.token, { refusalMs: 60 });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage, retry: QUICK_RETRY });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      c.revoke();
      const keeper = anon.withToken(r.token);
      await Promise.all([keeper.createThread(r.weave.id, "A"), keeper.createThread(r.weave.id, "B")]);
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback");
      const atFallback = c.denied();
      await new Promise((done) => setTimeout(done, 200));
      // One refusal, one fallback load, and one metadata read behind it: the queued refresh must be
      // dropped, not run against the load that replaced the loop it was queued on.
      expect([atFallback, c.denied(), c.loadsWith(r.secret), c.metadataReadsWith(r.secret)])
        .toEqual([1, 1, 1, 1]);
    } finally { session.dispose(); }
  });

  // A refresh publishes a whole snapshot — weave, threads, participants — so one that settles after
  // its generation was retired does not merely add a stale row, it replaces the state the new
  // generation published with the world as it was before.
  it("publishes nothing from a refresh whose generation was retired while it was in flight", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const j = await anon.joinWeave(r.secret, { name: "Paw", kind: "human" });
    const storage = memoryStorage();
    setIdentity(storage, r.weave.id, { token: j.token, participantId: j.participant.id }, { secret: r.secret });
    const gate = makeGate();
    const session = createSession({ client: staleSnapshotClient(s.baseUrl, gate), target: { kind: "id", weaveId: r.weave.id }, storage });
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      // A participant joining starts a metadata refresh, which parks holding the metadata of now.
      await anon.joinWeave(r.secret, { name: "Other", kind: "human" });
      await gate.entered;

      // The Weave moves on while that refresh is parked…
      const keeper = await s.core.resolveCredential(r.token);
      const fresh = await s.core.createThread(keeper, r.weave.id, "NEW");
      await s.core.setWeaveGuidelines(keeper, r.weave.id, "new rules");

      // …and the §2.6 recovery retires that refresh's generation: the stored token is swapped for a
      // dead one, so the reload invalidates it and falls back to the secret, reading the Weave as
      // it is now.
      saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token" });
      await session.load();
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      expect(session.getState().threads.some((t) => t.id === fresh.id)).toBe(true);
      const seq = session.getState().weave!.lastSeq;

      gate.release();
      await new Promise((done) => setTimeout(done, 150));     // long enough for the stale answer to land
      expect([session.getState().threads.some((t) => t.id === fresh.id),
        session.getState().weave?.guidelines,
        session.getState().weave!.lastSeq >= seq]).toEqual([true, "new rules", true]);
    } finally { gate.release(); session.dispose(); }
  });

  // The slot a refresh runs in is one per session, and a retired generation's request does not stop
  // being in flight just because its generation did: nothing cancels an HTTP request. A recovered
  // session that had to wait for it would lose the updates that arrive in the meantime.
  it("refreshes for the recovered generation without waiting on the retired one's request", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    setIdentity(storage, r.weave.id, { token: j.token, participantId: j.participant.id }, { secret: r.secret });
    const gate = makeGate();
    const c = gatedMetadataClient(s.baseUrl, gate, 2);       // read 1 is the load's; park read 2
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage });
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      // A participant joining starts a refresh, whose metadata read parks — holding the slot.
      await anon.joinWeave(r.secret, { name: "Other", kind: "human" });
      await gate.entered;

      // The §2.6 recovery: the stored token dies, so the reload invalidates it and falls back to
      // the secret. That is the new generation, with a stream of its own (metadata read 3).
      saveWeaveEntry(storage, r.weave.id, { token: "not-a-real-token" });
      await session.load();
      expect(session.getState().readOnlyReason).toBe("secret-fallback");
      await waitFor(() => session.getState().connection === "open");

      // An ordinary update arrives on that new stream while the retired request is still parked.
      const keeper = await s.core.resolveCredential(r.token);
      await s.core.createThread(keeper, r.weave.id, "LATE");
      // It must land without the gate being released at all: the new generation owes the old
      // request nothing, and the Thread is only in the metadata a refresh reads.
      await waitFor(() => session.getState().threads.some((t) => t.name === "LATE"));
      expect(c.readsWith(r.secret)).toBe(2);                 // the recovery's, and this refresh's

      gate.release();
      await new Promise((done) => setTimeout(done, 150));
      // The retired answer publishes nothing, and its `finally` starts nothing.
      expect([session.getState().threads.some((t) => t.name === "LATE"),
        session.getState().readOnlyReason, c.readsWith(r.secret)])
        .toEqual([true, "secret-fallback", 2]);
    } finally { gate.release(); session.dispose(); }
  });

  it("coalesces inside one generation: one refresh in flight, then exactly one more", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j);
    const gate = makeGate();
    const c = gatedMetadataClient(s.baseUrl, gate, 2);
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: r.weave.id }, storage });
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      const keeper = await s.core.resolveCredential(r.token);
      await s.core.createThread(keeper, r.weave.id, "A");    // starts the refresh that parks
      await gate.entered;
      // Two more events while it is parked: both mark the slot dirty, and together they are worth
      // exactly one follow-up refresh — not two.
      await s.core.createThread(keeper, r.weave.id, "B");
      await s.core.createThread(keeper, r.weave.id, "C");
      // Both must have *arrived* before the gate opens, or they would mark the follow-up dirty in
      // turn and earn a third read honestly — which is not what this test is about.
      await waitFor(() => session.getState().events.some((e) => e.payload.name === "C"));
      gate.release();
      await waitFor(() => session.getState().threads.some((t) => t.name === "C"));
      await new Promise((done) => setTimeout(done, 150));
      // The load's read, the parked one, and one follow-up.
      expect([c.readsWith(j.token), session.getState().threads.some((t) => t.name === "B")])
        .toEqual([3, true]);
    } finally { gate.release(); session.dispose(); }
  });

  it("still retries a refresh that failed for a transient reason, and leaves the entry alone", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = storedIdentity(r.weave.id, j, { secret: r.secret });
    let getWeaveCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (/^\/api\/weaves\/[^/]+$/.test(new URL(url).pathname)) {
          getWeaveCalls++;
          // Call 1 belongs to load(); fail the refresh the thread below triggers.
          if (getWeaveCalls === 2) return Promise.reject(new Error("simulated network failure"));
        }
        return fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "id", weaveId: r.weave.id }, storage, retry: QUICK_RETRY });
    await session.load();
    const after = storage.get(weaveKey(r.weave.id));
    try {
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(r.token).createThread(r.weave.id, "Design");
      await waitFor(() => session.getState().threads.some((t) => t.name === "Design"));
      expect(session.getState().readOnlyReason).toBeUndefined();
      expect(session.getState().me?.participant.name).toBe("Paw");
      expect(storage.get(weaveKey(r.weave.id))).toBe(after);
    } finally { session.dispose(); }
  });
});

// Spec §2.6, the row "entry's participantId is not in participants": the same treatment as a dead
// token, whichever credential the read was made with. On `/w/<secret>` the read has already
// succeeded, so no fallback is needed — but the identity is gone all the same, and the page has to
// say so rather than quietly loading as a stranger over a stale stored token.
describe("session identity a secret-link load cannot find", () => {
  it("invalidates the stored identity, keeping the secret and the display cache", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: j.token, participantId: GONE, name: "Paw", secret: r.secret, title: "T" });
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect([e.identity, e.token, e.participantId, e.name, e.secret, e.title])
        .toEqual(["invalid", undefined, undefined, undefined, r.secret, "T"]);
    } finally { session.dispose(); }
  });

  it("comes up ready with no identity, reading with the link", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: j.token, participantId: GONE, secret: r.secret });
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect([session.getState().status, session.getState().me, session.getState().readOnlyReason])
        .toEqual(["ready", undefined, "secret-fallback"]);
    } finally { session.dispose(); }
  });

  it("makes a join the way back: a fresh identity, and writing works again", async () => {
    const { r, j } = await joinedWeave("Paw");
    const storage = memoryStorage();
    saveWeaveEntry(storage, r.weave.id, { token: j.token, participantId: GONE, secret: r.secret });
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      await session.join("Dana");
      const e = readWeaveEntry(storage, r.weave.id)!;
      expect([e.identity, e.token === session.getState().me?.token, session.getState().readOnlyReason])
        .toEqual([undefined, true, undefined]);
      await session.post("back in");
      await waitFor(() => session.getState().events.some((x) => x.payload.text === "back in"));
    } finally { session.dispose(); }
  });

  it("leaves a plain guest visit to /w/<secret> exactly as it was", async () => {
    // A browser that holds nothing must see no banner at all: there is no identity to have lost.
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect([session.getState().status, session.getState().me, session.getState().readOnlyReason])
        .toEqual(["ready", undefined, undefined]);
      expect(readWeaveEntry(storage, r.weave.id)?.identity).toBeUndefined();
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

  it("reads through a valid secret even when the legacy entry beside it is corrupt", async () => {
    // The migration runs on every `/w/<secret>` load, so a cached identity that is not an entry at
    // all must cost nothing but itself — never the Weave the secret still opens.
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    storage.set(legacyKey(r.secret), "null");
    const session = await makeSession({ kind: "secret", secret: r.secret }, storage);
    try {
      expect([session.getState().status, session.getState().me, session.getState().weave?.title])
        .toEqual(["ready", undefined, "T"]);
      expect(storage.get(legacyKey(r.secret))).toBe("null");      // left exactly as it was
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

// ---------------------------------------------------------------------------------------------
// The Lobby's two side reads: the listener count (spec §5.1) and this browser's own profile
// (spec §3.3). Neither is part of the page's own read any more, so each is asserted through what
// the session publishes *and* through the requests these instrumented clients actually saw.

const LISTENERS = "/api/lobby/listeners";
const MY_PROFILE = "/api/lobby/participants/me";
const isWeaveRead = (path: string) => /^\/api\/weaves\/[^/]+$/.test(path);

/** How a scripted call answers: it is handed the pass-through to the server it replaced. */
type Answer = (pass: () => Promise<Response>) => Promise<Response>;
/** What a path answers on its n-th call; `undefined` is "let this one through". */
type Script = (call: number) => Answer | undefined;

const refuses = (code: string, message: string, status: number): Answer => () =>
  Promise.resolve(new Response(JSON.stringify({ code, message }),
    { status, headers: { "content-type": "application/json" } }));
/** A credential the server refuses, and two failures that are no evidence about any credential. */
const REVOKED = refuses("invalid_token", "Credential is not valid", 401);
const BROKEN = refuses("internal", "simulated server failure", 500);
const UNREACHABLE: Answer = () => Promise.reject(new Error("simulated network failure"));

const onCall = (n: number, answer: Answer): Script => (call) => (call === n ? answer : undefined);
const always = (answer: Answer): Script => () => answer;

/**
 * Parks the call on `gate` **holding the answer the server gave when it was made** — the shape of
 * every stale answer here: true when it was asked for, overtaken by the time it lands.
 */
const parks = (gate: ReturnType<typeof makeGate>): Answer => async (pass) => {
  const captured = await pass();
  gate.markEntered();
  await gate.released;
  return captured;
};
/** Parks the call and only then fails it: a rejection that lands long after it was asked for. */
const parksThen = (gate: ReturnType<typeof makeGate>, answer: Answer): Answer => async (pass) => {
  gate.markEntered();
  await gate.released;
  return answer(pass);
};
/** Lets the call through untouched: a scripted slot that only exists to be watched. */
const passes: Answer = (pass) => pass();

/**
 * Wraps an answer so a test can be ordered **after** it rather than merely later than it: the
 * promise settles the moment the client is handed that answer (or that failure), which is what
 * every "and then nothing happened" assertion here actually needs to wait for.
 */
function delivering(answer: Answer): { answer: Answer; delivered: Promise<void> } {
  let mark!: () => void;
  const delivered = new Promise<void>((r) => { mark = r; });
  return { answer: async (pass) => { try { return await answer(pass); } finally { mark(); } }, delivered };
}

/**
 * A client whose calls to a named path are scripted by call number — the Weave metadata read by a
 * script of its own, since its path carries the Weave id — recording the path and credential of
 * every request, so "the count was never read", "the page reloaded" and "with which credential"
 * are observed rather than hoped for.
 */
function sideReadClient(script: Record<string, Script> = {}, weaveRead: Script = () => undefined) {
  const seen: { path: string; auth: string | undefined }[] = [];
  const client = new LoomClient({
    baseUrl: s.baseUrl, allowInsecure: true,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      seen.push({ path, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
      const pass = () => fetch(url, init);
      const nth = seen.filter((c) => c.path === path).length;
      const answer = isWeaveRead(path) ? weaveRead(nth) : script[path]?.(nth);
      return answer ? answer(pass) : pass();
    },
  });
  return {
    client,
    calls: (path: string) => seen.filter((c) => c.path === path).length,
    /** The credential the n-th call on a path carried: which reader a given request went out with. */
    credentialOn: (path: string, nth: number) => seen.filter((c) => c.path === path)[nth - 1]?.auth,
    weaveReads: () => seen.filter((c) => isWeaveRead(c.path)).length,
    weaveReadsWith: (credential: string) =>
      seen.filter((c) => isWeaveRead(c.path) && c.auth === `Bearer ${credential}`).length,
  };
}

/** The Lobby's own id: what `/lobby` and `/weave/<lobby id>` both resolve to. */
const lobbyId = async (): Promise<string> => (await s.core.getLobby()).weaveId;
/** What the Lobby holds right now, asked for exactly as the session asks for it. */
const countNow = async (credential: string): Promise<number> =>
  (await anon.withToken(credential).listListeners({ limit: 0, facets: false })).total;
/** A profile with an owner of its own, so no two fixtures can be taken for one another. */
const aProfile = () => ({ models: [MODEL], serves: "anyone" as const, owner: `owner-${++fixtureN}` });
/**
 * What a "nothing happened" assertion waits for: the scripted answer is in the client's hands, and
 * the loop has then turned enough times for everything behind it — the body read, the rejection it
 * throws, the handler that would act on it — to have run. Turns of the event loop, not a duration:
 * nothing here is waiting for a wall clock to pass a mark.
 */
const afterDelivery = async (delivered: Promise<void>) => {
  await delivered;
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};

/** This browser joined as the fixture's listener: an identity that owns a profile, name and all. */
const asListener = async (f: Awaited<ReturnType<typeof lobbyFixture>>, extra: { secret?: string } = {}) => {
  const storage = memoryStorage();
  setIdentity(storage, await lobbyId(),
    { token: f.helper.token, participantId: f.helper.participant.id, name: f.helper.participant.name }, extra);
  return storage;
};

describe("the Lobby's listener count (spec §5.1)", () => {
  it("has the count on the load of the Lobby, with no refresh and no event", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const session = await makeSession({ kind: "id", weaveId: id }, storedIdentity(id, f.requester));
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      expect(session.getState().listenerCount).toBe(await countNow(f.requester.token));
    } finally { session.dispose(); }
  });

  it("has it on the Lobby opened by its secret link too", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      expect(session.getState().listenerCount).toBe(await countNow(f.requester.token));
    } finally { session.dispose(); }
  });

  // A page whose `getLobby()` failed on load learns it is the Lobby in the retry loop, and nothing
  // else would ever ask: the load's own trigger has been and gone.
  it("still produces a count when the pointer only arrives on a retry", async () => {
    const f = await lobbyFixture();
    let lobbyCalls = 0;
    const flaky = new LoomClient({
      baseUrl: s.baseUrl, allowInsecure: true,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        return new URL(url).pathname === "/api/lobby" && ++lobbyCalls === 1
          ? Promise.reject(new Error("simulated network failure")) : fetch(url, init);
      },
    });
    const session = createSession({ client: flaky, target: { kind: "secret", secret: f.secret }, storage: f.storage, retry: QUICK_RETRY });
    await session.load();
    try {
      expect([session.getState().lobby, session.getState().listenerCount]).toEqual([undefined, undefined]);
      await waitFor(() => session.getState().listenerCount !== undefined);
      expect(session.getState().listenerCount).toBe(await countNow(f.requester.token));
    } finally { session.dispose(); }
  });

  it("brings a listener that appears after the load into the number", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const before = session.getState().listenerCount!;
      await waitFor(() => session.getState().connection === "open");
      const late = await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "agent" });
      await anon.withToken(late.token).setCapabilities(aProfile());
      await waitFor(() => session.getState().listenerCount === before + 1);
    } finally { session.dispose(); }
  });

  // The one event that changes the count without changing the participant list.
  it("takes the number back down when a listener clears its profile", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const before = session.getState().listenerCount!;
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).setCapabilities(null);
      await waitFor(() => session.getState().listenerCount === before - 1);
    } finally { session.dispose(); }
  });

  it("does not let a failing count cost the load anything", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient({ [LISTENERS]: onCall(1, BROKEN) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      const st = session.getState();
      expect([st.status, st.threads.length > 0, st.participants.length > 0, st.events.length > 0, st.listenerCount])
        .toEqual(["ready", true, true, true, undefined]);
      // …and the next trigger fills it in: a failed count is retried, never given up on.
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().listenerCount !== undefined);
    } finally { session.dispose(); }
  });

  // "Not answered yet" and "asked and failed" are different states, and §5.1 words them
  // differently: `listenerCount === undefined` alone cannot say which of the two this is.
  it("says the count failed rather than leaving it looking unanswered", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient({ [LISTENERS]: always(BROKEN) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCountError === true);
      expect(session.getState().listenerCount).toBeUndefined();
    } finally { session.dispose(); }
  });

  it("clears that flag on the next count that answers", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient({ [LISTENERS]: onCall(1, BROKEN) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCountError === true);
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().listenerCountError === false);
      expect(session.getState().listenerCount).toBe(await countNow(f.requester.token));
    } finally { session.dispose(); }
  });

  it("keeps the last number it had when a later count read fails", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient({ [LISTENERS]: onCall(2, UNREACHABLE) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const answered = session.getState().listenerCount!;
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().listenerCountError === true);
      // Never replaced by `undefined`, and never by 0: the number on screen is the last one that
      // was true, beside a flag saying the newest attempt failed.
      expect(session.getState().listenerCount).toBe(answered);
    } finally { session.dispose(); }
  });

  // The ordering rule on the failure path. Without it, a stale rejection spends the page's
  // credential recovery — the most destructive act on this page — on a read nothing is waiting for.
  it("drops a count rejection that a newer answer has already overtaken", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = storedIdentity(id, f.requester, { secret: f.secret });
    const gate = makeGate();
    const stale = delivering(parksThen(gate, REVOKED));
    const c = sideReadClient({ [LISTENERS]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await gate.entered;                                   // read A is out, and unanswered
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });   // the refresh: read B
      await waitFor(() => session.getState().listenerCount !== undefined);
      const settled = { count: session.getState().listenerCount, entry: storage.get(weaveKey(id)), reads: c.weaveReads() };
      gate.release();                                       // …and only now A's 401 lands
      await afterDelivery(stale.delivered);
      expect([session.getState().listenerCount, session.getState().listenerCountError,
        storage.get(weaveKey(id)), c.weaveReads()])
        .toEqual([settled.count, false, settled.entry, settled.reads]);
    } finally { gate.release(); session.dispose(); }
  });

  it("drops a count rejection that a newer rejection has already overtaken", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = storedIdentity(id, f.requester, { secret: f.secret });
    const gate = makeGate();
    const stale = delivering(parksThen(gate, REVOKED));
    const c = sideReadClient({ [LISTENERS]: (n) => (n === 1 ? stale.answer : n === 2 ? BROKEN : undefined) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await gate.entered;
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().listenerCountError === true);
      const settled = { entry: storage.get(weaveKey(id)), reads: c.weaveReads() };
      gate.release();
      await afterDelivery(stale.delivered);
      expect([session.getState().listenerCount, storage.get(weaveKey(id)), c.weaveReads()])
        .toEqual([undefined, settled.entry, settled.reads]);
    } finally { gate.release(); session.dispose(); }
  });

  // An older, larger number landing last would overwrite a newer, smaller one: the generation
  // counter orders nothing *within* a generation, and both reads belong to this one.
  it("does not let an older count overwrite a newer one", async () => {
    const f = await lobbyFixture();
    const gate = makeGate();
    const stale = delivering(parks(gate));
    const c = sideReadClient({ [LISTENERS]: onCall(1, stale.answer) });
    const before = await countNow(f.requester.token);
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await gate.entered;                                   // read A is parked holding `before`
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).setCapabilities(null);            // one listener fewer
      await waitFor(() => session.getState().listenerCount === before - 1);
      gate.release();
      await afterDelivery(stale.delivered);
      expect(session.getState().listenerCount).toBe(before - 1);
    } finally { gate.release(); session.dispose(); }
  });

  // The count describes the Lobby, not the caller, so a browser that has never joined gets one: it
  // is read with the page's own reader, and on this route that reader is the link itself.
  it("counts the Lobby for a browser that holds nothing but the link", async () => {
    await lobbyFixture();
    const secret = await lobbySecret();
    const session = await makeSession({ kind: "secret", secret }, memoryStorage());
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      expect(session.getState().listenerCount).toBe(await countNow(secret));
    } finally { session.dispose(); }
  });

  it("reads no count on a Weave that is not the Lobby", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.target.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      const other = await anon.joinWeave(f.target.secret, { name: `Other-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().participants.some((p) => p.id === other.participant.id));
      expect(c.calls(LISTENERS)).toBe(0);                   // neither on the load nor on the refresh
    } finally { session.dispose(); }
  });

  // The count is read with the page's own reader, so a 401 from it is a page-credential failure and
  // takes the path the requests board's read already takes.
  it("falls back to the stored secret when the count's own read is refused", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = storedIdentity(id, f.requester, { secret: f.secret });
    const c = sideReadClient({ [LISTENERS]: always(REVOKED) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback");
      const e = readWeaveEntry(storage, id)!;
      expect([session.getState().status, session.getState().me, e.identity, e.token, e.secret])
        .toEqual(["ready", undefined, "invalid", undefined, f.secret]);
    } finally { session.dispose(); }
  });
});

// ---------------------------------------------------------------------------------------------
// The directory's own read, and who may spend the page's one credential recovery (spec §6.1,
// §11). `LISTENERS` is a **path**, and the session's own count read is call 1 on it, so every
// script below numbers the directory's queries from 2. Nothing here asserts an absolute number of
// writes or requests: a recovery's own reload writes the entry again and re-reads the Lobby, so
// every "and then nothing happened" is settle, snapshot, act, compare — and "invalidated once" is
// asked of the entry's **content**, which no later no-op write can fake.

describe("reading the directory, and who may spend a recovery (spec §6.1)", () => {
  it("hands the query's rejection back and writes nothing on the strength of it", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const verdicts: WriteResult[] = [];
    const refused = delivering(REVOKED);
    const c = sideReadClient({ [LISTENERS]: onCall(2, refused.answer) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage,
      onWrite: (v) => verdicts.push(v) });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);   // the load is provably finished
      const settled = { entry: storage.get(weaveKey(id)), writes: verdicts.length, reads: c.weaveReads() };
      const { page } = session.listListeners({ limit: 50 });
      await expect(page).rejects.toMatchObject({ code: "invalid_token" });
      await afterDelivery(refused.delivered);
      // Byte-identical entry, no write and no reload: the read path authorises nothing by itself.
      expect([storage.get(weaveKey(id)), verdicts.length, c.weaveReads(), session.getState().status])
        .toEqual([settled.entry, settled.writes, settled.reads, "ready"]);
    } finally { session.dispose(); }
  });

  it("recovers only when the rejection is reported, never on the rejection alone", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const verdicts: WriteResult[] = [];
    const refused = delivering(REVOKED);
    const c = sideReadClient({ [LISTENERS]: onCall(2, refused.answer) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage,
      onWrite: (v) => verdicts.push(v) });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const settled = { entry: storage.get(weaveKey(id)), writes: verdicts.length };
      const { issue, page } = session.listListeners({ limit: 50 });
      const e = await page.then(() => undefined, (err: unknown) => err);
      await afterDelivery(refused.delivered);
      expect([storage.get(weaveKey(id)), verdicts.length]).toEqual([settled.entry, settled.writes]);
      // …and the second call is the whole of the difference: this is the only way in.
      session.reportCredentialFailure(e, issue);
      await waitFor(() => {
        const entry = readWeaveEntry(storage, id);
        return entry?.identity === "invalid" && entry.secret === f.secret;
      });
    } finally { session.dispose(); }
  });

  it("spends exactly one recovery on two rejections of one generation", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const verdicts: WriteResult[] = [];
    const second = delivering(REVOKED);
    // Call 1 is the session's own count read; calls 2 and 3 are the two queries. Call 4 — the count
    // read the recovery's own reload makes, on the secret — is let through: it is none of this
    // test's business, and `always` would have taken call 1 with it.
    const c = sideReadClient({ [LISTENERS]: (n) => (n === 2 ? REVOKED : n === 3 ? second.answer : undefined) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage,
      onWrite: (v) => verdicts.push(v) });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const a = session.listListeners({ limit: 50 });
      const b = session.listListeners({ limit: 50 });                  // both issued before either is reported
      const ea = await a.page.then(() => undefined, (err: unknown) => err);
      const eb = await b.page.then(() => undefined, (err: unknown) => err);
      // Both really are rejections. Without this, a script that numbered the two queries differently
      // would leave one of them `undefined`, `isCredentialFailure` would refuse it, and the
      // "nothing moved" assertion below would pass for the wrong reason.
      expect(ea).toMatchObject({ code: "invalid_token" });
      expect(eb).toMatchObject({ code: "invalid_token" });
      session.reportCredentialFailure(ea, a.issue);
      // The whole recovery, by the state it ends in and not by a number: invalidated, reloaded on
      // the secret, and settled again.
      await waitFor(() => session.getState().status === "ready"
        && readWeaveEntry(storage, id)?.identity === "invalid" && c.weaveReadsWith(f.secret) > 0);
      const settled = { entry: storage.get(weaveKey(id)), writes: verdicts.length, reads: c.weaveReads(),
        onSecret: c.weaveReadsWith(f.secret) };
      session.reportCredentialFailure(eb, b.issue);
      await afterDelivery(second.delivered);
      // What this test proves is the rule, not which mechanism enforces it: two rejections of one
      // generation cost exactly one invalidation — no second write, no second reload, and the
      // session still `ready`. Several guards would each refuse the second report on their own, so
      // this one cannot say which did; test 14c ("refuses an issue taken before a completed
      // reload") is the one that isolates the generation guard.
      expect([storage.get(weaveKey(id)), verdicts.length, c.weaveReads(), c.weaveReadsWith(f.secret),
        session.getState().status])
        .toEqual([settled.entry, settled.writes, settled.reads, settled.onSecret, "ready"]);
      const e = readWeaveEntry(storage, id)!;
      expect([e.identity, e.token, e.participantId, e.secret]).toEqual(["invalid", undefined, undefined, f.secret]);
    } finally { session.dispose(); }
  });

  it("refuses an issue taken before a completed reload", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const verdicts: WriteResult[] = [];
    const gate = makeGate();
    const stale = delivering(parksThen(gate, REVOKED));
    const c = sideReadClient({ [LISTENERS]: onCall(2, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage,
      onWrite: (v) => verdicts.push(v) });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const { issue, page } = session.listListeners({ limit: 50 });
      const rejected = page.then(() => undefined, (err: unknown) => err);
      await gate.entered;                                   // the query is out, and unanswered
      await session.load();                                 // a full reload, and a fresh generation
      await waitFor(() => session.getState().status === "ready");          // its own entry write is behind us
      const settled = { entry: storage.get(weaveKey(id)), writes: verdicts.length, reads: c.weaveReads() };
      gate.release();
      const e = await rejected;
      await afterDelivery(stale.delivered);
      session.reportCredentialFailure(e, issue);
      await afterDelivery(stale.delivered);
      // Nothing was written for a rejection from a retired reader, and the page never went to
      // `no-credential` on its account.
      expect([storage.get(weaveKey(id)), verdicts.length, c.weaveReads(), session.getState().status])
        .toEqual([settled.entry, settled.writes, settled.reads, "ready"]);
    } finally { gate.release(); session.dispose(); }
  });

  it("reads the directory with the credential the page reads with", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    invalidateIdentity(storage, id);                        // this page has already fallen back to the secret
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerCount !== undefined);
      const { page } = session.listListeners({ limit: 50 });
      await page;
      expect(c.credentialOn(LISTENERS, 2)).toBe(`Bearer ${f.secret}`);
    } finally { session.dispose(); }
  });
});

describe("the session's own Lobby profile (spec §3.3)", () => {
  it("reads my own profile onto my own participant on an id target", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const session = await makeSession({ kind: "id", weaveId: id }, await asListener(f));
    try {
      await waitFor(() => session.getState().me?.participant.capabilities != null);
      expect(session.getState().me!.participant.capabilities).toMatchObject({ models: [MODEL], serves: "anyone" });
    } finally { session.dispose(); }
  });

  // The row the spec's second revision was written for: here the page reads with the secret, which
  // owns no participant row, so the profile can only come from a read made with `me`'s own token.
  it("reads it on the Lobby opened by its secret link, where the page reader owns no profile", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, await asListener(f, { secret: f.secret }));
    try {
      await waitFor(() => session.getState().me?.participant.capabilities != null);
      expect(session.getState().me!.participant.capabilities).toMatchObject({ models: [MODEL], serves: "anyone" });
    } finally { session.dispose(); }
  });

  // `refreshInfo` rebuilds `me` from `getWeave`'s list, which carries no profile at all now: without
  // `withMyProfile` at every site that builds `me`, the next refresh quietly blanks it again.
  it("keeps my profile through a refresh", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const session = await makeSession({ kind: "id", weaveId: id }, await asListener(f));
    try {
      await waitFor(() => session.getState().me?.participant.capabilities != null);
      await waitFor(() => session.getState().connection === "open");
      const late = await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().participants.some((p) => p.id === late.participant.id));
      expect(session.getState().me!.participant.capabilities).toMatchObject({ models: [MODEL] });
    } finally { session.dispose(); }
  });

  it("lands a profile declared from another client on my own participant", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().connection === "open");
      expect(session.getState().me!.participant.capabilities).toBeNull();
      // The same identity, declaring its profile from somewhere else: the event names me.
      await anon.withToken(f.requester.token).setCapabilities(aProfile());
      await waitFor(() => session.getState().me?.participant.capabilities != null);
    } finally { session.dispose(); }
  });

  it("gives a participant that has declared none a null profile, and throws nothing", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => c.calls(MY_PROFILE) > 0);
      expect([session.getState().status, session.getState().me!.participant.capabilities]).toEqual(["ready", null]);
    } finally { session.dispose(); }
  });

  it("does not let a failing own-profile read cost the load anything", async () => {
    const f = await lobbyFixture();
    const failed = delivering(BROKEN);
    const c = sideReadClient({ [MY_PROFILE]: (n) => (n === 1 ? failed.answer : BROKEN) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    const after = f.storage.get(weaveKey(await lobbyId()));
    try {
      await afterDelivery(failed.delivered);
      expect([session.getState().status, session.getState().me!.participant.capabilities,
        session.getState().readOnlyReason, f.storage.get(weaveKey(await lobbyId()))])
        .toEqual(["ready", null, undefined, after]);
    } finally { session.dispose(); }
  });

  // The event naming me is the mechanism; the refresh it also schedules is only the backstop. The
  // refresh's own metadata read is parked here, so what is counted is the event's own doing.
  it("re-reads my profile on a capabilities event that names me", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const gate = makeGate();
    const c = sideReadClient({}, onCall(2, parks(gate)));   // read 1 is the load's; park the refresh's
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage: await asListener(f) });
    await session.load();
    try {
      await waitFor(() => c.calls(MY_PROFILE) > 0);
      const reads = c.calls(MY_PROFILE);
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).setCapabilities(aProfile());
      await gate.entered;                                   // the refresh that event scheduled is parked
      await waitFor(() => c.calls(MY_PROFILE) > reads);
    } finally { gate.release(); session.dispose(); }
  });

  it("does not re-read it on a capabilities event that names someone else", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const gate = makeGate();
    const c = sideReadClient({}, onCall(2, parks(gate)));
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage: await asListener(f) });
    await session.load();
    try {
      await waitFor(() => c.calls(MY_PROFILE) > 0);
      const reads = c.calls(MY_PROFILE);
      await waitFor(() => session.getState().connection === "open");
      const other = await anon.joinLobby({ name: `Other-${++fixtureN}`, kind: "agent" });
      await anon.withToken(other.token).setCapabilities(aProfile());
      await gate.entered;
      await waitFor(() => session.getState().events.some((e) => e.type === "participant.capabilities_changed"
        && e.payload.participantId === other.participant.id));
      expect(c.calls(MY_PROFILE)).toBe(reads);
    } finally { gate.release(); session.dispose(); }
  });

  it("does not let an older profile answer resurrect a profile a newer one cleared", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const gate = makeGate();
    const stale = delivering(parks(gate));
    const cleared = delivering(passes);
    const c = sideReadClient({ [MY_PROFILE]: (n) => (n === 1 ? stale.answer : n === 2 ? cleared.answer : undefined) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage: await asListener(f) });
    await session.load();
    try {
      await gate.entered;                                   // read A is parked holding the profile
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).setCapabilities(null);
      await afterDelivery(cleared.delivered);               // read B has answered `null`, and landed
      gate.release();
      await afterDelivery(stale.delivered);
      expect(session.getState().me!.participant.capabilities).toBeNull();
    } finally { gate.release(); session.dispose(); }
  });

  it("discards an answer read for the identity this session has since left", async () => {
    const f = await lobbyFixture();
    const gate = makeGate();
    const stale = delivering(parks(gate));
    const c = sideReadClient({ [MY_PROFILE]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret },
      storage: await asListener(f, { secret: f.secret }) });
    await session.load();
    try {
      await gate.entered;                                   // the read is out, for the old identity
      await session.join(`Rejoined-${++fixtureN}`);
      gate.release();
      await afterDelivery(stale.delivered);
      expect(session.getState().me!.participant.capabilities).toBeNull();
    } finally { gate.release(); session.dispose(); }
  });

  // `join()` deliberately does not bump the generation, which is exactly why the cache is keyed on
  // the identity it was read for: a rejoin is a different participant, with no profile until it
  // declares one.
  it("starts a rejoined identity with no profile", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, await asListener(f, { secret: f.secret }));
    try {
      await waitFor(() => session.getState().me?.participant.capabilities != null);
      const name = `Rejoined-${++fixtureN}`;
      await session.join(name);
      expect([session.getState().me!.participant.name, session.getState().me!.participant.capabilities])
        .toEqual([name, null]);
    } finally { session.dispose(); }
  });

  // The sibling rule: the page is reading perfectly well with the secret, so the identity is
  // retired and *nothing else* — no reload, no retired stream, no generation bump.
  it("invalidates the identity a secret-link visit is refused for, without reloading the page", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const c = sideReadClient({ [MY_PROFILE]: always(REVOKED) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage });
    await session.load();
    const reads = c.weaveReads();
    try {
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback");
      const e = readWeaveEntry(storage, id)!;
      expect([e.identity, e.token, e.participantId, e.name, e.secret, e.title])
        .toEqual(["invalid", undefined, undefined, undefined, f.secret, session.getState().weave!.title]);
      // Still ready, still reading, and the page was never reloaded to report it.
      expect([session.getState().status, session.getState().me, session.getState().threads.length > 0,
        session.getState().events.length > 0, c.weaveReads()])
        .toEqual(["ready", undefined, true, true, reads]);
    } finally { session.dispose(); }
  });

  // On an id target that token *is* the page credential, so the helper retires it and answers
  // `{ reload: true }` — and the caller's job is to act on that answer. Dropping it leaves the page
  // reading with the very token the server has just refused.
  it("reloads an id target with the stored secret when its own token is refused", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const c = sideReadClient({ [MY_PROFILE]: always(REVOKED) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    const reads = c.weaveReads();
    try {
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback");
      const e = readWeaveEntry(storage, id)!;
      expect([e.identity, e.token, e.participantId, e.name, e.secret]).toEqual(["invalid", undefined, undefined, undefined, f.secret]);
      expect([session.getState().me, c.weaveReads() > reads, c.weaveReadsWith(f.secret)])
        .toEqual([undefined, true, 1]);
    } finally { session.dispose(); }
  });

  it("settles at no-credential when that token is refused and no secret was stored", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f);
    const c = sideReadClient({ [MY_PROFILE]: always(REVOKED) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await waitFor(() => session.getState().status === "no-credential");
      expect([session.getState().me, readWeaveEntry(storage, id)!.identity]).toEqual([undefined, "invalid"]);
    } finally { session.dispose(); }
  });

  it("leaves a freshly rejoined identity untouched when the old one's 401 lands late", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const gate = makeGate();
    const verdicts: WriteResult[] = [];
    const stale = delivering(parksThen(gate, REVOKED));
    const c = sideReadClient({ [MY_PROFILE]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage,
      onWrite: (v) => verdicts.push(v) });
    await session.load();
    try {
      await gate.entered;
      await session.join(`Rejoined-${++fixtureN}`);
      const settled = { entry: storage.get(weaveKey(id)), writes: verdicts.length };
      gate.release();
      await afterDelivery(stale.delivered);
      // Byte-identical: the rejected token is not this browser's any more, and a credential the
      // server issued seconds ago must not be deleted on its account.
      expect([storage.get(weaveKey(id)), verdicts.length, !!session.getState().me, session.getState().readOnlyReason])
        .toEqual([settled.entry, settled.writes, true, undefined]);
    } finally { gate.release(); session.dispose(); }
  });

  it("does nothing with a 401 whose generation has been retired", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const gate = makeGate();
    const held = makeGate();
    const stale = delivering(parksThen(gate, REVOKED));
    // The second load's own read is parked too, and never released. Without that it answers first
    // and moves the watermark, so `n <= applied` refuses the stale 401 as well — and this test
    // would stay green with the generation rule deleted, which is the one rule it is here for.
    const c = sideReadClient({ [MY_PROFILE]: (n) => (n === 1 ? stale.answer : parks(held)) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage });
    await session.load();
    try {
      await gate.entered;
      await session.load();                                 // a fresh load, and a fresh generation
      const settled = storage.get(weaveKey(id));
      gate.release();
      await afterDelivery(stale.delivered);
      expect([storage.get(weaveKey(id)), !!session.getState().me, session.getState().readOnlyReason])
        .toEqual([settled, true, undefined]);
    } finally { gate.release(); held.release(); session.dispose(); }
  });

  it("is equally silent about a transient failure for an identity this session has left", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const gate = makeGate();
    const stale = delivering(parksThen(gate, UNREACHABLE));
    const c = sideReadClient({ [MY_PROFILE]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage });
    await session.load();
    try {
      await gate.entered;
      await session.join(`Rejoined-${++fixtureN}`);
      const settled = storage.get(weaveKey(id));
      gate.release();
      await afterDelivery(stale.delivered);
      expect([session.getState().refreshError, storage.get(weaveKey(id)), session.getState().me!.participant.capabilities])
        .toEqual([undefined, settled, null]);
    } finally { gate.release(); session.dispose(); }
  });

  // A newer success with that same token is later, stronger evidence that it works — and deleting a
  // credential cannot be undone.
  it("does not invalidate on a stale 401 for the identity a newer read has just proven good", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const storage = await asListener(f, { secret: f.secret });
    const gate = makeGate();
    const stale = delivering(parksThen(gate, REVOKED));
    const c = sideReadClient({ [MY_PROFILE]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage });
    await session.load();
    try {
      await gate.entered;
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.helper.token).setCapabilities(aProfile());      // read B, for the same identity
      await waitFor(() => session.getState().me?.participant.capabilities != null);
      gate.release();
      await afterDelivery(stale.delivered);
      expect([readWeaveEntry(storage, id)!.token, session.getState().readOnlyReason, !!session.getState().me])
        .toEqual([f.helper.token, undefined, true]);
    } finally { gate.release(); session.dispose(); }
  });

  // A secret link grants read *before* joining, and the read this rule adds is made with `me`'s own
  // token: no identity, nothing to ask with, and nothing to ask for. It is also why the sibling
  // invalidation of §3.3 cannot loop on this route — a page that never joined never asks.
  it("asks for no profile on a Lobby this browser has no identity in", async () => {
    await lobbyFixture();
    const secret = await lobbySecret();
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "secret", secret }, storage: memoryStorage() });
    await session.load();
    try {
      // The page is fully alive — it has the count — so this is silence, not a load that stalled.
      await waitFor(() => session.getState().listenerCount !== undefined);
      expect([session.getState().me, c.calls(MY_PROFILE)]).toEqual([undefined, 0]);
    } finally { session.dispose(); }
  });

  it("reads no profile on a Weave that is not the Lobby", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.target.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      const other = await anon.joinWeave(f.target.secret, { name: `Other-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().participants.some((p) => p.id === other.participant.id));
      expect(c.calls(MY_PROFILE)).toBe(0);
    } finally { session.dispose(); }
  });
});
