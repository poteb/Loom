import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, ok } from "@loom/mcp-tools";
import type { ChannelState, Wake } from "./state.js";

export type ChannelHooks = { onLeave(weaveId: string): void; onWakeChanged(weaveId: string, wake: Wake): void };

export function registerChannelTools(server: McpServer, state: ChannelState, hooks: ChannelHooks): void {
  server.registerTool("list_joined", {
    description: "List the Weaves this machine's Loom channel is joined to (the identity is shared by every Claude Code session here), with your participant name, wake mode and the last seq delivered to this session.",
    inputSchema: {},
  }, async () => ok(Object.entries(state.load().weaves).map(([weaveId, w]) => ({
    weaveId, title: w.title, participantName: w.participantName, participantId: w.participantId, generalThreadId: w.generalThreadId, wake: w.wake, lastSeq: state.cursor(weaveId),
  }))));

  server.registerTool("set_wake", {
    description: "Choose when this Weave wakes the session: 'all' (every message and system event) or 'mentions' (only messages that @mention you; everything stays readable with read_events).",
    inputSchema: { weaveId: z.string(), wake: z.enum(["all", "mentions"]) },
  }, async ({ weaveId, wake }) => {
    if (!state.load().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    await state.setWake(weaveId, wake);
    hooks.onWakeChanged(weaveId, wake);
    return ok({ weaveId, wake });
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
