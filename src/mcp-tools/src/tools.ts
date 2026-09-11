import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoomToolBackend } from "./backend.js";
import { toToolResult } from "./result.js";

export const LOOM_TOOL_NAMES = [
  "create_weave", "join_weave", "lookup_weave", "get_weave", "read_events", "post_message", "create_thread",
  "close_thread", "archive_weave", "set_role", "export_weave",
  "keeper_list_weaves", "keeper_get_settings", "keeper_set_settings", "keeper_list", "keeper_add", "keeper_remove",
] as const;

const kind = z.enum(["human", "agent"]).default("agent");
const cred = (hint: string) => z.string().min(1).describe(hint);

export function registerLoomTools(server: McpServer, backend: LoomToolBackend, opts: { credentialHint?: string } = {}): void {
  const hint = opts.credentialHint ??
    "Your Loom credential for this Weave: the participant token returned by create_weave/join_weave (keep it for the whole session), a keeper token, or the Weave secret for read-only access.";

  server.registerTool("create_weave", {
    description: "Create a new Loom Weave (a room) with a General thread and post the opening message. You become its keeper. Returns the Weave, its secret (share it with others so they can join), your participant token (keep it; pass it as `credential` to every later call) and the General thread id.",
    inputSchema: {
      title: z.string().min(1).max(200), opener: z.string().default("").describe("Opening message in Markdown; put the subject (e.g. a PR link) here"),
      name: z.string().min(1).max(32).describe("Your participant name: 1-32 chars of A-Z a-z 0-9 _ . -"), kind,
      credential: z.string().optional().describe("Keeper token; only needed when the instance restricts Weave creation"),
    },
  }, ({ title, opener, name, kind, credential }) =>
    toToolResult(backend.createWeave({ title, opener, creator: { name, kind } }, credential)));

  server.registerTool("join_weave", {
    description: "Join an existing Weave with its secret. Returns the weaveId, your participant record and your participant token — keep the token and pass it as `credential` to every later call in this session.",
    inputSchema: { secret: z.string().min(1), name: z.string().min(1).max(32), kind },
  }, ({ secret, name, kind }) => toToolResult(backend.joinWeave(secret, { name, kind })));

  server.registerTool("lookup_weave", {
    description: "Resolve a Weave secret to its weaveId without joining (the secret also works as a read-only credential).",
    inputSchema: { secret: z.string().min(1) },
  }, ({ secret }) => toToolResult(backend.lookupWeave(secret)));

  server.registerTool("get_weave", {
    description: "Get a Weave: title, archived state, threads (with closed state) and participants (names, kinds, roles).",
    inputSchema: { credential: cred(hint), weaveId: z.string() },
  }, ({ credential, weaveId }) => toToolResult(backend.getWeave(credential, weaveId)));

  server.registerTool("read_events", {
    description: "Read the Weave's event log in seq order: messages and system events (joins, threads created/closed, role changes, archive). Use `since` (the last seq you have seen) to page; optional `threadId` filter; `limit` up to 1000.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().min(0).optional(), threadId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, ({ credential, weaveId, since, threadId, limit }) => toToolResult(backend.readEvents(credential, weaveId, { since, threadId, limit })));

  server.registerTool("post_message", {
    description: "Post a Markdown message to a thread. Mention someone with @Name. Returns the committed event (with its seq).",
    inputSchema: { credential: cred(hint), threadId: z.string(), text: z.string().min(1) },
  }, ({ credential, threadId, text }) => toToolResult(backend.postMessage(credential, threadId, text)));

  server.registerTool("create_thread", {
    description: "Create a new thread in the Weave (for a sub-topic). Returns the thread.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), name: z.string().min(1).max(100) },
  }, ({ credential, weaveId, name }) => toToolResult(backend.createThread(credential, weaveId, name)));

  server.registerTool("close_thread", {
    description: "Close a thread (keepers only). Closed threads stay readable; posting is rejected. The General thread cannot be closed.",
    inputSchema: { credential: cred(hint), threadId: z.string() },
  }, ({ credential, threadId }) => toToolResult(backend.closeThread(credential, threadId)));

  server.registerTool("archive_weave", {
    description: "Archive the Weave (keepers only). It becomes read-only for everyone.",
    inputSchema: { credential: cred(hint), weaveId: z.string() },
  }, ({ credential, weaveId }) => toToolResult(backend.archiveWeave(credential, weaveId)));

  server.registerTool("set_role", {
    description: "Change a participant's role to member or keeper (keepers only).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), participantId: z.string(), role: z.enum(["member", "keeper"]) },
  }, ({ credential, weaveId, participantId, role }) => toToolResult(backend.setRole(credential, weaveId, participantId, role)));

  server.registerTool("export_weave", {
    description: "Export the whole Weave transcript as Markdown (format md) or JSON (format json).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), format: z.enum(["md", "json"]).default("md") },
  }, ({ credential, weaveId, format }) => toToolResult(backend.exportWeave(credential, weaveId, format)));

  const keeper = "Instance keeper token (LOOM_KEEPER_TOKENS / keeper_add).";
  server.registerTool("keeper_list_weaves", { description: "List every Weave on this Loom instance, including archived ones (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(backend.keeperListWeaves(credential)));
  server.registerTool("keeper_get_settings", { description: "Read instance settings (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(backend.keeperGetSettings(credential)));
  server.registerTool("keeper_set_settings", {
    description: "Update instance settings: instanceName, maxMessageLength, openWeaveCreation (instance keepers only).",
    inputSchema: { credential: cred(keeper), instanceName: z.string().optional(), maxMessageLength: z.number().int().optional(), openWeaveCreation: z.boolean().optional() },
  }, ({ credential, ...patch }) => toToolResult(backend.keeperSetSettings(credential, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))));
  server.registerTool("keeper_list", { description: "List instance keepers (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(backend.keeperList(credential)));
  server.registerTool("keeper_add", { description: "Add an instance keeper; returns the new keeper and its token (shown once).", inputSchema: { credential: cred(keeper), name: z.string().min(1).max(64) } },
    ({ credential, name }) => toToolResult(backend.keeperAdd(credential, name)));
  server.registerTool("keeper_remove", { description: "Remove an instance keeper by id (instance keepers only; not yourself).", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(backend.keeperRemove(credential, id)));
}
