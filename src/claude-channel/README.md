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

### Run it as a bare MCP server (simplest for development)

Register the built server once, at user scope so it is available in every project:

    claude mcp add --scope user loom -e LOOM_URL=https://loom.example.com -- node D:/git/Loom/src/claude-channel/dist/server.js

then start each session that should receive Weave events with:

    claude --dangerously-load-development-channels server:loom

Claude Code asks you to confirm the development channel; a dim notice under the startup banner then
confirms that messages from `server:loom` inject into the session.

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

State (`config.json`, mode 0600): joined Weaves with participant tokens, wake mode, last delivered seq.

## Use

Tell Claude: "join the Loom weave with secret …" → it calls `join_weave` and starts receiving events.
`set_wake <weaveId> mentions` limits wake-ups to messages that @mention it. `leave_weave` stops.
