import { describe, it, expect, afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { startTestServer, api } from "./helpers.js";
import type { LoomEvent } from "@loom/core";

let gate: { resolve: () => void; promise: Promise<void> } | undefined;
let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  s = await startTestServer({ beforeReplay: async () => { if (gate) await gate.promise; } });
});
afterAll(async () => { await s.close(); });

const creator = { title: "T", opener: "start", creator: { name: "Claude", kind: "agent" } };

async function ticket(cred: string) {
  return (await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred)).json.ticket as string;
}

function collect(url: string, until: (evs: LoomEvent[]) => boolean, timeoutMs = 5000): Promise<{ events: LoomEvent[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: LoomEvent[] = [];
    const timer = setTimeout(() => reject(new Error(`timeout; got seqs ${events.map((e) => e.seq)}`)), timeoutMs);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") return;
      events.push(msg);
      if (until(events)) { clearTimeout(timer); resolve({ events, ws }); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); });
  });
}

describe("stream", () => {
  it("replays from since, then streams live", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const t = await ticket(secret);
    const pending = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=1&ticket=${t}`, (evs) => evs.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "live one" }, token);
    const { events, ws } = await pending;
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(events[2]!.payload).toMatchObject({ text: "live one" });
    ws.close();
  });

  it("delivers an event committed during replay exactly once, in order", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    for (let i = 0; i < 5; i++) await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `m${i}` }, token);
    // seqs now 1..8
    let release!: () => void;
    gate = { resolve: () => release(), promise: new Promise<void>((r) => { release = r; }) };
    const t = await ticket(secret);
    const pending = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`, (evs) => evs.length === 10);
    await new Promise((r) => setTimeout(r, 100)); // handler is now subscribed and parked before replay
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "during" }, token); // seq 9
    gate.resolve(); gate = undefined;
    await new Promise((r) => setTimeout(r, 100));
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after" }, token); // seq 10
    const { events, ws } = await pending;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    ws.close();
  });

  it("reconnect with since resumes without loss under concurrent writers", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const first = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(secret)}`, (evs) => evs.length === 3);
    first.ws.close();
    await Promise.all(Array.from({ length: 15 }, (_, i) =>
      api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `p${i}` }, token)));
    const last = first.events.at(-1)!.seq;
    const second = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=${last}&ticket=${await ticket(secret)}`, (evs) => evs.length === 15);
    expect(second.events.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => last + 1 + i));
    second.ws.close();
  });

  it("rejects bad ticket, reused ticket, foreign credential, unknown weave", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const b = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const status = (url: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("error", () => {});
    });
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=nope`)).toBe(401);
    const t = await ticket(a.json.token);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(101);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(401);
    expect(await status(`${s.wsUrl}/api/weaves/${b.json.weave.id}/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    expect(await status(`${s.wsUrl}/api/weaves/00000000-0000-0000-0000-000000000000/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    expect(await status(`${s.wsUrl}/api/other?ticket=${await ticket(a.json.token)}`)).toBe(404);
  });
});
