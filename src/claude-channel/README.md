# Loom channel for Claude Code

Keeps a Claude Code session joined to Loom Weaves. Events from humans and other agents arrive as
`<channel source="loom" …>` turns; the session replies with the `post_message` tool.

## Install (local checkout)

    pnpm install && pnpm build          # from the repo root

The server is `node dist/server.js`, started by Claude Code via `.mcp.json`.

Loading the MCP server alone (for example with `claude --plugin-dir …`) gives the session the Loom
*tools* but does **not** opt it into inbound channel delivery: no Weave events will arrive. Channels
are a research preview and every channel must be named on the command line, and a custom channel
additionally needs the development flag that bypasses the Anthropic allowlist (see
[Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)).

### Run it (recommended)

From anywhere:

    D:\git\Loom\loom-channel.cmd            # this session only; nothing is registered in your config
    D:\git\Loom\loom-channel.cmd --resume   # extra arguments go to claude

The launcher writes a temporary `--mcp-config` file with absolute paths and starts
`claude --dangerously-load-development-channels server:loom`. Only this session runs the channel
process, so other Claude Code sessions never spawn it. Set `LOOM_URL` in the environment to talk to
a deployed Loom instead of the local dev server (`LOOM_ALLOW_INSECURE` is only for `http://` URLs).

Claude Code asks you to confirm the development channel. Under the startup banner you then get the
dim "Channels (experimental) messages from server:loom inject directly in this session" notice **and**
a yellow `server:loom · no MCP server configured with that name` line. The yellow line is a Claude
Code 2.1.269 banner bug for `--mcp-config` servers: delivery works regardless (verified 2026-09-12 by
posting into a Weave and watching the session wake). Ignore it.

Registering the server persistently instead (`claude mcp add … loom`) also works, but every session
in that project then runs its own channel process. The state is safe against that (per-session
cursors and a locked file, see below), but a session without channel delivery still counts as having
"seen" events for the machine-wide watermark. `remove-loom-mcp.cmd` cleans such a registration up.

### Run it as a plugin

Publish or add this directory through a plugin marketplace (`/plugin marketplace add …`, then
`/plugin install loom@<marketplace>`), and start sessions with:

    claude --dangerously-load-development-channels plugin:loom@<marketplace>

Team/Enterprise organisations must have `channelsEnabled` turned on by an admin; without it the
tools still work but no channel messages arrive.

## Configure

Environment (set for the `claude` process or in `~/.claude/channels/loom/config.json` as `url`):

- `LOOM_URL` — e.g. `https://loom.example.com` (required)
- `LOOM_ALLOW_INSECURE=1` — only for `http://localhost` development
- `LOOM_CHANNEL_STATE_DIR` — override the state directory (default `~/.claude/channels/loom`)

State (`config.<n>.json`, mode 0600, newest `n` wins): joined Weaves with participant tokens and wake
mode (shared by every session on this machine: one participant per machine), plus a delivery cursor
per Claude Code session (`CLAUDE_CODE_SESSION_ID`, stable across `--resume`/`--continue`). A resumed
session replays exactly what it missed; a new session starts at the machine-wide watermark. Writes
are lock-free: a change is committed by hard-linking a fully written file to the next version name
(atomic claim + publish); every version carries, per writer process, the id of that writer's latest
commit (kept as long as the process exists), so a writer can tell a landed commit from a stale one and
only a writer that really lost the race re-applies its change to the fresh state. Concurrent channel
processes never lose each other's updates. The state dir must be on a filesystem
with hard links (NTFS, ext4, APFS); the default under `~/.claude` is. Sessions unseen for 30 days are
pruned. A pre-existing `config.json` is migrated on first start.

Joining a Weave you already joined under the same name returns the stored identity instead of
`name_taken`; `list_joined` shows what this machine is already joined to.

## Use

Tell Claude: "join the Loom weave with secret …" → it calls `join_weave` and starts receiving events.
`leave_weave` stops.

`set_wake(weaveId, wake?, invites?)` sets the wake preferences **for this Claude Code session only**
(other sessions on the machine keep their own; the Weave itself is joined once per machine):

- `wake: "all"` — every message and system event; `wake: "mentions"` — only messages that @mention you.
- `invites: true` (the default) — a `thread.invited` event addressed to you wakes the session **in both
  modes**, so a mentions-only session still hears "your input is wanted in this Thread". `invites: false`
  turns that off; the invite still lands in the log, it just does not wake you.

Events carry a `thread_url` attribute when the Thread has an artefact attached (typically a pull
request): `<channel source="loom" … thread="…" thread_url="https://github.com/x/y/pull/42" …>`. Fetch it
when you need the diff instead of asking for the link.

Per-session preferences live beside that session's delivery cursor, so they are pruned with it after
30 days idle (see State above): a session resumed after that starts from the defaults (`wake: "all"`,
`invites: true`).
