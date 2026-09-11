import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s?.close(); });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(path.join(tmpdir(), "loom-ch-")); });

const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/server.js");

export async function spawnChannel(dir: string): Promise<Client> {
  const client = new Client({ name: "claude-code-like", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_JS],
    env: { ...process.env, LOOM_URL: s!.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CHANNEL_STATE_DIR: dir },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

describe("channel tools", () => {
  it("advertises the claude/channel capability and all tools", async () => {
    const c = await spawnChannel(stateDir);
    const caps = c.getServerCapabilities();
    expect(caps?.experimental).toHaveProperty("claude/channel");
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["create_weave", "join_weave", "post_message", "read_events", "leave_weave", "set_wake", "list_joined"]) expect(names).toContain(n);
    expect(c.getInstructions()).toMatch(/<channel source="loom"/);
    await c.close();
  });

  it("create_weave and join_weave persist the token; leave_weave forgets it", async () => {
    const c = await spawnChannel(stateDir);
    const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
    let cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    expect(cfg.weaves[created.weave.id]).toMatchObject({ token: created.token, participantId: created.participant.id, wake: "all", lastSeq: 0, generalThreadId: created.generalThread.id });
    const listed = json(await c.callTool({ name: "list_joined", arguments: {} }));
    expect(listed).toEqual([expect.objectContaining({ weaveId: created.weave.id, title: "T", participantName: "Claude", wake: "all" })]);
    await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions" } });
    cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    expect(cfg.weaves[created.weave.id].wake).toBe("mentions");
    const left = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
    expect(left.isError).toBeFalsy();
    cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    expect(cfg.weaves).toEqual({});
    const unknown = await c.callTool({ name: "leave_weave", arguments: { weaveId: created.weave.id } });
    expect(unknown.isError).toBe(true);
    await c.close();
  });

  it("other tools work with an explicit credential and map errors", async () => {
    const c = await spawnChannel(stateDir);
    const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
    const posted = json(await c.callTool({ name: "post_message", arguments: { credential: created.token, threadId: created.generalThread.id, text: "hello" } }));
    expect(posted.seq).toBe(4);
    const bad = await c.callTool({ name: "get_weave", arguments: { credential: "garbage", weaveId: created.weave.id } });
    expect(bad.isError).toBe(true);
    expect(json(bad).code).toBe("invalid_token");
    await c.close();
  });

  it("credential \"stored\" resolves to the saved token; keeper tools reject it", async () => {
    const c = await spawnChannel(stateDir);
    const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude" } }));
    const posted = json(await c.callTool({ name: "post_message", arguments: { credential: "stored", threadId: created.generalThread.id, text: "hi" } }));
    expect(posted.seq).toBe(4);
    const events = json(await c.callTool({ name: "read_events", arguments: { credential: "stored", weaveId: created.weave.id } }));
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    const keeper = await c.callTool({ name: "keeper_list", arguments: { credential: "stored" } });
    expect(keeper.isError).toBe(true);
    expect(json(keeper).code).toBe("validation");
    await c.close();
  });
});
