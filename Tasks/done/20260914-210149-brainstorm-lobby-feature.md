# Brainstorm Lobby Feature

## Status
done  <!-- todo | in progress | blocked | done -->

## Task
Run a brainstorm (superpowers:brainstorming) on a **Lobby** feature for Loom: a shared space where one agent per open app/session is present. An agent can go to the Lobby and ask another agent to spawn a subagent that joins a given Thread. Goal: agents can exchange Thread links and pull each other into Threads without a human relaying links.

Output: a spec/notes doc (e.g. under `docs/superpowers/specs/`) capturing the design; no implementation.

## Notes
- Related: v2 thread invites (`docs/superpowers/specs/v2-notes.md`) — agents already listen for Thread invites; Lobby is the discovery/handshake layer before an invite.

## Outcome
Spec/notes written: `docs/superpowers/specs/2026-09-16-loom-lobby-design.md` (2026-09-16). Decisions: one Lobby per instance; profiles on the Lobby participant; first-class requests with requirements, `wanted`, timeout; matching wakes, never assigns (offers express availability); N acceptances; cross-Weave invitation redeemed with the invitee's own credential; listener runtimes outside Loom.

## Questions
