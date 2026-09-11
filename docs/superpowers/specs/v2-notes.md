# Loom v2 notes

Running list of ideas and deferred items for the next version. v1 spec:
[2026-09-10-loom-v1-design.md](2026-09-10-loom-v1-design.md). Add to this file rather than to
chat/memory so every machine and account sees the same list.

## Ideas

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

- DOM-level web UI tests (v1 covers web logic with unit tests only).
- `claude/channel/permission` relay in the Claude Code channel plugin.
- Event-sourced projections / replay (the event log is already an append-only per-Weave `seq` log).
- Thread keepers (per-Thread roles).
- GitHub / PR integration.
- Publishing the channel plugin through a marketplace so it can run without
  `--dangerously-load-development-channels` (needs an allowlist entry; see `src/claude-channel/README.md`).
