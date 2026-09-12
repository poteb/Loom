import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLoomTools, LOOM_TOOL_NAMES, LoomToolError, type LoomToolBackend } from "../src/index.js";

const calls: unknown[][] = [];
const fake: LoomToolBackend = {
  createWeave: async (input, credential) => { calls.push(["createWeave", input, credential]); return { weave: { id: "w1" }, secret: "s".repeat(43), token: "t".repeat(43) }; },
  joinWeave: async (secret, who) => { calls.push(["joinWeave", secret, who]); if (secret === "bad") throw new LoomToolError("weave_not_found", "Weave not found"); return { weaveId: "w1", token: "j".repeat(43) }; },
  lookupWeave: async () => ({ weaveId: "w1" }),
  getWeave: async (credential, weaveId) => ({ weave: { id: weaveId }, credential }),
  readEvents: async (_c, _w, opts) => [{ seq: (opts.since ?? 0) + 1 }],
  postMessage: async (_c, threadId, text) => ({ threadId, payload: { text } }),
  createThread: async (_c, weaveId, name, url) => ({ weaveId, name, url: url ?? null }),
  setThreadUrl: async (_c, threadId, url) => ({ id: threadId, url }),
  inviteParticipant: async (_c, threadId, participantId) => ({ seq: 9, created: true, threadId, participantId }),
  inbox: async (c, weaveId, opts) => [{ type: "thread.invited", weaveId, since: opts.since, credential: c }],
  closeThread: async () => {},
  archiveWeave: async () => {},
  setRole: async (_c, _w, participantId, role) => ({ participantId, role }),
  exportWeave: async (_c, _w, format) => (format === "md" ? "# md" : "{}"),
  keeperListWeaves: async () => [{ id: "w1" }],
  keeperGetSettings: async () => ({ instanceName: "Loom" }),
  keeperSetSettings: async (_c, patch) => patch,
  keeperList: async () => [],
  keeperAdd: async (_c, name) => ({ keeper: { name }, token: "k".repeat(43) }),
  keeperRemove: async () => { throw { code: "validation", message: "No such keeper" }; },
  keeperAgentsList: async () => [{ id: "a1", name: "ChatGPT" }],
  keeperAgentsAdd: async (_c, name) => ({ agent: { name }, key: "a".repeat(43) }),
  keeperAgentsRevoke: async () => {},
};

let client: Client;
beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerLoomTools(server, fake);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
});
afterAll(async () => { await client.close(); });

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0]!.text;

describe("registerLoomTools", () => {
  it("lists all tools with descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...LOOM_TOOL_NAMES].sort());
    for (const t of tools) expect((t.description ?? "").length).toBeGreaterThan(20);
    expect(tools.find((t) => t.name === "join_weave")!.description).toMatch(/token/i);
  });
  it("create_weave and join_weave return JSON results", async () => {
    const r = await client.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude", kind: "agent" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).secret).toHaveLength(43);
    const j = await client.callTool({ name: "join_weave", arguments: { secret: "s".repeat(43), name: "ChatGPT" } });
    expect(JSON.parse(text(j)).token).toHaveLength(43);
    expect(calls.find((c) => c[0] === "joinWeave")![2]).toEqual({ name: "ChatGPT", kind: "agent" });
  });
  it("passes credential and arguments through", async () => {
    const r = await client.callTool({ name: "read_events", arguments: { credential: "c", weaveId: "w1", since: 4 } });
    expect(JSON.parse(text(r))).toEqual([{ seq: 5 }]);
    const p = await client.callTool({ name: "post_message", arguments: { credential: "c", threadId: "t1", text: "hi" } });
    expect(JSON.parse(text(p)).payload.text).toBe("hi");
    const e = await client.callTool({ name: "export_weave", arguments: { credential: "c", weaveId: "w1", format: "md" } });
    expect(text(e)).toBe("# md");
  });
  it("maps backend errors to isError results with { code, message }", async () => {
    const r = await client.callTool({ name: "join_weave", arguments: { secret: "bad", name: "X" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ code: "weave_not_found", message: "Weave not found" });
    const k = await client.callTool({ name: "keeper_remove", arguments: { credential: "k", id: "nope" } });
    expect(JSON.parse(text(k)).code).toBe("validation");
  });
  it("rejects invalid arguments before calling the backend", async () => {
    const before = calls.length;
    const r = await client.callTool({ name: "set_role", arguments: { credential: "c", weaveId: "w", participantId: "p", role: "boss" } });
    expect(r.isError).toBe(true);
    expect(calls.length).toBe(before);
  });
});

describe("v2 tools", () => {
  it("advertises the new tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["set_thread_url", "invite_participant", "inbox", "keeper_agents_list", "keeper_agents_add", "keeper_agents_revoke"]) expect(names).toContain(n);
    expect([...LOOM_TOOL_NAMES]).toEqual(expect.arrayContaining(names));
  });
  it("create_thread passes url through; set_thread_url accepts null; invite and inbox route their arguments", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "create_thread", arguments: { credential: "c", weaveId: "w1", name: "PR", url: "https://e.com" } })))).toEqual({ weaveId: "w1", name: "PR", url: "https://e.com" });
    expect(JSON.parse(text(await client.callTool({ name: "set_thread_url", arguments: { credential: "c", threadId: "t1", url: null } })))).toEqual({ id: "t1", url: null });
    expect(JSON.parse(text(await client.callTool({ name: "invite_participant", arguments: { credential: "c", threadId: "t1", participantId: "p2" } })))).toMatchObject({ seq: 9, created: true });
    expect(JSON.parse(text(await client.callTool({ name: "inbox", arguments: { credential: "c", weaveId: "w1", since: 4 } })))).toEqual([{ type: "thread.invited", weaveId: "w1", since: 4, credential: "c" }]);
  });
  it("with a connection default, credential is optional and the default is used; an explicit one still wins", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerLoomTools(server, fake, { defaultCredential: () => "agent-key", agentName: "ChatGPT" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c2 = new Client({ name: "t2", version: "0" });
    await c2.connect(b);
    try {
      const r = JSON.parse(text(await c2.callTool({ name: "inbox", arguments: { weaveId: "w1" } })));
      expect(r[0].credential).toBe("agent-key");
      const r2 = JSON.parse(text(await c2.callTool({ name: "inbox", arguments: { weaveId: "w1", credential: "explicit" } })));
      expect(r2[0].credential).toBe("explicit");
      const schema = (await c2.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required ?? []).not.toContain("credential");
    } finally { await c2.close(); }
  });
  it("join_weave's name is optional: an agent connection falls back to its registered name", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "join_weave")!.inputSchema as { required?: string[] };
    expect(schema.required ?? []).not.toContain("name");
    expect(schema.required ?? []).toContain("secret");
  });

  it("without a connection default, credential stays required", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
    expect(schema.required).toContain("credential");
  });
});
