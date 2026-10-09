# Loom: kicking a participant out of a Weave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A keeper of a Weave (or the instance keeper token) kicks a participant out of it: `participants.kicked_at` is set and its role is `member`, the kicked agent's invitations into the Weave still pending are withdrawn, one `participant.kicked` lands on the Weave's General Thread, and from then on its token is refused on every surface with `forbidden` "You were removed from this Weave", an agent key's identity there is refused, its open streams close, and only a keeper's new invitation readmits it as the same participant. Surfaces: core, REST, the client, MCP (`kick_participant`), the channel, the CLI (`loom kick`, `loom info`, `loom read`), the web (a Kick control with a confirmation, the people list, the composer, the kicked tab's recovery), the export, the skills.

**Architecture:** Core gains one nullable column (`participants.kicked_at`, migration 0010), `kickParticipant` in `src/core/src/participants.ts` (the authority of `setRole`, under `withWeaveLocks` Lobby then Weave, the row `FOR UPDATE`, the withdrawals of §4.6 inside the same transaction), one event type after `participant.role_changed`, `PublicParticipant.kickedAt`, and the refusals at the few places a credential or a participant is accepted (`resolveCredential`, `resolveInWeave`, `joinWeave`'s adoption, `inviteParticipant`, `setRole`, the mention read) plus readmission in `redeemInvitation`. The server adds one action route and forces the WebSocket re-check before any `participant.kicked` is sent. Every other package is an adapter: a client wrapper, an MCP tool and its backend methods, the channel's line, instruction and `forbidden` drop, a CLI command and two output changes, and on the web a session predicate and action, a Kick control, two list filters, a stream-close recovery, a Thread line and a folded word. Behaviour only on the web: no CSS.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), pnpm 10 workspace, Node 24, Vitest 4 against a real Postgres 17 testcontainer (`fileParallelism: false`; mcp-tools with no database), drizzle-orm 0.45.2 with drizzle-kit 0.31.10 on postgres-js 3.4.9, zod 4.6.1, Hono 4, commander 15.0.0, Preact with happy-dom for the DOM tests. **No `package.json` gains a dependency anywhere in this plan.**

**Spec:** `docs/superpowers/specs/2026-10-09-loom-kick-participant-design.md`, approved by Paw on 2026-10-09 with every **(choice)** accepted as written, after two ChatGPT review rounds through Loom (PR #63). Read it whole before any task; it is the binding requirement text, and every text it quotes (messages, payloads, the tool description, the `get_weave` sentence, the skill edits, the channel's `type=` list, sentence and notification, the Thread lines, the CLI lines, the web's words) is transcribed into this plan byte for byte, never paraphrased. The spec's **(choice)** marks are requirements. Where this plan decides something the spec leaves open, or where the code made the spec's words need a reading, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md` (its "Migrations" section binds Task 1), `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `D:/git/Loom/.superpowers/sdd/2026-10-09-loom-kick-participant/progress.md`.

**Execution:** subagent-driven, as Paw's standing rule says (HANDBOOK §4, CLAUDE.md): the controller dispatches **one fresh Opus subagent per task** (`model: "opus"`, `run_in_background: true`) on the feature branch `feat/kick-participant` in the worktree `D:/git/worktrees/Loom-kick-participant`, then **an Opus task reviewer** per task (read-only, against the review package), and **reads every diff itself** before the next dispatch. Never inline. Briefs come from the SDD scripts (`task-brief`, `review-package`), so the task text never passes through the controller's context.

**Base:** branch `feat/kick-participant` off `origin/main` **after the docs PR carrying the spec and this plan (PR #63) merges**. From `main` (at `5eccd5a` when this plan was written) this plan consumes, unchanged unless a task says otherwise: `setRole` (`src/core/src/participants.ts`); `toPublicParticipant`, `resolveCredential`, `resolveInWeave`, `participantForAgent`, `stampSeen`, `actorId`, `assertIsKeeperOf`, `assertStillKeeperOf`, `assertCanRead` (`src/core/src/actors.ts`); `withWeaveLock`, `withWeaveLocks`, `NewEvent`, `readEvents`, `appendInTx` (`src/core/src/events.ts`); `generalThreadOf`, `createThread`, `getThread` (`src/core/src/threads.ts`); `getLobby`, `lobbyGeneralThreadId`, `ensureLobby`, `joinLobby` (`src/core/src/lobby/lobby.ts`); `inviteToWeave`, `redeemInvitation`, `listInvitations`, `withdrawInvitation` (`src/core/src/lobby/invitations.ts`); `joinWeave`, `createWeave`, `getWeave`, `archiveWeave`, `CreateWeaveResult`, `JoinResult` (`src/core/src/weaves.ts`); `inviteParticipant` (`src/core/src/invites.ts`); `postMessage` (`src/core/src/messages.ts`); `removeParticipant` (`src/core/src/removals.ts`); `openRequest`, `offer`, `accept`, `recordedAuthorityHolds` (`src/core/src/lobby/requests.ts`); `setCapabilities` (`src/core/src/lobby/profile.ts`); `inbox` (`src/core/src/inbox.ts`); `exportWeave` (`src/core/src/export.ts`); `addAgent` (`src/core/src/agents.ts`); `seedKeepers` (`src/core/src/keepers.ts`); `EVENT_TYPES`, `EventType`, `LoomEvent`, `PublicParticipant`, `Actor` (`src/core/src/types.ts`); `errors` (`src/core/src/errors.ts`); `isUuid`, `newSecret` (`src/core/src/ids.ts`); the facade `createCore` (`src/core/src/index.ts`); `freshDb`, `closeTestDb`, `keeperToken` (`src/core/test/helpers.ts`); in `src/core/test/units.test.ts` `NAMED`; in `src/core/test/migration-status.test.ts` the case `case 9: assertTransactionSafe accepts every real migration file`; `weaveRoutes` (`src/server/src/routes/weaves.ts`); `stream`, `ensureAuthorized`, `deliver`, `CREDENTIAL_REVOKED` (`src/server/src/ws.ts`); `CoreToolBackend` (`src/server/src/mcp/backend.ts`); `startTestServer`, `api`, `keeperToken` (`src/server/test/helpers.ts`); in `src/server/test/routes.test.ts` `s`, `KEEPER`, `creator`; in `src/server/test/ws.test.ts` `KEEPER`, `creator`, `makeGate`, `collect`; in `src/server/test/mcp.test.ts` `json`, and in `describe("listener onboarding over remote MCP")` `fresh`, `mint`, `agentClient`; `LoomClient` (`src/client/src/client.ts`), `Participant`, `EventType`, `RemovalResult` (`src/client/src/types.ts`), `openStream`, `FATAL` (`src/client/src/stream.ts`); in `src/client/test/client.test.ts` `srv`, `anon`, `input`; in `src/client/test/stream.test.ts` `srv`, `anon`, `input`, `waitFor`; `LOOM_TOOL_NAMES`, `registerLoomTools`, `READ_GUIDELINES` (`src/mcp-tools/src/tools.ts`); `LoomToolBackend` (`src/mcp-tools/src/backend.ts`); in `src/mcp-tools/test/tools.test.ts` `fake`, `calls`, `client`, `text`; in `src/mcp-tools/test/skills.test.ts` the drift guard's `skills`; `ClientToolBackend` (`src/claude-channel/src/backend.ts`), `withStoredCredential` (`src/claude-channel/src/stored.ts`), `formatEvent`, `shouldWake`, `safe` (`src/claude-channel/src/format.ts`), `INSTRUCTIONS` (`src/claude-channel/src/server.ts`), `StreamManager` (`src/claude-channel/src/streams.ts`), `ChannelState.removeWeave` (`src/claude-channel/src/state.ts`); in `src/claude-channel/test/format.test.ts` `ev`, `weave`, `names`; in `src/claude-channel/test/streams.test.ts` `WEAVE_ID`, `makeWeave`, `makeState`, `makeFakeClient`, `waitFor`; in `src/claude-channel/test/backend.test.ts` `makeState`, `WEAVE_ID`; in `src/claude-channel/test/channel.test.ts` `withChannel`, `stateDir`; `registerWeaveCommands` (`src/cli/src/commands/weave.ts`), `hhmm` (`src/cli/src/commands/request.ts`), `formatEvent` (`src/cli/src/commands/messages.ts`), `emit` (`src/cli/src/output.ts`); in `src/cli/test/cli-more.test.ts` `s`, `run`, `cfg`; `createSession`, `Session`, `SessionState`, `mayManageInvitations`, `recoverFromCredentialFailure`, `scheduleRefresh`, `doLoad`, `writer`, `onEvent` (`src/web/src/session.ts`); `isCredentialFailure` (`src/web/src/weaves-store.ts`); `ThreadDetails` (`src/web/src/components/ThreadDetails.tsx`), `InviteControl` (`src/web/src/components/ThreadTools.tsx`), `Composer`, `WeaveView`, `systemLine` (`src/web/src/components/MessageList.tsx`); `WORDS`, `runSummary` (`src/web/src/components/fold.ts`); in `src/web/test/session.test.ts` `s`, `anon`, `waitFor`, `storedIdentity`, `sideReadClient`; in `src/web/test/components.test.tsx` `me`, `bot`, `pr`, `state`, `session`; in `src/web/test/fold.test.ts` `ev`.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/kick-participant`, worktree `D:/git/worktrees/Loom-kick-participant`. **All git worktrees go under `D:/git/worktrees`, never inside the repo** (no `.claude/worktrees`, no `.worktrees`). One commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 10 is done and the whole-branch review (HANDBOOK §3 step 10) has run. The controller dispatches every implementer and reviewer **in the background** (`run_in_background: true`, `model: "opus"`), and reads every diff itself before the next dispatch.
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, skill files, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that line; **a rewritten line loses it, replaced by a colon** (the scan flags the whole added line). The lines this plan rewrites that carry one today are named in their tasks: the `get_weave` description (Task 5), the `**Participants**` and `src/participants.ts` lines of `src/core/README.md` (Task 1), the `**Messages**` line of `src/client/README.md` (Task 4), the `**Weaves**` line of `src/mcp-tools/README.md` (Task 5) and SECURITY §9 item 4 (Task 10). A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Never write a backslash-u escape** (a backslash, the letter u and four hex digits) into a file: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row.
- **The scan, before every commit.** After staging, run exactly this from the worktree root; it must print `scan clean`. It looks at added lines only, for the two mojibake openers (U+00C2, and U+00E2 followed by U+20AC) and the em dash, built with `String.fromCharCode` so this plan does not contain them:

```bash
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
```

- **Never run `vitest list`** (it once overwrote test files). Run tests with `npx vitest run <files>` inside the package, or the scripts below.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test and the rule tested once, in `core`; adapters test wiring. Pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker (core, server, client, cli, claude-channel and web use the testcontainer; mcp-tools does not). **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test across packages:** `pnpm -r build` whenever a task touches more than one package, and before any suite reads another package's change (workspace packages resolve to `dist`; `migration-status.test.ts` imports `@loom/core`'s `dist`; the channel suite spawns `dist/server.js`; the mcp-tools drift guard reads `@loom/core`'s `dist`; the client, cli and web suites start the server from `src/server/test/helpers.ts`, which reaches core through its `dist`). `pnpm -r typecheck` (sources and tests) is green at the end of every task.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.
- **Layering:** every rule lives in `@loom/core` and is tested there once: who may kick whom, what a kick writes and withdraws, the idempotent answer, the refusals, readmission, the mention filter. REST and MCP pass strings through with type-only schemas; the server's one rule of its own is the stream's forced re-check (§8.1); the client, the CLI, the channel and the web carry words, presentation and the identity drop only.
- **The words.** Every user-facing and API word of this feature is *kick* / *kicked*: `kick_participant`, `participant.kicked`, `loom kick`, the web's "Kick", `kicked_at`, `kickedAt`, `kickedBy`, `kickedByName`, `KickResult`, `KickControl`. The Thread-level *remove* (`remove_participant`, `thread.removed`) is untouched. The one sentence a kicked participant is answered with is Paw's own: "You were removed from this Weave".
- **One migration, generated.** Task 1 adds `0010_<drizzle-kit's name>.sql` (exactly `ALTER TABLE "participants" ADD COLUMN "kicked_at" timestamp with time zone;`), its `_journal.json` entry (idx 10, `when` greater than 1790879530257) and `meta/0010_snapshot.json`, by `drizzle-kit generate`, never by hand; CONTRIBUTING's "Migrations" rules apply as they stand. After Task 1, `git diff --stat origin/main -- src/core/drizzle` lists exactly those three files, and no later task touches `src/core/drizzle`.
- **Error codes:** the fixed set only. **No new code.** The new messages are verbatim:
  - `Nobody is kicked from the Lobby` (`validation`)
  - `You cannot kick yourself` (`validation`)
  - `That participant was kicked from this Weave` (`validation`; `inviteParticipant`, `setRole`)
  - `You were removed from this Weave` (`forbidden`; `resolveCredential`, `resolveInWeave`)
  - `You were removed from this Weave: a keeper must invite you back` (`forbidden`; `joinWeave`)
  - reused, unchanged: `No such participant in this Weave` (`validation`), `Only a keeper of this Weave can do this`, `Join the Weave first` (`forbidden`), `This invitation was withdrawn` (`forbidden`), `The requester is no longer a keeper of the target Weave` (`forbidden`), `Weave not found` (`weave_not_found`).
- **Values:** `EVENT_TYPES` gains `"participant.kicked"` directly after `"participant.role_changed"`; `weave.invitation_withdrawn` stays its last entry. The event lands on the Weave's General Thread with actor `actorId(actor)` and payload exactly `{ participantId, name, kickedBy, kickedByName }`, `kickedByName` the participant actor's name or `Keeper` for `keeper:<id>`. A withdrawal by a kick is `withdrawInvitation`'s event exactly (`{ invitationId, participantId, targetWeaveTitle, withdrawnBy, withdrawnByName }`), on the Lobby's General Thread for a direct invitation and on the request's Thread for a request's. `KickResult` is `{ participantId, name, seq, kickedAt, created, withdrawn }`; a repeat's seq is the newest `participant.kicked` naming the id in the Weave's log, `0` when none. `LOOM_TOOL_NAMES` gains `"kick_participant"` directly after `"set_role"` (42 names). The route is `POST /api/weaves/:id/participants/:pid/kick`, 200 on a repeat too.
- **Visual design is Paw's separate design session.** The web task adds behaviour, text and class hooks only (`kick-control`, `kick-confirm`, and the existing `btn btn-xs`); **no CSS**, no `styles.css` edit.
- **`skills/** text eol=lf`** (`.gitattributes`, unchanged): every file under `skills/` is LF in the working tree. Check with `git ls-files --eol skills` before committing Task 9: every row starts `i/lf    w/lf`.
- **CRLF working copies.** On Paw's machine the working copies of the docs and of many sources are CRLF (git normalises them on add). Every edit below replaces or follows one exact line or substring: match one line at a time, never a multi-line block, unless a task writes a whole file or its script reads the file as LF itself.
- **The known ripples.** A new list entry, field or member reaches exact assertions and typed fixtures elsewhere. Each is repaired **only by adding what the new rule gives**, never by loosening an assertion, and each repaired test is named in the commit body. The ones known at plan time are listed in the task that causes them: Task 1, `units.test.ts` "EVENT_TYPES holds every type the EventType union named, each once, and EventType accepts exactly those" (`NAMED`); Task 4, the typed participant fixtures that must gain `kickedAt: null` (`components.test.tsx` `me`, `bot` and the `ME` of `describe("the Offer form on the Lobby's routes (spec §3.3)")`; `listeners-page.test.tsx` and `main-page.test.tsx` `JOINED`, and `main-page.test.tsx` `CREATED_RESULT`; the channel's `backend.test.ts` `participant()` and `streams.test.ts` `weaveInfo()`); Task 5, `tools.test.ts` "advertises the twelve Lobby tools and nothing else new", "LOOM_TOOL_NAMES has the four new names, and the registered tools equal it", "LOOM_TOOL_NAMES has get_skill: 41 names" (renamed to 42) and the `fake` backend, and `mcp.test.ts` "serves the tool catalog without connection-level auth"; Task 6, `channel.test.ts` "the instructions list the onboarding and removal types"; Task 8, the `session()` fake of `components.test.tsx`. A red case of any other shape is a finding and stops the task.
- **The Lobby must exist for a kick.** `kickParticipant` reads the Lobby (spec §4.2 step 3), which every booted instance has (`main.ts` calls `ensureLobby`). Test files whose server never creates one (`routes.test.ts`, `ws.test.ts`, `client.test.ts`, `stream.test.ts`, `cli-more.test.ts`) call `ensureLobby()` in the new cases, which are appended at the end of each file so no earlier case sees the extra Weave.
- **Shared test databases.** The server, client, cli, channel and web suites share one database (and one Lobby) per file. Every new fixture takes fresh names (a counter, or the file's own tag), and a test never relies on the Lobby holding only its own participants or events.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/db/schema.ts` (modify) | `participants.kickedAt`; the `revokedAt` comment (spec §3) |
| `src/core/drizzle/0010_<generated>.sql`, `src/core/drizzle/meta/0010_snapshot.json`, `src/core/drizzle/meta/_journal.json` (generated) | migration 0010 |
| `src/core/src/types.ts` (modify) | `"participant.kicked"` in `EVENT_TYPES`; `PublicParticipant.kickedAt` |
| `src/core/src/actors.ts` (modify) | `toPublicParticipant` maps `kickedAt` (Task 1); `REMOVED_FROM_WEAVE` and the refusals in `resolveCredential` and `resolveInWeave` (Task 2) |
| `src/core/src/participants.ts` (rewrite in Task 1, modify in Task 2) | `KickResult`, `KickOptions`, `kickParticipant`, `withdrawPending`; `KICKED_TARGET` and the `setRole` refusal |
| `src/core/src/lobby/invitations.ts` (modify) | the `withdrawInvitation` comment (Task 1); readmission in `redeemInvitation` (Task 2) |
| `src/core/src/weaves.ts`, `invites.ts`, `messages.ts`, `export.ts` (modify, Task 2) | the secret-path refusal; the Thread-invite refusal; the mention filter; the export line and Participants mark |
| `src/core/src/index.ts` (modify) | the facade's `kickParticipant`; the type exports |
| `src/core/test/kick.test.ts` (new); `units.test.ts`, `db.test.ts` (modify) | spec §16.1 |
| `src/core/README.md` (modify) | the Participants line and the `participants.ts` line |
| `src/server/src/routes/weaves.ts`, `src/server/src/ws.ts` (modify) | `POST /api/weaves/:id/participants/:pid/kick`; the forced re-check |
| `src/server/test/routes.test.ts`, `ws.test.ts` (modify); `src/server/README.md` (modify) | spec §16.2 REST and streams; the route row |
| `src/client/src/types.ts`, `src/client/src/client.ts` (modify) | `KickResult`, `Participant.kickedAt`, the `EventType` member; `kickParticipant` |
| `src/client/test/client.test.ts`, `stream.test.ts` (modify); `src/client/README.md` (modify) | spec §16.3 |
| `src/mcp-tools/src/tools.ts`, `src/mcp-tools/src/backend.ts` (modify) | the name, the tool, the `get_weave` sentence; the `LoomToolBackend` method |
| `src/server/src/mcp/backend.ts`, `src/claude-channel/src/backend.ts`, `src/claude-channel/src/stored.ts` (modify) | the backend method over core, over the client, and with the stored credential |
| `src/mcp-tools/test/tools.test.ts`; `src/server/test/mcp.test.ts`; `src/claude-channel/test/backend.test.ts` (modify); `src/mcp-tools/README.md` (modify) | spec §16.4 tools, §16.2 MCP, §16.6 backend; the count and the Weaves line |
| `src/claude-channel/src/format.ts`, `server.ts`, `streams.ts`, `state.ts` (modify) | the line and `safe` exported; the instructions; the `forbidden` drop; `removeWeaveIfToken`, which forgets a Weave only while its stored token is the refused one |
| `src/claude-channel/test/format.test.ts`, `streams.test.ts`, `channel.test.ts` (modify); `src/claude-channel/README.md` (modify) | spec §16.6 |
| `src/cli/src/commands/weave.ts`, `messages.ts` (modify) | `loom kick`, `loom info`'s `Kicked:`; the `read` line |
| `src/cli/test/cli-more.test.ts` (modify); `src/cli/README.md`, `README.md` (modify) | spec §16.5; the command rows and the paragraph |
| `src/web/src/session.ts` (modify) | `present`, `canKick`, `kick`, the stream-close recovery, `participant.kicked` refreshes |
| `src/web/src/components/ThreadTools.tsx`, `ThreadDetails.tsx`, `Composer.tsx`, `MessageList.tsx`, `fold.ts` (modify) | `KickControl`; the people list; the mention names; the Thread line; the folded word |
| `src/web/test/components.test.tsx`, `session.test.ts`, `fold.test.ts` (modify) | spec §16.7 |
| `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-ask-for-review/SKILL.md`; `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (modify) | spec §13 |
| `src/mcp-tools/test/skills.test.ts` (modify) | spec §16.4 skills |
| `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/KNOWN-ISSUES.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §15, §17 (Task 10) |

**Why eleven tasks (0 to 10).** Each carries its own test cycle and could be rejected alone. The spec's sketch has nine; this plan keeps its first eight one to one (core kick 1, core refusals 2, server 3, client 4, MCP 5, channel 6, CLI 7, web 8) and splits its ninth into the skills (9, which need the registered tool and the event type for the drift guard) and the cross-cutting docs with the serial run (10), as the previous slice did. Core is two tasks because a reviewer judging "who may kick whom, what a kick writes and withdraws" (1) and "where a kicked credential is refused, and how a keeper's invitation readmits" (2) can reject one and approve the other; each core test sits in the task whose code makes it pass, so every case is RED first. The client's types (4) come before the channel (6) and the web (8), which switch on `@loom/client`'s union and type their fixtures by it. MCP (5) changes `LoomToolBackend`, so every implementer of it (the server's, the channel's two and the test fake) must change in the same commit for `pnpm -r typecheck` to stay green. Each package's README is in its own package's task.

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git -C D:/git/Loom fetch origin && git -C D:/git/Loom log origin/main --oneline -5` shows the squash commit of PR #63, and `git -C D:/git/Loom show origin/main:docs/superpowers/plans/2026-10-09-loom-kick-participant.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Create the worktree and the branch, outside the repo:

```bash
cd D:/git/Loom
git worktree add D:/git/worktrees/Loom-kick-participant -b feat/kick-participant origin/main
cd D:/git/worktrees/Loom-kick-participant
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Confirm the code this plan was written against is still there, from the worktree root: `node -e "console.log(require('./src/core/drizzle/meta/_journal.json').entries.at(-1).tag)"` prints `0009_zippy_quicksilver`; `grep -c '  "message", "participant.joined", "participant.role_changed",' src/core/src/types.ts` prints `1`; `grep -c "participant.kicked" src/core/src/types.ts` prints `0`; `grep -c "kicked" src/core/src/db/schema.ts` prints `0`; `grep -c "export async function setRole" src/core/src/participants.ts` prints `1`; `grep -c '"close_thread", "archive_weave", "set_role", "export_weave",' src/mcp-tools/src/tools.ts` prints `1`; `grep -c '|request.offer_withdrawn|weave.invitation_withdrawn" from=' src/claude-channel/src/server.ts` prints `1`; `grep -c "onStatus: (st) => {" src/web/src/session.ts` prints `1`; `ls src/core/test/kick.test.ts` fails. If any differs, stop and report: someone has added a migration or reshaped the code since the spec was written.
- [ ] Confirm the ledger folder is ignored: `git -C D:/git/Loom check-ignore -v .superpowers` prints a rule. If it prints nothing, stop and report (the folder holds real secrets; HANDBOOK §5).
- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. TESTING.md "Current totals" records **2473 tests in 80 files** after the withdraw-invitation slice (core 781/32, web 982/17, server 247/10, claude-channel 152/9, cli 89/5, client 51/4, mcp-tools 171/3). Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `D:/git/Loom/.superpowers/sdd/2026-10-09-loom-kick-participant/progress.md` (create the folder). Task 10 compares against that record and must not estimate. If the figures differ from TESTING.md's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---
### Task 1: core: migration 0010, `kickParticipant`, its withdrawals, the event and the facade

Spec §3, §4, §5.1, §5.2, §6 (the shape), §9.1, §10, §16.1. **This task carries fifteen `kick.test.ts` cases (the kick itself, its authority, its withdrawals and their races, a human's rejoin, a kicked keeper's recorded authority, an accepted agent, the secrets scan), the `units.test.ts` case and the `db.test.ts` case.**

**Files:**
- Modify: `src/core/src/db/schema.ts` (`participants.kickedAt`; the `revokedAt` comment)
- Generate: `src/core/drizzle/0010_<drizzle-kit's name>.sql`, `src/core/drizzle/meta/0010_snapshot.json`, `src/core/drizzle/meta/_journal.json`
- Modify: `src/core/src/types.ts` (`EVENT_TYPES`; `PublicParticipant.kickedAt`)
- Modify: `src/core/src/actors.ts` (`toPublicParticipant`)
- Rewrite: `src/core/src/participants.ts` (`setRole` unchanged; `KickResult`, `KickOptions`, `kickParticipant`, `withdrawPending`)
- Modify: `src/core/src/lobby/invitations.ts` (the comment in `withdrawInvitation`'s repeat branch)
- Modify: `src/core/src/index.ts` (the facade, after `setRole`; the type export)
- Modify: `src/core/README.md`
- Create: `src/core/test/kick.test.ts`
- Test: `src/core/test/units.test.ts`, `src/core/test/db.test.ts` (and `migration-status.test.ts` unchanged, whose `case 9: assertTransactionSafe accepts every real migration file` covers 0010)

**Interfaces:**
- Consumes: `getLobby(db)`, `lobbyGeneralThreadId(q, lobbyId)`, `generalThreadOf(q, weaveId)`, `withWeaveLocks(db, bus, [a, b], fn)` (its `fn` returns `{ result, events: Record<weaveId, NewEvent[]> }` and the rows are appended in the order given), `assertIsKeeperOf(actor, weaveId)`, `assertStillKeeperOf(tx, actor, weaveId)`, `actorId(actor)`, `isUuid(s)`, `errors.validation(msg)`, `errors.weaveNotFound()`, `resolveInWeave(db, actor, weaveId)`.
- Produces:

```ts
// src/core/src/db/schema.ts, participants: kickedAt: timestamp("kicked_at", { withTimezone: true })  (nullable, no default)
// src/core/src/types.ts: EVENT_TYPES begins "message", "participant.joined", "participant.role_changed", "participant.kicked", ...
// PublicParticipant gains: kickedAt: string | null   (ISO)
// participant.kicked payload: { participantId: string; name: string; kickedBy: string; kickedByName: string }

// src/core/src/participants.ts
export type KickResult = { participantId: string; name: string; seq: number; kickedAt: string; created: boolean; withdrawn: string[] };
export type KickOptions = { beforeLock?: () => Promise<void> };
export async function kickParticipant(db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, opts?: KickOptions): Promise<KickResult>;

// the facade (createCore)
kickParticipant: (actor: Actor, weaveId: string, participantId: string) => Promise<KickResult>;
// @loom/core exports the types KickResult, KickOptions
```

- [ ] **Step 1: Write the failing `units.test.ts` case, and repair `NAMED`.** In `src/core/test/units.test.ts`, inside `describe("EVENT_TYPES (spec 2026-09-28 §10.0)", ...)`, the `NAMED` list's first line (the known ripple: the list the union names gains the new type where spec §5.2 puts it) is today, whole, `    "message", "participant.joined", "participant.role_changed",`. Replace it with:

```ts
    "message", "participant.joined", "participant.role_changed", "participant.kicked",
```

and after that `describe`'s case `EVENT_TYPES holds weave.invitation_withdrawn directly after weave.invited, as its last entry (spec 2026-10-08 §6.2)` add:

```ts
  it("EVENT_TYPES holds participant.kicked directly after participant.role_changed (spec 2026-10-09 §5.2)", () => {
    const at = (t: string) => (EVENT_TYPES as readonly string[]).indexOf(t);
    expect(at("participant.kicked") - at("participant.role_changed")).toBe(1);
  });
```

- [ ] **Step 2: Write the failing `db.test.ts` case.** In `src/core/test/db.test.ts`, inside `describe("migrations", ...)`, directly after the case `v2 columns and tables exist after migration`, add:

```ts
  it("participants.kicked_at exists, a nullable timestamptz with no default (spec 2026-10-09 §3)", async () => {
    const db = await freshDb();
    const rows = await db.execute<{ data_type: string; is_nullable: string; column_default: string | null }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'participants' and column_name = 'kicked_at'`,
    );
    expect(rows.map((r) => [r.data_type, r.is_nullable, r.column_default])).toEqual([["timestamp with time zone", "YES", null]]);
  });
```

- [ ] **Step 3: Write the failing `kick.test.ts`.** Create `src/core/test/kick.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, weaveInvitations, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { archiveWeave, createWeave, joinWeave, type CreateWeaveResult } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { kickParticipant, setRole } from "../src/participants.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby, lobbyGeneralThreadId } from "../src/lobby/lobby.js";
import { inviteToWeave, listInvitations, redeemInvitation, withdrawInvitation } from "../src/lobby/invitations.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { accept, offer, openRequest } from "../src/lobby/requests.js";
import { inbox } from "../src/inbox.js";
import { createCore } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const TITLE = "Loom development";
const KEEPERS_ONLY = { code: "forbidden", message: "Only a keeper of this Weave can do this" };
const NO_SUCH = { code: "validation", message: "No such participant in this Weave" };
const WITHDRAWN = { code: "forbidden", message: "This invitation was withdrawn" };

/** A keyed agent standing in the Lobby that joined the Weave with its key: what an invitation can readmit. */
async function keyedAgent(instanceKeeper: Actor, w: CreateWeaveResult, name: string) {
  const { key } = await addAgent(db, instanceKeeper, name);
  const keyActor = await resolveCredential(db, key);
  const lobbyJoin = await joinLobby(db, bus, { name, kind: "agent" }, keyActor);
  const join = await joinWeave(db, bus, w.secret, { name, kind: "agent" }, keyActor);
  return {
    id: join.participant.id, token: join.token, key, keyActor, actor: await resolveCredential(db, join.token),
    lobbyId: lobbyJoin.participant.id, lobbyToken: lobbyJoin.token, lobbyActor: await resolveCredential(db, lobbyJoin.token),
  };
}
type Agent = Awaited<ReturnType<typeof keyedAgent>>;

/**
 * Loom development, kept by Paw (a human), with a PR Thread; Mia, a human member; Helper, a keyed
 * agent standing in the Lobby and in the Weave; Req, a Lobby participant who opens requests; and the
 * instance keeper.
 */
async function setup() {
  const { weaveId: lobbyId } = await ensureLobby(db);
  await seedKeepers(db, [keeperToken("k")]);
  const instanceKeeper = await resolveCredential(db, keeperToken("k"));
  const keeperId = instanceKeeper.kind === "keeper" ? instanceKeeper.keeperId : "";
  const w = await createWeave(db, bus, { title: TITLE, opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, w.token);
  const pr = await createThread(db, bus, paw, w.weave.id, "PR 14");
  const miaJoin = await joinWeave(db, bus, w.secret, { name: "Mia", kind: "human" });
  const mia = { id: miaJoin.participant.id, token: miaJoin.token, actor: await resolveCredential(db, miaJoin.token) };
  const helper = await keyedAgent(instanceKeeper, w, "Helper");
  const requester = await resolveCredential(db, (await joinLobby(db, bus, { name: "Req", kind: "agent" })).token);
  return { lobbyId, instanceKeeper, keeperId, w, weaveId: w.weave.id, paw, pawId: w.participant.id, pr, mia, helper, requester };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const row = async (id: string) => (await db.select().from(participants).where(eq(participants.id, id)))[0]!;
const invitation = async (id: string) => (await db.select().from(weaveInvitations).where(eq(weaveInvitations.id, id)))[0]!;
const pin = (id: string, at: Date) => db.update(weaveInvitations).set({ createdAt: at }).where(eq(weaveInvitations.id, id));
const weaveLog = (f: Fixture): Promise<LoomEvent[]> => readEvents(db, f.weaveId, {});
const lobbyLog = (f: Fixture): Promise<LoomEvent[]> => readEvents(db, f.lobbyId, {});
const kicks = async (f: Fixture) => (await weaveLog(f)).filter((e) => e.type === "participant.kicked");
const withdrawals = async (f: Fixture) => (await lobbyLog(f)).filter((e) => e.type === "weave.invitation_withdrawn");
/** Paw invites the agent's Lobby participant straight into the PR Thread: a direct invitation. */
const directInvite = (f: Fixture, agent: Agent = f.helper) => inviteToWeave(db, bus, f.paw, agent.lobbyId, f.weaveId, f.pr.id);
/** A request Req opened into the Weave on `authority`'s standing, with the agent's offer on it. */
async function offered(f: Fixture, agent: Agent = f.helper, authority: Actor = f.paw, title = "Review PR 14") {
  await setCapabilities(db, bus, agent.lobbyActor, { owner: "paw", serves: "anyone" });
  const request = await openRequest(db, bus, f.requester, authority, {
    title, requirements: {}, wanted: 1, targetWeaveId: f.weaveId, targetThreadId: f.pr.id, url: null,
  });
  await offer(db, bus, agent.lobbyActor, request.id, {});
  return request;
}
/** The same, accepted: one invitation of the request's to the agent. */
async function requestInvite(f: Fixture, agent: Agent = f.helper, title = "Review PR 14") {
  const request = await offered(f, agent, f.paw, title);
  const { invitationIds } = await accept(db, bus, f.requester, request.id, [agent.lobbyId], { deadlineMs: 3_600_000 });
  return { request, invitationId: invitationIds[0]! };
}
/** A second Weave with a keeper of its own, Kay: a keeper, but not of Loom development. */
async function elsewhere() {
  const w = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Kay", kind: "human" } });
  const kay = await resolveCredential(db, w.token);
  return { w, kay, kayId: w.participant.id, thread: await createThread(db, bus, kay, w.weave.id, "Side") };
}

describe("kickParticipant (spec 2026-10-09 §4)", () => {
  it("a keeper kicks a member: kicked_at set, role member, one participant.kicked on General with the exact payload, and the answer names it", async () => {
    const f = await setup();
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const after = await row(f.mia.id);
    expect([after.kickedAt instanceof Date, after.role]).toEqual([true, "member"]);
    const all = await kicks(f);
    expect(all).toHaveLength(1);
    const event = all[0]!;
    expect(r).toEqual({ participantId: f.mia.id, name: "Mia", seq: event.seq, kickedAt: after.kickedAt!.toISOString(), created: true, withdrawn: [] });
    expect([event.threadId, event.actor]).toEqual([f.w.generalThread.id, f.pawId]);
    expect(event.payload).toEqual({ participantId: f.mia.id, name: "Mia", kickedBy: f.pawId, kickedByName: "Paw" });
  });

  it("the authority matrix: a keeper and the instance keeper kick, a keeper kicks another keeper, an agent key kicks through the facade; everyone else is refused and nothing is written", async () => {
    const f = await setup();
    const other = await elsewhere();
    const secret = await resolveCredential(db, f.w.secret);
    const refused: [Actor, { code: string; message: string }][] = [
      [f.mia.actor, KEEPERS_ONLY], [other.kay, KEEPERS_ONLY], [secret, KEEPERS_ONLY],
      [f.helper.keyActor, { code: "forbidden", message: "Join the Weave first" }],   // a raw agent key, never resolved into the Weave
    ];
    for (const [actor, answer] of refused) {
      await expect(kickParticipant(db, bus, actor, f.weaveId, f.helper.id)).rejects.toMatchObject(answer);
    }
    expect([(await row(f.helper.id)).kickedAt, await kicks(f)]).toEqual([null, []]);

    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, f.mia.id);
    expect((await kicks(f))[0]).toMatchObject({ actor: `keeper:${f.keeperId}`, payload: { kickedBy: `keeper:${f.keeperId}`, kickedByName: "Keeper" } });

    // Through the facade an agent key stands for the participant it owns in the Weave: here a keeper,
    // who kicks Paw, another keeper. Paw's role is member from then on.
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    const core = createCore(db);
    expect(await core.kickParticipant(f.helper.keyActor, f.weaveId, f.pawId)).toMatchObject({ participantId: f.pawId, name: "Paw", created: true });
    expect((await row(f.pawId)).role).toBe("member");
    expect((await kicks(f)).at(-1)!.payload).toEqual({ participantId: f.pawId, name: "Paw", kickedBy: f.helper.id, kickedByName: "Helper" });
    // A key with no participant in the Weave is told to join first, by resolveInWeave.
    const { key } = await addAgent(db, f.instanceKeeper, "Stranger");
    await expect(core.kickParticipant(await resolveCredential(db, key), f.weaveId, f.helper.id))
      .rejects.toMatchObject({ code: "forbidden", message: "Join the Weave first" });
  });

  it("nobody kicks itself: a keeper, and an agent key mapped to a keeper, are told so", async () => {
    const f = await setup();
    const self = { code: "validation", message: "You cannot kick yourself" };
    await expect(kickParticipant(db, bus, f.paw, f.weaveId, f.pawId)).rejects.toMatchObject(self);
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    await expect(createCore(db).kickParticipant(f.helper.keyActor, f.weaveId, f.helper.id)).rejects.toMatchObject(self);
    expect(await kicks(f)).toEqual([]);
  });

  it("a keeper demoted after its credential was resolved is refused inside the lock, and the target is unchanged", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper");
    const miaKeeper = await resolveCredential(db, f.mia.token);
    await expect(kickParticipant(db, bus, miaKeeper, f.weaveId, f.helper.id, {
      beforeLock: async () => { await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "member"); },
    })).rejects.toMatchObject(KEEPERS_ONLY);
    expect([(await row(f.helper.id)).kickedAt, await kicks(f)]).toEqual([null, []]);
  });

  it("the Lobby is refused, and nothing is written", async () => {
    const f = await setup();
    const before = (await lobbyLog(f)).length;
    // The instance keeper passes the authority check for any Weave, so this reaches the Lobby rule.
    await expect(kickParticipant(db, bus, f.instanceKeeper, f.lobbyId, f.helper.lobbyId))
      .rejects.toMatchObject({ code: "validation", message: "Nobody is kicked from the Lobby" });
    expect([(await row(f.helper.lobbyId)).kickedAt, (await lobbyLog(f)).length]).toEqual([null, before]);
  });

  it("an unknown, malformed or other Weave's participant answers No such participant; a malformed weaveId is weave_not_found", async () => {
    const f = await setup();
    const other = await elsewhere();
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope", other.kayId]) {
      await expect(kickParticipant(db, bus, f.paw, f.weaveId, id)).rejects.toMatchObject(NO_SUCH);
    }
    await expect(kickParticipant(db, bus, f.paw, "nope", f.mia.id)).rejects.toMatchObject({ code: "weave_not_found" });
    expect(await kicks(f)).toEqual([]);
  });

  it("an archived Weave: the kick still works and is announced", async () => {
    const f = await setup();
    await archiveWeave(db, bus, f.paw, f.weaveId);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id)).created).toBe(true);
    expect((await kicks(f)).map((e) => e.payload.participantId)).toEqual([f.mia.id]);
  });

  it("an invitation pending at the kick is withdrawn by it, whatever its timestamp, and cannot readmit", async () => {
    const f = await setup();
    const other = await elsewhere();
    const rex = await keyedAgent(f.instanceKeeper, f.w, "Rex");
    // Untouched by the kick: one already redeemed (an adoption, before it), one into another Weave,
    // and one to another agent.
    const redeemed = await directInvite(f);
    await redeemInvitation(db, bus, f.helper.keyActor, redeemed.invitationId, { kind: "agent" });
    const intoOther = await inviteToWeave(db, bus, other.kay, f.helper.lobbyId, other.w.weave.id, other.thread.id);
    const toRex = await directInvite(f, rex);
    // The two that can readmit Helper, committed before the kick, then dated an hour after it: a
    // database clock that stepped backwards (KNOWN-ISSUES, the wall-clock created_at row).
    const direct = await directInvite(f);
    const viaRequest = await requestInvite(f);
    const later = Date.now() + 3_600_000;
    await pin(direct.invitationId, new Date(later));
    await pin(viaRequest.invitationId, new Date(later + 1000));

    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const kickedAt = (await row(f.helper.id)).kickedAt!;
    expect(r.withdrawn).toEqual([direct.invitationId, viaRequest.invitationId]);
    for (const id of r.withdrawn) expect((await invitation(id)).revokedAt?.getTime()).toBe(kickedAt.getTime());
    for (const id of r.withdrawn) for (const actor of [f.helper.keyActor, f.helper.lobbyActor]) {
      await expect(redeemInvitation(db, bus, actor, id, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    }
    expect((await row(f.helper.id)).kickedAt).toEqual(kickedAt);
    for (const id of r.withdrawn) expect((await invitation(id)).redeemedAt).toBeNull();
    for (const id of [redeemed.invitationId, intoOther.invitationId, toRex.invitationId]) expect((await invitation(id)).revokedAt).toBeNull();
  });

  it("the kick announces each withdrawal to its invitee, where its weave.invited landed, in withdrawInvitation's own shape", async () => {
    const f = await setup();
    const direct = await directInvite(f);
    const viaRequest = await requestInvite(f);
    await pin(direct.invitationId, new Date("2026-10-01T10:00:00.000Z"));
    await pin(viaRequest.invitationId, new Date("2026-10-01T10:00:01.000Z"));
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const events = await withdrawals(f);
    expect(events.map((e) => e.payload.invitationId)).toEqual([direct.invitationId, viaRequest.invitationId]);
    expect(events.map((e) => e.threadId)).toEqual([await lobbyGeneralThreadId(db, f.lobbyId), viaRequest.request.threadId]);
    for (const [i, e] of events.entries()) {
      expect(e.actor).toBe(f.pawId);
      expect(e.payload).toEqual({ invitationId: r.withdrawn[i], participantId: f.helper.lobbyId, targetWeaveTitle: TITLE, withdrawnBy: f.pawId, withdrawnByName: "Paw" });
    }
    const told = (await inbox(db, f.helper.lobbyActor, f.lobbyId, {})).filter((e) => e.type === "weave.invitation_withdrawn");
    expect(told.map((e) => e.payload.invitationId)).toEqual(r.withdrawn);
    expect(await listInvitations(db, f.paw, f.weaveId)).toEqual([]);
    const again = await withdrawInvitation(db, bus, f.paw, f.weaveId, direct.invitationId);
    expect([again.created, again.seq]).toEqual([false, events[0]!.seq]);

    // The instance keeper's kick names it Keeper.
    const rex = await keyedAgent(f.instanceKeeper, f.w, "Rex");
    const toRex = await directInvite(f, rex);
    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, rex.id);
    expect((await withdrawals(f)).at(-1)).toMatchObject({ actor: `keeper:${f.keeperId}`,
      payload: { invitationId: toRex.invitationId, participantId: rex.lobbyId, withdrawnBy: `keeper:${f.keeperId}`, withdrawnByName: "Keeper" } });
  });

  it("a participant with no agent withdraws nothing: a human, and an agent that joined by secret without a key", async () => {
    const f = await setup();
    const hu = await joinLobby(db, bus, { name: "Hu", kind: "human" });
    const forHu = await inviteToWeave(db, bus, f.paw, hu.participant.id, f.weaveId, f.pr.id);
    expect((await invitation(forHu.invitationId)).inviteeAgentId).toBeNull();
    const carl = await joinWeave(db, bus, f.w.secret, { name: "Carl", kind: "agent" });
    const before = (await lobbyLog(f)).length;
    for (const id of [f.mia.id, carl.participant.id]) {
      expect((await kickParticipant(db, bus, f.paw, f.weaveId, id)).withdrawn).toEqual([]);
    }
    expect([(await lobbyLog(f)).length, (await invitation(forHu.invitationId)).revokedAt]).toEqual([before, null]);
  });

  it("a kick racing redeemInvitation: both settle, and either the redemption came first or the kick withdrew the invitation", async () => {
    const f = await setup();
    const { invitationId } = await directInvite(f);
    const [k, r] = await Promise.allSettled([
      kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id),
      redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" }),
    ]);
    if (k.status !== "fulfilled") throw k.reason;
    const inv = await invitation(invitationId);
    if (r.status === "fulfilled") {
      const invited = (await weaveLog(f)).filter((e) => e.type === "thread.invited" && e.payload.participantId === f.helper.id).at(-1)!;
      expect([k.value.withdrawn, inv.redeemedAt instanceof Date, inv.revokedAt, invited.seq < k.value.seq]).toEqual([[], true, null, true]);
    } else {
      expect(r.reason).toMatchObject(WITHDRAWN);
      expect([k.value.withdrawn, inv.redeemedAt, inv.revokedAt instanceof Date]).toEqual([[invitationId], null, true]);
    }
    expect((await row(f.helper.id)).kickedAt).toBeInstanceOf(Date);
  });

  it("a human rejoins only under a new name", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await expect(joinWeave(db, bus, f.w.secret, { name: "Mia", kind: "human" })).rejects.toMatchObject({ code: "name_taken" });
    const again = await joinWeave(db, bus, f.w.secret, { name: "Mia-2", kind: "human" });
    expect(again.participant.id).not.toBe(f.mia.id);
  });

  it("a kicked keeper loses its recorded authority: accept refuses as after a demotion", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper");
    const miaKeeper = await resolveCredential(db, f.mia.token);
    const request = await offered(f, f.helper, miaKeeper);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await expect(accept(db, bus, f.requester, request.id, [f.helper.lobbyId], { deadlineMs: 3_600_000 }))
      .rejects.toMatchObject({ code: "forbidden", message: "The requester is no longer a keeper of the target Weave" });
  });

  it("an accepted agent kicked from the work Weave: its acceptance stands, its request invitation is withdrawn, and the removal then frees the slot with no second withdrawal", async () => {
    const f = await setup();
    const { request, invitationId } = await requestInvite(f);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).withdrawn).toEqual([invitationId]);
    const acceptance = async () => (await db.select().from(requestOffers)
      .where(and(eq(requestOffers.requestId, request.id), eq(requestOffers.participantId, f.helper.lobbyId))))[0]!;
    expect([(await acceptance()).accepted, (await acceptance()).removedAt]).toEqual([true, null]);
    expect((await removeParticipant(db, bus, f.requester, request.threadId, f.helper.lobbyId)).acceptanceRemoved).toBe(true);
    expect((await acceptance()).removedAt).toBeInstanceOf(Date);
    expect((await withdrawals(f)).filter((e) => e.payload.invitationId === invitationId)).toHaveLength(1);
  });

  it("no kick event, and no withdrawal a kick writes, carries a secret, a token or the agent key", async () => {
    const f = await setup();
    await directInvite(f);
    await requestInvite(f);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await kickParticipant(db, bus, f.instanceKeeper, f.weaveId, f.mia.id);
    const secrets = [
      f.helper.key, keeperToken("k"),
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((w) => w.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const weave = await weaveLog(f);
    const lobby = await lobbyLog(f);
    expect([weave.some((e) => e.type === "participant.kicked"), lobby.some((e) => e.type === "weave.invitation_withdrawn")]).toEqual([true, true]);
    for (const e of [...weave, ...lobby]) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/units.test.ts test/db.test.ts test/kick.test.ts`
Expected: FAIL. `units.test.ts`: the repaired `NAMED` case (EVENT_TYPES lacks the type) and the new position case; `db.test.ts`: the new case (no `kicked_at` row, so `[]`); `kick.test.ts`: the whole file, `does not provide an export named 'kickParticipant'`. Capture this output for the report.

- [ ] **Step 5: The column and the comment.** In `src/core/src/db/schema.ts`, in `participants`, directly after the line that is today, whole, `  seenHistory: timestamp("seen_history", { withTimezone: true }).array(),`, add:

```ts
  // Kicked out of this Weave by a keeper (spec 2026-10-09): the token and any agent key's mapping
  // here are refused from then on; the row stays, because events name it and the history keeps its
  // name. Cleared when a keeper's invitation readmits it (lobby/invitations.ts).
  kickedAt: timestamp("kicked_at", { withTimezone: true }),
```

and in `weaveInvitations`, replace the two comment lines above `revokedAt`, today, whole, `  // Withdrawn: by a removal from the request Thread (removals.ts) for a request's invitation, by` and ``  // `withdrawInvitation` (lobby/invitations.ts) for a direct one. Public shapes call it `withdrawnAt`.``, with:

```ts
  // Withdrawn: by a removal from the request Thread (removals.ts) for a request's invitation, by
  // `withdrawInvitation` (lobby/invitations.ts) for a direct one, or by a kick of the invitee's agent
  // from the target Weave (participants.ts). Public shapes call it `withdrawnAt`.
```

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @loom/core db:generate`
Expected: drizzle-kit prints one new migration, `drizzle/0010_<name>.sql`. Then prove its content, the journal entry and the line endings, from the worktree root:

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
const dir = "src/core/drizzle";
const file = fs.readdirSync(dir).find((n) => n.startsWith("0010_") && n.endsWith(".sql"));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const got = fs.readFileSync(`${dir}/${file}`, "utf8").split("--> statement-breakpoint").map(norm).filter(Boolean);
const want = ['ALTER TABLE "participants" ADD COLUMN "kicked_at" timestamp with time zone;'];
const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8")).entries.at(-1);
console.log(JSON.stringify(got) === JSON.stringify(want) ? `0010 statements ok: ${file}` : `0010 MISMATCH:\n${got.join("\n")}`);
console.log(journal.idx === 10 && journal.when > 1790879530257 && `${journal.tag}.sql` === file ? "journal ok" : `journal MISMATCH: ${JSON.stringify(journal)}`);
console.log(fs.existsSync(`${dir}/meta/0010_snapshot.json`) ? "snapshot ok" : "snapshot MISSING");
CHECK
git add src/core/drizzle && git ls-files --eol src/core/drizzle/0010_*.sql src/core/drizzle/meta/0010_snapshot.json src/core/drizzle/meta/_journal.json
git diff --cached --stat -- src/core/drizzle
```

Expected: `0010 statements ok: 0010_<name>.sql`, `journal ok`, `snapshot ok`, three `git ls-files --eol` rows each starting `i/lf    w/lf`, and a stat of exactly those three files (no older migration, journal entry or snapshot changed). A `MISMATCH` means the schema edit is not exactly Step 5. To regenerate: delete the `.sql` and `meta/0010_snapshot.json`, restore the journal with `git restore --source=HEAD --staged --worktree -- src/core/drizzle/meta/_journal.json`, fix the schema and generate again (CONTRIBUTING, "Migrations": three deletions, not two). A `w/crlf` row means the working copy was written with CRLF: `rm` that file and `git checkout -- <file>` to renormalise it. A `journal MISMATCH` on `when` (the machine's clock reads earlier than 0009's stamp) stops the task: report it rather than editing the stamp.

- [ ] **Step 7: The event type and the public shape.** In `src/core/src/types.ts`, replace the `EVENT_TYPES` line that is today, whole, `  "message", "participant.joined", "participant.role_changed",` with:

```ts
  "message", "participant.joined", "participant.role_changed", "participant.kicked",
```

and in `PublicParticipant`, directly after the line that is today, whole, `  lastSeenAt: string | null;`, add:

```ts
  /**
   * When a keeper kicked it out of this Weave (spec 2026-10-09 §6), ISO; null while it is here. A
   * kicked participant stays in `getWeave`'s list so names in the history resolve; every list that
   * means "who is here" leaves it out.
   */
  kickedAt: string | null;
```

- [ ] **Step 8: The mapping.** In `src/core/src/actors.ts`, in `toPublicParticipant`, replace the line that is today, whole, `    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null };` with:

```ts
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null, kickedAt: p.kickedAt ? p.kickedAt.toISOString() : null };
```

- [ ] **Step 9: `kickParticipant`.** Replace the whole of `src/core/src/participants.ts` with (its `setRole` is today's, unchanged; Task 2 adds its refusal):

```ts
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/index.js";
import { events, participants, requests, weaveInvitations } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock, withWeaveLocks, type NewEvent } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";
import { generalThreadOf } from "./threads.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby/lobby.js";
import type { Actor, PublicParticipant, Role } from "./types.js";

export async function setRole(db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, role: Role): Promise<PublicParticipant> {
  assertIsKeeperOf(actor, weaveId);
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  if (role !== "member" && role !== "keeper") throw errors.validation("role must be member or keeper");
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Weave");
  const general = await generalThreadOf(db, weaveId);
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    await assertStillKeeperOf(tx, actor, weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [p] = await tx.update(participants).set({ role })
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).returning();
    if (!p) throw errors.validation("No such participant in this Weave");
    return {
      result: toPublicParticipant(p),
      events: [{ threadId: general.id, type: "participant.role_changed" as const, actor: actorId(actor), payload: { participantId, role } }],
    };
  });
}

/**
 * What a kick answers (spec 2026-10-09 §4.1). `kickedAt` is the row's `kicked_at`, ISO. `withdrawn`
 * is the ids of the invitations this call withdrew (§4.6), oldest first; empty when there were none
 * and on a repeat.
 */
export type KickResult = {
  participantId: string; name: string; seq: number; kickedAt: string; created: boolean; withdrawn: string[];
};

export type KickOptions = {
  /** Test seam: runs after the checks made outside the lock and before the lock is taken. */
  beforeLock?: () => Promise<void>;
};

const NO_SUCH_PARTICIPANT = "No such participant in this Weave";

/**
 * Kicks a participant out of a Weave (spec 2026-10-09 §4): its `kicked_at` is set and its role is
 * `member` from then on, so its token is refused on every surface, an agent key's mapping there is
 * refused, and every keeper re-check that reads a fresh row reads it as no keeper. The row stays, so
 * the history keeps its name. A keeper of the Weave or the instance keeper token, re-checked inside
 * the lock; never oneself; never in the Lobby; an archived Weave is no obstacle, since a kick only
 * removes access. One `participant.kicked` lands on the Weave's General Thread. A repeat writes
 * nothing and answers the newest kick's seq with `created: false`.
 *
 * The kick also withdraws the kicked agent's invitations into this Weave still pending, direct or a
 * request's, each told to its invitee with `weave.invitation_withdrawn` (§4.6): an invitation pending
 * at the kick would otherwise readmit it. No clock is compared. Every flow that writes or redeems an
 * invitation holds this Weave's lock, so at this commit every invitation that could adopt the kicked
 * row is withdrawn, spent, or not yet written; one redeemable afterwards was issued after the kick.
 *
 * The Lobby's lock, then the Weave's, always: the withdrawals append to the Lobby's log, whether
 * there are any can only be known inside the Weave's lock, and that order is the one every
 * cross-Weave flow uses, so no deadlock is added.
 */
export async function kickParticipant(
  db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, opts: KickOptions = {},
): Promise<KickResult> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  // The authority before anything is read about the participant: a non-keeper learns nothing of the id.
  assertIsKeeperOf(actor, weaveId);
  const { weaveId: lobbyId } = await getLobby(db);
  // A Listener leaves the Lobby's directory by clearing its own profile; and withWeaveLocks must not
  // be asked for the same row twice.
  if (weaveId === lobbyId) throw errors.validation("Nobody is kicked from the Lobby");
  if (!isUuid(participantId)) throw errors.validation(NO_SUCH_PARTICIPANT);
  // An agent key reaches here already mapped to its participant by the facade; an instance keeper
  // has no participant row and cannot meet this.
  if (actor.kind === "participant" && actor.participant.id === participantId) throw errors.validation("You cannot kick yourself");
  const general = await generalThreadOf(db, weaveId);
  if (opts.beforeLock) await opts.beforeLock();
  return withWeaveLocks<KickResult>(db, bus, [lobbyId, weaveId], async (tx, byId) => {
    const weave = byId[weaveId]!;
    // The role the actor carries was captured when its credential was resolved; it may have been
    // taken away since. No archived check (§4.3).
    await assertStillKeeperOf(tx, actor, weaveId);
    const [p] = await tx.select().from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).for("update");
    if (!p) throw errors.validation(NO_SUCH_PARTICIPANT);
    if (p.kickedAt) {
      // Only this function sets kicked_at, and always writes its event in the same transaction, so
      // the newest participant.kicked naming the id is the kick that holds (§4.4); 0 when none is
      // found, the "none" value lastRemovalSeq uses. A repeat withdraws nothing: an invitation
      // pending now was issued after the first kick, by a keeper who meant to readmit.
      const [kick] = await tx.select({ seq: events.seq }).from(events)
        .where(and(eq(events.weaveId, weaveId), eq(events.type, "participant.kicked"),
          sql`${events.payload}->>'participantId' = ${participantId}`))
        .orderBy(desc(events.seq)).limit(1);
      return {
        result: { participantId, name: p.name, seq: kick?.seq ?? 0, kickedAt: p.kickedAt.toISOString(), created: false, withdrawn: [] },
        events: {},
      };
    }
    // One clock read: the row's kicked_at and every withdrawal's revoked_at. Shown, never compared (§3).
    const now = new Date();
    // role member in the same statement: every keeper re-check reads role, so a kicked keeper loses
    // keepership at this commit in every in-flight path (§3).
    await tx.update(participants).set({ kickedAt: now, role: "member" }).where(eq(participants.id, participantId));
    const by = actorId(actor);
    // A reader whose names miss either principal still names both from the payload (§5.1).
    const byName = actor.kind === "participant" ? actor.participant.name : "Keeper";
    const lobbyNews = p.agentId ? await withdrawPending(tx, lobbyId, weaveId, weave.title, p.agentId, now, by, byName) : [];
    const kicked: NewEvent = {
      threadId: general.id, type: "participant.kicked", actor: by,
      payload: { participantId, name: p.name, kickedBy: by, kickedByName: byName },
    };
    return {
      result: {
        participantId, name: p.name, seq: weave.lastSeq + 1, kickedAt: now.toISOString(), created: true,
        withdrawn: lobbyNews.map((e) => String(e.payload.invitationId)),
      },
      // withWeaveLocks appends and publishes the Lobby's events first, then the Weave's.
      events: { [lobbyId]: lobbyNews, [weaveId]: [kicked] },
    };
  });
}

/**
 * Withdraws the kicked agent's invitations into `weaveId` still pending (spec 2026-10-09 §4.6): only
 * these can adopt its row, because `redeemInvitation` adopts the participant whose `agent_id` is the
 * invitation's `invitee_agent_id`, whichever credential redeems it. Returns one
 * `weave.invitation_withdrawn` per row, oldest first, on the Thread its `weave.invited` landed on: the
 * Lobby's General for a direct invitation, the request's Thread for a request's. The payload is
 * `withdrawInvitation`'s exactly.
 */
async function withdrawPending(
  tx: Tx, lobbyId: string, weaveId: string, weaveTitle: string, agentId: string, now: Date, by: string, byName: string,
): Promise<NewEvent[]> {
  const rows = await tx.update(weaveInvitations).set({ revokedAt: now })
    .where(and(eq(weaveInvitations.targetWeaveId, weaveId), eq(weaveInvitations.inviteeAgentId, agentId),
      isNull(weaveInvitations.redeemedAt), isNull(weaveInvitations.revokedAt)))
    .returning({ id: weaveInvitations.id, participantId: weaveInvitations.inviteeParticipantId,
      requestId: weaveInvitations.requestId, createdAt: weaveInvitations.createdAt });
  // For a stable event order only; nothing is decided on it.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: NewEvent[] = [];
  for (const r of rows) {
    let threadId: string;
    if (r.requestId === null) {
      threadId = await lobbyGeneralThreadId(tx, lobbyId);
    } else {
      // A request's Thread may be closed; appendInTx does not look at closed_at, and a closed Thread
      // refuses posts, not system events.
      const [req] = await tx.select({ threadId: requests.threadId }).from(requests).where(eq(requests.id, r.requestId));
      threadId = req!.threadId;
    }
    out.push({ threadId, type: "weave.invitation_withdrawn", actor: by,
      payload: { invitationId: r.id, participantId: r.participantId, targetWeaveTitle: weaveTitle, withdrawnBy: by, withdrawnByName: byName } });
  }
  return out;
}
```

- [ ] **Step 10: The `withdrawInvitation` comment (spec §4.6).** In `src/core/src/lobby/invitations.ts`, in `withdrawInvitation`'s repeat branch, replace the two comment lines that are today, whole, `      // Only this function withdraws a direct invitation, and always writes its event in the same` and `      // transaction, so the newest event naming the id is that withdrawal (spec §4.4); 0 when none` with:

```ts
      // Only this function and a kick (participants.ts) withdraw a direct invitation, and each writes
      // its event in the same transaction, so the newest event naming the id is that withdrawal (spec
      // §4.4; 2026-10-09 §4.6); 0 when none
```

(the third line, `      // is found, the "none" value lastRemovalSeq uses.`, stays).

- [ ] **Step 11: The facade (spec §9.1).** In `src/core/src/index.ts`, replace the import line `import { setRole } from "./participants.js";` with `import { kickParticipant, setRole } from "./participants.js";`; directly after the facade's `setRole` entry (the line that begins `    setRole: async (actor: Actor, weaveId: string, participantId: string, role: Role) =>`) add:

```ts
    // A keeper action on one participant, resolved as setRole is (spec 2026-10-09 §9.1): an agent key
    // stands for the participant it owns in the Weave.
    kickParticipant: async (actor: Actor, weaveId: string, participantId: string) =>
      kickParticipant(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, participantId),
```

and directly after the line `export { type RemovalResult } from "./removals.js";` add:

```ts
export { type KickResult, type KickOptions } from "./participants.js";
```

- [ ] **Step 12: Run them to verify they pass**

Run: `pnpm -r build && cd src/core && npx vitest run test/units.test.ts test/db.test.ts test/kick.test.ts test/migration-status.test.ts`
Expected: PASS, pristine; `case 9: assertTransactionSafe accepts every real migration file` now covers eleven files.

- [ ] **Step 13: `src/core/README.md`.** Replace the line that begins `- **Participants**` (today `- **Participants**`, an em dash, then `` `setRole`, `resolveCredential`, `resolveInWeave` ``; the rewrite drops the em dash for a colon) with:

```text
- **Participants**: `setRole`, `kickParticipant` (a keeper takes a participant out of the Weave; its token is refused from then on, and only a keeper's invitation readmits it), `resolveCredential`, `resolveInWeave`
```

and the line that begins ``- [src/participants.ts](src/participants.ts)`` (today it, an em dash, then `` `setRole` ``) with:

```text
- [src/participants.ts](src/participants.ts): `setRole`, and `kickParticipant` (under the Lobby then Weave locks; it writes `participant.kicked` and withdraws the kicked agent's pending invitations into the Weave)
```

- [ ] **Step 14: Build, typecheck, then the whole core suite**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. `PublicParticipant` gains a required field, but no other package builds one by hand (the client's `Participant` is its own type, changed in Task 4).

- [ ] **Step 15: Commit**

```bash
git add src/core/src/db/schema.ts src/core/drizzle src/core/src/types.ts src/core/src/actors.ts src/core/src/participants.ts src/core/src/lobby/invitations.ts src/core/src/index.ts src/core/README.md src/core/test/units.test.ts src/core/test/db.test.ts src/core/test/kick.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(core): a keeper kicks a participant out of a Weave (migration 0010)" -m "Migration 0010 adds participants.kicked_at (nullable timestamptz). kickParticipant checks keepership before reading anything, refuses the Lobby and oneself, takes the Lobby then Weave locks, re-checks keepership inside them, sets kicked_at and role member, withdraws the kicked agent's pending invitations into the Weave (each announced with weave.invitation_withdrawn where its weave.invited landed), and writes participant.kicked on General; a repeat answers the newest kick's seq. PublicParticipant gains kickedAt; the facade gains kickParticipant. Ripple repaired: units.test.ts 'EVENT_TYPES holds every type the EventType union named, each once, and EventType accepts exactly those' (NAMED gains the type)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---
### Task 2: core: the refusals and the way back

Spec §6 (the mention filter, the export), §7, §11.2, §14, §16.1. **This task carries the remaining eleven `kick.test.ts` cases: the idempotent repeat with readmission, the token and the agent key refused, the secret path refused, readmission and its timestamps, a kick racing `inviteToWeave` (two cases), names in the history and the export, mentions, and the two Thread-level refusals.**

**Files:**
- Modify: `src/core/src/actors.ts` (`REMOVED_FROM_WEAVE`; `resolveCredential`; `resolveInWeave`)
- Modify: `src/core/src/weaves.ts` (the actors import; `asAlreadyJoined` in `joinWeave`)
- Modify: `src/core/src/lobby/invitations.ts` (`redeemInvitation`)
- Modify: `src/core/src/participants.ts` (`KICKED_TARGET`; the `setRole` refusal)
- Modify: `src/core/src/invites.ts` (the import; the invitee read)
- Modify: `src/core/src/messages.ts` (the import; the mention read)
- Modify: `src/core/src/export.ts` (the Participants line; one `sys` arm)
- Test: `src/core/test/kick.test.ts`

**Interfaces:**
- Consumes: Task 1's `kickParticipant`, `KickResult`, `PublicParticipant.kickedAt`, `participants.kickedAt`, the facade's `kickParticipant`; `newSecret()` (`src/core/src/ids.ts`, already imported by `invitations.ts`).
- Produces:

```ts
// src/core/src/actors.ts
export const REMOVED_FROM_WEAVE = "You were removed from this Weave";
// resolveCredential: a participant token whose row has kicked_at set throws forbidden REMOVED_FROM_WEAVE, before stampSeen
// resolveInWeave: an agent key whose participant in weaveId has kickedAt set throws forbidden REMOVED_FROM_WEAVE, before stampSeen

// src/core/src/participants.ts
export const KICKED_TARGET = "That participant was kicked from this Weave";   // setRole and inviteParticipant, validation

// joinWeave: adopting a kicked participant throws forbidden "You were removed from this Weave: a keeper must invite you back"
// redeemInvitation: adopting a kicked participant readmits it: kicked_at null, role member, a new token,
//   participant.joined then thread.invited on the invitation's Thread, alreadyJoined false
// postMessage: mentions resolve against participants whose kicked_at is null
// exportWeave md: "<name> was kicked by <kickedByName>"; Participants line "Name (kind, role, kicked)"
```

- [ ] **Step 1: Write the failing cases.** In `src/core/test/kick.test.ts`, replace the import line `import { resolveCredential } from "../src/actors.js";` with:

```ts
import { resolveCredential, resolveInWeave } from "../src/actors.js";
```

the import line `import { archiveWeave, createWeave, joinWeave, type CreateWeaveResult } from "../src/weaves.js";` with:

```ts
import { archiveWeave, createWeave, getWeave, joinWeave, type CreateWeaveResult } from "../src/weaves.js";
import { postMessage } from "../src/messages.js";
import { inviteParticipant } from "../src/invites.js";
import { exportWeave } from "../src/export.js";
```

and append at the end of the file:

```ts
describe("the refusals and the way back (spec 2026-10-09 §7)", () => {
  const REMOVED = { code: "forbidden", message: "You were removed from this Weave" };
  const REJOIN = { code: "forbidden", message: "You were removed from this Weave: a keeper must invite you back" };

  it("a repeat is idempotent: the first call's seq and kickedAt; an invitation issued between the two survives the repeat and readmits; after a second kick the repeat answers its seq", async () => {
    const f = await setup();
    const first = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    expect(await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id)).toEqual({ ...first, created: false });
    expect(await kicks(f)).toHaveLength(1);

    const kicked = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const { invitationId } = await directInvite(f);       // a keeper means to readmit
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).withdrawn).toEqual([]);
    expect((await invitation(invitationId)).revokedAt).toBeNull();
    const back = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([back.participant.id, back.participant.kickedAt]).toEqual([f.helper.id, null]);
    const second = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    expect(second.seq).toBeGreaterThan(kicked.seq);
    expect((await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id)).seq).toBe(second.seq);
  });

  it("the kicked token is refused on every path with You were removed from this Weave, and checks nothing in", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    await db.update(participants).set({ lastSeenAt: null }).where(eq(participants.id, f.mia.id));
    const core = createCore(db);
    // Every adapter turns the bearer string into an Actor with resolveCredential first (requireActor,
    // CoreToolBackend.actor, the WebSocket ticket and upgrade, a request's target credential), so each
    // call below resolves the token as they do.
    const as = () => core.resolveCredential(f.mia.token);
    const calls: [string, () => Promise<unknown>][] = [
      ["getWeave", async () => core.getWeave(await as(), f.weaveId)],
      ["readEvents", async () => core.readEvents(await as(), f.weaveId, {})],
      ["inbox", async () => core.inbox(await as(), f.weaveId, {})],
      ["postMessage", async () => core.postMessage(await as(), f.w.generalThread.id, "still here?")],
      ["createThread", async () => core.createThread(await as(), f.weaveId, "Mine")],
      ["markRead", async () => core.markRead(await as(), f.w.generalThread.id, 1)],
      ["readPositions", async () => core.readPositions(await as(), f.weaveId)],
      ["exportWeave", async () => core.exportWeave(await as(), f.weaveId, "md")],
      ["openRequest, as the target credential", async () => core.openRequest(f.requester, await as(),
        { title: "Review", requirements: {}, targetWeaveId: f.weaveId, targetThreadId: f.pr.id })],
    ];
    for (const [label, call] of calls) await expect(call(), label).rejects.toMatchObject(REMOVED);
    expect((await row(f.mia.id)).lastSeenAt).toBeNull();
  });

  it("the agent key is refused in that Weave only: the Lobby and another Weave it is in still answer", async () => {
    const f = await setup();
    const other = await elsewhere();
    await joinWeave(db, bus, other.w.secret, { name: "Helper", kind: "agent" }, f.helper.keyActor);
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await expect(resolveInWeave(db, f.helper.keyActor, f.weaveId)).rejects.toMatchObject(REMOVED);
    const core = createCore(db);
    await expect(core.getWeave(f.helper.keyActor, f.weaveId)).rejects.toMatchObject(REMOVED);
    expect((await core.getWeave(f.helper.keyActor, f.lobbyId)).weave.id).toBe(f.lobbyId);
    expect((await core.getWeave(f.helper.keyActor, other.w.weave.id)).weave.id).toBe(other.w.weave.id);
  });

  it("rejoining with the secret is refused for that agent, on the lookup and on the race path, and no second identity is made", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    await expect(joinWeave(db, bus, f.w.secret, { kind: "agent" }, f.helper.keyActor)).rejects.toMatchObject(REJOIN);
    // The race: a first join by the same key commits, and is kicked, after this one's lookup missed it.
    const { key } = await addAgent(db, f.instanceKeeper, "Racer");
    const racer = await resolveCredential(db, key);
    await expect(joinWeave(db, bus, f.w.secret, { name: "Racer", kind: "agent" }, racer, {
      beforeLock: async () => {
        const first = await joinWeave(db, bus, f.w.secret, { name: "Racer-2", kind: "agent" }, racer);
        await kickParticipant(db, bus, f.paw, f.weaveId, first.participant.id);
      },
    })).rejects.toMatchObject(REJOIN);
    const agentId = racer.kind === "agent" ? racer.agent.id : "";
    expect(await db.select().from(participants).where(and(eq(participants.weaveId, f.weaveId), eq(participants.agentId, agentId)))).toHaveLength(1);
  });

  it("a keeper's invitation readmits the same identity: kicked_at cleared, a member, a new token, announced with participant.joined then thread.invited", async () => {
    const f = await setup();
    await setRole(db, bus, f.paw, f.weaveId, f.helper.id, "keeper");
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    // Kicked and not yet readmitted: the old token is known and refused.
    await expect(resolveCredential(db, f.helper.token)).rejects.toMatchObject(REMOVED);
    const { invitationId } = await directInvite(f);
    const r = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([r.participant.id, r.participant.kickedAt, r.participant.role, r.alreadyJoined]).toEqual([f.helper.id, null, "member", false]);
    expect(r.token).not.toBe(f.helper.token);
    // Readmitted: the row now carries the new token, so no row matches the old one and it is unknown.
    await expect(resolveCredential(db, f.helper.token)).rejects.toMatchObject({ code: "invalid_token" });
    expect(await resolveCredential(db, r.token)).toMatchObject({ kind: "participant", participant: { id: f.helper.id } });
    const [joined, invited] = (await readEvents(db, f.weaveId, { threadId: f.pr.id })).slice(-2);
    expect([joined!.type, joined!.payload, invited!.type, invited!.payload.participantId])
      .toEqual(["participant.joined", { participantId: f.helper.id, name: "Helper", kind: "agent", role: "member" }, "thread.invited", f.helper.id]);
    // The Lobby-token redemption reaches the same row.
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const again = await directInvite(f);
    const viaLobby = await redeemInvitation(db, bus, f.helper.lobbyActor, again.invitationId, { kind: "agent" });
    expect([viaLobby.participant.id, viaLobby.participant.kickedAt]).toEqual([f.helper.id, null]);
  });

  it("an invitation issued after the kick readmits, even dated before the kick", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id);
    const kickedAt = (await row(f.helper.id)).kickedAt!;
    const { invitationId } = await directInvite(f);
    await pin(invitationId, new Date(kickedAt.getTime() - 3_600_000));
    const r = await redeemInvitation(db, bus, f.helper.keyActor, invitationId, { kind: "agent" });
    expect([r.participant.id, r.participant.kickedAt, r.alreadyJoined]).toEqual([f.helper.id, null, false]);
  });

  it("a kick racing inviteToWeave: both complete, and exactly one order holds", async () => {
    const f = await setup();
    const [k, inv] = await Promise.all([kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id), directInvite(f)]);
    const log = await lobbyLog(f);
    const invited = log.find((e) => e.type === "weave.invited" && e.payload.invitationId === inv.invitationId)!;
    const withdrawal = log.find((e) => e.type === "weave.invitation_withdrawn" && e.payload.invitationId === inv.invitationId);
    if (withdrawal) {
      // The invitation came first: the kick withdrew it.
      expect([withdrawal.seq > invited.seq, k.withdrawn]).toEqual([true, [inv.invitationId]]);
      await expect(redeemInvitation(db, bus, f.helper.keyActor, inv.invitationId, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    } else {
      // The kick came first: the invitation was issued after it, and readmits.
      expect(k.withdrawn).toEqual([]);
      expect((await redeemInvitation(db, bus, f.helper.keyActor, inv.invitationId, { kind: "agent" })).participant.kickedAt).toBeNull();
    }
  });

  it("a kick racing inviteToWeave, each order forced once: committed before the kick's locks, withdrawn; after the kick, it readmits", async () => {
    const f = await setup();
    let before = "";
    const k = await kickParticipant(db, bus, f.paw, f.weaveId, f.helper.id, {
      beforeLock: async () => { before = (await directInvite(f)).invitationId; },
    });
    expect(k.withdrawn).toEqual([before]);
    await expect(redeemInvitation(db, bus, f.helper.keyActor, before, { kind: "agent" })).rejects.toMatchObject(WITHDRAWN);
    const after = await directInvite(f);
    expect((await redeemInvitation(db, bus, f.helper.keyActor, after.invitationId, { kind: "agent" })).participant)
      .toMatchObject({ id: f.helper.id, kickedAt: null });
  });

  it("names still resolve: getWeave keeps the kicked participant with kickedAt, and the export names it, prints the kick and marks it", async () => {
    const f = await setup();
    await postMessage(db, bus, f.mia.actor, f.w.generalThread.id, "hello from Mia");
    const r = await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const info = await getWeave(db, f.paw, f.weaveId);
    expect(info.participants.find((p) => p.id === f.mia.id)!.kickedAt).toBe(r.kickedAt);
    const md = await exportWeave(db, f.paw, f.weaveId, "md");
    expect(md).toContain("**Mia** · ");
    expect(md).toContain("_system: Mia was kicked by Paw_");
    expect(md).toContain("Mia (human, member, kicked)");
    const json = JSON.parse(await exportWeave(db, f.paw, f.weaveId, "json"));
    expect(json.participants.find((p: { id: string }) => p.id === f.mia.id).kickedAt).toBe(r.kickedAt);
  });

  it("mentions skip a kicked participant", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const m = await postMessage(db, bus, f.paw, f.w.generalThread.id, "@Mia and @Helper, a look?");
    expect(m.payload.mentions).toEqual([f.helper.id]);
  });

  it("invite_participant and set_role refuse a kicked participant", async () => {
    const f = await setup();
    await kickParticipant(db, bus, f.paw, f.weaveId, f.mia.id);
    const answer = { code: "validation", message: "That participant was kicked from this Weave" };
    await expect(inviteParticipant(db, bus, f.paw, f.pr.id, f.mia.id)).rejects.toMatchObject(answer);
    await expect(setRole(db, bus, f.paw, f.weaveId, f.mia.id, "keeper")).rejects.toMatchObject(answer);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/kick.test.ts`
Expected: FAIL in the new `describe` only (the fifteen cases of Task 1 still pass): the repeat case at its readmission (`kickedAt` still set); the token case (`getWeave` resolves); the agent-key case (`resolveInWeave` resolves); the secret-path case (the join answers the stored identity); the readmission case (the old token still resolves before the readmission); the after-the-kick case; the forced-order case at its readmission; the racing case on whichever branch did not readmit; the names case at the export's line; the mentions case (`[mia, helper]`); the refusals case (`inviteParticipant` resolves). Capture this output for the report.

- [ ] **Step 3: The token and the agent key (spec §7.2, §7.3).** In `src/core/src/actors.ts`, directly before the doc comment that begins `/**` and whose first line is ` * Resolves a bearer credential: participant token, keeper token, agent key, or weave secret. Every`, add:

```ts
/** What a kicked participant's credential is answered with, on every surface (spec 2026-10-09 §7). */
export const REMOVED_FROM_WEAVE = "You were removed from this Weave";

```

In `resolveCredential`, directly after the line that is today, whole, `  if (p) {`, add:

```ts
    // Kicked out of its Weave by a keeper (spec 2026-10-09 §7.2): refused before the stamp, so a
    // refused token checks nothing in. Every surface resolves its credential here.
    if (p.kickedAt) throw errors.forbidden(REMOVED_FROM_WEAVE);
```

In `resolveInWeave`, directly after the line that is today, whole, `  if (!me) throw errors.forbidden("Join the Weave first");`, add:

```ts
  // The agent's participant there was kicked (spec 2026-10-09 §7.3): refused before the stamp.
  // participantForAgent itself answers what exists; its one direct caller reads the Lobby.
  if (me.kickedAt !== null) throw errors.forbidden(REMOVED_FROM_WEAVE);
```

- [ ] **Step 4: The secret path (spec §7.4).** In `src/core/src/weaves.ts`, replace the import line that is today, whole, `import { actorId, assertCanRead, assertInstanceKeeperFresh, assertIsKeeperOf, assertStillKeeperOf, toPublicParticipant } from "./actors.js";` with:

```ts
import { actorId, assertCanRead, assertInstanceKeeperFresh, assertIsKeeperOf, assertStillKeeperOf, REMOVED_FROM_WEAVE, toPublicParticipant } from "./actors.js";
```

and directly after the line that is today, whole, `  const asAlreadyJoined = async (p: typeof participants.$inferSelect): Promise<JoinResult> => {`, add:

```ts
    // A kicked agent does not come back through the secret (spec 2026-10-09 §7.4): only a keeper's
    // invitation readmits it. Both adoption paths, the lookup and the lost race, pass through here,
    // before any token is handed out.
    if (p.kickedAt) throw errors.forbidden(`${REMOVED_FROM_WEAVE}: a keeper must invite you back`);
```

- [ ] **Step 5: Readmission (spec §7.5).** In `src/core/src/lobby/invitations.ts`, in `redeemInvitation`, directly after the line that is today, whole, `      let p = mine;`, add:

```ts
      // Kicked from this Weave (spec 2026-10-09 §7.5): an invitation pending at the kick was withdrawn
      // by it, so this one was issued after the kick, by a keeper who meant to readmit. The same
      // participant comes back as a member with a new token, announced as a join, before the
      // thread.invited, as for a participant new to the Weave.
      if (p?.kickedAt) {
        [p] = await tx.update(participants).set({ kickedAt: null, role: "member", token: newSecret() })
          .where(eq(participants.id, p.id)).returning();
        out.push({ threadId: thread.id, type: "participant.joined", actor: p!.id,
          payload: { participantId: p!.id, name: p!.name, kind: p!.kind, role: p!.role } });
      }
```

and replace the line that is today, whole, `          alreadyJoined: !!mine, guidelines: guidelinesFor(await getInstanceGuidelines(tx), weave),` with:

```ts
          // A readmitted participant was not in the Weave when it redeemed.
          alreadyJoined: !!mine && !mine.kickedAt, guidelines: guidelinesFor(await getInstanceGuidelines(tx), weave),
```

- [ ] **Step 6: `setRole` (spec §7.6).** In `src/core/src/participants.ts`, directly after the line `const NO_SUCH_PARTICIPANT = "No such participant in this Weave";` add:

```ts
/** What `setRole` and `inviteParticipant` answer for a participant kicked out of the Weave (spec 2026-10-09 §7.6). */
export const KICKED_TARGET = "That participant was kicked from this Weave";
```

and in `setRole`, directly before the line that is today, whole, `    const [p] = await tx.update(participants).set({ role })`, add:

```ts
    // A kicked participant keeps its row so the history keeps its name; promoting it would make it a
    // recorded target authority again while it cannot act (spec 2026-10-09 §7.6).
    const [target] = await tx.select({ kickedAt: participants.kickedAt }).from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId)));
    if (target?.kickedAt) throw errors.validation(KICKED_TARGET);
```

(`setRole` is above the constant in the file; the constant is read when `setRole` runs, never at load, so the order is fine.)

- [ ] **Step 7: `inviteParticipant` (spec §7.6).** In `src/core/src/invites.ts`, directly after the line `import { lastRemovalSeq } from "./removals.js";` add `import { KICKED_TARGET } from "./participants.js";`; replace the line that is today, whole, `    const [invitee] = await tx.select({ id: participants.id }).from(participants)` with:

```ts
    const [invitee] = await tx.select({ id: participants.id, kickedAt: participants.kickedAt }).from(participants)
```

and directly after the line that is today, whole, `    if (!invitee) throw errors.validation("No such participant in this Weave");`, add:

```ts
    // A Thread invite is "your input is wanted here", which a kicked participant cannot act on, and it
    // is no way back into the Weave (spec 2026-10-09 §7.6).
    if (invitee.kickedAt) throw errors.validation(KICKED_TARGET);
```

- [ ] **Step 8: Mentions (spec §6).** In `src/core/src/messages.ts`, replace the import line `import { eq } from "drizzle-orm";` with `import { and, eq, isNull } from "drizzle-orm";`, and replace the line that is today, whole, `      .from(participants).where(eq(participants.weaveId, t.weaveId));` with:

```ts
      // A mention of someone who cannot read is a promise nobody keeps (spec 2026-10-09 §6).
      .from(participants).where(and(eq(participants.weaveId, t.weaveId), isNull(participants.kickedAt)));
```

- [ ] **Step 9: The export (spec §6, §11.2).** In `src/core/src/export.ts`, replace the line that is today, whole, ``  lines.push(`- Participants: ${info.participants.map((p: PublicParticipant) => `${p.name} (${p.kind}, ${p.role})`).join(", ")}`, "");`` with:

```ts
  lines.push(`- Participants: ${info.participants.map((p: PublicParticipant) => `${p.name} (${p.kind}, ${p.role}${p.kickedAt ? ", kicked" : ""})`).join(", ")}`, "");
```

and directly after the line that begins ``        e.type === "participant.role_changed" ? `` add:

```ts
        // A keeper kicked a participant out of the Weave (spec 2026-10-09 §11.2), both names from the payload.
        e.type === "participant.kicked" ? `${String(e.payload.name ?? "?")} was kicked by ${String(e.payload.kickedByName ?? "?")}` :
```

- [ ] **Step 10: Run them to verify they pass**

Run: `cd src/core && npx vitest run test/kick.test.ts`
Expected: PASS, all twenty-six cases, pristine.

- [ ] **Step 11: Build, typecheck, then the whole core suite**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. No existing case kicks anyone, so no existing assertion moves.

- [ ] **Step 12: Commit**

```bash
git add src/core/src/actors.ts src/core/src/weaves.ts src/core/src/lobby/invitations.ts src/core/src/participants.ts src/core/src/invites.ts src/core/src/messages.ts src/core/src/export.ts src/core/test/kick.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(core): a kicked participant is refused everywhere, and a keeper's invitation readmits it" -m "resolveCredential refuses a kicked token and resolveInWeave a kicked agent's mapping, both with forbidden 'You were removed from this Weave' before the stamp; joinWeave's adoption refuses a kicked agent with 'a keeper must invite you back'; redeemInvitation readmits a kicked participant as a member with a new token, announced with participant.joined; setRole and inviteParticipant refuse a kicked participant; mentions skip one; the export prints the kick and marks the participant." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---
### Task 3: server: the REST route and the stream's forced re-check

Spec §7.1 (the ticket and the upgrade), §8.1, §9.2, §16.2 (REST and streams). **This task carries the two `routes.test.ts` cases and the three `ws.test.ts` cases.**

**Files:**
- Modify: `src/server/src/routes/weaves.ts` (one route after `PUT /:id/participants/:pid/role`)
- Modify: `src/server/src/ws.ts` (`stream`: `deliver`, the gap recovery, the replay loop)
- Modify: `src/server/README.md`
- Test: `src/server/test/routes.test.ts`, `src/server/test/ws.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2: the facade's `kickParticipant(actor, weaveId, participantId)`, `resolveCredential`'s refusal, `resolveInWeave`'s refusal.
- Produces:

```ts
// REST
// POST /api/weaves/:id/participants/:pid/kick -> 200 KickResult (also on a repeat); no body read
// ws.ts: before any participant.kicked is sent (live, in a recovered gap, or in replay), the stream re-resolves
// its credential; a stream that fails closes with CREDENTIAL_REVOKED (4401, "credential revoked") and sends nothing at or after it
```

- [ ] **Step 1: Write the failing REST cases.** In `src/server/test/routes.test.ts`, at the end of the file (after the last `describe` closes), add:

```ts
describe("kicking a participant over REST (spec 2026-10-09 §9.2)", () => {
  /** A Weave with a member to kick; the Lobby exists, as it does on every booted instance. */
  async function kickable(name: string) {
    await s.core.ensureLobby();
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const j = await api(s.baseUrl, "POST", `/api/weaves/${c.json.secret}/join`, { name, kind: "agent" });
    return { weaveId: c.json.weave.id as string, keeper: c.json.token as string, keeperId: c.json.participant.id as string,
      member: j.json.token as string, memberId: j.json.participant.id as string };
  }
  const kickPath = (weaveId: string, pid: string) => `/api/weaves/${weaveId}/participants/${pid}/kick`;

  it("POST .../kick answers 200 created true, then 200 created false with the same seq; a member 403, the Lobby 400, oneself 400", async () => {
    const f = await kickable("KickMe");
    const first = await api(s.baseUrl, "POST", kickPath(f.weaveId, f.memberId), undefined, f.keeper);
    expect([first.status, first.json.participantId, first.json.name, first.json.created, first.json.withdrawn]).toEqual([200, f.memberId, "KickMe", true, []]);
    const again = await api(s.baseUrl, "POST", kickPath(f.weaveId, f.memberId), undefined, f.keeper);
    expect([again.status, again.json]).toEqual([200, { ...first.json, created: false }]);
    const g = await kickable("KickMeToo");
    const member = await api(s.baseUrl, "POST", kickPath(g.weaveId, g.keeperId), undefined, g.member);
    expect([member.status, member.json.code]).toEqual([403, "forbidden"]);
    const { weaveId: lobbyId } = await s.core.ensureLobby();
    const lobby = await api(s.baseUrl, "POST", kickPath(lobbyId, g.memberId), undefined, KEEPER);
    expect([lobby.status, lobby.json.code, lobby.json.message]).toEqual([400, "validation", "Nobody is kicked from the Lobby"]);
    const self = await api(s.baseUrl, "POST", kickPath(g.weaveId, g.keeperId), undefined, g.keeper);
    expect([self.status, self.json.code, self.json.message]).toEqual([400, "validation", "You cannot kick yourself"]);
  });

  it("the kicked token is refused: GET /api/weaves/:id and POST /api/auth/ws-ticket answer 403 with the message", async () => {
    const f = await kickable("KickRead");
    expect((await api(s.baseUrl, "POST", kickPath(f.weaveId, f.memberId), undefined, f.keeper)).status).toBe(200);
    const read = await api(s.baseUrl, "GET", `/api/weaves/${f.weaveId}`, undefined, f.member);
    expect([read.status, read.json.code, read.json.message]).toEqual([403, "forbidden", "You were removed from this Weave"]);
    const ticket = await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, f.member);
    expect([ticket.status, ticket.json.code, ticket.json.message]).toEqual([403, "forbidden", "You were removed from this Weave"]);
  });
});
```

- [ ] **Step 2: Write the failing stream cases.** In `src/server/test/ws.test.ts`, at the end of the file (after `describe("stream", ...)` closes), add:

```ts
describe("a kick closes the kicked participant's streams (spec 2026-10-09 §8.1)", () => {
  // A server of its own, whose TTL re-check never comes due within a case, so only the re-check a
  // kick forces can close a stream. Its freshDb() truncates the database this file shares with `s`,
  // which is why this describe runs last; `s` serves no case after it.
  let k: Awaited<ReturnType<typeof startTestServer>>;
  let kGate: ReturnType<typeof makeGate> | undefined;
  beforeAll(async () => {
    k = await startTestServer({
      authTtlMs: 600_000,
      beforeReplay: async () => {
        if (!kGate) return;
        kGate.markEntered();
        await kGate.released;
      },
    });
    await k.core.seedKeepers([KEEPER]);
    await k.core.ensureLobby();
  });
  afterAll(async () => { kGate?.release(); await k.close(); });

  const kTicket = async (cred: string) => (await api(k.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred)).json.ticket as string;
  /** A raw stream: what it receives, and how it closes. */
  function watch(url: string) {
    const ws = new WebSocket(url);
    const received: LoomEvent[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as LoomEvent));
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const opened = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return { ws, received, closed, opened };
  }
  /** A Weave whose opener makes seqs 1 to 3, and a member whose join is seq 4. */
  async function room(name: string) {
    const c = await api(k.baseUrl, "POST", "/api/weaves", creator);
    const j = await api(k.baseUrl, "POST", `/api/weaves/${c.json.secret}/join`, { name, kind: "human" });
    return { weaveId: c.json.weave.id as string, secret: c.json.secret as string, keeper: c.json.token as string,
      generalId: c.json.generalThread.id as string, member: j.json.token as string, memberId: j.json.participant.id as string };
  }
  const kick = (r: { weaveId: string; keeper: string }, pid: string) =>
    api(k.baseUrl, "POST", `/api/weaves/${r.weaveId}/participants/${pid}/kick`, undefined, r.keeper);

  it("the kicked member's live stream closes with 4401 before the kick is sent to it; the keeper's stream receives the kick", async () => {
    const r = await room("Mia");
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=4&ticket=${await kTicket(r.member)}`);
    await mine.opened;
    const theirs = collect(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=4&ticket=${await kTicket(r.keeper)}`,
      (evs) => evs.some((e) => e.type === "participant.kicked"));
    expect((await kick(r, r.memberId)).status).toBe(200);
    expect(await mine.closed).toEqual({ code: 4401, reason: "credential revoked" });
    expect(mine.received.map((e) => e.type)).not.toContain("participant.kicked");
    const { events, ws } = await theirs.done;
    expect(events.at(-1)!.payload).toMatchObject({ participantId: r.memberId, name: "Mia" });
    ws.close();
  });

  it("a stream replaying across a kick closes there and sends nothing at or after it", async () => {
    const r = await room("Ned");
    kGate = makeGate();
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=0&ticket=${await kTicket(r.member)}`);
    await kGate.entered;                       // subscribed, parked before the first replay page
    expect((await kick(r, r.memberId)).status).toBe(200);                                                   // seq 5
    await api(k.baseUrl, "POST", `/api/threads/${r.generalId}/messages`, { text: "after the kick" }, r.keeper);   // seq 6
    kGate.release(); kGate = undefined;
    expect((await mine.closed).code).toBe(4401);
    expect(mine.received.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("an agent-key stream closes when that agent's participant is kicked", async () => {
    const r = await room("Ola");
    const { key } = await k.core.addAgent(await k.core.resolveCredential(KEEPER), "KickBot");
    const joined = await api(k.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "KickBot", kind: "agent" }, key);
    expect(joined.status).toBe(201);           // seq 5
    const mine = watch(`${k.wsUrl}/api/weaves/${r.weaveId}/stream?since=5&ticket=${await kTicket(key)}`);
    await mine.opened;
    expect((await kick(r, joined.json.participant.id as string)).status).toBe(200);
    expect((await mine.closed).code).toBe(4401);
    expect(mine.received.map((e) => e.type)).not.toContain("participant.kicked");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -r build && cd src/server && npx vitest run test/routes.test.ts test/ws.test.ts`
Expected: FAIL. Every new case answers 404 from Hono's not-found on the kick route (`status` 404 where 200 is wanted); every existing case passes. Capture this output for the report.

- [ ] **Step 4: The route.** In `src/server/src/routes/weaves.ts`, directly after the `r.put("/:id/participants/:pid/role", ...)` handler (it ends with `    return c.json(await core.setRole(actor, c.req.param("id"), c.req.param("pid"), role));` and `  });`), add:

```ts

  // A keeper takes a participant out of this Weave, as an action route like POST /:id/archive (spec
  // 2026-10-09 §9.2). No body is read, and a repeat answers 200 too: `created` says which.
  r.post("/:id/participants/:pid/kick", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.kickParticipant(actor, c.req.param("id"), c.req.param("pid")));
  });
```

- [ ] **Step 5: The forced re-check (spec §8.1).** In `src/server/src/ws.ts`, in `stream`, directly after `ensureAuthorized`'s closing line (`  };`, the line after `      return false;` and `    }`), add:

```ts

  // A kick closes the kicked participant's streams at the kick, not a TTL later (spec 2026-10-09
  // §8.1): before a participant.kicked is sent, live, in a recovered gap or in replay, the stream
  // re-resolves its credential. The kicked one fails and closes with CREDENTIAL_REVOKED before the
  // event; every other stream passes once and sends it. One resolution per open stream per kick.
  const forceRecheckOn = (e: LoomEvent) => { if (e.type === "participant.kicked") authorizedAt = Number.NEGATIVE_INFINITY; };
  /** Sends one event read from the database; false when the stream was closed instead. */
  const sendRead = async (m: LoomEvent): Promise<boolean> => {
    if (m.type === "participant.kicked") {
      forceRecheckOn(m);
      if (!(await ensureAuthorized())) { ws.close(CREDENTIAL_REVOKED, "credential revoked"); return false; }
    }
    lastSent = m.seq;
    send(m);
    return true;
  };
```

In `deliver`, directly after its first line, today, whole, `    if (e.seq <= lastSent) return;`, add:

```ts
    forceRecheckOn(e);
```

replace the gap loop's line that is today, whole, `      for (const m of missing) if (m.seq > lastSent) { lastSent = m.seq; send(m); }` with:

```ts
      for (const m of missing) if (m.seq > lastSent && !(await sendRead(m))) return;
```

and in the replay loop replace the line that is today, whole, `      for (const e of events) { lastSent = e.seq; send(e); }` with:

```ts
      for (const e of events) if (!(await sendRead(e))) return;
```

- [ ] **Step 6: Run them to verify they pass**

Run: `pnpm -r build && cd src/server && npx vitest run test/routes.test.ts test/ws.test.ts`
Expected: PASS, pristine; the existing stream cases pass unchanged (an event that is not a kick is sent exactly as before).

- [ ] **Step 7: `src/server/README.md`.** Directly after the route-table row that is today, whole, ``| PUT | `/api/weaves/:id/participants/:pid/role` | `setRole` |``, add:

```markdown
| POST | `/api/weaves/:id/participants/:pid/kick` | `kickParticipant` → `{ participantId, name, seq, kickedAt, created, withdrawn }`, also on a repeat (`created` false); reads no body |
```

- [ ] **Step 8: Typecheck, then the server suite whole**

Run: `pnpm -r typecheck && cd src/server && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 9: Commit**

```bash
git add src/server/src/routes/weaves.ts src/server/src/ws.ts src/server/README.md src/server/test/routes.test.ts src/server/test/ws.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(server): kick a participant over REST, and close its streams at the kick" -m "POST /api/weaves/:id/participants/:pid/kick answers the KickResult, 200 on a repeat too. Before any participant.kicked is sent, live, in a recovered gap or in replay, a stream re-resolves its credential, so the kicked participant's streams (a token or an agent key) close with 4401 before the event, and every other stream sends it." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 4: client: `kickParticipant` and the types

Spec §5.2 (the client's `EventType`), §6 (the client's `Participant`), §9.3, §16.3. **This task carries the `client.test.ts` case and the `stream.test.ts` case.**

**Files:**
- Modify: `src/client/src/types.ts` (`Participant.kickedAt`; `EventType`; `KickResult`)
- Modify: `src/client/src/client.ts` (the type import; `kickParticipant` after `setRole`)
- Modify: `src/client/README.md`
- Test: `src/client/test/client.test.ts`, `src/client/test/stream.test.ts`
- Modify (the known ripple, typed participant fixtures): `src/web/test/components.test.tsx`, `src/web/test/listeners-page.test.tsx`, `src/web/test/main-page.test.tsx`, `src/claude-channel/test/backend.test.ts`, `src/claude-channel/test/streams.test.ts`

**Interfaces:**
- Consumes: Task 3's route; Task 3's forced re-check (the stream case).
- Produces:

```ts
// @loom/client types.ts
export type Participant = { ...; lastSeenAt: string | null; kickedAt: string | null };
export type EventType = "message" | "participant.joined" | "participant.role_changed" | "participant.kicked" | ...;
export type KickResult = { participantId: string; name: string; seq: number; kickedAt: string; created: boolean; withdrawn: string[] };

// LoomClient
kickParticipant(weaveId: string, participantId: string): Promise<KickResult>;   // POST /api/weaves/:id/participants/:pid/kick
```

- [ ] **Step 1: Write the failing client case.** In `src/client/test/client.test.ts`, at the end of the file, add:

```ts
describe("kickParticipant (spec 2026-10-09 §9.3)", () => {
  it("round-trips both created values; the kicked token is refused, and the Weave still lists it with its kickedAt", async () => {
    await srv().core.ensureLobby();
    const r = await anon.createWeave(input);
    const me = anon.withToken(r.token);
    const j = await anon.joinWeave(r.secret, { name: "Kicked", kind: "agent" });
    const first = await me.kickParticipant(r.weave.id, j.participant.id);
    expect(first).toMatchObject({ participantId: j.participant.id, name: "Kicked", created: true, withdrawn: [] });
    expect(typeof first.kickedAt).toBe("string");
    expect(await me.kickParticipant(r.weave.id, j.participant.id)).toEqual({ ...first, created: false });
    await expect(anon.withToken(j.token).getWeave(r.weave.id)).rejects.toMatchObject({ code: "forbidden", status: 403, message: "You were removed from this Weave" });
    expect((await me.getWeave(r.weave.id)).participants.find((p) => p.id === j.participant.id)!.kickedAt).toBe(first.kickedAt);
  });
});
```

- [ ] **Step 2: Write the failing stream case.** In `src/client/test/stream.test.ts`, at the end of the file, add:

```ts
describe("a kicked participant's stream (spec 2026-10-09 §8.1)", () => {
  it("reports closed with forbidden and does not reconnect again", async () => {
    await srv().core.ensureLobby();
    const r = await anon.createWeave(input);
    const j = await anon.joinWeave(r.secret, { name: "Gone", kind: "human" });
    const statuses: [StreamStatus, unknown][] = [];
    anon.withToken(j.token).stream(r.weave.id, {
      onEvent: () => {}, onStatus: (st, d) => statuses.push([st, d?.error]), backoffMs: { initial: 20, max: 50 },
    });
    await waitFor(() => statuses.some(([st]) => st === "open"));
    await anon.withToken(r.token).kickParticipant(r.weave.id, j.participant.id);
    await waitFor(() => statuses.some(([st]) => st === "closed"));
    expect(statuses.find(([st]) => st === "closed")![1]).toMatchObject({ code: "forbidden" });
    const settled = statuses.length;
    await new Promise((done) => setTimeout(done, 200));      // many backoffs of 20 ms
    expect(statuses.length).toBe(settled);
    expect(statuses.filter(([st]) => st === "reconnecting")).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -r build && cd src/client && npx vitest run test/client.test.ts test/stream.test.ts`
Expected: FAIL: both new cases, `kickParticipant is not a function`. Capture this output for the report.

- [ ] **Step 4: The types.** In `src/client/src/types.ts`, in `Participant`, directly after the line that is today, whole, `  lastSeenAt: string | null;` (the first of the file's two such lines, inside `Participant`), add:

```ts
  /** When a keeper kicked it out of this Weave (spec 2026-10-09 §6), ISO; null while it is here. A kicked participant stays listed, so names in the history resolve. */
  kickedAt: string | null;
```

replace the `EventType` union's first line, today, whole, `  | "message" | "participant.joined" | "participant.role_changed"`, with:

```ts
  | "message" | "participant.joined" | "participant.role_changed" | "participant.kicked"
```

and directly after the line that begins `export type RemovalResult = ` add:

```ts
/** What a kick answers (spec 2026-10-09 §4.1): `created` is false on a repeat, which carries the kick's seq; `withdrawn` is the invitations this call withdrew. */
export type KickResult = { participantId: string; name: string; seq: number; kickedAt: string; created: boolean; withdrawn: string[] };
```

- [ ] **Step 5: The wrapper.** In `src/client/src/client.ts`, in the `import type { ... } from "./types.js";` block, replace the line that is today, whole, `  JoinResult, Keeper, Kind, ListenersPage, ListenersQuery, Lobby, LoomEvent, LoomRequest, MarkAllReadResult, MarkReadResult,` with:

```ts
  JoinResult, Keeper, KickResult, Kind, ListenersPage, ListenersQuery, Lobby, LoomEvent, LoomRequest, MarkAllReadResult, MarkReadResult,
```

and directly after the `setRole` method (it ends with ``    return this.call("PUT", `/api/weaves/${weaveId}/participants/${participantId}/role`, { role });`` and `  }`), add:

```ts
  /** Kicks a participant out of `weaveId` (keepers). Idempotent: a repeat answers created false. */
  kickParticipant(weaveId: string, participantId: string): Promise<KickResult> {
    return this.call("POST", `/api/weaves/${weaveId}/participants/${participantId}/kick`);
  }
```

- [ ] **Step 6: The typed fixtures (the known ripple).** `Participant` gains a required field, so every participant literal the web and channel tests build in the wire shape gains `kickedAt: null`. From the worktree root run this once; it changes exactly the lines that hold both `joinedAt: ""` and `lastSeenAt: null }`, and refuses unless it finds the eight it expects:

```bash
node --input-type=module <<'FIX'
import fs from "node:fs";
const want = { "src/web/test/components.test.tsx": 3, "src/web/test/listeners-page.test.tsx": 1, "src/web/test/main-page.test.tsx": 2,
  "src/claude-channel/test/backend.test.ts": 1, "src/claude-channel/test/streams.test.ts": 1 };
for (const [f, n] of Object.entries(want)) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  let hits = 0;
  const out = lines.map((l) => {
    if (!(l.includes('joinedAt: ""') && l.includes("lastSeenAt: null }"))) return l;
    hits += 1;
    return l.replace("lastSeenAt: null }", "lastSeenAt: null, kickedAt: null }");
  });
  if (hits !== n) { console.log(`FIX MISMATCH: ${f} has ${hits} such lines, expected ${n}`); process.exit(1); }
  fs.writeFileSync(f, out.join("\n"));
}
console.log("eight participant fixtures gain kickedAt: null");
FIX
```

Expected: `eight participant fixtures gain kickedAt: null` (the `me`, `bot` and Offer-form `ME` of `components.test.tsx`; `JOINED` of `listeners-page.test.tsx`; `JOINED` and `CREATED_RESULT` of `main-page.test.tsx`; `participant()` of the channel's `backend.test.ts`; `weaveInfo()` of `streams.test.ts`). A `FIX MISMATCH` means the files are not the ones this plan was written against: stop and report. Each line keeps its own ending (CRLF or LF), since only the text before it changes.

- [ ] **Step 7: Run them to verify they pass**

Run: `pnpm -r build && cd src/client && npx vitest run test/client.test.ts test/stream.test.ts`
Expected: PASS, pristine.

- [ ] **Step 8: `src/client/README.md`.** Replace the line that begins `- **Messages**` (today `- **Messages**`, an em dash, `` `postMessage`, `readEvents` · **Inbox** ``, an em dash, `` `inbox` · **Participants** ``, an em dash, `` `setRole` ``; the rewrite drops the three em dashes for colons) with:

```text
- **Messages**: `postMessage`, `readEvents` · **Inbox**: `inbox` · **Participants**: `setRole`, `kickParticipant` (keepers; a repeat answers `created: false` with the same seq)
```

- [ ] **Step 9: Typecheck, then the client suite whole**

Run: `pnpm -r typecheck && cd src/client && npx vitest run`
Expected: all green, pristine; `pnpm -r typecheck` is green in web and claude-channel only because of Step 6.

- [ ] **Step 10: Commit**

```bash
git add src/client/src/types.ts src/client/src/client.ts src/client/README.md src/client/test/client.test.ts src/client/test/stream.test.ts src/web/test/components.test.tsx src/web/test/listeners-page.test.tsx src/web/test/main-page.test.tsx src/claude-channel/test/backend.test.ts src/claude-channel/test/streams.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(client): kickParticipant, KickResult, Participant.kickedAt and participant.kicked" -m "The client gains kickParticipant over POST /api/weaves/:id/participants/:pid/kick, the KickResult type, kickedAt on Participant and participant.kicked in EventType. Ripple repaired: the eight typed participant fixtures of components.test.tsx (me, bot, the Offer form's ME), listeners-page.test.tsx and main-page.test.tsx (JOINED, CREATED_RESULT), and the channel's backend.test.ts and streams.test.ts gain kickedAt: null." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---
### Task 5: MCP: `kick_participant`, its backends, and the `get_weave` sentence

Spec §9.4, §16.2 (MCP), §16.4 (tools), §16.6 (`backend.test.ts`). **This task carries the three `tools.test.ts` cases, the `mcp.test.ts` case and the `backend.test.ts` case.**

**Files:**
- Modify: `src/mcp-tools/src/tools.ts` (`LOOM_TOOL_NAMES`; the registration after `set_role`; the `get_weave` description)
- Modify: `src/mcp-tools/src/backend.ts` (`LoomToolBackend`)
- Modify: `src/server/src/mcp/backend.ts` (`CoreToolBackend`)
- Modify: `src/claude-channel/src/backend.ts` (`ClientToolBackend`), `src/claude-channel/src/stored.ts` (`withStoredCredential`)
- Modify: `src/mcp-tools/README.md`
- Test: `src/mcp-tools/test/tools.test.ts`, `src/server/test/mcp.test.ts`, `src/claude-channel/test/backend.test.ts`

**Interfaces:**
- Consumes: Task 1's facade `core.kickParticipant(actor, weaveId, participantId)`; Task 4's `LoomClient.kickParticipant(weaveId, participantId)`.
- Produces:

```ts
// src/mcp-tools/src/tools.ts: LOOM_TOOL_NAMES gains "kick_participant" directly after "set_role" (42 names)
// kick_participant input { credential, weaveId, participantId } -> { participantId, name, seq, kickedAt, created, withdrawn }

// src/mcp-tools/src/backend.ts, LoomToolBackend, after setRole
kickParticipant(credential: string, weaveId: string, participantId: string): Promise<unknown>;
```

- [ ] **Step 1: Write the failing `tools.test.ts` cases, and repair the fixtures.** In `src/mcp-tools/test/tools.test.ts`:
  - In the `fake` backend, directly after its line that is today, whole, `  setRole: async (_c, _w, participantId, role) => ({ participantId, role }),`, add (the fake must implement the interface Step 5 extends):

```ts
  kickParticipant: async (c, weaveId, participantId) => {
    calls.push(["kickParticipant", c, weaveId, participantId]);
    return { participantId, name: "ChatGPT-Work", seq: 12, kickedAt: "2026-10-09T10:00:00.000Z", created: true, withdrawn: [] };
  },
```

  - Replace every `expect(LOOM_TOOL_NAMES).toHaveLength(41);` (three, in the cases `advertises the twelve Lobby tools and nothing else new`, `LOOM_TOOL_NAMES has the four new names, and the registered tools equal it` and `LOOM_TOOL_NAMES has get_skill: 41 names`) with `expect(LOOM_TOOL_NAMES).toHaveLength(42);` (the ripple), and rename the case `LOOM_TOOL_NAMES has get_skill: 41 names` to `LOOM_TOOL_NAMES has get_skill: 42 names`.
  - Directly after `describe("the tool descriptions are the spec's", ...)` closes (before `describe("get_skill (spec 2026-09-28 §5.1)", ...)`), add:

```ts
describe("kick_participant (spec 2026-10-09 §9.4)", () => {
  const described = async () => new Map((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));

  it("passes its arguments to the backend unchanged and answers what it returns", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "kick_participant", arguments: { credential: "c", weaveId: "w1", participantId: "p9" } }))))
      .toEqual({ participantId: "p9", name: "ChatGPT-Work", seq: 12, kickedAt: "2026-10-09T10:00:00.000Z", created: true, withdrawn: [] });
    expect(calls.filter((x) => x[0] === "kickParticipant").at(-1)).toEqual(["kickParticipant", "c", "w1", "p9"]);
  });

  it("LOOM_TOOL_NAMES holds kick_participant directly after set_role", () => {
    const at = LOOM_TOOL_NAMES.indexOf("set_role");
    expect(LOOM_TOOL_NAMES.slice(at, at + 2)).toEqual(["set_role", "kick_participant"]);
  });

  it("kick_participant reads exactly as the spec gives it, and get_weave says a kicked participant stays listed", async () => {
    const d = await described();
    expect(d.get("kick_participant")).toBe("Kick a participant out of a Weave (keepers of that Weave only; never yourself; not in the Lobby; allowed in an archived Weave). From then on its token, and an agent key's identity in that Weave, are refused with forbidden, and its open streams close. Everything it wrote stays, and so does its name in the history. It comes back only through a new invitation from a keeper (invite_to_weave), as the same participant; its invitations into this Weave still pending are withdrawn by the kick (each invitee is told with weave.invitation_withdrawn). A participant.kicked event lands in the General Thread. Kicking one already kicked changes nothing and returns the same seq. Returns { participantId, name, seq, kickedAt, created, withdrawn }, withdrawn being the ids of the invitations this call withdrew.");
    expect(d.get("get_weave")).toContain("participants (names, kinds, roles); a kicked participant stays listed with its kickedAt, so names in the history resolve. In the Lobby");
  });
});
```

- [ ] **Step 2: Write the failing `mcp.test.ts` case, and repair the catalog count.** In `src/server/test/mcp.test.ts`, in the case `serves the tool catalog without connection-level auth`, replace the two lines that are today, whole, `        expect(tools).toHaveLength(41);` and `        expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_invitations", "withdraw_invitation"]));` with (the ripple):

```ts
        expect(tools).toHaveLength(42);
        expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_invitations", "withdraw_invitation", "kick_participant"]));
```

At the end of `describe("listener onboarding over remote MCP", ...)`, after the case `list_invitations and withdraw_invitation round trip with an agent key that keeps the target Weave (spec 2026-10-08 §13.2)`, add:

```ts
  it("kick_participant round trips with an agent key that keeps the Weave, and the kicked agent's next get_weave is forbidden (spec 2026-10-09 §16.2)", async () => {
    const keeper = await agentClient(await mint(fresh("Keep")));
    const kicked = await agentClient(await mint(fresh("Kick")));
    try {
      const target = json(await keeper.callTool({ name: "create_weave", arguments: { title: "Loom development", opener: "o", name: fresh("Host") } }));
      const joined = json(await kicked.callTool({ name: "join_weave", arguments: { secret: target.secret } }));
      const args = { weaveId: target.weave.id, participantId: joined.participant.id };
      const first = json(await keeper.callTool({ name: "kick_participant", arguments: args }));
      expect(first).toMatchObject({ participantId: joined.participant.id, created: true, withdrawn: [] });
      expect(json(await keeper.callTool({ name: "kick_participant", arguments: args }))).toEqual({ ...first, created: false });
      const refused = await kicked.callTool({ name: "get_weave", arguments: { weaveId: target.weave.id } });
      expect(refused.isError).toBe(true);
      expect(json(refused)).toMatchObject({ code: "forbidden", message: "You were removed from this Weave" });
    } finally {
      await Promise.all([keeper.close().catch(() => {}), kicked.close().catch(() => {})]);
    }
  });
```

- [ ] **Step 3: Write the failing `backend.test.ts` case.** In `src/claude-channel/test/backend.test.ts`, at the end of the file, add:

```ts
describe("kick_participant with the stored credential (spec 2026-10-09 §9.4)", () => {
  it("reaches that Weave's own token", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "stored-token", participantId: "p2", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const tokens: string[] = [];
    const answer = { participantId: "p9", name: "ChatGPT-Work", seq: 12, kickedAt: "2026-10-09T10:00:00.000Z", created: true, withdrawn: [] };
    const fake = {
      withToken: (t: string): unknown => { tokens.push(t); return fake; },
      kickParticipant: vi.fn(async () => answer),
    };
    const backend = withStoredCredential(new ClientToolBackend(fake as unknown as LoomClient, state, { onJoined: vi.fn() }), state, () => undefined);
    expect(await backend.kickParticipant("stored", WEAVE_ID, "p9")).toEqual(answer);
    expect(tokens).toEqual(["stored-token"]);
    expect(fake.kickParticipant).toHaveBeenCalledWith(WEAVE_ID, "p9");
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd src/mcp-tools && npx vitest run test/tools.test.ts`
Expected: FAIL: the three repaired count cases (`LOOM_TOOL_NAMES` still has 41), the pass-through case (`Tool kick_participant not found` in the tool error), the position case and the descriptions case. Then run `pnpm -r build && cd src/server && npx vitest run test/mcp.test.ts` (the catalog case sees 41 tools and the round trip gets a tool error) and `cd src/claude-channel && npx vitest run test/backend.test.ts` (`backend.kickParticipant is not a function`). Capture all three outputs for the report.

- [ ] **Step 5: The interface.** In `src/mcp-tools/src/backend.ts`, directly after the line that is today, whole, `  setRole(credential: string, weaveId: string, participantId: string, role: Role): Promise<unknown>;`, add:

```ts
  kickParticipant(credential: string, weaveId: string, participantId: string): Promise<unknown>; // { participantId, name, seq, kickedAt, created, withdrawn }
```

- [ ] **Step 6: The name, the tool and the `get_weave` sentence.** In `src/mcp-tools/src/tools.ts`, replace the `LOOM_TOOL_NAMES` line that is today, whole, `  "set_thread_url", "invite_participant", "remove_participant", "close_thread", "archive_weave", "set_role", "export_weave",` with:

```ts
  "set_thread_url", "invite_participant", "remove_participant", "close_thread", "archive_weave", "set_role", "kick_participant", "export_weave",
```

Directly after the `set_role` registration (it ends with the line `  }, ({ credential, weaveId, participantId, role }) => toToolResult(Promise.resolve().then(() => backend.setRole(resolve(credential), weaveId, participantId, role))));`), add:

```ts

  server.registerTool("kick_participant", {
    description: "Kick a participant out of a Weave (keepers of that Weave only; never yourself; not in the Lobby; allowed in an archived Weave). From then on its token, and an agent key's identity in that Weave, are refused with forbidden, and its open streams close. Everything it wrote stays, and so does its name in the history. It comes back only through a new invitation from a keeper (invite_to_weave), as the same participant; its invitations into this Weave still pending are withdrawn by the kick (each invitee is told with weave.invitation_withdrawn). A participant.kicked event lands in the General Thread. Kicking one already kicked changes nothing and returns the same seq. Returns { participantId, name, seq, kickedAt, created, withdrawn }, withdrawn being the ids of the invitations this call withdrew.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), participantId: z.string() },
  }, ({ credential, weaveId, participantId }) => toToolResult(Promise.resolve().then(() => backend.kickParticipant(resolve(credential), weaveId, participantId))));
```

Then replace the `get_weave` description line, the one that begins ``    description: `Get a Weave: title, archived state, threads (with closed state) and participants (names, kinds, roles).`` (today its Lobby sentence reads "In the Lobby the participants' capability profiles are not included", an em dash, "use find_agents to read those."; the rewrite drops that em dash for a colon), with:

```ts
    description: `Get a Weave: title, archived state, threads (with closed state) and participants (names, kinds, roles); a kicked participant stays listed with its kickedAt, so names in the history resolve. In the Lobby the participants' capability profiles are not included: use find_agents to read those. ${READ_GUIDELINES}`,
```

- [ ] **Step 7: The three backends.** In `src/server/src/mcp/backend.ts`, directly after the line that begins `  async setRole(c: string, weaveId: string, participantId: string, role: Role) {`, add:

```ts
  async kickParticipant(c: string, weaveId: string, participantId: string) { return this.core.kickParticipant(await this.actor(c), weaveId, participantId); }
```

In `src/claude-channel/src/backend.ts`, directly after the line that begins `  setRole(c: string, weaveId: string, participantId: string, role: Role) {`, add:

```ts
  kickParticipant(c: string, weaveId: string, participantId: string) { return this.as(c).kickParticipant(weaveId, participantId); }
```

In `src/claude-channel/src/stored.ts`, directly after the line that is today, whole, `    setRole: async (c, w, p, r) => inner.setRole(byWeave(c, w), w, p, r),`, add:

```ts
    kickParticipant: async (c, w, p) => inner.kickParticipant(byWeave(c, w), w, p),
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm -r build && cd src/mcp-tools && npx vitest run test/tools.test.ts && cd ../server && npx vitest run test/mcp.test.ts && cd ../claude-channel && npx vitest run test/backend.test.ts`
Expected: PASS, pristine.

- [ ] **Step 9: `src/mcp-tools/README.md`.** Replace the line that is today, whole, ``registerLoomTools(server, backend, opts?)` registers all 41 tools and three resources;`` (it begins with a backtick) with:

```text
`registerLoomTools(server, backend, opts?)` registers all 42 tools and three resources;
```

and the line that begins `- **Weaves**` (today `- **Weaves**`, an em dash, then the list; the rewrite drops the em dash for a colon) with:

```text
- **Weaves**: `create_weave`, `join_weave` (with a secret, or `inviteId` to redeem a cross-Weave invitation), `lookup_weave`, `get_weave` (a kicked participant stays listed with its `kickedAt`), `archive_weave`, `export_weave`, `kick_participant` (a keeper takes a participant out of the Weave; only a keeper's new invitation brings it back)
```

- [ ] **Step 10: Typecheck, then the four suites whole**

Run: `pnpm -r typecheck && cd src/mcp-tools && npx vitest run && cd ../server && npx vitest run && cd ../claude-channel && npx vitest run`
Expected: all green, pristine. The mcp-tools drift guard (`skills.test.ts`) still passes: no skill names the new tool yet.

- [ ] **Step 11: Commit**

```bash
git add src/mcp-tools/src/tools.ts src/mcp-tools/src/backend.ts src/mcp-tools/README.md src/mcp-tools/test/tools.test.ts src/server/src/mcp/backend.ts src/server/test/mcp.test.ts src/claude-channel/src/backend.ts src/claude-channel/src/stored.ts src/claude-channel/test/backend.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(mcp-tools): kick_participant, and get_weave says a kicked participant stays listed" -m "One tool after set_role (42 names), one LoomToolBackend method implemented over core (server), over the client (channel) and with the stored credential resolved against the Weave (stored.ts). get_weave's description gains the kicked-participant sentence, and its Lobby sentence's em dash becomes a colon. Ripples repaired: tools.test.ts 'advertises the twelve Lobby tools and nothing else new', 'LOOM_TOOL_NAMES has the four new names, and the registered tools equal it', 'LOOM_TOOL_NAMES has get_skill: 41 names' (now 42), the fake backend; mcp.test.ts 'serves the tool catalog without connection-level auth'." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 6: claude-channel: the line, the instructions, and dropping a refused identity

Spec §5.3 (the channel), §8.3, §11.3, §16.6. **This task carries the two `format.test.ts` cases, the four `streams.test.ts` cases and the repaired `channel.test.ts` case.**

**Files:**
- Modify: `src/claude-channel/src/format.ts` (`safe` exported; `formatEvent`)
- Modify: `src/claude-channel/src/server.ts` (the `INSTRUCTIONS` entry beginning `'Events arrive as <channel source="loom"`)
- Modify: `src/claude-channel/src/state.ts` (`removeWeaveIfToken`; `removeWeave` through the shared `forget`)
- Modify: `src/claude-channel/src/streams.ts` (the imports; `Active.token`; `drop`; the stream's terminal close; the initial metadata failure)
- Modify: `src/claude-channel/README.md`
- Test: `src/claude-channel/test/format.test.ts`, `src/claude-channel/test/streams.test.ts`, `src/claude-channel/test/channel.test.ts`

**Interfaces:**
- Consumes: Task 4's `EventType` member `"participant.kicked"` and `LoomClientError` (`@loom/client`); the payload of Task 1.
- Produces: `formatEvent` renders `<name> was kicked from the Weave by <kickedByName>`; `shouldWake` is unchanged (the type wakes only in `wake: "all"`); `StreamManager` acts on a stored Weave whose stream closes with `forbidden`, or whose start's `getWeave` answers `forbidden`: it tears the stream down and asks `ChannelState` to forget the Weave only while the stored token is still the refused one. When it was, the entry and every session's cursor and preferences for it are removed, it logs `identity for weave <id> refused (forbidden): dropped`, sends one notification, and schedules no restart. When another session sharing the state has stored a replacement token since, the entry, its cursors and its preferences stand, nothing is notified, it logs `identity for weave <id> refused (forbidden): a replacement is stored, restarted with it`, and restarts the stream with the replacement.

```ts
// src/claude-channel/src/state.ts
/** Forgets a Weave only while its stored token is `token`; returns the replacement when another one is stored. */
removeWeaveIfToken(id: string, token: string): Promise<JoinedWeave | undefined>;
```

- [ ] **Step 1: Write the failing `format.test.ts` cases.** In `src/claude-channel/test/format.test.ts`, at the end of the file, add:

```ts
describe("participant.kicked (spec 2026-10-09 §11.3)", () => {
  /** A keeper unknown to this Weave's names kicked someone also unknown to them: the payload names both. */
  const kicked = ev({ type: "participant.kicked", actor: "kp9",
    payload: { participantId: "p9", name: "ChatGPT-Work", kickedBy: "kp9", kickedByName: "Claude-Code" } });

  it("formatEvent names both people from the payload alone", () => {
    const r = formatEvent(kicked, weave, names, "p1");
    expect([r.content, r.meta.type]).toEqual(["ChatGPT-Work was kicked from the Weave by Claude-Code", "participant.kicked"]);
  });

  it("shouldWake: it wakes a session in wake all, and not in mentions mode (no rule of its own)", () => {
    expect(shouldWake(kicked, { participantId: "p1", wake: "all", invites: true, requests: true })).toBe(true);
    expect(shouldWake(kicked, { participantId: "p1", wake: "mentions", invites: true, requests: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing `streams.test.ts` cases.** In `src/claude-channel/test/streams.test.ts`, at the end of the file, add:

```ts
describe("a refused identity is dropped (spec 2026-10-09 §8.3)", () => {
  const REFUSED = () => new LoomClientError("forbidden", "You were removed from this Weave");
  const NOTICE = {
    content: 'You were removed from "T": Loom refuses this participant\'s token. The channel forgot this Weave; a keeper must invite you back (invite_to_weave).',
    meta: { weave: WEAVE_ID, weave_title: "T", type: "participant.kicked" },
  };

  it("a stream that closes with forbidden is stopped, removed from state, notified once, and not restarted", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    streams[0]!.opts.onStatus?.("closed", { error: REFUSED() });
    await waitFor(() => notify.mock.calls.length === 1);
    expect(notify).toHaveBeenCalledWith(NOTICE);
    expect(state.load().weaves[WEAVE_ID]).toBeUndefined();
    expect(log).toHaveBeenCalledWith(`identity for weave ${WEAVE_ID} refused (forbidden): dropped`);
    expect(streams[0]!.close).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 60));   // past the 20 ms backoff
    expect([streams.length, notify.mock.calls.length]).toEqual([1, 1]);
  });

  it("the same when the restart's getWeave answers forbidden", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client, streams, getWeaveCalls } = makeFakeClient({ onGetWeave: (call) => { if (call === 2) throw REFUSED(); } });
    const sm = new StreamManager(client, state, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    streams[0]!.opts.onStatus?.("closed", { error: new LoomClientError("network", "boom") });   // an ordinary restart
    await waitFor(() => notify.mock.calls.length === 1);
    expect(notify).toHaveBeenCalledWith(NOTICE);
    expect(state.load().weaves[WEAVE_ID]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect([streams.length, getWeaveCalls(), notify.mock.calls.length]).toEqual([1, 2, 1]);
  });

  it("invalid_token still restarts with backoff and drops nothing", async () => {
    const w = makeWeave();
    const state = await makeState(w);
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client, streams } = makeFakeClient();
    const sm = new StreamManager(client, state, notify, vi.fn(), { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    streams[0]!.opts.onStatus?.("closed", { error: new LoomClientError("invalid_token", "Unknown credential") });
    await waitFor(() => streams.length === 2);
    expect([notify.mock.calls.length, state.load().weaves[WEAVE_ID]?.token]).toEqual([0, "tok"]);
    sm.closeAll();
  });

  it("a replacement token another session stored outlives the old token's refusal: kept with every cursor and preference, the stream restarted with it, nothing notified", async () => {
    // One machine, one state directory, two sessions. A listens with "tok"; B, after the kick, is
    // readmitted and stores the new token; only then does A's stream get its delayed forbidden.
    const w = makeWeave();
    const a = await makeState(w, "s1");
    await a.setPrefs(WEAVE_ID, { invites: false });
    const log = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { client: fake, streams } = makeFakeClient();
    const tokens: string[] = [];
    const client = { ...fake, withToken: (t: string) => { tokens.push(t); return fake.withToken(t); } } as unknown as LoomClient;
    const sm = new StreamManager(client, a, notify, log, { initial: 20, max: 80 });
    sm.start(WEAVE_ID, w);
    await waitFor(() => streams.length === 1);
    const b = new ChannelState(a.dir, "s2");
    await b.setPrefs(WEAVE_ID, { wake: "mentions" });
    await b.upsertWeave(WEAVE_ID, { ...makeWeave(), token: "tok-2", lastSeq: 5 });
    streams[0]!.opts.onStatus?.("closed", { error: REFUSED() });
    await waitFor(() => streams.length === 2);
    expect(tokens).toEqual(["tok", "tok-2"]);
    expect(streams[0]!.close).toHaveBeenCalled();
    expect(streams[1]!.opts.since).toBe(3);   // A's own cursor, kept
    expect(log).toHaveBeenCalledWith(`identity for weave ${WEAVE_ID} refused (forbidden): a replacement is stored, restarted with it`);
    const after = new ChannelState(a.dir, "s3").load();
    expect(after.weaves[WEAVE_ID]?.token).toBe("tok-2");
    expect([after.sessions.s1?.cursors[WEAVE_ID], after.sessions.s1?.prefs?.[WEAVE_ID]]).toEqual([3, { invites: false }]);
    expect([after.sessions.s2?.cursors[WEAVE_ID], after.sessions.s2?.prefs?.[WEAVE_ID]]).toEqual([5, { wake: "mentions" }]);
    await new Promise((r) => setTimeout(r, 60));   // past the 20 ms backoff: no further restart
    expect([streams.length, notify.mock.calls.length]).toEqual([2, 0]);
    sm.closeAll();
  });
});
```

- [ ] **Step 3: Repair the instructions case.** In `src/claude-channel/test/channel.test.ts`, in the case `the instructions list the onboarding and removal types`, replace the line that is today, whole, ``      expect(c.getInstructions()).toContain('|thread.removed|listener.removed|request.offer_withdrawn|weave.invitation_withdrawn" from=');`` with (the known ripple, and the spec's pinned substring and sentence):

```ts
      expect(c.getInstructions()).toContain('|thread.removed|listener.removed|request.offer_withdrawn|weave.invitation_withdrawn|participant.kicked" from=');
      expect(c.getInstructions()).toContain("A participant.kicked notification without seq or thread is the channel's own: Loom refused your token in that Weave, and the channel forgot it.");
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm -r build && cd src/claude-channel && npx vitest run test/format.test.ts test/streams.test.ts test/channel.test.ts`
Expected: FAIL. `format.test.ts`: the `formatEvent` case (`participant.kicked` is rendered as its type by the `default` branch); its `shouldWake` case passes already, since it pins that no rule is added (spec §5.3). `streams.test.ts`: the two drop cases time out waiting for the notification (a `forbidden` close restarts today); the replacement case fails at `tokens` (`["tok", "tok"]`: today's restart reads this process's cached state, which still holds the refused token); the `invalid_token` case passes already, and pins that it keeps doing so. `channel.test.ts`: the repaired case, neither substring found. Capture this output for the report.

- [ ] **Step 5: The line.** In `src/claude-channel/src/format.ts`, replace the line that is today, whole, `function safe(v: unknown): string { return String(v ?? "").replace(/[<>"\r\n]/g, " ").trim(); }` with:

```ts
export function safe(v: unknown): string { return String(v ?? "").replace(/[<>"\r\n]/g, " ").trim(); }
```

and in `formatEvent`, directly after the line that begins ``    case "participant.role_changed": content = `` add:

```ts
    // A keeper kicked someone out of the Weave (spec 2026-10-09 §11.3), both names from the payload.
    // No "you" form: the kicked session never receives it (its stream closes first).
    case "participant.kicked": content = `${str(e.payload.name)} was kicked from the Weave by ${str(e.payload.kickedByName)}`; break;
```

- [ ] **Step 6: The instructions.** In `src/claude-channel/src/server.ts`, in the `INSTRUCTIONS` entry that begins `'Events arrive as <channel source="loom"`, replace the substring `|request.offer_withdrawn|weave.invitation_withdrawn" from=` with `|request.offer_withdrawn|weave.invitation_withdrawn|participant.kicked" from=`, and the substring `or a one-line description of a system event.',` (the entry's end) with:

```ts
or a one-line description of a system event. A participant.kicked notification without seq or thread is the channel\'s own: Loom refused your token in that Weave, and the channel forgot it.',
```

(The entry is a single-quoted string, so the apostrophe is written `\'`, as the entry already writes `request\'s`.) Nothing else in that entry changes.

- [ ] **Step 7: The drop.** In `src/claude-channel/src/streams.ts`, replace the two import lines that are today, whole, `import type { LoomClient, LoomEvent, StreamHandle } from "@loom/client";` and `import { formatEvent, shouldWake, withPreamble, type Names } from "./format.js";` with:

```ts
import { LoomClientError, type LoomClient, type LoomEvent, type StreamHandle } from "@loom/client";
import { formatEvent, safe, shouldWake, withPreamble, type Names } from "./format.js";
```

In `type Active`, replace the substring `participantId: string; chain: Promise<void>;` with `participantId: string; token: string; chain: Promise<void>;` (the token this entry's stream reads with, so a refusal names the token it refused), and in `start`, in the `const entry: Active = {` literal, replace the substring `participantId: w.participantId,` with `participantId: w.participantId, token: w.token,`.

Directly before the line that begins `  /** Schedules a restart of` (the doc comment of `scheduleRestart`), add:

```ts
  /**
   * Loom refused this stored identity in its own Weave with `forbidden` (spec 2026-10-09 §8.3). After
   * the kick slice a participant token reading its own Weave is refused that way for one reason only,
   * a kick, so the Weave is stopped and forgotten, the agent is told once, and no restart is
   * scheduled: a dead token retried every 30 s for the life of the process helps nobody.
   * `invalid_token` and `weave_not_found` keep the backoff (KNOWN-ISSUES), because a misconfigured
   * LOOM_URL or a restored database answers one of them for every stored identity at once.
   *
   * The refused token is the one this entry's stream read with, captured before anything awaits.
   * Every session on the machine shares ChannelState, and another one may have been readmitted and
   * stored a replacement token after this stream opened; so the Weave is forgotten only while its
   * stored token is still the refused one. When a replacement is stored, it and every session's
   * cursor and preferences stand, nothing is notified, and this Weave is restarted with the
   * replacement from this session's own cursor: nothing else tells this process the token changed.
   */
  private async drop(weaveId: string, entry: Active): Promise<void> {
    if (this.active.get(weaveId) !== entry) return;
    const refused = entry.token;
    const title = entry.title;
    // teardown(), not stop(): whether this session leaves the Weave is known only once the state answers.
    this.teardown(weaveId);
    try {
      const replacement = await this.state.removeWeaveIfToken(weaveId, refused);
      if (replacement) {
        this.log(`identity for weave ${weaveId} refused (forbidden): a replacement is stored, restarted with it`);
        // A join in this process may have started the Weave while the state answered; that stream already reads with it.
        if (!this.active.has(weaveId)) this.start(weaveId, replacement);
        return;
      }
      this.preambleDone.delete(weaveId);   // what stop() adds to teardown(): a later rejoin opens with the rules again
      this.log(`identity for weave ${weaveId} refused (forbidden): dropped`);
      // The channel never receives the participant.kicked itself (its stream closes first), and
      // without this the session's next call on the Weave would be sent to join_weave, which refuses it.
      await this.notify({
        content: `You were removed from "${title}": Loom refuses this participant's token. The channel forgot this Weave; a keeper must invite you back (invite_to_weave).`,
        meta: { weave: safe(weaveId), weave_title: safe(title), type: "participant.kicked" },
      });
    } catch (err) {
      this.log(`dropping weave ${weaveId} failed: ${(err as Error).message}`);
    }
  }

```

In `src/claude-channel/src/state.ts`, replace the method that is today, whole:

```ts
  removeWeave(id: string): Promise<void> {
    return this.mutate((c) => {
      delete c.weaves[id];
      for (const s of Object.values(c.sessions)) { delete s.cursors[id]; delete s.prefs?.[id]; }
    });
  }
```

with:

```ts
  removeWeave(id: string): Promise<void> {
    return this.mutate((c) => { forget(c, id); });
  }

  /**
   * Forgets a Weave only while its stored token is `token`, the one Loom refused (spec 2026-10-09
   * §8.3). Read inside the mutation, so it holds against the newest committed state: another session
   * sharing this state may have been readmitted and stored a replacement token after the refused one
   * was read. A replacement is returned and left standing, with every session's cursor and
   * preferences for the Weave; undefined means the refused entry was forgotten, or nothing was stored.
   */
  removeWeaveIfToken(id: string, token: string): Promise<JoinedWeave | undefined> {
    return this.mutate((c) => {
      const w = c.weaves[id];
      if (w && w.token !== token) return { ...w };
      forget(c, id);
      return undefined;
    });
  }
```

and directly before the line that is today, whole, `/** A writer entry belongs to a process that still exists (and could therefore still resume and re-check). */`, add:

```ts
/** Removes a Weave's stored identity and every session's cursor and preferences for it. */
function forget(c: ChannelConfig, id: string): void {
  delete c.weaves[id];
  for (const s of Object.values(c.sessions)) { delete s.cursors[id]; delete s.prefs?.[id]; }
}

```

In `start`, in the `.catch((err) => {` that follows the initial `refresh()` (its first line is `      // The metadata carries the guidelines this session's first turn must open with, so it is a`), directly after the line `      if (entry.stopped) return undefined;` add:

```ts
      if (err instanceof LoomClientError && err.code === "forbidden") { void this.drop(weaveId, entry); return undefined; }
```

and in the stream's `onStatus`, directly after the line that is today, whole, `          if (st === "closed" && d?.error && !entry.stopped) {`, add:

```ts
            if (d.error.code === "forbidden") { void this.drop(weaveId, entry); return; }
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm -r build && cd src/claude-channel && npx vitest run test/format.test.ts test/streams.test.ts test/channel.test.ts`
Expected: PASS, pristine (the channel suite spawns the rebuilt `dist/server.js`).

- [ ] **Step 9: `src/claude-channel/README.md`.** Directly after the line that is today, whole, `` `invites: true`). `` (the end of the paragraph that begins `Per-session preferences live beside that session's delivery cursor`), add, with one empty line before it:

```markdown
A `participant.kicked` (a keeper kicked someone out of the Weave) is a system event like any other:
it wakes a session in `wake: "all"` only. **A refused identity is dropped.** When Loom refuses the
token this channel stores for a Weave with `forbidden` (after a kick, the one reason it can), the
channel stops that Weave's stream, forgets the Weave in its state, logs `identity for weave <id>
refused (forbidden): dropped`, and sends the session one notification naming the Weave, with no
`seq` or `thread`; it does not retry. It forgets the Weave only while the stored token is the refused
one: when another session on the machine has since stored a replacement (it was invited back), the
replacement and every session's cursor and preferences stay, and the stream restarts with it.
`invalid_token` and `weave_not_found` are still retried with backoff.
```

- [ ] **Step 10: Typecheck, then the channel suite whole**

Run: `pnpm -r typecheck && cd src/claude-channel && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 11: Commit**

```bash
git add src/claude-channel/src/format.ts src/claude-channel/src/server.ts src/claude-channel/src/state.ts src/claude-channel/src/streams.ts src/claude-channel/README.md src/claude-channel/test/format.test.ts src/claude-channel/test/streams.test.ts src/claude-channel/test/channel.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(channel): render participant.kicked, and drop an identity Loom refuses with forbidden" -m "The line names both people from the payload; the type wakes in wake all only, by the existing fallback. The instructions' type= list gains it, with a sentence on the channel's own notification. A stored Weave whose stream closes with forbidden, or whose start's getWeave answers forbidden, is stopped, removed from state and notified once, with no restart, but only while the stored token is the refused one: a replacement another session stored is kept with every cursor and preference, and the stream restarts with it. invalid_token and weave_not_found keep the backoff. Ripple repaired: channel.test.ts 'the instructions list the onboarding and removal types'." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---
### Task 7: CLI: `loom kick`, `loom info`'s `Kicked:`, and the `read` line

Spec §8.4 (unchanged store), §9.5 to §9.7, §16.5. **This task carries the three `cli-more.test.ts` cases.**

**Files:**
- Modify: `src/cli/src/commands/weave.ts` (the `hhmm` import; `info`; `kick` after `role`)
- Modify: `src/cli/src/commands/messages.ts` (`formatEvent`)
- Modify: `src/cli/README.md`, `README.md`
- Test: `src/cli/test/cli-more.test.ts`

**Interfaces:**
- Consumes: Task 4's `LoomClient.kickParticipant`, `KickResult`, `Participant.kickedAt` (`@loom/client`); `emit(c, json, human)`; `c.resolveWeave()` (the global `--weave`, else the last Weave created or joined); `hhmm(v)` (`src/cli/src/commands/request.ts`).
- Produces:

```text
loom kick <participantId>   "Kicked <name> (seq <seq>)", plus "; withdrew 1 pending invitation" or "; withdrew <n> pending invitations"
                            when withdrawn is not empty; on a repeat "<name> was already kicked (seq <seq>)"; --json the KickResult
loom info                   "Participants:" lists those whose kickedAt is null; when any is kicked, "Kicked:" then
                            "  <id>  <name> (<kind>) at <hh:mm of kickedAt>" per kicked participant
loom read                   #<seq> [<thread>] * <name> was kicked by <kickedByName>
```

- [ ] **Step 1: Write the failing cases.** In `src/cli/test/cli-more.test.ts`, directly after the import line `import { stdinReader } from "../src/main.js";` add:

```ts
import { hhmm } from "../src/commands/request.js";
```

and at the end of the file add:

```ts
describe("kick (spec 2026-10-09 §9.5 to §9.7)", () => {
  let n = 0;
  /**
   * A Weave this test's config keeps (as Me), and a keyed agent standing in the Lobby that joined it
   * with its key and holds a direct invitation into it still pending. The Lobby exists, as it does on
   * every booted instance.
   */
  async function kickable() {
    await s.core.ensureLobby();
    const created = (await run(["create", "--title", "Loom development", "--name", "Me", "--json"])).json();
    const keeper = await s.core.resolveCredential(created.token);
    const name = `Kickee${++n}`;
    const { key } = await s.core.addAgent(await s.core.resolveCredential(keeperToken("k1")), name);
    const agent = await s.core.resolveCredential(key);
    const lobby = await s.core.joinLobby({ name, kind: "agent" }, agent);
    const joined = await s.core.joinWeave(created.secret, { name, kind: "agent" }, agent);
    await s.core.inviteToWeave(keeper, lobby.participant.id, created.weave.id, created.generalThread.id);
    return { name, id: joined.participant.id };
  }

  it("kick prints the line with the withdrawn tail, a repeat the already-kicked line with the same seq, and --json the KickResult", async () => {
    const k = await kickable();
    const first = await run(["kick", k.id]);
    expect(first.code).toBe(0);
    const m = /^Kicked (\S+) \(seq (\d+)\); withdrew 1 pending invitation\n$/.exec(first.out);
    expect(m?.[1]).toBe(k.name);
    const again = await run(["kick", k.id]);
    expect(again.out).toBe(`${k.name} was already kicked (seq ${m![2]})\n`);
    const json = (await run(["kick", k.id, "--json"])).json();
    expect(json).toMatchObject({ participantId: k.id, name: k.name, seq: Number(m![2]), created: false, withdrawn: [] });
    expect(typeof json.kickedAt).toBe("string");
  });

  it("a member's kick exits 1 with the forbidden message", async () => {
    await s.core.ensureLobby();
    const created = (await run(["create", "--title", "T", "--name", "Me", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    await run(["join", created.secret, "--name", "Other", "--json"], { LOOM_CONFIG: cfg2 });
    const refused = await run(["kick", created.participant.id], { LOOM_CONFIG: cfg2 });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Only a keeper of this Weave can do this");
  });

  it("info lists a kicked participant under Kicked: and not under Participants:, and read renders the kick line", async () => {
    const k = await kickable();
    const kicked = (await run(["kick", k.id, "--json"])).json();
    const out = (await run(["info"])).out;
    const [present, gone] = out.split("Kicked:\n");
    expect(present).toContain("Participants:\n");
    expect(present).not.toContain(k.id);
    expect(gone).toBe(`  ${k.id}  ${k.name} (agent) at ${hhmm(kicked.kickedAt)}\n`);
    const read = await run(["read", "--since", String(kicked.seq - 1)]);
    expect(read.out).toContain(`#${kicked.seq} [General] * ${k.name} was kicked by Me`);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r build && cd src/cli && npx vitest run test/cli-more.test.ts`
Expected: FAIL: the three new cases; commander answers `error: unknown command 'kick'` (exit 1, empty stdout). Capture this output for the report.

- [ ] **Step 3: The command and `info`.** In `src/cli/src/commands/weave.ts`, directly after the import line `import { lobbyContext } from "./lobby.js";` add:

```ts
import { hhmm } from "./request.js";
```

Replace the two lines of `info` that are, today, the line `        "Participants:",` and the one after it, which begins `        ...info.participants.map((p) =>` and prints each participant as two spaces, its id, two spaces, its name and `(kind, role)`, with:

```ts
        // Who is here; a kicked participant follows under its own heading (spec 2026-10-09 §9.6).
        "Participants:",
        ...info.participants.filter((p) => !p.kickedAt).map((p) => `  ${p.id}  ${p.name} (${p.kind}, ${p.role})`),
        ...(info.participants.some((p) => p.kickedAt)
          ? ["Kicked:", ...info.participants.filter((p) => p.kickedAt).map((p) => `  ${p.id}  ${p.name} (${p.kind}) at ${hhmm(p.kickedAt)}`)]
          : []),
```

Then directly after the `role` command (it ends with the line ``      emit(c, p, `${p.name} is now ${p.role}`);`` and `    });`), add:

```ts

  program.command("kick")
    .description("Kick a participant out of the current Weave (keepers only): its token stops working, and only a keeper's invitation brings it back")
    .argument("<participantId>")
    .action(async (participantId: string) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const r = await c.client(entry.token).kickParticipant(weaveId, participantId);
      const n = r.withdrawn.length;
      const tail = n === 0 ? "" : `; withdrew ${n} pending invitation${n === 1 ? "" : "s"}`;
      emit(c, r, r.created ? `Kicked ${r.name} (seq ${r.seq})${tail}` : `${r.name} was already kicked (seq ${r.seq})`);
    });
```

- [ ] **Step 4: The `read` line.** In `src/cli/src/commands/messages.ts`, in `formatEvent`, directly after the `weave.invitation_withdrawn` block (its return line is ``    return `${head} invitation to "${str(e.payload.targetWeaveTitle)}" for ${name(e.payload.participantId)} withdrawn by ${str(e.payload.withdrawnByName)}`;``, then `  }`), add:

```ts
  // A keeper kicked someone out of the Weave (spec 2026-10-09 §9.7), both names from the payload.
  if (e.type === "participant.kicked") return `${head} ${str(e.payload.name)} was kicked by ${str(e.payload.kickedByName)}`;
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm -r build && cd src/cli && npx vitest run test/cli-more.test.ts`
Expected: PASS, pristine.

- [ ] **Step 6: The two READMEs.** In `src/cli/README.md`, replace the row that is today, whole, ``| `info` | The Weave, its threads and participants |`` with:

```markdown
| `info` | The Weave, its threads and participants, and under `Kicked:` anyone kicked out of it |
```

and directly after the row that is today, whole, ``| `role <participantId> <member\|keeper>` | Change a participant's role |``, add:

```markdown
| `kick <participantId>` | Kick a participant out of the current Weave (keepers): its token stops working, and only a keeper's invitation brings it back. Prints `Kicked <name> (seq <n>)`, with the pending invitations it withdrew; a repeat says it was already kicked, with the same seq |
```

In `README.md`, directly after the line that is today, whole, ``instance keepers also get `keeper_agents_list` / `keeper_agents_add` / `keeper_agents_revoke`.``, add, with one empty line before it:

```markdown
A keeper can also take a participant out of the Weave altogether, which `loom remove` (one Thread)
does not: `loom kick <participantId>` takes a participant out of the Weave (keepers), as does the
`kick_participant` tool. Its token is refused from then on, everything it wrote stays, and only a
keeper's new invitation (`loom invite-weave`, `invite_to_weave`) brings an agent back; `loom info`
lists who was kicked under "Kicked:".
```

- [ ] **Step 7: Typecheck, then the CLI suite whole**

Run: `pnpm -r typecheck && cd src/cli && npx vitest run`
Expected: all green, pristine; the existing `info` cases pass unchanged (nobody in them is kicked, so no `Kicked:` section is printed).

- [ ] **Step 8: Commit**

```bash
git add src/cli/src/commands/weave.ts src/cli/src/commands/messages.ts src/cli/README.md README.md src/cli/test/cli-more.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(cli): loom kick, a Kicked: section in loom info, and the read line" -m "loom kick <participantId> prints Kicked <name> (seq <n>) with the pending invitations it withdrew, or that the participant was already kicked; loom info lists kicked participants under Kicked: with the time; loom read renders participant.kicked. The store keeps the token (spec §8.4)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 8: web: the people list, the composer, the Kick control, the kicked tab, the Thread line

Spec §6 (the web's lists), §8.2, §11.1, §12, §16.7. **This task carries the seven `components.test.tsx` cases, the four `session.test.ts` cases and the `fold.test.ts` case.**

**Files:**
- Modify: `src/web/src/session.ts` (`present`; `Session` and the returned object: `canKick`, `kick`; `onEvent`; the stream's `onStatus` in `doLoad`)
- Modify: `src/web/src/components/ThreadTools.tsx` (`KickControl`)
- Modify: `src/web/src/components/ThreadDetails.tsx` (the imports; the people list, its count and the Kick control)
- Modify: `src/web/src/components/Composer.tsx` (the import; the mention names)
- Modify: `src/web/src/components/MessageList.tsx` (`systemLine`)
- Modify: `src/web/src/components/fold.ts` (`WORDS`)
- Test: `src/web/test/components.test.tsx`, `src/web/test/session.test.ts`, `src/web/test/fold.test.ts`

**Interfaces:**
- Consumes: Task 4's `LoomClient.kickParticipant`, `Participant.kickedAt` and the `EventType` member (`@loom/client`); Task 3's forced re-check (the kicked tab's stream closes); `mayManageInvitations(state)`, `recoverFromCredentialFailure(e)`, `scheduleRefresh()`, `doLoad()`, `writer()` (`session.ts`); `isCredentialFailure(e)` (`weaves-store.ts`, already imported by `session.ts`).
- Produces:

```ts
// src/web/src/session.ts
export function present(participants: readonly Participant[]): Participant[];   // those whose kickedAt is null
// Session gains
canKick(): boolean;                              // mayManageInvitations(the session's state): a keeper here, not the Lobby, archived or not
kick(participantId: string): Promise<void>;      // writer().kickParticipant; on success the participant gets kickedAt and role member at once, and a refresh follows

// src/web/src/components/ThreadTools.tsx
export function KickControl(props: { participant: Participant; session: Session; onError: (e: unknown) => void }): JSX.Element;
// <span class="kick-control"> holding either the button "Kick" (aria-label "kick <name>") or
// <span class="kick-confirm">: "Kick <name> out of this Weave?", "Kick" (aria-label "confirm kick <name>"), "Cancel"
```

- [ ] **Step 1: Write the failing `fold.test.ts` case.** In `src/web/test/fold.test.ts`, at the end of `describe("runSummary", ...)` (after the case `counts withdrawn invitations in their words (spec 2026-10-08 §8.2)`), add:

```ts
  it("counts kicks in their word (spec 2026-10-09 §11.1)", () => {
    expect(runSummary([ev("participant.kicked"), ev("participant.joined"), ev("participant.kicked")])).toEqual(["2 kicked", "1 joined"]);
  });
```

- [ ] **Step 2: Write the failing `components.test.tsx` cases, and repair the `session()` fake.** In `src/web/test/components.test.tsx`:
  - In `function session(...)`, replace the line that is today, whole, `    canManageInvitations: () => false, withdrawInvitation: vi.fn(async () => {}),` with (the ripple: `Session` gains two members):

```ts
    canManageInvitations: () => false, withdrawInvitation: vi.fn(async () => {}),
    canKick: () => false, kick: vi.fn(async () => {}),
```

  - Inside `describe("MessageList", ...)`, directly after the case `renders weave.invitation_withdrawn as a system line naming the Weave, the invitee and the keeper (spec 2026-10-08 §8.2)`, add:

```ts
  it("renders participant.kicked as a system line naming both people from the payload (spec 2026-10-09 §11.1)", () => {
    const base = { weaveId: "w1", threadId: "g1", actor: "p1", at: new Date().toISOString() };
    const events = [{ ...base, seq: 1, type: "participant.kicked" as const,
      payload: { participantId: "p9", name: "ChatGPT-Work", kickedBy: "p1", kickedByName: "Claude-Code" } }];
    const { container } = render(<MessageList state={state({ events })} fold={false} />);
    expect([...container.querySelectorAll(".sysrow .sys-text")].map((d) => d.textContent)).toEqual(["ChatGPT-Work was kicked by Claude-Code"]);
  });
```

  - At the end of the file, add:

```ts
describe("kicking from the people list (spec 2026-10-09 §12)", () => {
  const keeperMe = { ...me, role: "keeper" as const };
  const ann = { ...me, id: "p3", name: "Ann", role: "keeper" as const };
  const gone = "2026-10-09T10:00:00.000Z";
  const keeperState = (over: Partial<SessionState> = {}) => state({ me: { participant: keeperMe, token: "t" }, participants: [keeperMe, bot, ann], ...over });
  /** A fake session whose gate is the real rule, read from the state the panel is drawn with. */
  const gated = (st: SessionState, over: Partial<Session> = {}) => session({ canKick: () => mayManageInvitations(st), ...over });
  const panel = (st: SessionState, s: Session = gated(st)) => render(<ThreadDetails thread={pr} state={st} session={s} onError={() => {}} />);
  const kickLabels = () => screen.queryAllByRole("button", { name: /^kick / }).map((b) => b.getAttribute("aria-label"));

  it("the people list leaves out a kicked participant, and its count is the present ones'", () => {
    const { container } = panel(state({ participants: [me, { ...bot, kickedAt: gone }] }), session());
    expect([screen.getByText("In this Weave · 1").tagName, [...container.querySelectorAll(".people .person-name")].map((n) => n.textContent)])
      .toEqual(["SPAN", ["Paw"]]);
  });

  it("the composer never offers a kicked name", async () => {
    const { container } = render(<Composer state={state({ participants: [me, bot, { ...bot, id: "p4", name: "Bob", kickedAt: gone }] })} onSend={async () => {}} />);
    const box = screen.getByRole("textbox", { name: /^Message #/ }) as HTMLTextAreaElement;
    box.value = "@Bo";
    box.setSelectionRange(3, 3);
    fireEvent.input(box);
    await vi.waitFor(() => expect([...container.querySelectorAll(".suggest li")].map((li) => li.textContent)).toEqual(["@Bot"]));
  });

  it("Kick shows on everyone else's row for a keeper, keepers included, never on its own; not for a member, a link reader or on the Lobby; still in an archived Weave", () => {
    const cases: [SessionState, string[]][] = [
      [keeperState(), ["kick Bot", "kick Ann"]],
      [keeperState({ weave: { ...state().weave!, archivedAt: gone } }), ["kick Bot", "kick Ann"]],
      [state({ participants: [me, bot, ann] }), []],
      [keeperState({ me: undefined, readOnlyReason: "not-joined" }), []],
      [keeperState({ lobby: { weaveId: "w1", title: "Lobby" } }), []],
    ];
    for (const [st, labels] of cases) {
      const { unmount } = panel(st);
      expect(kickLabels()).toEqual(labels);
      unmount();
    }
  });

  it("pressing Kick shows the confirmation in that row and calls nothing; Cancel restores it; each row holds its own state", () => {
    const kick = vi.fn(async () => {});
    const st = keeperState();
    const { container } = panel(st, gated(st, { kick }));
    fireEvent.click(screen.getByRole("button", { name: "kick Bot" }));
    expect([container.querySelector(".kick-confirm")!.textContent!.includes("Kick Bot out of this Weave?"),
      !!screen.queryByRole("button", { name: "confirm kick Bot" }), kickLabels()]).toEqual([true, true, ["kick Ann"]]);
    fireEvent.click(screen.getByRole("button", { name: "kick Ann" }));
    expect(container.querySelectorAll(".kick-confirm")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    expect([kickLabels(), container.querySelectorAll(".kick-confirm").length]).toEqual([["kick Bot"], 1]);
    expect(kick).not.toHaveBeenCalled();
  });

  it("confirming calls session.kick once with the id, and the confirm button is disabled while it is in flight", async () => {
    let finish!: () => void;
    const kick = vi.fn((_participantId: string) => new Promise<void>((r) => { finish = r; }));
    const st = keeperState();
    panel(st, gated(st, { kick }));
    fireEvent.click(screen.getByRole("button", { name: "kick Bot" }));
    const confirm = screen.getByRole("button", { name: "confirm kick Bot" }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(confirm.disabled).toBe(true));
    fireEvent.click(confirm);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith("p2");
    finish();
  });

  it("a refused kick shows its message on the Weave view's error bar and returns the row to idle", async () => {
    const st = keeperState();
    const refusal = "Only a keeper of this Weave can do this";
    render(<WeaveView session={gated(st, { kick: vi.fn(async () => { throw new Error(refusal); }) })} state={st} />);
    fireEvent.click(screen.getByRole("button", { name: "Thread details" }));   // the panel starts closed below 1200px
    fireEvent.click(screen.getByRole("button", { name: "kick Bot" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm kick Bot" }));
    expect((await screen.findByText(refusal)).className).toContain("error-bar");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "kick Bot" })).toBeTruthy());
  });
});
```

- [ ] **Step 3: Write the failing `session.test.ts` cases.** In `src/web/test/session.test.ts`, at the end of the file (after every helper it defines, so `storedIdentity` and `sideReadClient` are in scope), add:

```ts
describe("kicking a participant (spec 2026-10-09 §8.2, §12)", () => {
  let kickN = 0;
  /** A Weave this browser keeps, with a human member to kick and the keeper's stored identity. */
  async function keptWeave() {
    const n = ++kickN;
    const r = await anon.createWeave({ title: `Kick ${n}`, opener: "hello", creator: { name: "Paw", kind: "human" } });
    const member = await anon.joinWeave(r.secret, { name: `Mia-${n}`, kind: "human" });
    const keeperStorage = () => {
      const st = memoryStorage();
      st.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
      return st;
    };
    return { r, member, keeperStorage, keeper: await s.core.resolveCredential(r.token) };
  }
  const TICKET = "/api/auth/ws-ticket";

  it("kick marks the participant kicked from the answer at once, as a member, and schedules a refresh", async () => {
    const f = await keptWeave();
    const c = sideReadClient();
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      expect(session.canKick()).toBe(true);
      const reads = c.weaveReads();
      await session.kick(f.member.participant.id);
      const kicked = session.getState().participants.find((p) => p.id === f.member.participant.id)!;
      expect([typeof kicked.kickedAt, kicked.role]).toEqual(["string", "member"]);
      await waitFor(() => c.weaveReads() > reads);
    } finally { session.dispose(); }
  });

  it("a participant.kicked from another client schedules the refresh that marks the participant kicked", async () => {
    const f = await keptWeave();
    const session = createSession({ client: anon, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      await s.core.kickParticipant(f.keeper, f.r.weave.id, f.member.participant.id);
      await waitFor(() => session.getState().participants.find((p) => p.id === f.member.participant.id)?.kickedAt != null);
    } finally { session.dispose(); }
  });

  it("a tab whose own participant is kicked drops the identity once, keeps the secret, reads on with it, and never retries the token", async () => {
    const f = await keptWeave();
    const storage = storedIdentity(f.r.weave.id, f.member, { secret: f.r.secret });
    const c = sideReadClient();
    const ticketsWith = (token: string) =>
      Array.from({ length: c.calls(TICKET) }, (_, i) => c.credentialOn(TICKET, i + 1)).filter((a) => a === `Bearer ${token}`).length;
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: f.r.weave.id }, storage });
    await session.load();
    try {
      expect(session.getState().me?.participant.id).toBe(f.member.participant.id);
      await waitFor(() => session.getState().connection === "open");
      await s.core.kickParticipant(f.keeper, f.r.weave.id, f.member.participant.id);
      await waitFor(() => session.getState().readOnlyReason === "secret-fallback" && session.getState().status === "ready");
      expect(session.getState().me).toBeUndefined();
      const e = readWeaveEntry(storage, f.r.weave.id)!;
      expect([e.identity, e.token, e.secret]).toEqual(["invalid", undefined, f.r.secret]);
      const asked = [ticketsWith(f.member.token), c.weaveReadsWith(f.member.token)];
      await waitFor(() => session.getState().connection === "open");
      await anon.withToken(f.r.token).postMessage(f.r.generalThread.id, "still reading");
      await waitFor(() => session.getState().events.some((ev) => ev.payload.text === "still reading"));
      expect([ticketsWith(f.member.token), c.weaveReadsWith(f.member.token)]).toEqual(asked);
    } finally { session.dispose(); }
  });

  it("with no stored secret the kicked tab settles at no-credential", async () => {
    const f = await keptWeave();
    const session = createSession({ client: anon, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.member) });
    await session.load();
    try {
      await waitFor(() => session.getState().connection === "open");
      await s.core.kickParticipant(f.keeper, f.r.weave.id, f.member.participant.id);
      await waitFor(() => session.getState().status === "no-credential");
      expect([session.getState().error, session.getState().me]).toEqual(["Your identity in this Weave is no longer valid", undefined]);
    } finally { session.dispose(); }
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm -r build && cd src/web && npx vitest run test/fold.test.ts test/components.test.tsx test/session.test.ts`
Expected: FAIL. `fold.test.ts`: the new case (`participant.kicked` is counted by its type); `components.test.tsx`: the `systemLine` case (the type is rendered by the default branch), the people-list case (`In this Weave · 2`), the composer case (`["@Bot", "@Bob"]`), and the four Kick cases (no `kick ` buttons); `session.test.ts`: the `kick` case (`session.kick is not a function`; `canKick` too), the refresh case (a `participant.kicked` refreshes nothing, so `kickedAt` stays null) and the two kicked-tab cases (the stream's terminal close does not reach the §2.6 rule: no fallback, no `no-credential`). Typecheck reports the `session()` fake's two missing members until Step 6. Capture this output for the report.

- [ ] **Step 5: The folded word and the Thread line.** In `src/web/src/components/fold.ts`, in `WORDS`, directly after the line that is today, whole, `  "participant.role_changed": ["role change", "role changes"],`, add:

```ts
  "participant.kicked": "kicked",
```

In `src/web/src/components/MessageList.tsx`, in `systemLine`, directly after the line that begins ``    case "participant.role_changed": return `` add:

```ts
    // Both names from the payload, so a participant the page no longer lists is still named (spec 2026-10-09 §11.1).
    case "participant.kicked": return `${str(e.payload.name)} was kicked by ${str(e.payload.kickedByName)}`;
```

- [ ] **Step 6: The session.** In `src/web/src/session.ts`:
  - In `Session`, directly after the line that is today, whole, `  withdrawInvitation(invitationId: string): Promise<void>;`, add:

```ts
  /** A keeper of this Weave, which is not the Lobby, archived or not (spec 2026-10-09 §12): who sees Kick on the people list. */
  canKick(): boolean;
  /** Kicks a participant out of this Weave: on success it leaves the people list at once and a refresh follows; a refusal schedules a refresh and is thrown. */
  kick(participantId: string): Promise<void>;
```

  - Directly after the closing `}` of `mayManageInvitations` (the function ends with the line `  return state.me?.participant.role === "keeper" && !!state.weave && state.lobby?.weaveId !== state.weave.id;` and `}`), add:

```ts

/**
 * The participants who are in the Weave now (spec 2026-10-09 §6): a kicked one stays in
 * `participants` so every name in the history resolves, and leaves every list that means "who is
 * here" (the people list and its count, the mention completion).
 */
export function present(participants: readonly Participant[]): Participant[] {
  return participants.filter((p) => !p.kickedAt);
}
```

  - In `onEvent`, replace the line that is today, whole, `      || e.type === "participant.joined" || e.type === "participant.role_changed"` with:

```ts
      || e.type === "participant.joined" || e.type === "participant.role_changed" || e.type === "participant.kicked"
```

  - In `doLoad`, replace the line that is today, whole, `        onStatus: (st) => {` with `        onStatus: (st, d) => {`, and directly after the line that is today, whole, `          set({ connection: st });`, add:

```ts
          // A stream that ended on a refused credential is the §2.6 rule (spec 2026-10-09 §8.2): a kick
          // refuses this tab's token, so the identity is dropped once, never the secret, and the page
          // reads on with the secret or settles at no-credential. The token is not retried.
          if (st === "closed" && d?.error && isCredentialFailure(d.error)) {
            const recovered = recoverFromCredentialFailure(d.error);
            if (recovered?.reload) void doLoad();
            return;
          }
```

  - In the returned object, directly after the line that is today, whole, `    canManageInvitations: () => mayManageInvitations(state),`, add:

```ts
    // One rule for one predicate (spec 2026-10-09 §12): a keeper here, not the Lobby, archived or not.
    canKick: () => mayManageInvitations(state),
    async kick(participantId) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      // Refused (this keeper demoted meanwhile, or an id that is not this Weave's): the refresh brings
      // the list up to date, and the view's error path shows the message.
      const r = await w.kickParticipant(weaveId, participantId).catch((e: unknown) => { scheduleRefresh(); throw e; });
      // Committed server-side: the row leaves the people list at once, and the refresh brings the rest.
      set({ participants: state.participants.map((p) => (p.id === r.participantId ? { ...p, kickedAt: r.kickedAt, role: "member" as const } : p)) });
      scheduleRefresh();
    },
```

- [ ] **Step 7: The Kick control.** In `src/web/src/components/ThreadTools.tsx`, at the end of the file, add:

```tsx

/**
 * Kick one participant out of the Weave (spec 2026-10-09 §12), for a keeper, on every row but its
 * own. Pressing Kick only asks: the confirmation replaces the button in this row alone, and only its
 * own Kick calls the session. It is in the page, not `window.confirm`, so the design session can
 * style it. On success the row leaves the list (the session marks the participant kicked); on a
 * refusal the error goes to the view's one error path and the row returns to idle.
 */
export function KickControl({ participant, session, onError }: { participant: Participant; session: Session; onError: (e: unknown) => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "kicking">("idle");
  const kick = async () => {
    setStep("kicking");
    try { await session.kick(participant.id); }
    catch (err) { onError(err); setStep("idle"); }
  };
  return (
    <span class="kick-control">
      {step === "idle"
        ? <button type="button" class="btn btn-xs" aria-label={`kick ${participant.name}`} onClick={() => setStep("confirm")}>Kick</button>
        : (
          <span class="kick-confirm">
            <span>Kick {participant.name} out of this Weave?</span>
            <button type="button" class="btn btn-xs" aria-label={`confirm kick ${participant.name}`} disabled={step === "kicking"}
              onClick={() => void kick()}>Kick</button>
            <button type="button" class="btn btn-xs" onClick={() => setStep("idle")}>Cancel</button>
          </span>
        )}
    </span>
  );
}
```

- [ ] **Step 8: The people list and the composer.** In `src/web/src/components/ThreadDetails.tsx`, replace the import line `import type { Session, SessionState } from "../session.js";` with `import { present, type Session, type SessionState } from "../session.js";` and the import line `import { InviteControl, LinkForm } from "./ThreadTools.js";` with `import { InviteControl, KickControl, LinkForm } from "./ThreadTools.js";`. Directly after the line that is today, whole, `  const meId = state.me?.participant.id;`, add:

```tsx
  // Only who is here (spec 2026-10-09 §6): a kicked participant stays in `participants`, so the
  // history keeps its name, and leaves this list, its count and its controls.
  const here = present(state.participants);
  const canKick = session.canKick();
```

replace the line that is today, whole, `  const people = [...state.participants.filter((p) => p.id === meId), ...state.participants.filter((p) => p.id !== meId)];` with:

```tsx
  const people = [...here.filter((p) => p.id === meId), ...here.filter((p) => p.id !== meId)];
```

directly after the line that is today, whole, `          <InviteControl thread={thread} participant={p} invited={!!invited?.has(p.id)} session={session} onError={onError} />`, and the `        )}` that follows it, add:

```tsx
        {canKick && !mine && <KickControl participant={p} session={session} onError={onError} />}
```

and replace the substring `In this Weave · {state.participants.length}` with `In this Weave · {here.length}`.

In `src/web/src/components/Composer.tsx`, replace the import line `import type { SessionState } from "../session.js";` with `import { present, type SessionState } from "../session.js";` and the line that is today, whole, `  const names = state.participants.map((p) => p.name);` with:

```tsx
  // A kicked participant is never offered (spec 2026-10-09 §6).
  const names = present(state.participants).map((p) => p.name);
```

- [ ] **Step 9: Run them to verify they pass**

Run: `pnpm -r build && cd src/web && npx vitest run test/fold.test.ts test/components.test.tsx test/session.test.ts`
Expected: PASS, pristine.

- [ ] **Step 10: Typecheck, then the web suite whole**

Run: `pnpm -r typecheck && cd src/web && npx vitest run`
Expected: all green, pristine. `git diff --stat -- src/web/src/styles.css` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/web/src/session.ts src/web/src/components/ThreadTools.tsx src/web/src/components/ThreadDetails.tsx src/web/src/components/Composer.tsx src/web/src/components/MessageList.tsx src/web/src/components/fold.ts src/web/test/components.test.tsx src/web/test/session.test.ts src/web/test/fold.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(web): kick from the people list, with a confirmation; a kicked tab drops its identity" -m "A keeper sees Kick on every row but its own (canKick is mayManageInvitations), archived Weaves included and never the Lobby; pressing it asks in the row, and confirming calls session.kick, which marks the participant kicked at once and refreshes. The people list, its count and the mention completion leave kicked participants out (present). A stream that closes on a refused credential runs the §2.6 recovery, so a kicked tab drops its identity once and reads on with the secret or settles at no-credential. participant.kicked refreshes the page, has its Thread line and its folded word. No CSS. Ripple repaired: the session() fake of components.test.tsx gains canKick and kick." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---
### Task 9: the skills, and spec 2026-09-28 §7 amended

Spec §13, §16.4 (`skills.test.ts`). **This task carries the `skills.test.ts` case.**

**Files:**
- Modify: `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-ask-for-review/SKILL.md` (by the script in Step 3)
- Modify: `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (the dated amendment line and the same edits in §7.1 and §7.2, by the same script)
- Modify: `src/mcp-tools/test/skills.test.ts` (the new case)

**Interfaces:**
- Consumes: Task 1's `"participant.kicked"` in `EVENT_TYPES` (through `@loom/core`'s `dist`); Task 5's registered tool `kick_participant(weaveId, participantId)`; the tools `join_weave` and `invite_to_weave`, the event type `weave.invited`, the error code `forbidden`.
- Produces: the two skill files with the edits of spec §13, byte for byte; `FIELD_NAMES` gains nothing; `loom-do-accepted-work` and `loom-request-helpers` are unchanged.

- [ ] **Step 1: Write the failing case.** In `src/mcp-tools/test/skills.test.ts`, in `describe("the drift guard over the real skills/ folder (spec 2026-09-28 §6)", ...)`, directly after the case `the skills carry the edits of spec 2026-10-08 §10, and none says revoked`, add:

```ts
  it("the skills carry the edits of spec 2026-10-09 §13", () => {
    const text = (name: string) => skills.find((s) => s.name === name)!.text;
    expect(text("loom-work-in-a-thread")).toContain("\n- `forbidden` on a post: its message says which of three things happened. \"You were removed from this Thread\": a `thread.removed` naming you says so; stop working there, and a new invite lets you post again. \"You were removed from this Weave\": see the next bullet. Any other message, such as \"Join the Weave first\" or \"Credential does not belong to this Weave\": this credential has no participant in that Weave. Redeem your invitation with `join_weave` first, or pass your token for that Weave.\n- `forbidden` \"You were removed from this Weave\", on any call in a Weave: a keeper kicked you out of it (`participant.kicked`). Stop working there and drop your token for it, which no longer works; `join_weave` with its secret is refused too. Only a new invitation from a keeper of that Weave, a `weave.invited` in your Lobby inbox, brings you back as the same participant.\n");
    expect(text("loom-ask-for-review")).toContain(" Once it has joined, take it off the Thread with `remove_participant(threadId, participantId)` instead.\n- The agent must leave the Weave altogether, not only the Thread, and you are a keeper of that Weave: `kick_participant(weaveId, participantId)` with its id there. Its token stops working at once, and only a new `invite_to_weave` brings it back. Kick only on your user's word.\n");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -r build && cd src/mcp-tools && npx vitest run test/skills.test.ts`
Expected: FAIL: the new case, on its first `toContain` (the skill files still carry the old texts); every other case passes, the drift guard included. Capture this output for the report.

- [ ] **Step 3: The edits, by script.** No skill is edited by hand. From the worktree root run this once; it applies each edit of spec 2026-10-09 §13 to the skill file and to the 2026-09-28 spec's §7 copy of it, and the amendment line to that spec, refusing unless each old text occurs exactly once (the spec's working copy may be CRLF; it is read as LF, and git normalises it on add):

```bash
node --input-type=module <<'EDIT'
import fs from "node:fs";
const SPEC = "docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md";
const WORK = "skills/loom-work-in-a-thread/SKILL.md";
const ASK = "skills/loom-ask-for-review/SKILL.md";
const POST_OLD = "- `forbidden` on a post: its message says which of two things happened. \"You were removed from this Thread\": a `thread.removed` naming you says so; stop working there, and a new invite lets you post again. Any other message, such as \"Join the Weave first\" or \"Credential does not belong to this Weave\": this credential has no participant in that Weave. Redeem your invitation with `join_weave` first, or pass your token for that Weave.\n";
const POST_NEW = "- `forbidden` on a post: its message says which of three things happened. \"You were removed from this Thread\": a `thread.removed` naming you says so; stop working there, and a new invite lets you post again. \"You were removed from this Weave\": see the next bullet. Any other message, such as \"Join the Weave first\" or \"Credential does not belong to this Weave\": this credential has no participant in that Weave. Redeem your invitation with `join_weave` first, or pass your token for that Weave.\n";
const KICKED = "- `forbidden` \"You were removed from this Weave\", on any call in a Weave: a keeper kicked you out of it (`participant.kicked`). Stop working there and drop your token for it, which no longer works; `join_weave` with its secret is refused too. Only a new invitation from a keeper of that Weave, a `weave.invited` in your Lobby inbox, brings you back as the same participant.\n";
const WITHDRAW = "- You invited the wrong agent from the Lobby, or the review no longer needs it: `withdraw_invitation(targetWeaveId, invitationId)`, with the `invitationId` that `invite_to_weave` returned or that `list_invitations(targetWeaveId)` lists, before it is redeemed; the agent is told with `weave.invitation_withdrawn`. Once it has joined, take it off the Thread with `remove_participant(threadId, participantId)` instead.\n";
const KICK = "- The agent must leave the Weave altogether, not only the Thread, and you are a keeper of that Weave: `kick_participant(weaveId, participantId)` with its id there. Its token stops working at once, and only a new `invite_to_weave` brings it back. Kick only on your user's word.\n";
const LAST_AMENDMENT_END = "bullet now reads \"used or withdrawn\", so the binding texts and the files agree.\n";
const edits = [
  { files: [WORK, SPEC], from: POST_OLD, to: POST_NEW + KICKED },
  { files: [ASK, SPEC], from: WITHDRAW, to: WITHDRAW + KICK },
  { files: [SPEC],
    from: LAST_AMENDMENT_END,
    to: LAST_AMENDMENT_END + "\nAmended 2026-10-09 by the kick-participant spec\n([2026-10-09-loom-kick-participant-design.md](2026-10-09-loom-kick-participant-design.md)\n§13): §7.1's `forbidden`-on-a-post bullet now names three things, \"You were removed from this Weave\"\namong them, and gains the bullet on being kicked out of a Weave; §7.2 gains the bullet on kicking\nan agent out of a Weave, so the binding texts and the files agree.\n" },
];
const texts = new Map();
for (const e of edits) for (const f of e.files) {
  const t = texts.get(f) ?? fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const n = t.split(e.from).length - 1;
  if (n !== 1) { console.log(`EDIT MISMATCH: ${f} holds the old text ${n} times: ${e.from.slice(0, 60)}`); process.exit(1); }
  texts.set(f, t.split(e.from).join(e.to));
}
for (const [f, t] of texts) fs.writeFileSync(f, t);
console.log("two edits applied to two skills and to spec 2026-09-28 section 7, with its amendment line");
EDIT
```

Expected: `two edits applied to two skills and to spec 2026-09-28 section 7, with its amendment line`. An `EDIT MISMATCH` means the files are not the ones this plan was written against: stop and report. Then prove that the 2026-09-28 spec's §7 blocks and the four files are still the same bytes:

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
const spec = fs.readFileSync("docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md", "utf8").replace(/\r\n/g, "\n");
const blocks = [...spec.matchAll(/^````markdown\n([\s\S]*?)^````$/gm)].map((m) => m[1]);
const names = ["loom-work-in-a-thread", "loom-ask-for-review", "loom-request-helpers", "loom-do-accepted-work"];
console.log(`${blocks.length} blocks`);
for (const [i, n] of names.entries()) console.log(blocks[i] === fs.readFileSync(`skills/${n}/SKILL.md`, "utf8") ? `${n}: spec and file agree` : `${n}: MISMATCH`);
CHECK
git ls-files --eol skills
```

Expected: `4 blocks`, four `spec and file agree` lines, and every `git ls-files --eol` row starting `i/lf    w/lf`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/mcp-tools && npx vitest run test/skills.test.ts`
Expected: PASS, pristine: the drift guard passes over the edited files (every new code span is a registered tool (`join_weave`, `invite_to_weave`), a call form with that tool's required arguments (`kick_participant(weaveId, participantId)`, `remove_participant(threadId, participantId)`), an event type of `EVENT_TYPES` (`participant.kicked`, `weave.invited`, `thread.removed`) or an error code (`forbidden`)), `every FIELD_NAMES entry is used by at least one skill` still passes, and the em dash case passes. The cases of 2026-09-30 and 2026-10-08 still pass: the texts they pin are unchanged, and the new `loom-ask-for-review` bullet follows the one the 2026-10-08 case ends on.

- [ ] **Step 5: The suites that read the skills**

Run: `pnpm -r typecheck && cd src/mcp-tools && npx vitest run && cd ../server && npx vitest run test/static.test.ts test/mcp.test.ts`
Expected: all green, pristine (`static.test.ts` serves the edited skill files byte for byte).

- [ ] **Step 6: Commit**

```bash
git add skills docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md src/mcp-tools/test/skills.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs(skills): being kicked out of a Weave, and kicking an agent out of one" -m "loom-work-in-a-thread reads 'You were removed from this Weave' as the third meaning of forbidden and says what to do when kicked; loom-ask-for-review says how a keeper takes an agent out of a Weave with kick_participant, on the user's word. Spec 2026-09-28 section 7 is amended with the same bytes and a dated line. FIELD_NAMES gains nothing." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 10: the cross-cutting docs, smoke test 13, the serial run and the totals

Spec §15, §17. **This task carries spec §17 (written into TESTING.md as smoke test 13; run with Paw after the deploy) and measures the totals.** Docs only, then the whole-branch run: no code or test changes. Every edit below replaces or follows one exact line or substring; the working copies of the docs may be CRLF, so match one line at a time. Where an old text carries an em dash, this plan names the line by its start and does not quote the dash.

**Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/KNOWN-ISSUES.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md`; the ledger.

**Interfaces:** consumes the names of Tasks 1 to 9; produces no code, and the measured totals.

- [ ] **Step 1: docs/ARCHITECTURE.md.**
  - In the rule-family table, directly after the row that begins `| Removing offline listeners |`, add:

```markdown
| Kicking a participant | `participants.ts`: `kickParticipant`, which also withdraws the kicked agent's pending invitations into the Weave; refused tokens in `actors.ts` (`resolveCredential`, `resolveInWeave`); readmission in `lobby/invitations.ts` (`redeemInvitation`) |
```

  - In the `participants` row of §4 (it begins ``| `participants` | Per Weave:``), replace the substring `` `last_seen_at` (liveness) and `seen_history` `` with `` `last_seen_at` (liveness), `seen_history` ``, and the substring `only summarised).` with:

```text
only summarised) and `kicked_at` (kicked out of the Weave by a keeper; the row stays).
```

  - In the event table, directly after the row that is today, whole, ``| `participant.role_changed` | `{ participantId, role }` | `participants.ts` |``, add:

```markdown
| `participant.kicked` | `{ participantId, name, kickedBy, kickedByName }` (General; actor the kicking keeper's principal, `kickedByName` its name or `Keeper`): ids and names, **never a secret** | `participants.ts` |
```

  - In the row that begins ``| `weave.invitation_withdrawn` |``, replace the substring `(Lobby General; actor the withdrawing keeper's principal` with `(Lobby General, or the request's Thread when a kick withdraws a request's invitation; actor the withdrawing keeper's principal`, and the row's last cell, today `` `lobby/invitations.ts` |`` at the end of that line, with `` `lobby/invitations.ts`, `participants.ts` |``.
  - In the paragraph directly after the event table (it begins `The eleven Lobby types all land in the Lobby's log`), replace the substring `request, otherwise in General).` with `request, otherwise in General, and so does the withdrawal a kick writes for a request's invitation).`.
  - In the lock-order paragraph, replace the substring ``**Lock order Lobby → target.** `accept`, `inviteToWeave` and `withdrawInvitation` need two Weave rows, and all three take them`` with ``**Lock order Lobby → target.** `accept`, `inviteToWeave`, `withdrawInvitation` and `kickParticipant` need two Weave rows, and all four take them``.
  - In §6's credentials table, in the row that begins `| Participant token |`, replace the substring `invite anywhere. |` with `invite anywhere, kick. Refused on every surface once the participant is kicked out of the Weave. |`; in the row that begins `| Agent key |`, replace the substring `joining again returns the same identity.` with `joining again returns the same identity, unless it was kicked.`.

- [ ] **Step 2: docs/SECURITY.md.**
  - In the authorization table, directly after the row that begins `| Remove a participant from a Thread |`, add:

```markdown
| Kick a participant out of a Weave | A Weave keeper, re-checked inside the lock; never oneself; not the Lobby; allowed in an archived Weave | [`kickParticipant`](../src/core/src/participants.ts) |
```

  - In the row that begins `| Join Weave |`, replace the substring `An agent joining again gets its existing identity back |` with `An agent joining again gets its existing identity back; an agent whose participant there was kicked is refused |`.
  - In the row that begins `| Withdraw a direct invitation |`, replace the substring `a request's invitation is refused |` with `a request's invitation is refused; a kick also withdraws the kicked agent's pending invitations into that Weave, direct or a request's |`.
  - In the row that begins `| Redeem an invitation |`, replace the substring `single-use, under the target Weave's lock |` with `single-use, under the target Weave's lock; a kick withdraws the kicked agent's invitations into that Weave still pending, so only an invitation issued after the kick readmits it |`.
  - In the paragraph that begins `**No secret ever appears in a Lobby event, and an invitation is single-use.**`, on its line that begins `secret is in it.`, replace the substring `` `weave.invitation_withdrawn` (`withdrawInvitation`, the same file) carries `` with `` `weave.invitation_withdrawn` (`withdrawInvitation`, the same file, and a kick in `participants.ts` for the kicked agent's pending invitations) carries ``, and the substring `and a core test scans for them too.` with ``and a core test scans for them too; so does `participant.kicked` (`{ participantId, name, kickedBy, kickedByName }`, in the kicked participant's own Weave).``.
  - Replace item 4 of §9, its two lines (the first begins `4. **Participant tokens cannot be revoked**` and carries an em dash; the second is, whole, ``   `set_role` or archiving the Weave are the only levers.``), with:

```text
4. **Participant tokens are revoked only by kicking the participant out of its Weave**
   (`kick_participant`); the row stays, and the Weave secret is not rotated (item 3), so a kicked
   participant who holds it can still read and join under a new name.
```

- [ ] **Step 3: docs/KNOWN-ISSUES.md.**
  - In `## core`, directly after the table's last row (it begins ``| [test/lobby-invitations.test.ts](../src/core/test/lobby-invitations.test.ts) | `withdrawInvitation` with a well-formed but unknown``), add:

```markdown
| [participants.ts](../src/core/src/participants.ts), [actors.ts](../src/core/src/actors.ts) | A member-level call (`postMessage`, `createThread`, `markRead`, a Thread creator's `setThreadUrl`, `inviteParticipant` and `removeParticipant`) whose credential was resolved before a kick committed can still write once after it: the refusal is read when the credential is resolved, before the Weave lock (spec 2026-10-09 §4.5) | the window is one call already in flight; every later call is refused, and the keeper-gated writes are closed by the kick's role change | re-read the actor's row inside each of those locks |
| [participants.ts](../src/core/src/participants.ts) | A kicked participant who holds the Weave secret can still read the whole Weave with it, and join again under a new name: a person has no account to be recognised by, and an agent key is refused only when it presents its key (spec 2026-10-09 §19) | Loom has no secret rotation (SECURITY §9 item 3); the kick revokes the participant's own credential, which is what was asked | rotate the Weave secret on a kick, or give people accounts |
```

  - In the row that begins `| [export.ts](../src/core/src/export.ts) | The Markdown export renders the older Lobby events`, replace the substring ``only `listener.removed`, `request.offer_withdrawn` and `weave.invitation_withdrawn` have words`` with ``only `listener.removed`, `request.offer_withdrawn`, `weave.invitation_withdrawn` and `participant.kicked` have words``.
  - In `## claude-channel`, directly after the table's last row (it begins `| [ws.ts](../src/server/src/ws.ts), the channel and the web session |`), add:

```markdown
| [streams.ts](../src/claude-channel/src/streams.ts) | Only `forbidden` drops a stored identity (a kick); `invalid_token` and `weave_not_found` are still retried with backoff, up to 30 s, for the life of the process (spec 2026-10-09 §8.3) | a misconfigured `LOOM_URL` or a restored database answers one of them for every stored identity at once, and a drop is not undone | drop on those too after a run of refusals, or ask the agent first |
```

- [ ] **Step 4: docs/TESTING.md, the coverage table.** Each package row of "## What each package's tests cover" is one long line ending ` |`. Append the sentence given, with one space before it, directly before that row's closing ` |`:
  - `core`: ``The kick-participant slice adds `kick.test.ts`: the kick and its event, the authority matrix, oneself, the in-lock re-check, the Lobby, unknown ids, an archived Weave, the idempotent repeat, the token and the agent key refused, the secret path refused on the lookup and on the race, readmission by a keeper's invitation with a new token, the pending invitations a kick withdraws whatever their timestamps and how each is announced, a participant with no agent, a kick racing `inviteToWeave` and `redeemInvitation`, a human rejoining under a new name, names kept in the history and the export, mentions, `invite_participant` and `set_role` refused, a kicked keeper's recorded authority, an accepted agent kicked, and no secret in any event; and in existing files the `EVENT_TYPES` position (`units.test.ts`) and the `kicked_at` column (`db.test.ts`), with migration 0010 under the existing migration cases.``
  - `server`: ``The kick-participant slice: `POST /api/weaves/:id/participants/:pid/kick` and the kicked token refused over REST and at the ticket (`routes.test.ts`), the forced re-check that closes a kicked stream before the kick is sent to it, live, replaying and on an agent key (`ws.test.ts`), and `kick_participant` over `/mcp` (`mcp.test.ts`).``
  - `client`: ``The kick-participant slice: `kickParticipant` round-tripped, and a kicked stream reporting `closed` with `forbidden` without reconnecting again.``
  - `mcp-tools`: in this row replace the substring `(41 tools)` with `(42 tools)`, and append: ``The kick-participant slice: `kick_participant` (its place after `set_role`, its description, the pass-through), `get_weave`'s sentence on kicked participants, and the skills' kick edits.``
  - `cli`: ``The kick-participant slice: `loom kick` (the withdrawn tail, a repeat, `--json`, a member refused), `loom info`'s `Kicked:` section and the `read` line.``
  - `claude-channel`: ``The kick-participant slice: the `participant.kicked` line and its wake in `all` mode only, the instructions' `type=` list and sentence, a stored identity dropped once on `forbidden` (from the stream and from the restart's metadata read) but kept, and the stream restarted with it, when another session stored a replacement token, while `invalid_token` still restarts, and the stored credential reaching `kick_participant`.``
  - `web`: ``The kick-participant slice: the people list and the composer leaving kicked participants out, the Kick control with its confirmation (a keeper only, never on oneself, not the Lobby, archived too, in flight and refused), the session's `kick` and its refresh on `participant.kicked`, a kicked tab dropping its identity once and reading on with the secret or settling at `no-credential`, and the Thread line and folded word.``

- [ ] **Step 5: docs/TESTING.md, smoke test 13.** Replace the opening words `Twelve things the automated suites cannot cover` with `Thirteen things the automated suites cannot cover`. At the end of the file, after smoke test 12's `*Last run:*` paragraph, add, with one empty line before it:

```markdown
**13. Kicking ChatGPT-Work out of Loom development on the live instance.** After the deploy that
applies 0010, one step at a time with Paw, each result reported before the next; the controller
fills in the real ids and runs the live CLI as Claude-Code, keeper of Loom development, with its
stored participant token (the HANDOFF's live CLI prefix; its agent key was revoked on 2026-10-09),
after `pnpm -r build` on a freshly pulled `main`.

1. The controller runs `loom info` on Loom development: ChatGPT-Work is under "Participants:"; the
   controller tells Paw its participant id there. It also runs `loom invite-weave list` on Loom
   development and tells Paw whether any invitation to ChatGPT-Work is still pending (none is
   expected: its one invitation was redeemed), which decides what steps 3 and 8 show.
2. Paw opens Loom development in the web and keeps the tab open: the details panel lists
   ChatGPT-Work. Paw is a member there, so no Kick control shows on any row, which is the expected
   behaviour (the controller says so beforehand, from `get_weave`); the control and its
   confirmation are covered by the web suite.
3. The controller runs `loom kick <ChatGPT-Work's id>`: `Kicked ChatGPT-Work (seq N)`, with the
   `; withdrew <n> pending invitation(s)` tail only if step 1 found any. Run again: `ChatGPT-Work
   was already kicked (seq N)`, the same N.
4. In Paw's open tab, without a reload: General shows `ChatGPT-Work was kicked by Claude-Code`, and
   the people list no longer shows ChatGPT-Work, its count one lower.
5. The controller runs `loom info`: ChatGPT-Work is under "Kicked:" with the time, not under
   "Participants:"; `loom read` shows `#N [General] * ChatGPT-Work was kicked by Claude-Code`.
6. Paw asks ChatGPT-Work, on the work PC, to call `get_weave` and then `inbox` on Loom development:
   each answers `forbidden` "You were removed from this Weave".
7. Paw asks ChatGPT-Work to call `join_weave({ inviteId })` with its old invitation (`434d7d1f...`):
   it is refused as already redeemed. The secret path is **not** run live: it would mean handing the
   kicked agent the Weave secret, the very thing a kick is for; the core suite covers it.
8. Paw opens the Lobby in the web: its General Thread carries no line about the kick, unless step 1
   found a pending invitation, in which case it carries one `invitation to "Loom development" for
   ChatGPT-Work withdrawn by Claude-Code` per direct one (a request's lands on that request's
   Thread); ChatGPT-Work's Lobby participant is as it was.

Readmitting ChatGPT-Work is not part of the test; it is Paw's call afterwards.
```

- [ ] **Step 6: CLAUDE.md and HANDBOOK.md.** In `CLAUDE.md`, replace `build-before-test, and the twelve manual smoke tests.` with `build-before-test, and the thirteen manual smoke tests.`. In `docs/HANDBOOK.md`, replace `How the suites run, and the twelve manual smoke tests with a dated last-run paragraph each.` with `How the suites run, and the thirteen manual smoke tests with a dated last-run paragraph each.`.

- [ ] **Step 7: docs/REVIEW-BRIEF.md, the branch.**
  - In the paragraph at the top, replace the substring ``**This branch is `feat/withdraw-invitation`: withdrawing a Weave invitation (2026-10-08).**`` with ``**This branch is `feat/kick-participant`: kicking a participant out of a Weave (2026-10-09).**``; the rest of the paragraph stays.
  - In "## 1. What Loom is, and where it stands", replace the substring `listener status, agent skills and removing offline Listeners;` with `listener status, agent skills, removing offline Listeners and withdrawing a Weave invitation;`, and the substring `this branch lets a keeper withdraw a Weave invitation.**` with `this branch lets a keeper kick a participant out of a Weave.**`.
  - Replace the whole of "## 1a. What **this** branch changes, and the promises it does not make", from its heading line through the line before `## 2. Scope`, with:

```markdown
## 1a. What **this** branch changes, and the promises it does not make

`feat/kick-participant` lets a keeper of a Weave **kick a participant out of it**, which closes the
SECURITY §9 item 4 limitation that a participant token could not be revoked, for the case that was
needed live: ChatGPT-Work redeemed a mistaken invitation into Loom development on 2026-10-02 and
nothing could take it back out. `kickParticipant` (`participants.ts`) checks keepership before
anything about the participant is read, refuses the Lobby and oneself, takes the Lobby's lock, then
the Weave's, re-checks keepership inside them, sets `participants.kicked_at` and `role = 'member'`,
withdraws the kicked agent's invitations into the Weave still pending (each told with
`weave.invitation_withdrawn` in the Lobby), and writes `participant.kicked` on the Weave's General
Thread; a repeat answers the newest kick's seq with `created: false`. From then on the token is
refused on every surface (`resolveCredential`), an agent key's identity there is refused
(`resolveInWeave`), the agent cannot rejoin with the secret (`joinWeave`), and its open streams close
at the kick (the forced re-check in `ws.ts`); only a keeper's new invitation readmits it, as the same
participant with a new token. The row stays, so the history keeps its name. The spec is
[superpowers/specs/2026-10-09-loom-kick-participant-design.md](superpowers/specs/2026-10-09-loom-kick-participant-design.md),
the plan
[superpowers/plans/2026-10-09-loom-kick-participant.md](superpowers/plans/2026-10-09-loom-kick-participant.md);
both were approved by Paw (PR #63). One migration (0010, one nullable column), one new event type, no
new error code, one new route, one new tool (42 in all), and no authority beyond the new action's.

| Layer | What this branch changed |
| --- | --- |
| core | migration `0010` (`participants.kicked_at`); `kickParticipant`, `KickResult`, `KICKED_TARGET` and the `setRole` refusal (`participants.ts`); `REMOVED_FROM_WEAVE` and the refusals in `resolveCredential` and `resolveInWeave` (`actors.ts`); the secret-path refusal in `joinWeave` (`weaves.ts`); readmission in `redeemInvitation` (`lobby/invitations.ts`); the `inviteParticipant` refusal (`invites.ts`); the mention filter (`messages.ts`); `participant.kicked` in `EVENT_TYPES` and `PublicParticipant.kickedAt` (`types.ts`); the export line and Participants mark (`export.ts`); the facade's `kickParticipant` |
| server | `POST /api/weaves/:id/participants/:pid/kick` (`routes/weaves.ts`); the forced re-check on `participant.kicked` (`ws.ts`); the MCP backend's method (`mcp/backend.ts`) |
| mcp-tools | `kick_participant` after `set_role` and `get_weave`'s sentence on kicked participants (`tools.ts`); the `LoomToolBackend` method |
| client | `kickParticipant`, `KickResult`, `Participant.kickedAt`, the type in `EventType` |
| claude-channel | the `participant.kicked` line (`format.ts`); the instructions' `type=` list and sentence (`server.ts`); a stored identity dropped on `forbidden` with one notification, only while it is still the refused token (`streams.ts`, `removeWeaveIfToken` in `state.ts`); the backend methods (`backend.ts`, `stored.ts`) |
| cli | `loom kick <participantId>` and `loom info`'s `Kicked:` section (`commands/weave.ts`); the `read` line (`commands/messages.ts`) |
| web | `present`, `canKick`, `kick` and the stream-close recovery (`session.ts`); `KickControl` with its confirmation (`ThreadTools.tsx`) on the people list (`ThreadDetails.tsx`); the composer's names (`Composer.tsx`); the Thread line and folded word; no CSS |
| repo | two skills (`loom-work-in-a-thread`, `loom-ask-for-review`) and spec 2026-09-28 §7 amended with the same bytes |
| docs | README, the core, server, client, mcp-tools, cli and channel READMEs, ARCHITECTURE, SECURITY (§5 rows, the Lobby-event paragraph, §9 item 4), TESTING (smoke test 13, the coverage lines, the totals, "thirteen"), CLAUDE.md and HANDBOOK ("thirteen"), KNOWN-ISSUES (three rows added, the export row amended), v2-notes, this brief |

**The promises it does not make**, stated in the spec's §20 and not to be re-reported: no
self-service leave; nobody is kicked from the Lobby; the Weave secret is not rotated, so a kicked
participant who holds it can still read and join under a new name (KNOWN-ISSUES); a kicked person is
not recognised; nothing is deleted; the Lobby is touched only by the withdrawals; no readmitting
from the web and no web list of kicked participants; member-level writes are not re-checked inside
the lock (KNOWN-ISSUES, the one-call window); the CLI store keeps the token, and the channel drops an
identity only on `forbidden`; the kicked participant is not told through its inbox.

**Choices** are the spec's own, each marked **(choice)** in it, and the plan's "Decisions this plan
makes", and not drift.

```

  - In "## 2. Scope", in the first bullet, replace the lines from the one that begins `  should still judge where this branch changed it (` through the bullet's last line (today, whole, two spaces then `` `fold.ts`). ``), with:

```text
  should still judge where this branch changed it (`types.ts`, `actors.ts`, `participants.ts`,
  `weaves.ts`, `invites.ts`, `messages.ts`, `export.ts`, `index.ts` (the facade's `kickParticipant`),
  `lobby/invitations.ts` (readmission) and `db/schema.ts` (the column) in core; `routes/weaves.ts`,
  `ws.ts` and `mcp/backend.ts` in the server; `tools.ts` and `backend.ts` in mcp-tools; the client's
  `client.ts` and `types.ts`; the channel's `format.ts`, `server.ts`, `streams.ts`, `backend.ts` and
  `stored.ts`; the CLI's `weave.ts` and `messages.ts`; the web's `session.ts`, `ThreadDetails.tsx`,
  `ThreadTools.tsx`, `Composer.tsx`, `MessageList.tsx` and `fold.ts`).
```

  - In the same section's list of specs, replace the line that is today, whole, `    **the spec for this branch**, with` (under the withdraw-invitation spec) with `    (the previous branch: withdrawing a Weave invitation), with`, and directly before the line that begins `  - [superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md]` add:

```markdown
  - [superpowers/specs/2026-10-09-loom-kick-participant-design.md](superpowers/specs/2026-10-09-loom-kick-participant-design.md)
    **the spec for this branch**, with
    [superpowers/plans/2026-10-09-loom-kick-participant.md](superpowers/plans/2026-10-09-loom-kick-participant.md)
    beside it. Its quoted texts are binding, byte for byte, and Paw accepted every **(choice)** in it
    as written. It amends the agent-skills spec's §7 (its dated line), which the skill files must
    still equal, and changes no other spec.
```

  - In "## 4. Where to start", in row 6, replace the substring `(all **41** tools,` with `(all **42** tools,`.
  - In "## 5. What we want back", replace the substring `For this branch the withdraw-invitation spec is` with `For this branch the kick-participant spec is`.
  - In "## 6. Questions we would especially like answered", in question 10, replace the substring `Four flows take two Weave` with `Five flows take two Weave`, and on its next line the substring `` a removal from a request's Thread, and `withdrawInvitation`. Is there`` with `` a removal from a request's Thread, `withdrawInvitation`, and `kickParticipant`. Is there``; then replace the questions of "For **this branch** specifically", from the line that begins `13. **Can a withdrawal and a redemption both win?**` through the line that is today, whole, ``    `--thread` missing as exit 2).``, with:

```markdown
13. **Can a pending invitation undo a kick?** The kick withdraws, inside the Weave's lock, every
    invitation into the Weave still pending for the kicked agent, and compares no clock. Find an
    interleaving of `kickParticipant` with `inviteToWeave`, `accept` or `redeemInvitation` that
    leaves an invitation issued before the kick redeemable after it, a kicked row adopted without
    being readmitted, or a deadlock among them or with a removal from a request's Thread.
14. **Is the token refused everywhere?** `resolveCredential` refuses a kicked token, `resolveInWeave`
    a kicked agent's mapping, `joinWeave` its secret path. Find a surface (REST, MCP, the ticket, the
    upgrade, a request's target credential, the WebSocket re-check, a Thread-addressed call) that
    still accepts either after the kick commits, beyond the one in-flight call KNOWN-ISSUES names.
15. **Do the streams close at the kick?** Every stream re-checks its credential before a
    `participant.kicked` is sent, live, replayed or in a recovered gap. Find a path on which the
    kicked participant receives the kick, or anything after it, or on which another reader does not.
16. **Is the authority exactly a keeper's, re-checked?** `assertIsKeeperOf` before anything about the
    participant is read, `assertStillKeeperOf` inside the locks, never oneself, never the Lobby. Find
    a caller that kicks without keepership, a demotion or a kick of the kicker that slips between the
    checks, or an answer that tells a non-keeper whether a participant id exists.
17. **Does every reader say the same thing, and keep the names?** The web line, the export,
    `loom read` and the channel against spec §9.7 and §11; the people list, the composer, `loom info`
    and the export's Participants line leaving kicked participants out or marking them, while every
    old message and system line still names them.
```

- [ ] **Step 8: docs/superpowers/specs/v2-notes.md.** In the entry whose heading is, whole, `### Kicking a participant out of a Weave (Paw, 2026-10-09): spec and plan`, replace that heading with `### Kicking a participant out of a Weave (Paw, 2026-10-09): built`, and after the entry's last paragraph (the one that begins `It is the keeper-side half of the entry`) add, with an empty line before it:

```markdown
**Built** by the kick-participant slice on `feat/kick-participant`
([spec](2026-10-09-loom-kick-participant-design.md), [plan](../plans/2026-10-09-loom-kick-participant.md)):
a keeper kicks a participant out of a Weave (REST, MCP `kick_participant`, `loom kick`, the web's
Kick with a confirmation); its token and an agent key's identity there are refused, its streams
close, the kicked agent's pending invitations into the Weave are withdrawn, and only a keeper's new
invitation readmits it. Migration 0010. Smoke test 13 kicks ChatGPT-Work out of Loom development
after the deploy.
```

  The controller adds the implementation PR's number to that paragraph when it opens the PR (HANDBOOK §3 step 11).

- [ ] **Step 9: Build, typecheck and run everything, serially, from a clean build**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every package passes, with no stray output. If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop. Record per package (tests and files) and overall in the ledger, beside Task 0's baseline. The expected movement, for the controller to check against (the run's figures are the record, not these): core +28 tests and +1 file (`kick.test.ts` 26, `units.test.ts` 1, `db.test.ts` 1), server +6 (`routes.test.ts` 2, `ws.test.ts` 3, `mcp.test.ts` 1; the repaired catalog case adds none), client +2 (`client.test.ts` 1, `stream.test.ts` 1), mcp-tools +4 (`tools.test.ts` 3, `skills.test.ts` 1; the repaired and renamed cases add none), claude-channel +7 (`format.test.ts` 2, `streams.test.ts` 4, `backend.test.ts` 1; the repaired `channel.test.ts` case adds none), cli +3, web +12 (`components.test.tsx` 7, `session.test.ts` 4, `fold.test.ts` 1): **+62 tests and +1 file**, so from 2473 in 80 to **2535 in 81** if Task 0's baseline matched TESTING.md. A difference is reported in the ledger with its reason, never smoothed.

- [ ] **Step 10: The checks the branch must pass whole**
  - `git diff --stat origin/main -- src/web/src/styles.css` prints nothing, and `git diff --stat origin/main -- src/core/drizzle` lists exactly the 0010 `.sql`, `meta/0010_snapshot.json` and `meta/_journal.json`.
  - `git ls-files --eol skills src/core/drizzle` shows every row starting `i/lf    w/lf`.
  - `git diff origin/main | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"` prints `scan clean`.
  - `git diff --stat origin/main` shows no `Bin` row.
  - The words check: `git diff origin/main -- src skills | node -e "let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && /\b(ban|banned|evict|evicted|expel)\b/i.test(l)); console.log(hits.length ? 'CHECK:\n' + hits.join('\n') : 'words clean'); });"`: it prints `words clean` (the feature's word is "kick"; "removed" appears only in Paw's sentence and in the untouched Thread-level removal).

- [ ] **Step 11: The totals in TESTING.md.** These are measured values, written in from Step 9's record; nothing is estimated. In "## Current totals":
  - Replace the opening words of the first paragraph, `As of **the withdraw-invitation slice** on`, with `Before it, as of **the withdraw-invitation slice** on`.
  - Directly before that paragraph, after the heading and its empty line, add one paragraph in the house shape, built from the ledger: the slice's name and branch (`the kick-participant slice` on `feat/kick-participant`), the head it was measured at, the total and each package's tests and files in the order core, web, server, claude-channel, cli, client, mcp-tools, the three commands it came from (`pnpm -r build`, `pnpm -r typecheck` (clean), `pnpm --workspace-concurrency=1 -r test`), Task 0's baseline (its sha, total and files), and what the slice added, by package and by file, as Step 9 recorded it. The paragraph that begins `As of **the withdraw-invitation slice** on `feat/withdraw-invitation`` in today's file is the model to copy the shape from.

- [ ] **Step 12: The totals in REVIEW-BRIEF.md.** In §5, in these three lines

```text
  Postgres testcontainer or a reachable compose Postgres). Give the totals you saw; on this branch
  they should be **2473 tests in 80 files** (core 781/32, web 982/17, server 247/10,
  claude-channel 152/9, cli 89/5, client 51/4, mcp-tools 171/3), with `pnpm -r typecheck` clean.
```

  keep the first line as it is and write Step 9's figures into the other two, in the same order and the same `tests/files` form per package.

- [ ] **Step 13: Commit**

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md docs/KNOWN-ISSUES.md docs/TESTING.md CLAUDE.md docs/HANDBOOK.md docs/REVIEW-BRIEF.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs: kicking a participant out of a Weave; smoke test 13; the totals" -m "ARCHITECTURE, SECURITY (a §5 row, three amended rows, the Lobby-event paragraph, §9 item 4 rewritten without its em dash), KNOWN-ISSUES (three rows, the export row amended), v2-notes and the review brief as spec section 15 lists; TESTING gains smoke test 13, the coverage lines and the serial run measured on the branch against Task 0's baseline, and CLAUDE.md and HANDBOOK count thirteen smoke tests." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

**After this task (controller, not an implementer):** the whole-branch review (HANDBOOK §3 step 10), its fix wave, then the PR (step 11), whose number the controller adds to the v2-notes paragraph of Step 8. **After the merge, on Paw's word for that PR:** `deploy\live-update.cmd` applies 0010 (it stops Loom for a few seconds; run it in a background shell that survives, and check health right after, HANDOFF's deploy lesson); then `git -C D:/git/Loom pull` and `pnpm -r build` in `D:/git/Loom` (the live CLI runs from `dist`, which a pull leaves stale); then smoke test 13 with Paw, one step at a time, which kicks ChatGPT-Work out of Loom development. Then remove the worktree: `git -C D:/git/Loom worktree remove D:/git/worktrees/Loom-kick-participant`, `git -C D:/git/Loom worktree prune`, delete the merged branch, and check `git -C D:/git/Loom worktree list`.

---
## Decisions this plan makes (for the controller to confirm with Paw)

1. **Task split.** Eleven tasks (0 to 10) against the spec's nine-task sketch: its tasks 1 to 8 map one to one onto Tasks 1 to 8, and its task 9 (skills, documentation, KNOWN-ISSUES, smoke test 13) is split into the skills (9) and the cross-cutting docs with the serial run and the totals (10), as the previous slice did. Each package's README is updated in its own package's task; the cross-cutting docs wait for Task 10 because they describe surfaces that exist only once every adapter is in.
2. **Each core test sits in the task whose code turns it green**, so every case is RED first: the kick, its authority, its withdrawals and their race with a redemption, a human's rejoin (`name_taken` holds as soon as a kicked row keeps its name), a kicked keeper's recorded authority (the role change), an accepted agent and the secrets scan are Task 1's; the repeat (whose second half needs readmission), the refusals, readmission, the `inviteToWeave` races (each has a branch that readmits), the export and the mentions are Task 2's.
3. **"The token is refused on every path" resolves the token for each call.** Spec §16.1 lists the facade's `getWeave`, `readEvents`, `inbox`, `postMessage`, `createThread`, `markRead`, `readPositions`, `exportWeave` and an `openRequest` target credential; the facade takes an `Actor`, which every adapter makes with `resolveCredential` (`requireActor`, `CoreToolBackend.actor`, the ticket, the upgrade, a target credential). The case therefore calls `core.resolveCredential(token)` before each of those calls, so each refusal is the one an adapter meets, and checks `last_seen_at` stays null. A resolved `Actor` held from before the kick is the in-flight window of spec §4.5, not a path.
4. **The Lobby must exist for a kick.** Spec §4.2 step 3 reads it with `getLobby`, which answers `weave_not_found` before the first boot, as `withdrawInvitation` already does; every booted instance has one. Test files whose server never creates one call `ensureLobby()` in the new cases, appended at each file's end so no earlier case sees the extra Weave.
5. **`ws.test.ts` gets a second server, in a `describe` of its own at the end of the file.** The file's server re-checks every 50 ms, which would close a kicked stream on its own and hide whether the forced re-check acts; spec §16.2 asks for an `authTtlMs` long enough that only the forced re-check can. Its `freshDb()` truncates the database the file shares, which is safe only because no case of the file's own server runs after it.
6. **The forced re-check also covers a recovered gap.** Spec §8.1 names `deliver` and the replay loop; `deliver`'s gap recovery sends events read from the database too, and a kick inside a gap would otherwise be sent without a re-check. `sendRead` re-checks only a `participant.kicked`, so every other event is sent exactly as before.
7. **Rewritten lines lose their em dashes, replaced by colons.** The `get_weave` description's Lobby sentence (Task 5) changes from an em dash to a colon beside the spec's new sentence; nothing pins that text. The same holds for the `**Participants**` and `src/participants.ts` lines of the core README, the `**Messages**` line of the client README, the `**Weaves**` line of the mcp-tools README and SECURITY §9 item 4.
8. **The README lines the spec names are placed as follows.** `src/mcp-tools/README.md`'s "Weave tools line" is its `**Weaves**` line, which also gets `get_weave`'s note; its "registers all 41 tools" becomes 42. `src/client/README.md`'s "participants line" is the `**Participants**` part of its `**Messages**` line. `README.md`'s "CLI paragraph" is a new paragraph after the Thread commands and their MCP tools, before "### The Lobby", carrying the spec's words "`loom kick <participantId>` takes a participant out of the Weave (keepers)". `src/cli/README.md` also gets the `info` row's `Kicked:` (spec §9.6).
9. **The Kick control's markup.** `KickControl` is a `<span class="kick-control">` holding either the button or the `<span class="kick-confirm">`, so both hooks the spec names exist; the buttons reuse `btn btn-xs`. Only the confirming button is disabled while the kick is in flight, as the spec says; Cancel stays enabled. No CSS.
10. **`present(participants)` is exported from `session.ts`** and is the one rule for "who is here", read by the people list, its count and the composer (spec §6). It keeps a participant whose `kickedAt` is falsy, so an answer without the field (an older server) lists everyone, as today.
11. **`canKick()` is `mayManageInvitations(state)`** (the spec's own choice), and the DOM tests gate on that real function rather than on a stub, as the previous slice's panel tests do.
12. **The channel's drop.** It runs only for a `LoomClientError` whose code is `forbidden`, from the stream's terminal close or from `start`'s metadata read; it is a no-op unless the Weave's active entry is still the one that failed; the refused token is the entry's own (`Active.token`, the one its reader was made with), captured before anything awaits; the state forgets the Weave only while the stored token equals it (`removeWeaveIfToken`, inside the mutation, so against the newest commit). When another session sharing the state has stored a replacement, the entry and every session's cursor and preferences stand, nothing is notified, and the stream is restarted with the replacement from this session's own cursor, because nothing else tells this process the token changed (a restart from the cached state would retry the refused token); a replacement refused in turn is then dropped the ordinary way, so there is no loop. A failing `removeWeaveIfToken` or `notify` is logged rather than thrown. The notification's meta values go through `format.ts`'s `safe`, now exported, as every other notification's do.
13. **Core's shared words are constants**: `REMOVED_FROM_WEAVE` (`actors.ts`, also used by `joinWeave`'s longer message) and `KICKED_TARGET` (`participants.ts`, also used by `invites.ts`). `withdrawPending` is a private helper of `participants.ts`; the withdrawn rows are sorted in JavaScript by `created_at`, then id, as spec §4.6 says, for a stable event order only.
14. **ARCHITECTURE edits beyond the spec's list**, for accuracy: the lock-order paragraph names `kickParticipant` among the two-row flows, the Lobby-types paragraph says a kick's withdrawal of a request's invitation lands on the request's Thread, and the participant token row says a keeper may kick. REVIEW-BRIEF question 10 counts five two-row flows.
15. **Readmission's answer.** `alreadyJoined` is `!!mine && !mine.kickedAt`: false for a readmitted participant (spec §7.5 step 3), unchanged otherwise. The readmitted row is re-read by `returning()`, so the answer carries the new token and the cleared `kickedAt`.
16. **Beyond the spec's list**, each in the task named: the authority matrix also checks the facade's "Join the Weave first" for a key with no participant in the Weave (1); the pending-invitation case also redeems with the Lobby token (1); the readmission case also checks the old token, `forbidden` while kicked and `invalid_token` after the readmission (no row holds it any more), and the new one resolving (2); the names case also checks the JSON export's `kickedAt` (2); the client case also checks `getWeave` lists the kicked participant (4); the CLI also checks a member's refusal (7); the channel's `invalid_token` case pins the backoff the spec keeps, and its `shouldWake` case pins that no rule is added (6), so both pass at once by design.
17. **The web's kicked-tab cases use an id target with a stored token.** A tab reading with the Weave secret (a `/w/<secret>` target) is not refused by a kick and keeps reading, which is today's behaviour and spec §19's honest limit.
18. **Smoke test 13 says to run `pnpm -r build` after pulling `main`** before the live CLI is used (the HANDOFF's lesson: the CLI runs from `dist`), and the controller's after-merge steps say the same.
19. **The migration's stamp.** If the machine's clock reads earlier than 0009's `when` when `drizzle-kit generate` runs, Task 1 stops and reports rather than editing the stamp (CONTRIBUTING: the hash is recorded beside it).

## Where the code made the spec's words need a reading

- Spec §16.1 tests the token's refusal "from the facade's" calls, but the facade takes an `Actor`; resolution is the adapters' first step (Decision 3).
- Spec §4.2 step 3 needs the Lobby, which test servers that never boot do not create (Decision 4).
- Spec §16.2 asks `ws.test.ts` for a long `authTtlMs`, but the file's one server is configured at 50 ms (Decision 5).
- Spec §8.1 names `deliver` and the replay loop; the gap recovery inside `deliver` is a third send site (Decision 6).
- Spec §9.4's sentence lands in a `get_weave` description line that carries an em dash; spec §9.3 and §9.4's README lines carry them too (Decision 7).
- Nothing else in the spec contradicts `origin/main` at `5eccd5a`: every function, type, message and file it names exists as it says, `shouldWake` needs no case (the `wake: "all"` fallback already wakes a Weave event), `toPublicParticipant` is the only builder of `PublicParticipant`, and `redeemInvitation` adopts by the invitation's `invitee_agent_id` for a Lobby-token redemption exactly as spec §4.6 reads it.

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §16.1 a keeper kicks a member | 1 |
| §16.1 the authority matrix | 1 |
| §16.1 nobody kicks itself | 1 |
| §16.1 a keeper demoted after its credential was resolved is refused inside the lock | 1 |
| §16.1 the Lobby is refused | 1 |
| §16.1 unknown, malformed and another Weave's participant; a malformed weaveId | 1 |
| §16.1 an archived Weave: the kick still works | 1 |
| §16.1 a repeat is idempotent (with the invitation issued between, and the second kick) | 2 |
| §16.1 the token is refused on every path | 2 |
| §16.1 the agent key is refused in that Weave only | 2 |
| §16.1 rejoining with the secret is refused for that agent (lookup and race) | 2 |
| §16.1 a keeper's invitation readmits the same identity (and the Lobby-token redemption) | 2 |
| §16.1 an invitation pending at the kick is withdrawn by it, whatever its timestamp | 1 |
| §16.1 an invitation issued after the kick readmits | 2 |
| §16.1 the kick announces each withdrawal to its invitee | 1 |
| §16.1 a participant with no agent withdraws nothing | 1 |
| §16.1 a kick racing inviteToWeave (started together; each order forced once) | 2 (two cases) |
| §16.1 a kick racing redeemInvitation | 1 |
| §16.1 a human rejoins only under a new name | 1 |
| §16.1 names still resolve | 2 |
| §16.1 mentions skip a kicked participant | 2 |
| §16.1 invite_participant and set_role refuse a kicked participant | 2 |
| §16.1 a kicked keeper loses its recorded authority | 1 |
| §16.1 an accepted agent kicked from the work Weave | 1 |
| §16.1 no kick event carries a secret or a token | 1 |
| §16.1 `units.test.ts`: EVENT_TYPES holds the type after participant.role_changed | 1 |
| §16.1 `migration-status.test.ts`: the existing migration case runs over 0010 | 1 (unchanged case) |
| §16.1 `db.test.ts`: participants.kicked_at exists and is nullable | 1 |
| §16.2 `routes.test.ts`: kick 200 created true, then created false with the same seq; a member 403; the Lobby 400; self 400 | 3 |
| §16.2 `routes.test.ts`: the kicked token on GET /api/weaves/:id 403 with the message; ws-ticket 403 | 3 |
| §16.2 `ws.test.ts`: the kicked stream closes with 4401 and never receives the kick; the keeper's receives it | 3 |
| §16.2 `ws.test.ts`: a stream replaying across a kick closes there | 3 |
| §16.2 `ws.test.ts`: an agent-key stream of a kicked agent closes | 3 |
| §16.2 `mcp.test.ts`: kick_participant over /mcp with an agent key that keeps the Weave; the tool list includes it; the kicked agent's get_weave is forbidden | 5 |
| §16.3 `kickParticipant` round-trips both created values | 4 |
| §16.3 `stream.test.ts`: a kicked stream reports closed with forbidden and does not reconnect again | 4 |
| §16.4 `tools.test.ts`: LOOM_TOOL_NAMES holds kick_participant after set_role | 5 |
| §16.4 `tools.test.ts`: its description as §9.4; get_weave's new sentence | 5 |
| §16.4 `tools.test.ts`: the arguments passed to the backend unchanged | 5 |
| §16.4 `skills.test.ts`: the guard passes over the edited files | 9 |
| §16.4 `skills.test.ts`: the skills carry the edits of spec 2026-10-09 §13 | 9 |
| §16.5 `loom kick`: the line, the withdrew tail, a repeat, `--json` | 7 |
| §16.5 a member's `loom kick` exits non-zero with the forbidden message | 7 |
| §16.5 `loom info` lists the kicked participant under Kicked: and not under Participants:; `loom read` renders the line | 7 |
| §16.6 `format.test.ts`: the line of §11.3 | 6 |
| §16.6 `format.test.ts`: shouldWake in wake all, not in mentions mode | 6 |
| §16.6 `streams.test.ts`: forbidden on the stream's close drops, notifies once, does not restart | 6 |
| §16.6 `streams.test.ts`: the same when the restart's getWeave answers forbidden | 6 |
| §16.6 `streams.test.ts`: invalid_token still restarts with backoff | 6 |
| §16.6 `streams.test.ts`: a replacement token another session stored is kept with its cursors and preferences, the stream restarts with it, nothing is notified | 6 |
| §16.6 `channel.test.ts`: the pinned instructions substring and the sentence | 6 |
| §16.6 `backend.test.ts`: kickParticipant with credential stored reaches that Weave's token | 5 |
| §16.7 `components.test.tsx`: systemLine renders the line of §11.1 | 8 |
| §16.7 `components.test.tsx`: the people list leaves out a kicked participant and its count drops | 8 |
| §16.7 `components.test.tsx`: the composer never offers a kicked name | 8 |
| §16.7 `components.test.tsx`: Kick on others' rows for a keeper, never its own, never a member, a link reader or the Lobby, and in an archived Weave | 8 |
| §16.7 `components.test.tsx`: pressing Kick shows the confirmation and calls nothing; Cancel restores the row | 8 |
| §16.7 `components.test.tsx`: confirming calls session.kick once and disables the confirm button while in flight | 8 |
| §16.7 `components.test.tsx`: a refused kick shows its message on the error bar and returns the row to idle | 8 |
| §16.7 `session.test.ts`: kick marks the participant kicked from the answer and schedules a refresh | 8 |
| §16.7 `session.test.ts`: a participant.kicked event schedules a refresh | 8 |
| §16.7 `session.test.ts`: a kicked tab invalidates the identity, keeps the secret, reloads read-only, does not retry the token | 8 |
| §16.7 `session.test.ts`: with no stored secret it settles at no-credential | 8 |
| §16.7 `fold.test.ts`: runSummary counts the type in its word | 8 |
| §17 smoke test 13 (written into TESTING.md; run with Paw after the deploy) | 10 |

Every spec section is covered: §1 and §2 (the Goal and the Global Constraints), §3 (Task 1: the column, the role change, the timestamp, the `revokedAt` comment), §4 (1), §5.1 and §5.2 (1; the client's union in 4), §5.3 (1: no inbox arm; 6: the channel's wake), §6 (1: the shape; 2: the mentions and the export; 7: `loom info`; 8: the web's lists), §7.1 to §7.4 (2; the ticket and the upgrade through §7.2, tested in 3), §7.5 and §7.6 (2), §8.1 (3), §8.2 (8), §8.3 (6), §8.4 (7: unchanged, the store keeps the token), §9.1 (1), §9.2 (3), §9.3 (4), §9.4 (5), §9.5 to §9.7 (7), §10 (1: the accepted agent and the recorded authority), §11.1 (8), §11.2 (2), §11.3 (6), §12 (8), §13 (9), §14 (1 and 2: every message verbatim), §15 (each package's README in its task, the rest in 10), §16 (above), §17 (10), §18 (this plan's split, Decision 1), §19 (1 and 2: the refusals, the withdrawals, the new token, the secrets scan; 10: SECURITY and KNOWN-ISSUES), §20 (10: REVIEW-BRIEF's promises).
