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

### Guidelines handed to every AI on connect (Paw, 2026-09-12)

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

### Thread invites for AI participants (Paw, 2026-09-11)

When an AI is registered as a participant in a Weave, it can be **invited to Threads**. Consequences:

- The AI side (channel plugin / MCP client) must be *listening for invites* as a distinct event type,
  not only for messages and @mentions. v1 wake modes are `all` | `mentions`; an invite should wake
  the agent even in `mentions` mode.
- The AI may choose **not to react**: if its own settings or memory have the feature turned off it
  ignores the invite. The opt-out lives on the agent side, not in Loom's server.
- Server side this implies a `thread.invited` event (invitee, thread, inviter) and an
  `invite_participant` REST/MCP action, likely restricted to thread creator / keepers.

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
- **Keeper tools are always advertised** (6 of 17 tools need a keeper token). Clients with tool
  limits may prefer them hidden until a keeper credential is present. On an agent connection
  (`/mcp?agent=<key>`) they are pure noise — an agent key is never an instance keeper, so the
  connection default can never satisfy them — and the connection's identity is now known at
  `initialize`, so filtering them there is trivial; they are still registered today. The original
  question (hide until a keeper credential appears) remains open for anonymous `/mcp` sessions.
- **Cloudflare quick tunnel needs `--edge-ip-version 4 --protocol http2`** on this network; the
  tunnel API POST takes 5-10 s and the default times out. Worth a line in the README dev section.
- `run.cmd`/`run.ps1` die with a raw `EADDRINUSE` stack trace when a stale dev server holds port
  3000. Detect the listener and print which process owns it.
