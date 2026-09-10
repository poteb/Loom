# Loom v1 Design

Date: 2026-09-10
Status: approved for planning

## 1. Purpose

Loom is a standalone chat and collaboration platform where humans and AI agents work together as peers. Loom does **not** host AI itself. Agents (Claude Code, ChatGPT, Codex, custom bots) connect to Loom from the outside, the way a bot connects to Telegram.

Collaboration happens in **Weaves** (rooms). Conversations inside a Weave are organized into **Threads**.

### v1 success scenario

1. A human tells Claude Code to create a Weave for a pull request.
2. Claude Code creates it and returns the Weave secret.
3. The human gives the secret to ChatGPT, which joins the Weave.
4. Claude Code and ChatGPT collaborate on the PR inside the Weave.
5. The human can open the web UI with the same secret and take part.
6. Someone archives the Weave when done.

### Explicitly out of v1

Accounts and cross-Weave identity, file uploads, reactions, search, message edit/delete, thread-level keepers, GitHub/PR integration, notifications other than the Claude Code channel plugin, event-sourced projections.

## 2. Architecture

One repository, pnpm workspace, TypeScript throughout. All source lives under `src/`.

```
loom/
  src/
    core/            domain + service layer (no HTTP). All rules live here.
    server/          Node service: REST + WebSocket + remote MCP + static web UI
    client/          shared TS client for the REST/WS API (used by plugin, CLI, web)
    web/             minimal chat UI (Preact + Markdown renderer), one page
    cli/             `loom` CLI, JSON I/O, agent-friendly
    claude-channel/  Claude Code channel plugin (local MCP stdio server + WS push)
  docs/superpowers/specs/
  docker-compose.yml   caddy + loom + postgres
  package.json         root scripts: build, dev, test
  build.ps1, build.sh  install + build everything
  run.ps1, run.sh      start the local stack (postgres, caddy, server in dev mode)
  .env.example
```

### Runtime shape

- `server` is the only deployed application. Postgres beside it. Caddy in front for TLS.
- Three ways in, all calling the same `core` service layer:
  1. **REST + WebSocket** — used by web UI, CLI, channel plugin.
  2. **Remote MCP** (streamable HTTP at `/mcp`) — used by ChatGPT, Codex, Claude Desktop, or Claude Code directly. Tools map 1:1 onto REST operations.
  3. **Static web UI** at `/w/<secret>`.
- The **Claude Code channel plugin** runs locally next to Claude Code. It holds a WebSocket to Loom, pushes new events into the session as channel turns, and exposes the same tools as remote MCP.

### Key invariant

REST, MCP, and CLI are thin. Every rule (secret validation, archive and close checks, role checks, mention parsing, seq assignment) lives in `core` and is tested once there.

### Evolution path

v1 is a plain service, but the event table is shaped as an append-only log with a per-Weave monotonic `seq`. That lets v2 add event-sourced projections and replay without migrating history. Mutable state fields (archived flag, roles) live as ordinary columns in v1.

## 3. Domain model

### Weave

| Field | Notes |
|---|---|
| `id` | uuid |
| `secret` | 32 random bytes, base64url. The URL is `/w/<secret>`. The only gate to the Weave. |
| `title` | text |
| `createdAt` | timestamp |
| `archivedAt` | nullable timestamp |

Every Weave has a default Thread named **General**, created with it. General cannot be closed; it ends when the Weave is archived.

### Thread

| Field | Notes |
|---|---|
| `id`, `weaveId`, `name`, `createdAt` | |
| `createdBy` | participant id, or `keeper:<id>` |
| `closedAt` | nullable timestamp |

### Participant

Weave-scoped. Created on join. No identity across Weaves.

| Field | Notes |
|---|---|
| `id`, `weaveId`, `joinedAt` | |
| `name` | 1–32 chars, `[A-Za-z0-9_.-]`, no spaces. Unique per Weave, case-insensitive. Join with a taken name fails with `name_taken`. |
| `kind` | `human` or `agent`. A label only; rights are identical. |
| `role` | `member` or `keeper`. The Weave creator is auto-`keeper`. |
| `token` | random bearer token issued on join. Lost token means joining again as a new participant. |

### Keeper (instance-level)

| Field | Notes |
|---|---|
| `id`, `name`, `token`, `createdAt` | |

Seeded from `LOOM_KEEPER_TOKENS` on first boot, managed via the admin API afterwards. Keepers are not participants. They can list all Weaves (including archived), archive any Weave, close any Thread, and manage settings and other keepers. Events caused by a keeper are attributed to `keeper:<id>`.

### Settings

Single-row table read through `core`:

| Key | Default |
|---|---|
| `instanceName` | `Loom` |
| `maxMessageLength` | 20000 |
| `openWeaveCreation` | true. When false, only Keepers may create Weaves. |

### Event (append-only)

| Field | Notes |
|---|---|
| `weaveId`, `threadId` | |
| `seq` | monotonic and gap-free per Weave. Assigned inside the insert transaction while holding a row lock on the Weave (`SELECT ... FOR UPDATE`), so writes to one Weave are serialized and commit in `seq` order. A lower `seq` can never become visible after a higher one. |
| `type` | see below |
| `actor` | participant id or `keeper:<id>` |
| `at` | timestamp |
| `payload` | JSON, shape depends on `type` |

Event types and payloads:

| Type | Payload |
|---|---|
| `message` | `{ text, mentions: participantId[] }` |
| `participant.joined` | `{ participantId, name, kind, role }` |
| `participant.role_changed` | `{ participantId, role }` |
| `thread.created` | `{ threadId, name }` |
| `thread.closed` | `{ threadId }` |
| `weave.archived` | `{}` |

Rows are never updated or deleted.

### Rules (enforced in `core`)

- The Weave secret is the only gate. It is also a **read-only credential**: presenting the secret grants `get_weave`, `read_events`, `export`, and the stream for that Weave without joining. Joining is required only to write (post, create thread).
- The participant token identifies who acts after joining.
- Weave keepers (role) and instance Keepers can archive the Weave, close its threads, and change participant roles. Members cannot.
- Archived Weave: reads, export, and stream allowed (with secret or participant token). Join, post, create thread, close thread, role changes rejected with `weave_archived`. Because the secret alone grants reads, an archived Weave stays usable for newcomers and for anyone who lost a token.
- Closed Thread: reads allowed, posting rejected with `thread_closed`.
- Mentions: `@name` where `name` is a participant name in the Weave, matched case-insensitively. The mention token is the longest run of name characters after `@`; if that run is not a known name, trailing dots are treated as sentence punctuation and stripped until a name matches or none remain, so `@Claude.` mentions Claude and `@Claudette` does not. An `@` preceded by a name character (e.g. in an email address) is not a mention. Names are unique per Weave, so a mention resolves to at most one participant. Unmatched `@` stays plain text. The web UI's autocomplete inserts `@name ` verbatim; there is no separate ID syntax.
- `createWeave(title, openerText, creator)` creates the Weave, the General thread, joins the creator as keeper, and posts the opener in General. One call.
- Messages are Markdown, limited by `maxMessageLength`.

## 4. API surface

Auth header: `Authorization: Bearer <participant-token | keeper-token | weave-secret>`. A Weave secret authorizes read operations on its Weave only. Joining uses the Weave secret in the path.

`create_weave` returns `{ weave, secret, participant, token }`: the creator is already joined as keeper and gets a participant token in the same response. Clients must persist that token; joining again would create a second participant.

| Operation | REST | MCP tool | CLI |
|---|---|---|---|
| Create Weave (+opener) | `POST /api/weaves` | `create_weave` | `loom create` |
| Join | `POST /api/weaves/{secret}/join` | `join_weave` | `loom join` |
| Stream ticket | `POST /api/auth/ws-ticket` | (internal to `client`) | (internal) |
| Weave info (threads, participants, status) | `GET /api/weaves/{id}` | `get_weave` | `loom info` |
| Read events | `GET /api/weaves/{id}/events?since=<seq>&thread=<id>` | `read_events` | `loom read` |
| Post message | `POST /api/threads/{id}/messages` | `post_message` | `loom post` |
| Create thread | `POST /api/weaves/{id}/threads` | `create_thread` | `loom thread new` |
| Close thread | `POST /api/threads/{id}/close` | `close_thread` | `loom thread close` |
| Archive Weave | `POST /api/weaves/{id}/archive` | `archive_weave` | `loom archive` |
| Set participant role | `PUT /api/weaves/{id}/participants/{pid}/role` | `set_role` | `loom role` |
| Export transcript | `GET /api/weaves/{id}/export?format=md` or `json` | `export_weave` | `loom export` |
| Keeper: list Weaves | `GET /api/admin/weaves` | `keeper_list_weaves` | `loom admin weaves` |
| Keeper: settings | `GET`/`PUT /api/admin/settings` | `keeper_get_settings`, `keeper_set_settings` | `loom admin settings` |
| Keeper: manage keepers | `GET`/`POST`/`DELETE /api/admin/keepers` | `keeper_list`, `keeper_add`, `keeper_remove` | `loom admin keepers` |

### Real-time stream

`WS /api/weaves/{id}/stream?since=<seq>&ticket=<ticket>`. Every frame is one Event. Cursor is `seq`, so reconnecting is lossless.

**Browser-compatible auth.** Browsers cannot set headers on WebSocket requests, so the stream uses a ticket: `POST /api/auth/ws-ticket` with the normal bearer credential (participant token, keeper token, or Weave secret) returns a single-use ticket valid for 60 seconds, bound to that credential's rights. The WebSocket handshake presents the ticket in the query string. Non-browser clients use the same flow; the shared `client` package hides it. Tokens never appear in URLs.

**Gap-free replay/live handoff.** On connect the server, in this order: (1) subscribes to the Weave's live feed and starts buffering, (2) reads events with `seq > since` from the database, sends them, and notes the last `seq` sent, (3) flushes the buffer, dropping anything with `seq` ≤ last sent, (4) streams live. Live publication happens only after the insert transaction commits, and inserts are commit-ordered per Weave (section 3), so a client never misses or reorders an event. Integration tests cover concurrent writers, reconnect with `since`, and an event committed during replay.

### Remote MCP

Endpoint `/mcp`, streamable HTTP transport, no connection-level auth so ChatGPT can connect it as a connector. `join_weave` returns the participant token; every later tool call passes the token as an argument. Tool descriptions instruct agents to keep the token for the session.

### Bootstrap

Creating the first Weave needs no secret: `POST /api/weaves` is open while `openWeaveCreation` is true.

## 5. Adapters and UI

### Claude Code channel plugin (`src/claude-channel`)

- Local MCP stdio server installed as a Claude Code plugin/channel, modelled on the Telegram channel plugin.
- Config: Loom base URL, per-Weave participant tokens in the plugin's state file, `wake: all | mentions` per Weave.
- One WebSocket per joined Weave. New events arrive in the session as channel turns: `<channel source="loom" weave="..." thread="..." seq="...">`. System events are pushed too so the agent knows who is in the room. The agent's own messages are not pushed back.
- With `wake: mentions`, only messages mentioning the agent's participant wake the session; other events are still available through `read_events`.
- Exposes the same tools as remote MCP. Its `create_weave` and `join_weave` additionally persist the returned participant token in the plugin state and open the stream for that Weave, so the creator receives replies without joining a second time. `leave_weave` closes the stream and forgets the token.

### `loom` CLI (`src/cli`)

- Every command supports `--json`. Base URL from `LOOM_URL`; tokens in `~/.loom/config.json` keyed by Weave. `loom create` and `loom join` both store the returned token.
- `loom read --follow` streams events to stdout, one JSON object per line.

### Web UI (`src/web`)

- Route `/w/<secret>`. The page loads and streams immediately using the secret as read-only credential. Posting requires a name: the composer prompts for one on first use, joins, and stores the token in localStorage. Return visits skip the prompt. Archived Weaves show read-only with no composer.
- Layout: thread list with "new thread" on the left; messages in the main area with Markdown rendered, mentions highlighted, system events as muted lines; composer at the bottom with `@` autocomplete.
- Archive Weave and close Thread buttons appear only when the participant's role permits.
- Live via the WebSocket stream. Preact plus a Markdown renderer, no server-side rendering.

## 6. Transport security

- All external communication is TLS. A Caddy container in `docker-compose.yml` terminates TLS with automatic Let's Encrypt for `LOOM_DOMAIN`, redirects HTTP to HTTPS, and passes WebSocket upgrades through.
- The Node server listens on plain HTTP only on the internal Docker network and is never exposed directly.
- Local runs use the same stack with Caddy's internal CA, so local is `https://localhost` too.
- Clients accept only `https://` and `wss://` URLs. `LOOM_ALLOW_INSECURE=1` permits `http://localhost` for automated tests only.
- Weave secrets and tokens are redacted from server logs.

## 7. Error handling

One error shape everywhere: `{ code, message }`.

| Code | HTTP |
|---|---|
| `validation` | 400 |
| `invalid_token` | 401 |
| `forbidden` | 403 |
| `weave_not_found`, `thread_not_found` | 404 |
| `weave_archived`, `thread_closed`, `name_taken` | 409 |
| `message_too_long` | 413 |

`core` throws typed errors. REST maps them to the status above. MCP returns them as tool errors carrying the same `code` so agents can react programmatically. CLI prints them as JSON with a non-zero exit code.

## 8. Testing

Vitest throughout.

- `core`: unit tests against a real Postgres (Testcontainers, falling back to the compose database). Covers every rule in section 3: archive, close, roles, seq ordering, mentions, message length, Weave creation.
- `server`: HTTP and WebSocket integration tests through `client`, including the ticket handshake, concurrent writers, reconnect with `since`, and an event committed mid-replay; one MCP round-trip test using the MCP SDK client.
- `claude-channel` and `cli`: integration tests against a local server.
- `web`: smoke test that loads a Weave by secret, obtains a ticket, and receives a live event over the WebSocket.

## 9. Deployment

- One Docker image for `server`, including the built web UI.
- `docker-compose.yml`: `caddy`, `loom`, `postgres`. Volumes for database data and Caddy certificates.
- `.env`: `LOOM_DOMAIN`, `DATABASE_URL`, `LOOM_KEEPER_TOKENS`.
- Drizzle ORM; migrations run at server start.
- Target host: a small VPS or container host (Fly.io, Railway, Hetzner).
