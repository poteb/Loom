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
  createThread: async (_c, weaveId, name) => ({ weaveId, name }),
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
