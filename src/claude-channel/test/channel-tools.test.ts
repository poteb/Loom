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
    prefs: () => ({ wake: "all", invites: true }),
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
