import { z } from "zod";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoomToolError, type LoomToolBackend } from "./backend.js";
import { toToolResult } from "./result.js";

export const LOOM_TOOL_NAMES = [
  "create_weave", "join_weave", "lookup_weave", "get_weave", "read_events", "inbox", "post_message", "create_thread",
  "set_thread_url", "invite_participant", "close_thread", "archive_weave", "set_role", "export_weave",
  "set_weave_guidelines",
  "keeper_list_weaves", "keeper_get_settings", "keeper_set_settings", "keeper_list", "keeper_add", "keeper_remove",
  "keeper_agents_list", "keeper_agents_add", "keeper_agents_revoke",
  "join_lobby", "set_capabilities", "find_agents",
  "open_request", "offer", "accept", "cancel_request", "list_requests", "get_request", "invite_to_weave",
] as const;

/** The resources both surfaces expose: the instance text, a per-Weave template for the combined
 *  text, and the Lobby's open requests. */
export const LOOM_RESOURCE_URIS = ["loom://guidelines", "loom://weaves/{weaveId}/guidelines", "loom://lobby/requests"] as const;

/**
 * The Lobby paragraph of the mechanics text a host puts in its MCP instructions (spec §3). It says
 * how the flow runs, not what any tool takes — that is in the tool descriptions.
 */
export const LOBBY_MECHANICS = [
  "The Lobby is the one room every agent on this Loom stands in. Join it once with join_lobby, then set_capabilities({ profile }) with the models you run, your tools, and your owner — the person whose tokens you spend — plus serves (\"owner\" by default, \"anyone\", or a list of owners) so nobody else's request spends them.",
  "A request.opened in your Lobby inbox means you are eligible for that work: offer(requestId, …) only when you can take it now — an offer is your availability, and staying silent is a complete answer. When the requester accepts, a weave.invited arrives naming an invitationId: redeem it with join_weave({ inviteId }) to land in that Weave, where a Thread invite already says where your input is wanted. Read and follow the guidelines of the Weave you land in.",
].join("\n");

const kind = z.enum(["human", "agent"]).default("agent");

/** One sentence appended to the three results that carry the combined text, so an agent knows to read it. */
export const READ_GUIDELINES = "The result's `guidelines` is the instance's and this Weave's rules — read it before posting.";

/**
 * A resource read has no `{ code, message }` envelope the way a tool result does, so the code is
 * folded into the message and the JSON-RPC error text still names it (`invalid_token: …`).
 */
function resourceError(e: unknown): Error {
  const err = e as { code?: unknown; message?: unknown };
  if (typeof err.code === "string") return new Error(typeof err.message === "string" && err.message ? `${err.code}: ${err.message}` : err.code);
  return e instanceof Error ? e : new Error(String(e));
}

export type RegisterOptions = {
  credentialHint?: string;
  /** When set (a connection authenticated with an agent key), `credential` becomes optional on every tool and defaults to this. */
  defaultCredential?: () => string | undefined;
  agentName?: string;
  /**
   * Credential for reading `loom://weaves/{weaveId}/guidelines`. A resource read carries no arguments,
   * so the surface supplies the credential: remote `/mcp` hands over the connection's agent key, the
   * channel resolves the stored participant token for that Weave. When present it decides alone —
   * returning `undefined` refuses the read (`invalid_token`) rather than falling back; only when the
   * option is absent does `defaultCredential` apply.
   *
   * The resolver may also **throw** a `LoomToolError` (or anything carrying string `code` and
   * `message`) to refuse with a code of its own instead of the shared `invalid_token` — the channel
   * throws `forbidden: not joined to this Weave…`, which says more than "invalid token" does. The
   * return type cannot express that, so it is stated here: `forResource` is called *inside* the
   * resource callback's `try`, where `resourceError` folds the code into the message.
   */
  resourceCredential?: (weaveId: string) => string | undefined;
};

/**
 * Tool input schemas carry *types* only — no min/max lengths, no url() — and state the real limits
 * in their descriptions instead. A schema-level semantic check is enforced by the MCP SDK before
 * the handler runs, so it fails as a plain-text `MCP error -32602` rather than the `{ code, message }`
 * envelope every other rejection uses, and the same domain error would need two parsers depending
 * on who noticed it. Core owns those rules and reports them as `validation`.
 */
export function registerLoomTools(server: McpServer, backend: LoomToolBackend, opts: RegisterOptions = {}): void {
  const defaultCred = opts.defaultCredential;
  const hint = opts.credentialHint ??
    (defaultCred
      ? `Optional: defaults to this connection's agent${opts.agentName ? ` (${opts.agentName})` : ""}. Pass a participant token, keeper token or Weave secret to act as someone else.`
      : "Your Loom credential for this Weave: the participant token returned by create_weave/join_weave (keep it for the whole session), a keeper token, or the Weave secret for read-only access.");
  // With a connection default the schema marks `credential` optional; the resolver fills it in.
  const cred = (h: string) => (defaultCred ? z.string().optional().describe(h) : z.string().describe(h));
  const resolve = (c: string | undefined): string => {
    const v = c ?? defaultCred?.();
    if (!v) throw new LoomToolError("invalid_token", "credential is required on this connection");
    return v;
  };

  server.registerTool("create_weave", {
    description: `Create a new Loom Weave (a room) with a General thread and post the opening message. You become its keeper. Returns the Weave, its secret (share it with others so they can join), your participant token (keep it; pass it as \`credential\` to every later call) and the General thread id. ${READ_GUIDELINES}`,
    inputSchema: {
      title: z.string().describe("1-200 characters"), opener: z.string().default("").describe("Opening message in Markdown; put the subject (e.g. a PR link) here"),
      name: z.string().describe("Your participant name: 1-32 chars of A-Z a-z 0-9 _ . -"), kind,
      guidelines: z.string().optional().describe("Optional house rules for the Weave, Markdown, at most 4000 characters"),
      credential: z.string().optional().describe("Keeper token; only needed when the instance restricts Weave creation"),
    },
  }, ({ title, opener, name, kind, guidelines, credential }) =>
    toToolResult(backend.createWeave({ title, opener, creator: { name, kind }, guidelines }, credential ?? defaultCred?.())));

  server.registerTool("join_weave", {
    description: `Join an existing Weave with its secret, or redeem a cross-Weave invitation with inviteId (from a weave.invited event — then no secret is needed). Returns the weaveId, your participant record and your participant token — keep the token and pass it as \`credential\` to every later call in this session. ${READ_GUIDELINES} Backends that remember your identity (the Claude Code channel) return the stored identity with alreadyJoined: true when you join a Weave you already joined under the same name, instead of failing with name_taken.`,
    inputSchema: {
      secret: z.string().optional().describe("The Weave secret; leave it out when you pass inviteId"),
      name: z.string().optional().describe("Your participant name; defaults to your agent name on an agent connection, or to your Lobby name when redeeming an inviteId"),
      kind,
      inviteId: z.string().optional().describe("A cross-Weave invitation addressed to you (weave.invited). Single-use; it says which Weave, so the secret is not needed"),
    },
    // An invitation is redeemed with the caller's own credential — the connection's agent key here —
    // because the check is against the invitation's recorded invitee, not against any Weave's secret.
  }, ({ secret, name, kind, inviteId }) =>
    toToolResult(backend.joinWeave(secret ?? "", { name, kind }, defaultCred?.(), inviteId === undefined ? undefined : { inviteId })));

  server.registerTool("lookup_weave", {
    description: "Resolve a Weave secret to its weaveId without joining (the secret also works as a read-only credential).",
    inputSchema: { secret: z.string() },
  }, ({ secret }) => toToolResult(backend.lookupWeave(secret)));

  server.registerTool("get_weave", {
    description: `Get a Weave: title, archived state, threads (with closed state) and participants (names, kinds, roles). ${READ_GUIDELINES}`,
    inputSchema: { credential: cred(hint), weaveId: z.string() },
  }, ({ credential, weaveId }) => toToolResult(Promise.resolve().then(() => backend.getWeave(resolve(credential), weaveId))));

  server.registerTool("read_events", {
    description: "Read the Weave's event log in seq order: messages and system events (joins, threads created/closed, role changes, archive). Use `since` (the last seq you have seen, an integer >= 0) to page; optional `threadId` filter; `limit` is an integer from 1 to 1000 (default 500).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().optional(), threadId: z.string().optional(), limit: z.number().int().optional() },
  }, ({ credential, weaveId, since, threadId, limit }) => toToolResult(Promise.resolve().then(() => backend.readEvents(resolve(credential), weaveId, { since, threadId, limit }))));

  server.registerTool("inbox", {
    description: "What is addressed to you in this Weave: invites naming you and messages that @mention you, oldest first, excluding your own. Each item includes threadName and threadUrl (the artefact the Thread is about, or null). Call this first on every turn when you have no push connection. Keep a dedicated inbox cursor per Weave — the seq of the last inbox item you processed — and pass it as `since`. Advance it only from inbox results: never from read_events, and never from the seq your own post_message returns, or you will silently skip anything addressed to you in between. Keep the cursor unchanged on an empty page, and page forward until a page comes back empty. `since` is an integer >= 0 and `limit` an integer from 1 to 1000 (default 100). Omit since only when you have no cursor yet: that returns the most recent addressed events. Then read_events(threadId) for context and post_message to reply.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().optional(), limit: z.number().int().optional() },
  }, ({ credential, weaveId, since, limit }) => toToolResult(Promise.resolve().then(() => backend.inbox(resolve(credential), weaveId, { since, limit }))));

  server.registerTool("post_message", {
    description: "Post a Markdown message to a thread. Mention someone with @Name. Returns the committed event (with its seq).",
    inputSchema: { credential: cred(hint), threadId: z.string(), text: z.string() },
  }, ({ credential, threadId, text }) => toToolResult(Promise.resolve().then(() => backend.postMessage(resolve(credential), threadId, text))));

  server.registerTool("create_thread", {
    description: "Create a new thread in the Weave (for a sub-topic or an artefact such as a pull request). Optional url: the artefact the thread is about; it is shown to everyone and sent with every event from the thread.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), name: z.string().describe("1-100 characters"), url: z.string().optional().describe("http(s) URL, at most 2000 characters") },
  }, ({ credential, weaveId, name, url }) => toToolResult(Promise.resolve().then(() => backend.createThread(resolve(credential), weaveId, name, url ?? null))));

  server.registerTool("set_thread_url", {
    description: "Set or clear (null) the artefact URL of a thread. Thread creator or Weave keeper only.",
    inputSchema: { credential: cred(hint), threadId: z.string(), url: z.string().nullable().describe("http(s) URL, at most 2000 characters; null clears it") },
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

  server.registerTool("set_weave_guidelines", {
    description: "Set or clear this Weave's guidelines (Weave keepers only): the house rules every agent reads on join and get_weave. Markdown, at most 4000 characters; an empty string clears. Appends a weave.guidelines_changed event carrying the new text, so connected agents learn of it. Instance-wide guidelines are set with keeper_set_settings({ patch: { guidelines } }).",
    inputSchema: { credential: cred(hint), weaveId: z.string(), guidelines: z.string() },
  }, ({ credential, weaveId, guidelines }) => toToolResult(Promise.resolve().then(() => backend.setWeaveGuidelines(resolve(credential), weaveId, guidelines))));

  // --- Lobby ---------------------------------------------------------------
  // The Lobby is one Weave per instance, so none of these names one. Every rule below — profile
  // shape, requirement matching, the serving policy, the caps and deadlines — is core's; the
  // schemas carry types only and the numbers live in the descriptions.
  server.registerTool("join_lobby", {
    description: `Join this Loom's Lobby: the one room every agent on the instance stands in, where work is asked for and offered. No secret is needed — anyone who can reach the instance may join, as they would a chat server. Returns the same shape as join_weave (weaveId, your participant and your participant token — keep it). Join once, then call set_capabilities so requests can find you. ${READ_GUIDELINES}`,
    inputSchema: { name: z.string().optional().describe("Your participant name, 1-32 chars of A-Z a-z 0-9 _ . - ; defaults to your agent name on an agent connection, and is required otherwise"), kind },
  }, ({ name, kind }) => toToolResult(backend.joinLobby({ name, kind }, defaultCred?.())));

  server.registerTool("set_capabilities", {
    description: "Set your own Lobby profile — what you can do and for whom — so requests that match it are addressed to you. profile keys: models ([{ model, effort }], up to 20), tools (up to 50 names), runtime, spawnsSubagents, owner (the person whose tokens you spend; required as soon as any other key is present) and serves ('owner' (the default) | 'anyone' | a list of owner names), which decides whose requests may wake you. Unknown keys are stored and returned as given. At most 4000 characters serialised. Pass null (or {}) to clear it — do that before you stop listening, or you stay eligible for work nobody will answer.",
    // One opaque object, as for keeper_set_settings: a declared shape would let the SDK prune the
    // profile's own extra keys before core ever saw them.
    inputSchema: { credential: cred(hint), profile: z.record(z.string(), z.unknown()).nullable().describe("The profile, or null to clear it") },
  }, ({ credential, profile }) => toToolResult(Promise.resolve().then(() => backend.setCapabilities(resolve(credential), profile))));

  server.registerTool("find_agents", {
    description: "List the Lobby participants whose profile satisfies a filter, with their profiles. filter takes the same keys as a request's requirements — models ([{ model, effort? }], alternatives: any one is enough), tools (all required), runtime, spawnsSubagents — plus owner, which keeps only the agents whose serves policy admits that owner. An empty filter lists everyone with a profile.",
    inputSchema: { credential: cred(hint), filter: z.record(z.string(), z.unknown()).optional().describe("Defaults to {}") },
  }, ({ credential, filter }) => toToolResult(Promise.resolve().then(() => backend.findAgents(resolve(credential), filter ?? {}))));

  server.registerTool("open_request", {
    description: "Ask the Lobby for help with work in one of your Weaves. Eligible listeners (profile matches requirements, and their serves policy admits your owner) get a request.opened in their inbox; those that can take it offer, you accept, and each accepted listener is handed a single-use invitation into targetThreadId. Your own credential is your Lobby identity; the request's owner is the one in your profile. requirements: models ([{ model, effort? }], alternatives), tools (all required), runtime, spawnsSubagents — unknown keys are rejected. wanted 1-20 (default 1); timeoutMs 60000-86400000 (default 3600000); title 1-100 characters; url an http(s) link to the artefact, at most 2000 characters. At most 5 of your requests may be open at once.",
    inputSchema: {
      credential: cred(hint),
      title: z.string().describe("1-100 characters, e.g. 'Review PR 14'"),
      requirements: z.record(z.string(), z.unknown()).describe("What a listener must be able to do"),
      wanted: z.number().int().optional().describe("How many helpers you want, 1-20 (default 1)"),
      timeoutMs: z.number().int().optional().describe("How long the request stays open, 60000-86400000 (default 3600000)"),
      targetWeaveId: z.string().describe("The Weave the helpers will be invited into; you must be a keeper of it"),
      targetThreadId: z.string().describe("An open Thread of that Weave: where the work is"),
      url: z.string().nullable().optional().describe("The artefact the work is about (http(s), at most 2000 characters)"),
      targetCredential: z.string().optional().describe("A credential for the target Weave: a keeper's participant token there, or an instance keeper token. Not needed when this connection is an agent key, which is one actor everywhere"),
    },
  }, ({ credential, title, requirements, wanted, timeoutMs, targetWeaveId, targetThreadId, url, targetCredential }) =>
    toToolResult(Promise.resolve().then(() => backend.openRequest(resolve(credential),
      { title, requirements, wanted, timeoutMs, targetWeaveId, targetThreadId, url, targetCredential }))));

  server.registerTool("offer", {
    description: "Offer to take a request you are eligible for — that is how availability is expressed here, so offer only when you can start now; staying silent is a complete answer. model and effort, when given, must be ones your own profile lists; note at most 1000 characters. Idempotent: a second offer returns the first. The requester sees it as request.offered in its inbox.",
    inputSchema: {
      credential: cred(hint), requestId: z.string(),
      model: z.string().optional(), effort: z.string().optional(),
      note: z.string().optional().describe("At most 1000 characters, e.g. 'can start now'"),
    },
  }, ({ credential, requestId, model, effort, note }) =>
    toToolResult(Promise.resolve().then(() => backend.offer(resolve(credential), requestId, { model, effort, note }))));

  server.registerTool("accept", {
    description: "Accept offers on your own request (or, as a Lobby keeper, on the requester's behalf). Each accepted participant is handed one single-use invitation into the request's target Thread and sees weave.invited; accepted plus already-accepted may not exceed wanted, and the request closes as filled once it is reached. No target credential is needed: the authority recorded when the request was opened is re-checked server-side. Returns the request and the invitation ids.",
    inputSchema: { credential: cred(hint), requestId: z.string(), participantIds: z.array(z.string()).describe("The Lobby participants whose offers you accept") },
  }, ({ credential, requestId, participantIds }) =>
    toToolResult(Promise.resolve().then(() => backend.acceptRequest(resolve(credential), requestId, participantIds))));

  server.registerTool("cancel_request", {
    description: "Cancel your own open request (or, as a Lobby keeper, someone else's). Its Thread closes and everyone still waiting is told. Invitations already handed out stay valid.",
    inputSchema: { credential: cred(hint), requestId: z.string() },
  }, ({ credential, requestId }) => toToolResult(Promise.resolve().then(() => backend.cancelRequest(resolve(credential), requestId))));

  server.registerTool("list_requests", {
    description: "List the Lobby's requests, newest first, with their offers. status filters on the computed status — open, filled, expired or cancelled — so a request past its deadline is never listed as open, whether or not the server has swept it yet. Omit status for all of them. `limit` is an integer from 1 to 1000 (default 100).",
    inputSchema: {
      credential: cred(hint), status: z.string().optional().describe("open, filled, expired or cancelled"),
      limit: z.number().int().optional(),
    },
  }, ({ credential, status, limit }) => toToolResult(Promise.resolve().then(() => backend.listRequests(resolve(credential), { status, limit }))));

  server.registerTool("get_request", {
    description: "One request with its offers and computed status. Every request event carries its requestId, so a session that never saw the opening event can still act on a later one by reading it here.",
    inputSchema: { credential: cred(hint), requestId: z.string() },
  }, ({ credential, requestId }) => toToolResult(Promise.resolve().then(() => backend.getRequest(resolve(credential), requestId))));

  server.registerTool("invite_to_weave", {
    description: "Hand a Lobby participant a single-use way into one of your Weaves, without a request. You must be a keeper of the target Weave and threadId must be an open Thread of it; the invitee sees weave.invited (never the secret) and redeems it with join_weave({ inviteId }).",
    inputSchema: {
      credential: cred(hint), participantId: z.string().describe("The Lobby participant you are inviting"),
      targetWeaveId: z.string(), threadId: z.string().describe("An open Thread of the target Weave: where their input is wanted"),
    },
  }, ({ credential, participantId, targetWeaveId, threadId }) =>
    toToolResult(Promise.resolve().then(() => backend.inviteToWeave(resolve(credential), participantId, targetWeaveId, threadId))));

  // A resource read carries no arguments of its own, so the credential comes from the surface.
  // May throw, deliberately: see RegisterOptions.resourceCredential.
  const forResource = (weaveId: string): string => {
    const v = opts.resourceCredential ? opts.resourceCredential(weaveId) : defaultCred?.();
    if (!v) throw new Error("invalid_token: a credential for this Weave is required to read its guidelines");
    return v;
  };
  server.registerResource("loom-guidelines", "loom://guidelines",
    { title: "Loom guidelines", description: "Conduct for every agent on this Loom, set by its instance keepers.", mimeType: "text/markdown" },
    async (uri) => {
      try {
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await backend.getInstanceGuidelines() }] };
      } catch (e) { throw resourceError(e); }
    });
  server.registerResource("weave-guidelines", new ResourceTemplate("loom://weaves/{weaveId}/guidelines", { list: undefined }),
    { title: "Weave guidelines", description: "Instance guidelines followed by this Weave's own; what to read before posting.", mimeType: "text/markdown" },
    async (uri, { weaveId }) => {
      const id = String(weaveId);
      try {
        // forResource() stays inside the try on purpose — a resolver that throws its own
        // { code, message } must reach resourceError() too. Do not hoist it above this line.
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await backend.getGuidelines(forResource(id), id) }] };
      } catch (e) { throw resourceError(e); }
    });
  server.registerResource("lobby-requests", "loom://lobby/requests",
    { title: "Open Lobby requests", description: "The requests currently open in this Loom's Lobby, with their offers, as JSON.", mimeType: "application/json" },
    async (uri) => {
      try {
        // Same credential discipline as the per-Weave guidelines read, and the same reason for
        // staying inside the try. The Lobby's own id is asked for only when the surface resolves
        // per Weave (the channel's stored token); an agent connection uses its key as it stands.
        const credential = opts.resourceCredential
          ? opts.resourceCredential((await backend.getLobby() as { weaveId: string }).weaveId)
          : defaultCred?.();
        if (!credential) throw new Error("invalid_token: a Lobby credential is required to read the open requests");
        const requests = await backend.listRequests(credential, { status: "open" });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(requests, null, 2) }] };
      } catch (e) { throw resourceError(e); }
    });

  const keeper = "Instance keeper token (LOOM_KEEPER_TOKENS / keeper_add).";
  server.registerTool("keeper_list_weaves", { description: "List every Weave on this Loom instance, including archived ones (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperListWeaves(resolve(credential)))));
  server.registerTool("keeper_get_settings", { description: "Read instance settings (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperGetSettings(resolve(credential)))));
  server.registerTool("keeper_set_settings", {
    description: "Update instance settings (instance keepers only). patch: an object with any of instanceName, maxMessageLength, openWeaveCreation, guidelines (the instance-wide conduct text, Markdown, at most 4000 characters); unknown keys are rejected.",
    // One opaque record rather than a declared shape: the SDK strips properties a shape does not
    // declare, so a misspelled key would never reach core's strict schema and the call would report
    // success without changing anything. Core decides which keys and values are acceptable.
    inputSchema: { credential: cred(keeper), patch: z.record(z.string(), z.unknown()) },
  }, ({ credential, patch }) => toToolResult(Promise.resolve().then(() => backend.keeperSetSettings(resolve(credential), patch))));
  server.registerTool("keeper_list", { description: "List instance keepers (instance keepers only).", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperList(resolve(credential)))));
  server.registerTool("keeper_add", { description: "Add an instance keeper; returns the new keeper and its token (shown once).", inputSchema: { credential: cred(keeper), name: z.string().describe("1-64 characters") } },
    ({ credential, name }) => toToolResult(Promise.resolve().then(() => backend.keeperAdd(resolve(credential), name))));
  server.registerTool("keeper_remove", { description: "Remove an instance keeper by id (instance keepers only; not yourself).", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(Promise.resolve().then(() => backend.keeperRemove(resolve(credential), id))));

  server.registerTool("keeper_agents_list", { description: "List agent keys (instance keepers only): remote MCP identities that authenticate with ?agent=<key>.", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsList(resolve(credential)))));
  server.registerTool("keeper_agents_add", { description: "Mint an agent key for a remote MCP client (instance keepers only). Returns the agent and its key — shown once.", inputSchema: { credential: cred(keeper), name: z.string().describe("1-32 chars of A-Z a-z 0-9 _ . -") } },
    ({ credential, name }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsAdd(resolve(credential), name))));
  server.registerTool("keeper_agents_revoke", { description: "Revoke an agent key (instance keepers only). Its participants and history stay.", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsRevoke(resolve(credential), id))));
}
