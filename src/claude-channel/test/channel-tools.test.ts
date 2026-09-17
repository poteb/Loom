import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LoomClient } from "@loom/client";
import { registerChannelTools, type ChannelHooks } from "../src/channel-tools.js";
import type { ChannelConfig, ChannelState, JoinedWeave } from "../src/state.js";

const open: Server[] = [];
afterEach(async () => {
  // closeAllConnections() first: a stalled request holds its socket open, so close() alone never
  // calls back and the suite would hang on teardown.
  for (const s of open.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

/** Starts a throwaway HTTP server on a loopback port and returns its base URL. */
async function serving(handler: () => void): Promise<string> {
  const s = createServer(handler);
  open.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const TOKEN = "T".repeat(43);
function joined(n: number): JoinedWeave {
  return { title: `W${n}`, token: TOKEN, participantId: `p${n}`, participantName: "Claude", generalThreadId: `g${n}`, wake: "all", lastSeq: n };
}

/** The slice of ChannelState list_joined reads; the real store is exercised in state.test.ts. */
function fakeState(weaveIds: string[]): ChannelState {
  const weaves = Object.fromEntries(weaveIds.map((id, i) => [id, joined(i)]));
  return {
    load: () => ({ weaves, sessions: {}, writers: {} } satisfies ChannelConfig),
    prefs: () => ({ wake: "all", invites: true, requests: true }),
    cursor: () => 7,
  } as unknown as ChannelState;
}

/** Registers the channel tools against a stub server and hands back the handlers by name. */
function toolsOf(state: ChannelState, client: LoomClient): Map<string, (args: unknown) => Promise<CallToolResult>> {
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const hooks: ChannelHooks = { onLeave: () => {}, onPrefsChanged: () => {} };
  const server = { registerTool: (name: string, _cfg: unknown, handler: (args: unknown) => Promise<CallToolResult>) => { handlers.set(name, handler); } };
  registerChannelTools(server as unknown as McpServer, state, client, hooks);
  return handlers;
}

async function listJoined(state: ChannelState, client: LoomClient): Promise<Record<string, unknown>[]> {
  const r = await toolsOf(state, client).get("list_joined")!({});
  return JSON.parse((r.content as { text: string }[])[0]!.text);
}

/** A client whose getWeave answers per weaveId, recording concurrent in-flight calls. */
function fakeClient(answer: (weaveId: string) => Promise<{ guidelines: string }>): { client: LoomClient; peak: () => number } {
  let inFlight = 0; let peak = 0;
  const client = {
    withToken: () => ({
      getWeave: async (weaveId: string) => {
        peak = Math.max(peak, ++inFlight);
        try { return await answer(weaveId); } finally { inFlight--; }
      },
    }),
  };
  return { client: client as unknown as LoomClient, peak: () => peak };
}

/** A state whose weaves can be removed, so leave_weave's two steps can be told apart. */
function leaveState(weaves: Record<string, JoinedWeave>): { state: ChannelState; removed: string[] } {
  const removed: string[] = [];
  const config = () => ({ weaves, sessions: {}, writers: {} } satisfies ChannelConfig);
  const state = {
    load: config, get: config,
    prefs: () => ({ wake: "all", invites: true, requests: true }),
    cursor: () => 0,
    removeWeave: async (id: string) => { removed.push(id); delete weaves[id]; },
  } as unknown as ChannelState;
  return { state, removed };
}

/**
 * A client whose Lobby profile write answers as `answer` says, and whose Lobby pointer answers as
 * `lobby` says — the lookup `leave_weave` makes for a stored entry that carries no `isLobby` flag.
 */
function capabilitiesClient(answer: () => Promise<unknown>, lobby: () => Promise<{ weaveId: string }> = async () => ({ weaveId: "somewhere-else" })):
  { client: LoomClient; calls: (unknown)[] } {
  const calls: unknown[] = [];
  const client = {
    withToken: () => ({ setCapabilities: (profile: unknown) => { calls.push(profile); return answer(); } }),
    getLobby: () => lobby(),
  };
  return { client: client as unknown as LoomClient, calls };
}

describe("leave_weave", () => {
  const lobby = (): Record<string, JoinedWeave> => ({ L: { ...joined(1), title: "Lobby", isLobby: true } });
  const call = async (state: ChannelState, client: LoomClient, args: unknown, onLeave = () => {}) => {
    const handlers = new Map<string, (a: unknown) => Promise<CallToolResult>>();
    const server = { registerTool: (name: string, _cfg: unknown, handler: (a: unknown) => Promise<CallToolResult>) => { handlers.set(name, handler); } };
    registerChannelTools(server as unknown as McpServer, state, client, { onLeave, onPrefsChanged: () => {} });
    const r = await handlers.get("leave_weave")!(args);
    return { r, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
  };

  it("clears the Lobby profile before dropping the credential", async () => {
    const { state, removed } = leaveState(lobby());
    const { client, calls } = capabilitiesClient(async () => ({ id: "p1" }));
    const { r, body } = await call(state, client, { weaveId: "L" });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([null]);
    expect(removed).toEqual(["L"]);
    expect(body).toMatchObject({ weaveId: "L", left: true });
    expect(body.profileMayRemain).toBeUndefined();
  });

  it("rejects the leave and keeps everything when the profile cannot be cleared", async () => {
    const { state, removed } = leaveState(lobby());
    const { client, calls } = capabilitiesClient(async () => { throw new Error("fetch failed"); });
    let stopped = 0;
    const { r, body } = await call(state, client, { weaveId: "L" }, () => { stopped++; });
    expect(r.isError).toBe(true);
    expect(body.code).toBe("network");
    expect(calls).toEqual([null]);
    expect(removed).toEqual([]);           // still joined: a retry can still clear the profile
    expect(stopped).toBe(0);               // and the stream was never torn down
  });

  it("force drops the credential anyway and says the profile may still be live", async () => {
    const { state, removed } = leaveState(lobby());
    const { client } = capabilitiesClient(async () => { throw new Error("fetch failed"); });
    const { r, body } = await call(state, client, { weaveId: "L", force: true });
    expect(r.isError).toBeFalsy();
    expect(body).toMatchObject({ weaveId: "L", left: true, profileMayRemain: true });
    expect(removed).toEqual(["L"]);
  });

  // A credential can reach the Lobby without join_lobby (a secret join), and entries predate the
  // flag; the leave must not decide from the flag alone that there is no profile to clear.
  it("recognises the Lobby at leave time for a stored entry that carries no flag", async () => {
    const { state, removed } = leaveState({ L: joined(1) });
    const { client, calls } = capabilitiesClient(async () => ({ id: "p1" }), async () => ({ weaveId: "L" }));
    const { r, body } = await call(state, client, { weaveId: "L" });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([null]);                 // the profile was cleared first…
    expect(removed).toEqual(["L"]);                // …and only then was the credential dropped
    expect(body).toMatchObject({ weaveId: "L", left: true });
  });

  it("rejects the leave when it cannot tell whether the Weave is the Lobby", async () => {
    const { state, removed } = leaveState({ L: joined(1) });
    const { client, calls } = capabilitiesClient(async () => ({ id: "p1" }), async () => { throw new Error("fetch failed"); });
    let stopped = 0;
    const { r, body } = await call(state, client, { weaveId: "L" }, () => { stopped++; });
    expect(r.isError).toBe(true);
    expect(body.code).toBe("network");
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
    expect(stopped).toBe(0);
  });

  it("leaves an ordinary Weave without touching any profile", async () => {
    const { state, removed } = leaveState({ w1: joined(1) });
    const { client, calls } = capabilitiesClient(async () => { throw new Error("should not be called"); });
    const { r, body } = await call(state, client, { weaveId: "w1" });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([]);
    expect(body).toEqual({ weaveId: "w1", left: true });
    expect(removed).toEqual(["w1"]);
  });
});

describe("list_joined guidelines fan-out", () => {
  it("reports one Weave's failure per Weave, redacted, and still answers for the others", async () => {
    const { client } = fakeClient(async (id) => {
      if (id === "w1") throw new Error(`Weave not found for token ${TOKEN}`);
      return { guidelines: `rules for ${id}` };
    });
    const entries = await listJoined(fakeState(["w0", "w1", "w2"]), client);
    expect(entries.map((e) => e.weaveId)).toEqual(["w0", "w1", "w2"]);
    expect(entries[0]!.guidelines).toBe("rules for w0");
    expect(entries[2]!.guidelines).toBe("rules for w2");
    expect(entries[1]!.guidelines).toBeNull();
    // The message travels to the agent's transcript, so it goes through the channel's redact().
    expect(entries[1]!.guidelinesError).toBe("Weave not found for token [redacted]");
  });

  it("gives up on a stalled server at the deadline instead of hanging the whole listing", async () => {
    const url = await serving(() => { /* accepted, never answered */ });
    const client = new LoomClient({ baseUrl: url, allowInsecure: true });
    const t0 = Date.now();
    const entries = await listJoined(fakeState(["w0"]), client);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(entries[0]!.guidelines).toBeNull();
    expect(entries[0]!.guidelinesError).toBe("Request to Loom timed out or was aborted");
  });

  it("caps how many Weaves are fetched at once", async () => {
    const { client, peak } = fakeClient(async (id) => {
      await new Promise((r) => setTimeout(r, 20));
      return { guidelines: id };
    });
    const ids = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const entries = await listJoined(fakeState(ids), client);
    expect(entries.map((e) => e.guidelines)).toEqual(ids);
    expect(peak()).toBeLessThanOrEqual(4);
  });
});
