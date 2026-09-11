import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { LoomClient, type LoomEvent, type StreamStatus } from "../src/index.js";

let s: TestServer | undefined;
let anon: LoomClient;
beforeAll(async () => { s = await startTestServer(); anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true }); });
afterAll(async () => { await s?.close(); });

function srv(): TestServer {
  if (!s) throw new Error("test server did not start");
  return s;
}

const input = { title: "T", opener: "start", creator: { name: "Claude", kind: "agent" as const } };

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

describe("stream", () => {
  it("replays from since, then delivers live events", async () => {
    const r = await anon.createWeave(input);
    const me = anon.withToken(r.token);
    const got: LoomEvent[] = []; const statuses: StreamStatus[] = [];
    const h = me.stream(r.weave.id, { since: 1, onEvent: (e) => got.push(e), onStatus: (st) => statuses.push(st) });
    await waitFor(() => got.length === 2);
    await me.postMessage(r.generalThread.id, "live");
    await waitFor(() => got.length === 3);
    expect(got.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(h.lastSeq).toBe(4);
    expect(statuses.slice(0, 2)).toEqual(["connecting", "open"]);
    h.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses.at(-1)).toBe("closed");
  });

  it("reconnects with the cursor after the server drops the socket, without loss or duplicates", async () => {
    const r = await anon.createWeave(input);
    const bySecret = anon.withToken(r.secret);
    const me = anon.withToken(r.token);
    const got: LoomEvent[] = []; const statuses: StreamStatus[] = [];
    const h = bySecret.stream(r.weave.id, {
      since: 0, onEvent: (e) => got.push(e), onStatus: (st) => statuses.push(st),
      backoffMs: { initial: 20, max: 50 },
    });
    await waitFor(() => got.length === 3);
    // Drop every server-side socket for this weave, then post while the client is reconnecting.
    srv().dropSockets();
    await waitFor(() => statuses.includes("reconnecting"));
    await me.postMessage(r.generalThread.id, "after drop");
    await waitFor(() => got.length === 4, 8000);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(statuses.filter((x) => x === "open").length).toBeGreaterThanOrEqual(2);
    h.close();
  });

  it("stops with closed + error when the credential is rejected", async () => {
    const r = await anon.createWeave(input);
    const bad = anon.withToken("not-a-valid-token");
    const statuses: [StreamStatus, unknown][] = [];
    bad.stream(r.weave.id, { onEvent: () => {}, onStatus: (st, d) => statuses.push([st, d?.error]) });
    await waitFor(() => statuses.some(([st]) => st === "closed"));
    const closed = statuses.find(([st]) => st === "closed")!;
    expect(closed[1]).toMatchObject({ code: "invalid_token" });
  });

  it("does not reconnect when reconnect is false", async () => {
    const r = await anon.createWeave(input);
    const statuses: StreamStatus[] = [];
    const h = anon.withToken(r.secret).stream(r.weave.id, { onEvent: () => {}, onStatus: (st) => statuses.push(st), reconnect: false });
    await waitFor(() => statuses.includes("open"));
    srv().dropSockets();
    await waitFor(() => statuses.includes("closed"));
    expect(statuses).not.toContain("reconnecting");
    h.close();
  });
});

describe("stream close is terminal", () => {
  it("reports closed exactly once when close() is called twice", async () => {
    const r = await anon.createWeave(input);
    const statuses: StreamStatus[] = [];
    const h = anon.withToken(r.secret).stream(r.weave.id, { onEvent: () => {}, onStatus: (st) => statuses.push(st) });
    await waitFor(() => statuses.includes("open"));
    h.close();
    h.close();
    await new Promise((res) => setTimeout(res, 50));
    expect(statuses.filter((x) => x === "closed")).toHaveLength(1);
  });

  it("reports closed once when close() lands while the ws-ticket request is still in flight", async () => {
    const r = await anon.createWeave(input);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let markRequested!: () => void;
    const requested = new Promise<void>((res) => { markRequested = res; });
    const client = new LoomClient({
      baseUrl: srv().baseUrl,
      allowInsecure: true,
      token: r.secret,
      fetch: async (target, init) => {
        const url = typeof target === "string" ? target : target.toString();
        if (new URL(url).pathname === "/api/auth/ws-ticket") {
          markRequested();
          await gate;
          // The request only fails *after* close(): the post-close catch must stay silent rather
          // than report a second "closed" (or schedule a reconnect) for an already-dead stream.
          throw new Error("socket hang up");
        }
        return fetch(url, init);
      },
    });
    const statuses: StreamStatus[] = [];
    const h = client.stream(r.weave.id, {
      onEvent: () => {}, onStatus: (st) => statuses.push(st), backoffMs: { initial: 10, max: 20 },
    });
    await requested;
    h.close();
    release();
    await new Promise((res) => setTimeout(res, 100));
    expect(statuses.filter((x) => x === "closed")).toHaveLength(1);
    expect(statuses).not.toContain("reconnecting");
  });
});

describe("stream survives a failing WebSocket constructor", () => {
  it("treats a synchronous constructor throw like a dropped socket and reconnects", async () => {
    const r = await anon.createWeave(input);
    let fail = true;
    const Flaky = class {
      constructor(url: string) {
        if (fail) { fail = false; throw new Error("constructor boom"); }
        return new WebSocket(url) as never;
      }
    } as unknown as typeof WebSocket;
    const got: LoomEvent[] = []; const statuses: StreamStatus[] = [];
    const h = anon.withToken(r.secret).stream(r.weave.id, {
      since: 0, onEvent: (e) => got.push(e), onStatus: (st) => statuses.push(st),
      backoffMs: { initial: 10, max: 20 }, WebSocketImpl: Flaky,
    });
    await waitFor(() => got.length === 3);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(statuses).toContain("reconnecting");
    h.close();
  });

  it("reports closed with a network error when the constructor throws and reconnect is false", async () => {
    const r = await anon.createWeave(input);
    const Throwing = class {
      constructor() { throw new Error("constructor boom"); }
    } as unknown as typeof WebSocket;
    const statuses: [StreamStatus, unknown][] = [];
    anon.withToken(r.secret).stream(r.weave.id, {
      onEvent: () => {}, onStatus: (st, d) => statuses.push([st, d?.error]),
      reconnect: false, WebSocketImpl: Throwing,
    });
    await waitFor(() => statuses.some(([st]) => st === "closed"));
    expect(statuses.find(([st]) => st === "closed")![1]).toMatchObject({ code: "network" });
    expect(statuses.filter(([st]) => st === "closed")).toHaveLength(1);
  });
});
