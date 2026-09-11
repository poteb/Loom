import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
});
