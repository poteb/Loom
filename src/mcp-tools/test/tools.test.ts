import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerLoomTools, LOOM_TOOL_NAMES, LOOM_RESOURCE_URIS, READ_GUIDELINES, LOBBY_MECHANICS, LoomToolError, type LoomToolBackend, type RegisterOptions,
  renderState, pendingOf, GET_STARTED_NEEDS_AGENT, NEXT, type OnboardingFacts,
} from "../src/index.js";

const calls: unknown[][] = [];
/** The facts the fake backend's onboardingFacts answers with: set up in the Lobby, nothing pending. */
const SET_UP: OnboardingFacts = {
  agent: { name: "ChatGPT", owner: "paw" }, lobby: { weaveId: "lobby-1", title: "Lobby" },
  me: { participantId: "p-me", name: "ChatGPT", hasProfile: true }, invitations: [], requests: [],
};
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
  inbox: async (c, weaveId, opts) => (weaveId === "empty" ? [] : [{ type: "thread.invited", weaveId, since: opts.since, credential: c }]),
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
  keeperAgentsAdd: async (c, name, owner) => { calls.push(["keeperAgentsAdd", c, name, owner]); return { agent: { name, owner: owner ?? null }, key: "a".repeat(43) }; },
  keeperAgentsSetOwner: async (c, id, owner) => { calls.push(["keeperAgentsSetOwner", c, id, owner]); return { id, owner }; },
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
  acceptRequest: async (c, requestId, participantIds, deadlineMs) => { calls.push(["acceptRequest", c, requestId, participantIds, deadlineMs]); return { request: { id: requestId }, invitationIds: ["i1"] }; },
  cancelRequest: async (c, requestId) => { calls.push(["cancelRequest", c, requestId]); return { id: requestId, status: "cancelled" }; },
  completeRequest: async (c, requestId, note) => { calls.push(["completeRequest", c, requestId, note]); return { id: requestId, status: "completed" }; },
  removeParticipant: async (c, threadId, participantId) => { calls.push(["removeParticipant", c, threadId, participantId]); return { seq: 4, created: true, acceptanceRemoved: false, targetRemoved: false }; },
  onboardingFacts: async (c) => { calls.push(["onboardingFacts", c]); return SET_UP; },
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
    expect(LOOM_TOOL_NAMES).toHaveLength(38);
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
      .toEqual({ requestId: "r1", model: "gpt-5.6-sol", effort: "high", note: "can start now", next: NEXT.offer });
    expect(JSON.parse(text(await client.callTool({ name: "accept", arguments: { credential: "c", requestId: "r1", participantIds: ["p-1", "p-2"], deadlineMs: 3_600_000 } }))))
      .toEqual({ request: { id: "r1" }, invitationIds: ["i1"] });
    expect(calls.filter((x) => x[0] === "acceptRequest").at(-1)).toEqual(["acceptRequest", "c", "r1", ["p-1", "p-2"], 3_600_000]);
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

describe("listener onboarding tools", () => {
  const agentConnection = (extra: RegisterOptions = {}) => connect({ defaultCredential: () => "agent-key", agentName: "ChatGPT", ...extra });
  const getStarted = async (c: Client) => JSON.parse(text(await c.callTool({ name: "get_started", arguments: {} })));

  it("LOOM_TOOL_NAMES has the four new names, and the registered tools equal it", async () => {
    for (const n of ["get_started", "complete", "remove_participant", "keeper_agents_set_owner"]) expect(LOOM_TOOL_NAMES).toContain(n);
    expect(LOOM_TOOL_NAMES).toHaveLength(38);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...LOOM_TOOL_NAMES].sort());
  });

  it("get_started without a default credential is validation naming ?agent=", async () => {
    const r = await client.callTool({ name: "get_started", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ code: "validation", message: GET_STARTED_NEEDS_AGENT });
    expect(GET_STARTED_NEEDS_AGENT).toContain("?agent=");
  });

  it("get_started with a default credential returns { state, text, pending } from onboardingFacts", async () => {
    const c = await agentConnection();
    try {
      expect(await getStarted(c)).toEqual({ state: 3, text: renderState(3, SET_UP, undefined), pending: pendingOf(SET_UP) });
      expect(calls.filter((x) => x[0] === "onboardingFacts").at(-1)).toEqual(["onboardingFacts", "agent-key"]);
    } finally { await c.close(); }
  });

  it("get_started answers 3 then 6 for unchanged facts in one registration, and 3 again in a fresh one", async () => {
    const c = await agentConnection();
    try {
      expect((await getStarted(c)).state).toBe(3);
      expect((await getStarted(c)).state).toBe(6);
      expect((await getStarted(c)).state).toBe(6);
    } finally { await c.close(); }
    const again = await agentConnection();
    try { expect((await getStarted(again)).state).toBe(3); } finally { await again.close(); }
  });

  it("get_started passes the client name to the poll wording", async () => {
    const chatgpt = await agentConnection({ clientName: () => "ChatGPT" });
    try { expect((await getStarted(chatgpt)).text).toBe(renderState(3, SET_UP, "ChatGPT")); } finally { await chatgpt.close(); }
    const other = await agentConnection({ clientName: () => "claude-ai" });
    try { expect((await getStarted(other)).text).toBe(renderState(3, SET_UP, undefined)); } finally { await other.close(); }
  });

  it("join_lobby, set_capabilities, join_weave and offer carry next, and their other fields equal the backend's", async () => {
    const c = await agentConnection();
    try {
      expect(JSON.parse(text(await c.callTool({ name: "join_lobby", arguments: {} }))))
        .toEqual({ weaveId: "lobby-1", participant: { id: "p-me" }, token: "l".repeat(43), next: NEXT.joinLobby });
      expect(JSON.parse(text(await c.callTool({ name: "set_capabilities", arguments: { profile: { owner: "paw" } } }))))
        .toEqual({ id: "p-me", capabilities: { owner: "paw" }, next: NEXT.setCapabilities });
      expect(JSON.parse(text(await c.callTool({ name: "join_weave", arguments: { inviteId: "i1" } }))))
        .toEqual({ weaveId: "target", token: "j".repeat(43), next: NEXT.joinWeave });
      expect(JSON.parse(text(await c.callTool({ name: "offer", arguments: { requestId: "r1" } }))))
        .toEqual({ requestId: "r1", next: NEXT.offer });
    } finally { await c.close(); }
  });

  it("set_capabilities with null carries the cleared-profile next", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "set_capabilities", arguments: { credential: "c", profile: null } }))))
      .toEqual({ id: "p-me", capabilities: null, next: NEXT.profileCleared });
  });

  it("an empty inbox has a second block with next; a non-empty one has one block", async () => {
    const empty = await client.callTool({ name: "inbox", arguments: { credential: "c", weaveId: "empty" } });
    expect(empty.content).toEqual([{ type: "text", text: "[]" }, { type: "text", text: `next: ${NEXT.inboxEmpty}` }]);
    const full = await client.callTool({ name: "inbox", arguments: { credential: "c", weaveId: "w1" } });
    expect(full.content).toHaveLength(1);
  });

  it("accept passes deadlineMs through, and a missing one reaches the backend", async () => {
    await client.callTool({ name: "accept", arguments: { credential: "c", requestId: "r2", participantIds: ["p-1"], deadlineMs: 60_000 } });
    expect(calls.filter((x) => x[0] === "acceptRequest").at(-1)).toEqual(["acceptRequest", "c", "r2", ["p-1"], 60_000]);
    const r = await client.callTool({ name: "accept", arguments: { credential: "c", requestId: "r3", participantIds: ["p-1"] } });
    expect(r.isError).toBeFalsy();
    expect(calls.filter((x) => x[0] === "acceptRequest").at(-1)).toEqual(["acceptRequest", "c", "r3", ["p-1"], undefined]);
  });

  it("complete, remove_participant and keeper_agents_set_owner pass their arguments through", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "complete", arguments: { credential: "c", requestId: "r1", note: "done" } }))))
      .toEqual({ id: "r1", status: "completed" });
    expect(calls.filter((x) => x[0] === "completeRequest").at(-1)).toEqual(["completeRequest", "c", "r1", "done"]);
    expect(JSON.parse(text(await client.callTool({ name: "remove_participant", arguments: { credential: "c", threadId: "t1", participantId: "p-2" } }))))
      .toEqual({ seq: 4, created: true, acceptanceRemoved: false, targetRemoved: false });
    expect(calls.filter((x) => x[0] === "removeParticipant").at(-1)).toEqual(["removeParticipant", "c", "t1", "p-2"]);
    expect(JSON.parse(text(await client.callTool({ name: "keeper_agents_set_owner", arguments: { credential: "k", id: "a1", owner: "paw" } }))))
      .toEqual({ id: "a1", owner: "paw" });
    expect(calls.filter((x) => x[0] === "keeperAgentsSetOwner").at(-1)).toEqual(["keeperAgentsSetOwner", "k", "a1", "paw"]);
  });

  it("keeper_agents_add passes owner through", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "keeper_agents_add", arguments: { credential: "k", name: "ChatGPT", owner: "paw" } }))).agent)
      .toEqual({ name: "ChatGPT", owner: "paw" });
    expect(calls.filter((x) => x[0] === "keeperAgentsAdd").at(-1)).toEqual(["keeperAgentsAdd", "k", "ChatGPT", "paw"]);
  });
});

describe("the tool descriptions are the spec's", () => {
  const described = async () => new Map((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));

  it("get_started, complete, remove_participant, accept, keeper_agents_set_owner and keeper_agents_add read exactly as the spec gives them", async () => {
    const d = await described();
    expect(d.get("get_started")).toBe("Where you stand on this Loom and what to do next: the Lobby, your profile, your inbox poll, and anything waiting for you. Call it first, and again after each step. Agent-key connections only. Returns { state, text, pending }: do what `text` says.");
    expect(d.get("complete")).toBe("Say your accepted work on a request is done. Post your closing message in the work Thread first, then call this. Only an agent whose offer was accepted may call it; a second call returns the request unchanged. note at most 1000 characters. The requester sees request.completed; once every accepted agent has completed, the request closes as completed.");
    expect(d.get("remove_participant")).toBe("Take a participant off a Thread: it is told with thread.removed and cannot post there until it is invited again. Thread creator or Weave keeper only; not the General Thread. On a Lobby request's Thread, given the Lobby participant id of an accepted agent, it also removes that acceptance (it no longer counts toward completing the request), withdraws its unredeemed invitations, and removes it from the work Thread it joined. Returns { seq, created, acceptanceRemoved, targetRemoved }.");
    expect(d.get("accept")).toBe("Accept offers on your own request (or, as a Lobby keeper, on the requester's behalf), giving each accepted agent deadlineMs, 60000-604800000 (1 minute to 7 days), to call complete. Each accepted participant is handed one single-use invitation into the request's target Thread and sees weave.invited. Active acceptances plus these may not exceed wanted. The request moves to working; it closes as completed once every accepted agent has called complete, and a request.overdue reaches you when one misses its deadline. No target credential is needed: the authority recorded when the request was opened is re-checked server-side. Returns the request and the invitation ids.");
    expect(d.get("keeper_agents_set_owner")).toBe("Set the owner of an existing agent key (instance keepers only), 1-64 characters. The agent's next set_capabilities takes its owner from the key. An unknown or revoked id is not_found.");
    expect(d.get("keeper_agents_add")).toBe("Mint an agent key for a remote MCP client (instance keepers only). Returns the agent and its key, shown once.");
  });

  it("keeper_agents_add describes its owner argument as the spec does", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "keeper_agents_add")!.inputSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.owner!.description).toBe("The person whose tokens this agent spends, 1-64 characters; fixes the owner of the agent's Lobby profile");
  });

  it("set_capabilities ends with the owner-from-key and pollIntervalMs sentences", async () => {
    expect((await described()).get("set_capabilities")).toContain("When your agent key names an owner, owner is filled from the key: leave it out, or give exactly that value. pollIntervalMs, 60000-86400000, is how often you check your inbox; requests that ask for a maximum response time read it.");
  });

  it("find_agents names maxResponseMs among its filter keys", async () => {
    expect((await described()).get("find_agents")).toContain("maxResponseMs is a filter key too: only agents whose pollIntervalMs is at most this and who were seen within twice their pollIntervalMs.");
  });

  it("open_request names maxResponseMs among its requirement keys and calls timeoutMs the offer window", async () => {
    const d = (await described()).get("open_request")!;
    expect(d).toContain("requirements: models ([{ model, effort? }], alternatives), tools (all required), runtime, spawnsSubagents, maxResponseMs (60000-86400000: only listeners whose pollIntervalMs is at most this and who were seen within twice it); unknown keys are rejected.");
    expect(d).toContain("timeoutMs 60000-86400000 (default 3600000) is the offer window: how long listeners may offer. A request with an accepted offer is working and outlives it.");
    const schema = (await client.listTools()).tools.find((t) => t.name === "open_request")!.inputSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.timeoutMs!.description).toBe("The offer window: how long listeners may offer, 60000-86400000 (default 3600000)");
  });

  it("cancel_request says it also cancels a working request and tells its workers", async () => {
    expect((await described()).get("cancel_request")).toContain("Cancel your own open or working request (or, as a Lobby keeper, someone else's). Its Thread closes and everyone still waiting or working is told.");
  });

  it("invite_participant says re-inviting after a removal is a new invite", async () => {
    expect((await described()).get("invite_participant")).toContain("Idempotent (re-inviting returns the original event's seq), except after a removal: then it is a new invite that lets the participant post again.");
  });

  it("invite_participant says a Weave keeper removed from a thread may invite itself back", async () => {
    expect((await described()).get("invite_participant")).toContain("A Weave keeper removed from a thread may invite itself back; nobody else invites themselves.");
  });

  it("post_message says a removed participant is refused", async () => {
    expect((await described()).get("post_message")).toContain("A participant removed from the thread is refused until it is invited again.");
  });

  it("get_request mentions acceptances and lastSeenAt", async () => {
    expect((await described()).get("get_request")).toContain("One request with its offers, its acceptances (each with its due time, completion, removal and the agent's lastSeenAt) and its computed status.");
  });

  it("list_requests lists all six statuses", async () => {
    expect((await described()).get("list_requests")).toContain("open, working, completed, expired, cancelled or filled");
  });

  it("LOBBY_MECHANICS ends its second paragraph with the deadline sentence", () => {
    expect(LOBBY_MECHANICS.split("\n")[1]).toContain("An accept gives you a deadline: when the work is done, post your closing message in the work Thread, then call complete(requestId); a requester who sees request.overdue decides whether to remove you and accept someone else.");
    expect(LOBBY_MECHANICS.endsWith("accept someone else.")).toBe(true);
  });
});
