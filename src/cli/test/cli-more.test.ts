import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";

let s: TestServer;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([keeperToken("k1")]); });
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
  return { code, out, err, json: () => JSON.parse(out), lines: () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
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
