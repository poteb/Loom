import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, ok } from "@loom/mcp-tools";
import type { ChannelState, Wake } from "./state.js";

export type ChannelHooks = { onLeave(weaveId: string): void; onWakeChanged(weaveId: string, wake: Wake): void };

export function registerChannelTools(server: McpServer, state: ChannelState, hooks: ChannelHooks): void {
  server.registerTool("list_joined", {
    description: "List the Weaves this Claude Code session is joined to through the Loom channel, with your participant name, wake mode and the last seq delivered.",
    inputSchema: {},
  }, async () => ok(Object.entries(state.get().weaves).map(([weaveId, w]) => ({
    weaveId, title: w.title, participantName: w.participantName, participantId: w.participantId, generalThreadId: w.generalThreadId, wake: w.wake, lastSeq: w.lastSeq,
  }))));

  server.registerTool("set_wake", {
    description: "Choose when this Weave wakes the session: 'all' (every message and system event) or 'mentions' (only messages that @mention you; everything stays readable with read_events).",
    inputSchema: { weaveId: z.string(), wake: z.enum(["all", "mentions"]) },
  }, async ({ weaveId, wake }) => {
    if (!state.get().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    state.setWake(weaveId, wake);
    hooks.onWakeChanged(weaveId, wake);
    return ok({ weaveId, wake });
  });

  server.registerTool("leave_weave", {
    description: "Stop receiving events from a Weave and forget the stored participant token. (The participant stays in the Weave; joining again creates a new participant.)",
    inputSchema: { weaveId: z.string() },
  }, async ({ weaveId }) => {
    if (!state.get().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    hooks.onLeave(weaveId);
    state.removeWeave(weaveId);
    return ok({ weaveId, left: true });
  });
}
