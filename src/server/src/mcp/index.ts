import type { Hono } from "hono";
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

export function buildMcpServer(core: Core): McpServer {
  const server = new McpServer({ name: "loom", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  registerLoomTools(server, new CoreToolBackend(core));
  return server;
}

export type MountMcpOptions = {
  /** Test seam: how the shared McpServer connects to the shared transport. Defaults to
   * `server.connect(transport)`. Lets a test control exactly when the one shared connect attempt
   * resolves, to prove every concurrent request waits for it instead of racing ahead. */
  connect?: (server: McpServer, transport: StreamableHTTPTransport) => Promise<void>;
};

export function mountMcp(app: Hono<Env>, core: Core, opts?: MountMcpOptions): void {
  const server = buildMcpServer(core);
  const transport = new StreamableHTTPTransport();
  const doConnect = opts?.connect ?? ((s, t) => s.connect(t));
  // One shared connect attempt, awaited by every request. An `isConnected()` check would let a
  // request that arrives while the first connect is still in flight through on a transport that has
  // not finished starting — and, if two requests raced the check, would call connect() twice (the
  // SDK throws "Already connected"). A failed attempt is cleared so the next request retries.
  let connectPromise: Promise<void> | undefined;
  app.all("/mcp", async (c) => {
    connectPromise ??= doConnect(server, transport).catch((e: unknown) => { connectPromise = undefined; throw e; });
    await connectPromise;
    return transport.handleRequest(c);
  });
}
