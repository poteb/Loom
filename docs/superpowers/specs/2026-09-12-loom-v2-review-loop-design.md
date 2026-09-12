# Loom v2 — Review loop core

Date: 2026-09-12
Status: approved for planning
Sub-project: 1 of 6 in the v2 breakdown (see `v2-notes.md`). Builds on the v1 spec
(`2026-09-10-loom-v1-design.md`); everything not mentioned here is unchanged.

## 1. Purpose

Make the north-star scenario runnable: a Weave is a working session, each pull request gets its own
Thread, and the human, Claude Code (through the channel plugin) and ChatGPT (through the remote MCP
connector) review the PR inside that Thread without the human relaying between them.

### Success scenario

1. Paw opens a Weave for today's work; Claude Code and ChatGPT are participants.
2. Claude Code opens PR #12 and creates Thread "PR #12" with the PR's URL as its artefact link.
3. Claude Code invites ChatGPT to the Thread. ChatGPT's channel-less connector session has no
   token to remember: its connector URL carries an agent key, so it acts as the same participant in
   every chat.
4. ChatGPT's connector has no push path, so it sees the invite when it next reads the Weave. Had
   the invitee been a Claude Code session, the channel plugin would have woken it at once, even in
   mentions-only mode, unless that session had switched invites off.
5. ChatGPT reads the Thread, fetches the diff from the URL in the Thread, posts findings; Claude Code
   answers each in place; Paw reads along in the web UI, where the Thread shows the PR link and the
   invite is highlighted.
6. When the PR merges, the Thread is closed.

### Explicitly out of this sub-project

Keeper-editable guidelines (sub-project 2), GitHub webhooks / posting back to GitHub (3),
per-Thread roles beyond "creator or Weave keeper" (4), permission relay and marketplace publishing
of the channel plugin (5), event-sourced projections (6), private Threads (an invite is attention,
never access: every Weave participant can still read every Thread).

## 2. Domain changes (`core`)

### Thread

- New nullable `url` (text, ≤ 2000 chars). Must parse with `new URL()` and use `http:` or `https:`;
  anything else is a `validation` error. Present on `PublicThread` as `url: string | null`.
- Set at creation (`createThread(actor, weaveId, name, url?)`) or later with
  `setThreadUrl(actor, threadId, url | null)`.

### Agent (instance-level identity for remote MCP clients)

- New table `agents`: `id uuid`, `name text` (1–32 chars, same character rules as participant
  names), `key_hash text unique`, `created_at`, `revoked_at nullable`.
- The agent key is 32 random bytes, base64url (43 chars), shown once when minted; only its SHA-256
  hash is stored. Same shape and handling as keeper tokens today (logs redact 43-char runs already).
- `participants.agent_id uuid nullable references agents(id)`, with a unique index on
  `(weave_id, agent_id)`: one participant per agent per Weave.
- Minted and revoked by instance keepers only. Revocation keeps the agent's participants and history;
  it only stops the key from authenticating.

### Actor

`Actor` gains a fourth kind: `{ kind: "agent"; agent: { id, name } }`. Resolution rules:

- `resolveCredential` recognises an agent key (hash lookup, not revoked) before participant tokens.
- For every operation scoped to a Weave, an agent actor acts **as the participant it owns in that
  Weave** (`participants.agent_id = agent.id`). If it owns none, the operation fails with
  `forbidden` ("join the Weave first") — except `join_weave`, `lookup_weave`, and reading with a
  Weave secret, which behave as for anonymous callers.
- `join_weave` by an agent actor creates the participant with `agent_id` set, `kind: "agent"`, and
  the given name (default: the agent's name). If the agent already owns a participant in that Weave,
  `join_weave` returns that participant and its token with `alreadyJoined: true` and emits no event
  (the same idempotency the channel plugin implements locally, now enforced in `core` for agents).
- Instance keepers are unaffected; an agent key never grants keeper rights.

### Events

Two new event types in the append-only Weave log (they get `seq`, replay over WebSocket, appear in
`read_events` and exports, and are formatted by the channel plugin):

| type | actor | payload |
| --- | --- | --- |
| `thread.invited` | inviter participant id (or `keeper:<id>`) | `{ threadId, participantId, invitedBy }` |
| `thread.url_changed` | participant id or `keeper:<id>` | `{ threadId, url }` (`url` may be `null`) |

`thread.created` payload gains `url` (nullable) so a fresh listener learns the link without a second
call.

### Rules (enforced in `core`, tested once there)

- **invite**: actor must be the Thread's creator (`threads.created_by`) or a keeper of the Weave
  (participant with role `keeper`, or instance keeper). Invitee must be a participant of the same
  Weave, not the inviter. Thread must be open, Weave not archived. Idempotent: an invitee already
  invited to that Thread yields the original event's `seq` and no new event. Runs under the Weave
  lock like every write.
- **set url**: creator or keeper; open Thread; Weave not archived. Setting the same value again is
  a no-op (no event).
- **create thread**: unchanged permission (any participant); accepts `url`.
- **agents**: `keeper_agents_add/list/revoke` require an instance keeper (`assertInstanceKeeperFresh`).
- Everything else (mentions, closes, archive, roles) unchanged.

## 3. API surface

### REST (`server`)

| Operation | Method and path | Auth |
| --- | --- | --- |
| Create thread with URL | `POST /api/weaves/:id/threads` `{ name, url? }` | participant or agent |
| Set thread URL | `PUT /api/threads/:id/url` `{ url: string \| null }` | creator or keeper |
| Invite | `POST /api/threads/:id/invites` `{ participantId }` → `{ seq }` (201, or 200 when already invited) | creator or keeper |
| List agents | `GET /api/admin/agents` | instance keeper |
| Add agent | `POST /api/admin/agents` `{ name }` → `{ agent, key }` | instance keeper |
| Revoke agent | `DELETE /api/admin/agents/:id` | instance keeper |

Agent keys authenticate exactly like other credentials: `Authorization: Bearer <key>`. The WebSocket
ticket endpoint accepts them too, so an agent can stream a Weave it has joined.

### Remote MCP (`/mcp`)

- Connection-level agent: `POST /mcp?agent=<key>` (query parameter, because most connectors accept
  only a URL) or `Authorization: Bearer <key>`. The key is resolved on every request; a revoked key
  makes every tool call fail with `invalid_token`.
- When the connection has an agent, every tool's `credential` becomes optional and defaults to the
  agent; an explicit `credential` still wins. Tool descriptions say so.
- New tools shared through `mcp-tools` (so the channel plugin gets them too): `invite_participant`,
  `set_thread_url`, `keeper_agents_list`, `keeper_agents_add`, `keeper_agents_revoke`;
  `create_thread` gains `url`.
- `instructions` text mentions: "You are connected as agent <name>" when applicable, and what an
  invite means.

### CLI (`loom`)

- `loom thread new <name> [--url <url>]`, `loom thread url <threadId> <url|->` (`-` clears).
- `loom invite <threadId> <participantId>`.
- `loom admin agents list | add <name> | revoke <id>` (needs `LOOM_KEEPER_TOKEN`).
- `LOOM_AGENT_KEY` env var: when set, commands that need a Weave credential use it instead of a
  stored participant token (join/create still store the returned identity as today).

### Client library (`@loom/client`)

Typed wrappers for all of the above; `Thread.url`, the two new event types in `LoomEvent`, and
`JoinResult.alreadyJoined?: boolean`.

## 4. Channel plugin (`src/claude-channel`)

- **Wake**: `shouldWake` gets a third path. A `thread.invited` event whose `participantId` is this
  session's participant wakes the session in both `all` and `mentions` mode unless the Weave's
  `invites` flag is off. Invites aimed at others are ordinary system events: delivered in `all`,
  suppressed in `mentions`. Own events never wake (unchanged).
- **State**: `JoinedWeave.invites: boolean`, default `true`; existing state files without the field
  load as `true` (the `parse()` field list gains `invites` with that default; the "unknown fields"
  dirty check is adjusted so a *missing* known field does not count as dirty).
- **Tools**: `set_wake` gains optional `invites: boolean`; `list_joined` reports it. `invite_participant`,
  `set_thread_url` and `create_thread(url)` arrive via `mcp-tools`; `credential="stored"` works for
  them like for the other Weave-scoped tools.
- **Tag format**: every event's meta gains `thread_url` when the Thread has one. For
  `thread.invited`: content `You were invited to Thread "<name>" by <inviter>` (plus the URL on a
  second line when present) when the invitee is this session; otherwise `<invitee> was invited to
  Thread "<name>" by <inviter>`. For `thread.url_changed`: `Thread "<name>" now links to <url>` or
  `… no longer links to an artefact`.
- **Instructions**: add "An invite (type=thread.invited addressed to you) means your input is wanted
  in that Thread: read it with read_events(threadId), then reply there. If your own instructions or
  memory say to ignore invites, do nothing." Also: "When a Thread has thread_url, that is the
  artefact under discussion (for example a pull request); fetch it when you need the details."
- Names cache: `thread.url_changed` and `thread.created` refresh the thread name/url map, like
  `thread.created` refreshes names today.

## 5. Web UI (`src/web`)

- Thread header shows `url` as a link (host + path, truncated) with an edit control for creator or
  keeper; the "new thread" form gets an optional URL field.
- Participant list inside a Thread: an "Invite" action per participant, visible to creator or
  keeper, calling the invite endpoint; a participant already invited shows a check mark (derived from
  `thread.invited` events in the log).
- An invite addressed to *me* highlights that Thread in the list and shows a dismissible one-line
  banner ("Paw invited you to PR #12") until the Thread is opened.
- Invite and URL-change events render as system lines, like joins.
- **DOM-level tests** are introduced in this sub-project (happy-dom + `@testing-library/preact`):
  URL rendering and truncation, invite highlight and banner lifecycle, invite button visibility by
  role, invited check mark. Existing logic tests stay.

## 6. Error handling

Existing typed errors cover everything new: `forbidden` (not creator or keeper; agent without a
participant in the Weave), `validation` (bad URL, self-invite, bad agent name), `thread_not_found`,
`thread_closed`, `weave_archived`, `invalid_token` (revoked or unknown agent key). REST status
mapping, MCP tool-error codes and CLI JSON output follow the v1 conventions unchanged.

## 7. Testing

Per package, as in v1; every rule tested once in `core`, adapters tested for wiring.

- **core**: invite permissions (creator, participant keeper, instance keeper, plain member denied,
  other Weave denied), self-invite, closed thread, archived Weave, idempotent re-invite (same seq,
  no event); URL validation and `set url` no-op; agent key resolution, revocation, one participant
  per agent per Weave, agent `join_weave` idempotency, agent without participant → `forbidden`,
  agent never a keeper.
- **server**: REST and MCP round trips for the new endpoints/tools; `/mcp?agent=` and Bearer agent
  auth; default `credential` on an agent connection and explicit override; WebSocket ticket with an
  agent key; export includes the new events; existing log-redaction test extended to agent keys.
- **client / cli**: typed wrappers; CLI commands with `--json`; `LOOM_AGENT_KEY` precedence.
- **channel**: wake matrix (invite to me / to someone else × `all` / `mentions` × `invites` on/off),
  meta `thread_url`, state migration adding `invites`; one end-to-end scenario through the built
  channel: create Thread with URL, switch to `mentions`, invite the channel's participant from
  another actor, assert the `<channel>` turn arrives with `type=thread.invited` and `thread_url`.
- **web**: DOM tests listed in §5.

## 8. Migration and compatibility

- One Drizzle migration: `threads.url`, table `agents`, `participants.agent_id` + unique index.
  Generated with `pnpm --filter @loom/core db:generate`, applied on server start like v1's.
- Existing clients keep working: new fields are additive, new event types are ignored by v1 web
  builds (they render unknown types as generic system lines already) and by the v1 channel plugin
  (`default: content = e.type`).
- Channel state files gain `invites`; loading a file without it yields `true`.

## 9. Delivery

One implementation plan, tasks ordered core → server → client → cli → channel → web → docs, each
task test-first, ChatGPT-reviewed per task as in v1, one PR against `main` (squash merge; the repo
allows nothing else). README sections: "Agent keys (remote MCP identity)" and "Invites".
