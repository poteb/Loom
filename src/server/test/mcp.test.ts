import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, keeperToken, type TestServer } from "./helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([keeperToken("k1")]); });
afterAll(async () => { await s?.close(); });

async function connect(): Promise<Client> {
  const client = new Client({ name: "chatgpt-like", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s!.baseUrl}/mcp`)));
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse(text(r));

describe("remote MCP at /mcp", () => {
  it("serves the tool catalog without connection-level auth", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("join_weave");
    expect(tools).toHaveLength(17);
    await c.close();
  });

  it("two independent clients collaborate: create → join → post → read", async () => {
    const claude = await connect();
    const gpt = await connect();
    const created = json(await claude.callTool({ name: "create_weave", arguments: { title: "PR 1", opener: "Review it", name: "Claude", kind: "agent" } }));
    const joined = json(await gpt.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "ChatGPT" } }));
    expect(joined.weaveId).toBe(created.weave.id);
    const posted = json(await gpt.callTool({ name: "post_message", arguments: { credential: joined.token, threadId: created.generalThread.id, text: "Looks fine @Claude" } }));
    expect(posted.payload.mentions).toEqual([created.participant.id]);
    const events = json(await claude.callTool({ name: "read_events", arguments: { credential: created.token, weaveId: created.weave.id, since: 3 } }));
    expect(events.map((e: { type: string }) => e.type)).toEqual(["participant.joined", "message"]);
    const info = json(await gpt.callTool({ name: "get_weave", arguments: { credential: created.secret, weaveId: created.weave.id } }));
    expect(info.participants).toHaveLength(2);
    const md = text(await gpt.callTool({ name: "export_weave", arguments: { credential: created.secret, weaveId: created.weave.id, format: "md" } }));
    expect(md).toContain("# PR 1");
    await claude.close(); await gpt.close();
  });

  it("maps core errors to isError tool results", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "join_weave", arguments: { secret: "nope", name: "X" } });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ code: "weave_not_found" });
    const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "A" } }));
    const forbidden = await c.callTool({ name: "post_message", arguments: { credential: created.secret, threadId: created.generalThread.id, text: "x" } });
    expect(json(forbidden).code).toBe("forbidden");
    const bad = await c.callTool({ name: "get_weave", arguments: { credential: "garbage", weaveId: created.weave.id } });
    expect(json(bad).code).toBe("invalid_token");
    await c.close();
  });

  it("keeper tools work with a keeper token", async () => {
    const c = await connect();
    const list = json(await c.callTool({ name: "keeper_list_weaves", arguments: { credential: keeperToken("k1") } }));
    expect(Array.isArray(list)).toBe(true);
    const st = json(await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), instanceName: "Fragt Loom" } }));
    expect(st.instanceName).toBe("Fragt Loom");
    const denied = await c.callTool({ name: "keeper_list", arguments: { credential: "x".repeat(43) } });
    expect(json(denied).code).toBe("invalid_token");
    await c.close();
  });
});
