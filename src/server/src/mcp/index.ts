import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { registerLoomTools } from "@loom/mcp-tools";
import type { Core } from "@loom/core";
import type { Env } from "../auth.js";
import { CoreToolBackend } from "./backend.js";

export const MCP_INSTRUCTIONS = [
  "Loom is a chat platform where humans and AI agents collaborate in Weaves (rooms) with Threads.",
  "Start by calling join_weave with the secret you were given (or create_weave). Keep the returned participant token and pass it as `credential` to every other tool for the rest of the session.",
  "Read with read_events (page with `since` = last seq you saw); post with post_message; mention people with @Name. The Weave secret alone grants read-only access.",
].join("\n");

/** `agent` is the connection's own agent key (from `Authorization: Bearer` or `?agent=`): it becomes
 * every tool's default credential, so a connector that can only be given a URL still acts as itself. */
export function buildMcpServer(core: Core, agent?: { credential: string; name: string }): McpServer {
  const instructions = agent
    ? `${MCP_INSTRUCTIONS}
You are connected as agent ${agent.name}: every tool's credential defaults to you. Start each turn with inbox(weaveId, since = last seq you saw) to find invites and mentions addressed to you; a thread's url is the artefact it is about (for example a pull request) — fetch it for details. join_weave a Weave once; joining again returns your existing identity.`
    : MCP_INSTRUCTIONS;
  const server = new McpServer({ name: "loom", version: "0.2.0" }, { instructions });
  registerLoomTools(server, new CoreToolBackend(core), agent ? { defaultCredential: () => agent.credential, agentName: agent.name } : {});
  return server;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export type MountMcpOptions = {
  /** Test seam: how a session's McpServer connects to its transport. Defaults to
   * `server.connect(transport)`. Lets a test control exactly when a connect attempt resolves, to
   * prove concurrent requests that share a session wait for that session's own attempt without
   * racing ahead, and that a brand-new session gets its own independent attempt. */
  connect?: (server: McpServer, transport: StreamableHTTPTransport) => Promise<void>;
  /** How long (ms) a session may sit idle before it is evicted. Defaults to 30 minutes. Injectable
   * so tests can exercise eviction without waiting half an hour. */
  sessionTtlMs?: number;
};

type McpSession = { server: McpServer; transport: StreamableHTTPTransport; lastSeen: number };

export function mountMcp(app: Hono<Env>, core: Core, opts?: MountMcpOptions): { closeIdle: () => void } {
  const doConnect = opts?.connect ?? ((s, t) => s.connect(t));
  const ttlMs = opts?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  // One McpServer + one StreamableHTTPTransport per MCP session, keyed by the session id the
  // transport itself assigns on `initialize`. A single shared transport correlates responses by
  // JSON-RPC message id alone, so two independent clients whose first requests both use id 0 in the
  // same tick collide (one hangs) — per-session isolation removes the shared map entirely.
  const sessions = new Map<string, McpSession>();

  function evictIdle(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > ttlMs) {
        sessions.delete(id);
        void session.server.close();
      }
    }
  }
  const evictionTimer = setInterval(evictIdle, Math.max(10, Math.min(ttlMs, 60_000)));
  evictionTimer.unref();

  app.all("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (!session) return c.json({ code: "not_found", message: "Unknown MCP session" }, 404);
      session.lastSeen = Date.now();
      return session.transport.handleRequest(c);
    }

    // No session id: this must be a fresh session's `initialize` request (the transport itself
    // rejects anything else sent without one). Build a brand-new server + transport and connect
    // them before handling the request — that's this session's own, independent connect attempt.
    // An agent key on the connection (Bearer, or ?agent= for connectors that only take a URL)
    // becomes this session's default credential. Only the *name* is cached here: revocation needs
    // no session bookkeeping, because every tool call re-resolves the key in CoreToolBackend.
    const credential = c.get("credential");
    let agent: { credential: string; name: string } | undefined;
    if (credential) {
      const actor = await core.resolveCredential(credential);   // throws invalid_token → 401 via onError
      if (actor.kind === "agent") agent = { credential, name: actor.agent.name };
    }
    const server = buildMcpServer(core, agent);
    let session: McpSession;
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.lastSeen = Date.now();
        sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        void session.server.close();
      },
    });
    session = { server, transport, lastSeen: Date.now() };
    await doConnect(server, transport);
    return transport.handleRequest(c);
  });

  return { closeIdle: () => clearInterval(evictionTimer) };
}
