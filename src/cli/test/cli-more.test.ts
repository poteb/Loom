import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoomClient, type StreamHandle, type StreamOptions } from "@loom/client";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";
import { stdinReader } from "../src/main.js";
import { Readable } from "node:stream";

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
// A gate a failing assertion left parked would hold the server's replay hook (and therefore the
// next test's WS connection) forever, turning one failure into a suite-wide hang: always release.
afterEach(() => { gate?.release(); gate = undefined; });

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

  it("export --json outputs the JSON transcript, and wins over a conflicting --format", async () => {
    await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"]);

    const j = await run(["export", "--json"]);
    expect(j.code).toBe(0);
    expect(j.json().events.length).toBeGreaterThan(0);

    const conflict = await run(["export", "--json", "--format", "md"]);
    expect(conflict.code).toBe(0);
    expect(conflict.json().events.length).toBeGreaterThan(0);

    const md = await run(["export", "--format", "md"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("# T");
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
    // (non-stream) batch was already fetched and printed before this point, so these commits are
    // invisible to it and will only surface once the stream's own replay runs.
    await gate.entered;
    // The FIRST event after the cursor is a thread.created on purpose: its handler awaits
    // getWeave() before printing, so the burst behind it is structurally forced to queue on the
    // chain while an earlier link is still suspended — the overshoot hazard this test exists for,
    // rather than one that depends on how the runtime happens to interleave synchronous handlers.
    await s.core.createThread(actor, created.weave.id, "Design");
    await s.core.postMessage(actor, created.generalThread.id, "one");
    await s.core.postMessage(actor, created.generalThread.id, "two");
    await s.core.postMessage(actor, created.generalThread.id, "three");
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
    expect(lines[0].type).toBe("thread.created");
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
    // Count close() calls on the handle the follow loop actually holds: settle() must run exactly
    // once, so the stream is released once — never twice (a double settle) and never zero times.
    let closeCalls = 0;
    const realStream = LoomClient.prototype.stream;
    const streamSpy = vi.spyOn(LoomClient.prototype, "stream").mockImplementation(
      function (this: LoomClient, weaveId: string, opts: StreamOptions): StreamHandle {
        const handle = realStream.call(this, weaveId, opts);
        return { close: () => { closeCalls++; handle.close(); }, get lastSeq() { return handle.lastSeq; } };
      },
    );
    try {
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
      expect(closeCalls).toBe(1);
    } finally { streamSpy.mockRestore(); }
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
    // With creation restricted, an anonymous create is forbidden but a configured keeper token gets through.
    const anonCreate = await run(["create", "--title", "R", "--name", "Me", "--json"]);
    expect(anonCreate.code).toBe(1);
    expect(JSON.parse(anonCreate.err).code).toBe("forbidden");
    const keeperCreate = await run(["create", "--title", "R", "--name", "Me", "--json"], K);
    expect(keeperCreate.code).toBe(0);
    expect(keeperCreate.json().weave.title).toBe("R");
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

describe("v2: thread url, invite, inbox, agents", () => {
  it("thread new --url, thread url, invite, inbox", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Paw", "--kind", "human", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const bot = (await run(["join", created.secret, "--name", "Bot", "--json"], { LOOM_CONFIG: cfg2 })).json();
    const t = await run(["thread", "new", "PR 1", "--url", "https://e.com/1", "--json"]);
    expect(t.code).toBe(0); expect(t.json().url).toBe("https://e.com/1");
    const cleared = await run(["thread", "url", t.json().id, "-", "--json"]);
    expect(cleared.code).toBe(0); expect(cleared.json().url).toBeNull();
    const inv = await run(["invite", t.json().id, bot.participant.id, "--json"]);
    expect(inv.code).toBe(0); expect(inv.json().created).toBe(true);
    const human = await run(["invite", t.json().id, bot.participant.id]);
    expect(human.out).toMatch(/already invited/i);
    const box = await run(["inbox", "--json"], { LOOM_CONFIG: cfg2 });
    expect(box.code).toBe(0); expect(box.json().events.map((e: { type: string }) => e.type)).toEqual(["thread.invited"]);
    const boxHuman = await run(["inbox"], { LOOM_CONFIG: cfg2 });
    expect(boxHuman.out).toContain("invited");
    expect(boxHuman.out).toContain("[PR 1]");   // the thread name comes from the inbox item itself
    const paged = await run(["inbox", "--since", "0", "--limit", "5", "--json"], { LOOM_CONFIG: cfg2 });
    expect(paged.code).toBe(0); expect(paged.json().events).toHaveLength(1);
    // A bad numeric option is a usage error, like read --since / --count.
    expect((await run(["inbox", "--limit", "0", "--json"], { LOOM_CONFIG: cfg2 })).code).toBe(2);
    const denied = await run(["invite", t.json().id, created.participant.id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(denied.code).toBe(1); expect(JSON.parse(denied.err).code).toBe("forbidden");
  });
  it("admin agents and LOOM_AGENT_KEY", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const add = await run(["admin", "agents", "add", "ChatGPT", "--json"], K);
    expect(add.code).toBe(0); expect(add.json().key).toHaveLength(43);
    const list = await run(["admin", "agents", "list"], K);
    expect(list.out).toContain("ChatGPT"); expect(list.out).not.toContain(add.json().key);
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Paw", "--json"])).json();
    const emptyCfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const A = { LOOM_CONFIG: emptyCfg, LOOM_AGENT_KEY: add.json().key };
    // With LOOM_AGENT_KEY set, --name is optional: the server names the participant after the agent.
    const joined = await run(["join", created.secret, "--json"], A);
    expect(joined.code).toBe(0);
    expect(joined.json().participant.agentId).toBe(add.json().agent.id);
    expect(joined.json().participant.name).toBe("ChatGPT");
    // Without a key it is still a usage error to omit it.
    const noName = await run(["join", created.secret, "--json"], { LOOM_CONFIG: emptyCfg });
    expect(noName.code).toBe(2);
    // create with only an agent key links the creator to that agent, exactly as join does.
    const mine = await run(["create", "--title", "Mine", "--opener", "o", "--name", "ChatGPT", "--json"], { ...A, LOOM_CONFIG: path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json") });
    expect(mine.code).toBe(0); expect(mine.json().participant.agentId).toBe(add.json().agent.id);
    const posted = await run(["post", "--weave", created.weave.id, "hello", "--json"], { LOOM_CONFIG: path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"), LOOM_AGENT_KEY: add.json().key });
    expect(posted.code).toBe(0); expect(posted.json().payload.text).toBe("hello");
    const rev = await run(["admin", "agents", "revoke", add.json().agent.id, "--json"], K);
    expect(rev.code).toBe(0);
    const after = await run(["post", "--weave", created.weave.id, "again", "--json"], { LOOM_CONFIG: emptyCfg, LOOM_AGENT_KEY: add.json().key });
    expect(after.code).toBe(1); expect(JSON.parse(after.err).code).toBe("invalid_token");
  });

  // The id and the key are both opaque 40-odd-character strings, and the 2026-09-15 dogfood pasted
  // the id into the connector URL. Each line now says what the value is for, and the URL — the only
  // thing that goes into the MCP client — carries the key.
  it("admin agents add labels the URL, the key and the id", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const add = await run(["admin", "agents", "add", "Labelled"], K);
    expect(add.code).toBe(0);
    const j = await run(["admin", "agents", "list", "--json"], K);
    const agent = j.json().agents.find((a: { name: string }) => a.name === "Labelled");
    const urlLine = add.out.split("\n").find((l) => l.includes("connector URL"))!;
    const keyLine = add.out.split("\n").find((l) => l.trimStart().startsWith("key ("))!;
    const idLine = add.out.split("\n").find((l) => l.trimStart().startsWith("id ("))!;
    expect(add.out).toContain('Added agent "Labelled"');
    expect(urlLine).toContain("copy this into the MCP client");
    expect(urlLine).toContain(`${s.baseUrl}/mcp?agent=`);
    expect(urlLine).not.toContain(agent.id);            // the id must never end up in the connector URL
    expect(keyLine).toContain("shown once");
    expect(idLine).toContain("revoke");
    expect(idLine).toContain(agent.id);
    // The key is the value in the URL, and the same value the key line prints.
    const key = urlLine.slice(urlLine.indexOf("?agent=") + "?agent=".length).trim();
    expect(key).toHaveLength(43);
    expect(keyLine).toContain(key);
    // --json is the machine contract: unchanged shape.
    const j2 = await run(["admin", "agents", "add", "Jsonly", "--json"], K);
    expect(Object.keys(j2.json()).sort()).toEqual(["agent", "key"]);
    expect(j2.json().key).toHaveLength(43);
    // list leads with the name, then the id.
    const list = await run(["admin", "agents", "list"], K);
    const row = list.out.split("\n").find((l) => l.startsWith("Jsonly"))!;
    expect(row).toBe(`Jsonly  ${j2.json().agent.id}  owner:-`);
  });

  it("admin agents add --owner prints the owner line, and admin agents list shows owner:paw and owner:-", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const owned = await run(["admin", "agents", "add", "OwnedCli", "--owner", "paw"], K);
    expect(owned.code).toBe(0);
    expect(owned.out.split("\n").find((l) => l.trimStart().startsWith("owner (fixes the Lobby profile's owner):"))).toMatch(/ paw$/);
    const plain = (await run(["admin", "agents", "add", "PlainCli", "--json"], K)).json();
    const list = (await run(["admin", "agents", "list"], K)).out.split("\n");
    expect(list.find((l) => l.startsWith("OwnedCli"))).toMatch(/  owner:paw$/);
    expect(list.find((l) => l.startsWith("PlainCli"))).toBe(`PlainCli  ${plain.agent.id}  owner:-`);
  });

  it("admin agents set-owner takes an id or a name", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const byIdAgent = (await run(["admin", "agents", "add", "SetById", "--json"], K)).json();
    const byId = await run(["admin", "agents", "set-owner", byIdAgent.agent.id, "paw", "--json"], K);
    expect(byId.code).toBe(0);
    expect(byId.json().owner).toBe("paw");
    await run(["admin", "agents", "add", "SetByName", "--json"], K);
    const byName = await run(["admin", "agents", "set-owner", "SetByName", "bob", "--json"], K);
    expect(byName.code).toBe(0);
    expect(byName.json()).toMatchObject({ name: "SetByName", owner: "bob" });
  });

  it("admin agents revoke accepts a name when it is unambiguous", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const solo = await run(["admin", "agents", "add", "Solo", "--json"], K);
    const byName = await run(["admin", "agents", "revoke", "Solo", "--json"], K);
    expect(byName.code).toBe(0);
    expect(byName.json()).toEqual({ ok: true, id: solo.json().agent.id });
    const list = await run(["admin", "agents", "list"], K);
    expect(list.out.split("\n").find((l) => l.startsWith("Solo"))).toContain("[revoked]");
    // A revoked agent no longer answers to its name.
    const again = await run(["admin", "agents", "revoke", "Solo", "--json"], K);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err).message).toContain("Solo");
    // An unknown name is a lookup failure, not a request the server ever sees.
    const missing = await run(["admin", "agents", "revoke", "Nobody", "--json"], K);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).message).toContain('no agent named "Nobody"');
  });

  it("admin agents revoke refuses an ambiguous name and lists the ids", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const a = await run(["admin", "agents", "add", "Twin", "--json"], K);
    const b = await run(["admin", "agents", "add", "Twin", "--json"], K);
    const amb = await run(["admin", "agents", "revoke", "Twin", "--json"], K);
    expect(amb.code).toBe(2);
    const message = JSON.parse(amb.err).message;
    expect(message).toContain(a.json().agent.id);
    expect(message).toContain(b.json().agent.id);
    // Nothing was revoked: the ids still work one at a time.
    expect((await run(["admin", "agents", "revoke", a.json().agent.id, "--json"], K)).code).toBe(0);
    expect((await run(["admin", "agents", "revoke", "Twin", "--json"], K)).code).toBe(0);   // now unambiguous
  });

  it("admin agents revoke explains an ambiguous name in human mode too", async () => {
    // The 2026-09-15 review found this exiting 2 with both streams empty: the diagnostic only
    // existed in --json mode, so a human was told nothing at all.
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const a = await run(["admin", "agents", "add", "Double", "--json"], K);
    const b = await run(["admin", "agents", "add", "Double", "--json"], K);
    const amb = await run(["admin", "agents", "revoke", "Double"], K);
    expect(amb.code).toBe(2);
    expect(amb.out).toBe("");
    expect(amb.err).toContain('several agents are named "Double"');
    expect(amb.err).toContain(a.json().agent.id);
    expect(amb.err).toContain(b.json().agent.id);
    // Neither of them was revoked by the attempt.
    const rows = (await run(["admin", "agents", "list"], K)).out.split("\n").filter((l) => l.startsWith("Double"));
    expect(rows).toHaveLength(2);
    expect(rows.filter((l) => l.includes("[revoked]"))).toEqual([]);
  });
});

describe("global --url vs. the thread artefact --url", () => {
  // Commander would otherwise hand every --url to the program: these two pin which one wins where.
  it("takes the base URL only before the command name", async () => {
    const created = await run(["--url", s.baseUrl, "create", "--title", "U", "--opener", "o", "--name", "Paw", "--json"], { LOOM_URL: "http://127.0.0.1:1" });
    expect(created.code).toBe(0);
    // Without a base URL anywhere, the --url after the command is the artefact link, not a fallback.
    const t = await run(["thread", "new", "PR 9", "--url", "https://e.com/9", "--json"], { LOOM_URL: "" });
    expect(t.code).toBe(1);
    expect(JSON.parse(t.err).code).toBe("no_url");
    const ok = await run(["--url", s.baseUrl, "thread", "new", "PR 9", "--url", "https://e.com/9", "--json"], { LOOM_URL: "http://127.0.0.1:1" });
    expect(ok.code).toBe(0);
    expect(ok.json().url).toBe("https://e.com/9");
  });
});

describe("stdinReader", () => {
  it("reads the stream once and answers a second `-` from the same promise", async () => {
    // Two `-` arguments in one invocation (`create --guidelines -` piped, then a retry) used to
    // attach a fresh listener set to a stream that had already ended, so the second read resolved
    // "" and silently cleared what the first one had set.
    const stream = Readable.from(["one ", "two"]);
    const reader = stdinReader(stream);
    expect(await reader.read()).toBe("one two");
    expect(await reader.read()).toBe("one two");
    expect(stream.listenerCount("data")).toBe(1);        // one listener set, not one per read
  });

  it("rejects on a stream error, and keeps rejecting rather than re-reading", async () => {
    const stream = new Readable({ read() { this.destroy(new Error("pipe broke")); } });
    const reader = stdinReader(stream);
    await expect(reader.read()).rejects.toThrow("pipe broke");
    await expect(reader.read()).rejects.toThrow("pipe broke");
  });
});
