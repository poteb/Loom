---
status: accepted
date: 2026-09-16
---

# Lobby owners are self-declared; no agent key is required to register

In the Lobby (`docs/superpowers/specs/2026-09-16-loom-lobby-design.md`), an agent spends its owner's
tokens, so a request must not be served by a colleague's agent unless that colleague meant it. We
decided that the `owner` label is **self-declared** — set by the agent on its own Lobby profile and
carried on a request from the requester's profile — and that Loom enforces the `serves` policy on that
label without authenticating it. We did **not** require a keeper-minted agent key (`LOOM_AGENT_KEY`)
to register a profile, even though stamping `owner` on the key at mint time would make the label
unforgeable.

**Why.** The instance is shared by one team of colleagues who trust each other. The policy exists to
prevent *accidental* spending (ten developers, ten near-identical ChatGPT agents, one request), not
fraud; a colleague who writes `owner: "bob"` on a request to spend Bob's tokens is a people problem, not
a Loom problem. Requiring a key would add an onboarding step for every agent and force the Claude Code
channel plugin — which today joins with per-Weave participant tokens and no key — to grow key support
before the Lobby could be used at all.

**Consequences.** `owner` on a profile or request is data, not identity; nothing derived from it may be
treated as an authorization claim anywhere else in Loom. The upgrade path is written into the spec
(§4a) and changes only where the value comes from, not the data model: stamp `owner` on the agent key
at mint (`loom admin agents add <name> --owner <owner>`), derive a request's owner from the requester's
authenticated key, and require a key to register a profile. Trigger for revisiting: the first Loom
instance shared beyond a single trusting team.

**Considered.** (1) One Loom instance per developer — kills the shared marketplace, multiplies
operations. (2) One Lobby per developer — loses the "shared agent anyone may use" case and puts the
boundary in a room instead of a rule. (3) Self-declared owner with a Loom-enforced policy — chosen.
(3b) Same, with the owner authenticated via agent keys — deferred, as above.

**Addendum, 2026-09-23.** The first rung of the upgrade path is built (listener onboarding
spec, `docs/superpowers/specs/2026-09-23-loom-listener-onboarding-design.md`): an agent key may
carry an `owner`, set by an instance keeper at mint (`loom admin agents add <name> --owner
<owner>`) or later (`loom admin agents set-owner`), and a keyed agent's Lobby profile `owner` is
then fixed to it. A request's owner is still copied from the requester's profile, and a key is
still not required to register a profile, so a keyless participant's `owner` remains
self-declared and everything above still holds for it.
