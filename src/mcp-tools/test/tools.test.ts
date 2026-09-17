import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLoomTools, LOOM_TOOL_NAMES, LOOM_RESOURCE_URIS, READ_GUIDELINES, LOBBY_MECHANICS, LoomToolError, type LoomToolBackend, type RegisterOptions } from "../src/index.js";

const calls: unknown[][] = [];
/** Set by the one case that needs the credential-free instance read to fail; cleared straight after. */
let instanceGuidelinesError: LoomToolError | undefined;
const fake: LoomToolBackend = {
  createWeave: async (input, credential) => { calls.push(["createWeave", input, credential]); return { weave: { id: "w1" }, secret: "s".repeat(43), token: "t".repeat(43) }; },
  joinWeave: async (secret, who, _credential, opts) => { calls.push(["joinWeave", secret, who, opts]); if (secret === "bad") throw new LoomToolError("weave_not_found", "Weave not found"); return { weaveId: opts?.inviteId ? "target" : "w1", token: "j".repeat(43) }; },
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
  setWeaveGuidelines: async (c, w, g) => { calls.push(["setWeaveGuidelines", c, w, g]); return { weave: { id: w, guidelines: g }, seq: 7 }; },
  getInstanceGuidelines: async () => { if (instanceGuidelinesError) throw instanceGuidelinesError; return "## Loom guidelines\nBe kind."; },
  getLobby: async () => { calls.push(["getLobby"]); return { weaveId: "lobby-1", title: "Lobby" }; },
  joinLobby: async (who, credential) => { calls.push(["joinLobby", who, credential]); return { weaveId: "lobby-1", participant: { id: "p-me" }, token: "l".repeat(43) }; },
  setCapabilities: async (c, profile) => { calls.push(["setCapabilities", c, profile]); return { id: "p-me", capabilities: profile }; },
  findAgents: async (c, filter) => { calls.push(["findAgents", c, filter]); return [{ participant: { id: "p-1" }, capabilities: { owner: "paw" } }]; },
  openRequest: async (c, input) => { calls.push(["openRequest", c, input]); return { id: "r1", eligible: ["p-1"] }; },
  listRequests: async (c, opts) => { calls.push(["listRequests", c, opts]); return [{ id: "r1", status: opts.status ?? "any", credential: c }]; },
  getRequest: async (c, requestId) => { calls.push(["getRequest", c, requestId]); return { id: requestId, offers: [] }; },
  offer: async (c, requestId, input) => {
    calls.push(["offer", c, requestId, input]);
    if (requestId === "closed") throw new LoomToolError("request_closed", "This request is closed");
    return { requestId, ...input };
  },
  acceptRequest: async (c, requestId, participantIds) => { calls.push(["acceptRequest", c, requestId, participantIds]); return { request: { id: requestId }, invitationIds: ["i1"] }; },
  cancelRequest: async (c, requestId) => { calls.push(["cancelRequest", c, requestId]); return { id: requestId, status: "cancelled" }; },
  inviteToWeave: async (c, participantId, targetWeaveId, targetThreadId) => {
    calls.push(["inviteToWeave", c, participantId, targetWeaveId, targetThreadId]);
    return { invitationId: "i1", seq: 3 };
  },
  getGuidelines: async (c, w) => {
    calls.push(["getGuidelines", c, w]);
    if (w === "nope") throw new LoomToolError("forbidden", "not joined; call join_weave");
    return `combined:${w}:${c}`;
  },
};

/** A fresh server+client pair over an in-memory transport, so per-connection options can be varied. */
const connect = async (opts?: RegisterOptions): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerLoomTools(server, fake, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
};

let client: Client;
beforeAll(async () => {
  client = await connect();
});
afterAll(async () => { await client.close(); });

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0]!.text;
/** A resource content entry is text-or-blob in the SDK types; every Loom resource is text/markdown. */
const first = (r: Awaited<ReturnType<Client["readResource"]>>) => r.contents[0] as { uri: string; mimeType?: string; text: string };

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
  it("keeper_set_settings hands the whole patch to the backend, unknown keys included", async () => {
    // The SDK strips properties a raw shape does not declare, so a misspelled settings key used to
    // vanish before core's strict schema could reject it. A single `patch` record keeps it.
    const r = await client.callTool({ name: "keeper_set_settings", arguments: { credential: "k", patch: { instanceName: "X", openWeaveCreaton: false } } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ instanceName: "X", openWeaveCreaton: false });
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
    // `secret` is optional too now — the inviteId path needs none — so only `name` is pinned here.
    const schema = (await client.listTools()).tools.find((t) => t.name === "join_weave")!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required ?? []).not.toContain("name");
    expect(Object.keys(schema.properties)).toContain("secret");
  });

  it("without a connection default, credential stays required", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
    expect(schema.required).toContain("credential");
  });
});

describe("guidelines", () => {
  it("advertises set_weave_guidelines and forwards credential, weaveId and text", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("set_weave_guidelines");
    expect([...LOOM_TOOL_NAMES]).toContain("set_weave_guidelines");
    const r = await client.callTool({ name: "set_weave_guidelines", arguments: { credential: "c", weaveId: "w1", guidelines: "Be brief." } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ weave: { id: "w1", guidelines: "Be brief." }, seq: 7 });
    expect(calls.filter((c) => c[0] === "setWeaveGuidelines").at(-1)).toEqual(["setWeaveGuidelines", "c", "w1", "Be brief."]);
  });

  it("create_weave passes optional guidelines through; join/create/get descriptions point at them", async () => {
    await client.callTool({ name: "create_weave", arguments: { title: "T", opener: "o", name: "Claude", kind: "agent", guidelines: "House rules" } });
    expect(calls.filter((c) => c[0] === "createWeave").at(-1)![1]).toEqual({ title: "T", opener: "o", creator: { name: "Claude", kind: "agent" }, guidelines: "House rules" });
    const tools = (await client.listTools()).tools;
    for (const n of ["create_weave", "join_weave", "get_weave"]) expect(tools.find((t) => t.name === n)!.description).toContain(READ_GUIDELINES);
    expect(tools.find((t) => t.name === "keeper_set_settings")!.description).toMatch(/guidelines/);
  });

  it("lists the instance resource and the Weave template", async () => {
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain("loom://guidelines");
    expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toContain("loom://weaves/{weaveId}/guidelines");
    expect([...LOOM_RESOURCE_URIS]).toEqual(["loom://guidelines", "loom://weaves/{weaveId}/guidelines", "loom://lobby/requests"]);
  });

  it("reads the instance guidelines without any credential", async () => {
    const r = first(await client.readResource({ uri: "loom://guidelines" }));
    expect(r.mimeType).toBe("text/markdown");
    expect(r.text).toBe("## Loom guidelines\nBe kind.");
  });

  it("reads a Weave's guidelines with the credential the surface resolves", async () => {
    const c = await connect({ resourceCredential: () => "tok" });
    try {
      const r = first(await c.readResource({ uri: "loom://weaves/w1/guidelines" }));
      expect(r.mimeType).toBe("text/markdown");
      expect(r.text).toBe("combined:w1:tok");
      expect(calls.filter((x) => x[0] === "getGuidelines").at(-1)).toEqual(["getGuidelines", "tok", "w1"]);
    } finally { await c.close(); }
  });

  it("refuses the Weave read with invalid_token when the surface resolves no credential", async () => {
    const c = await connect({ resourceCredential: () => undefined });
    try {
      await expect(c.readResource({ uri: "loom://weaves/w1/guidelines" })).rejects.toThrow(/invalid_token/);
    } finally { await c.close(); }
  });

  it("falls back to the connection default when no resourceCredential is given", async () => {
    const c = await connect({ defaultCredential: () => "agent-key" });
    try {
      expect(first(await c.readResource({ uri: "loom://weaves/w2/guidelines" })).text).toBe("combined:w2:agent-key");
    } finally { await c.close(); }
  });

  it("carries the backend's error code on the credential-free instance read too", async () => {
    instanceGuidelinesError = new LoomToolError("internal", "boom");
    try {
      await expect(client.readResource({ uri: "loom://guidelines" })).rejects.toThrow(/internal: boom/);
    } finally { instanceGuidelinesError = undefined; }
  });

  it("carries the backend's error code in the resource error message", async () => {
    const c = await connect({ resourceCredential: () => "tok" });
    try {
      await expect(c.readResource({ uri: "loom://weaves/nope/guidelines" })).rejects.toThrow(/forbidden/);
    } finally { await c.close(); }
  });

  it("lets the resolver itself refuse with its own code by throwing", async () => {
    // The channel does exactly this for a Weave it has not joined. It works only because the
    // resolver runs inside the resource callback's try, where resourceError folds the code into
    // the message — pinning it here so a refactor cannot hoist the call out of the try.
    const c = await connect({ resourceCredential: () => { throw new LoomToolError("forbidden", "not joined"); } });
    try {
      await expect(c.readResource({ uri: "loom://weaves/w1/guidelines" })).rejects.toThrow(/forbidden: not joined/);
    } finally { await c.close(); }
  });
});

describe("lobby tools", () => {
  const LOBBY_TOOLS = [
    "join_lobby", "set_capabilities", "find_agents", "open_request", "offer", "accept",
    "cancel_request", "list_requests", "get_request", "invite_to_weave",
  ];

  it("advertises the ten Lobby tools and nothing else new", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of LOBBY_TOOLS) expect(names).toContain(n);
    expect(LOOM_TOOL_NAMES).toHaveLength(34);
    expect(names.sort()).toEqual([...LOOM_TOOL_NAMES].sort());
  });

  it("join_lobby forwards the name and kind, and the connection's own credential", async () => {
    const c = await connect({ defaultCredential: () => "agent-key" });
    try {
      expect(JSON.parse(text(await c.callTool({ name: "join_lobby", arguments: { name: "Pawbot" } })))).toMatchObject({ weaveId: "lobby-1" });
      expect(calls.filter((x) => x[0] === "joinLobby").at(-1)).toEqual(["joinLobby", { name: "Pawbot", kind: "agent" }, "agent-key"]);
    } finally { await c.close(); }
  });

  it("set_capabilities hands the whole profile over, unknown keys included, and null clears it", async () => {
    const profile = { models: [{ model: "gpt-5.6-sol", effort: "high" }], owner: "paw", serves: "owner", houseStyle: "terse" };
    const r = await client.callTool({ name: "set_capabilities", arguments: { credential: "c", profile } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).capabilities).toEqual(profile);
    await client.callTool({ name: "set_capabilities", arguments: { credential: "c", profile: null } });
    expect(calls.filter((x) => x[0] === "setCapabilities").at(-1)).toEqual(["setCapabilities", "c", null]);
  });

  it("find_agents forwards the filter as given, and defaults it to an empty one", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "find_agents", arguments: { credential: "c", filter: { models: [{ model: "m" }], owner: "paw" } } })))).toEqual([{ participant: { id: "p-1" }, capabilities: { owner: "paw" } }]);
    expect(calls.filter((x) => x[0] === "findAgents").at(-1)).toEqual(["findAgents", "c", { models: [{ model: "m" }], owner: "paw" }]);
    await client.callTool({ name: "find_agents", arguments: { credential: "c" } });
    expect(calls.filter((x) => x[0] === "findAgents").at(-1)).toEqual(["findAgents", "c", {}]);
  });

  it("open_request forwards every argument, targetCredential included", async () => {
    const args = {
      credential: "c", title: "Review PR 14", requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }], tools: ["github"] },
      wanted: 2, timeoutMs: 3_600_000, targetWeaveId: "w1", targetThreadId: "t1",
      url: "https://example.com/pr/14", targetCredential: "target-tok",
    };
    expect(JSON.parse(text(await client.callTool({ name: "open_request", arguments: args })))).toEqual({ id: "r1", eligible: ["p-1"] });
    expect(calls.filter((x) => x[0] === "openRequest").at(-1)).toEqual(["openRequest", "c", {
      title: args.title, requirements: args.requirements, wanted: 2, timeoutMs: 3_600_000,
      targetWeaveId: "w1", targetThreadId: "t1", url: args.url, targetCredential: "target-tok",
    }]);
  });

  it("offer, accept, cancel_request, get_request and list_requests route their arguments", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "offer", arguments: { credential: "c", requestId: "r1", model: "gpt-5.6-sol", effort: "high", note: "can start now" } }))))
      .toEqual({ requestId: "r1", model: "gpt-5.6-sol", effort: "high", note: "can start now" });
    expect(JSON.parse(text(await client.callTool({ name: "accept", arguments: { credential: "c", requestId: "r1", participantIds: ["p-1", "p-2"] } }))))
      .toEqual({ request: { id: "r1" }, invitationIds: ["i1"] });
    expect(calls.filter((x) => x[0] === "acceptRequest").at(-1)).toEqual(["acceptRequest", "c", "r1", ["p-1", "p-2"]]);
    expect(JSON.parse(text(await client.callTool({ name: "cancel_request", arguments: { credential: "c", requestId: "r1" } })))).toEqual({ id: "r1", status: "cancelled" });
    expect(JSON.parse(text(await client.callTool({ name: "get_request", arguments: { credential: "c", requestId: "r9" } })))).toEqual({ id: "r9", offers: [] });
    expect(JSON.parse(text(await client.callTool({ name: "list_requests", arguments: { credential: "c", status: "open" } })))).toEqual([{ id: "r1", status: "open", credential: "c" }]);
    // Which words name a status is core's rule, so an unknown one is passed through, not rejected here.
    await client.callTool({ name: "list_requests", arguments: { credential: "c", status: "nonsense" } });
    expect(calls.filter((x) => x[0] === "listRequests").at(-1)).toEqual(["listRequests", "c", { status: "nonsense" }]);
  });

  it("invite_to_weave forwards participant, target Weave and thread", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "invite_to_weave", arguments: { credential: "c", participantId: "p-1", targetWeaveId: "w1", threadId: "t1" } }))))
      .toEqual({ invitationId: "i1", seq: 3 });
    expect(calls.filter((x) => x[0] === "inviteToWeave").at(-1)).toEqual(["inviteToWeave", "c", "p-1", "w1", "t1"]);
  });

  it("maps a request_closed rejection into the { code, message } envelope", async () => {
    const r = await client.callTool({ name: "offer", arguments: { credential: "c", requestId: "closed" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ code: "request_closed", message: "This request is closed" });
  });

  it("join_weave takes an inviteId, with the secret optional when it is given", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "join_weave")!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required ?? []).not.toContain("secret");
    expect(Object.keys(schema.properties)).toContain("inviteId");
    expect(JSON.parse(text(await client.callTool({ name: "join_weave", arguments: { inviteId: "i1" } })))).toMatchObject({ weaveId: "target" });
    expect(calls.filter((x) => x[0] === "joinWeave").at(-1)![3]).toEqual({ inviteId: "i1" });
  });

  it("reads loom://lobby/requests as the open requests, with the credential the surface resolves", async () => {
    const c = await connect({ resourceCredential: (w) => (w === "lobby-1" ? "lobby-tok" : undefined) });
    try {
      const r = first(await c.readResource({ uri: "loom://lobby/requests" }));
      expect(r.mimeType).toBe("application/json");
      expect(JSON.parse(r.text)).toEqual([{ id: "r1", status: "open", credential: "lobby-tok" }]);
      expect(calls.filter((x) => x[0] === "listRequests").at(-1)).toEqual(["listRequests", "lobby-tok", { status: "open" }]);
    } finally { await c.close(); }
  });

  it("falls back to the connection default for the requests resource, and refuses without one", async () => {
    const withDefault = await connect({ defaultCredential: () => "agent-key" });
    try {
      expect(JSON.parse(first(await withDefault.readResource({ uri: "loom://lobby/requests" })).text)[0].credential).toBe("agent-key");
    } finally { await withDefault.close(); }
    await expect(client.readResource({ uri: "loom://lobby/requests" })).rejects.toThrow(/invalid_token/);
  });

  it("carries the backend's own code when the requests read is refused", async () => {
    const c = await connect({ resourceCredential: () => { throw new LoomToolError("forbidden", "join the Lobby first"); } });
    try {
      await expect(c.readResource({ uri: "loom://lobby/requests" })).rejects.toThrow(/forbidden: join the Lobby first/);
    } finally { await c.close(); }
  });

  it("the Lobby mechanics paragraph tells an agent how the flow runs", () => {
    for (const phrase of ["join_lobby", "set_capabilities", "request.opened", "offer", "join_weave({ inviteId })", "guidelines"]) {
      expect(LOBBY_MECHANICS).toContain(phrase);
    }
  });
});
