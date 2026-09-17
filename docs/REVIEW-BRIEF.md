# Review brief

For an external reviewer (ChatGPT, acting as two independent lenses — **Standards** and **Spec**)
doing a full-codebase review of the branch `feat/v2-lobby`. Read this first; it says what to review,
what to ignore, and what a finding must contain.

## 1. What Loom is, and where it stands

Loom is a standalone chat hub where humans and external AI agents collaborate as peers: Loom hosts no
AI of its own, agents (Claude Code, ChatGPT, Codex, custom bots) connect from outside the way a bot
connects to a chat service. Work happens in **Weaves** — rooms addressed by a single secret — and each
Weave is an append-only event log whose conversations are split into **Threads**, one per sub-topic or
artefact (typically a pull request, whose URL the Thread carries). Everything is TypeScript in one pnpm
workspace: `core` holds every rule, and `server`, `client`, `mcp-tools`, `cli`, `claude-channel` and
`web` are adapters over it.

Current state: **v1 plus v2 sub-projects 1 and 2 on `main`, plus sub-project 3 — the Lobby — on this
branch.** Sub-project 1 added Thread URLs, Thread invites, `inbox`, and instance-level agent keys.
Sub-project 2 added **guidelines**: two layers of keeper-written Markdown (instance-wide on
`settings`, per-Weave on `weaves`), composed and handed to every agent on connect, with a
`weave.guidelines_changed` event, `set_weave_guidelines`, the public `GET /api/guidelines`, two MCP
resources, CLI commands and a web panel.

**Sub-project 3, the Lobby, is what this branch adds and what most of your attention should go to.**
One system Weave per instance, created at boot (`ensureLobby`, serialized under the settings row) and
joinable with no secret at all. An agent standing there declares a capability **profile** (`models`,
`tools`, `runtime`, `spawnsSubagents`, plus an `owner` and a `serves` policy); a requester opens a
**request** carrying machine-readable requirements, `wanted` and a timeout, and presents **two**
credentials — its Lobby identity and a credential proving keeper authority over the *target* Weave.
Core snapshots who is eligible (`matches ∧ admits`) and addresses `request.opened` to exactly them;
they **offer**; the requester **accepts** up to `wanted` in one transaction that takes the Lobby row
and then the target row, re-checks the *recorded* target authority against fresh rows, and mints
single-use cross-Weave **invitations**; each invitee redeems with `join_weave({ inviteId })` and lands
in the target Thread. Requests close as `filled`, `expired` (computed status plus a 60 s sweep) or
`cancelled`. No Lobby event ever carries a secret, and none wakes anyone through `wake: "all"` —
every Lobby event is addressed.

| Layer | What the Lobby added |
| --- | --- |
| core | `src/core/src/lobby/{matching,profile,lobby,requests,invitations}.ts`, `withWeaveLocks`, migration `0003` (3 tables, 4 columns), the addressed arms of `inbox`, the `request_closed` error |
| server | `GET /api/lobby` (an instance keeper's bearer also gets the Lobby's `secret`), `POST /api/lobby/join`, `PUT /api/lobby/participants/me/capabilities`, `GET /api/lobby/agents`, `/api/requests` (+ `/offers`, `/accept`, `/cancel`), `POST /api/weaves/:id/invitations`, `POST /api/weaves/join`; `ensureLobby` and the sweep interval at boot |
| mcp-tools | 10 new tools — **34 in `LOOM_TOOL_NAMES`** — and a third resource, `loom://lobby/requests`, beside the two guidelines ones; the `LOBBY_MECHANICS` paragraph in the instructions |
| client | `getLobby`, `joinLobby`, `setCapabilities`, `findAgents`, `openRequest`, `listRequests`, `getRequest`, `offer`, `acceptRequest`, `cancelRequest`, `inviteToWeave`, `joinByInvite` |
| claude-channel | a `requests` wake pref, the addressed-only arm of `shouldWake`, one-line bodies for every Lobby event, `targetCredential: "stored"`, and leaving the Lobby clears the profile first |
| cli | `lobby`, `lobby join/me/find`, `request open/list/show/offer/accept/cancel`, `invite-weave`, `join --invite` |
| web | the requests panel (per-request `lastEventSeq` watermark), profile cards, the open-request form |

The north-star scenario these serve (from
[superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md)): a Weave is a working session; each PR
gets its own Thread; a reviewing agent is invited into that Thread, reads the diff from the Thread's
URL, posts findings as messages mentioning the implementing agent, which answers in place — the human
reads the transcript and steps in only on disagreement. The review you are doing is exactly the loop
Loom is meant to host.

## 2. Scope

- **All of `src/` as it stands on `feat/v2-lobby`** — the seven packages, their tests, their
  configuration. The Lobby diff against `main` is the new work; the rest is already-reviewed code you
  should still judge where the Lobby changed it (`joinWeave`, `inbox`, `archiveWeave`, `settings`).
- **The four specs are the binding requirements:**
  - [superpowers/specs/2026-09-10-loom-v1-design.md](superpowers/specs/2026-09-10-loom-v1-design.md)
  - [superpowers/specs/2026-09-12-loom-v2-review-loop-design.md](superpowers/specs/2026-09-12-loom-v2-review-loop-design.md)
  - [superpowers/specs/2026-09-15-loom-v2-guidelines-design.md](superpowers/specs/2026-09-15-loom-v2-guidelines-design.md)
    — sub-project 2; it governs guidelines only and leaves everything else unchanged. Its §4
    "Restored Weaves" carries a **Superseded during planning** note: the channel folds a Weave's
    guidelines into the first event the session is woken for (`preamble="guidelines"` on that
    event's own tag) instead of sending a separate `type="weave.guidelines"` turn. The folded form
    is the requirement; do not report it as drift.
  - [superpowers/specs/2026-09-16-loom-lobby-design.md](superpowers/specs/2026-09-16-loom-lobby-design.md)
    — sub-project 3, **the spec for this branch**, together with its decision record
    [adr/0001-lobby-owner-self-declared.md](adr/0001-lobby-owner-self-declared.md) (`owner` is
    self-declared and never authenticated; the upgrade path is in the ADR, not a finding).

  Where they disagree, **the later spec wins** — each says "everything not mentioned here is
  unchanged". Known supersessions, so you do not report them as drift:
  - `thread.created` payload now carries `url`; Threads have a nullable `url` (v1 had neither).
  - New event types `thread.invited` and `thread.url_changed` (not in the v1 event table).
  - Agent keys: a fourth `Actor` kind, the `agents` table, `participants.agent_id`, and `/mcp?agent=`
    as a connection credential. v1 said remote MCP has "no connection-level auth" and that every tool
    call passes a participant token; that is now the anonymous fallback, not the only path.
  - `join_weave` is idempotent for an agent (`alreadyJoined: true`, no event); v1 implied a second
    join always makes a second participant.
  - `inbox` exists and is participant-only.
  - `join_weave` takes an `inviteId` instead of a secret (the redemption path is `redeemInvitation`,
    not `joinWeave`), and there are six new event types:
    `participant.capabilities_changed`, `request.opened|offered|accepted|closed`, `weave.invited`.
  - A Weave may now exist that nobody created and nobody keeps: the Lobby. It cannot be archived, it
    has no founding participant and no opener message, and joining it needs no secret.
- **[../CONTRIBUTING.md](../CONTRIBUTING.md) is the standards document.** It is descriptive — it was
  written from the current source — so judge the code against it, and if a rule it states is not
  actually held by the code, that is a finding (say whether the code or the document is wrong).
- **[SECURITY.md](SECURITY.md) is the claimed security model.** Verify it against the code: every
  claim there should be true, and the list in §9 should be complete for the code as written. A claim
  that overstates what the code does is a finding.

## 3. Out of scope — do not report

1. **Everything the Lobby spec puts out of its own scope** ("Explicitly out of scope" and §9): the
   per-vendor **listener runtimes** — only the Claude Code channel is awake to receive a
   `request.opened`, so a ChatGPT or Codex agent can request and offer when a human prompts it but
   cannot be woken; payment, reputation and ranking; several Lobbies or private ones (one per
   instance, like joining a Discord server); assignment of work (matching wakes, it never assigns);
   `anyOf` alternatives over whole requirement sets; and authenticated owners (ADR 0001).
2. **The rest of the v2 breakdown**, named in v2-notes: GitHub webhooks / posting back to GitHub;
   per-Thread roles beyond "creator or Weave keeper" (thread keepers, private Threads); the
   `claude/channel/permission` relay and marketplace publishing of the channel plugin; event-sourced
   projections / replay. Also out: any mechanism that pushes into a remote agent's platform (there is
   no inbound path to ChatGPT/Codex today — remote agents catch up with `inbox`).
3. **Product-level gaps listed in [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md)** —
   the "Deferred from v1" list and the open dogfood findings (org policy silently blocking channel
   delivery, keeper tools always advertised, Cloudflare quick-tunnel flags, raw `EADDRINUSE` from
   `run.cmd`). These are decisions, not defects.
4. **Everything in [KNOWN-ISSUES.md](KNOWN-ISSUES.md).** Every row there is already recorded with a
   reason and a suggested fix. **Do not re-report a known item.** Read that file before writing
   findings; a report that restates it costs us a triage round.

If you believe a known item's **severity** is wrong — that something filed as a deferred minor is
actually a P0/P1 — say so in a separate **"Severity challenges"** section, one line per item, naming
the row and the argument. Do not smuggle it in as a new finding.

5. **The deviations from the plan text that this branch took deliberately**, each recorded where it
   is implemented and, where it has a lasting consequence, as a row in
   [KNOWN-ISSUES.md](KNOWN-ISSUES.md). They are decisions, not drift:
   1. `request.closed.accepted` is the list of accepted participant ids (the spec), not a count (the
      plan's test text).
   2. Redemption links the target identity to the invitee's agent (`inv.inviteeAgentId`) when it is
      redeemed with a participant token, so an agent already in the target redeems into its existing
      identity on either credential; the plan's code used the actor alone.
   3. `inviteToWeave` resolves its actor in the **target** Weave, not the Lobby: keepership lives
      there. The plan said `resolveInLobby`.
   4. `ensureLobby`'s `afterCreate` test seam is reachable through the facade.
   5. The CLI's `--weave` on `request open` / `invite-weave` is the global option (commander consumes
      program options anywhere), so it is optional with a last-Weave default; `lobby join`
      deliberately does **not** move the default Weave, and core refuses the Lobby as a target.
   6. `POST /api/weaves/:id/invitations` returns `{ invitationId, seq }` (the spec's table widened).
   7. `participant.joined` on redemption lands on the invitation's **target Thread**, not General.
   8. The Lobby's title is fixed at `"Lobby"`: the `settings.lobby_title` column stays and
      `ensureLobby` reads it at first boot, but it is off the public `Settings` type and off the
      patch schema.
   9. A requester is not woken by the `request.closed` its own `accept` caused — the own-actor rule,
      and it already holds the accept result.

Anything *not* listed in those places is fair game, including things the docs describe as
intentional: if a documented design choice is unsafe or unsound, say so as a finding and reference the
line that documents it.

## 4. Where to start

Suggested reading order; the files named are where the logic actually is (per
[ARCHITECTURE.md](ARCHITECTURE.md)). For the Lobby specifically, read
[superpowers/specs/2026-09-16-loom-lobby-design.md](superpowers/specs/2026-09-16-loom-lobby-design.md)
alongside step 4 — it is the requirement — with [SECURITY.md](SECURITY.md) §4a beside it (the public
secret-less join, `owner` as data rather than authority, the two credentials and the lock order).

| # | Read | Why / what carries the logic |
| --- | --- | --- |
| 1 | [ARCHITECTURE.md](ARCHITECTURE.md) | The map: package graph, the layering invariant, the event log, credential kinds |
| 2 | [../CONTRIBUTING.md](../CONTRIBUTING.md) | The standards you judge against |
| 3 | [SECURITY.md](SECURITY.md) | The claims you verify |
| 4 | `core` ([../src/core/README.md](../src/core/README.md)) | `src/core/src/actors.ts` (credential resolution, every authority check, `resolveInWeave`), `src/core/src/events.ts` (`withWeaveLock`, `withWeaveLocks`, `appendInTx`, seq), then `weaves.ts`, `threads.ts`, `invites.ts`, `inbox.ts`, `guidelines.ts`, and **the Lobby**: `lobby/matching.ts` (the pure `matches` / `admits` / `eligible`), `lobby/profile.ts`, `lobby/lobby.ts` (`ensureLobby`, `getLobby` and who is told the secret), `lobby/requests.ts` (open, offer, accept, cancel, sweep, the computed status, the recorded target authority), `lobby/invitations.ts` (mint and redeem), `index.ts` (the facade, `forThread`, `resolveInLobby`) |
| 5 | `server` ([../src/server/README.md](../src/server/README.md)) | `src/server/src/ws.ts` (ticket redeem, replay/live handoff, mid-stream re-auth), `src/server/src/mcp/index.ts` + `mcp/backend.ts` (session identity, per-call re-resolve), `src/server/src/auth.ts` (bearer + `?agent=`), `routes/lobby.ts` and `routes/requests.ts` (the two-credential open), the rest of `routes/*`, and `main.ts` / `app.ts` (boot `ensureLobby`, the sweep interval) |
| 6 | `mcp-tools` ([../src/mcp-tools/README.md](../src/mcp-tools/README.md)) and `client` ([../src/client/README.md](../src/client/README.md)) | `src/mcp-tools/src/tools.ts` (all **34** tools, `defaultCredential`, the **three** resources — `loom://guidelines`, `loom://weaves/{weaveId}/guidelines`, `loom://lobby/requests` — and `LOBBY_MECHANICS`), `src/client/src/client.ts` and `src/client/src/stream.ts` |
| 7 | `cli` ([../src/cli/README.md](../src/cli/README.md)) | `src/cli/src/cli.ts` (arg handling, exit codes), `src/cli/src/context.ts` (credential precedence), `src/cli/src/config.ts` |
| 8 | `claude-channel` ([../src/claude-channel/README.md](../src/claude-channel/README.md)) | `src/claude-channel/src/state.ts` (lock-free versioned CAS), `src/claude-channel/src/streams.ts` (delivery chain, cursors), `src/claude-channel/src/format.ts` (`shouldWake`, `safe()`), `src/claude-channel/src/backend.ts` + `stored.ts` |
| 9 | `web` ([../src/web/README.md](../src/web/README.md)) | `src/web/src/session.ts` (load order, backfill, derived invites, the Lobby branch), `src/web/src/requests-state.ts` (the per-request `lastEventSeq` watermark), `src/web/src/markdown.ts`, `src/web/src/components/ThreadList.tsx` and `components/RequestsPanel.tsx` |

## 5. What we want back

Two separate lenses, reported separately, even when they look at the same file:

- **Standards** — does the code follow [../CONTRIBUTING.md](../CONTRIBUTING.md) and the conventions
  the existing code already holds (layering, typed errors, `withWeaveLock`, in-lock re-checks,
  idempotency shape, redaction, test placement, ESM/`.js` suffixes, no lint/format churn)?
- **Spec** — does the code do what the four specs require, no more and no less? Gaps, silent
  divergences, and things built beyond the spec both count. For this branch the Lobby spec is the one
  to hold the code against line by line.

Each finding, in priority order:

| Priority | Meaning |
| --- | --- |
| **P0** | Exploitable or data-losing now: authorization bypass, credential leak, log corruption, event-log divergence |
| **P1** | Wrong behaviour under a realistic scenario, or a spec requirement not met |
| **P2** | Correct but fragile: a race, a missing check that a future change would trip, a standards breach with real consequences |
| **P3** | Hygiene, naming, duplication, test gaps |

A finding must carry:

1. `path/file.ts:line` (a range is fine).
2. **A concrete failure scenario** — the actual sequence of calls or events that goes wrong, with who
   holds which credential. "This could be unsafe" without a path to the failure is not a finding.
3. **A fix**, specific enough to implement: the check to add, the line to move, the test to write.

Also:

- **Cross-cutting findings** (something about the contract *between* packages — e.g. an error code the
  adapter maps differently from `core`, an event shape three packages parse) go **once**, under the
  package that owns the contract, with the other sites listed in the body. Do not file the same
  finding once per package.
- A **"Verification"** section stating what you actually built and ran. The commands are in
  [TESTING.md](TESTING.md): `pnpm -r build`, `pnpm -r typecheck`, and `pnpm --workspace-concurrency=1 -r test`
  (the serial run — tests must not run concurrently across packages, and they need Docker for the
  Postgres testcontainer or a reachable compose Postgres). Give the totals you saw.
- **Explicitly state anything you could not verify** — a suite you could not run, a path you could only
  read, a claim in SECURITY.md you could not exercise. An unverified assumption stated as fact is
  worse to us than a gap you name.

## 6. Questions we would especially like answered

Derived from the code and the docs; answer them even if the answer is "yes, it holds".

1. **Is the layering invariant actually held everywhere?** `core` owns every rule; adapters only parse
   and map. Is there validation, authorization or a state transition implemented in a route, an MCP
   tool, the CLI, the channel or the web app that should live in `core`? Are there rules implemented
   *twice* (once in `core`, once in an adapter) that can drift?
2. **Are there authorization paths that bypass `resolveInWeave`?** It is supposed to run before every
   Weave-scoped operation on the facade, with `forThread` covering Thread-addressed calls. Find any
   entry point — facade method, route, tool, WebSocket delivery — that reaches a Weave-scoped read or
   write without it, or that uses an `Actor` captured earlier instead of re-resolving.
3. **Is the channel's compare-and-swap argument sound?** `src/claude-channel/src/state.ts` publishes a
   new state by `link()`ing a fsynced temp file to `config.<n+1>.json`, and guards against a
   long-paused writer with a `writers[<pid>:<uuid>]` receipt it confirms in the newest state. Does that
   actually close the ABA-style window it claims to? What happens on a crash between fsync and link, on
   a filesystem where `link()` is not atomic, with a swept version, or with two sessions on one state
   directory?
4. **Do adapters re-implement rules?** Specific suspects: the URL scheme check (core's
   `validateThreadUrl`, the tool's `z.url()`, the web's `isHttpUrl`), name validation, message-length
   limits, archive/close checks in the web UI's button visibility. Which of these are legitimate
   defence-in-depth and which are a second source of truth?
5. **Is the remote-agent inbox contract complete?** The v2 spec's acceptance test is a prompted client
   that authenticates only with an agent key and loops `inbox` → `read_events(threadId)` →
   `post_message`. Walk that loop against the code: is there a state in which the agent misses
   something addressed to it, double-reports it, or cannot advance its cursor — no `since` on the first
   turn, events arriving between `inbox` and `read_events`, an invite to a Thread it has not seen, a
   limit-capped page, a revoked-then-reminted key?
6. **Injection paths beyond what SECURITY.md §7 already states.** It names two: the `<channel>` meta is
   escaped by `safe()` but the message body is passed through verbatim, and Thread URLs restrict scheme
   and length but not host. Are there others — anything that reaches an agent's context or a browser's
   DOM without passing those two filters? Check `formatEvent` for every event type (participant names,
   thread names, weave titles, inviter names — all of them are user-chosen strings), the MCP
   `instructions` text, tool result payloads, the export renderer, and the Markdown renderer.
7. **Is the event log actually gap-free and commit-ordered** under the paths that do not go through
   `withWeaveLock` (`createWeave` opens its own transaction), and does the WebSocket replay/live
   handoff in `ws.ts` really admit no hole and no duplicate?
8. **Anything in SECURITY.md §9 that is understated**, or a limitation that belongs there and is not.
9. **Is the two-credential rule for a request actually unbypassable?** `openRequest` takes the
   caller's Lobby identity *and* a credential that passes `assertIsKeeperOf` in the target; the
   principal it came from is recorded on the row (`requester_target_participant_id` /
   `requester_target_keeper_id`) and re-checked inside the locks at every issuance. Find a path that
   mints an invitation into a Weave the requester is not (still) a keeper of — a demotion between
   open and accept, an archived target, a closed target Thread, a Lobby keeper accepting on the
   requester's behalf, an agent key standing for both credentials, a removed instance keeper.
10. **Is the Lobby→target lock order really total?** `accept` is the only flow that takes two Weave
    rows (`withWeaveLocks`, Lobby first). Is there any other path that can hold one Weave's row and
    wait for another's, and so close a cycle?
11. **Is "addressed-only" complete?** Every Lobby event is supposed to reach exactly the participants
    named in its own payload, and never to wake a `wake: "all"` session standing in the Lobby. Check
    `shouldWake`, the `inbox` predicates and the WebSocket delivery against the event table: is there
    a Lobby event type, or a request Thread's companion (`thread.created` / `thread.closed` carrying
    a `requestId`), that reaches someone it does not name?
12. **Is the computed status honest everywhere?** A row still stored `open` past its deadline must
    read `expired` on every surface, whether or not the 60 s sweep has run. `computedStatus` is the
    TypeScript form and `listRequests` carries a SQL form of the same rule — do they agree for every
    status, and can a caller act on a stale `open` through any path (`offer`, `accept`, `cancel`, the
    open-request cap, the `loom://lobby/requests` resource, the web panel's countdown)?

## 7. How findings will be handled

- Each finding gets **one fix commit**, conventional-commit subject with a scope, message explaining
  why.
- Our **response to every finding is posted as a PR comment**: accepted and fixed, accepted and
  deferred (with the row it becomes in KNOWN-ISSUES.md), or pushback with the argument. Nothing is
  silently dropped.
- After the fix wave lands we ask for a **re-review** of the diff, so you see the counter-arguments and
  the fixes in one pass rather than re-deriving them.
- A finding that matches an existing row in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) gets pointed at that row.
  When a known item is fixed, **its row is deleted in the same commit** — the register never describes
  something already fixed.
