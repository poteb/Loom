import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";

let s: TestServer;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s.close(); });

let cfg: string;
beforeEach(() => { cfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"); });

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  let out = ""; let err = "";
  const io: CliIo = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: cfg, ...extraEnv },
  };
  const code = await runCli(args, io);
  return { code, out, err, json: () => JSON.parse(out) };
}

describe("loom create / join / info / post / read", () => {
  it("create stores the token and prints the secret; join stores a second identity", async () => {
    const c = await run(["create", "--title", "PR 9", "--opener", "Review PR 9", "--name", "Claude", "--kind", "agent", "--json"]);
    expect(c.code).toBe(0);
    const created = c.json();
    expect(created.secret).toHaveLength(43);
    const h = await run(["create", "--title", "PR 9", "--name", "Claude"]);
    expect(h.out).toMatch(/secret:/i);
    expect(h.out).toContain(`/w/`);

    // a second config file = a second user joining with the secret
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const j = await run(["join", created.secret, "--name", "ChatGPT", "--json"], { LOOM_CONFIG: cfg2 });
    expect(j.code).toBe(0);
    expect(j.json().participant.name).toBe("ChatGPT");

    const info = await run(["info", "--weave", created.weave.id, "--json"]);
    expect(info.code).toBe(0);
    expect(info.json().participants.map((p: { name: string }) => p.name)).toEqual(["Claude", "ChatGPT"]);
  });

  it("post and read use the last weave by default; read supports --since and --thread", async () => {
    const c = await run(["create", "--title", "T", "--opener", "hello", "--name", "Me", "--json"]);
    const created = c.json();
    const p = await run(["post", "second", "message", "--json"]);
    expect(p.code).toBe(0);
    expect(p.json().payload.text).toBe("second message");
    const r = await run(["read", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().events.map((e: { type: string }) => e.type)).toEqual(["thread.created", "participant.joined", "message", "message"]);
    const since = await run(["read", "--since", "3", "--json"]);
    expect(since.json().events.map((e: { seq: number }) => e.seq)).toEqual([4]);
    const human = await run(["read"]);
    expect(human.out).toContain("#4 [General] Me: second message");
    expect(human.out).toContain("#2 [General] * participant.joined");
    const inThread = await run(["read", "--thread", created.generalThread.id, "--json"]);
    expect(inThread.json().events).toHaveLength(4);
  });

  it("reports errors with code and exit 1; usage errors exit 2", async () => {
    const noWeave = await run(["read", "--json"]);
    expect(noWeave.code).toBe(1);
    expect(JSON.parse(noWeave.err).code).toBe("no_weave");
    const bad = await run(["join", "nope", "--name", "X"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("weave_not_found");
    const usage = await run(["create"]);
    expect(usage.code).toBe(2);
    const insecure = await run(["info"], { LOOM_ALLOW_INSECURE: "" });
    expect(insecure.code).toBe(1);
    expect(insecure.err).toContain("insecure_url");
  });
});
