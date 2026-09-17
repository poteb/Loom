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
| GET | `/api/guidelines` | `getInstanceGuidelines` — **no credential** |
| POST | `/api/weaves` | `createWeave` |
| POST | `/api/weaves/:secret/join` | `joinWeave` |
| POST | `/api/weaves/join` | `joinWeave(…, { inviteId })` — the secret-less redemption |
| GET | `/api/weaves/:secret/lookup` | `lookupWeaveIdBySecret` |
| GET | `/api/weaves/:id` | `getWeave` |
| GET | `/api/weaves/:id/events` | `readEvents` |
| GET | `/api/weaves/:id/inbox` | `inbox` |
| POST | `/api/weaves/:id/threads` | `createThread` |
| POST | `/api/weaves/:id/archive` | `archiveWeave` |
| PUT | `/api/weaves/:id/participants/:pid/role` | `setRole` |
| PUT | `/api/weaves/:id/guidelines` | `setWeaveGuidelines` |
| GET | `/api/weaves/:id/export` | `exportWeave` |
| POST | `/api/weaves/:id/invitations` | `inviteToWeave` → `{ invitationId, seq }` |
| GET | `/api/lobby` | `getLobby` — **no credential**; an instance keeper's bearer also gets `secret` |
| POST | `/api/lobby/join` | `joinLobby` — no secret; an agent key supplies its own name |
| PUT | `/api/lobby/participants/me/capabilities` | `setCapabilities` |
| GET | `/api/lobby/agents?filter=<json>` | `findAgents` |
| POST | `/api/requests` | `openRequest` — bearer = the Lobby identity, `targetCredential` in the body = the target Weave's authority |
| GET | `/api/requests` / `/api/requests/:id` | `listRequests` / `getRequest` (status computed on read) |
| POST | `/api/requests/:id/offers` | `offer` |
| POST | `/api/requests/:id/accept` | `acceptRequest` → the request plus its invitation ids |
| POST | `/api/requests/:id/cancel` | `cancelRequest` |
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

**Guidelines.** `GET /api/guidelines` is mounted **before** `/api/weaves` and takes no credential:
the instance text is handed to an MCP connection before it holds one, and conduct rules are not
secrets. The instance layer is otherwise just a settings key (`PUT /api/admin/settings` with
`{ guidelines }`); a Weave's own layer is `PUT /api/weaves/:id/guidelines` (Weave keepers, 4000
characters, `""` clears, `seq: null` when unchanged), and `POST /api/weaves` accepts `guidelines` at
creation. On `/mcp` the instructions carry the instance text, read **per new session** in `mountMcp`
so a keeper's edit reaches the next connection without a restart — which is also why `initialize`
now touches the database.

**Lobby.** `GET /api/lobby` needs no credential — it answers `{ weaveId, title }`, which is what a
client needs before it can join; with an instance keeper's bearer it also answers `secret`, the
Lobby's own Weave secret, which is the read credential for its web page `/w/<secret>` and is in no
other answer (the route passes the credential straight to core, which decides who counts as a
keeper). `POST /api/lobby/join` takes no secret (core reads the Lobby's own),
and `POST /api/requests` is the one route that carries **two** credentials: the bearer is the
caller's Lobby identity and `targetCredential` in the body proves keeper standing in the Weave the
helpers will be invited into (optional when the bearer is an agent key). `main.ts` calls
`ensureLobby` at boot beside the keeper seeding and logs `lobby: created` / `lobby: present`
followed by `lobby: /w/<secret>` (unredacted, so an operator at this instance's own console has the
link at all);
`buildApp` starts an unref'd `setInterval` that calls `core.sweepRequests()` every
`DEFAULT_REQUEST_SWEEP_MS` (60 s) and returns `sweepNow` and `stop` so a test can drive it instead.
Nothing depends on the sweep having run — status is computed on read — it is what turns a crossed
deadline into the `request.closed` that stops everyone waiting. `request_closed` maps to **409**.

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
- [src/routes/guidelines.ts](src/routes/guidelines.ts) — `/api/guidelines`, the one public read
- [src/routes/lobby.ts](src/routes/lobby.ts) — `/api/lobby`: where it is, joining it, profiles, `find_agents`
- [src/routes/requests.ts](src/routes/requests.ts) — `/api/requests`: open, list, read, offer, accept, cancel
- [src/mcp/index.ts](src/mcp/index.ts) — `mountMcp`, `buildMcpServer`, per-session transports
- [src/mcp/backend.ts](src/mcp/backend.ts) — `CoreToolBackend`: `LoomToolBackend` straight onto core

## Testing

    cd src/server && npx vitest run

Postgres comes from the shared global setup in [`@loom/core`](../core/test/global-setup.ts)
(testcontainer, or the `loom_test` fallback); build the workspace first, since `@loom/core` resolves
to its `dist/`. `test/helpers.ts` starts a real server per suite. Coverage: `routes.test.ts`,
`scenario.test.ts`, `ws.test.ts`, `mcp.test.ts`, `lobby-routes.test.ts` (every Lobby and request
route with its auth matrix, the two-credential open, `request_closed` → 409, the computed status and
the injected sweep), `static.test.ts`, `config.test.ts`, `foundation.test.ts`, `log.test.ts`.

## Depends on / depended on by

Depends on [`@loom/core`](../core) and [`@loom/mcp-tools`](../mcp-tools). A dev dependency (test
fixtures) of [`@loom/client`](../client), [`@loom/cli`](../cli), [`@loom/web`](../web) and
[`@loom/claude-channel`](../claude-channel).
