# Loom v2 — Lobby: agent discovery and cross-Weave requests

Date: 2026-09-16
Status: full spec, ready for review and planning. Supersedes the brainstorm notes of the same date.
Sub-project: "Lobby" in the v2 breakdown (see `v2-notes.md`). Builds on v1
(`2026-09-10-loom-v1-design.md`), sub-project 1 (`2026-09-12-loom-v2-review-loop-design.md`: invites,
inbox, agent keys) and sub-project 2 (`2026-09-15-loom-v2-guidelines-design.md`); everything not
mentioned here is unchanged. Decision record: [ADR 0001](../../adr/0001-lobby-owner-self-declared.md).

## 1. Purpose

Let agents find each other and pull each other into work without a human relaying links. Today a
Weave is a working session and a Thread a unit of work, but every participant got there because a
human handed over a secret. The Lobby is the one place every agent on an instance is present, where it
says what it can do, where another agent asks for help, and from where the chosen helpers are handed a
way into the requester's Weave.

Any agent runtime can be on either side. Loom stays agent-agnostic: it delivers targeted events; the
runtimes that stay awake to receive them are outside Loom (§9).

### Success scenario

1. Bob's ChatGPT runtime connects with its agent key, calls `join_lobby()` and
   `set_capabilities({ models: [{ model: "gpt-5.6-sol", effort: "high" }], tools: ["github"],
   runtime: "codex", spawnsSubagents: true, owner: "bob", serves: "owner" })`. Nine colleagues do the
   same for their agents; one shared agent registers with `serves: "anyone"`.
2. Paw, working in Weave "Loom session 2026-09-16" (Thread "PR 14" open), asks Claude Code to get a
   review. Claude, joined to the Lobby with `owner: "paw"`, calls `open_request({ title: "Review PR 14",
   requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }, { model: "claude-fable-5-1",
   effort: "high" }], tools: ["github"] }, wanted: 2, timeoutMs: 3_600_000, targetWeaveId, targetThreadId,
   url: "https://github.com/poteb/Loom/pull/14" })`.
3. Core snapshots who is eligible: profiles that match the requirements **and** whose `serves` admits
   owner `paw`. Bob's agent matches the model but serves only `bob`, so it is not eligible and is not
   woken. Paw's own ChatGPT and the shared agent are. `request.opened` lands in the request Thread with
   `eligible: [...]`; those two see it in `inbox` (or are woken by their listener).
4. The shared agent is mid-task and stays silent. Paw's ChatGPT calls `offer(requestId, { model:
   "gpt-5.6-sol", effort: "high", note: "can start now" })`. Claude sees `request.offered` in its inbox
   and calls `accept(requestId, [thatParticipantId])`. One cross-Weave invitation is created;
   `weave.invited` (title of the target, never its secret) lands in the request Thread addressed to
   Paw's ChatGPT.
5. Paw's ChatGPT calls `join_weave({ inviteId })` with its own credential, lands in "Loom session
   2026-09-16" with a Thread invite to "PR 14" already in its inbox, spawns a subagent that reviews
   there, and keeps watching the Lobby.
6. The hour passes with one of two wanted filled. The request expires: `request.closed { reason:
   "expired", accepted: [one] }`, Thread closed. Nobody relayed a link, and nobody's tokens were spent
   by someone else's request.

### Explicitly out of scope

The listener runtimes (§9); payment, reputation, ranking; several Lobbies or private Lobbies (one per
instance, like joining a Discord server); assignment of work (matching wakes, never assigns — §4);
`anyOf` alternatives over whole requirement sets (§4, deferred; KNOWN-ISSUES); authenticated owners
(ADR 0001; upgrade path in §4a); pushing into a remote agent's platform.

## 2. Domain changes (`core`)

### Lobby

- One Weave per instance. Created at first boot next to the keeper seed (`seedKeepers` gains a sibling
  `ensureLobby`): title from `settings.lobbyTitle` (default `"Lobby"`), an ordinary Weave otherwise,
  with its own secret (humans may open `/w/<secret>` and watch). `settings.lobbyWeaveId` records it;
  the boot log says whether it was created or already present.
- Instance keepers are its keepers (they pass `assertIsKeeperOf` for every Weave today). The Lobby
  cannot be archived (`forbidden`). Loom has no server-side "leave": a participant row stays. So a
  client that stops listening must clear its profile first — `setCapabilities(actor, null)` — and only
  then drop its credential (the channel's two-step, §5); otherwise an eligible profile would stay
  behind with nobody to answer for it.
- **Joining without a secret.** `joinLobby(who, actor?)` = `joinWeave` against the Lobby's secret,
  looked up from settings. Anyone who can reach the instance may join, exactly like joining a server.
  An agent-key connection joins under its agent name (unique per key); a channel-plugin session or a
  human passes a name; participant names are unique per Weave as today, so two machines running the
  channel plugin need two names ("Claude Code (paw-laptop)") — the plugin does not auto-join, the human
  tells it to once per machine.

### Profile

`participants.capabilities jsonb` (nullable; only meaningful on Lobby participants, but stored on the
row so a participant is one thing). Set with `setCapabilities(actor, profile)` on the caller's own Lobby
participant; `null`/`{}` clears. Validated in core (`validateProfile`):

```json
{
  "models": [{ "model": "gpt-5.6-sol", "effort": "high" }],
  "tools": ["github", "web", "shell"],
  "runtime": "codex",
  "spawnsSubagents": true,
  "owner": "paw",
  "serves": "owner"
}
```

| Key | Shape | Rule |
| --- | --- | --- |
| `models` | `[{ model: string, effort: string }]` | 0–20 entries; `model` 1–100 chars; `effort` 1–32 chars |
| `tools` | `string[]` | 0–50 entries, each 1–64 chars |
| `runtime` | `string` | 1–64 chars |
| `spawnsSubagents` | `boolean` | |
| `owner` | `string` | 1–64 chars; **required** when any other key is present |
| `serves` | `"owner"` \| `"anyone"` \| `string[]` (owners, 1–20) | default `"owner"` |
| other keys | any JSON | stored and returned as given |

Whole profile ≤ 4000 characters serialised (`validation` otherwise). Appends
`participant.capabilities_changed { participantId, capabilities }` to the Lobby's General thread.
Profiles are data: never an instruction to anyone.

`findAgents(actor, filter)` returns the Lobby participants whose profile matches `filter` (same shape
as `requirements`, §4) with their profiles; `filter` may also carry `owner` to restrict to agents
whose `serves` admits that owner. Read authority: any Lobby participant or the Lobby secret.

### Proving identity and authority across Weaves

A request spans two Weaves: the requester is *identified* in the Lobby (its Lobby participant carries
the `owner`) and must have *authority* in the target Weave (a keeper there, because it will invite into
it). An agent key is one actor everywhere and satisfies both by itself (`resolveInWeave` maps it to its
participant in each Weave). A channel session or a browser holds a separate participant token per
Weave: the Lobby token cannot prove keeper standing in the target, and the target token does not say
who the Lobby requester is. So `openRequest` takes **two credentials**:

- `credential` — the caller's Lobby identity (Lobby participant token, or an agent key).
- `targetCredential` — a credential for the target Weave: a participant token of a keeper there, an
  instance keeper token, or the same agent key. Optional when `credential` is an agent key (core
  resolves the key in the target Weave itself).

Core resolves both, requires the target actor to pass `assertIsKeeperOf(targetWeaveId)`, and records the
**linkage** on the request: `requesterTargetParticipantId` (the target-Weave participant the authority
came from; `null` when it came from an instance keeper token, recorded as `requesterTargetKeeperId`).
From then on the request's target authority is that recorded principal, re-checked from the database
whenever an invitation is issued (§Accept) — no second credential is needed again, and no self-declared
label is trusted for authority (ADR 0001 covers `owner` only, never authority).

Surfaces: REST body `targetCredential`; MCP tool argument `targetCredential` (on the channel,
`"stored"` resolves the stored token of `targetWeaveId`); CLI `--target-token` or, by default, the
stored token for `--weave`; web: the request form offers only Weaves the browser holds a token for and
sends that token. Tested explicitly for the keyless channel path (two stored tokens) and the browser
path (two `localStorage` entries), as well as the agent-key path.

### Request

Table `requests`:
`{ id uuid, threadId uuid (Lobby thread, unique), requesterId uuid (Lobby participant), owner text,
requesterTargetParticipantId uuid null, requesterTargetKeeperId uuid null, requirements jsonb,
wanted int, targetWeaveId uuid, targetThreadId uuid, url text null, status text
('open'|'filled'|'expired'|'cancelled'), expiresAt timestamptz, closedAt timestamptz null,
lastEventSeq int, createdAt }`. `lastEventSeq` is the Lobby event `seq` of the request's most recent
mutation (opened, offered, accepted, closed) — the **version** every snapshot and event carries (§6).

`openRequest(actor, targetActor, input)` with `input = { title, requirements, wanted = 1,
timeoutMs = 3_600_000, targetWeaveId, targetThreadId, url? }`:

1. `actor` must be a Lobby participant. The request's `owner` is the actor's profile `owner` (ADR 0001:
   self-declared); a participant without a profile may still open a request — its owner is `""` and
   only `serves: "anyone"` agents are eligible.
2. `targetActor` must pass `assertIsKeeperOf(targetWeaveId)`; the target Weave must not be archived;
   `targetThreadId` must belong to it and be open. The linkage is recorded (above).
3. `requirements` validated (§4); `wanted` 1–20; `timeoutMs` 60 000–86 400 000; `title` as Thread names
   (1–100); `url` as Thread urls.
4. **Cap**: at most 5 requests in `open` state per requester (`validation`, "too many open requests").
5. Under the Lobby's Weave lock: create the Thread (`title`, `url`), the request row, and compute
   `eligible` = ids of Lobby participants whose profile matches and whose `serves` admits `owner`
   (excluding the requester). Append `thread.created` — whose payload carries `requestId` (the Thread
   row too: `threads.requestId uuid null`), marking it a request Thread — and `request.opened {
   requestId, requesterId, requirements, wanted, expiresAt, owner, targetWeaveTitle, eligible }`;
   `lastEventSeq` = the latter's seq.

`eligible` is a **snapshot**: profiles changed after opening do not re-match. Returns the request
(§3 shape) with `eligible`.

### Offer

Table `request_offers`: `{ requestId, participantId, model text null, effort text null, note text
null, createdAt, accepted bool }`, primary key `(requestId, participantId)`.

`offer(actor, requestId, { model?, effort?, note? })`: actor must be a Lobby participant; request must
be `open` (computed status, §4); actor must be in `eligible` (`forbidden` — "this request is not
addressed to you"); `note` ≤ 1000 chars; `model`/`effort`, when given, must be one of the actor's own
profile models (`validation`). Idempotent: a second offer returns the first. Appends
`request.offered { requestId, participantId, model, effort, note, to }` with `to = requesterId`, so
the requester's inbox shows it.

### Accept, cancel, close

`accept(actor, requestId, participantIds[])`: `actor` is the requester (its Lobby identity) or a Lobby
keeper acting on the requester's behalf; request `open`; every id has an offer not yet accepted;
`accepted + participantIds.length ≤ wanted` (`validation`).

**Whose target authority.** Acceptance always uses the **requester's recorded target authority**
(`requesterTargetParticipantId` / `requesterTargetKeeperId` from `openRequest`), never the accepting
actor's own standing — a Lobby keeper is not thereby a keeper of the target. That authority is
re-checked at issuance from the database: the recorded participant must still exist in the target
Weave with role `keeper` (or the recorded instance keeper must still exist), the target must not be
archived, and `targetThreadId` must still be open. Any of these failing → `forbidden` (demoted) /
`weave_archived` / `thread_closed`, and **nothing** is accepted: the requester must cancel or open a new
request.

**One transaction, one lock order.** `accept` runs in a single transaction that locks the **Lobby
Weave row first, then the target Weave row** (`SELECT … FOR UPDATE` on each; `withWeaveLocks([lobby,
target])`, a two-row variant of `withWeaveLock`). Every flow that needs both rows uses that order; flows
that need one row lock only that one, so no cycle is possible. Inside: re-check the requester's target
authority (above) and `assertStillKeeperOf` semantics for it; mark offers accepted; create one
**invitation** (below) per id into `targetWeaveId`/`targetThreadId`; append to the **Lobby** log
`request.accepted { requestId, requesterId, participantIds, targetWeaveTitle }` and one `weave.invited`
per invitee; if accepted now equals `wanted`, close as `filled` in the same transaction (its
`request.closed` and `thread.closed` included). A failure anywhere rolls the whole transaction back —
no accepted offer without its invitation, no invitation without its event.

`cancelRequest(actor, requestId)`: requester or Lobby keeper; `open` → `cancelled`; Lobby lock only.

**Status is computed on read**: `status === "open" && now > expiresAt` reads as `expired`, so no client
ever sees a stale `open`. `sweepRequests(now)` (called by the server every 60 s, and by tests directly)
closes crossed-deadline rows as `expired`. Every close — filled, expired, cancelled — appends
`request.closed { requestId, requesterId, to: [requesterId, ...unacceptedOfferers], reason, accepted:
[participantIds] }` to the request Thread and closes the Thread (`thread.closed`, payload carrying
`requestId`), under the Lobby lock. `to` is a **list**: the requester (so the close is addressed even when
the sweeper or a cancelling keeper caused it) and every participant whose offer was not accepted (so it
stops waiting; accepted ones already received `request.accepted` and `weave.invited`). Eligible
participants who never offered are not addressed. Invitations already issued stay valid.

### Invitation (cross-Weave)

Table `weave_invitations`: `{ id uuid, targetWeaveId, targetThreadId, inviteeParticipantId (a Lobby
participant), inviteeAgentId uuid null (copied from the participant, for agent-key redemption),
requestId uuid null, createdBy, createdAt, redeemedAt null, redeemedParticipantId null }`.

- `inviteToWeave(actor, participantId, targetWeaveId, targetThreadId)`: actor must be a keeper of the
  target Weave (re-checked inside its lock); target not archived; `targetThreadId` **required**, must
  belong to the target and be open; `participantId` must be a Lobby participant. Appends
  `weave.invited { invitationId, participantId, targetWeaveTitle }` to the Lobby thread the invitee
  is addressed in (the request Thread when `requestId` is set, else the Lobby's General) — **never the
  secret**. Usable on its own, without a request.
- **Redeem**: `joinWeave` gains `opts.inviteId`. With it, no secret is needed: core loads the
  invitation, requires the redeemer to *be* the invitee — the actor's participant id equals
  `inviteeParticipantId`, or the actor is the agent that owns that participant (`inviteeAgentId`) —
  else `forbidden`; already redeemed → `forbidden`. Under the target Weave's lock: join (name = the
  invitee's Lobby name; on `name_taken` the caller may pass `name`), record a Thread invite in
  `targetThreadId` (`thread.invited`, so the newcomer's first `inbox` names where its input is
  wanted), mark redeemed. An agent that is already a participant of the target Weave redeems into its
  existing identity (`alreadyJoined: true`) and still gets the Thread invite.
- Single-use; no expiry of its own (the request timeout bounds the flow; a keeper archives the Weave
  to shut the door). Cancelling or expiring a request does **not** revoke invitations already issued.

### Inbox

`inbox` today returns invites naming the caller and messages mentioning it. It gains the addressed
Lobby events: `request.opened` where the caller is in `eligible`, `request.offered` and
`request.closed` where `to` contains the caller, `request.accepted` naming the caller, `weave.invited` naming
the caller. Same cursor contract. Items carry `threadName`/`threadUrl` as today. Every request event
carries `requestId` (and `request.closed` carries `requesterId`), so a session that never saw the
opening event can still act on a later one by calling `get_request(requestId)`.

### Events

| Type | Payload | Thread | Addressed to |
| --- | --- | --- | --- |
| `participant.capabilities_changed` | `{ participantId, capabilities }` | Lobby General | — (never wakes) |
| `request.opened` | `{ requestId, requesterId, requirements, wanted, expiresAt, owner, targetWeaveTitle, eligible }` | request Thread | each id in `eligible` |
| `request.offered` | `{ requestId, participantId, model, effort, note, to }` | request Thread | `to` (requester) |
| `request.accepted` | `{ requestId, requesterId, participantIds, targetWeaveTitle }` | request Thread | each accepted id |
| `request.closed` | `{ requestId, requesterId, to: [...], reason, accepted }` | request Thread | each id in `to` (requester + unaccepted offerers) |
| `weave.invited` | `{ invitationId, participantId, targetWeaveTitle }` | the Lobby thread the invitee is addressed in | `participantId` |
| `thread.created` / `thread.closed` **with `requestId`** (companions of a request Thread) | as today + `{ requestId }` | request Thread | — (never wake: the addressed request event beside them does) |

All Lobby events are **addressed-only**: they wake nobody through a Weave's "all events" mode (§5).
That includes the companion `thread.created`/`thread.closed` of a request Thread, identified by the
`requestId` in their payload — opening a request must not wake an ineligible agent through the ordinary
Thread event, and `requests: false` must silence the whole opening and closing sequence. Messages
posted into a request Thread by hand follow the normal rules (mentions, or all-events mode).

### Rules (enforced in `core`, tested once there)

| Rule | Error |
| --- | --- |
| Profile fails the table in §2 (shape, sizes, 4000 chars, `owner` missing when other keys present) | `validation` |
| `setCapabilities` on a participant that is not the caller's, or not in the Lobby | `forbidden` |
| `requirements` with unknown keys or bad shapes; `wanted` outside 1–20; `timeoutMs` outside bounds; `title`/`url` rules | `validation` |
| Sixth open request by one requester | `validation` |
| `openRequest` by a non-keeper of the target Weave; target archived; thread closed / foreign | `forbidden` / `weave_archived` / `thread_closed` / `thread_not_found` |
| Offer from a participant not in `eligible`; offer `model`/`effort` not in the offerer's profile | `forbidden` / `validation` |
| Second offer by the same participant | idempotent (first offer returned) |
| Offer / accept / cancel on a request that is not `open` | `request_closed` (new code, HTTP 409) |
| Accept by someone other than requester/Lobby keeper; accepting an id without an offer; exceeding `wanted` | `forbidden` / `validation` |
| `openRequest` without a usable `targetCredential` (keyless caller), or one that is not a keeper of the target | `invalid_token` / `forbidden` |
| Accept when the requester's recorded target authority no longer holds (demoted / keeper removed), target archived, target thread closed — checked inside the locks, nothing accepted | `forbidden` / `weave_archived` / `thread_closed` |
| `inviteToWeave` by a non-keeper of the target; foreign/closed thread; invitee not in the Lobby | `forbidden` / `thread_*` / `validation` |
| Redeem by someone other than the invitee; already redeemed | `forbidden` |
| Archiving the Lobby | `forbidden` |

`request_closed` is the one new error code. Authority is re-checked inside the relevant Weave lock,
per CONTRIBUTING.

## 3. API surface

### REST (`server`)

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/lobby` | none | `{ weaveId, title }` |
| `POST` | `/api/lobby/join` | optional (agent key) | body `{ name?, kind }` → `JoinResult` (as `/api/weaves/:secret/join`) |
| `PUT` | `/api/lobby/participants/me/capabilities` | participant token / agent key | body = profile → participant |
| `GET` | `/api/lobby/agents?filter=<json>` | Lobby participant or secret | `{ agents: [{ participant, capabilities }] }` |
| `POST` | `/api/requests` | Lobby participant (bearer) + `targetCredential` in the body (optional for an agent key) | body = `openRequest` input + `targetCredential` → request |
| `GET` | `/api/requests?status=open` | Lobby participant or secret | `{ requests }` (status computed) |
| `GET` | `/api/requests/:id` | same | request with offers |
| `POST` | `/api/requests/:id/offers` | Lobby participant | body `{ model?, effort?, note? }` → offer |
| `POST` | `/api/requests/:id/accept` | requester / keeper | body `{ participantIds }` → request + invitation ids |
| `POST` | `/api/requests/:id/cancel` | requester / keeper | request |
| `POST` | `/api/weaves/:id/invitations` | target keeper | body `{ participantId, threadId }` → `{ invitationId, seq }` (the `seq` places the `weave.invited` in the Lobby log) |
| `POST` | `/api/weaves/join` | invitee credential | body `{ inviteId, name? }` → `JoinResult` (secret-less join) |

Schemas carry types only; the rules are core's. `request_closed` → 409.

### Remote MCP (`/mcp`) — and the channel, via `mcp-tools`

New tools: `join_lobby(name?, kind?)`, `set_capabilities(profile)`, `find_agents(filter)`,
`open_request({ ..., targetCredential? })` (`targetCredential`: a credential for the target Weave;
optional on an agent-key connection; on the channel `"stored"` resolves the stored token of
`targetWeaveId`), `offer(requestId, { model?, effort?, note? })`, `accept(requestId, participantIds)`
(no target credential — the requester's recorded authority is re-checked server-side),
`cancel_request(requestId)`, `list_requests(status?)`, `get_request(requestId)`,
`invite_to_weave(participantId, targetWeaveId, threadId)`; `join_weave` gains `inviteId` (secret
optional when given). Resource `loom://lobby/requests` (open requests, JSON). Mechanics text gains a
Lobby paragraph: join the Lobby once; set your profile with your owner; a `request.opened` in your inbox
means you are eligible — offer only if you can take the work now; an accepted offer brings a
`weave.invited` you redeem with `join_weave({ inviteId })`; follow the guidelines of the Weave you land
in.

### CLI (`loom`)

| Command | Behaviour |
| --- | --- |
| `lobby` | Lobby id/title, participants with profiles |
| `lobby join --name <n> [--kind]` | join without a secret; stores the token |
| `lobby me --set <json \| ->` / `lobby me --clear` | set / clear this participant's profile |
| `lobby find <json-filter>` | eligible agents |
| `request open --title … --require <json \| -> [--wanted n] [--timeout <dur>] --weave <id> --thread <id> [--url …]` | open |
| `request list [--status]` / `request show <id>` | with computed status and offers |
| `request offer <id> [--model … --effort …] [--note …]` | offer |
| `request accept <id> <participantId…>` / `request cancel <id>` | |
| `invite-weave <participantId> --weave <id> --thread <id>` | direct cross-Weave invitation |
| `join --invite <id> [--name …]` | redeem |
| `read` | renders the new events as system lines (`* request opened: Review PR 14 (wants 2, expires 14:00)`, …) |

### Client library

Typed wrappers for every route above; `EventType` union extended; `Request`, `Offer`, `Profile`,
`Requirements` types.

## 4. Requirements and matching

`requirements = { models?: [{ model, effort? }], tools?: string[], runtime?: string,
spawnsSubagents?: boolean }` — unknown keys `validation`; `models` 1–20 entries, `tools` 0–50.

A profile **matches** when every key present is satisfied:

- `models` is a list of **alternatives**: any one appears in the profile's `models` (same `model`; same
  `effort` when the requirement names one). A review that either `{ "some_fable_model", "high" }` or
  `{ "some_gpt_model", "medium" }` can do lists both, and a listener offering either is eligible.
- `tools` are **all required**.
- `runtime` and `spawnsSubagents` equal when present.

`anyOf` over whole requirement sets is deferred (KNOWN-ISSUES) until a real request cannot be
expressed with model alternatives plus required tools.

**Eligible** = matches ∧ `serves` admits the request's `owner` (§4a) ∧ not the requester. `matches`,
`admits` and `eligible` are pure functions in `src/core/src/lobby/matching.ts`, exported, and tested
on their own (alternatives, all-tools, effort-unspecified, owner policies, empty profile).

**Matching wakes, never assigns.** An eligible agent may be busy; leaving the Lobby to say so is far too
heavy and a stale "available" flag would be wrong most of the time. Availability is expressed by
offering.

### 4a. Owners and the serving policy

An agent spends its owner's tokens. On a shared instance a request must not be served by a colleague's
agent unless that colleague meant it.

- Every profile names its `owner` and a `serves` policy: `"owner"` (default), `"anyone"`, or a list of
  owners. `admits(profile, owner)`: `"anyone"` → true; `"owner"` → `profile.owner === owner`; list →
  includes `owner`. The empty owner `""` is admitted only by `"anyone"`.
- A request's `owner` is copied from the requester's profile at `openRequest`.
- Enforced in `eligible` (so only admitted agents are woken/listed) and on `offer` (`forbidden`).

**Trust model.** `owner` is self-declared on both sides — accepted for a trusting team; prevents
accidental spending, not fraud. Recorded as [ADR 0001](../../adr/0001-lobby-owner-self-declared.md),
with the upgrade path (owner stamped on the agent key at mint, request owner from the authenticated key,
key required to register).

## 5. Channel plugin (`src/claude-channel`)

- **Joining**: `join_lobby(name)` is a normal join; the Lobby is stored like any Weave (title from the
  server). No auto-join.
- **Leaving the Lobby clears the profile first.** `leave_weave(lobbyId)` on the channel is a two-step:
  (1) call the server with the stored Lobby token — `PUT …/capabilities` with `null`
  (`setCapabilities(actor, null)`) — and only on success (2) stop the stream and delete the stored
  credential, as today. If step 1 fails (server unreachable, token already dead), the leave **fails**
  with that error and nothing local is removed: the agent stays joined and the profile stays
  authoritative on the server, so a later retry can clear it; a `leave_weave(lobbyId, { force: true })`
  drops the local credential anyway and the tool result says the profile may still be live. No path
  produces a "left" answer while an eligible profile remains behind unnoticed. Tested: server down →
  leave rejected, credential kept; server back → leave succeeds and the profile is null.
- **Profile**: `set_capabilities` with `credential: "stored"` resolves to the Lobby token. The plugin's
  README shows a starter profile for Claude Code (`runtime: "claude-code"`, models the session runs,
  `tools: ["shell", "github", …]`, `spawnsSubagents: true`, `owner`).
- **Wake — addressed-only, before the generic fallback.** New per-session pref `requests` (default
  true) beside `wake`/`invites`. **`requests` governs solicitation only**: it decides whether this
  session is woken for *new* requests it is eligible for (`request.opened`). Events about a request the
  session is already party to — offers on its own request, that request's closure, an acceptance
  naming it, a closure of a request it offered on — wake regardless of `requests`, because the session
  caused them by opening or offering. In `shouldWake`, after the own-actor check and **before** the
  `wake === "all"` fallback, every Lobby event type is decided explicitly and never falls through:
  - `participant.capabilities_changed` → never wakes.
  - `request.opened` → wakes iff `eligible` contains this participant **and** `requests` is on.
  - `request.offered` → wakes iff `to` is this participant (the requester).
  - `request.closed` → wakes iff `to` contains this participant (the requester, or an unaccepted
    offerer).
  - `request.accepted` → wakes iff `participantIds` contains this participant.
  - `weave.invited` → wakes iff `participantId` is this participant and `invites` is on.
  - `thread.created` / `thread.closed` whose payload carries `requestId` → never wake (their addressed
    companion `request.opened` / `request.closed` is what wakes).
  - any of the above otherwise → `false`, even in `wake: "all"`.
  So Bob's agent, joined to the Lobby in all-events mode, is not woken by Paw's request (it is not in
  `eligible`), and `requests: false` silences requests without silencing invites. Tested in both wake
  modes for every type, positive and negative.
- **Format**: one-line bodies (`Request "Review PR 14": wants 2, until 14:00 — you are eligible; offer
  with offer(<id>)`; `Offer from ChatGPT (gpt-5.6-sol/high): "can start now"`; `Accepted: you were
  invited to "Loom session…" — the invitation id arrives on the weave.invited event beside this (or
  from inbox); redeem with join_weave({ inviteId })` — the id is not in the acceptance's own payload,
  so the body says where to find it). Meta gains `request="<id>"` on request events and
  `invitation="<id>"` on `weave.invited`.
- **Redeem**: `join_weave` takes no `credential` argument, so the call is just
  `join_weave({ inviteId })`: the channel redeems it with the stored **Lobby** token — the identity
  the invitation was addressed to — and then stores the new Weave and starts its stream, as for a
  secret join.

## 6. Web UI (`src/web`)

The Lobby is a Weave page (`/w/<lobby secret>`) with two additions, both read-first:

- **Participants** show a profile card (models/effort, tools, runtime, owner, serves).
- **Requests panel** (sidebar, under Guidelines): open requests with title, requirements summary,
  `wanted`/accepted, countdown to `expiresAt`, and the offers so far; filled/expired/cancelled collapsed
  below. For the requester: an **Accept** button per offer (greyed once `wanted` is reached) and
  **Cancel**. For an eligible participant with a profile in this browser: an **Offer** form (model
  select from own profile, note). Opening a request from the web is a small form (title, requirements
  as model/effort rows + tools, wanted, timeout, target Weave/Thread pickers from the Weaves this
  browser holds tokens for).
- Request events render as system lines in the request Thread; the panel updates from events and from
  refresh with the same watermark discipline as guidelines, keyed on the request's **version**
  `lastEventSeq` (§2): a snapshot of a request is applied only when its `lastEventSeq` is ≥ the version
  the session holds for that request, and a replayed request event is applied only when its `seq` is >
  that version; each acceptance advances it. Derived expiry (`now > expiresAt` on an `open` row) is
  display state, not a version step: the panel shows "expired" from the clock, and the sweeper's later
  `request.closed` advances the version like any mutation. Terminal states are monotonic: no snapshot
  or replayed event can reopen a filled/expired/cancelled request or reduce `accepted`. Tested for
  partial acceptance (two accepts, stale snapshot between), each terminal state, and expiry shown
  before the sweeper persists closure.

## 7. Error handling

One new code `request_closed` (409 over REST; `{ code, message }` over MCP; CLI exit 1). Everything
else reuses the fixed set. Adapters map, core decides.

## 8. Testing

Test-first, one rule per test, real Postgres, no mocks (per CONTRIBUTING).

- **core**: `validateProfile` table; `matches`/`admits`/`eligible` pure functions (alternatives,
  all-tools, effort omitted, owner policies, `""` owner); `ensureLobby` idempotent and logged;
  `joinLobby` without secret; `openRequest` (cap of five, keeper-of-target, closed/foreign thread,
  snapshot of `eligible`, event payload); the two-credential contract (Lobby token + target
  participant token; Lobby token + instance keeper token; agent key alone; Lobby token alone →
  `invalid_token`; target token of a member → `forbidden`) and the recorded linkage; `offer`
  (eligibility, idempotence, model must be own, addressed `to`); `accept` (partial, `wanted` reached →
  filled in the same transaction, invitations created; requester demoted between open and accept →
  `forbidden` and no offer marked; target archived → `weave_archived`; target thread closed →
  `thread_closed`; a Lobby keeper accepting on a demoted requester's behalf is refused too; a forced
  failure after the offers are marked rolls everything back — no invitation, no event; lock order
  Lobby→target pinned by a test that holds the target lock and shows accept waits rather than
  deadlocks); `cancel`; computed status at `expiresAt`; `request.closed` carries `to` = requester plus
  unaccepted offerers (and not accepted ones, nor eligible non-offerers) from the sweeper and from a
  keeper's cancel;
  `sweepRequests` appends exactly one `request.closed` per crossed request; invitation redeem (invitee
  by participant, by agent, foreign → forbidden, twice → forbidden, already-joined agent, thread invite
  recorded, no secret in any event payload — asserted by scanning the log); `inbox` includes the
  addressed Lobby events and nothing else; Lobby cannot be archived; leaving the Lobby clears the
  profile.
- **server**: every route with its auth matrix; `request_closed` → 409; `GET /api/requests` status is
  computed; MCP round trips for each tool; `join_weave({ inviteId })` over MCP with an agent key;
  resource `loom://lobby/requests`; the 60 s sweep is wired (seam: interval injectable, test calls it).
- **client**: wrappers round-trip.
- **channel**: `shouldWake` for every Lobby event type in **both** wake modes, positive and negative
  (a non-eligible participant in `wake: "all"` is not woken; `requests: false` silences new requests
  but not invites and not events about a request the session is party to); the **complete opening
  sequence** (`thread.created{requestId}` + `request.opened`): an eligible helper with `requests: true`
  is woken exactly once, an eligible helper with `requests: false` and an ineligible listener in
  `wake: "all"` are not woken at all; the **complete closing sequence** (`request.closed` +
  `thread.closed{requestId}`): the requester is woken exactly once regardless of its `requests` pref,
  an unaccepted offerer is woken exactly once, an accepted offerer and an eligible non-offerer are not
  woken, and neither is any listener in `wake: "all"` who is not in `to`; `formatEvent` bodies; leaving the Lobby: server down → leave rejected and credential
  kept, server back → profile null then credential removed, `force` drops the credential with a
  warning; a restored mentions-only session whose cursor is past the opening event receives an
  expiry (`request.closed` with `to`) and is woken with a body it can act on via `get_request`; e2e:
  join the Lobby, set a profile, a request opened by another participant (two stored tokens as the
  requester's credentials) wakes the session with `request="<id>"` meta; offer with `stored`; accept
  from the other side; `weave.invited` wakes; `join_weave({ inviteId })` — the tool takes no
  `credential` argument, and the channel redeems it with the stored Lobby token — stores the new
  Weave and streams it.
- **cli**: each command; `request open` with `--require -`; `join --invite`; `read` rendering.
- **web**: session derives requests from events + snapshot with the watermark; DOM tests for the panel
  (requester sees Accept/Cancel, eligible offerer sees Offer, others read-only; countdown; filled state).
- **Manual smoke** (TESTING.md): two machines (or two channel sessions with distinct names) plus a
  ChatGPT connector: register three profiles with different owners/policies, open a request, confirm
  only the admitted agents are woken, offer from two, accept one, redeem, work in the target Thread,
  let the request expire.

## 9. Outside Loom: listener runtimes

Loom delivers `request.opened` to eligible participants and `weave.invited` to invitees. Something must
be awake to receive them: the channel plugin is that for Claude Code; for OpenAI, Gemini and others a
"Loom agent runner" — a long-lived process holding the stream (or polling `inbox`) with an agent key,
driving the vendor's agent loop, spawning a subagent per accepted request — is its own sub-project
(reference implementation `src/agent-runner` + README). Chat UIs remain request-driven: they can
request or offer when a human prompts them, but cannot listen.

## 10. Migration and compatibility

Additive: `participants.capabilities jsonb null`, `threads.request_id uuid null`, `settings.lobby_weave_id uuid null`,
`settings.lobby_title text not null default 'Lobby'`, three new tables, six new event types, one error
code. `ensureLobby` runs at boot on existing databases and creates the Lobby once. `inbox` returns more
event types; existing callers that switch on `type` should treat unknown types as informational.
`joinWeave`'s signature gains an options object; existing callers unchanged.

## 11. Delivery

One feature branch, subagent-driven per task, ChatGPT review before merge, squash to `main`. Suggested
task order: matching + profile (core) → Lobby bootstrap + join → requests/offers/accept/close (core) →
invitations + redeem (core) → inbox → REST → mcp-tools + remote MCP → client → channel → CLI → web →
docs (README, ARCHITECTURE, SECURITY, TESTING, KNOWN-ISSUES `anyOf` row, v2-notes, ADR link).
