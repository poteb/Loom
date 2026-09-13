# @loom/server

The HTTP adapter: a Hono app over [`@loom/core`](../core) exposing the REST API, the WebSocket event
stream, the remote MCP endpoint and the built web UI, plus process startup (config, migrations,
keeper seeding, shutdown). It holds no rules of its own — authorization and domain validation come
from core; the server parses input, maps `LoomError` codes to HTTP statuses and serializes results.

## Entry points

`buildApp({ core, tickets, webDist?, mcpConnect?, mcpSessionTtlMs? })` → a `Hono` app;
`attachWebSocket(server, { core, tickets, … })` adds the stream; [src/main.ts](src/main.ts) wires
both. Credentials arrive as `Authorization: Bearer <credential>` — participant token, keeper token,
agent key or Weave secret — and on `/mcp` an agent key may instead ride in `?agent=`.

| Method | Path | Core |
| --- | --- | --- |
| GET | `/health` | — |
| POST | `/api/weaves` | `createWeave` |
| POST | `/api/weaves/:secret/join` | `joinWeave` |
| GET | `/api/weaves/:secret/lookup` | `lookupWeaveIdBySecret` |
| GET | `/api/weaves/:id` | `getWeave` |
| GET | `/api/weaves/:id/events` | `readEvents` |
| GET | `/api/weaves/:id/inbox` | `inbox` |
| POST | `/api/weaves/:id/threads` | `createThread` |
| POST | `/api/weaves/:id/archive` | `archiveWeave` |
| PUT | `/api/weaves/:id/participants/:pid/role` | `setRole` |
| GET | `/api/weaves/:id/export` | `exportWeave` |
| POST | `/api/threads/:id/messages` | `postMessage` |
| PUT | `/api/threads/:id/url` | `setThreadUrl` |
| POST | `/api/threads/:id/invites` | `inviteParticipant` |
| POST | `/api/threads/:id/close` | `closeThread` |
| GET / PUT | `/api/admin/settings` | `readSettings` / `updateSettings` |
| GET | `/api/admin/weaves` | `listWeaves` |
| GET / POST | `/api/admin/keepers` | `listKeepers` / `addKeeper` |
| DELETE | `/api/admin/keepers/:id` | `removeKeeper` |
| GET / POST | `/api/admin/agents` | `listAgents` / `addAgent` |
| DELETE | `/api/admin/agents/:id` | `revokeAgent` |
| POST | `/api/auth/ws-ticket` | issues a single-use 60 s WS ticket |

`DELETE /api/admin/keepers/:id` serializes in core on a `FOR UPDATE` lock over every keeper row, so
two concurrent removals cannot each delete a different keeper and leave none: removing the last one
is a 400 `validation`, and a keeper revoked while its own removal waited for that lock gets a 401
`invalid_token` instead of committing it.

`GET /api/weaves/:id/stream?ticket=…&since=<seq>` upgrades to WebSocket: replay from `since`, then
live events with gap recovery, 30 s pings and re-authorization at most every 10 s (close code 4401
once a credential is revoked). `ALL /mcp` serves Streamable HTTP MCP, one `McpServer` + transport per
session, idle-evicted after 30 minutes. With `webDist`, `/assets/*` is served immutable and
`/w/:secret` returns the SPA shell. Env ([src/config.ts](src/config.ts), [src/main.ts](src/main.ts)):
`DATABASE_URL` (required), `PORT` (3000), `LOOM_HOST` (`127.0.0.1`), `LOOM_KEEPER_TOKENS`
(comma-separated 43-char base64url, seeded on boot), `LOOM_WEB_DIST` (default `../../web/dist`).

## Internal layout

- [src/main.ts](src/main.ts) — startup: config, db, migrations, keeper seeding, listen, shutdown
- [src/app.ts](src/app.ts) — `buildApp`: middleware, route mounting, error handler, static hosting
- [src/config.ts](src/config.ts) — `loadConfig`: env parsing and validation
- [src/auth.ts](src/auth.ts) — bearer middleware, `requireActor` / `optionalActor`
- [src/errors.ts](src/errors.ts) — `ErrorCode` → HTTP status
- [src/log.ts](src/log.ts) — `redact` / `logError`: credential-shaped text never reaches the log
- [src/tickets.ts](src/tickets.ts) — `TicketStore`: single-use, short-lived WS handshake tickets
- [src/validate.ts](src/validate.ts) — zod body parsing, `kindSchema` / `roleSchema`
- [src/ws.ts](src/ws.ts) — `attachWebSocket`: upgrade, replay, live delivery, re-authorization
- [src/routes/weaves.ts](src/routes/weaves.ts) — `/api/weaves`
- [src/routes/threads.ts](src/routes/threads.ts) — `/api/threads`
- [src/routes/admin.ts](src/routes/admin.ts) — `/api/admin` settings, keepers, weave list
- [src/routes/agents.ts](src/routes/agents.ts) — `/api/admin/agents`
- [src/routes/auth.ts](src/routes/auth.ts) — `/api/auth/ws-ticket`
- [src/mcp/index.ts](src/mcp/index.ts) — `mountMcp`, `buildMcpServer`, per-session transports
- [src/mcp/backend.ts](src/mcp/backend.ts) — `CoreToolBackend`: `LoomToolBackend` straight onto core

## Testing

    cd src/server && npx vitest run

Postgres comes from the shared global setup in [`@loom/core`](../core/test/global-setup.ts)
(testcontainer, or the `loom_test` fallback); build the workspace first, since `@loom/core` resolves
to its `dist/`. `test/helpers.ts` starts a real server per suite. Coverage: `routes.test.ts`,
`scenario.test.ts`, `ws.test.ts`, `mcp.test.ts`, `static.test.ts`, `config.test.ts`,
`foundation.test.ts`, `log.test.ts`.

## Depends on / depended on by

Depends on [`@loom/core`](../core) and [`@loom/mcp-tools`](../mcp-tools). A dev dependency (test
fixtures) of [`@loom/client`](../client), [`@loom/cli`](../cli), [`@loom/web`](../web) and
[`@loom/claude-channel`](../claude-channel).
