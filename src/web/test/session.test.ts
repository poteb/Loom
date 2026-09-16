import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { LoomClient } from "@loom/client";
import { createSession, type Session } from "../src/session.js";
import { memoryStorage } from "../src/storage.js";
import { DEFAULT_INSTANCE_GUIDELINES } from "@loom/core";

let s: TestServer;
let anon: LoomClient;
beforeAll(async () => { s = await startTestServer(); anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true }); });
afterAll(async () => { await s.close(); });

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

async function makeSession(secret: string, storage = memoryStorage()): Promise<Session> {
  const session = createSession({ client: anon, secret, storage });
  await session.load();
  return session;
}

describe("session", () => {
  it("loads by secret (read-only), streams live events, and requires a name to post", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = await makeSession(r.secret);
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
    const a = await makeSession(r.secret, storage);
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

    const b = await makeSession(r.secret, storage);
    expect(b.getState().me?.participant.name).toBe("Paw");
    b.dispose();
  });

  it("visiting a thread does not acknowledge invites that arrive later", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Paw", kind: "human" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const a = await makeSession(r.secret, storage);
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
    const k = await makeSession(r.secret, storage);
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
    const session = createSession({ client: anon, secret: "nope", storage: memoryStorage() });
    await session.load();
    expect(session.getState().status).toBe("error");
    expect(session.getState().error).toMatch(/not found/i);
  });

  it("anonymous writes always demand a name, whether or not the session has loaded", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });

    const unloaded = createSession({ client: anon, secret: r.secret, storage: memoryStorage() });
    await expect(unloaded.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.createThread("Design")).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.closeThread(r.generalThread.id)).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);
    await expect(unloaded.archive()).rejects.toMatchObject({ code: "no_identity" });
    expect(unloaded.getState().needsName).toBe(true);

    const loaded = await makeSession(r.secret);
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
    const session = createSession({ client: anon, secret: r.secret, storage: memoryStorage() });
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
    const session = createSession({ client: racing, secret: r.secret, storage: memoryStorage() });
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
    const session = createSession({ client: flaky, secret: r.secret, storage: memoryStorage() });
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
      client: flaky, secret: r.secret, storage: memoryStorage(),
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
    const session = createSession({ client: flaky, secret: r.secret, storage: memoryStorage() });
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
    const session = createSession({ client: flaky, secret: r.secret, storage });
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
    const session = createSession({ client: flaky, secret: r.secret, storage });
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
    const session = createSession({ client: gated, secret: r.secret, storage });
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
      const session = createSession({ client: gatedClient(s.baseUrl, gate), secret: r.secret, storage: memoryStorage() });
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
      const session = createSession({ client: gatedClient(s.baseUrl, gate), secret: r.secret, storage: memoryStorage() });
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
    const session = createSession({ client: anon, secret: r.secret, storage: memoryStorage() });
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
      client: flaky, secret: r.secret, storage: memoryStorage(),
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
    const session = await makeSession(r.secret);
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
    const session = await makeSession(r.secret, storage);
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
    const session = createSession({ client: staleSnapshotClient(s.baseUrl, gate), secret: r.secret, storage });
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
    const session = createSession({ client: staleSnapshotClient(s.baseUrl, gate), secret: r.secret, storage });
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
    const session = createSession({ client, secret: r.secret, storage: memoryStorage() });
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
    const session = createSession({ client, secret: r.secret, storage: memoryStorage() });
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
