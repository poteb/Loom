import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve, type ServerType } from "@hono/node-server";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";
import { startTestServer, keeperToken, type TestServer } from "./helpers.js";

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([keeperToken("k1")]); });
afterAll(async () => { await s?.close(); });

async function connect(): Promise<Client> {
  const client = new Client({ name: "chatgpt-like", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s!.baseUrl}/mcp`)));
  return client;
}

/** Connects `n` clients, runs `fn`, and always closes them — a failed assertion must not leave
 * open HTTP sessions behind to hang teardown. */
async function withClients<T>(n: number, fn: (clients: Client[]) => Promise<T>): Promise<T> {
  const clients = await Promise.all(Array.from({ length: n }, () => connect()));
  try {
    return await fn(clients);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
const withClient = <T>(fn: (c: Client) => Promise<T>): Promise<T> => withClients(1, ([c]) => fn(c!));
const withTwoClients = <T>(fn: (a: Client, b: Client) => Promise<T>): Promise<T> => withClients(2, ([a, b]) => fn(a!, b!));
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse(text(r));

describe("remote MCP at /mcp", () => {
  it("serves the tool catalog without connection-level auth", async () => {
    await withClient(async (c) => {
        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name)).toContain("join_weave");
        expect(tools).toHaveLength(17);
    });
  });

  it("serves three clients that connect concurrently to a freshly mounted app", async () => {
    // A *fresh* app: its McpServer has never been connected, so all three handshakes race the
    // one-time server.connect(). The mount must connect exactly once and make every request wait
    // for that same attempt, instead of checking isConnected() and handling a request on a
    // transport whose start() is still in flight.
    const tickets = new TicketStore();
    const app = buildApp({ core: s!.core, tickets });
    const server: ServerType = await new Promise((resolve) => {
      const h = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(h));
    });
    const addr = server.address();
    const url = new URL(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`);
    const clients: Client[] = [];
    try {
      await Promise.all(Array.from({ length: 3 }, async () => {
        const c = new Client({ name: "racer", version: "1.0" });
        clients.push(c);
        await c.connect(new StreamableHTTPClientTransport(url));
      }));
      const lists = await Promise.all(clients.map((c) => c.listTools()));
      expect(lists).toHaveLength(3);
      for (const { tools } of lists) expect(tools.map((t) => t.name)).toContain("join_weave");
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      tickets.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("two independent clients collaborate: create → join → post → read", async () => {
    await withTwoClients(async (claude, gpt) => {
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
    });
  });

  it("maps core errors to isError tool results", async () => {
    await withClient(async (c) => {
      const r = await c.callTool({ name: "join_weave", arguments: { secret: "nope", name: "X" } });
      expect(r.isError).toBe(true);
      expect(json(r)).toMatchObject({ code: "weave_not_found" });
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "A" } }));
      const forbidden = await c.callTool({ name: "post_message", arguments: { credential: created.secret, threadId: created.generalThread.id, text: "x" } });
      expect(json(forbidden).code).toBe("forbidden");
      const bad = await c.callTool({ name: "get_weave", arguments: { credential: "garbage", weaveId: created.weave.id } });
      expect(json(bad).code).toBe("invalid_token");
    });
  });

  it("keeper tools work with a keeper token", async () => {
    await withClient(async (c) => {
      const list = json(await c.callTool({ name: "keeper_list_weaves", arguments: { credential: keeperToken("k1") } }));
      expect(Array.isArray(list)).toBe(true);
      const st = json(await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), instanceName: "Fragt Loom" } }));
      expect(st.instanceName).toBe("Fragt Loom");
      const denied = await c.callTool({ name: "keeper_list", arguments: { credential: "x".repeat(43) } });
      expect(json(denied).code).toBe("invalid_token");
    });
  });
});
