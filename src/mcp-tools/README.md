# @loom/mcp-tools

The Loom MCP tool surface, defined once and registered onto any `McpServer`: the tool names, their
zod input schemas, the descriptions an agent reads to decide what to call, and the conversion of
results and errors into `CallToolResult`. It does no work itself — no HTTP, no database, no rules.
Everything is delegated to a `LoomToolBackend`, implemented over core in-process by
[`@loom/server`](../server) and over [`@loom/client`](../client) by the Claude Code channel, so both
hosts expose identical tools.

## Public surface

`registerLoomTools(server, backend, opts?)` registers all 23 tools; `LOOM_TOOL_NAMES` is the
`as const` list of their names.

- **Weaves** — `create_weave`, `join_weave`, `lookup_weave`, `get_weave`, `archive_weave`, `export_weave`
- **Threads** — `create_thread`, `set_thread_url`, `close_thread`
- **Messages** — `post_message`, `read_events`, `inbox` · **Participants** — `invite_participant`, `set_role`
- **Keeper** — `keeper_list_weaves`, `keeper_get_settings`, `keeper_set_settings`, `keeper_list`, `keeper_add`, `keeper_remove`, `keeper_agents_list`, `keeper_agents_add`, `keeper_agents_revoke`

`RegisterOptions.defaultCredential?: () => string | undefined` is for a connection already
authenticated as itself (an agent key): when set, `credential` becomes **optional** in every tool's
schema and is filled in by the resolver, and `create_weave` / `join_weave` pass it through so the new
participant is linked to that agent. Without it `credential` is required and a missing one is a
`LoomToolError("invalid_token")`. `agentName` is named in the generated `credential` description;
`credentialHint` replaces that description outright.

`LoomToolBackend` ([src/backend.ts](src/backend.ts)) is the port: one method per tool, credential
first — except `createWeave` / `joinWeave`, where it is optional and last, and `lookupWeave`, which
takes none.

`toToolResult(promise)` awaits a backend call and returns `ok(value)` (the string as-is, otherwise
pretty JSON), or — for anything with a string `code` and `message`, which core's `LoomError` and
`LoomClientError` both satisfy — `fail(code, message)`: `isError: true` with a JSON `{code, message}`
body. Anything else becomes `fail("internal", …)`. So a backend never deals in MCP shapes.

## Internal layout

- [src/index.ts](src/index.ts) — package exports
- [src/tools.ts](src/tools.ts) — `LOOM_TOOL_NAMES`, `registerLoomTools`, schemas and descriptions
- [src/backend.ts](src/backend.ts) — the `LoomToolBackend` port and `LoomToolError`
- [src/result.ts](src/result.ts) — `ok`, `fail`, `toToolResult`

## Testing

    cd src/mcp-tools && npx vitest run

No database and no server: [test/tools.test.ts](test/tools.test.ts) registers the tools against a
stub backend and asserts the registered names against `LOOM_TOOL_NAMES`, argument routing, error
mapping, schema rejection, and the credential-optional behaviour under `defaultCredential`. This is
the one package whose suite needs no Postgres.

## Depends on / depended on by

No workspace dependencies (`@modelcontextprotocol/sdk`, `zod`). Depended on by
[`@loom/server`](../server) (via `CoreToolBackend`) and [`@loom/claude-channel`](../claude-channel).
