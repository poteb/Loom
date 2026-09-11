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

export function mountMcp(app: Hono<Env>, core: Core): void {
  const server = buildMcpServer(core);
  const transport = new StreamableHTTPTransport();
  app.all("/mcp", async (c) => {
    if (!server.isConnected()) await server.connect(transport);
    return transport.handleRequest(c);
  });
}
