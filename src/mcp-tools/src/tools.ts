import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoomToolError, type LoomToolBackend } from "./backend.js";
import { toToolResult } from "./result.js";

export const LOOM_TOOL_NAMES = [
  "create_weave", "join_weave", "lookup_weave", "get_weave", "read_events", "inbox", "post_message", "create_thread",
  "set_thread_url", "invite_participant", "close_thread", "archive_weave", "set_role", "export_weave",
  "keeper_list_weaves", "keeper_get_settings", "keeper_set_settings", "keeper_list", "keeper_add", "keeper_remove",
  "keeper_agents_list", "keeper_agents_add", "keeper_agents_revoke",
] as const;

const kind = z.enum(["human", "agent"]).default("agent");

export type RegisterOptions = {
  credentialHint?: string;
  /** When set (a connection authenticated with an agent key), `credential` becomes optional on every tool and defaults to this. */
  defaultCredential?: () => string | undefined;
  agentName?: string;
};

export function registerLoomTools(server: McpServer, backend: LoomToolBackend, opts: RegisterOptions = {}): void {
  const defaultCred = opts.defaultCredential;
  const hint = opts.credentialHint ??
    (defaultCred
      ? `Optional: defaults to this connection's agent${opts.agentName ? ` (${opts.agentName})` : ""}. Pass a participant token, keeper token or Weave secret to act as someone else.`
      : "Your Loom credential for this Weave: the participant token returned by create_weave/join_weave (keep it for the whole session), a keeper token, or the Weave secret for read-only access.");
  // With a connection default the schema marks `credential` optional; the resolver fills it in.
  const cred = (h: string) => (defaultCred ? z.string().min(1).optional().describe(h) : z.string().min(1).describe(h));
  const resolve = (c: string | undefined): string => {
    const v = c ?? defaultCred?.();
    if (!v) throw new LoomToolError("invalid_token", "credential is required on this connection");
    return v;
  };

  server.registerTool("create_weave", {
    description: "Create a new Loom Weave (a room) with a General thread and post the opening message. You become its keeper. Returns the Weave, its secret (share it with others so they can join), your participant token (keep it; pass it as `credential` to every later call) and the General thread id.",
    inputSchema: {
      title: z.string().min(1).max(200), opener: z.string().default("").describe("Opening message in Markdown; put the subject (e.g. a PR link) here"),
      name: z.string().min(1).max(32).describe("Your participant name: 1-32 chars of A-Z a-z 0-9 _ . -"), kind,
      credential: z.string().optional().describe("Keeper token; only needed when the instance restricts Weave creation"),
    },
  }, ({ title, opener, name, kind, credential }) =>
    toToolResult(backend.createWeave({ title, opener, creator: { name, kind } }, credential ?? defaultCred?.())));

  server.registerTool("join_weave", {
    description: "Join an existing Weave with its secret. Returns the weaveId, your participant record and your participant token — keep the token and pass it as `credential` to every later call in this session. Backends that remember your identity (the Claude Code channel) return the stored identity with alreadyJoined: true when you join a Weave you already joined under the same name, instead of failing with name_taken.",
    inputSchema: { secret: z.string().min(1), name: z.string().min(1).max(32).optional().describe("Your participant name; defaults to your agent name on an agent connection"), kind },
  }, ({ secret, name, kind }) => toToolResult(backend.joinWeave(secret, { name, kind }, defaultCred?.())));

  server.registerTool("lookup_weave", {
    description: "Resolve a Weave secret to its weaveId without joining (the secret also works as a read-only credential).",
    inputSchema: { secret: z.string().min(1) },
  }, ({ secret }) => toToolResult(backend.lookupWeave(secret)));

  server.registerTool("get_weave", {
    description: "Get a Weave: title, archived state, threads (with closed state) and participants (names, kinds, roles).",
    inputSchema: { credential: cred(hint), weaveId: z.string() },
  }, ({ credential, weaveId }) => toToolResult(Promise.resolve().then(() => backend.getWeave(resolve(credential), weaveId))));

  server.registerTool("read_events", {
    description: "Read the Weave's event log in seq order: messages and system events (joins, threads created/closed, role changes, archive). Use `since` (the last seq you have seen) to page; optional `threadId` filter; `limit` up to 1000.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().min(0).optional(), threadId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, ({ credential, weaveId, since, threadId, limit }) => toToolResult(Promise.resolve().then(() => backend.readEvents(resolve(credential), weaveId, { since, threadId, limit }))));

  server.registerTool("inbox", {
    description: "What is addressed to you in this Weave: invites naming you and messages that @mention you, oldest first, excluding your own. Each item includes threadName and threadUrl (the artefact the Thread is about, or null). Call this first on every turn when you have no push connection, passing since = the last seq you saw; omit since to get the most recent addressed events. Then read_events(threadId) for context and post_message to reply.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, ({ credential, weaveId, since, limit }) => toToolResult(Promise.resolve().then(() => backend.inbox(resolve(credential), weaveId, { since, limit }))));

  server.registerTool("post_message", {
    description: "Post a Markdown message to a thread. Mention someone with @Name. Returns the committed event (with its seq).",
    inputSchema: { credential: cred(hint), threadId: z.string(), text: z.string().min(1) },
  }, ({ credential, threadId, text }) => toToolResult(Promise.resolve().then(() => backend.postMessage(resolve(credential), threadId, text))));

  server.registerTool("create_thread", {
    description: "Create a new thread in the Weave (for a sub-topic or an artefact such as a pull request). Optional url: the artefact the thread is about; it is shown to everyone and sent with every event from the thread.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), name: z.string().min(1).max(100), url: z.url().max(2000).optional() },
  }, ({ credential, weaveId, name, url }) => toToolResult(Promise.resolve().then(() => backend.createThread(resolve(credential), weaveId, name, url ?? null))));

  server.registerTool("set_thread_url", {
    description: "Set or clear (null) the artefact URL of a thread. Thread creator or Weave keeper only.",
    inputSchema: { credential: cred(hint), threadId: z.string(), url: z.url().max(2000).nullable() },
  }, ({ credential, threadId, url }) => toToolResult(Promise.resolve().then(() => backend.setThreadUrl(resolve(credential), threadId, url))));

  server.registerTool("invite_participant", {
    description: "Invite a participant of the Weave into a thread: a targeted 'your input is wanted here'. Thread creator or Weave keeper only. Idempotent (re-inviting returns the original event's seq). Channel-connected agents are woken by an invite even in mentions-only mode.",
    inputSchema: { credential: cred(hint), threadId: z.string(), participantId: z.string() },
  }, ({ credential, threadId, participantId }) => toToolResult(Promise.resolve().then(() => backend.inviteParticipant(resolve(credential), threadId, participantId))));

  server.registerTool("close_thread", {
    description: "Close a thread (keepers only). Closed threads stay readable; posting is rejected. The General thread cannot be closed.",
    inputSchema: { credential: cred(hint), threadId: z.string() },
  }, ({ credential, threadId }) => toToolResult(Promise.resolve().then(() => backend.closeThread(resolve(credential), threadId))));

  server.registerTool("archive_weave", {
    description: "Archive the Weave (keepers only). It becomes read-only for everyone.",
    inputSchema: { credential: cred(hint), weaveId: z.string() },
  }, ({ credential, weaveId }) => toToolResult(Promise.resolve().then(() => backend.archiveWeave(resolve(credential), weaveId))));

  server.registerTool("set_role", {
    description: "Change a participant's role to member or keeper (keepers only).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), participantId: z.string(), role: z.enum(["member", "keeper"]) },
  }, ({ credential, weaveId, participantId, role }) => toToolResult(Promise.resolve().then(() => backend.setRole(resolve(credential), weaveId, participantId, role))));

  server.registerTool("export_weave", {
    description: "Export the whole Weave transcript as Markdown (format md) or JSON (format json).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), format: z.enum(["md", "json"]).default("md") },
  }, ({ credential, weaveId, format }) => toToolResult(Promise.resolve().then(() => backend.exportWeave(resolve(credential), weaveId, format))));

  const keeper = "Instance keeper token (LOOM_KEEPER_TOKENS / keeper_add).";
  server.registerTool("keeper_list_weaves", { description: "List every Weave on this Loom instance, including archived ones (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperListWeaves(resolve(credential)))));
  server.registerTool("keeper_get_settings", { description: "Read instance settings (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperGetSettings(resolve(credential)))));
  server.registerTool("keeper_set_settings", {
    description: "Update instance settings: instanceName, maxMessageLength, openWeaveCreation (instance keepers only).",
    inputSchema: { credential: cred(keeper), instanceName: z.string().optional(), maxMessageLength: z.number().int().optional(), openWeaveCreation: z.boolean().optional() },
  }, ({ credential, ...patch }) => toToolResult(Promise.resolve().then(() => backend.keeperSetSettings(resolve(credential), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))))));
  server.registerTool("keeper_list", { description: "List instance keepers (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperList(resolve(credential)))));
  server.registerTool("keeper_add", { description: "Add an instance keeper; returns the new keeper and its token (shown once).", inputSchema: { credential: cred(keeper), name: z.string().min(1).max(64) } },
    ({ credential, name }) => toToolResult(Promise.resolve().then(() => backend.keeperAdd(resolve(credential), name))));
  server.registerTool("keeper_remove", { description: "Remove an instance keeper by id (instance keepers only; not yourself).", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(Promise.resolve().then(() => backend.keeperRemove(resolve(credential), id))));

  server.registerTool("keeper_agents_list", { description: "List agent keys (instance keepers only): remote MCP identities that authenticate with ?agent=<key>.", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsList(resolve(credential)))));
  server.registerTool("keeper_agents_add", { description: "Mint an agent key for a remote MCP client (instance keepers only). Returns the agent and its key — shown once.", inputSchema: { credential: cred(keeper), name: z.string().min(1).max(32) } },
    ({ credential, name }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsAdd(resolve(credential), name))));
  server.registerTool("keeper_agents_revoke", { description: "Revoke an agent key (instance keepers only). Its participants and history stay.", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsRevoke(resolve(credential), id))));
}
