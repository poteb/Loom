import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoomClient } from "@loom/client";
import { fail, ok } from "@loom/mcp-tools";
import type { ChannelState, Prefs } from "./state.js";

export type ChannelHooks = { onLeave(weaveId: string): void; onPrefsChanged(weaveId: string, prefs: Prefs): void };

export function registerChannelTools(server: McpServer, state: ChannelState, client: LoomClient, hooks: ChannelHooks): void {
  server.registerTool("list_joined", {
    description: "List the Weaves this machine's Loom channel is joined to (the identity is shared by every Claude Code session here), with your participant name, this session's wake mode and invites flag, guidelines (the instance's and that Weave's rules as they stand now — read them before posting), and lastSeq: the last event this session's stream has processed (in 'mentions' mode that includes events it did not wake you for; use read_events to see them).",
    inputSchema: {},
  }, async () => ok(await Promise.all(Object.entries(state.load().weaves).map(async ([weaveId, w]) => {
    const entry = {
      weaveId, title: w.title, participantName: w.participantName, participantId: w.participantId, generalThreadId: w.generalThreadId, ...state.prefs(weaveId), lastSeq: state.cursor(weaveId),
    };
    // One Weave's guidelines are a fetch that can fail (a revoked token, a server that is down);
    // reporting that per Weave beats failing the whole listing, which is how a session finds its
    // way back to everything else it is joined to.
    try {
      return { ...entry, guidelines: (await client.withToken(w.token).getWeave(weaveId)).guidelines };
    } catch (e) {
      return { ...entry, guidelines: null, guidelinesError: e instanceof Error ? e.message : String(e) };
    }
  }))));

  server.registerTool("set_wake", {
    description: "Preferences for this session only. wake: 'all' (every message and system event) or 'mentions' (only messages that @mention you). invites: whether an invite addressed to you wakes this session (default true; it wakes even in 'mentions' mode). Other Claude Code sessions keep their own settings.",
    inputSchema: { weaveId: z.string(), wake: z.enum(["all", "mentions"]).optional(), invites: z.boolean().optional() },
  }, async ({ weaveId, wake, invites }) => {
    if (!state.load().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    if (wake === undefined && invites === undefined) return fail("validation", "Pass wake and/or invites");
    const prefs = await state.setPrefs(weaveId, { ...(wake !== undefined ? { wake } : {}), ...(invites !== undefined ? { invites } : {}) });
    hooks.onPrefsChanged(weaveId, prefs);
    return ok({ weaveId, ...prefs });
  });

  server.registerTool("leave_weave", {
    description: "Stop receiving events from a Weave and forget the stored participant token. (The participant stays in the Weave; joining again creates a new participant.)",
    inputSchema: { weaveId: z.string() },
  }, async ({ weaveId }) => {
    if (!state.load().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    hooks.onLeave(weaveId);
    await state.removeWeave(weaveId);
    return ok({ weaveId, left: true });
  });
}
