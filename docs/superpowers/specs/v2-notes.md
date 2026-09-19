# Loom v2 notes

Running list of ideas and deferred items for the next version. v1 spec:
[2026-09-10-loom-v1-design.md](2026-09-10-loom-v1-design.md). Add to this file rather than to
chat/memory so every machine and account sees the same list.

## North-star scenario (Paw, 2026-09-12)

A **Weave is a working session**: for example "Loom v1 review + channel fixes, 2026-09-11/12", with
the human and every agent involved (Claude Code via the channel, ChatGPT via the `/mcp` connector)
as participants. **Each PR gets its own Thread** inside that Weave; General carries the running
conversation about what we are doing.

This came from watching PR #4's review loop: four ChatGPT review rounds, every hop mediated by the
human ("see review on PR"), findings and replies exchanged as GitHub comments, and the reviewer only
seeing the counter-argument on its next full pass. In Loom, a finding is a message in the PR's
Thread, the implementing agent answers it in place ("real, fixing" / "pushback: …"), the reviewer
reacts to that reply, and the human reads the transcript and steps in only on disagreement.

What v2 needs for it, in priority order — **items 1–3 are delivered by sub-project 1**
([2026-09-12-loom-v2-review-loop-design.md](2026-09-12-loom-v2-review-loop-design.md)):

1. ~~Thread invites (see below): the reviewer is invited into the PR's Thread; it wakes for that
   Thread, not for the whole Weave.~~ **Done**: `invite_participant` / `loom invite`, a
   `thread.invited` event, `inbox` for remote agents, and channel wake-on-invite even in
   mentions-only mode (per-session `set_wake(weaveId, wake?, invites?)`).
2. ~~Stable agent identity and delivery cursors across sessions (done in PR #4 for the channel):
   the reviewer and the implementer must not lose each other on restart.~~ **Done**: per-session
   cursors in PR #4, plus **agent keys** (`loom admin agents add <name>` → `/mcp?agent=<key>`) so a
   remote MCP client has one identity across connections without holding a token in context.
3. ~~Something that ties a Thread to its artefact (a PR URL as Thread metadata, or the PR link in the
   Thread's opener) so agents can find the diff without being told.~~ **Done**: a Thread `url`
   (`create_thread(url)` / `set_thread_url` / `loom thread new --url` / `loom thread url`), carried on
   every event from that Thread and as the channel's `thread_url` attribute.

## Ideas

### Guidelines handed to every AI on connect (Paw, 2026-09-12) — **shipped in sub-project 2**

Built as specified below, to
[2026-09-15-loom-v2-guidelines-design.md](2026-09-15-loom-v2-guidelines-design.md): two layers
(`settings.guidelines`, `weaves.guidelines`), 4000 characters each, composed by `guidelinesFor` and
returned as `guidelines` on `create_weave` / `join_weave` / `get_weave`; the instance layer in both
surfaces' MCP `instructions` (read per new remote session, fetched under a 2 s deadline by the
channel) and readable with no credential at `GET /api/guidelines`; the resources `loom://guidelines`
and `loom://weaves/{weaveId}/guidelines`; a `weave.guidelines_changed` event carrying
`{ guidelines, previous }`; `set_weave_guidelines`, `loom guidelines [set]`,
`loom admin settings --set guidelines=…`, and a Guidelines panel in the web UI. One thing landed
differently: the channel folds a Weave's guidelines into the *first woken event* of a session as a
`preamble="guidelines"` attribute on that event's own turn, rather than sending a separate
`type="weave.guidelines"` turn ahead of it — see the spec's §4 note.

The original note:

Loom should give an AI **guidelines for how to use Loom** each time it connects. Today both MCP
surfaces send a fixed `instructions` text on connect (remote `/mcp` and the channel plugin), but it
is hard-coded in the repo and covers mechanics only (tags, tools, credentials).

v2: make the guidelines **Loom-owned and keeper-editable**, layered:

- **Instance guidelines** (instance keepers): conduct for every agent on this Loom, e.g. "reply in
  the Thread you were addressed in", "state pushback with reasons, do not just comply", "do not
  paste secrets", "keep replies short, link to artefacts".
- **Weave guidelines** (Weave keepers): what this Weave is for and its house rules, e.g. review
  etiquette for a "PR reviews" Weave.
- Delivery: instance guidelines in the MCP `instructions` on connect (both surfaces) and returned
  by `join_weave`/`create_weave`; Weave guidelines returned by `join_weave`, `get_weave`, and pushed
  as a `weave.guidelines_changed` event so already-connected agents see updates. Remote MCP sessions
  can also expose them as an MCP resource.
- Storage: text fields on settings (instance) and weaves (Weave), editable via admin/keeper tools,
  CLI, and the web UI; changes are events (`weave.guidelines_changed`) so they are auditable.
- Keep the built-in mechanics text separate and non-editable; guidelines are appended to it.

### Thread invites for AI participants (Paw, 2026-09-11) — **shipped in sub-project 1**

Paw's idea: when an AI is registered as a participant in a Weave, it can be **invited to Threads** —
a targeted "your input is wanted here", not an access change. Built as:

- **A distinct event type.** `thread.invited` carries the invitee, the Thread and the inviter, so the
  AI side listens for invites and not only for messages and @mentions. The channel wakes a session on
  an invite addressed to it in **both** wake modes (`all` and `mentions`), as Paw asked.
- **The agent-side opt-out.** `set_wake(weaveId, invites=false)` stops the wake-ups for that Claude
  Code session; an agent whose own instructions or memory say to ignore invites simply does nothing
  with one. The opt-out stays on the agent side — Loom's server does not know about it.
- **The server action.** `invite_participant` (REST + MCP + `loom invite <threadId> <participantId>`),
  restricted to the Thread's creator and Weave keepers, and idempotent: inviting twice returns the
  first invite's seq. Remote agents that cannot be woken read pending invites with `inbox`.

### Lobby: agent discovery and cross-Weave requests (Paw, 2026-09-14/16) — **shipped in sub-project 3** ([PR #14](https://github.com/poteb/Loom/pull/14))

Built as specified in [2026-09-16-loom-lobby-design.md](2026-09-16-loom-lobby-design.md), across
core (`src/core/src/lobby/*`, migration `0003`), the REST routes `/api/lobby` and `/api/requests`,
the client wrappers, ten MCP tools plus `join_weave({ inviteId })` and the `loom://lobby/requests`
resource, the Claude Code channel (addressed-only wake rules, a `requests` preference, the two-step
leave), the CLI (`lobby`, `request`, `invite-weave`, `join --invite`) and the web UI (profile cards
and a requests panel with a per-request version watermark). The trust model is
[ADR 0001](../../adr/0001-lobby-owner-self-declared.md).

The original note:

One Lobby Weave per instance where every agent registers a capability profile (`models: [{ model, effort }]`, tools, runtime, spawns subagents); a requester opens a first-class request with machine-readable requirements, `wanted: N` and a timeout; matching participants are *woken*, the free ones *offer*, the requester *accepts* up to N, each accepted agent gets a single-use cross-Weave invitation (no secret in any event) and redeems it with its own credential; profiles carry an `owner` and a `serves` policy so a request never spends a colleague's tokens (self-declared for now, [ADR 0001](../../adr/0001-lobby-owner-self-declared.md)). Listener runtimes per agent family live outside Loom. Spec: [2026-09-16-loom-lobby-design.md](2026-09-16-loom-lobby-design.md).

Follow-ups this left open — ideas, not defects (the defects are rows in
[../../KNOWN-ISSUES.md](../../KNOWN-ISSUES.md)):

- **A Loom agent runner per vendor.** The Lobby delivers `request.opened` and `weave.invited`, but
  only the Claude Code channel is awake to receive them. ChatGPT, Codex, Gemini and the rest need a
  long-lived process holding the stream (or polling `inbox`) with an agent key, driving the vendor's
  agent loop and spawning a subagent per accepted request. Its own sub-project (spec §9), with
  `src/agent-runner` as the reference implementation. Until it exists, a remote agent can request
  and offer when a human prompts it, but cannot be woken — the same manual trigger the north-star
  run of 2026-09-16 identified as the last human step left in the loop.
- **`anyOf` over whole requirement sets.** `requirements` today is flat: `models` are alternatives
  and `tools` are all required, so "either a Fable with shell, or a GPT with github" cannot be
  expressed. Deferred in the spec (§4) until a real request needs it; the shape would be
  `anyOf: Requirements[]`, matched by `some`.
- **Authenticated owners.** The ADR's upgrade path: stamp `owner` on the agent key at mint
  (`loom admin agents add <name> --owner <owner>`), derive a request's owner from the authenticated
  key, and require a key to register a profile. Trigger: the first Loom instance shared beyond a
  single trusting team.
- **Invitations that expire.** `weave_invitations` has no TTL and a cancelled or expired request does
  not revoke one already issued. An `expires_at` defaulting to the request's deadline would close
  that, at the cost of a helper who redeems late finding the door shut.
- **A second Lobby, or private ones.** Explicitly out of scope: one per instance, like joining a
  Discord server. Revisit only if a single instance ever hosts teams that should not see each
  other's requests — at which point the Lobby's public join (SECURITY §4a) is the thing to reopen.

### Claude Code skills for Loom (Paw, 2026-09-17)

Loom is driven from a Claude Code session entirely by prose: every step of the Lobby smoke test
needed a hand-written prompt carrying the exact tool name and arguments, down to the JSON of a
profile. Ship **skills** that carry that knowledge instead — a "join Loom" skill (pick a name the
validator accepts, join the Lobby, set a starter profile with `owner` and `serves`, and explain what
`credential: "stored"` means so the agent stops asking for a token), and likely companions: open a
request for a PR review, the offer/redeem flow from the helper's side, and leaving cleanly (profile
first, then the credential). The channel's MCP `instructions` and the guidelines cover mechanics; a
skill is what turns "ask the Lobby for a reviewer" into the right four calls.

### Web client layout for a busy instance (Paw, 2026-09-17)

The web UI's sidebar stacks Threads, Guidelines, Requests and every listener's full profile card in
one column. That reads well with three participants and one request, and will not survive hundreds
of listeners, Weaves and Threads. Needs a scale-aware layout: a collapsed, searchable listener list
with cards on demand, paged and filterable Threads and requests, and a Weave switcher. It meets the
cursor-less `listRequests` row in [../../KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) — paging the UI
needs a cursor the API does not have yet.

Still open after sub-project 4. The main page's My Weaves has the filter-and-"Show more" shape this
idea wants (and refreshes at most six rows at a time), but the Weave page itself is untouched: the
sidebar still stacks everything, and a Weave switcher is exactly the thing My Weaves is not. Its
**first slice** is the Lobby listeners page below — the listener column, done properly.

### A web main page: joining the Lobby from a browser (Paw, 2026-09-17) — **shipped in sub-project 4** ([PR #17](https://github.com/poteb/Loom/pull/17))

Built as specified in
[2026-09-17-loom-web-main-page-design.md](2026-09-17-loom-web-main-page-design.md), entirely in
`src/web` plus seven static routes in `src/server`: the session takes a `SessionTarget` union
(`{ kind: "secret" }` or `{ kind: "id" }`) and reads an id target with the stored participant token,
falling back to a stored Weave secret when the identity has been invalidated; routes `/`, `/lobby`
and `/weave/<id>` beside the unchanged `/w/<secret>`; storage is one entry per Weave at
`loom:weave:<weaveId>`, with the old `loom:<secret>` entries migrated lazily and never lost; and the
main page carries the instance guidelines, a Lobby summary, the Join-the-Lobby form, My Weaves
(rendered from cached titles, refreshed lazily behind a six-in-flight bound) and a Create-a-Weave
form with its save-this-link moment. **No core rule and no route authorization changed.**

Two things the spec did not foresee and the implementation settled: a write now reports whether it
persisted (`WriteResult`), and a join or creation whose credential reached only memory renders its
destination **in place** rather than navigating away from the only copy of it — with a one-time
notice shared by the main page and the Weave pages; and the stored entry gained a `name` field, the
name this browser joined under, so "joined as `dana`" renders from storage with no request. The Lobby
summary shows counts only to a browser that already holds a Lobby token, so nothing new is readable
anonymously (SECURITY §4a) — what the page does add is discoverability of the already-public join.

The original note:

There is no page at `/`: a Weave is reachable only as `/w/<secret>`, so a **human** cannot join the
Lobby from a browser at all — the Lobby is joined without a secret, but nothing in the web client
offers that. It needs a token-based session load path (the browser holds a participant token rather
than a Weave secret) plus a landing page that lists what this instance has and offers the join.

### Lobby listeners page (Paw, 2026-09-19) — spec written, awaiting review and planning

Spec: [2026-09-19-loom-lobby-listeners-design.md](2026-09-19-loom-lobby-listeners-design.md). The
first slice of [Web client layout for a busy instance](#web-client-layout-for-a-busy-instance-paw-2026-09-17).

The Lobby sidebar renders every listener's full profile card, and `getWeave` ships every profile on
every load and every refresh — with thousands of listeners that is both an unreadable column and a
multi-megabyte answer. The design: a new paged core query `listListeners(actor, query)` — search on
name or owner, filters on models (any-of, with an optional effort), tools (all-of), runtime and
`serves`, all ANDed; `sort` `name|owner|joined` in both directions on a `(sort key, id)` cursor;
`total`, `matched` and facet counts (top 20 each, computed over the result minus that facet's own
filter); filtering in SQL over the `jsonb` profile behind a partial GIN index. `getWeave` stops
returning `capabilities` for Lobby participants other than the caller's own; `find_agents` is
unchanged. REST `GET /api/lobby/listeners`, a client wrapper, one more enumerated static route, and
a page at `/lobby/listeners` with the existing `ProfileCard` in a grid; the Lobby sidebar becomes
one **Listeners (N)** line. Read-only: no actions on a listener, and no MCP tool or CLI command in
this change.

**Later (Paw, 2026-09-19).** Reuse the facets as **dropdown-with-free-text wherever a model, tool or
runtime is entered** — the Open-a-request form and a listener's own profile — so the common answer
is one click and an unusual one is still typeable. How **new** models are introduced is undecided
("we'll figure that out later"): a facet only knows what somebody has already registered, so the
first listener to run a new model must type it, and a typo becomes a facet row that looks official.

## Deferred from v1

Listed as out of scope in the v1 spec or recorded during implementation:

- Pushing into a remote agent's platform (waking ChatGPT/Codex/Claude Desktop from Loom): those
  platforms offer no inbound path today; remote agents act when prompted and catch up with `inbox`
  (v2 sub-project 1). Revisit when a scheduler/webhook surface exists.

- DOM-level web UI tests (v1 covers web logic with unit tests only).
- `claude/channel/permission` relay in the Claude Code channel plugin.
- Event-sourced projections / replay (the event log is already an append-only per-Weave `seq` log).
- Thread keepers (per-Thread roles).
- GitHub / PR integration.
- Publishing the channel plugin through a marketplace so it can run without
  `--dangerously-load-development-channels` (needs an allowlist entry; see `src/claude-channel/README.md`).

## Dogfood findings (2026-09-11, first live run)

What worked: web UI ↔ remote MCP (`/mcp` through a Cloudflare quick tunnel) as a claude.ai custom
connector, live WebSocket updates in the browser, @mentions across the remote path, and the Claude
Code channel plugin end to end on a personal (Max) account: a message posted through the connector
arrived in the channel-enabled session as a `<channel source="loom">` turn and it replied with
`credential="stored"` within 12 s.

- ~~Channel state is per machine, not per session~~ **Fixed 2026-09-12**: locked read-merge-write
  state (later replaced by lock-free versioned commits), per-session delivery cursors keyed by `CLAUDE_CODE_SESSION_ID`, and `loom-channel.cmd`
  (`--mcp-config`, this session only). Claude Code 2.1.269 prints a misleading
  `server:loom · no MCP server configured with that name` banner line for `--mcp-config` servers;
  delivery works regardless (verified). Worth reporting upstream. Claude Code gives the
  server no signal that a session is channel-enabled (verified: env and `initialize` are identical),
  so a *persistently registered* tools-only session still counts as having seen events. Original note:
  Channel state is per machine, not per session. Every Claude Code session in a project that
  has the `loom` MCP server registered spawns its own channel process, and all of them share
  `~/.claude/channels/loom/config.json` and stream the same Weaves. Observed with three processes
  at once: a session without channel delivery consumed the offline event and persisted
  `lastSeq`, so the channel-enabled session started with nothing to replay and missed the message.
  Options: key state by session/pid, or a single long-lived channel daemon that sessions attach to.
- ~~Rejoin with the same name is not idempotent~~ **Fixed 2026-09-12** (`alreadyJoined: true`). Original note:
  Rejoin with the same name is not idempotent. The agent called `join_weave` for a Weave the
  channel already had stored under that name and got `name_taken`. `join_weave` should return the
  stored identity when the channel already holds a token for (weave, name); the instructions should
  also say "check `list_joined` first".
- **Org policy blocks delivery silently for the user.** On a Team/Enterprise account without
  `channelsEnabled`, the tools work (join succeeded) but no channel turns arrive and the startup
  notice is easy to miss. The README should say to check the plan/admin setting first.
- ~~**The agent must carry its token.**~~ **Fixed 2026-09-12** by agent keys: a keeper mints one per
  remote agent (`loom admin agents add <name>`), the connector URL is `<base>/mcp?agent=<key>`, and
  every connection acts as that agent — no `credential` on calls, and `join_weave` returns the same
  participant each time. Original note: Remote MCP clients hold the participant token in context and
  pass it on every call; a fresh session can't act. Consider a per-connection identity minted on
  `initialize`, or a token-lookup tool keyed by (weave, name) that the keeper approves.
- **Keeper tools are always advertised** (9 of the 34 tools need a keeper token — it was 6 of 17 when
  this was written; sub-project 1 added `inbox`, `set_thread_url`, `invite_participant` and the three
  `keeper_agents_*` tools, sub-project 2 `set_weave_guidelines`, which needs a *Weave* keeper, not an
  instance one, and sub-project 3 the ten Lobby and request tools). Clients with tool
  limits may prefer them hidden until a keeper credential is present. On an agent connection
  (`/mcp?agent=<key>`) they are pure noise — an agent key is never an instance keeper, so the
  connection default can never satisfy them — and the connection's identity is now known at
  `initialize`, so filtering them there is trivial; they are still registered today. The original
  question (hide until a keeper credential appears) remains open for anonymous `/mcp` sessions.
- **Cloudflare quick tunnel needs `--edge-ip-version 4 --protocol http2`** on this network; the
  tunnel API POST takes 5-10 s and the default times out. Worth a line in the README dev section.
- `run.cmd`/`run.ps1` die with a raw `EADDRINUSE` stack trace when a stale dev server holds port
  3000. Detect the listener and print which process owns it.

## Dogfood findings (2026-09-15, review-loop smoke test)

First live run of the v2 review loop — manual smoke test 2 from [../../TESTING.md](../../TESTING.md):
dev server + Cloudflare quick tunnel, with ChatGPT (desktop custom MCP connector, Streamable HTTP, no
auth, agent key in `?agent=`) as the remote agent. The whole loop worked: `join_weave` with the agent
key (no name needed), `loom thread new "PR 7" --url https://github.com/poteb/Loom/pull/7`,
`loom invite`, an @mention, and then a single prompt — "check your Loom inbox and act on it" — made
ChatGPT find the invite by Thread name + URL, fetch the PR, and post its summary in the PR Thread as
itself (seq 8); the web UI showed it on load. `loom admin agents revoke` then turned the next
`initialize` into a 401 `invalid_token`.

- **Keeper seeding is silently skipped when the table is not empty.** The dev database still held the
  keeper from the 2026-09-10 first boot, so a freshly generated `LOOM_KEEPER_TOKENS` was never seeded
  and every admin command failed with a bare `invalid_token`. Fix: log at boot when seeding is skipped
  because keepers exist (and how many), and say in README/SECURITY that a new token in `.env` does
  nothing on an existing database — use `loom admin keepers add` from an existing keeper, or clear the
  table.
- **`loom admin agents add` output confuses the agent id with the key.** It prints
  `Added agent "ChatGPT" (<id>)`, `key: <key>`, `connector URL: …?agent=<key>`; the uuid id was pasted
  into the connector URL instead of the key (both look like opaque tokens). Fix: label the id
  `id (for revoke): …`, print the connector URL as the one line to copy, and consider making `revoke`
  accept the agent name when unambiguous.
- **A revoked key makes the connector's tools vanish rather than error.** Correct on Loom's side (401
  `invalid_token` on `initialize`), but the agent only saw "Loom's tools are not in this session's tool
  list" and had nothing to report to the human. Document this in README under agent keys; nothing Loom
  can do about the client's behaviour.
- **The connector URL is pinned to the quick-tunnel hostname**, which changes on every
  `start_cloudflare_tunnel.cmd` start, so the connector must be edited each time. For repeated
  dogfooding a named tunnel or a fixed dev domain is needed (setup note, not a code change).
- **Compose Postgres moved to host port 5433** (PR #8) because another project's Postgres owns 5432 on
  the dev machine.
- **Walkthrough UX (process, not product):** hand-run steps must be given one at a time with real ids
  filled in; a list with `<placeholders>` was unusable with this many secrets and ids. Loom-side
  takeaway: the CLI should print the exact next command where it can — e.g. after `create`, print the
  `thread new`/`invite` shapes with the real ids.
- **What worked without help:** ChatGPT needed no Loom-specific coaching beyond the MCP `instructions`
  text — it used `inbox`, followed the Thread URL, replied in the right Thread, and reported "no
  further inbox items". Step 10 of the smoke test (the Claude Code channel side receiving the invite
  wake-up) was not run this time.

## Dogfood findings (2026-09-16, north-star run)

First run of the north-star scenario itself, with sub-projects 1 and 2 on `main` (056a94e): Weave
"Loom session 2026-09-16" created with Weave guidelines (review etiquette), Thread "PR 12" linked to
<https://github.com/poteb/Loom/pull/12>, ChatGPT joined through the remote connector (agent key in
`?agent=`), and Claude Code acting through the CLI (this account cannot use the channel plugin).
Sequence: `join_weave` returned both guideline layers verbatim (instance default + Weave rules) and
ChatGPT quoted them back correctly; invite + @mention posted in the PR Thread; one prompt ("check
your Loom inbox and act on it, following the guidelines") made ChatGPT find the invite via `inbox`,
review the PR (it also used its own GitHub PR-review skill and published a GitHub review), and reply
in the Thread in the guidelines' shape ("no actionable findings … ready for your merge decision");
the implementer acknowledged in the Thread. No content was relayed by the human — the human only
started ChatGPT's turn.

- **Guidelines delivery works.** Both layers arrived through `join_weave` and were followed (one
  message, `path:line` convention, an explicit "ready to merge" line). Nothing to change; this closes
  half 1 of sub-project 2's manual smoke test. Half 2 (a mentions-only channel session waking on a
  Weave guidelines change) is still unrun — it needs the personal account.
- **The human still starts every remote-agent turn.** ChatGPT acts only when prompted; the inbox makes
  the prompt trivial, but the trigger is manual. This is the deferred "pushing into a remote agent's
  platform" item, and the run confirms it is now the only human step left in the loop.
- **The implementer identity was the human's.** Claude Code posted through the CLI with Paw's
  participant token, so ChatGPT addressed its reply to `@Paw`. A faithful loop needs the implementer
  to have its own participant — an agent key for "Claude Code" via `LOOM_AGENT_KEY`, or the channel
  plugin. Suggest a `loom join … --name "Claude Code"` step in the smoke test, or documenting
  `LOOM_AGENT_KEY` as the CLI-side agent identity.
- **Connector type is easy to get wrong.** The custom-MCP dialog offers STDIO and Streamable HTTP;
  STDIO was picked once, and the symptom in ChatGPT is only "the connector's tools are not exposed to
  this task" plus a plugin-directory search — no error. README's connector paragraph should say
  "type: Streamable HTTP" explicitly and name that symptom.
- **Everything the reviewer needed was in the Thread.** `thread_url` carried the PR and `inbox` carried
  the invite with the Thread name; the review landed both in the Thread and on GitHub. The GitHub copy
  is redundant once the Thread is the record — sub-project 3 (GitHub integration) should decide which
  one is canonical.
- **The tunnel and agent key had to be recreated** (new hostname after every restart; the previous key
  revoked) — same note as 2026-09-15. A named tunnel would remove one setup step.

## Lobby smoke test 2026-09-17

Manual smoke test 4 from [../../TESTING.md](../../TESTING.md), on `main` at `c818ed3`, with three
owners: two `loom-channel.cmd` sessions on one machine (the second given its own
`LOOM_CHANNEL_STATE_DIR`) and ChatGPT as a remote connector over a Cloudflare quick tunnel. **All 12
steps passed and no product defect was found** — the serving policy decided who was woken, a scan of
the Lobby's whole event log found no Weave secret and no participant token in it, the repeated offer
was idempotent, the cross-Weave invitation was single-use, the sweeper closed both an empty and a
partially-filled request within 60 s of the deadline (leaving the redeemed invitation valid), and the
two-step leave cleared the profile before the credential. What it produced was documentation and
polish: three doc fixes folded back into the smoke test's own steps, four minor or cosmetic rows plus
a dev-environment one in [../../KNOWN-ISSUES.md](../../KNOWN-ISSUES.md), and three ideas.

- **Skills, not prompts.** Every step needed a hand-written prompt with the exact tool name and
  arguments — see [Claude Code skills for Loom](#claude-code-skills-for-loom-paw-2026-09-17) above.
- **The web client will not scale.** See
  [Web client layout for a busy instance](#web-client-layout-for-a-busy-instance-paw-2026-09-17).
- **A human cannot join the Lobby from a browser.** ~~See
  [A web main page](#a-web-main-page-joining-the-lobby-from-a-browser-paw-2026-09-17).~~ **Done**:
  the main page at `/` joins the Lobby by name, and `/lobby` and `/weave/<id>` open a Weave from a
  stored participant token — see that section.
- **The human still starts every ChatGPT turn** (steps 4, 8, 9 and 10) — the same "no listener
  runtime except the Claude Code channel" gap the 2026-09-16 north-star run ended on, now seen from
  the Lobby side: ChatGPT is *eligible* and is sent `request.opened`, but nothing is awake to read it.
