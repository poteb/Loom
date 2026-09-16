import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve, type ServerType } from "@hono/node-server";
import { DEFAULT_INSTANCE_GUIDELINES, INSTANCE_HEADING } from "@loom/core";
import { buildApp } from "../src/app.js";
import { LOBBY_MECHANICS } from "@loom/mcp-tools";
import { MCP_INSTRUCTIONS, type MountMcpOptions } from "../src/mcp/index.js";
import { TicketStore } from "../src/tickets.js";
import { startTestServer, keeperToken, type TestServer } from "./helpers.js";

/** Races `p` against a timeout so a hung request fails the test instead of hanging the run. */
function withTimeout<T>(p: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function startFreshApp(core: TestServer["core"], opts?: { mcpConnect?: MountMcpOptions["connect"]; mcpSessionTtlMs?: number }) {
  const tickets = new TicketStore();
  const { app, stop: stopSweep } = buildApp({ core, tickets, mcpConnect: opts?.mcpConnect, mcpSessionTtlMs: opts?.mcpSessionTtlMs });
  const server: ServerType = await new Promise((resolve) => {
    const h = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(h));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return {
    baseUrl,
    mcpUrl: new URL(`${baseUrl}/mcp`),
    close: async () => {
      tickets.stop();
      stopSweep();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let s: TestServer | undefined;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([keeperToken("k1")]); await s.core.ensureLobby(); });
afterAll(async () => { await s?.close(); });

/** Connects `n` clients, runs `fn`, and always closes them — a failed assertion, or one client's
 * connect() rejecting while its siblings already hold open sessions, must not leave HTTP sessions
 * leaked behind to hang teardown. So every Client is created up front (a cheap, synchronous, never-
 * failing step) before any connect() is attempted, and the try/finally that closes them wraps the
 * connecting too — not just the caller's `fn`. */
async function withClientsAt<T>(url: URL, n: number, fn: (clients: Client[]) => Promise<T>): Promise<T> {
  const clients = Array.from({ length: n }, () => new Client({ name: "chatgpt-like", version: "1.0" }));
  try {
    await Promise.all(clients.map((c) => c.connect(new StreamableHTTPClientTransport(url))));
    return await fn(clients);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
const withClients = <T>(n: number, fn: (clients: Client[]) => Promise<T>): Promise<T> =>
  withClientsAt(new URL(`${s!.baseUrl}/mcp`), n, fn);
/** Same, on a connection that authenticates as `key` — the shape a connector with only a URL uses. */
const withAgentClient = <T>(key: string, fn: (c: Client) => Promise<T>): Promise<T> => {
  const url = new URL(`${s!.baseUrl}/mcp`);
  url.searchParams.set("agent", key);
  return withClientsAt(url, 1, ([c]) => fn(c!));
};
const withClient = <T>(fn: (c: Client) => Promise<T>): Promise<T> => withClients(1, ([c]) => fn(c!));
const withTwoClients = <T>(fn: (a: Client, b: Client) => Promise<T>): Promise<T> => withClients(2, ([a, b]) => fn(a!, b!));
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse(text(r));

describe("remote MCP at /mcp", () => {
  it("withClients closes every already-created client even when a later connect() rejects", async () => {
    // Partial setup: the 2nd of 3 clients fails to connect. The 1st already holds an open HTTP
    // session by then — it must still be closed, not leaked because Promise.all rejected before
    // the try/finally ever ran.
    const realConnect = Client.prototype.connect;
    let calls = 0;
    const connectSpy = vi.spyOn(Client.prototype, "connect").mockImplementation(async function (this: Client, transport: unknown) {
      calls++;
      if (calls === 2) throw new Error("boom");
      return realConnect.call(this, transport as Parameters<typeof realConnect>[0]);
    });
    const closeSpy = vi.spyOn(Client.prototype, "close");
    try {
      await expect(withClients(3, async () => { throw new Error("fn should not run"); })).rejects.toThrow("boom");
      // A client whose own connect() succeeded fires its transport's onclose handler, which calls
      // close() again — so assert every *distinct* created client got closed at least once, rather
      // than pinning an exact call count coupled to that internal double-invocation.
      expect(new Set(closeSpy.mock.instances).size).toBe(3);
    } finally {
      connectSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("connects a fresh per-session server for each new session, and every concurrent no-session request waits for its own attempt", async () => {
    // Deterministic version of the concurrency race below: instead of hoping real concurrency wins
    // the race, control each connect attempt directly via the injectable seam. Two plain requests
    // with no mcp-session-id header (not full MCP handshakes, so there's no JSON-RPC id-correlation
    // concern here — this is purely about the per-session connect gate) each get their own session
    // and their own connect attempt, and each must stall until *its* connect resolves.
    let connectCalls = 0;
    const releases: Array<() => void> = [];
    const mcpConnect: MountMcpOptions["connect"] = async (mcpServer, transport) => {
      connectCalls++;
      await new Promise<void>((resolve) => releases.push(resolve));
      await mcpServer.connect(transport);
    };
    const tickets = new TicketStore();
    const { app, stop: stopSweep } = buildApp({ core: s!.core, tickets, mcpConnect });
    try {
      let aDone = false;
      let bDone = false;
      const pa = Promise.resolve(app.request("/mcp", { method: "PUT" })).then((r) => { aDone = true; return r; });
      const pb = Promise.resolve(app.request("/mcp", { method: "PUT" })).then((r) => { bDone = true; return r; });
      await new Promise((r) => setTimeout(r, 50));
      expect(connectCalls).toBe(2);
      expect(aDone).toBe(false);
      expect(bDone).toBe(false);
      releases.forEach((release) => release());
      const [ra, rb] = await Promise.all([pa, pb]);
      expect(aDone).toBe(true);
      expect(bDone).toBe(true);
      expect(connectCalls).toBe(2);
      expect(ra.status).toBe(405);
      expect(rb.status).toBe(405);
    } finally {
      tickets.stop();
      stopSweep();
    }
  });

  it("does not connect again for a request that carries an already-known session id", async () => {
    let connectCalls = 0;
    const mcpConnect: MountMcpOptions["connect"] = async (mcpServer, transport) => {
      connectCalls++;
      await mcpServer.connect(transport);
    };
    const fresh = await startFreshApp(s!.core, { mcpConnect });
    const client = new Client({ name: "once", version: "1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(fresh.mcpUrl));
      expect(connectCalls).toBe(1);
      await client.listTools();
      await client.listTools();
      expect(connectCalls).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await fresh.close();
    }
  });

  it("connects two clients truly concurrently to a fresh server without id collisions", async () => {
    // The old implementation shared one McpServer + one transport across every client, correlating
    // responses by JSON-RPC message id in a single map. Two independent clients whose first requests
    // both use id 0 in the same tick collided (one hung). Real sockets add enough latency variance
    // that two concurrent connect()s rarely land in the exact same tick, so route the SDK's HTTP
    // transport through the Hono app's own `fetch` in-process — no real network I/O to serialize
    // things — which is what actually forces both id-0 requests to race for real. Guard each step
    // with a per-client timeout so a regression fails fast instead of hanging the whole run.
    const tickets = new TicketStore();
    const { app, stop: stopSweep } = buildApp({ core: s!.core, tickets });
    const mcpUrl = new URL("http://mcp.test/mcp");
    const transportFor = () => new StreamableHTTPClientTransport(mcpUrl, { fetch: (url, init) => Promise.resolve(app.request(url, init)) });
    const a = new Client({ name: "racer-a", version: "1.0" });
    const b = new Client({ name: "racer-b", version: "1.0" });
    try {
      await Promise.all([
        withTimeout(a.connect(transportFor()), "client a connect"),
        withTimeout(b.connect(transportFor()), "client b connect"),
      ]);
      const [la, lb] = await Promise.all([
        withTimeout(a.listTools(), "client a listTools"),
        withTimeout(b.listTools(), "client b listTools"),
      ]);
      expect(la.tools.map((t) => t.name)).toContain("join_weave");
      expect(lb.tools.map((t) => t.name)).toContain("join_weave");
    } finally {
      await Promise.all([a.close().catch(() => {}), b.close().catch(() => {})]);
      tickets.stop();
      stopSweep();
    }
  });

  it("isolates sessions: each connected client works independently, and closing one does not affect the other", async () => {
    await withTwoClients(async (a, b) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "Iso", opener: "hi", name: "A" } }));
      const joined = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "B" } }));
      expect(joined.weaveId).toBe(created.weave.id);
      await a.close();
      const events = json(await b.callTool({ name: "read_events", arguments: { credential: joined.token, weaveId: created.weave.id, since: 0 } }));
      expect(Array.isArray(events)).toBe(true);
    });
  });

  it("rejects an unknown mcp-session-id with a 404 not_found", async () => {
    const res = await fetch(`${s!.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("evicts a session after it has been idle longer than the configured ttl", async () => {
    const fresh = await startFreshApp(s!.core, { mcpSessionTtlMs: 50 });
    const clientTransport = new StreamableHTTPClientTransport(fresh.mcpUrl);
    const client = new Client({ name: "idle", version: "1.0" });
    try {
      await client.connect(clientTransport);
      const sessionId = clientTransport.sessionId;
      expect(sessionId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 150));
      const res = await fetch(fresh.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    } finally {
      await client.close().catch(() => {});
      await fresh.close();
    }
  });

  it("serves the tool catalog without connection-level auth", async () => {
    await withClient(async (c) => {
        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name)).toContain("join_weave");
        expect(tools).toHaveLength(34);
    });
  });

  it("serves three clients that connect concurrently to a freshly mounted app", async () => {
    // A *fresh* app: its McpServer has never been connected, so all three handshakes race the
    // one-time server.connect(). The mount must connect exactly once and make every request wait
    // for that same attempt, instead of checking isConnected() and handling a request on a
    // transport whose start() is still in flight.
    const tickets = new TicketStore();
    const { app, stop: stopSweep } = buildApp({ core: s!.core, tickets });
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
      stopSweep();
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
      // Semantic rejections belong to core and must arrive in the same { code, message } envelope.
      // A schema-level min(1)/url() check would fail first, as a plain-text "MCP error -32602".
      const empty = await c.callTool({ name: "post_message", arguments: { credential: created.token, threadId: created.generalThread.id, text: "" } });
      expect(empty.isError).toBe(true);
      expect(json(empty).code).toBe("validation");
      const noName = await c.callTool({ name: "create_thread", arguments: { credential: created.token, weaveId: created.weave.id, name: "" } });
      expect(noName.isError).toBe(true);
      expect(json(noName).code).toBe("validation");
      const badUrl = await c.callTool({ name: "create_thread", arguments: { credential: created.token, weaveId: created.weave.id, name: "T", url: "ftp://no" } });
      expect(badUrl.isError).toBe(true);
      expect(json(badUrl).code).toBe("validation");
      // A malformed Thread filter is a domain error too, not a raw Postgres 22P02 surfaced as
      // `internal` with the SQL text in it.
      const badThread = await c.callTool({ name: "read_events", arguments: { credential: created.token, weaveId: created.weave.id, threadId: "bad-id" } });
      expect(badThread.isError).toBe(true);
      expect(json(badThread).code).toBe("thread_not_found");
    });
  });

  it("rejects an out-of-range page as a { code: validation } tool error on both paged tools", async () => {
    // The tool schemas carry types only, so nothing but core stands between the client and SQL
    // here: without core's own bounds `read_events(limit: 0)` quietly returned a one-event page
    // over MCP while the identical REST call was a 400.
    await withClient(async (c) => {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "A" } }));
      for (const name of ["read_events", "inbox"]) {
        for (const page of [{ limit: 0 }, { since: -1 }]) {
          const r = await c.callTool({ name, arguments: { credential: created.token, weaveId: created.weave.id, ...page } });
          expect([name, page, r.isError]).toEqual([name, page, true]);
          expect(json(r)).toMatchObject({ code: "validation" });
        }
      }
    });
  });

  it("pins the inbox cursor contract: only inbox results may advance it", async () => {
    // The documented rule used to be "since = the last seq you saw", which a turn reads as the seq
    // of its own reply. This interleaving is why that skips work: an event addressed to the agent
    // is committed between its inbox call and its reply, so the reply's seq is already past it.
    await withTwoClients(async (bot, paw) => {
      const created = json(await bot.callTool({ name: "create_weave", arguments: { title: "Cursor", opener: "start", name: "Bot" } }));
      const joined = json(await paw.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Paw", kind: "human" } }));
      const thread = created.generalThread.id;

      await paw.callTool({ name: "post_message", arguments: { credential: joined.token, threadId: thread, text: "first @Bot" } });
      const page = json(await bot.callTool({ name: "inbox", arguments: { credential: created.token, weaveId: created.weave.id } }));
      expect(page).toHaveLength(1);
      const cursor = page[0].seq as number;   // the inbox cursor: the last inbox item processed

      const missed = json(await paw.callTool({ name: "post_message", arguments: { credential: joined.token, threadId: thread, text: "second @Bot" } }));
      const reply = json(await bot.callTool({ name: "post_message", arguments: { credential: created.token, threadId: thread, text: "on it" } }));
      expect(reply.seq).toBeGreaterThan(missed.seq);

      // Advancing from the reply (or from any read_events page) loses "second @Bot" permanently.
      expect(json(await bot.callTool({ name: "inbox", arguments: { credential: created.token, weaveId: created.weave.id, since: reply.seq } }))).toEqual([]);
      // The dedicated inbox cursor still returns it.
      const next = json(await bot.callTool({ name: "inbox", arguments: { credential: created.token, weaveId: created.weave.id, since: cursor } }));
      expect(next.map((e: { seq: number }) => e.seq)).toEqual([missed.seq]);
    });
  });

  it("keeper tools work with a keeper token", async () => {
    await withClient(async (c) => {
      const list = json(await c.callTool({ name: "keeper_list_weaves", arguments: { credential: keeperToken("k1") } }));
      expect(Array.isArray(list)).toBe(true);
      const st = json(await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), patch: { instanceName: "Fragt Loom" } } }));
      expect(st.instanceName).toBe("Fragt Loom");
      const denied = await c.callTool({ name: "keeper_list", arguments: { credential: "x".repeat(43) } });
      expect(json(denied).code).toBe("invalid_token");
      // A misspelled key reaches core, which rejects the whole patch rather than reporting success.
      const typo = await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), patch: { openWeaveCreaton: false } } });
      expect(typo.isError).toBe(true);
      expect(json(typo).code).toBe("validation");
      const still = json(await c.callTool({ name: "keeper_get_settings", arguments: { credential: keeperToken("k1") } }));
      expect(still.instanceName).toBe("Fragt Loom");
    });
  });
});

describe("remote MCP with an agent key", () => {
  async function agentClient(key: string, via: "query" | "bearer") {
    const c = new Client({ name: "chatgpt-like", version: "1.0" });
    const url = new URL(`${s!.baseUrl}/mcp`);
    if (via === "query") url.searchParams.set("agent", key);
    const transport = via === "bearer"
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } })
      : new StreamableHTTPClientTransport(url);
    await c.connect(transport);
    return c;
  }
  it("?agent= makes credential optional and defaults to the agent; create → read/write with the key alone; explicit credential still wins", async () => {
    const { key } = await s!.core.addAgent(await s!.core.resolveCredential(keeperToken("k1")), "ChatGPT");
    const c = await agentClient(key, "query");
    try {
      const schema = (await c.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required ?? []).not.toContain("credential");
      expect(c.getInstructions()).toMatch(/connected as agent ChatGPT/);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "Mine", opener: "start", name: "ChatGPT" } }));
      expect(created.participant.agentId).toBeDefined();
      const posted = json(await c.callTool({ name: "post_message", arguments: { threadId: created.generalThread.id, text: "key only" } }));
      expect(posted.type).toBe("message");
      const inbox = json(await c.callTool({ name: "inbox", arguments: { weaveId: created.weave.id } }));
      expect(inbox).toEqual([]);
      const other = await s!.core.createWeave({ title: "O", opener: "", creator: { name: "Q", kind: "human" } });
      const explicit = json(await c.callTool({ name: "get_weave", arguments: { weaveId: other.weave.id, credential: other.token } }));
      expect(explicit.weave.id).toBe(other.weave.id);
      const denied = await c.callTool({ name: "get_weave", arguments: { weaveId: other.weave.id } });
      expect(denied.isError).toBe(true); expect(json(denied).code).toBe("forbidden");
    } finally { await c.close(); }
  });
  it("join_weave without a name takes the connection's agent name", async () => {
    const { key } = await s!.core.addAgent(await s!.core.resolveCredential(keeperToken("k1")), "Nameless");
    const other = await s!.core.createWeave({ title: "Host", opener: "", creator: { name: "Host", kind: "human" } });
    const c = await agentClient(key, "query");
    try {
      const joined = json(await c.callTool({ name: "join_weave", arguments: { secret: other.secret } }));
      expect(joined.participant.name).toBe("Nameless");
      expect(joined.participant.agentId).toBeTruthy();
    } finally { await c.close(); }
  });
  it("Bearer agent key works too; a revoked key fails every tool with invalid_token", async () => {
    const keeper = await s!.core.resolveCredential(keeperToken("k1"));
    const { agent, key } = await s!.core.addAgent(keeper, "Bot");
    const c = await agentClient(key, "bearer");
    try {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "B", opener: "", name: "Bot" } }));
      await s!.core.revokeAgent(keeper, agent.id);
      const r = await c.callTool({ name: "get_weave", arguments: { weaveId: created.weave.id } });
      expect(r.isError).toBe(true); expect(json(r).code).toBe("invalid_token");
    } finally { await c.close(); }
  });
  it("join_weave on a revoked connection fails with invalid_token instead of joining anonymously", async () => {
    const keeper = await s!.core.resolveCredential(keeperToken("k1"));
    const { agent, key } = await s!.core.addAgent(keeper, "Stale");
    const c = await agentClient(key, "bearer");
    try {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "J", opener: "", name: "Stale" } }));
      await s!.core.revokeAgent(keeper, agent.id);
      // Revocation means the key authenticates nothing: join is not a back door around it.
      const joined = await c.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "Guest" } });
      expect(joined.isError).toBe(true);
      expect(json(joined).code).toBe("invalid_token");
    } finally { await c.close(); }
  });
  it("without an agent, credential stays required and there is no agent line in the instructions", async () => {
    await withClient(async (c) => {
      const schema = (await c.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required).toContain("credential");
      expect(c.getInstructions()).not.toMatch(/connected as agent/);
    });
  });
});

describe("guidelines over remote MCP", () => {
  /** A patch made here would otherwise leak into every later session in this file, so put it back. */
  async function restoreInstanceGuidelines(): Promise<void> {
    const keeper = await s!.core.resolveCredential(keeperToken("k1"));
    await s!.core.updateSettings(keeper, { guidelines: DEFAULT_INSTANCE_GUIDELINES });
  }

  it("a fresh session's instructions carry the mechanics sentence and the instance guidelines", async () => {
    // The sentence belongs to the mechanics text, so pin it there; the session then only has to
    // carry that text plus the instance layer under core's heading.
    expect(MCP_INSTRUCTIONS).toContain("Guidelines are rules from the people running this Loom");
    await withClient(async (c) => {
      const instructions = c.getInstructions() ?? "";
      expect(instructions).toContain(MCP_INSTRUCTIONS);
      expect(instructions).toContain(`${INSTANCE_HEADING}\n${DEFAULT_INSTANCE_GUIDELINES}`);
    });
  });

  it("a keeper patch reaches the next session's instructions; the session that made it keeps the text it was built with", async () => {
    // instructions are fixed at initialize, so the instance text is read per new session.
    try {
      await withClient(async (c) => {
        const patched = json(await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), patch: { guidelines: "be brief" } } }));
        expect(patched.guidelines).toBe("be brief");
        expect(c.getInstructions() ?? "").toContain(DEFAULT_INSTANCE_GUIDELINES);
      });
      await withClient(async (c) => {
        const instructions = c.getInstructions() ?? "";
        expect(instructions).toContain(`${INSTANCE_HEADING}\nbe brief`);
        expect(instructions).not.toContain(DEFAULT_INSTANCE_GUIDELINES);
      });
    } finally {
      await restoreInstanceGuidelines();
    }
  });

  it("cleared instance guidelines leave the instructions as the mechanics text alone", async () => {
    // A keeper may clear the shipped default; the heading must then not appear at all, rather than
    // introducing an empty section.
    try {
      await withClient(async (c) => {
        expect(json(await c.callTool({ name: "keeper_set_settings", arguments: { credential: keeperToken("k1"), patch: { guidelines: "" } } })).guidelines).toBe("");
      });
      await withClient(async (c) => {
        expect(c.getInstructions()).toBe(MCP_INSTRUCTIONS);
        expect(c.getInstructions() ?? "").not.toContain(INSTANCE_HEADING);
      });
    } finally {
      await restoreInstanceGuidelines();
    }
  });

  it("join_weave, create_weave and get_weave results carry both guideline layers", async () => {
    await withTwoClients(async (a, b) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "G", opener: "o", name: "A", guidelines: "rules" } }));
      expect(created.guidelines).toContain(`## Loom guidelines\n${DEFAULT_INSTANCE_GUIDELINES}`);
      expect(created.guidelines).toContain("## Guidelines for this Weave\nrules");
      const joined = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "B" } }));
      expect(joined.guidelines).toBe(created.guidelines);
      const info = json(await b.callTool({ name: "get_weave", arguments: { credential: joined.token, weaveId: created.weave.id } }));
      expect(info.guidelines).toBe(created.guidelines);
    });
  });

  it("set_weave_guidelines: the creator sets them, a member is forbidden, over-long is a validation error", async () => {
    await withTwoClients(async (a, b) => {
      const created = json(await a.callTool({ name: "create_weave", arguments: { title: "SG", opener: "o", name: "A" } }));
      // Creation appends three events (thread.created, participant.joined, message), so this is seq 4.
      const set = json(await a.callTool({ name: "set_weave_guidelines", arguments: { credential: created.token, weaveId: created.weave.id, guidelines: "house rules" } }));
      expect(set.seq).toBe(4);
      expect(set.weave.guidelines).toBe("house rules");
      const joined = json(await b.callTool({ name: "join_weave", arguments: { secret: created.secret, name: "B" } }));
      expect(joined.guidelines).toContain("## Guidelines for this Weave\nhouse rules");
      const denied = await b.callTool({ name: "set_weave_guidelines", arguments: { credential: joined.token, weaveId: created.weave.id, guidelines: "mine" } });
      expect(denied.isError).toBe(true);
      expect(json(denied)).toMatchObject({ code: "forbidden" });
      const tooLong = await a.callTool({ name: "set_weave_guidelines", arguments: { credential: created.token, weaveId: created.weave.id, guidelines: "x".repeat(4001) } });
      expect(tooLong.isError).toBe(true);
      expect(json(tooLong)).toMatchObject({ code: "validation" });
    });
  });

  it("loom://guidelines reads without a credential; the Weave resource on an anonymous session is refused", async () => {
    await withClient(async (c) => {
      const res = await c.readResource({ uri: "loom://guidelines" });
      expect((res.contents[0] as { text: string }).text).toBe(DEFAULT_INSTANCE_GUIDELINES);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "R", opener: "o", name: "A" } }));
      // Remote /mcp passes no resourceCredential: the connection's own agent key is the only one a
      // resource read can use, and an anonymous session has none.
      await expect(c.readResource({ uri: `loom://weaves/${created.weave.id}/guidelines` })).rejects.toThrow(/invalid_token/);
    });
  });

  it("an agent-key session reads a joined Weave's guidelines and is refused a Weave it has not joined", async () => {
    const { key } = await withClient(async (c) =>
      json(await c.callTool({ name: "keeper_agents_add", arguments: { credential: keeperToken("k1"), name: "ResourceReader" } })));
    const host = await withClient(async (c) => ({
      joined: json(await c.callTool({ name: "create_weave", arguments: { title: "Joined", opener: "o", name: "Host", guidelines: "weave rules" } })),
      other: json(await c.callTool({ name: "create_weave", arguments: { title: "Other", opener: "o", name: "Host" } })),
    }));
    await withAgentClient(key, async (c) => {
      await c.callTool({ name: "join_weave", arguments: { secret: host.joined.secret } });
      const res = await c.readResource({ uri: `loom://weaves/${host.joined.weave.id}/guidelines` });
      const body = (res.contents[0] as { text: string }).text;
      expect(body).toContain(`## Loom guidelines\n${DEFAULT_INSTANCE_GUIDELINES}`);
      expect(body).toContain("## Guidelines for this Weave\nweave rules");
      // An agent key grants nothing in a Weave it has not joined (core's resolveInWeave).
      await expect(c.readResource({ uri: `loom://weaves/${host.other.weave.id}/guidelines` })).rejects.toThrow(/forbidden/);
    });
  });
});

describe("the Lobby over remote MCP", () => {
  /** Lobby names and owners are shared by every test in the file, so each fixture takes a fresh one. */
  let n = 0;
  const uniq = (prefix: string) => `${prefix}-${++n}`;
  const MODEL = { model: "gpt-5.6-sol", effort: "high" };

  type InboxItem = { seq: number; type: string; payload: Record<string, unknown> };
  /** The one inbox item of that type: an addressed Lobby event reaches its listener exactly once. */
  const addressed = (items: InboxItem[], type: string): Record<string, unknown> => {
    const found = items.filter((e) => e.type === type);
    expect(found.map((e) => e.type)).toEqual([type]);
    return found[0]!.payload;
  };

  async function agentSession(name: string): Promise<Client> {
    const { key } = await s!.core.addAgent(await s!.core.resolveCredential(keeperToken("k1")), name);
    const c = new Client({ name: "listener", version: "1.0" });
    const url = new URL(`${s!.baseUrl}/mcp`);
    url.searchParams.set("agent", key);
    await c.connect(new StreamableHTTPClientTransport(url));
    return c;
  }

  /** Joins the Lobby as the connection's own agent and registers `profile`. */
  async function standInLobby(c: Client, profile: unknown): Promise<{ lobbyId: string; participantId: string }> {
    const joined = json(await c.callTool({ name: "join_lobby", arguments: {} }));
    const set = await c.callTool({ name: "set_capabilities", arguments: { profile } });
    expect(set.isError).toBeFalsy();
    return { lobbyId: joined.weaveId, participantId: joined.participant.id };
  }

  it("two agent sessions run the whole flow: open with no target credential, offer, accept, redeem", async () => {
    const owner = uniq("paw");
    const requester = await agentSession(uniq("PawClaude"));
    const helper = await agentSession(uniq("PawGpt"));
    try {
      // The requester's key is one actor everywhere: it creates the target Weave (so it is a keeper
      // there) and stands in the Lobby, which is exactly what lets open_request leave out a
      // targetCredential.
      const target = json(await requester.callTool({ name: "create_weave", arguments: { title: "Loom session", opener: "PR 14", name: uniq("Paw") } }));
      const me = await standInLobby(requester, { owner });
      const them = await standInLobby(helper, { models: [MODEL], owner, serves: "owner" });

      const request = json(await requester.callTool({
        name: "open_request",
        arguments: {
          title: "Review PR 14", requirements: { models: [MODEL] }, wanted: 1,
          targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id,
          url: "https://example.com/pr/14",
        },
      }));
      expect(request.eligible).toEqual([them.participantId]);

      const opened = addressed(json(await helper.callTool({ name: "inbox", arguments: { weaveId: them.lobbyId } })), "request.opened");
      expect(opened.requestId).toBe(request.id);
      expect(opened.targetWeaveTitle).toBe("Loom session");

      const offered = json(await helper.callTool({ name: "offer", arguments: { requestId: request.id, model: MODEL.model, effort: MODEL.effort, note: "can start now" } }));
      expect(offered).toMatchObject({ participantId: them.participantId, note: "can start now" });

      const toRequester = addressed(json(await requester.callTool({ name: "inbox", arguments: { weaveId: me.lobbyId } })), "request.offered");
      expect(toRequester.participantId).toBe(them.participantId);

      const accepted = json(await requester.callTool({ name: "accept", arguments: { requestId: request.id, participantIds: [them.participantId] } }));
      expect(accepted.invitationIds).toHaveLength(1);
      expect(accepted.request.status).toBe("filled");

      const invited = addressed(json(await helper.callTool({ name: "inbox", arguments: { weaveId: them.lobbyId } })), "weave.invited");
      expect(invited.invitationId).toBe(accepted.invitationIds[0]);
      expect(JSON.stringify(invited)).not.toContain(target.secret);

      const redeemed = json(await helper.callTool({ name: "join_weave", arguments: { inviteId: invited.invitationId } }));
      expect(redeemed.weaveId).toBe(target.weave.id);
      // The redemption lands with a Thread invite already waiting, so the newcomer knows where to work.
      const inTarget = json(await helper.callTool({ name: "inbox", arguments: { weaveId: target.weave.id } }));
      expect(addressed(inTarget, "thread.invited").threadId).toBe(target.generalThread.id);
    } finally {
      await Promise.all([requester.close().catch(() => {}), helper.close().catch(() => {})]);
    }
  });

  it("open_request from a session that holds only a Lobby token is invalid_token", async () => {
    const target = await s!.core.createWeave({ title: "Someone else's", opener: "", creator: { name: uniq("Host"), kind: "human" } });
    await withClient(async (c) => {
      // An anonymous session may join the Lobby (no secret needed), but its Lobby token proves
      // nothing in the target Weave, and it gave no targetCredential.
      const joined = json(await c.callTool({ name: "join_lobby", arguments: { name: uniq("Anon"), kind: "agent" } }));
      const r = await c.callTool({
        name: "open_request",
        arguments: {
          credential: joined.token, title: "No authority", requirements: { models: [MODEL] },
          targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id,
        },
      });
      expect(r.isError).toBe(true);
      expect(json(r).code).toBe("invalid_token");
    });
  });

  it("loom://lobby/requests lists the open requests for an agent session and is refused without a credential", async () => {
    const c = await agentSession(uniq("Reader"));
    try {
      const target = json(await c.callTool({ name: "create_weave", arguments: { title: "Reader target", opener: "x", name: uniq("Reader") } }));
      await standInLobby(c, { owner: uniq("owner") });
      const request = json(await c.callTool({
        name: "open_request",
        arguments: { title: "Readable", requirements: { models: [MODEL] }, targetWeaveId: target.weave.id, targetThreadId: target.generalThread.id },
      }));
      const res = await c.readResource({ uri: "loom://lobby/requests" });
      const entry = res.contents[0] as { mimeType?: string; text: string };
      expect(entry.mimeType).toBe("application/json");
      const rows = JSON.parse(entry.text) as { id: string; status: string }[];
      expect(rows.find((r) => r.id === request.id)).toMatchObject({ status: "open" });
    } finally { await c.close(); }
    // Remote /mcp resolves no credential for an anonymous session, so the read is refused.
    await withClient(async (anon) => {
      await expect(anon.readResource({ uri: "loom://lobby/requests" })).rejects.toThrow(/invalid_token/);
    });
  });

  it("a session's instructions carry the Lobby mechanics paragraph", async () => {
    expect(MCP_INSTRUCTIONS).toContain(LOBBY_MECHANICS);
    await withClient(async (c) => expect(c.getInstructions() ?? "").toContain(LOBBY_MECHANICS));
  });
});
