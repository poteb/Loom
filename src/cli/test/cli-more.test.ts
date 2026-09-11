import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";

/** A one-shot rendezvous: the awaiter of `entered` learns the pauser has reached the gate, then
 *  the pauser waits on `released` until the test calls `release()`. Mirrors server/test/ws.test.ts,
 *  used here to pin the moment a `read --follow` WS connection is subscribed but not yet replaying. */
function makeGate() {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => { markEntered = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { entered, released, markEntered, release };
}

let s: TestServer;
let gate: ReturnType<typeof makeGate> | undefined;
beforeAll(async () => {
  s = await startTestServer({
    beforeReplay: async () => {
      if (!gate) return;
      gate.markEntered();
      await gate.released;
    },
  });
  await s.core.seedKeepers([keeperToken("k1")]);
});
afterAll(async () => { await s.close(); });

let cfg: string;
beforeEach(() => { cfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"); });

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  let out = ""; let err = "";
  const io: CliIo = {
    stdout: { write: (x: string) => { out += x; } },
    stderr: { write: (x: string) => { err += x; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: cfg, ...extraEnv },
  };
  const code = await runCli(args, io);
  // Getters, not plain fields: a caller that reads `.out`/`.err` after some later event (a delay,
  // a second await) must see writes that happened after `run()` itself resolved, not a string
  // snapshot frozen at this point.
  return {
    code,
    get out() { return out; },
    get err() { return err; },
    json: () => JSON.parse(out),
    lines: () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

describe("threads, roles, archive, export", () => {
  it("thread new/close, role, archive, export", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const joined = (await run(["join", created.secret, "--name", "Other", "--json"], { LOOM_CONFIG: cfg2 })).json();

    const t = await run(["thread", "new", "Design", "--json"]);
    expect(t.code).toBe(0);
    expect(t.json().name).toBe("Design");

    const denied = await run(["thread", "close", t.json().id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.err).code).toBe("forbidden");

    const role = await run(["role", joined.participant.id, "keeper", "--json"]);
    expect(role.code).toBe(0);
    expect(role.json().role).toBe("keeper");
    const closed = await run(["thread", "close", t.json().id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(closed.code).toBe(0);

    const ar = await run(["archive"]);
    expect(ar.code).toBe(0);
    expect(ar.out).toMatch(/archived/i);

    const md = await run(["export"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("# T");
    const js = await run(["export", "--format", "json"]);
    expect(JSON.parse(js.out).events.at(-1).type).toBe("weave.archived");
  });

  it("role and export --format reject invalid values as usage errors", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const badRole = await run(["role", created.participant.id, "boss"]);
    expect(badRole.code).toBe(2);
    const badFormat = await run(["export", "--format", "xml"]);
    expect(badFormat.code).toBe(2);
  });
});

describe("read --follow", () => {
  it("prints the initial batch then streamed events as JSON lines and exits after --count", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const me = s.core;
    const actor = await me.resolveCredential(created.token);
    const follow = run(["read", "--follow", "--since", "3", "--count", "2", "--json"]);
    await new Promise((r) => setTimeout(r, 300));
    await me.postMessage(actor, created.generalThread.id, "one");
    await me.postMessage(actor, created.generalThread.id, "two");
    const res = await follow;
    expect(res.code).toBe(0);
    const lines = res.lines();
    expect(lines.map((e: { seq: number }) => e.seq)).toEqual([4, 5]);
    expect(lines[0].payload.text).toBe("one");
  });

  it("human follow output resolves names for events in new threads", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const actor = await s.core.resolveCredential(created.token);
    const follow = run(["read", "--follow", "--since", "3", "--count", "2"]);
    await new Promise((r) => setTimeout(r, 300));
    const t = await s.core.createThread(actor, created.weave.id, "Design");
    await s.core.postMessage(actor, t.id, "in design");
    const res = await follow;
    expect(res.code).toBe(0);
    expect(res.out).toContain("#4 [Design] * thread.created");
    expect(res.out).toContain("#5 [Design] Me: in design");
  });

  it("stops exactly at --count even when several events arrive in the same replay burst", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const actor = await s.core.resolveCredential(created.token);
    gate = makeGate();
    const follow = run(["read", "--follow", "--since", "3", "--count", "2", "--json"]);
    // The WS handler has subscribed and is parked inside beforeReplay: the CLI's initial
    // (non-stream) batch was already fetched and printed before this point, so these four
    // commits are invisible to it and will only surface once the stream's own replay runs.
    await gate.entered;
    await s.core.postMessage(actor, created.generalThread.id, "one");
    await s.core.postMessage(actor, created.generalThread.id, "two");
    await s.core.postMessage(actor, created.generalThread.id, "three");
    await s.core.postMessage(actor, created.generalThread.id, "four");
    // Releasing now lets replay read all four committed events in a single DB page and send them
    // down the socket back-to-back, deterministically exercising the chained-handler queue: the
    // client's onEvent fires for seq 6 and 7 while the chain link for seq 5 (which reaches
    // --count and calls settle()) may not have run yet.
    gate.release();
    gate = undefined;
    const res = await follow;
    expect(res.code).toBe(0);
    const lines = res.lines();
    expect(lines.map((e: { seq: number }) => e.seq)).toEqual([4, 5]);
    // Read `res.out` live (via run()'s getter), after the follow's promise has already settled,
    // to confirm seq 6 and 7 never get written even though they were already queued.
    const lenAfterResolve = res.out.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(res.out.length).toBe(lenAfterResolve);
  });

  it("filters follow events by --thread", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const actor = await s.core.resolveCredential(created.token);
    const t = await s.core.createThread(actor, created.weave.id, "Design");
    const follow = run(["read", "--follow", "--since", "4", "--thread", t.id, "--count", "1", "--json"]);
    await new Promise((r) => setTimeout(r, 300));
    await s.core.postMessage(actor, created.generalThread.id, "in general");
    await s.core.postMessage(actor, t.id, "in design");
    const res = await follow;
    expect(res.code).toBe(0);
    const lines = res.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].threadId).toBe(t.id);
    expect(lines[0].payload.text).toBe("in design");
  });

  it("rejects a stored-but-invalid token before ever reaching the follow loop", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const store = new ConfigStore(cfg);
    const config = store.load();
    config.weaves[created.weave.id]!.token = "x".repeat(43);
    store.save(config);
    const before = process.listenerCount("SIGINT");
    const res = await run(["read", "--follow", "--count", "1", "--json"]);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.err).code).toBe("invalid_token");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("closes the stream and removes the SIGINT listener when the stream fails while live", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const before = process.listenerCount("SIGINT");
    gate = makeGate();
    const follow = run(["read", "--follow", "--count", "5", "--json"]);
    // The WS handler only reaches beforeReplay after the handshake completed and it subscribed to
    // the bus, so by the time this resolves the client has already seen status "open" — the
    // follow loop is genuinely live, not merely mid-connect.
    await gate.entered;
    // Revoke the participant's token directly in the database (mirrors server/test/ws.test.ts's
    // direct-row technique): the CLI's in-memory client still holds the now-stale token string,
    // so the *next* ws-ticket request for it will fail with invalid_token.
    const pg = s.core.db.$client;
    await pg`update participants set token = ${"revoked-" + created.participant.id} where id = ${created.participant.id}::uuid`;
    gate.release();
    gate = undefined;
    // Force the live connection closed so the client's stream reconnect logic runs, re-requests a
    // ticket with the now-revoked token, and gets a fatal invalid_token back.
    s.dropSockets();
    const res = await follow;
    expect(res.code).toBe(1);
    expect(JSON.parse(res.err).code).toBe("invalid_token");
    expect(process.listenerCount("SIGINT")).toBe(before);
    const lenAfterResolve = res.out.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(res.out.length).toBe(lenAfterResolve);
  });

  it("prints the initial batch before any streamed event, and initial events don't count toward --count", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const actor = await s.core.resolveCredential(created.token);
    const follow = run(["read", "--follow", "--since", "1", "--count", "1", "--json"]);
    await new Promise((r) => setTimeout(r, 300));
    await s.core.postMessage(actor, created.generalThread.id, "streamed");
    const res = await follow;
    expect(res.code).toBe(0);
    const lines = res.lines();
    // seq 2 and 3 are the initial (non-follow) batch for --since 1; they print unconditionally and
    // are not counted. Only the streamed seq 4 counts toward --count 1, so the command exits after it.
    expect(lines.map((e: { seq: number }) => e.seq)).toEqual([2, 3, 4]);
    expect(lines.at(-1).payload.text).toBe("streamed");
  });
});

describe("admin", () => {
  it("requires LOOM_KEEPER_TOKEN and manages weaves, settings, keepers", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const none = await run(["admin", "weaves", "--json"]);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.err).code).toBe("no_keeper_token");
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };

    const w = await run(["admin", "weaves", "--json"], K);
    expect(w.code).toBe(0);
    expect(w.json().weaves.some((x: { id: string }) => x.id === created.weave.id)).toBe(true);

    const st = await run(["admin", "settings", "--set", "instanceName=Fragt", "--set", "maxMessageLength=500", "--json"], K);
    expect(st.code).toBe(0);
    expect(st.json()).toMatchObject({ instanceName: "Fragt", maxMessageLength: 500 });
    const bad = await run(["admin", "settings", "--set", "nope=1", "--json"], K);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).code).toBe("validation");

    const boolOff = await run(["admin", "settings", "--set", "openWeaveCreation=false", "--json"], K);
    expect(boolOff.code).toBe(0);
    expect(boolOff.json().openWeaveCreation).toBe(false);
    const boolOn = await run(["admin", "settings", "--set", "openWeaveCreation=true", "--json"], K);
    expect(boolOn.code).toBe(0);
    expect(boolOn.json().openWeaveCreation).toBe(true);

    const show = await run(["admin", "settings"], K);
    expect(show.out).toContain("instanceName: Fragt");
    await run(["admin", "settings", "--set", "maxMessageLength=20000"], K);

    const add = await run(["admin", "keepers", "add", "Ops", "--json"], K);
    expect(add.code).toBe(0);
    expect(add.json().token).toHaveLength(43);
    const list = await run(["admin", "keepers", "list", "--json"], K);
    expect(list.json().keepers.some((k: { id: string }) => k.id === add.json().keeper.id)).toBe(true);
    const rm = await run(["admin", "keepers", "remove", add.json().keeper.id], K);
    expect(rm.code).toBe(0);
  });
});
