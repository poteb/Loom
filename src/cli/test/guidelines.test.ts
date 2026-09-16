import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await s.core.seedKeepers([keeperToken("k1")]);
});
afterAll(async () => { await s.close(); });

let cfg: string;
beforeEach(() => { cfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"); });

/** Same shape as the other CLI suites' `run()`, plus the stdin a `-` argument reads from. */
async function run(args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) {
  let out = ""; let err = "";
  const stdin = opts.stdin;
  const io: CliIo = {
    stdout: { write: (x: string) => { out += x; } },
    stderr: { write: (x: string) => { err += x; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: cfg, ...opts.env },
    ...(stdin === undefined ? {} : { stdin: { read: async () => stdin } }),
  };
  const code = await runCli(args, io);
  return { code, out, err, json: () => JSON.parse(out) };
}

describe("guidelines", () => {
  it("create --guidelines, guidelines, guidelines set (stdin and clear), and the event rendering", async () => {
    const created = (await run(["create", "--title", "T", "--name", "Paw", "--guidelines", "rules", "--json"])).json();
    expect(created.weave.guidelines).toBe("rules");

    const show = await run(["guidelines"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("## Loom guidelines");
    expect(show.out).toContain("## Guidelines for this Weave");
    expect(show.out).toContain("rules");

    const j = await run(["guidelines", "--json"]);
    expect(j.code).toBe(0);
    expect(j.json().weave).toBe("rules");
    expect(j.json().instance.length).toBeGreaterThan(0);
    expect(j.json().combined).toContain("rules");

    const set = await run(["guidelines", "set", "rules 2"]);
    expect(set.code).toBe(0);
    expect(set.out.trim()).toBe("Guidelines updated (seq 4)");
    const again = await run(["guidelines", "set", "rules 2"]);
    expect(again.code).toBe(0);
    expect(again.out.trim()).toBe("Guidelines unchanged");

    // `-` is the long-text escape hatch: the value comes from stdin, not the command line.
    const piped = await run(["guidelines", "set", "-"], { stdin: "from stdin" });
    expect(piped.code).toBe(0);
    expect((await run(["guidelines", "--json"])).json().weave).toBe("from stdin");
    const noStdin = await run(["guidelines", "set", "-"]);
    expect(noStdin.code).toBe(1);
    expect(noStdin.err).toContain("no stdin available for -");

    const read = await run(["read"]);
    expect(read.out).toContain("#4 [General] * guidelines changed by Paw\n    rules 2");

    const cleared = await run(["guidelines", "set", ""]);
    expect(cleared.code).toBe(0);
    const after = await run(["guidelines"]);
    expect(after.out).toContain("## Loom guidelines");
    expect(after.out).not.toContain("## Guidelines for this Weave");
    const clearedEvent = await run(["read"]);
    expect(clearedEvent.out).toContain("* guidelines cleared by Paw");
  });

  it("create --guidelines - reads stdin", async () => {
    const created = (await run(["create", "--title", "T2", "--name", "Paw", "--guidelines", "-", "--json"], { stdin: "piped rules" })).json();
    expect(created.weave.guidelines).toBe("piped rules");
  });

  it("a member cannot set the Weave guidelines", async () => {
    const created = (await run(["create", "--title", "T3", "--name", "Paw", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const joined = await run(["join", created.secret, "--name", "Member", "--json"], { env: { LOOM_CONFIG: cfg2 } });
    expect(joined.code).toBe(0);
    const denied = await run(["guidelines", "set", "x"], { env: { LOOM_CONFIG: cfg2 } });
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("(forbidden)");
  });

  // Last: it rewrites the instance layer every other test in this file reads.
  it("admin settings --set guidelines=- takes the instance text from stdin", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const set = await run(["admin", "settings", "--set", "guidelines=-", "--json"], { env: K, stdin: "instance rules" });
    expect(set.code).toBe(0);
    expect(set.json().guidelines).toBe("instance rules");
    const shown = await run(["admin", "settings", "--json"], { env: K });
    expect(shown.json().guidelines).toBe("instance rules");
  });
});
