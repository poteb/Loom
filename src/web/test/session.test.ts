import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { LoomClient } from "@loom/client";
import { createSession, type Session } from "../src/session.js";
import { memoryStorage } from "../src/storage.js";

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
