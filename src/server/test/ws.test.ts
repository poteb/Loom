import { describe, it, expect, afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import type { Socket } from "node:net";
import { startTestServer, api, keeperToken } from "./helpers.js";
import type { LoomEvent } from "@loom/core";

function makeGate() {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => { markEntered = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { entered, released, markEntered, release };
}

const KEEPER = keeperToken("ws-keeper");
let gate: ReturnType<typeof makeGate> | undefined;
let drainGate: ReturnType<typeof makeGate> | undefined;
let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  s = await startTestServer({
    beforeReplay: async () => {
      if (!gate) return;
      gate.markEntered();
      await gate.released;
    },
    afterReplay: async () => {
      if (!drainGate) return;
      drainGate.markEntered();
      await drainGate.released;
    },
    pingIntervalMs: 50,
    replayPageSize: 5,
    authTtlMs: 50,
  });
  await s.core.seedKeepers([KEEPER]);
});
afterAll(async () => { await s.close(); });

const creator = { title: "T", opener: "start", creator: { name: "Claude", kind: "agent" } };

async function ticket(cred: string) {
  return (await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred)).json.ticket as string;
}

type Stream = {
  ws: WebSocket;
  events: LoomEvent[];
  /** Resolves when `until` is satisfied. */
  done: Promise<{ events: LoomEvent[]; ws: WebSocket }>;
  /** Resolves once an event with at least this seq has been received. */
  waitFor: (seq: number) => Promise<void>;
};

function collect(url: string, until: (evs: LoomEvent[]) => boolean, timeoutMs = 5000): Stream {
  const ws = new WebSocket(url);
  const events: LoomEvent[] = [];
  const waiters = new Map<number, () => void>();
  let settle!: (v: { events: LoomEvent[]; ws: WebSocket }) => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<{ events: LoomEvent[]; ws: WebSocket }>((res, rej) => { settle = res; fail = rej; });
  const stop = () => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } };
  const timer = setTimeout(() => {
    stop();
    fail(new Error(`timeout; got seqs ${events.map((e) => e.seq)}`));
  }, timeoutMs);
  ws.on("message", (data) => {
    const e = JSON.parse(data.toString()) as LoomEvent;
    events.push(e);
    for (const [seq, resolve] of waiters) if (e.seq >= seq) { waiters.delete(seq); resolve(); }
    if (until(events)) { clearTimeout(timer); settle({ events, ws }); }
  });
  ws.on("error", (e) => { stop(); fail(e); });
  ws.on("unexpected-response", (_req, res) => { stop(); fail(new Error(`HTTP ${res.statusCode}`)); });
  return {
    ws, events, done,
    waitFor: (seq) => Promise.race([
      new Promise<void>((resolve) => {
        if (events.some((e) => e.seq >= seq)) return resolve();
        waiters.set(seq, resolve);
      }),
      done.then(() => undefined),
    ]),
  };
}

describe("stream", () => {
  it("replays from since, then streams live", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const t = await ticket(secret);
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=1&ticket=${t}`, (evs) => evs.length === 3);
    await st.waitFor(3); // replay finished; the handler is live
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "live one" }, token);
    const { events, ws } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(events[2]!.payload).toMatchObject({ text: "live one" });
    ws.close();
  });

  it("delivers an event committed during replay exactly once, in order", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    for (let i = 0; i < 5; i++) await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `m${i}` }, token);
    // seqs now 1..8
    gate = makeGate();
    const t = await ticket(secret);
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`, (evs) => evs.length === 10);
    await gate.entered; // handler is now subscribed and parked inside beforeReplay
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "during" }, token); // seq 9
    gate.release(); gate = undefined;
    await st.waitFor(9); // replay + buffer flush drained
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after" }, token); // seq 10
    const { events, ws } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    ws.close();
  });

  it("recovers a gap when a live event skips a seq", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, participant, generalThread, secret } = c.json;
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(secret)}`, (evs) => evs.length === 5);
    await st.waitFor(3); // live, lastSent = 3

    // Commit seqs 4 and 5 behind the bus's back, then announce only seq 5.
    const pg = s.core.db.$client;
    for (const seq of [4, 5]) {
      await pg`insert into events (weave_id, seq, thread_id, type, actor, payload)
               values (${weave.id}::uuid, ${seq}, ${generalThread.id}::uuid, 'message', ${participant.id},
                       ${JSON.stringify({ text: `direct ${seq}`, mentions: [] })}::jsonb)`;
    }
    await pg`update weaves set last_seq = 5 where id = ${weave.id}::uuid`;
    s.core.bus.publish({
      weaveId: weave.id, seq: 5, threadId: generalThread.id, type: "message",
      actor: participant.id, at: new Date().toISOString(), payload: { text: "direct 5", mentions: [] },
    });

    const { events, ws } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]!.payload).toMatchObject({ text: "direct 4" });
    ws.close();
  });

  it("recovers a gap in the handoff buffer, delivering each event once", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, participant, generalThread, secret } = c.json; // seqs 1..3
    gate = makeGate();
    const t = await ticket(secret);
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`, (evs) => evs.length === 5);
    await gate.entered; // subscribed, parked before replay

    // Commit seqs 4 and 5 behind the bus's back, then announce only seq 5. The buffered seq 5 must
    // travel the same gap-recovering path as a live event, whether or not replay already saw 4.
    const pg = s.core.db.$client;
    for (const seq of [4, 5]) {
      await pg`insert into events (weave_id, seq, thread_id, type, actor, payload)
               values (${weave.id}::uuid, ${seq}, ${generalThread.id}::uuid, 'message', ${participant.id},
                       ${JSON.stringify({ text: `handoff ${seq}`, mentions: [] })}::jsonb)`;
    }
    await pg`update weaves set last_seq = 5 where id = ${weave.id}::uuid`;
    s.core.bus.publish({
      weaveId: weave.id, seq: 5, threadId: generalThread.id, type: "message",
      actor: participant.id, at: new Date().toISOString(), payload: { text: "handoff 5", mentions: [] },
    });
    gate.release(); gate = undefined;

    const { events, ws } = await st.done;
    await new Promise((r) => setTimeout(r, 150)); // a duplicate would land here
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]!.payload).toMatchObject({ text: "handoff 4" });
    ws.close();
  });

  it("recovers a gap from a buffered event parked after replay", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, participant, generalThread, secret } = c.json; // seqs 1..3
    drainGate = makeGate();
    const t = await ticket(secret);
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`, (evs) => evs.length === 5);
    await st.waitFor(3);       // replay has emitted 1..3
    await drainGate.entered;   // parked after replay, still buffering

    // Commit seqs 4 and 5 behind the bus's back, then announce only seq 5 into the buffer.
    const pg = s.core.db.$client;
    for (const seq of [4, 5]) {
      await pg`insert into events (weave_id, seq, thread_id, type, actor, payload)
               values (${weave.id}::uuid, ${seq}, ${generalThread.id}::uuid, 'message', ${participant.id},
                       ${JSON.stringify({ text: `drain ${seq}`, mentions: [] })}::jsonb)`;
    }
    await pg`update weaves set last_seq = 5 where id = ${weave.id}::uuid`;
    s.core.bus.publish({
      weaveId: weave.id, seq: 5, threadId: generalThread.id, type: "message",
      actor: participant.id, at: new Date().toISOString(), payload: { text: "drain 5", mentions: [] },
    });
    drainGate.release(); drainGate = undefined;

    const { events, ws } = await st.done;
    await new Promise((r) => setTimeout(r, 150)); // a duplicate would land here
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]!.payload).toMatchObject({ text: "drain 4" });   // recovered from Postgres by deliver()
    ws.close();
  });

  it("replays across page boundaries in order", async () => {
    // replayPageSize is 5 for this server: 3 creation events + 8 messages = 11 events = 3 pages.
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    for (let i = 0; i < 8; i++) await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `p${i}` }, token);
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(secret)}`, (evs) => evs.length === 11);
    const { events, ws } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    ws.close();
  });

  it("reconnect with since resumes without loss under concurrent writers", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const first = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(secret)}`, (evs) => evs.length === 3).done;
    first.ws.close();
    await Promise.all(Array.from({ length: 15 }, (_, i) =>
      api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `p${i}` }, token)));
    const last = first.events.at(-1)!.seq;
    const second = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=${last}&ticket=${await ticket(secret)}`, (evs) => evs.length === 15).done;
    expect(second.events.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => last + 1 + i));
    second.ws.close();
  });

  it("keeps the connection alive with WebSocket control pings", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const t = await ticket(c.json.secret);
    const ws = new WebSocket(`${s.wsUrl}/api/weaves/${c.json.weave.id}/stream?since=0&ticket=${t}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ping within 1s")), 1000);
        ws.on("ping", () => { clearTimeout(timer); resolve(); });
        ws.on("error", (e) => { clearTimeout(timer); reject(e); });
      });
    } finally { ws.close(); }
  });

  it("survives a malformed (unmasked) frame from an authenticated client", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const t = await ticket(c.json.secret);
    const ws = new WebSocket(`${s.wsUrl}/api/weaves/${c.json.weave.id}/stream?since=0&ticket=${t}`);
    ws.on("error", () => { /* an abrupt server-side terminate() can surface as a client error too */ });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    // RFC 6455 requires every client-to-server frame to be masked. Writing an unmasked frame
    // directly onto the raw socket (bypassing ws's own, always-masked framing) reproduces what
    // WS_ERR_EXPECTED_MASK detects server-side.
    const socket = (ws as unknown as { _socket: Socket })._socket;
    socket.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); // unmasked text "hello"
    await closed; // the server closed the connection instead of crashing the process

    // The server is still alive: a fresh, well-behaved connection still streams normally.
    const c2 = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c2.json;
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=1&ticket=${await ticket(secret)}`, (evs) => evs.length === 3);
    await st.waitFor(3);
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "still alive" }, token);
    const { events, ws: ws2 } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    ws2.close();
  });

  it("closes with 4401 when the streaming keeper's credential is revoked mid-stream", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread } = c.json;

    // A second keeper, so it can be removed without hitting the "a keeper cannot remove itself" guard.
    const added = await api(s.baseUrl, "POST", "/api/admin/keepers", { name: "temp" }, KEEPER);
    const tempKeeperToken = added.json.token as string;
    const tempKeeperId = added.json.keeper.id as string;

    const received: LoomEvent[] = [];
    const t = await ticket(tempKeeperToken);
    const ws = new WebSocket(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`);
    const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as LoomEvent));
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    await api(s.baseUrl, "DELETE", `/api/admin/keepers/${tempKeeperId}`, undefined, KEEPER);
    await new Promise((r) => setTimeout(r, 150)); // past the file-wide 50ms auth cache TTL
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after revoke" }, token);

    const { code, reason } = await closeEvent;
    expect(code).toBe(4401);
    expect(reason).toBe("credential revoked");
    expect(received.some((e) => (e.payload as { text?: string }).text === "after revoke")).toBe(false);

    // A still-valid participant stream on the same weave keeps receiving.
    const st = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=1&ticket=${await ticket(token)}`, (evs) => evs.length === 3);
    const { events, ws: ws2 } = await st.done;
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(events[2]!.payload).toMatchObject({ text: "after revoke" });
    ws2.close();
  });

  it("stops replay with 4401 when the streaming keeper is removed before a replay page", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread } = c.json;
    // A backlog larger than replayPageSize (5), so replay is genuinely multi-page work rather than
    // a single read that happens to finish before anything can change.
    for (let i = 0; i < 6; i++) await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `b${i}` }, token);

    const added = await api(s.baseUrl, "POST", "/api/admin/keepers", { name: "replay" }, KEEPER);
    const tempKeeperToken = added.json.token as string;
    const tempKeeperId = added.json.keeper.id as string;

    gate = makeGate();
    const received: LoomEvent[] = [];
    const ws = new WebSocket(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(tempKeeperToken)}`);
    const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as LoomEvent));
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await gate.entered;   // subscribed, parked before the first replay page

    await api(s.baseUrl, "DELETE", `/api/admin/keepers/${tempKeeperId}`, undefined, KEEPER);
    await new Promise((r) => setTimeout(r, 150));   // past the file-wide 50ms auth cache TTL
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after revoke" }, token);
    gate.release(); gate = undefined;

    // Replay used to run on the Actor captured at connect time, so it read and delivered events
    // committed after the removal — including ones the removed keeper had never been able to see.
    const { code, reason } = await closeEvent;
    expect(code).toBe(4401);
    expect(reason).toBe("credential revoked");
    expect(received).toEqual([]);
  });

  it("keeps an agent-key stream open past the auth TTL", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const { key } = await s.core.addAgent(await s.core.resolveCredential(KEEPER), "WsBot");
    const joined = await api(s.baseUrl, `POST`, `/api/weaves/${secret}/join`, { name: "WsBot", kind: "agent" }, key);
    expect(joined.status).toBe(201);   // seq 4: participant.joined

    // An agent key is an instance-level identity: the mid-stream re-check must map it to its
    // participant in this Weave before asking whether it may read, or it reads as revoked.
    const received: LoomEvent[] = [];
    const closes: number[] = [];
    const ws = new WebSocket(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=4&ticket=${await ticket(key)}`);
    ws.on("message", (data) => received.push(JSON.parse(data.toString()) as LoomEvent));
    ws.on("close", (code) => closes.push(code));
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });

    await new Promise((r) => setTimeout(r, 150));   // past the file-wide 50ms auth cache TTL
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after ttl" }, token);
    await new Promise((r) => setTimeout(r, 300));

    expect(closes).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(received.map((e) => (e.payload as { text?: string }).text)).toContain("after ttl");
    ws.close();
  });

  it("rejects bad ticket, reused ticket, foreign credential, unknown weave", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const b = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const handshake = (url: string) => new Promise<{ status: number; body: string }>((resolve) => {
      const ws = new WebSocket(url);
      ws.on("unexpected-response", (_r, res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      ws.on("open", () => { ws.close(); resolve({ status: 101, body: "" }); });
      ws.on("error", () => { /* the rejection is reported by unexpected-response */ });
    });
    const status = async (url: string) => (await handshake(url)).status;

    const bad = await handshake(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=nope`);
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.body).code).toBe("invalid_token");

    const t = await ticket(a.json.token);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(101);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(401);
    expect(await status(`${s.wsUrl}/api/weaves/${b.json.weave.id}/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    // A participant credential is scoped to its own Weave, so access loses to existence.
    expect(await status(`${s.wsUrl}/api/weaves/00000000-0000-0000-0000-000000000000/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    const unknown = await handshake(`${s.wsUrl}/api/weaves/00000000-0000-0000-0000-000000000000/stream?ticket=${await ticket(KEEPER)}`);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).code).toBe("weave_not_found");
    const noRoute = await handshake(`${s.wsUrl}/api/other?ticket=${await ticket(a.json.token)}`);
    expect(noRoute.status).toBe(404);
    expect(JSON.parse(noRoute.body).code).toBe("not_found");
  });
});

describe("a kick closes the kicked participant's streams (spec 2026-10-09 §8.1)", () => {
  // A server of its own, whose TTL re-check never comes due within a case, so only the re-check a
  // kick forces can close a stream. Its freshDb() truncates the database this file shares with `s`,
  // which is why this describe runs last; `s` serves no case after it.
  let k: Awaited<ReturnType<typeof startTestServer>>;
  let kGate: ReturnType<typeof makeGate> | undefined;
  beforeAll(async () => {
    k = await startTestServer({
      authTtlMs: 600_000,
      beforeReplay: async () => {
        if (!kGate) return;
        kGate.markEntered();
        await kGate.released;
      },
    });
    await k.core.seedKeepers([KEEPER]);
    await k.core.ensureLobby();
  });
  afterAll(async () => { kGate?.release(); await k.close(); });

  const kTicket = async (cred: string) => (await api(k.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred)).json.ticket as string;
  /** A raw stream: what it receives, and how it closes. */
  function watch(url: string) {
    const ws = new WebSocket(url);
    const received: LoomEvent[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as LoomEvent));
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const opened = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return { ws, received, closed, opened };
  }
  /** A Weave whose opener makes seqs 1 to 3, and a member whose join is seq 4. */
  async function room(name: string) {
    const c = await api(k.baseUrl, "POST", "/api/weaves", creator);
    const j = await api(k.baseUrl, "POST", `/api/weaves/${c.json.secret}/join`, { name, kind: "human" });
    return { weaveId: c.json.weave.id as string, secret: c.json.secret as string, keeper: c.json.token as string,
      generalId: c.json.generalThread.id as string, member: j.json.token as string, memberId: j.json.participant.id as string };
  }
  const kick = (r: { weaveId: string; keeper: string }, pid: string) =>
    api(k.baseUrl, "POST", `/api/weaves/${r.weaveId}/participants/${pid}/kick`, undefined, r.keeper);

  it("the kicked member's live stream closes with 4401 before the kick is sent to it; the keeper's stream receives the kick", async () => {
    const r = await room("Mia");
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=4&ticket=${await kTicket(r.member)}`);
    await mine.opened;
    const theirs = collect(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=4&ticket=${await kTicket(r.keeper)}`,
      (evs) => evs.some((e) => e.type === "participant.kicked"));
    expect((await kick(r, r.memberId)).status).toBe(200);
    expect(await mine.closed).toEqual({ code: 4401, reason: "credential revoked" });
    expect(mine.received.map((e) => e.type)).not.toContain("participant.kicked");
    const { events, ws } = await theirs.done;
    expect(events.at(-1)!.payload).toMatchObject({ participantId: r.memberId, name: "Mia" });
    ws.close();
  });

  it("a stream replaying across a kick closes there and sends nothing at or after it", async () => {
    const r = await room("Ned");
    kGate = makeGate();
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=0&ticket=${await kTicket(r.member)}`);
    await kGate.entered;                       // subscribed, parked before the first replay page
    expect((await kick(r, r.memberId)).status).toBe(200);                                                   // seq 5
    await api(k.baseUrl, "POST", `/api/threads/${r.generalId}/messages`, { text: "after the kick" }, r.keeper);   // seq 6
    kGate.release(); kGate = undefined;
    expect((await mine.closed).code).toBe(4401);
    expect(mine.received.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("an agent-key stream closes when that agent's participant is kicked", async () => {
    const r = await room("Ola");
    const { key } = await k.core.addAgent(await k.core.resolveCredential(KEEPER), "KickBot");
    const joined = await api(k.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "KickBot", kind: "agent" }, key);
    expect(joined.status).toBe(201);           // seq 5
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=5&ticket=${await kTicket(key)}`);
    await mine.opened;
    expect((await kick(r, joined.json.participant.id as string)).status).toBe(200);
    expect((await mine.closed).code).toBe(4401);
    expect(mine.received.map((e) => e.type)).not.toContain("participant.kicked");
  });
});
