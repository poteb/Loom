# Loom: withdrawing a Weave invitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A keeper of a Weave (or the instance keeper token) sees the invitations still pending into it and withdraws a direct, unredeemed one: `revoked_at` is set, one `weave.invitation_withdrawn` lands in the Lobby's General Thread addressed to the invitee, and a later redemption answers `forbidden` "This invitation was withdrawn". Surfaces: core, REST, the client, MCP (`list_invitations`, `withdraw_invitation`), the channel, the CLI (`loom invite-weave list`, `loom invite-weave withdraw <invitationId>`), the web (a keeper's "Pending invitations" panel and the Thread line), the export, the skills.

**Architecture:** Core gains `listInvitations` (a read, keepers of the target only) and `withdrawInvitation` (the authority of `inviteToWeave` exactly: `assertIsKeeperOf`, then `withWeaveLocks` Lobby then target, `assertStillKeeperOf`, the row `FOR UPDATE`) in `src/core/src/lobby/invitations.ts`, one event type at the end of `EVENT_TYPES`, one `inbox` arm, one export line and two facade methods. No migration: the existing `weave_invitations.revoked_at` column is the withdrawal, and every public shape calls it `withdrawnAt`. Every other package is an adapter: two REST routes, two client wrappers, two MCP tools and their backend methods, a `REACTION_TABLE` row, the channel's wake rule and texts, two CLI subcommands and a `read` line, and on the web a session read and action, a panel and a Thread line. Behaviour only on the web: no CSS.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), pnpm 10 workspace, Node 24, Vitest 4 against a real Postgres 17 testcontainer (`fileParallelism: false`; mcp-tools with no database), drizzle-orm 0.45.2 on postgres-js 3.4.9, zod 4.6.1, Hono 4, commander 15.0.0, Preact with happy-dom for the DOM tests. **No `package.json` gains a dependency anywhere in this plan.**

**Spec:** `docs/superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md`, approved by Paw on 2026-10-08 with every **(choice)** accepted as written (PR #60). Read it whole before any task; it is the binding requirement text, and every text it quotes (messages, payloads, tool descriptions, the reaction table row, the skill edits, the channel `type=` list, the Thread lines, the CLI lines) is transcribed into this plan byte for byte, never paraphrased. The spec's **(choice)** marks are requirements. Where this plan decides something the spec leaves open, or where the code made the spec's words need a reading, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `D:/git/Loom/.superpowers/sdd/2026-10-08-loom-withdraw-invitation/progress.md`.

**Execution:** subagent-driven, as Paw's standing rule says (HANDBOOK §4): the controller dispatches **one fresh Opus subagent per task** (`model: "opus"`, `run_in_background: true`) on the feature branch `feat/withdraw-invitation` in the worktree `D:/git/worktrees/Loom-withdraw-invitation`, then an Opus reviewer per task, and reads every diff itself before the next dispatch. Never inline.

**Base:** branch `feat/withdraw-invitation` off `origin/main` **after the docs PR carrying the spec and this plan (PR #60) merges**. From `main` this plan consumes, unchanged unless a task says otherwise: `inviteToWeave`, `redeemInvitation`, `invitationRowAndEvent` (`src/core/src/lobby/invitations.ts`); `removeParticipant`, `lastRemovalSeq`, `RemovalResult` (`src/core/src/removals.ts`); `withWeaveLock`, `withWeaveLocks`, `NewEvent`, `readEvents` (`src/core/src/events.ts`); `actorId`, `assertIsKeeperOf`, `assertStillKeeperOf`, `resolveCredential`, `resolveInWeave` (`src/core/src/actors.ts`); `getLobby`, `lobbyGeneralThreadId`, `ensureLobby`, `joinLobby` (`src/core/src/lobby/lobby.ts`); `EVENT_TYPES`, `EventType`, `LoomEvent`, `Actor` (`src/core/src/types.ts`); `errors` (`src/core/src/errors.ts`); `isUuid` (`src/core/src/ids.ts`); `inbox` (`src/core/src/inbox.ts`); `exportWeave` (`src/core/src/export.ts`); `onboardingFacts` (`src/core/src/lobby/onboarding.ts`); `setRole` (`src/core/src/participants.ts`); `openRequest`, `offer`, `accept` (`src/core/src/lobby/requests.ts`); the facade `createCore` (`src/core/src/index.ts`); `freshDb`, `closeTestDb`, `keeperToken` (`src/core/test/helpers.ts`); in `src/core/test/lobby-invitations.test.ts` `setup`, `Fixture`, `TARGET_TITLE`, `invitationRow`, `lobbyEvents`, `targetEvents`, `targetParticipants`; in `src/core/test/lobby-onboarding.test.ts` `core`, `listener`, `host`; in `src/core/test/units.test.ts` `NAMED`; `weaveRoutes` (`src/server/src/routes/weaves.ts`); `CoreToolBackend` (`src/server/src/mcp/backend.ts`); `startTestServer`, `api` (`src/server/test/helpers.ts`); in `src/server/test/lobby-routes.test.ts` `scenario`, `Scenario`, `openRequest`, `s`; in `src/server/test/mcp.test.ts` `json`, `withClient`, and in `describe("listener onboarding over remote MCP")` `fresh`, `mint`, `agentClient`; `LoomClient` (`src/client/src/client.ts`), `EventType`, `InvitationResult` (`src/client/src/types.ts`); in `src/client/test/client.test.ts` `lobby` (inside `describe("Lobby wrappers")`); `LOOM_TOOL_NAMES`, `registerLoomTools` (`src/mcp-tools/src/tools.ts`); `LoomToolBackend` (`src/mcp-tools/src/backend.ts`); `REACTION_TABLE` (`src/mcp-tools/src/onboarding.ts`); in `src/mcp-tools/test/tools.test.ts` `fake`, `calls`, `client`, `text`, `described`, `LOBBY_TOOLS`; in `src/mcp-tools/test/onboarding.test.ts` `TABLE`, `profiled`, `corpus`; in `src/mcp-tools/test/skills.test.ts` `FIELD_NAMES`, `group`, the drift guard's `skills`; `ClientToolBackend` (`src/claude-channel/src/backend.ts`), `withStoredCredential` (`src/claude-channel/src/stored.ts`), `formatEvent`, `shouldWake` (`src/claude-channel/src/format.ts`), `INSTRUCTIONS` (`src/claude-channel/src/server.ts`); in `src/claude-channel/test/format.test.ts` `ev`, `weave`, `names`; in `src/claude-channel/test/backend.test.ts` `makeState`, `WEAVE_ID`; in `src/claude-channel/test/channel.test.ts` `withChannel`, `stateDir`; `registerRequestCommands`, `hhmm` (`src/cli/src/commands/request.ts`), `formatEvent` (`src/cli/src/commands/messages.ts`), `CliError` (`src/cli/src/context.ts`), `emit` (`src/cli/src/output.ts`); in `src/cli/test/lobby.test.ts` `run`, `scenario`, `open`, `hhmm`, `newCfg`, `uniq`, `lobbyWeaveId`; `createSession`, `Session`, `SessionState`, `scheduleRefresh`, `refreshInfo`, `doLoad`, `writer`, `messageOf`, `countReads` (`src/web/src/session.ts`); `createCounter` (`src/web/src/side-reads.ts`, already imported by `session.ts`); `WeaveView` (`src/web/src/components/WeaveView.tsx`); `systemLine` (`src/web/src/components/MessageList.tsx`); `WORDS`, `runSummary` (`src/web/src/components/fold.ts`); in `src/web/test/session.test.ts` `s`, `anon`, `waitFor`, `makeGate`, `sideReadClient`, `onCall`, `always`, `parks`, `parksThen`, `delivering`, `afterDelivery`, `refuses`, `BROKEN`; in `src/web/test/components.test.tsx` `me`, `state`, `session`, `lobbyState`; in `src/web/test/fold.test.ts` `ev`.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/withdraw-invitation`, worktree `D:/git/worktrees/Loom-withdraw-invitation`. **All git worktrees go under `D:/git/worktrees`, never inside the repo** (no `.claude/worktrees`, no `.worktrees`). One commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 8 is done and the whole-branch review (HANDBOOK §3 step 10) has run. The controller dispatches every implementer and reviewer **in the background** (`run_in_background: true`, `model: "opus"`), and reads every diff itself before the next dispatch.
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, skill files, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that sentence; a rewritten sentence loses it. A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Never write a backslash-u escape** (a backslash, the letter u and four hex digits) into a file: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row.
- **The scan, before every commit.** After staging, run exactly this from the worktree root; it must print `scan clean`. It looks at added lines only, for the two mojibake openers (U+00C2, and U+00E2 followed by U+20AC) and the em dash, built with `String.fromCharCode` so this plan does not contain them:

```bash
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
```

- **Never run `vitest list`** (it once overwrote test files). Run tests with `npx vitest run <files>` inside the package, or the scripts below.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test and the rule tested once, in `core`; adapters test wiring. Pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker (core, server, client, cli, claude-channel and web use the testcontainer; mcp-tools does not). **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test across packages:** `pnpm -r build` whenever a task touches more than one package, and before any suite reads another package's change (workspace packages resolve to `dist`; the channel suite spawns `dist/server.js`; the mcp-tools drift guard reads `@loom/core`'s `dist`; the client, cli and web suites start the server from `src/server/test/helpers.ts`, which reaches core through its `dist`). `pnpm -r typecheck` (sources and tests) is green at the end of every task.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.
- **Layering:** every rule lives in `@loom/core` and is tested there once: who may list and withdraw, which rows can be withdrawn, the idempotent answer, the event and its payload (`listInvitations`, `withdrawInvitation`), and who the event reaches (`inbox`). REST and MCP pass strings through with type-only schemas; the client, the CLI, the channel and the web carry words and presentation only.
- **The words.** Every user-facing and API word of this feature is *withdraw* / *withdrawn*: `withdraw_invitation`, `weave.invitation_withdrawn`, `invite-weave withdraw`, the button "Withdraw", `withdrawnBy`, `withdrawnByName`, `withdrawnAt`. Never "cancel" or "revoke" in a new name, message, description, line or skill text (Paw, 2026-10-08). The column `weave_invitations.revoked_at` and its drizzle name `revokedAt` keep their names, inside core only.
- **No migration.** `git diff --stat origin/main -- src/core/drizzle` prints nothing at the end of every task.
- **Error codes:** the fixed set only. **No new code.** The new messages are verbatim:
  - core, not found: `No such invitation in this Weave` (`not_found`)
  - core, a request's: `This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)` (`validation`)
  - core, redeemed: `This invitation was already redeemed: take the participant off the Thread with remove_participant instead` (`validation`)
  - CLI: `invite-weave <participantId> needs --thread <id>` (`CliError` `validation`, exit 2)
  - reused, unchanged: `Only a keeper of this Weave can do this`, `Join the Weave first` (`forbidden`), `This invitation was withdrawn` (`forbidden`, `redeemInvitation`), `Weave not found` (`weave_not_found`).
- **Values:** `EVENT_TYPES` gains `"weave.invitation_withdrawn"` directly after `"weave.invited"`, as its last entry; the event lands on the Lobby's General Thread with actor `actorId(actor)` and payload exactly `{ invitationId, participantId, targetWeaveTitle, withdrawnBy, withdrawnByName }`; `withdrawnByName` is the participant actor's name, or `Keeper` for `keeper:<id>`; the idempotent answer's seq is the newest `weave.invitation_withdrawn` naming the id in the Lobby log, `0` when none; `LOOM_TOOL_NAMES` gains `"list_invitations", "withdraw_invitation"` directly after `"invite_to_weave"` (41 names).
- **Visual design is Paw's separate design session.** The web task adds behaviour, text and class hooks only (`nav-section invitations` as the spec names it, `invitation-list` and `invitation` inside it, and the existing `btn btn-xs`, `muted`, `error`, `nav-head`, `sec`); **no CSS**, no `styles.css` edit.
- **`skills/** text eol=lf`** (`.gitattributes`, unchanged): every file under `skills/` is LF in the working tree. Check with `git ls-files --eol skills` before committing Task 7: every row starts `i/lf    w/lf`.
- **CRLF working copies.** On Paw's machine the working copies of the docs and of many sources are CRLF (git normalises them on add). Every edit below replaces or follows one exact line or substring: match one line at a time, never a multi-line block, unless a task's script reads the file as LF itself.
- **The known ripples.** A new list entry reaches exact assertions elsewhere. Each is repaired **only by adding what the new rule gives**, never by loosening an assertion, and each repaired test is named in the commit body. The ones known at plan time are listed in the task that causes them (Task 1: `units.test.ts` "EVENT_TYPES holds every type the EventType union named..."; Task 3: `tools.test.ts` "advertises the ten Lobby tools and nothing else new", "LOOM_TOOL_NAMES has the four new names, and the registered tools equal it", "LOOM_TOOL_NAMES has get_skill: 39 names", the `fake` backend, and `onboarding.test.ts`' `TABLE`; `mcp.test.ts` "serves the tool catalog without connection-level auth"; Task 4: `channel.test.ts` "the instructions list the onboarding and removal types"; Task 6: the `session()` fake of `components.test.tsx`; Task 7: `skills.test.ts` "the skills carry the four edits of spec 2026-09-30 §8.3" and the `FIELD_NAMES` entry of `invitationId`). A red case of any other shape is a finding and stops the task.
- **Shared test databases.** The server, client, cli, channel and web suites share one database (and one Lobby) per file. Every new fixture takes fresh names (`uniq`, a counter, or the file's own tag), and a test never relies on the Lobby holding only its own participants or events.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/types.ts` (modify) | `"weave.invitation_withdrawn"` at the end of `EVENT_TYPES` |
| `src/core/src/lobby/invitations.ts` (modify) | `PendingInvitation`, `listInvitations`, `WithdrawResult`, `WithdrawOptions`, `withdrawInvitation` and their three messages |
| `src/core/src/db/schema.ts` (modify) | the `revokedAt` comment (spec §3) |
| `src/core/src/inbox.ts` (modify) | the `weave.invited` arm takes the new type too; the doc comment |
| `src/core/src/index.ts` (modify) | the facade's `listInvitations` and `withdrawInvitation`; the type exports |
| `src/core/src/export.ts` (modify) | the Markdown line of `weave.invitation_withdrawn` |
| `src/core/test/lobby-invitations.test.ts`, `lobby-onboarding.test.ts`, `units.test.ts`, `export.test.ts` (modify) | spec §13.1 |
| `src/core/README.md` (modify) | the Invitations line and the `lobby/invitations.ts` line |
| `src/server/src/routes/weaves.ts` (modify) | `GET /api/weaves/:id/invitations`, `POST /api/weaves/:id/invitations/:invitationId/withdraw` |
| `src/server/test/lobby-routes.test.ts` (modify) | spec §13.2, REST |
| `src/client/src/types.ts`, `src/client/src/client.ts` (modify) | `PendingInvitation`, `WithdrawResult`, the `EventType` member; `listInvitations`, `withdrawInvitation` |
| `src/client/test/client.test.ts` (modify) | spec §13.3 |
| `src/server/README.md`, `src/client/README.md` (modify) | the two route rows; the Invitations line |
| `src/mcp-tools/src/tools.ts`, `src/mcp-tools/src/backend.ts`, `src/mcp-tools/src/onboarding.ts` (modify) | the two names and tools; the two `LoomToolBackend` methods; the `REACTION_TABLE` row |
| `src/server/src/mcp/backend.ts`, `src/claude-channel/src/backend.ts`, `src/claude-channel/src/stored.ts` (modify) | the two backend methods over core, over the client, and with the stored credential |
| `src/mcp-tools/test/tools.test.ts`, `onboarding.test.ts`; `src/server/test/mcp.test.ts`; `src/claude-channel/test/backend.test.ts` (modify) | spec §13.4, §13.2 MCP, §13.6 backend |
| `src/mcp-tools/README.md` (modify) | the Lobby line |
| `src/claude-channel/src/format.ts`, `src/claude-channel/src/server.ts` (modify) | `shouldWake` and the two texts; the instructions' `type=` list and `invitation=` sentence |
| `src/claude-channel/test/format.test.ts`, `channel.test.ts` (modify); `src/claude-channel/README.md` (modify) | spec §13.6; the wake list |
| `src/cli/src/commands/request.ts`, `src/cli/src/commands/messages.ts` (modify) | `invite-weave list`, `invite-weave withdraw`, `--thread` optional; the `read` line |
| `src/cli/test/lobby.test.ts` (modify); `src/cli/README.md`, `README.md` (modify) | spec §13.5; the command rows and the sentence |
| `src/web/src/session.ts` (modify) | `SessionState.invitations` and `invitationsError`, `mayManageInvitations`, the read, `canManageInvitations`, `withdrawInvitation` |
| `src/web/src/components/InvitationsPanel.tsx` (new) | the Pending invitations section |
| `src/web/src/components/WeaveView.tsx`, `MessageList.tsx`, `fold.ts` (modify) | the panel in the sidebar; the Thread line; the folded words |
| `src/web/test/components.test.tsx`, `session.test.ts`, `fold.test.ts` (modify) | spec §13.7 |
| `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-ask-for-review/SKILL.md`, `skills/loom-do-accepted-work/SKILL.md` (modify) | the edits of spec §10 |
| `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (modify) | the dated amendment line and the same edits in §7.1, §7.2, §7.4 |
| `src/mcp-tools/test/skills.test.ts` (modify) | spec §13.4 skills |
| `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/KNOWN-ISSUES.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §12, §14 (Task 8) |

**Why nine tasks (0 to 8).** Each carries its own test cycle and could be rejected alone. Core (1) holds the whole rule with its event, its addressing and its export line, because a reviewer judging "who may withdraw what, what is written, who is told" wants them in one diff. REST and the client (2) are one surface: the client's wrappers are only testable against the routes, and its `EventType` member must exist before the channel and the web switch on it. MCP (3) changes `LoomToolBackend`, so every implementer of it (the server's, the channel's two and the test fake) must change in the same commit for `pnpm -r typecheck` to stay green; `REACTION_TABLE` rides with it because it is the same package and the same agent-facing text. The channel's wake and texts (4), the CLI (5) and the web (6) are separate readers. The skills (7) need the registered tools and the event type for the drift guard. The cross-cutting docs, smoke test 12 and the measured totals close (8); each package's README is in its own package's task.

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git -C D:/git/Loom fetch origin && git -C D:/git/Loom log origin/main --oneline -5` shows the squash commit of PR #60, and `git -C D:/git/Loom show origin/main:docs/superpowers/plans/2026-10-08-loom-withdraw-invitation.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Create the worktree and the branch, outside the repo:

```bash
cd D:/git/Loom
git worktree add D:/git/worktrees/Loom-withdraw-invitation -b feat/withdraw-invitation origin/main
cd D:/git/worktrees/Loom-withdraw-invitation
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Confirm the code this plan was written against is still there, from the worktree root: `node -e "console.log(require('./src/core/drizzle/meta/_journal.json').entries.at(-1).tag)"` prints `0009_zippy_quicksilver`; `grep -c '  "weave.invited",' src/core/src/types.ts` prints `1`; `grep -c "weave.invitation_withdrawn" src/core/src/types.ts` prints `0`; `grep -c "export async function inviteToWeave" src/core/src/lobby/invitations.ts` prints `1`; `grep -c '"cancel_request", "list_requests", "get_request", "invite_to_weave",' src/mcp-tools/src/tools.ts` prints `1`; `grep -c '.requiredOption("--thread <id>", "Thread of the target Weave they are invited into")' src/cli/src/commands/request.ts` prints `1`; `grep -c '|listener.removed|request.offer_withdrawn" from=' src/claude-channel/src/server.ts` prints `1`; `ls src/web/src/components/InvitationsPanel.tsx` fails. If any differs, stop and report: someone has reshaped the code since the spec was written.
- [ ] Confirm the ledger folder is ignored: `git -C D:/git/Loom check-ignore -v .superpowers` prints a rule. If it prints nothing, stop and report (the folder holds real secrets; HANDBOOK §5).
- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. TESTING.md "Current totals" records **2423 tests in 80 files** after the offline-removal slice (core 761/32, web 968/17, server 244/10, claude-channel 149/9, cli 85/5, client 50/4, mcp-tools 166/3). Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `D:/git/Loom/.superpowers/sdd/2026-10-08-loom-withdraw-invitation/progress.md` (create the folder). Task 8 compares against that record and must not estimate. If the figures differ from TESTING.md's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---

### Task 1: core: `withdrawInvitation`, `listInvitations`, the event, its inbox arm and its export line

Spec §3 to §6, §7.1, §8.3, §16. **This task carries the seventeen `lobby-invitations.test.ts` cases, the `lobby-onboarding.test.ts` case, the `units.test.ts` case and the `export.test.ts` case of spec §13.1.**

**Files:**
- Modify: `src/core/src/types.ts` (`EVENT_TYPES`)
- Modify: `src/core/src/lobby/invitations.ts` (the two import lines; the new types and functions after `inviteToWeave`)
- Modify: `src/core/src/db/schema.ts` (the comment above `revokedAt`)
- Modify: `src/core/src/inbox.ts` (the doc comment; the `weave.invited` arm)
- Modify: `src/core/src/index.ts` (the facade, after `inviteToWeave`; the `lobby/invitations.js` type export)
- Modify: `src/core/src/export.ts` (one `sys` arm)
- Modify: `src/core/README.md`
- Test: `src/core/test/lobby-invitations.test.ts`, `src/core/test/lobby-onboarding.test.ts`, `src/core/test/units.test.ts`, `src/core/test/export.test.ts`

**Interfaces:**
- Consumes: `getLobby(db)`, `lobbyGeneralThreadId(q, lobbyId)`, `withWeaveLocks(db, bus, [a, b], fn)` (its `fn` returns `{ result, events: Record<weaveId, NewEvent[]> }`), `assertIsKeeperOf(actor, weaveId)`, `assertStillKeeperOf(tx, actor, weaveId)`, `actorId(actor)`, `isUuid(s)`, `errors.notFound(msg)`, `errors.validation(msg)`, `errors.weaveNotFound()`, `resolveInWeave(db, actor, weaveId)`.
- Produces:

```ts
// src/core/src/types.ts: EVENT_TYPES ends "weave.invited", "weave.invitation_withdrawn"
// weave.invitation_withdrawn payload: { invitationId: string; participantId: string; targetWeaveTitle: string; withdrawnBy: string; withdrawnByName: string }

// src/core/src/lobby/invitations.ts
export type PendingInvitation = { invitationId: string; participantId: string; inviteeName: string; targetThreadId: string;
  targetThreadName: string; createdAt: string; createdBy: string; createdByName: string | null; requestId: string | null };
export async function listInvitations(db: Db, actor: Actor, targetWeaveId: string): Promise<PendingInvitation[]>;
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };
export type WithdrawOptions = { beforeLock?: () => Promise<void> };
export async function withdrawInvitation(db: Db, bus: EventBus, actor: Actor, targetWeaveId: string, invitationId: string, opts?: WithdrawOptions): Promise<WithdrawResult>;

// the facade (createCore)
listInvitations: (actor: Actor, targetWeaveId: string) => Promise<PendingInvitation[]>;
withdrawInvitation: (actor: Actor, targetWeaveId: string, invitationId: string) => Promise<WithdrawResult>;
// @loom/core exports the types PendingInvitation, WithdrawResult, WithdrawOptions
```

- [ ] **Step 1: Write the failing `units.test.ts` case.** In `src/core/test/units.test.ts`, inside `describe("EVENT_TYPES (spec 2026-09-28 §10.0)", ...)`, the `NAMED` list's last line (the known ripple: the list the union names gains the new type where §6.2 puts it) is today, whole, `    "weave.invited",`. Replace it with:

```ts
    "weave.invited", "weave.invitation_withdrawn",
```

and after that `describe`'s case `EVENT_TYPES holds listener.removed after participant.capabilities_changed and request.offer_withdrawn after request.offered (spec 2026-09-30 §5.4)` add:

```ts
  it("EVENT_TYPES holds weave.invitation_withdrawn directly after weave.invited, as its last entry (spec 2026-10-08 §6.2)", () => {
    const at = (t: string) => (EVENT_TYPES as readonly string[]).indexOf(t);
    expect([at("weave.invitation_withdrawn") - at("weave.invited"), at("weave.invitation_withdrawn")]).toEqual([1, EVENT_TYPES.length - 1]);
  });
```

- [ ] **Step 2: Write the failing `lobby-invitations.test.ts` cases.** In `src/core/test/lobby-invitations.test.ts`, replace the import line `import { inviteToWeave, redeemInvitation } from "../src/lobby/invitations.js";` with:

```ts
import { inviteToWeave, listInvitations, redeemInvitation, withdrawInvitation } from "../src/lobby/invitations.js";
import { inbox } from "../src/inbox.js";
import { setRole } from "../src/participants.js";
```

Then append at the end of the file:

```ts
const REQUEST_REFUSAL = "This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)";
const REDEEMED_REFUSAL = "This invitation was already redeemed: take the participant off the Thread with remove_participant instead";
const KEEPERS_ONLY = "Only a keeper of this Weave can do this";

/** Paw, keeper of the target, invites a Lobby participant straight into the PR Thread: a direct invitation. */
const direct = (f: Fixture, participantId = f.helper.id) =>
  inviteToWeave(db, bus, f.paw, participantId, f.target.weave.id, f.prThread.id);
/** A request Helper opened into the target, with Other's offer accepted: one invitation that belongs to it. */
async function requestInvitation(f: Fixture, title = "Review PR 14") {
  await setCapabilities(db, bus, f.other.actor, { owner: "paw", serves: "anyone" });
  const request = await openRequest(db, bus, f.helper.actor, f.paw, {
    title, requirements: {}, wanted: 1, targetWeaveId: f.target.weave.id, targetThreadId: f.prThread.id, url: null,
  });
  await offer(db, bus, f.other.actor, request.id, {});
  const { invitationIds } = await accept(db, bus, f.helper.actor, request.id, [f.other.id], { deadlineMs: 3_600_000 });
  return { request, invitationId: invitationIds[0]! };
}
/** A second Weave with a keeper of its own, Kay: a keeper, but not of the target. */
async function elsewhere() {
  const w = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Kay", kind: "human" } });
  const kay: Actor = { kind: "participant", participant: w.participant };
  return { weaveId: w.weave.id, kay, thread: await createThread(db, bus, kay, w.weave.id, "Side") };
}
const withdrawals = async (f: Fixture): Promise<LoomEvent[]> =>
  (await lobbyEvents(f)).filter((e) => e.type === "weave.invitation_withdrawn");

describe("withdrawInvitation", () => {
  it("a keeper of the target withdraws a direct invitation: revoked_at set, one event on the Lobby's General, nothing in the target", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    const targetBefore = (await targetEvents(f)).length;
    const r = await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const row = await invitationRow(invitationId);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ redeemedAt: null, redeemedParticipantId: null, requestId: null, createdBy: f.pawId });
    const all = await withdrawals(f);
    expect(all).toHaveLength(1);
    const event = all[0]!;
    expect(r).toEqual({ invitationId, seq: event.seq, withdrawnAt: row.revokedAt!.toISOString(), created: true });
    expect(event.threadId).toBe(await lobbyGeneralThreadId(db, f.lobbyId));
    expect(event.actor).toBe(f.pawId);
    expect(event.payload).toEqual({ invitationId, participantId: f.helper.id, targetWeaveTitle: TARGET_TITLE, withdrawnBy: f.pawId, withdrawnByName: "Paw" });
    expect((await targetEvents(f)).length).toBe(targetBefore);
  });

  it("the authority matrix: the target's keeper and the instance keeper withdraw; everyone else is refused and nothing is written", async () => {
    const f = await setup();
    const other = await elsewhere();
    const secret = await resolveCredential(db, f.target.secret);
    const { invitationId } = await direct(f);
    const refused: [Actor, string][] = [
      [f.targetMember, KEEPERS_ONLY], [other.kay, KEEPERS_ONLY],
      [f.helper.actor, KEEPERS_ONLY],               // the invitee itself, a Lobby participant
      [f.other.actor, KEEPERS_ONLY], [secret, KEEPERS_ONLY],
      [f.helper.keyActor, "Join the Weave first"],   // a raw agent key, never resolved into the target
    ];
    for (const [actor, message] of refused) {
      await expect(withdrawInvitation(db, bus, actor, f.target.weave.id, invitationId)).rejects.toMatchObject({ code: "forbidden", message });
    }
    expect((await invitationRow(invitationId)).revokedAt).toBeNull();
    expect(await withdrawals(f)).toEqual([]);

    expect((await withdrawInvitation(db, bus, f.instanceKeeper, f.target.weave.id, invitationId)).created).toBe(true);
    const keeperId = f.instanceKeeper.kind === "keeper" ? f.instanceKeeper.keeperId : "";
    expect((await withdrawals(f))[0]).toMatchObject({ actor: `keeper:${keeperId}`, payload: { withdrawnBy: `keeper:${keeperId}`, withdrawnByName: "Keeper" } });

    // Through the facade an agent key stands for the participant it owns in the target: a keeper there.
    const core = createCore(db);
    const own = await core.createWeave({ title: "Helper's Weave", opener: "", creator: { name: "HelperHost", kind: "agent" } }, f.helper.keyActor);
    const work = await core.createThread(f.helper.keyActor, own.weave.id, "Work");
    const viaKey = await core.inviteToWeave(f.helper.keyActor, f.other.id, own.weave.id, work.id);
    expect((await core.withdrawInvitation(f.helper.keyActor, own.weave.id, viaKey.invitationId)).created).toBe(true);
    // A key with no participant in the target is told to join first, by resolveInWeave.
    await expect(core.withdrawInvitation(f.helper.keyActor, f.target.weave.id, invitationId))
      .rejects.toMatchObject({ code: "forbidden", message: "Join the Weave first" });
  });

  it("a keeper demoted after its credential was resolved is refused inside the lock, and the row is unchanged", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId, {
      beforeLock: async () => { await setRole(db, bus, f.instanceKeeper, f.target.weave.id, f.pawId, "member"); },
    })).rejects.toMatchObject({ code: "forbidden", message: KEEPERS_ONLY });
    expect((await invitationRow(invitationId)).revokedAt).toBeNull();
    expect(await withdrawals(f)).toEqual([]);
  });

  it("a request's invitation is refused, whatever its state, and nothing is written", async () => {
    const f = await setup();
    const pending = await requestInvitation(f);
    // A second request whose accepted agent was then removed from its Thread: the removal withdrew it.
    const removed = await requestInvitation(f, "Review PR 15");
    await removeParticipant(db, bus, f.helper.actor, removed.request.threadId, f.other.id);
    expect((await invitationRow(removed.invitationId)).revokedAt).toBeInstanceOf(Date);
    const before = await lobbyEvents(f);
    for (const id of [pending.invitationId, removed.invitationId]) {
      await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, id)).rejects.toMatchObject({ code: "validation", message: REQUEST_REFUSAL });
    }
    expect((await invitationRow(pending.invitationId)).revokedAt).toBeNull();
    expect(await lobbyEvents(f)).toEqual(before);
  });

  it("a redeemed invitation is refused, and the row is unchanged", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" });
    const before = await invitationRow(invitationId);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).rejects.toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
    expect(await invitationRow(invitationId)).toEqual(before);
    expect(await withdrawals(f)).toEqual([]);
  });

  it("an unknown, malformed or other Weave's invitation, and the Lobby as target, answer not_found; a malformed target is weave_not_found", async () => {
    const f = await setup();
    const other = await elsewhere();
    const theirs = await inviteToWeave(db, bus, other.kay, f.helper.id, other.weaveId, other.thread.id);
    const notFound = { code: "not_found", message: "No such invitation in this Weave" };
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, "nope")).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, theirs.invitationId)).rejects.toMatchObject(notFound);
    // The instance keeper passes the authority check for any Weave, so this reaches the Lobby rule.
    await expect(withdrawInvitation(db, bus, f.instanceKeeper, f.lobbyId, theirs.invitationId)).rejects.toMatchObject(notFound);
    await expect(withdrawInvitation(db, bus, f.paw, "nope", theirs.invitationId)).rejects.toMatchObject({ code: "weave_not_found" });
    expect((await invitationRow(theirs.invitationId)).revokedAt).toBeNull();
  });

  it("a repeat is idempotent: created false, the first call's seq and withdrawnAt, and still one event", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    const first = await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    expect(await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).toEqual({ ...first, created: false });
    expect((await withdrawals(f)).map((e) => e.payload.invitationId)).toEqual([invitationId]);
  });

  it("redeeming after a withdrawal is refused, whichever credential tries, and no participant is created in the target", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const before = (await targetParticipants(f)).length;
    for (const actor of [f.helper.actor, f.helper.keyActor]) {
      await expect(redeemInvitation(db, bus, actor, invitationId, { kind: "agent" }))
        .rejects.toMatchObject({ code: "forbidden", message: "This invitation was withdrawn" });
    }
    expect((await targetParticipants(f)).length).toBe(before);
  });

  it("withdraw racing redeem: a redemption that commits first wins, and the withdrawal writes nothing", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await expect(withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId, {
      beforeLock: async () => { await redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }); },
    })).rejects.toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
    const row = await invitationRow(invitationId);
    expect([row.redeemedAt instanceof Date, row.revokedAt]).toEqual([true, null]);
    expect(await withdrawals(f)).toEqual([]);
  });

  it("withdraw racing redeem: in twenty rounds exactly one wins each time, and the other answers its own refusal", async () => {
    const f = await setup();
    for (let round = 0; round < 20; round++) {
      const { invitationId } = await direct(f);
      const [w, r] = await Promise.allSettled([
        withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId),
        redeemInvitation(db, bus, f.helper.actor, invitationId, { kind: "agent" }),
      ]);
      expect([w.status, r.status].sort()).toEqual(["fulfilled", "rejected"]);
      if (w.status === "rejected") expect(w.reason).toMatchObject({ code: "validation", message: REDEEMED_REFUSAL });
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "forbidden", message: "This invitation was withdrawn" });
      const row = await invitationRow(invitationId);
      expect([row.redeemedAt !== null, row.revokedAt !== null].filter((set) => set)).toHaveLength(1);
    }
  });

  it("an archived target Weave: the withdrawal still works and is announced", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    expect((await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId)).created).toBe(true);
    expect((await withdrawals(f)).map((e) => e.payload.invitationId)).toEqual([invitationId]);
  });

  it("no withdrawal event carries a secret or a token", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, invitationId);
    const secrets = [
      f.helper.key, keeperToken("k"),
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((w) => w.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const log = await lobbyEvents(f);
    expect(log.map((e) => e.type)).toContain("weave.invitation_withdrawn");
    for (const e of log) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });

  it("the inbox: the invitee's Lobby inbox carries the withdrawal; another Lobby participant's and the withdrawing keeper's do not", async () => {
    const f = await setup();
    const first = await direct(f);                        // Paw invites Helper
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, first.invitationId);
    // Helper keeps a Weave of its own and stands in the Lobby: as the withdrawing keeper it is not told.
    const core = createCore(db);
    const own = await core.createWeave({ title: "Helper's Weave", opener: "", creator: { name: "HelperHost", kind: "agent" } }, f.helper.keyActor);
    const work = await core.createThread(f.helper.keyActor, own.weave.id, "Work");
    const second = await core.inviteToWeave(f.helper.keyActor, f.other.id, own.weave.id, work.id);
    await core.withdrawInvitation(f.helper.keyActor, own.weave.id, second.invitationId);
    const withdrawn = async (actor: Actor) => (await inbox(db, actor, f.lobbyId, {}))
      .filter((e) => e.type === "weave.invitation_withdrawn").map((e) => e.payload.invitationId);
    expect(await withdrawn(f.helper.actor)).toEqual([first.invitationId]);
    expect(await withdrawn(f.other.actor)).toEqual([second.invitationId]);
  });
});

describe("listInvitations", () => {
  it("lists what is pending, oldest first, with every field; redeemed and withdrawn ones are left out", async () => {
    const f = await setup();
    const directOne = await direct(f);
    const viaRequest = await requestInvitation(f);
    const redeemed = await direct(f, f.other.id);
    await redeemInvitation(db, bus, f.other.actor, redeemed.invitationId, { kind: "agent" });
    const withdrawn = await direct(f);
    await withdrawInvitation(db, bus, f.paw, f.target.weave.id, withdrawn.invitationId);
    // Each row's created_at is its transaction's now(), and the database clock can step backwards
    // (KNOWN-ISSUES, the wall-clock created_at row). Pinned, and against insertion order.
    const pin = (id: string, at: string) => db.update(weaveInvitations).set({ createdAt: new Date(at) }).where(eq(weaveInvitations.id, id));
    await pin(directOne.invitationId, "2026-09-27T10:00:00.000Z");
    await pin(viaRequest.invitationId, "2026-09-27T09:00:00.000Z");
    expect(await listInvitations(db, f.paw, f.target.weave.id)).toEqual([
      { invitationId: viaRequest.invitationId, participantId: f.other.id, inviteeName: "Other", targetThreadId: f.prThread.id,
        targetThreadName: "PR 14", createdAt: "2026-09-27T09:00:00.000Z", createdBy: f.helper.id, createdByName: "Helper",
        requestId: viaRequest.request.id },
      { invitationId: directOne.invitationId, participantId: f.helper.id, inviteeName: "Helper", targetThreadId: f.prThread.id,
        targetThreadName: "PR 14", createdAt: "2026-09-27T10:00:00.000Z", createdBy: f.pawId, createdByName: "Paw", requestId: null },
    ]);
  });

  it("resolves createdByName: the inviting keeper's name in the target, the requester's Lobby name, Keeper, and null for a principal no row resolves", async () => {
    const f = await setup();
    const byPaw = await direct(f);
    const viaRequest = await requestInvitation(f);
    const byKeeper = await inviteToWeave(db, bus, f.instanceKeeper, f.other.id, f.target.weave.id, f.prThread.id);
    const orphan = await direct(f);
    await db.update(weaveInvitations).set({ createdBy: "00000000-0000-4000-8000-000000000000" }).where(eq(weaveInvitations.id, orphan.invitationId));
    const names = new Map((await listInvitations(db, f.paw, f.target.weave.id)).map((i) => [i.invitationId, i.createdByName]));
    expect([byPaw, viaRequest, byKeeper, orphan].map((i) => names.get(i.invitationId))).toEqual(["Paw", "Helper", "Keeper", null]);
  });

  it("authority: a keeper and the instance keeper read it; a member, another Weave's keeper and a Lobby participant are forbidden; an unknown Weave is weave_not_found", async () => {
    const f = await setup();
    await direct(f);
    const other = await elsewhere();
    expect(await listInvitations(db, f.paw, f.target.weave.id)).toHaveLength(1);
    expect(await listInvitations(db, f.instanceKeeper, f.target.weave.id)).toHaveLength(1);
    for (const actor of [f.targetMember, other.kay, f.helper.actor]) {
      await expect(listInvitations(db, actor, f.target.weave.id)).rejects.toMatchObject({ code: "forbidden", message: KEEPERS_ONLY });
    }
    await expect(listInvitations(db, f.instanceKeeper, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(listInvitations(db, f.paw, "nope")).rejects.toMatchObject({ code: "weave_not_found" });
  });

  it("an archived Weave still lists its pending rows", async () => {
    const f = await setup();
    const { invitationId } = await direct(f);
    await archiveWeave(db, bus, f.paw, f.target.weave.id);
    expect((await listInvitations(db, f.paw, f.target.weave.id)).map((i) => i.invitationId)).toEqual([invitationId]);
  });
});
```

- [ ] **Step 3: Write the failing `lobby-onboarding.test.ts` case.** In `src/core/test/lobby-onboarding.test.ts`, at the end of `describe("onboardingFacts", ...)` (after the case `me.removed is null again after set_capabilities, both with a profile and with null`) add:

```ts
  it("get_started forgets a withdrawn invitation (spec 2026-10-08 §4.6)", async () => {
    const l = await listener();
    const kept = await host("Alpha");
    const invited = await core.inviteToWeave(kept.actor, l.id, kept.weaveId, kept.threadId);
    expect((await core.onboardingFacts(l.agent)).invitations).toEqual([{ inviteId: invited.invitationId, weaveTitle: "Alpha", requestId: null }]);
    await core.withdrawInvitation(kept.actor, kept.weaveId, invited.invitationId);
    expect((await core.onboardingFacts(l.agent)).invitations).toEqual([]);
  });
```

- [ ] **Step 4: Write the failing `export.test.ts` case.** In `src/core/test/export.test.ts`, after the import line `import { sweepOfflineListeners } from "../src/lobby/removal.js";` add:

```ts
import { inviteToWeave, withdrawInvitation } from "../src/lobby/invitations.js";
```

and inside `describe("exportWeave", ...)`, directly before the case `rejects bad format and foreign credential`, add:

```ts
  it("renders weave.invitation_withdrawn as a system line in the web's words (spec 2026-10-08 §8.3)", async () => {
    const lobby = await ensureLobby(db);
    const reader = await resolveCredential(db, lobby.secret);
    const target = await createWeave(db, bus, { title: "Loom development", opener: "hi", creator: { name: "Claude-Code", kind: "agent" } });
    const keeper = await resolveCredential(db, target.token);
    const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
    const invitee = await joinLobby(db, bus, { name: "Claude-Work", kind: "agent" });
    const { invitationId } = await inviteToWeave(db, bus, keeper, invitee.participant.id, target.weave.id, thread.id);
    await withdrawInvitation(db, bus, keeper, target.weave.id, invitationId);
    const md = await exportWeave(db, reader, lobby.weaveId, "md");
    expect(md).toContain('_system: invitation to "Loom development" for Claude-Work withdrawn by Claude-Code_');
    expect(md).not.toContain("_system: weave.invitation_withdrawn_");
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/units.test.ts test/lobby-invitations.test.ts test/lobby-onboarding.test.ts test/export.test.ts`
Expected: FAIL. `units.test.ts`: the `NAMED` case (EVENT_TYPES lacks the type) and the new position case; `lobby-invitations.test.ts` and `export.test.ts`: the whole file, `does not provide an export named 'listInvitations'` (or `withdrawInvitation`); `lobby-onboarding.test.ts`: the new case, `core.withdrawInvitation is not a function`. Capture this output for the report.

- [ ] **Step 6: The event type.** In `src/core/src/types.ts`, replace the `EVENT_TYPES` line that is today, whole, `  "weave.invited",` with:

```ts
  "weave.invited", "weave.invitation_withdrawn",
```

- [ ] **Step 7: `listInvitations` and `withdrawInvitation`.** In `src/core/src/lobby/invitations.ts`, replace the two import lines `import { and, eq } from "drizzle-orm";` and `import { participants, requests, threads, weaveInvitations } from "../db/schema.js";` with:

```ts
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { events, participants, requests, threads, weaveInvitations, weaves } from "../db/schema.js";
```

Then directly after `inviteToWeave`'s closing `}` (the function ends with the lines `    return { result: { invitationId, seq: lobby.lastSeq + 1 }, events: { [lobbyId]: [event] } };`, `  });`, `}`), and before the `/**` that opens the doc comment beginning ` * Redeems an invitation: the invitee lands in the target Weave with the Thread invite that says`, insert, with an empty line on each side:

```ts
/** One invitation into a Weave that is neither redeemed nor withdrawn (spec 2026-10-08 §5.1). */
export type PendingInvitation = {
  invitationId: string;
  /** The invitee's Lobby participant. */
  participantId: string;
  /** Its Lobby name. */
  inviteeName: string;
  targetThreadId: string;
  targetThreadName: string;
  /** ISO. */
  createdAt: string;
  /** The recorded principal, as stored: a participant id or `keeper:<id>`. */
  createdBy: string;
  /** `Keeper` for an instance keeper, the participant's name for a uuid a row resolves, else null. */
  createdByName: string | null;
  /** Null for a direct invitation, the only kind that can be withdrawn. */
  requestId: string | null;
};

/**
 * The invitations into `targetWeaveId` still pending (spec 2026-10-08 §5): neither redeemed nor
 * withdrawn, oldest first. Keepers of that Weave and the instance keeper only. A request's
 * invitations are listed with their `requestId`, so a keeper sees every way in that is still open;
 * an archived Weave or a closed Thread hides no row, since each is still withdrawable. A read: no
 * lock, no event.
 */
export async function listInvitations(db: Db, actor: Actor, targetWeaveId: string): Promise<PendingInvitation[]> {
  if (!isUuid(targetWeaveId)) throw errors.weaveNotFound();
  assertIsKeeperOf(actor, targetWeaveId);
  const [target] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.id, targetWeaveId));
  if (!target) throw errors.weaveNotFound();
  const rows = await db.select({
    invitationId: weaveInvitations.id, participantId: weaveInvitations.inviteeParticipantId, inviteeName: participants.name,
    targetThreadId: weaveInvitations.targetThreadId, targetThreadName: threads.name, createdAt: weaveInvitations.createdAt,
    createdBy: weaveInvitations.createdBy, requestId: weaveInvitations.requestId,
  })
    .from(weaveInvitations)
    .innerJoin(threads, eq(threads.id, weaveInvitations.targetThreadId))
    .innerJoin(participants, eq(participants.id, weaveInvitations.inviteeParticipantId))
    .where(and(eq(weaveInvitations.targetWeaveId, targetWeaveId), isNull(weaveInvitations.redeemedAt), isNull(weaveInvitations.revokedAt)))
    .orderBy(asc(weaveInvitations.createdAt), asc(weaveInvitations.id));
  // One extra read for the page's distinct principals: an inviting keeper lives in the target, a
  // request's requester in the Lobby, and `keeper:<id>` in no participants row at all.
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((id) => isUuid(id)))];
  const named = ids.length > 0
    ? await db.select({ id: participants.id, name: participants.name }).from(participants).where(inArray(participants.id, ids))
    : [];
  const nameOf = new Map(named.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    invitationId: r.invitationId, participantId: r.participantId, inviteeName: r.inviteeName,
    targetThreadId: r.targetThreadId, targetThreadName: r.targetThreadName, createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy, createdByName: r.createdBy.startsWith("keeper:") ? "Keeper" : (nameOf.get(r.createdBy) ?? null),
    requestId: r.requestId ?? null,
  }));
}

/** What a withdrawal answers (spec 2026-10-08 §4.1). `withdrawnAt` is the row's `revoked_at`, ISO. */
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };

export type WithdrawOptions = {
  /** Test seam: runs after the checks made outside the lock and before the locks are taken. */
  beforeLock?: () => Promise<void>;
};

const NO_SUCH_INVITATION = "No such invitation in this Weave";
const BELONGS_TO_REQUEST = "This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)";
const ALREADY_REDEEMED = "This invitation was already redeemed: take the participant off the Thread with remove_participant instead";

/**
 * Withdraws a direct invitation into `targetWeaveId` before it is redeemed (spec 2026-10-08 §4): the
 * row's `revoked_at` is set and the invitee is told with `weave.invitation_withdrawn` on the Lobby's
 * General Thread, beside the `weave.invited` it undoes; a later redemption answers "This invitation
 * was withdrawn". The authority is `inviteToWeave`'s exactly, checked before anything about the
 * invitation is read and again inside the target's lock. A request's invitation is refused (the
 * removal from its Thread withdraws it), and so is a redeemed one; one already withdrawn answers
 * the original withdrawal's seq with `created: false` and writes nothing. An archived target is no
 * obstacle: a withdrawal only removes access.
 *
 * The Lobby's lock, then the target's, then the row `FOR UPDATE`: the order every cross-Weave flow
 * uses. `redeemInvitation` takes the target's lock and then the row, never the Lobby's, so the two
 * are serialised on the target and exactly one of them wins.
 */
export async function withdrawInvitation(
  db: Db, bus: EventBus, actor: Actor, targetWeaveId: string, invitationId: string, opts: WithdrawOptions = {},
): Promise<WithdrawResult> {
  const { weaveId: lobbyId } = await getLobby(db);
  if (!isUuid(targetWeaveId)) throw errors.weaveNotFound();
  // The authority before anything is read about the invitation: a non-keeper learns nothing of the id.
  assertIsKeeperOf(actor, targetWeaveId);
  // No invitation can target the Lobby (inviteToWeave refuses it), and withWeaveLocks must not be
  // asked for the same row twice.
  if (targetWeaveId === lobbyId || !isUuid(invitationId)) throw errors.notFound(NO_SUCH_INVITATION);
  if (opts.beforeLock) await opts.beforeLock();
  return withWeaveLocks<WithdrawResult>(db, bus, [lobbyId, targetWeaveId], async (tx, byId) => {
    const lobby = byId[lobbyId]!;
    const target = byId[targetWeaveId]!;
    // The role the actor carries was captured when its credential was resolved; it may have been
    // taken away since. No archived check (spec §4.3).
    await assertStillKeeperOf(tx, actor, targetWeaveId);
    const [inv] = await tx.select().from(weaveInvitations).where(eq(weaveInvitations.id, invitationId)).for("update");
    if (!inv || inv.targetWeaveId !== targetWeaveId) throw errors.notFound(NO_SUCH_INVITATION);
    // Before the two state checks, so a request's invitation answers the same whatever its state.
    if (inv.requestId !== null) throw errors.validation(BELONGS_TO_REQUEST);
    if (inv.revokedAt) {
      // Only this function withdraws a direct invitation, and always writes its event in the same
      // transaction, so the newest event naming the id is that withdrawal (spec §4.4); 0 when none
      // is found, the "none" value lastRemovalSeq uses.
      const [withdrawal] = await tx.select({ seq: events.seq }).from(events)
        .where(and(eq(events.weaveId, lobbyId), eq(events.type, "weave.invitation_withdrawn"),
          sql`${events.payload}->>'invitationId' = ${invitationId}`))
        .orderBy(desc(events.seq)).limit(1);
      return { result: { invitationId, seq: withdrawal?.seq ?? 0, withdrawnAt: inv.revokedAt.toISOString(), created: false }, events: {} };
    }
    if (inv.redeemedAt) throw errors.validation(ALREADY_REDEEMED);
    const now = new Date();
    await tx.update(weaveInvitations).set({ revokedAt: now }).where(eq(weaveInvitations.id, invitationId));
    const by = actorId(actor);
    // A Lobby reader cannot resolve `by` (a target-Weave id, or keeper:<id>), so the name travels too.
    const byName = actor.kind === "participant" ? actor.participant.name : "Keeper";
    const event: NewEvent = {
      threadId: await lobbyGeneralThreadId(tx, lobbyId), type: "weave.invitation_withdrawn", actor: by,
      payload: { invitationId, participantId: inv.inviteeParticipantId, targetWeaveTitle: target.title, withdrawnBy: by, withdrawnByName: byName },
    };
    return { result: { invitationId, seq: lobby.lastSeq + 1, withdrawnAt: now.toISOString(), created: true }, events: { [lobbyId]: [event] } };
  });
}
```

- [ ] **Step 8: The schema comment (spec §3).** In `src/core/src/db/schema.ts`, in the `weaveInvitations` table, replace the two comment lines `  // Withdrawn by a removal from the request Thread (removals.ts). A revoked invitation cannot be` and `  // redeemed.` with:

```ts
  // Withdrawn: by a removal from the request Thread (removals.ts) for a request's invitation, by
  // `withdrawInvitation` (lobby/invitations.ts) for a direct one. Public shapes call it `withdrawnAt`.
```

- [ ] **Step 9: The inbox arm (spec §6.3).** In `src/core/src/inbox.ts`, replace the three doc-comment lines that run from ` * What is addressed to the acting participant: invites naming it, messages mentioning it and the` to the line ending `excluding its own events, always oldest-first.` (the sentence is rewritten, so its two em dashes go) with:

```ts
 * What is addressed to the acting participant: invites naming it, messages mentioning it and the
 * Lobby events that name it (a request it is eligible for, an offer or a close addressed to it, an
 * acceptance naming it, a cross-Weave invitation naming it, or its withdrawal), excluding its own
 * events, always oldest-first.
```

and replace the arm that is today, whole, ``      and(eq(events.type, "weave.invited"), sql`${events.payload}->>'participantId' = ${me.id}`),`` with:

```ts
      // A cross-Weave invitation, or its withdrawal by a keeper of the target (spec 2026-10-08 §6.3):
      // both name the invitee in `participantId`, and the actor is never its own Lobby id.
      and(inArray(events.type, ["weave.invited", "weave.invitation_withdrawn"]), sql`${events.payload}->>'participantId' = ${me.id}`),
```

- [ ] **Step 10: The facade (spec §7.1).** In `src/core/src/index.ts`, directly after the two lines of the facade's `inviteToWeave` entry (the second is `      invitations.inviteToWeave(db, bus, await resolveInWeave(db, actor, targetWeaveId), participantId, targetWeaveId, targetThreadId),`) add:

```ts
    // The same resolution as inviteToWeave (spec 2026-10-08 §7.1): listing and withdrawing need
    // keepership in the target, so an agent key stands for the participant it owns there.
    listInvitations: async (actor: Actor, targetWeaveId: string) =>
      invitations.listInvitations(db, await resolveInWeave(db, actor, targetWeaveId), targetWeaveId),
    withdrawInvitation: async (actor: Actor, targetWeaveId: string, invitationId: string) =>
      invitations.withdrawInvitation(db, bus, await resolveInWeave(db, actor, targetWeaveId), targetWeaveId, invitationId),
```

and replace the line `export { type InvitationDraft } from "./lobby/invitations.js";` with:

```ts
export { type InvitationDraft, type PendingInvitation, type WithdrawResult, type WithdrawOptions } from "./lobby/invitations.js";
```

- [ ] **Step 11: The export line (spec §8.3).** In `src/core/src/export.ts`, directly before the line `        e.type === "weave.archived" ? "Weave archived" : e.type;` add:

```ts
        // A keeper took back a direct invitation (spec 2026-10-08 §8.3), in the web's words.
        e.type === "weave.invitation_withdrawn" ? `invitation to "${String(e.payload.targetWeaveTitle ?? "")}" for ${nameOf(e.payload.participantId)} withdrawn by ${String(e.payload.withdrawnByName ?? "?")}` :
```

- [ ] **Step 12: Run them to verify they pass**

Run: `cd src/core && npx vitest run test/units.test.ts test/lobby-invitations.test.ts test/lobby-onboarding.test.ts test/export.test.ts`
Expected: PASS, pristine.

- [ ] **Step 13: `src/core/README.md`.** In the line that begins `- **Requests**`, replace everything from `· **Invitations**` to the end of the line (today it reads `· **Invitations**`, a dash, then `` `inviteToWeave`; `joinWeave(…, { inviteId })` redeems one``; the dash is an em dash, which this rewrite drops) with:

```text
· **Invitations**: `inviteToWeave`; `listInvitations` (a keeper's view of the ones still pending into its Weave) and `withdrawInvitation` (takes back a direct one before it is redeemed); `joinWeave(…, { inviteId })` redeems one
```

Then in the line that begins ``- [src/lobby/invitations.ts](src/lobby/invitations.ts)``, replace the substring ``, `redeemInvitation` (single-use, the redeemer must be the invitee)`` with:

```text
, `redeemInvitation` (single-use, the redeemer must be the invitee), `listInvitations` and `withdrawInvitation` (a direct invitation only, under the Lobby then target locks; it writes `weave.invitation_withdrawn`)
```

- [ ] **Step 14: Build, typecheck, then the whole core suite**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. No other package changes in this task, and no other package's suite reads the new type yet.

- [ ] **Step 15: Commit**

```bash
git add src/core/src/types.ts src/core/src/lobby/invitations.ts src/core/src/db/schema.ts src/core/src/inbox.ts src/core/src/index.ts src/core/src/export.ts src/core/README.md src/core/test/units.test.ts src/core/test/lobby-invitations.test.ts src/core/test/lobby-onboarding.test.ts src/core/test/export.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(core): a keeper withdraws a direct Weave invitation, and lists the pending ones" -m "withdrawInvitation sets revoked_at under the Lobby then target locks, with inviteToWeave's authority (assertIsKeeperOf, then assertStillKeeperOf in the lock), refuses a request's invitation and a redeemed one, answers a repeat with the original seq, and writes weave.invitation_withdrawn on the Lobby's General, addressed to the invitee through inbox. listInvitations is a keeper's read of the rows neither redeemed nor withdrawn. The export renders the new line. No migration. Ripple repaired: units.test.ts 'EVENT_TYPES holds every type the EventType union named...' (NAMED gains the type)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 2: server and client: the two routes, the two wrappers, the client's types

Spec §6.2 (the client's `EventType`), §7.2, §7.3, §11. **This task carries the two REST cases of spec §13.2 and the client case of spec §13.3.**

**Files:**
- Modify: `src/server/src/routes/weaves.ts` (two routes after `POST /:id/invitations`)
- Modify: `src/client/src/types.ts` (`EventType`; `PendingInvitation`, `WithdrawResult`)
- Modify: `src/client/src/client.ts` (the type import; two wrappers after `inviteToWeave`)
- Modify: `src/server/README.md`, `src/client/README.md`
- Test: `src/server/test/lobby-routes.test.ts`, `src/client/test/client.test.ts`

**Interfaces:**
- Consumes: Task 1's facade `core.listInvitations(actor, targetWeaveId)` and `core.withdrawInvitation(actor, targetWeaveId, invitationId)`; `requireActor(c, core)`; the client's private `call<T>(method, path, body?)`.
- Produces:

```ts
// REST
// GET  /api/weaves/:id/invitations                       -> 200 { invitations: PendingInvitation[] }
// POST /api/weaves/:id/invitations/:invitationId/withdraw -> 200 WithdrawResult (also on a repeat); no body read

// @loom/client types.ts
export type EventType = ... | "weave.invited" | "weave.invitation_withdrawn";
export type PendingInvitation = { invitationId: string; participantId: string; inviteeName: string; targetThreadId: string;
  targetThreadName: string; createdAt: string; createdBy: string; createdByName: string | null; requestId: string | null };
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };

// LoomClient
listInvitations(weaveId: string): Promise<PendingInvitation[]>;            // unwraps { invitations }
withdrawInvitation(weaveId: string, invitationId: string): Promise<WithdrawResult>;
```

- [ ] **Step 1: Write the failing REST cases.** In `src/server/test/lobby-routes.test.ts`, directly after `describe("POST /api/weaves/:id/invitations", ...)` closes (before `describe("POST /api/weaves/join", ...)`), add:

```ts
describe("pending invitations over REST (spec 2026-10-08 §7.2)", () => {
  /** The target's keeper hands a Lobby participant a direct invitation. */
  const invite = async (f: Scenario, participantId: string): Promise<string> => {
    const r = await api(s.baseUrl, "POST", `/api/weaves/${f.target.weaveId}/invitations`, { participantId, threadId: f.target.threadId }, f.target.keeper);
    expect(r.status).toBe(201);
    return r.json.invitationId as string;
  };
  const withdrawPath = (f: Scenario, invitationId: string) => `/api/weaves/${f.target.weaveId}/invitations/${invitationId}/withdraw`;

  it("GET /api/weaves/:id/invitations answers { invitations } to a keeper, and 403 to a member", async () => {
    const f = await scenario();
    const id = await invite(f, f.pawbot.id);
    const r = await api(s.baseUrl, "GET", `/api/weaves/${f.target.weaveId}/invitations`, undefined, f.target.keeper);
    expect(r.status).toBe(200);
    expect((r.json.invitations as { invitationId: string; participantId: string; requestId: string | null }[])
      .map((i) => [i.invitationId, i.participantId, i.requestId])).toEqual([[id, f.pawbot.id, null]]);
    const member = await api(s.baseUrl, "GET", `/api/weaves/${f.target.weaveId}/invitations`, undefined, f.target.member);
    expect([member.status, member.json.code]).toEqual([403, "forbidden"]);
  });

  it("POST .../withdraw answers 200 created true, then 200 created false with the same seq; a request's invitation 400; an unknown id 404; a non-keeper 403", async () => {
    const f = await scenario();
    const id = await invite(f, f.pawbot.id);
    const first = await api(s.baseUrl, "POST", withdrawPath(f, id), undefined, f.target.keeper);
    expect([first.status, first.json.invitationId, first.json.created]).toEqual([200, id, true]);
    const again = await api(s.baseUrl, "POST", withdrawPath(f, id), undefined, f.target.keeper);
    expect([again.status, again.json]).toEqual([200, { ...first.json, created: false }]);

    const req = await openRequest(f);
    await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "ready" }, f.pawbot.token);
    const accepted = await api(s.baseUrl, "POST", `/api/requests/${req.id}/accept`, { participantIds: [f.pawbot.id], deadlineMs: 3_600_000 }, f.claude.token);
    expect(accepted.status).toBe(200);
    const viaRequest = await api(s.baseUrl, "POST", withdrawPath(f, accepted.json.invitationIds[0] as string), undefined, f.target.keeper);
    expect([viaRequest.status, viaRequest.json.code]).toEqual([400, "validation"]);

    const unknown = await api(s.baseUrl, "POST", withdrawPath(f, "00000000-0000-4000-8000-000000000000"), undefined, f.target.keeper);
    expect([unknown.status, unknown.json.code]).toEqual([404, "not_found"]);

    const second = await invite(f, f.bobbot.id);
    const member = await api(s.baseUrl, "POST", withdrawPath(f, second), undefined, f.target.member);
    expect([member.status, member.json.code]).toEqual([403, "forbidden"]);
  });
});
```

- [ ] **Step 2: Write the failing client case.** In `src/client/test/client.test.ts`, inside `describe("Lobby wrappers", ...)`, directly after the case `invites a Lobby participant into another Weave and redeems it without a secret`, add:

```ts
  it("listInvitations unwraps the array and withdrawInvitation round-trips both created values (spec 2026-10-08 §7.3)", async () => {
    const f = await lobby();
    const inv = await f.keeper.inviteToWeave(f.target.weave.id, f.botId, f.thread.id);
    const listed = await f.keeper.listInvitations(f.target.weave.id);
    expect(listed.map((i) => [i.invitationId, i.participantId, i.inviteeName, i.targetThreadName, i.requestId]))
      .toEqual([[inv.invitationId, f.botId, `Pawbot-${f.t}`, "PR 14", null]]);
    const first = await f.keeper.withdrawInvitation(f.target.weave.id, inv.invitationId);
    expect(first).toMatchObject({ invitationId: inv.invitationId, created: true });
    expect(await f.keeper.withdrawInvitation(f.target.weave.id, inv.invitationId)).toEqual({ ...first, created: false });
    expect(await f.keeper.listInvitations(f.target.weave.id)).toEqual([]);
    await expect(f.bot.listInvitations(f.target.weave.id)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -r build && cd src/server && npx vitest run test/lobby-routes.test.ts && cd ../client && npx vitest run test/client.test.ts`
Expected: FAIL. The server's two new cases answer 404 from Hono's not-found for both routes (the GET case sees `status` 404 where 200 is wanted); the client case fails with `f.keeper.listInvitations is not a function`. Capture this output for the report. (The `&&` stops after the server suite fails; run the client line on its own to capture its RED as well.)

- [ ] **Step 4: The two routes.** In `src/server/src/routes/weaves.ts`, directly after the `r.post("/:id/invitations", ...)` handler (it ends with `    return c.json(await core.inviteToWeave(actor, participantId, c.req.param("id"), threadId), 201);` and `  });`), add:

```ts
  // A keeper's list of the ways into this Weave still open, and the withdrawal of a direct one, as
  // an action route like POST /:id/archive (spec 2026-10-08 §7.2). The withdrawal reads no body and
  // answers 200 on a repeat too: `created` says which.
  r.get("/:id/invitations", async (c) => {
    const actor = await requireActor(c, core);
    return c.json({ invitations: await core.listInvitations(actor, c.req.param("id")) });
  });

  r.post("/:id/invitations/:invitationId/withdraw", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.withdrawInvitation(actor, c.req.param("id"), c.req.param("invitationId")));
  });
```

- [ ] **Step 5: The client's types.** In `src/client/src/types.ts`, replace the `EventType` union's last line, today, whole, `  | "weave.invited";`, with:

```ts
  | "weave.invited" | "weave.invitation_withdrawn";
```

and directly after the line `export type InvitationResult = { invitationId: string; seq: number };` add:

```ts
/** One invitation into a Weave that is neither redeemed nor withdrawn (spec 2026-10-08 §5.1). */
export type PendingInvitation = {
  invitationId: string; participantId: string; inviteeName: string; targetThreadId: string; targetThreadName: string;
  createdAt: string; createdBy: string; createdByName: string | null; requestId: string | null;
};
/** What a withdrawal answers (spec 2026-10-08 §4.1): `created` is false on a repeat, which carries the original seq. */
export type WithdrawResult = { invitationId: string; seq: number; withdrawnAt: string; created: boolean };
```

- [ ] **Step 6: The two wrappers.** In `src/client/src/client.ts`, in the `import type { ... } from "./types.js";` block, replace the line that is today, whole, `  Offer, OpenRequestInput, Participant, Profile, ReadPositions, RemovalResult, RequestStatus, Role, Settings, Thread, Weave,` with:

```ts
  Offer, OpenRequestInput, Participant, PendingInvitation, Profile, ReadPositions, RemovalResult, RequestStatus, Role, Settings, Thread, Weave,
```

and the line that follows it, today, whole, `  WeaveInfo,`, with:

```ts
  WeaveInfo, WithdrawResult,
```

Then directly after the `inviteToWeave` method (it ends with `    return this.call("POST", `/api/weaves/${weaveId}/invitations`, { participantId, threadId });` and `  }`), add:

```ts
  /** A keeper's view of the invitations into `weaveId` not yet redeemed or withdrawn. */
  async listInvitations(weaveId: string): Promise<PendingInvitation[]> {
    const r = await this.call<{ invitations: PendingInvitation[] }>("GET", `/api/weaves/${weaveId}/invitations`);
    return r.invitations;
  }
  /** Withdraws a direct invitation into `weaveId` (keepers). Idempotent: a repeat answers created false. */
  withdrawInvitation(weaveId: string, invitationId: string): Promise<WithdrawResult> {
    return this.call("POST", `/api/weaves/${weaveId}/invitations/${invitationId}/withdraw`);
  }
```

- [ ] **Step 7: Run them to verify they pass**

Run: `pnpm -r build && cd src/server && npx vitest run test/lobby-routes.test.ts && cd ../client && npx vitest run test/client.test.ts`
Expected: PASS, pristine.

- [ ] **Step 8: The two READMEs.** In `src/server/README.md`, directly after the route-table row that is today, whole, ``| POST | `/api/weaves/:id/invitations` | `inviteToWeave` → `{ invitationId, seq }` |``, add:

```markdown
| GET | `/api/weaves/:id/invitations` | `listInvitations` → `{ invitations }`: the ones not yet redeemed or withdrawn (keepers of that Weave) |
| POST | `/api/weaves/:id/invitations/:invitationId/withdraw` | `withdrawInvitation` → `{ invitationId, seq, withdrawnAt, created }`, also on a repeat (`created` false); reads no body |
```

In `src/client/README.md`, in the line that begins `- **Requests**`, replace everything from `· **Invitations**` to the end of the line (today `· **Invitations**`, a dash, then `` `inviteToWeave`, `joinByInvite` ``; the dash is an em dash, which this rewrite drops) with:

```text
· **Invitations**: `inviteToWeave`, `listInvitations` (unwraps `{ invitations }`), `withdrawInvitation` (a repeat answers `created: false`), `joinByInvite`
```

- [ ] **Step 9: Typecheck, then the two suites whole**

Run: `pnpm -r typecheck && cd src/server && npx vitest run && cd ../client && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 10: Commit**

```bash
git add src/server/src/routes/weaves.ts src/server/test/lobby-routes.test.ts src/server/README.md src/client/src/types.ts src/client/src/client.ts src/client/test/client.test.ts src/client/README.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(server,client): list and withdraw a Weave's pending invitations over REST" -m "GET /api/weaves/:id/invitations answers { invitations } and POST /api/weaves/:id/invitations/:invitationId/withdraw answers the WithdrawResult, 200 on a repeat too; both go straight to core. The client gains listInvitations, withdrawInvitation, the PendingInvitation and WithdrawResult types and weave.invitation_withdrawn in EventType." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 3: MCP: `list_invitations`, `withdraw_invitation`, their backends, and the reaction table

Spec §7.4, §13.2 (MCP), §13.4 (tools, onboarding), §13.6 (`backend.test.ts`). **This task carries the three `tools.test.ts` cases, the `onboarding.test.ts` case, the `mcp.test.ts` case and the `backend.test.ts` case.**

**Files:**
- Modify: `src/mcp-tools/src/tools.ts` (`LOOM_TOOL_NAMES`; two registrations after `invite_to_weave`)
- Modify: `src/mcp-tools/src/backend.ts` (`LoomToolBackend`)
- Modify: `src/mcp-tools/src/onboarding.ts` (`REACTION_TABLE`)
- Modify: `src/server/src/mcp/backend.ts` (`CoreToolBackend`)
- Modify: `src/claude-channel/src/backend.ts` (`ClientToolBackend`), `src/claude-channel/src/stored.ts` (`withStoredCredential`)
- Modify: `src/mcp-tools/README.md`
- Test: `src/mcp-tools/test/tools.test.ts`, `src/mcp-tools/test/onboarding.test.ts`, `src/server/test/mcp.test.ts`, `src/claude-channel/test/backend.test.ts`

**Interfaces:**
- Consumes: Task 1's facade methods; Task 2's `LoomClient.listInvitations(weaveId)` and `LoomClient.withdrawInvitation(weaveId, invitationId)`.
- Produces:

```ts
// src/mcp-tools/src/tools.ts: LOOM_TOOL_NAMES gains "list_invitations", "withdraw_invitation" directly after "invite_to_weave" (41 names)
// list_invitations    input { credential, targetWeaveId }                -> the array of PendingInvitation
// withdraw_invitation input { credential, targetWeaveId, invitationId }  -> { invitationId, seq, withdrawnAt, created }

// src/mcp-tools/src/backend.ts, LoomToolBackend, after inviteToWeave
listInvitations(credential: string, targetWeaveId: string): Promise<unknown[]>;                        // PendingInvitation[]
withdrawInvitation(credential: string, targetWeaveId: string, invitationId: string): Promise<unknown>; // { invitationId, seq, withdrawnAt, created }

// src/mcp-tools/src/onboarding.ts: REACTION_TABLE gains, directly after the weave.invited row:
// "| `weave.invitation_withdrawn` naming you | A keeper withdrew that invitation: do not redeem it (`join_weave` refuses it). Nothing else is asked of you. |"
```

- [ ] **Step 1: Write the failing `tools.test.ts` cases, and repair the fixtures.** In `src/mcp-tools/test/tools.test.ts`:
  - In the `fake` backend, directly after its `inviteToWeave` entry (it ends `    return { invitationId: "i1", seq: 3 };` and `  },`), add (the fake must implement the interface Step 6 extends):

```ts
  listInvitations: async (c, targetWeaveId) => { calls.push(["listInvitations", c, targetWeaveId]); return [{ invitationId: "i1", requestId: null }]; },
  withdrawInvitation: async (c, targetWeaveId, invitationId) => {
    calls.push(["withdrawInvitation", c, targetWeaveId, invitationId]);
    return { invitationId, seq: 4, withdrawnAt: "2026-10-08T10:00:00.000Z", created: true };
  },
```

  - In `describe("lobby tools", ...)`, replace the `LOBBY_TOOLS` line that is today, whole, `    "cancel_request", "list_requests", "get_request", "invite_to_weave",` with `    "cancel_request", "list_requests", "get_request", "invite_to_weave", "list_invitations", "withdraw_invitation",`; rename the case `advertises the ten Lobby tools and nothing else new` to `advertises the twelve Lobby tools and nothing else new`, and in it replace `expect(LOOM_TOOL_NAMES).toHaveLength(39);` with `expect(LOOM_TOOL_NAMES).toHaveLength(41);` (a ripple).
  - In the case `LOOM_TOOL_NAMES has the four new names, and the registered tools equal it`, replace `expect(LOOM_TOOL_NAMES).toHaveLength(39);` with `expect(LOOM_TOOL_NAMES).toHaveLength(41);` (a ripple).
  - Rename the case `LOOM_TOOL_NAMES has get_skill: 39 names` to `LOOM_TOOL_NAMES has get_skill: 41 names`, and in it replace `expect(LOOM_TOOL_NAMES).toHaveLength(39);` with `expect(LOOM_TOOL_NAMES).toHaveLength(41);` (a ripple).
  - In `describe("lobby tools", ...)`, directly after the case `invite_to_weave forwards participant, target Weave and thread`, add:

```ts
  it("list_invitations and withdraw_invitation pass their arguments to the backend unchanged and answer what it returns (spec 2026-10-08 §7.4)", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "list_invitations", arguments: { credential: "c", targetWeaveId: "w1" } }))))
      .toEqual([{ invitationId: "i1", requestId: null }]);
    expect(calls.filter((x) => x[0] === "listInvitations").at(-1)).toEqual(["listInvitations", "c", "w1"]);
    expect(JSON.parse(text(await client.callTool({ name: "withdraw_invitation", arguments: { credential: "c", targetWeaveId: "w1", invitationId: "i1" } }))))
      .toEqual({ invitationId: "i1", seq: 4, withdrawnAt: "2026-10-08T10:00:00.000Z", created: true });
    expect(calls.filter((x) => x[0] === "withdrawInvitation").at(-1)).toEqual(["withdrawInvitation", "c", "w1", "i1"]);
  });

  it("LOOM_TOOL_NAMES holds list_invitations and withdraw_invitation directly after invite_to_weave (spec 2026-10-08 §7.4)", () => {
    const at = LOOM_TOOL_NAMES.indexOf("invite_to_weave");
    expect(LOOM_TOOL_NAMES.slice(at, at + 3)).toEqual(["invite_to_weave", "list_invitations", "withdraw_invitation"]);
  });
```

  - At the end of `describe("the tool descriptions are the spec's", ...)` (after the case that begins `keeper_set_settings names removeOfflineListenersAfterMs`), add:

```ts
  it("list_invitations and withdraw_invitation read exactly as the spec gives them (spec 2026-10-08 §7.4)", async () => {
    const d = await described();
    expect(d.get("list_invitations")).toBe("List the invitations into one of your Weaves that are not yet redeemed or withdrawn (keepers of that Weave only). Each carries its invitationId, the invitee's Lobby participantId and name, the target Thread, when and by whom it was made, and its requestId (null for a direct invitation). Only a direct invitation can be withdrawn with withdraw_invitation.");
    expect(d.get("withdraw_invitation")).toBe("Withdraw a direct invitation into one of your Weaves before it is redeemed (keepers of the target Weave only): the invitee is told with weave.invitation_withdrawn and can no longer redeem it. An invitation that belongs to a request is refused: remove the agent from the request's Thread with remove_participant instead. Withdrawing one already withdrawn changes nothing and returns the same seq. Returns { invitationId, seq, withdrawnAt, created }.");
  });
```

- [ ] **Step 2: Write the failing `onboarding.test.ts` case, and repair `TABLE`.** In `src/mcp-tools/test/onboarding.test.ts`, directly above the line `const TABLE = [` add:

```ts
const WITHDRAWN_ROW = "| `weave.invitation_withdrawn` naming you | A keeper withdrew that invitation: do not redeem it (`join_weave` refuses it). Nothing else is asked of you. |";
```

In the `TABLE` constant, directly after its row that begins ``  "| `weave.invited` naming you |`` (the row ends ``you need it to call `complete`. |",``), add (a ripple: `renderState produces the exact texts of spec §4.5` compares `REACTION_TABLE` with `TABLE`):

```ts
  WITHDRAWN_ROW,
```

Then at the end of `describe("renderState", ...)` (after the case that begins `REACTION_TABLE holds the listener.removed row directly after the thread.removed row`) add:

```ts
  it("REACTION_TABLE holds the weave.invitation_withdrawn row directly after the weave.invited row, so state 3 and renderDocument carry it (spec 2026-10-08 §7.4)", () => {
    const rows = REACTION_TABLE.split("\n");
    const at = rows.findIndex((r) => r.startsWith("| `weave.invited` naming you |"));
    expect(rows[at + 1]).toBe(WITHDRAWN_ROW);
    expect(renderState(3, profiled, undefined)).toContain(WITHDRAWN_ROW);
    expect(renderDocument("https://loom.3dbox.dk")).toContain(WITHDRAWN_ROW);
    expect(parseSkill("join-loom", renderDocument("https://loom.3dbox.dk")).name).toBe("join-loom");
  });
```

- [ ] **Step 3: Write the failing `mcp.test.ts` case, and repair the catalog count.** In `src/server/test/mcp.test.ts`, in the case `serves the tool catalog without connection-level auth`, replace `        expect(tools).toHaveLength(39);` with (a ripple):

```ts
        expect(tools).toHaveLength(41);
        expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_invitations", "withdraw_invitation"]));
```

At the end of `describe("listener onboarding over remote MCP", ...)`, after the case `complete and remove_participant round trip with an agent key`, add:

```ts
  it("list_invitations and withdraw_invitation round trip with an agent key that keeps the target Weave (spec 2026-10-08 §13.2)", async () => {
    const keeper = await agentClient(await mint(fresh("Keep")));
    const invitee = await agentClient(await mint(fresh("Inv")));
    try {
      const target = json(await keeper.callTool({ name: "create_weave", arguments: { title: "Loom development", opener: "o", name: fresh("Host") } }));
      const joined = json(await invitee.callTool({ name: "join_lobby", arguments: {} }));
      const invited = json(await keeper.callTool({ name: "invite_to_weave", arguments: {
        participantId: joined.participant.id, targetWeaveId: target.weave.id, threadId: target.generalThread.id,
      } }));
      const listed = json(await keeper.callTool({ name: "list_invitations", arguments: { targetWeaveId: target.weave.id } }));
      expect((listed as { invitationId: string; requestId: string | null }[]).map((i) => [i.invitationId, i.requestId])).toEqual([[invited.invitationId, null]]);
      const args = { targetWeaveId: target.weave.id, invitationId: invited.invitationId };
      const first = json(await keeper.callTool({ name: "withdraw_invitation", arguments: args }));
      expect(first).toMatchObject({ invitationId: invited.invitationId, created: true });
      expect(json(await keeper.callTool({ name: "withdraw_invitation", arguments: args }))).toEqual({ ...first, created: false });
      expect(json(await keeper.callTool({ name: "list_invitations", arguments: { targetWeaveId: target.weave.id } }))).toEqual([]);
      const refused = await invitee.callTool({ name: "withdraw_invitation", arguments: args });
      expect(refused.isError).toBe(true);
      expect(json(refused)).toMatchObject({ code: "forbidden" });
    } finally {
      await Promise.all([keeper.close().catch(() => {}), invitee.close().catch(() => {})]);
    }
  });
```

- [ ] **Step 4: Write the failing `backend.test.ts` case.** In `src/claude-channel/test/backend.test.ts`, after the import line `import { ClientToolBackend } from "../src/backend.js";` add:

```ts
import { withStoredCredential } from "../src/stored.js";
```

and at the end of the file add:

```ts
describe("the two invitation tools with the stored credential (spec 2026-10-08 §7.4)", () => {
  it("list_invitations and withdraw_invitation with credential stored reach the target Weave's own token", async () => {
    const state = makeState();
    await state.upsertWeave(WEAVE_ID, { title: "Design review", token: "stored-token", participantId: "p2", participantName: "Claude", generalThreadId: "g1", wake: "all", lastSeq: 7 });
    const tokens: string[] = [];
    const answer = { invitationId: "i1", seq: 5, withdrawnAt: "2026-10-08T10:00:00.000Z", created: true };
    const fake = {
      withToken: (t: string): unknown => { tokens.push(t); return fake; },
      listInvitations: vi.fn(async () => []),
      withdrawInvitation: vi.fn(async () => answer),
    };
    const backend = withStoredCredential(new ClientToolBackend(fake as unknown as LoomClient, state, { onJoined: vi.fn() }), state, () => undefined);
    expect(await backend.listInvitations("stored", WEAVE_ID)).toEqual([]);
    expect(await backend.withdrawInvitation("stored", WEAVE_ID, "i1")).toEqual(answer);
    expect(tokens).toEqual(["stored-token", "stored-token"]);
    expect(fake.listInvitations).toHaveBeenCalledWith(WEAVE_ID);
    expect(fake.withdrawInvitation).toHaveBeenCalledWith(WEAVE_ID, "i1");
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd src/mcp-tools && npx vitest run test/tools.test.ts test/onboarding.test.ts`
Expected: FAIL. `tools.test.ts`: the three repaired count cases (39 against 41), `advertises the twelve Lobby tools`, the pass-through case (`Tool list_invitations not found` in the tool error), the position case and the descriptions case; `onboarding.test.ts`: `renderState produces the exact texts of spec §4.5` (the `TABLE` ripple) and the new row case. Then run `pnpm -r build && cd src/server && npx vitest run test/mcp.test.ts` (the catalog case sees 39 tools and the round-trip case gets a tool error) and `cd src/claude-channel && npx vitest run test/backend.test.ts` (`backend.listInvitations is not a function`). Capture all three outputs for the report.

- [ ] **Step 6: The interface.** In `src/mcp-tools/src/backend.ts`, directly after the `inviteToWeave(...)` line of `LoomToolBackend` (it ends `// { invitationId, seq }`), add:

```ts
  listInvitations(credential: string, targetWeaveId: string): Promise<unknown[]>;                        // PendingInvitation[]
  withdrawInvitation(credential: string, targetWeaveId: string, invitationId: string): Promise<unknown>; // { invitationId, seq, withdrawnAt, created }
```

- [ ] **Step 7: The names and the two tools.** In `src/mcp-tools/src/tools.ts`, replace the `LOOM_TOOL_NAMES` line that is today, whole, `  "open_request", "offer", "accept", "complete", "cancel_request", "list_requests", "get_request", "invite_to_weave",` with:

```ts
  "open_request", "offer", "accept", "complete", "cancel_request", "list_requests", "get_request", "invite_to_weave",
  "list_invitations", "withdraw_invitation",
```

Then directly after the `invite_to_weave` registration (it ends with `    toToolResult(Promise.resolve().then(() => backend.inviteToWeave(resolve(credential), participantId, targetWeaveId, threadId))));`), add:

```ts

  server.registerTool("list_invitations", {
    description: "List the invitations into one of your Weaves that are not yet redeemed or withdrawn (keepers of that Weave only). Each carries its invitationId, the invitee's Lobby participantId and name, the target Thread, when and by whom it was made, and its requestId (null for a direct invitation). Only a direct invitation can be withdrawn with withdraw_invitation.",
    inputSchema: { credential: cred(hint), targetWeaveId: z.string() },
  }, ({ credential, targetWeaveId }) =>
    toToolResult(Promise.resolve().then(() => backend.listInvitations(resolve(credential), targetWeaveId))));

  server.registerTool("withdraw_invitation", {
    description: "Withdraw a direct invitation into one of your Weaves before it is redeemed (keepers of the target Weave only): the invitee is told with weave.invitation_withdrawn and can no longer redeem it. An invitation that belongs to a request is refused: remove the agent from the request's Thread with remove_participant instead. Withdrawing one already withdrawn changes nothing and returns the same seq. Returns { invitationId, seq, withdrawnAt, created }.",
    inputSchema: { credential: cred(hint), targetWeaveId: z.string(), invitationId: z.string() },
  }, ({ credential, targetWeaveId, invitationId }) =>
    toToolResult(Promise.resolve().then(() => backend.withdrawInvitation(resolve(credential), targetWeaveId, invitationId))));
```

- [ ] **Step 8: The reaction table row.** In `src/mcp-tools/src/onboarding.ts`, in `REACTION_TABLE`, directly after the row that begins ``  "| `weave.invited` naming you |``, add:

```ts
  "| `weave.invitation_withdrawn` naming you | A keeper withdrew that invitation: do not redeem it (`join_weave` refuses it). Nothing else is asked of you. |",
```

- [ ] **Step 9: The three backends.** In `src/server/src/mcp/backend.ts`, directly after the `inviteToWeave` method (it ends `    return this.core.inviteToWeave(await this.actor(c), participantId, targetWeaveId, targetThreadId);` and `  }`), add:

```ts
  async listInvitations(c: string, targetWeaveId: string) { return this.core.listInvitations(await this.actor(c), targetWeaveId); }
  async withdrawInvitation(c: string, targetWeaveId: string, invitationId: string) {
    return this.core.withdrawInvitation(await this.actor(c), targetWeaveId, invitationId);
  }
```

In `src/claude-channel/src/backend.ts`, directly after the `inviteToWeave` method (it ends `    return this.as(c).inviteToWeave(targetWeaveId, participantId, targetThreadId);` and `  }`), add:

```ts
  listInvitations(c: string, targetWeaveId: string) { return this.as(c).listInvitations(targetWeaveId); }
  withdrawInvitation(c: string, targetWeaveId: string, invitationId: string) { return this.as(c).withdrawInvitation(targetWeaveId, invitationId); }
```

In `src/claude-channel/src/stored.ts`, directly after the line `    inviteToWeave: async (c, p, w, t) => inner.inviteToWeave(byWeave(c, w), p, w, t),` (under the comment `// Keeper authority in the *target* Weave, which this one does name.`), add:

```ts
    listInvitations: async (c, w) => inner.listInvitations(byWeave(c, w), w),
    withdrawInvitation: async (c, w, id) => inner.withdrawInvitation(byWeave(c, w), w, id),
```

- [ ] **Step 10: Run them to verify they pass**

Run: `pnpm -r build && cd src/mcp-tools && npx vitest run test/tools.test.ts test/onboarding.test.ts && cd ../server && npx vitest run test/mcp.test.ts && cd ../claude-channel && npx vitest run test/backend.test.ts`
Expected: PASS, pristine.

- [ ] **Step 11: `src/mcp-tools/README.md`.** In the line that begins `- **Lobby**`, replace everything from the start of the line up to and including its first full stop (today `- **Lobby**`, a dash, then `` `join_lobby`, `set_capabilities`, `find_agents`, `invite_to_weave`.``; the dash is an em dash, which this rewrite drops) with:

```text
- **Lobby**: `join_lobby`, `set_capabilities`, `find_agents`, `invite_to_weave`, and `list_invitations` and `withdraw_invitation` (a keeper of the target lists the invitations still pending into it and withdraws a direct one before it is redeemed).
```

and the rest of the line (from ` No tool was added for the listeners directory`) stays as it is.

- [ ] **Step 12: Typecheck, then the four suites whole**

Run: `pnpm -r typecheck && cd src/mcp-tools && npx vitest run && cd ../server && npx vitest run && cd ../claude-channel && npx vitest run`
Expected: all green, pristine. The mcp-tools drift guard (`skills.test.ts`) still passes: no skill names a new tool yet.

- [ ] **Step 13: Commit**

```bash
git add src/mcp-tools/src/tools.ts src/mcp-tools/src/backend.ts src/mcp-tools/src/onboarding.ts src/mcp-tools/README.md src/mcp-tools/test/tools.test.ts src/mcp-tools/test/onboarding.test.ts src/server/src/mcp/backend.ts src/server/test/mcp.test.ts src/claude-channel/src/backend.ts src/claude-channel/src/stored.ts src/claude-channel/test/backend.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(mcp-tools): list_invitations and withdraw_invitation, and the reaction table row" -m "Two tools after invite_to_weave (41 names), two LoomToolBackend methods implemented over core (server), over the client (channel) and with the stored credential resolved against the target Weave (stored.ts); REACTION_TABLE tells an agent that a weave.invitation_withdrawn naming it asks nothing of it. Ripples repaired: tools.test.ts 'advertises the ten Lobby tools...' (now twelve), 'LOOM_TOOL_NAMES has the four new names...', 'LOOM_TOOL_NAMES has get_skill: 39 names' (now 41), the fake backend; onboarding.test.ts TABLE; mcp.test.ts 'serves the tool catalog without connection-level auth'." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 4: claude-channel: wake on and render `weave.invitation_withdrawn`

Spec §8.1, §13.6. **This task carries the two `format.test.ts` cases and the repaired `channel.test.ts` case.**

**Files:**
- Modify: `src/claude-channel/src/format.ts` (`formatEvent`, `shouldWake`)
- Modify: `src/claude-channel/src/server.ts` (the `INSTRUCTIONS` entry beginning `'Events arrive as <channel source="loom"`)
- Modify: `src/claude-channel/README.md`
- Test: `src/claude-channel/test/format.test.ts`, `src/claude-channel/test/channel.test.ts`

**Interfaces:**
- Consumes: Task 2's `EventType` member `"weave.invitation_withdrawn"` (`@loom/client`); the payload of Task 1.
- Produces: `shouldWake` answers `e.payload.participantId === me` for the type, in the Lobby switch, whatever `wake` and `invites` say; `formatEvent` renders `Your invitation to "<targetWeaveTitle>" was withdrawn by <withdrawnByName>; do not redeem it` for the session's own participant and `Invitation to "<targetWeaveTitle>" for <name> withdrawn by <withdrawnByName>` for anyone else, with `meta.invitation` from the existing rule.

- [ ] **Step 1: Write the failing `format.test.ts` cases.** In `src/claude-channel/test/format.test.ts`, at the end of the file, add:

```ts
describe("withdrawn invitations (spec 2026-10-08 §8.1)", () => {
  /** A keeper of the target, unknown to this Weave's names, withdrew the invitation it had sent `participantId`. */
  const withdrawnFor = (participantId: string) => ev({ type: "weave.invitation_withdrawn", actor: "kp9", threadId: "t1",
    payload: { invitationId: "i1", participantId, targetWeaveTitle: "Loom development", withdrawnBy: "kp9", withdrawnByName: "Claude-Code" } });

  it("shouldWake: one naming the session's participant wakes it in both wake modes and with invites off; one naming another wakes it in neither, wake all included", () => {
    for (const wake of ["all", "mentions"] as const) for (const invites of [true, false]) {
      const w = { participantId: "p1", wake, invites, requests: true };
      expect([shouldWake(withdrawnFor("p1"), w), shouldWake(withdrawnFor("p3"), w)]).toEqual([true, false]);
    }
  });

  it("formatEvent: the session's own reads as its invitation withdrawn, another's names the invitee, and meta.invitation is set", () => {
    const own = formatEvent(withdrawnFor("p1"), weave, names, "p1");
    expect(own.content).toBe('Your invitation to "Loom development" was withdrawn by Claude-Code; do not redeem it');
    expect(own.meta.invitation).toBe("i1");
    expect(own.meta.type).toBe("weave.invitation_withdrawn");
    expect(formatEvent(withdrawnFor("p2"), weave, names, "p1").content).toBe('Invitation to "Loom development" for Paw withdrawn by Claude-Code');
  });
});
```

- [ ] **Step 2: Repair the instructions case.** In `src/claude-channel/test/channel.test.ts`, in the case `the instructions list the onboarding and removal types`, replace the line ``      expect(c.getInstructions()).toContain('|request.completed|request.overdue|thread.removed|listener.removed|request.offer_withdrawn" from=');`` with (the known ripple, and the spec's pinned substring):

```ts
      expect(c.getInstructions()).toContain('|thread.removed|listener.removed|request.offer_withdrawn|weave.invitation_withdrawn" from=');
      expect(c.getInstructions()).toContain('invitation="<invitationId>" on weave.invited and weave.invitation_withdrawn, and preamble=');
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -r build && cd src/claude-channel && npx vitest run test/format.test.ts test/channel.test.ts`
Expected: FAIL. `format.test.ts`: the wake case (`wake: "all"` wakes for `p3`, `[true, true]`; `mentions` wakes for neither, `[false, false]`) and the text case (`weave.invitation_withdrawn` is rendered as its type by the `default` branch); `channel.test.ts`: the repaired case, neither substring found. Capture this output for the report.

- [ ] **Step 4: The wake rule.** In `src/claude-channel/src/format.ts`, in `shouldWake`'s Lobby switch, directly after the line `      case "weave.invited": return w.invites && e.payload.participantId === me;` add:

```ts
      // A keeper took back an invitation it had sent this session (spec 2026-10-08 §8.1). Undoing an
      // invite is not an invite, so the invites preference does not silence it either.
      case "weave.invitation_withdrawn": return e.payload.participantId === me;
```

- [ ] **Step 5: The two texts.** In `formatEvent`, directly before the line that begins ``    case "request.completed": content = `` (it follows the `case "weave.invited": { ... }` block), add:

```ts
    case "weave.invitation_withdrawn": {
      const title = str(e.payload.targetWeaveTitle);
      const by = str(e.payload.withdrawnByName);
      content = e.payload.participantId === me
        ? `Your invitation to "${title}" was withdrawn by ${by}; do not redeem it`
        : `Invitation to "${title}" for ${who(e.payload.participantId).name} withdrawn by ${by}`;
      break;
    }
```

- [ ] **Step 6: The instructions.** In `src/claude-channel/src/server.ts`, in the `INSTRUCTIONS` entry that begins `'Events arrive as <channel source="loom"`, replace the substring `|listener.removed|request.offer_withdrawn" from=` with `|listener.removed|request.offer_withdrawn|weave.invitation_withdrawn" from=`, and the substring `invitation="<invitationId>" on weave.invited, and preamble=` with `invitation="<invitationId>" on weave.invited and weave.invitation_withdrawn, and preamble=`. Nothing else in that entry changes.

- [ ] **Step 7: Run them to verify they pass**

Run: `pnpm -r build && cd src/claude-channel && npx vitest run test/format.test.ts test/channel.test.ts`
Expected: PASS, pristine (the channel suite spawns the rebuilt `dist/server.js`).

- [ ] **Step 8: `src/claude-channel/README.md`.** The wake list's bullet that begins ``- `listener.removed` wakes the participant it names`` runs over three lines, the last of which is, whole, ``  requester it names in `to`, in both wake modes and whatever `invites` says.``. Directly after that line add:

```markdown
- `weave.invitation_withdrawn` wakes the participant it names, in both wake modes and whatever `invites` says.
```

and replace the line that is today, whole, `` `weave.invited` carries `invitation="<invitationId>"`. `` (the second line of the paragraph that begins ``Request events carry `request="<requestId>"` on the tag``) with:

```markdown
`weave.invited` and `weave.invitation_withdrawn` carry `invitation="<invitationId>"`.
```

- [ ] **Step 9: Typecheck, then the channel suite whole**

Run: `pnpm -r typecheck && cd src/claude-channel && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 10: Commit**

```bash
git add src/claude-channel/src/format.ts src/claude-channel/src/server.ts src/claude-channel/README.md src/claude-channel/test/format.test.ts src/claude-channel/test/channel.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(channel): wake on and render weave.invitation_withdrawn" -m "The invitee is woken in both wake modes whatever invites says, decided in the Lobby switch so wake all never reaches anyone else; its text says not to redeem, and anyone else's names the invitee. The instructions' type= list and invitation= sentence name the type. Ripple repaired: channel.test.ts 'the instructions list the onboarding and removal types'." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 5: CLI: `invite-weave list`, `invite-weave withdraw`, `--thread` made optional, the `read` line

Spec §7.5, §11, §13.5. **This task carries the four `lobby.test.ts` cases.**

**Files:**
- Modify: `src/cli/src/commands/request.ts` (the type import; `invitationLine`; the `invite-weave` command and its two subcommands)
- Modify: `src/cli/src/commands/messages.ts` (`formatEvent`)
- Modify: `src/cli/README.md`, `README.md`
- Test: `src/cli/test/lobby.test.ts`

**Interfaces:**
- Consumes: Task 2's `LoomClient.listInvitations`, `LoomClient.withdrawInvitation`, `PendingInvitation` (`@loom/client`); `CliError(code, message, { exitCode })`; `emit(c, json, human)`; `c.resolveWeave()` (the global `--weave`, else the last Weave created or joined).
- Produces:

```text
loom invite-weave <participantId> --thread <id>     unchanged; without --thread: CliError validation "invite-weave <participantId> needs --thread <id>", exit 2
loom invite-weave list                              one line per invitation, or "(no pending invitations)"; --json { invitations }
loom invite-weave withdraw <invitationId>           "Withdrew invitation <id> (seq <n>)" or "Invitation <id> was already withdrawn (seq <n>)"; --json the WithdrawResult
loom read: <head> invitation to "<targetWeaveTitle>" for <name(participantId)> withdrawn by <withdrawnByName>
```

- [ ] **Step 1: Write the failing `lobby.test.ts` cases.** In `src/cli/test/lobby.test.ts`, inside `describe("loom request", ...)`, directly after the case `invite-weave hands a Lobby participant a way into the current Weave`, add:

```ts
  it("invite-weave list prints one line per pending invitation, marks a request's, --json is { invitations }, and an empty list says so (spec 2026-10-08 §7.5)", async () => {
    const sc = await scenario();
    const direct = (await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req })).json();
    const r = await open(sc);
    await run(["request", "offer", r.id, "--json"], { cfg: sc.bot });
    const accepted = (await run(["request", "accept", r.id, sc.botId, "--deadline", "30m", "--json"], { cfg: sc.req })).json();
    const listed = await run(["invite-weave", "list", "--weave", sc.weaveId, "--json"], { cfg: sc.req });
    expect(listed.code).toBe(0);
    type Row = { invitationId: string; inviteeName: string; targetThreadName: string; createdAt: string; createdBy: string; createdByName: string | null; requestId: string | null };
    const rows = listed.json().invitations as Row[];
    expect(rows.map((i) => [i.invitationId, i.requestId]).sort()).toEqual([[direct.invitationId, null], [accepted.invitationIds[0], r.id]].sort());
    expect(rows.every((i) => i.inviteeName === sc.botName && i.targetThreadName === "PR 14")).toBe(true);
    expect(rows.find((i) => i.requestId === r.id)!.createdBy).toBe(sc.requesterId);
    const line = (i: Row) => `${i.invitationId}  ${i.inviteeName}  thread "${i.targetThreadName}"  by ${i.createdByName ?? i.createdBy}  ${hhmm(i.createdAt)}${i.requestId !== null ? ` [request ${i.requestId}]` : ""}`;
    const human = await run(["invite-weave", "list", "--weave", sc.weaveId], { cfg: sc.req });
    expect(human.out).toBe(rows.map(line).join("\n") + "\n");
    const cfg = newCfg();
    const quiet = (await run(["create", "--title", "Quiet", "--name", uniq("Paw"), "--json"], { cfg })).json();
    expect((await run(["invite-weave", "list", "--weave", quiet.weave.id], { cfg })).out).toBe("(no pending invitations)\n");
  });

  it("invite-weave withdraw prints the seq, a repeat says it was already withdrawn with the same seq, and a request's invitation exits 1 with the validation message", async () => {
    const sc = await scenario();
    const direct = (await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req })).json();
    const first = await run(["invite-weave", "withdraw", direct.invitationId, "--weave", sc.weaveId], { cfg: sc.req });
    expect(first.code).toBe(0);
    const m = /^Withdrew invitation (\S+) \(seq (\d+)\)\n$/.exec(first.out);
    expect(m?.[1]).toBe(direct.invitationId);
    const again = await run(["invite-weave", "withdraw", direct.invitationId, "--weave", sc.weaveId], { cfg: sc.req });
    expect(again.out).toBe(`Invitation ${direct.invitationId} was already withdrawn (seq ${m![2]})\n`);
    const json = (await run(["invite-weave", "withdraw", direct.invitationId, "--weave", sc.weaveId, "--json"], { cfg: sc.req })).json();
    expect(json).toMatchObject({ invitationId: direct.invitationId, seq: Number(m![2]), created: false });
    const r = await open(sc);
    await run(["request", "offer", r.id, "--json"], { cfg: sc.bot });
    const accepted = (await run(["request", "accept", r.id, sc.botId, "--deadline", "30m", "--json"], { cfg: sc.req })).json();
    const refused = await run(["invite-weave", "withdraw", accepted.invitationIds[0], "--weave", sc.weaveId], { cfg: sc.req });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("This invitation belongs to a request: remove the agent from the request's Thread instead (remove_participant)");
  });

  it("invite-weave <participantId> without --thread is a usage error with exit 2 (spec 2026-10-08 §11)", async () => {
    const sc = await scenario();
    const bad = await run(["invite-weave", sc.botId, "--weave", sc.weaveId], { cfg: sc.req });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("invite-weave <participantId> needs --thread <id>");
  });
```

and inside `describe("loom read renders the Lobby events", ...)`, at its end (after the case `renders a profile change as a system line`), add:

```ts
  it("renders weave.invitation_withdrawn as a system line naming the Weave, the invitee and the keeper (spec 2026-10-08 §7.5)", async () => {
    const sc = await scenario();
    const direct = (await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req })).json();
    const keeperName = (await run(["invite-weave", "list", "--weave", sc.weaveId, "--json"], { cfg: sc.req })).json().invitations[0].createdByName as string;
    const withdrawn = (await run(["invite-weave", "withdraw", direct.invitationId, "--weave", sc.weaveId, "--json"], { cfg: sc.req })).json();
    // From just before the withdrawal: the Lobby's General is shared by the whole file and pages oldest first.
    const read = await run(["read", "--weave", lobbyWeaveId, "--thread", sc.lobbyGeneralThreadId, "--since", String(withdrawn.seq - 1)], { cfg: sc.req });
    expect(read.code).toBe(0);
    expect(read.out).toContain(`* invitation to "Loom session" for ${sc.botName} withdrawn by ${keeperName}`);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r build && cd src/cli && npx vitest run test/lobby.test.ts`
Expected: FAIL. The list and withdraw cases: commander reads `list` and `withdraw` as the participant id and refuses for want of `--thread` (`error: required option '--thread <id>' not specified`, exit 2); the `--thread` case: exit 2 with commander's own message, which does not contain the new one; the `read` case fails at the list call the same way. Capture this output for the report.

- [ ] **Step 3: The subcommands.** In `src/cli/src/commands/request.ts`, replace the import line `import type { Acceptance, LoomRequest, Offer, Requirements, RequestStatus } from "@loom/client";` with:

```ts
import type { Acceptance, LoomRequest, Offer, PendingInvitation, Requirements, RequestStatus } from "@loom/client";
```

Directly before `function requestBlock(r: LoomRequest): string {` add:

```ts
/**
 * One pending invitation, as `invite-weave list` prints it (spec 2026-10-08 §7.5). A request's is
 * marked, because only a direct one can be withdrawn; the time is the local clock's, the instant is
 * in `--json`.
 */
function invitationLine(i: PendingInvitation): string {
  return `${i.invitationId}  ${i.inviteeName}  thread "${i.targetThreadName}"  by ${i.createdByName ?? i.createdBy}  ${hhmm(i.createdAt)}${i.requestId !== null ? ` [request ${i.requestId}]` : ""}`;
}
```

Then replace the whole `invite-weave` command, from the line `  program.command("invite-weave <participantId>")` through the `    });` that closes its `.action(...)` (the line before it is ``      emit(c, r, `Invited ${participantId} into thread ${o.thread} of ${weaveId} (invitation ${r.invitationId}, seq ${r.seq})`);``), with:

```ts
  const inviteWeave = program.command("invite-weave <participantId>")
    .description("Hand a Lobby participant a single-use way into a Thread of the current Weave (keepers)")
    // Not a requiredOption: commander checks the mandatory options of a command's ancestors too, so a
    // required --thread here would refuse `invite-weave list` and `invite-weave withdraw` (spec §7.5).
    .option("--thread <id>", "Thread of the target Weave they are invited into")
    .addHelpText("after", "\nThe target Weave is the global --weave <id> (default: the last Weave created or joined).\nSubcommands: list (pending invitations into the Weave), withdraw <invitationId> (take back a direct one before it is redeemed).")
    .action(async (participantId: string, o: { thread?: string }) => {
      if (o.thread === undefined) throw new CliError("validation", "invite-weave <participantId> needs --thread <id>", { exitCode: 2 });
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const r = await c.client(entry.token).inviteToWeave(weaveId, participantId, o.thread);
      emit(c, r, `Invited ${participantId} into thread ${o.thread} of ${weaveId} (invitation ${r.invitationId}, seq ${r.seq})`);
    });

  // commander dispatches to a subcommand when the first operand names one, and otherwise runs the
  // command's own action: a participant id is a uuid, never `list` or `withdraw`.
  inviteWeave.command("list")
    .description("The invitations into the current Weave not yet redeemed or withdrawn, a request's marked (keepers)")
    .action(async () => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const invitations = await c.client(entry.token).listInvitations(weaveId);
      emit(c, { invitations }, invitations.map(invitationLine).join("\n") || "(no pending invitations)");
    });

  inviteWeave.command("withdraw <invitationId>")
    .description("Take back a direct invitation into the current Weave before it is redeemed (keepers)")
    .action(async (invitationId: string) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const r = await c.client(entry.token).withdrawInvitation(weaveId, invitationId);
      emit(c, r, r.created ? `Withdrew invitation ${r.invitationId} (seq ${r.seq})` : `Invitation ${r.invitationId} was already withdrawn (seq ${r.seq})`);
    });
```

- [ ] **Step 4: The `read` line.** In `src/cli/src/commands/messages.ts`, in `formatEvent`, directly after the `weave.invited` block (its return line is ``    return `${head} invited ${name(e.payload.participantId)} to "${str(e.payload.targetWeaveTitle)}" (invite ${str(e.payload.invitationId)})`;``, then `  }`), add:

```ts
  // A keeper took back a direct invitation (spec 2026-10-08 §7.5), in the style of the line above.
  if (e.type === "weave.invitation_withdrawn") {
    return `${head} invitation to "${str(e.payload.targetWeaveTitle)}" for ${name(e.payload.participantId)} withdrawn by ${str(e.payload.withdrawnByName)}`;
  }
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm -r build && cd src/cli && npx vitest run test/lobby.test.ts`
Expected: PASS, pristine; the existing `invite-weave <participantId> --thread <id>` cases pass unchanged.

- [ ] **Step 6: The two READMEs.** In `src/cli/README.md`, directly after the command-table row that is today, whole, ``| `invite-weave <participantId> --weave <id> --thread <id>` | Hand a Lobby participant a single-use way into a Thread of that Weave (keepers) |``, add:

```markdown
| `invite-weave list --weave <id>` | The invitations into that Weave not yet redeemed or withdrawn, one line each, a request's marked `[request <id>]` (keepers) |
| `invite-weave withdraw <invitationId> --weave <id>` | Take back a direct invitation before it is redeemed; a repeat says it was already withdrawn, with the same seq (keepers) |
```

In `README.md`, replace the line that is today, whole, ``invitation with no request at all: `loom invite-weave <participantId> --weave <id> --thread <id>`.`` with:

```markdown
invitation with no request at all: `loom invite-weave <participantId> --weave <id> --thread <id>`; `loom invite-weave withdraw <invitationId>` takes a direct one back before it is redeemed, and `loom invite-weave list` shows the ones pending.
```

- [ ] **Step 7: Typecheck, then the CLI suite whole**

Run: `pnpm -r typecheck && cd src/cli && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 8: Commit**

```bash
git add src/cli/src/commands/request.ts src/cli/src/commands/messages.ts src/cli/README.md README.md src/cli/test/lobby.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(cli): invite-weave list and invite-weave withdraw" -m "invite-weave gains two subcommands under commander 15's dispatch, so --thread becomes an ordinary option and the invite action refuses its absence itself (CliError validation, exit 2), since commander checks an ancestor's mandatory options for every subcommand. list prints one line per pending invitation, a request's marked; withdraw prints the seq, or that it was already withdrawn. loom read renders weave.invitation_withdrawn." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 6: web: the Thread line, the folded words, the session's read and action, the Pending invitations panel

Spec §8.2, §9, §13.7. **This task carries the seven `components.test.tsx` cases, the five `session.test.ts` cases (spec §13.7's three, and the two that order the read within a generation) and the `fold.test.ts` case.**

**Files:**
- Modify: `src/web/src/session.ts` (the client import; `SessionState`; `Session`; `mayManageInvitations`; the `invitationReads` counter; `readInvitations` and its two call sites; `canManageInvitations` and `withdrawInvitation` on the returned object)
- Create: `src/web/src/components/InvitationsPanel.tsx`
- Modify: `src/web/src/components/WeaveView.tsx` (the import; the panel after `GuidelinesPanel`)
- Modify: `src/web/src/components/MessageList.tsx` (`systemLine`)
- Modify: `src/web/src/components/fold.ts` (`WORDS`)
- Test: `src/web/test/components.test.tsx`, `src/web/test/session.test.ts`, `src/web/test/fold.test.ts`

**Interfaces:**
- Consumes: Task 2's `LoomClient.listInvitations`, `LoomClient.withdrawInvitation`, `PendingInvitation` and the `EventType` member (`@loom/client`).
- Produces:

```ts
// src/web/src/session.ts
export function mayManageInvitations(state: SessionState): boolean;   // keeper here, and this Weave is not the Lobby; archived or not
// SessionState gains
invitations?: PendingInvitation[];      // absent until a read has come back
invitationsError?: string;              // the last read's failure, cleared by the next success
// Session gains
canManageInvitations(): boolean;        // mayManageInvitations(the session's state)
withdrawInvitation(invitationId: string): Promise<void>;

// src/web/src/components/InvitationsPanel.tsx
export function InvitationsPanel(props: { state: SessionState; session: Session; onError: (e: unknown) => void }): JSX.Element | null;
// <section class="nav-section invitations">, headed "Pending invitations"; rows <li class="invitation"> in <ul class="invitation-list">
```

- [ ] **Step 1: Write the failing `fold.test.ts` case.** In `src/web/test/fold.test.ts`, at the end of `describe("runSummary", ...)` (after the case `counts listener removals and withdrawn offers in their words (spec 2026-09-30 §9.1)`), add:

```ts
  it("counts withdrawn invitations in their words (spec 2026-10-08 §8.2)", () => {
    expect(runSummary([ev("weave.invitation_withdrawn")])).toEqual(["1 invitation withdrawn"]);
    expect(runSummary([ev("weave.invited"), ev("weave.invitation_withdrawn"), ev("weave.invitation_withdrawn")]))
      .toEqual(["1 invited to a Weave", "2 invitations withdrawn"]);
  });
```

- [ ] **Step 2: Write the failing `components.test.tsx` cases, and repair the `session()` fake.** In `src/web/test/components.test.tsx`:
  - After the import line `import { WeaveView } from "../src/components/WeaveView.js";` add `import { InvitationsPanel } from "../src/components/InvitationsPanel.js";`; replace the import line `import { CLOSED_REQUESTS_PAGE, type Session, type SessionState } from "../src/session.js";` with `import { CLOSED_REQUESTS_PAGE, mayManageInvitations, type Session, type SessionState } from "../src/session.js";`; and in the `@loom/client` import line add `type PendingInvitation, ` directly before `type Thread }`.
  - In `function session(...)`, replace the line `    onVisible: () => () => {}, onWorkChanged: () => () => {},` with (the ripple: `Session` gains two members):

```ts
    onVisible: () => () => {}, onWorkChanged: () => () => {},
    canManageInvitations: () => false, withdrawInvitation: vi.fn(async () => {}),
```

  - In `describe("MessageList", ...)`, directly after the case `renders listener.removed, with the last check-in or never, and request.offer_withdrawn as system lines (spec 2026-09-30 §9.1)`, add:

```tsx
  it("renders weave.invitation_withdrawn as a system line naming the Weave, the invitee and the keeper (spec 2026-10-08 §8.2)", () => {
    const base = { weaveId: "w1", threadId: "g1", actor: "kp9", at: new Date().toISOString() };
    const events = [{ ...base, seq: 1, type: "weave.invitation_withdrawn" as const,
      payload: { invitationId: "i1", participantId: "p2", targetWeaveTitle: "Loom development", withdrawnBy: "kp9", withdrawnByName: "Claude-Code" } }];
    const { container } = render(<MessageList state={lobbyState({ currentThreadId: "g1", events })} fold={false} />);
    expect([...container.querySelectorAll(".sysrow .sys-text")].map((d) => d.textContent))
      .toEqual(['invitation to "Loom development" for Helper withdrawn by Claude-Code']);
  });
```

  - Directly after `describe("GuidelinesPanel", ...)` closes, add:

```tsx
describe("InvitationsPanel (spec 2026-10-08 §9)", () => {
  const keeperMe = { ...me, role: "keeper" as const };
  const INVITES: PendingInvitation[] = [
    { invitationId: "i1", participantId: "lp1", inviteeName: "Claude-Work", targetThreadId: "t1", targetThreadName: "PR 12",
      createdAt: "2026-10-02T08:00:00.000Z", createdBy: "p1", createdByName: "Paw", requestId: null },
    { invitationId: "i2", participantId: "lp2", inviteeName: "ChatGPT-Work", targetThreadId: "t1", targetThreadName: "PR 12",
      createdAt: "2026-10-02T08:05:00.000Z", createdBy: "lp9", createdByName: null, requestId: "r9" },
  ];
  const keeperState = (over: Partial<SessionState> = {}) => state({ me: { participant: keeperMe, token: "t" }, invitations: INVITES, ...over });
  /** A fake session whose gate is the real rule, read from the state the view is drawn with. */
  const gated = (st: SessionState, over: Partial<Session> = {}) => session({ canManageInvitations: () => mayManageInvitations(st), ...over });
  const section = (container: Element) => container.querySelector(".nav-section.invitations");

  it("the section is drawn for a keeper, and not for a member, a reader with the Weave link, or on the Lobby", () => {
    const cases: [SessionState, boolean][] = [
      [keeperState(), true],
      [state({ invitations: INVITES }), false],
      [keeperState({ me: undefined, readOnlyReason: "not-joined" }), false],
      [keeperState({ lobby: { weaveId: "w1", title: "Lobby" } }), false],
    ];
    for (const [st, drawn] of cases) {
      const { container, unmount } = render(<WeaveView session={gated(st)} state={st} />);
      expect(!!section(container)).toBe(drawn);
      unmount();
    }
  });

  it("is drawn in an archived Weave, headed Pending invitations, with Withdraw", () => {
    const st = keeperState({ weave: { ...state().weave!, archivedAt: "2026-10-08T10:00:00.000Z" } });
    const { container } = render(<WeaveView session={gated(st)} state={st} />);
    expect(section(container)!.querySelector(".sec")!.textContent).toBe("Pending invitations");
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);
  });

  it("a direct invitation has Withdraw; a request's has none and says how it is withdrawn", () => {
    const st = keeperState();
    const { container } = render(<InvitationsPanel state={st} session={gated(st)} onError={() => {}} />);
    const rows = [...container.querySelectorAll(".invitation")];
    expect(rows.map((r) => !!r.querySelector("button"))).toEqual([true, false]);
    expect(rows[0]!.textContent).toContain("Claude-Work");
    expect(rows[0]!.textContent).toContain(`thread "PR 12"`);
    expect(rows[0]!.textContent).toContain("by Paw");
    expect(rows[1]!.textContent).toContain("by someone");
    expect(rows[1]!.textContent).toContain("remove the agent from the request's Thread to withdraw it");
  });

  it("pressing Withdraw calls the session once, disables the button while in flight, and removes the row on success", async () => {
    let finish!: () => void;
    const withdrawInvitation = vi.fn((_invitationId: string) => new Promise<void>((r) => { finish = r; }));
    const st = keeperState();
    const { container } = render(<InvitationsPanel state={st} session={gated(st, { withdrawInvitation })} onError={() => {}} />);
    const button = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    fireEvent.click(button);
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(withdrawInvitation).toHaveBeenCalledTimes(1);
    expect(withdrawInvitation).toHaveBeenCalledWith("i1");
    finish();
    await vi.waitFor(() => expect(container.textContent).not.toContain("Claude-Work"));
    expect(container.textContent).toContain("ChatGPT-Work");
  });

  it("a refused withdrawal shows its message on the Weave view's error bar and keeps the row", async () => {
    const st = keeperState();
    const refusal = "This invitation was already redeemed: take the participant off the Thread with remove_participant instead";
    const { container } = render(<WeaveView session={gated(st, { withdrawInvitation: vi.fn(async () => { throw new Error(refusal); }) })} state={st} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect((await screen.findByText(refusal)).className).toContain("error-bar");
    expect(section(container)!.textContent).toContain("Claude-Work");
  });

  it("a failed read shows the section's error, keeps the rows it had, and never says there are none; an empty list says so", () => {
    const failed = keeperState({ invitations: undefined, invitationsError: "Could not reach Loom" });
    const a = render(<InvitationsPanel state={failed} session={gated(failed)} onError={() => {}} />);
    expect(section(a.container)!.textContent).toContain("Could not reach Loom");
    expect(section(a.container)!.textContent).not.toContain("No pending invitations.");
    a.unmount();
    const kept = keeperState({ invitationsError: "Could not reach Loom" });
    const b = render(<InvitationsPanel state={kept} session={gated(kept)} onError={() => {}} />);
    expect(b.container.querySelectorAll(".invitation")).toHaveLength(2);
    expect(section(b.container)!.textContent).toContain("Could not reach Loom");
    b.unmount();
    const empty = keeperState({ invitations: [] });
    const c = render(<InvitationsPanel state={empty} session={gated(empty)} onError={() => {}} />);
    expect(section(c.container)!.textContent).toContain("No pending invitations.");
  });
});
```

- [ ] **Step 3: Write the failing `session.test.ts` cases.** In `src/web/test/session.test.ts`, at the end of the file (after every helper it defines, so `sideReadClient`, `onCall`, `always`, `parks`, `parksThen`, `delivering`, `afterDelivery`, `refuses` and `BROKEN` are in scope), add:

```ts
describe("pending invitations (spec 2026-10-08 §9)", () => {
  let invN = 0;
  /** A Weave this browser keeps, a Lobby participant to invite into it, and the keeper's stored identity. */
  async function invitedWeave() {
    const n = ++invN;
    const r = await anon.createWeave({ title: `Invites ${n}`, opener: "hello", creator: { name: "Paw", kind: "human" } });
    const keeper = await s.core.resolveCredential(r.token);
    const guest = async (tag: string) => (await anon.joinLobby({ name: `Guest-${tag}-${n}`, kind: "agent" })).participant;
    const invite = async (participantId: string) =>
      (await s.core.inviteToWeave(keeper, participantId, r.weave.id, r.generalThread.id)).invitationId;
    const keeperStorage = () => {
      const st = memoryStorage();
      st.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
      return st;
    };
    return { r, keeper, guest, invite, keeperStorage, path: `/api/weaves/${r.weave.id}/invitations` };
  }

  it("the list is read on load and on each refresh for a keeper, and never for a member", async () => {
    const f = await invitedWeave();
    const a = await f.guest("a");
    const first = await f.invite(a.id);
    const keeper = createSession({ client: anon, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await keeper.load();
    try {
      expect(keeper.canManageInvitations()).toBe(true);
      await waitFor(() => keeper.getState().invitations?.length === 1);
      expect(keeper.getState().invitations![0]).toMatchObject({ invitationId: first, participantId: a.id, inviteeName: a.name, requestId: null });
      const second = await f.invite((await f.guest("b")).id);
      // A participant.joined in this Weave schedules the coalesced refresh that re-reads the list.
      await waitFor(() => keeper.getState().connection === "open");
      await anon.joinWeave(f.r.secret, { name: "Reader", kind: "human" });
      await waitFor(() => keeper.getState().invitations?.length === 2);
      expect(keeper.getState().invitations!.map((i) => i.invitationId).sort()).toEqual([first, second].sort());
    } finally { keeper.dispose(); }

    const m = sideReadClient();
    const joined = await anon.joinWeave(f.r.secret, { name: "Member", kind: "human" });
    const storage = memoryStorage();
    storage.set(`loom:${f.r.secret}`, JSON.stringify({ token: joined.token, participantId: joined.participant.id }));
    const member = createSession({ client: m.client, target: { kind: "secret", secret: f.r.secret }, storage });
    await member.load();
    try {
      expect(member.canManageInvitations()).toBe(false);
      await waitFor(() => member.getState().connection === "open");
      await anon.joinWeave(f.r.secret, { name: "Reader2", kind: "human" });
      await waitFor(() => member.getState().participants.some((p) => p.name === "Reader2"));
      expect([m.calls(f.path), member.getState().invitations]).toEqual([0, undefined]);
    } finally { member.dispose(); }
  });

  it("an invitations answer for a load this tab has since replaced is dropped", async () => {
    const f = await invitedWeave();
    const id = await f.invite((await f.guest("a")).id);
    const gate = makeGate();
    const held = delivering(parks(gate));
    const c = sideReadClient({ [f.path]: onCall(1, held.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      await gate.entered;                      // the first read holds an answer with the invitation in it
      await s.core.withdrawInvitation(f.keeper, f.r.weave.id, id);
      await session.load();                    // a new generation, whose own read answers []
      await waitFor(() => session.getState().invitations !== undefined);
      expect(session.getState().invitations).toEqual([]);
      gate.release();
      await held.delivered;
      await new Promise((r) => setTimeout(r, 50));
      expect(session.getState().invitations).toEqual([]);
    } finally { session.dispose(); }
  });

  // The generation orders nothing within a generation: the load and every refresh each start a read,
  // so two can be in flight at once, and the one that lands last is not always the newest. Mirrors
  // the listener count's "does not let an older count overwrite a newer one".
  it("an older invitations answer never replaces a newer one within the same generation", async () => {
    const f = await invitedWeave();
    const id = await f.invite((await f.guest("a")).id);
    const gate = makeGate();
    const stale = delivering(parks(gate));
    const c = sideReadClient({ [f.path]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      await gate.entered;                      // read A, the load's, is parked holding the invitation
      await s.core.withdrawInvitation(f.keeper, f.r.weave.id, id);   // withdrawn outside this tab, as the CLI or MCP would
      await waitFor(() => session.getState().connection === "open");
      await anon.joinWeave(f.r.secret, { name: "Reader", kind: "human" });   // the refresh: read B answers []
      await waitFor(() => session.getState().invitations?.length === 0);
      gate.release();                          // ...and only now A's answer, with the row in it, lands
      await afterDelivery(stale.delivered);
      expect(session.getState().invitations).toEqual([]);
    } finally { gate.release(); session.dispose(); }
  });

  // One watermark for answers and rejections alike: an older read's failure must not replace a newer
  // read's rows with an error. Mirrors "drops a count rejection that a newer answer has already overtaken".
  it("an older invitations rejection never replaces a newer answer within the same generation", async () => {
    const f = await invitedWeave();
    const id = await f.invite((await f.guest("a")).id);
    const gate = makeGate();
    const stale = delivering(parksThen(gate, BROKEN));
    const c = sideReadClient({ [f.path]: onCall(1, stale.answer) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      await gate.entered;                      // read A, the load's, is out and unanswered
      await waitFor(() => session.getState().connection === "open");
      await anon.joinWeave(f.r.secret, { name: "Reader", kind: "human" });   // the refresh: read B answers the row
      await waitFor(() => session.getState().invitations?.length === 1);
      gate.release();                          // ...and only now A's 500 lands
      await afterDelivery(stale.delivered);
      expect([session.getState().invitations!.map((i) => i.invitationId), session.getState().invitationsError])
        .toEqual([[id], undefined]);
    } finally { gate.release(); session.dispose(); }
  });

  it("withdrawInvitation drops the row at once and schedules a refresh; a refused one keeps the row and re-reads the list", async () => {
    const f = await invitedWeave();
    const first = await f.invite((await f.guest("a")).id);
    const second = await f.invite((await f.guest("b")).id);
    const c = sideReadClient({ [`${f.path}/${second}/withdraw`]: always(refuses("validation",
      "This invitation was already redeemed: take the participant off the Thread with remove_participant instead", 400)) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.r.secret }, storage: f.keeperStorage() });
    await session.load();
    try {
      await waitFor(() => session.getState().invitations?.length === 2);
      const reads = c.weaveReads();
      await session.withdrawInvitation(first);
      expect(session.getState().invitations!.map((i) => i.invitationId)).toEqual([second]);
      await waitFor(() => c.weaveReads() > reads);
      await waitFor(() => session.getState().refreshError === undefined && c.calls(f.path) >= 2);
      const lists = c.calls(f.path);
      await expect(session.withdrawInvitation(second)).rejects.toMatchObject({ code: "validation" });
      expect(session.getState().invitations!.map((i) => i.invitationId)).toEqual([second]);
      await waitFor(() => c.calls(f.path) > lists);
    } finally { session.dispose(); }
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm -r build && cd src/web && npx vitest run test/fold.test.ts test/components.test.tsx test/session.test.ts`
Expected: FAIL. `fold.test.ts`: the new case (`1 weave.invitation_withdrawn`, named by its type); `components.test.tsx`: the whole file, `Failed to resolve import "../src/components/InvitationsPanel.js"`; `session.test.ts`: the five new cases (`keeper.canManageInvitations is not a function`; the generation case and the two ordering cases time out waiting for `invitations`). Capture this output for the report. The two ordering cases are what the watermark of Step 6 exists for: against a `readInvitations` with only the generation, identity and Weave guards they fail on the stale answer (`[]` expected, the withdrawn row received) and on the stale rejection (`invitationsError` set where `undefined` is expected).

- [ ] **Step 5: The folded words and the Thread line.** In `src/web/src/components/fold.ts`, in `WORDS`, directly after the line `  "weave.invited": "invited to a Weave",` add:

```ts
  "weave.invitation_withdrawn": ["invitation withdrawn", "invitations withdrawn"],
```

In `src/web/src/components/MessageList.tsx`, in `systemLine`, directly after the line that begins `    case "weave.invited": return ` add:

```ts
    // A keeper took back a direct invitation (spec 2026-10-08 §8.2): on the Lobby's General, live.
    case "weave.invitation_withdrawn": return `invitation to "${str(e.payload.targetWeaveTitle)}" for ${name(e.payload.participantId)} withdrawn by ${str(e.payload.withdrawnByName)}`;
```

- [ ] **Step 6: The session.** In `src/web/src/session.ts`:
  - Replace the import line that is today, whole, `  type LoomRequest, type OpenRequestInput,` with `  type LoomRequest, type OpenRequestInput, type PendingInvitation,`.
  - In `SessionState`, directly after the line `  newAfter?: { threadId: string; seq: number; firstNew: number | null };` add:

```ts
  /**
   * The invitations still pending into this Weave (spec 2026-10-08 §9), for a keeper of a Weave that
   * is not the Lobby. Absent until a read has come back; a failed read keeps what is held.
   */
  invitations?: PendingInvitation[];
  /** Why the last invitations read failed, cleared by the next success. Never shown as an empty list. */
  invitationsError?: string;
```

  - In `Session`, directly after the line `  markAllRead(): Promise<void>;` add:

```ts
  /** A keeper of this Weave, which is not the Lobby, archived or not (spec 2026-10-08 §9): who sees the pending invitations and may withdraw them. */
  canManageInvitations(): boolean;
  /** Withdraws a direct invitation into this Weave: on success its row leaves `invitations` at once and a refresh follows; a refusal re-reads the list and is thrown. */
  withdrawInvitation(invitationId: string): Promise<void>;
```

  - Directly before the line ``/** The server's own page maximum (`MAX_PAGE_LIMIT`): what "everything" is asked for as. */`` (it precedes `const PAGE = 1000;`), add:

```ts
/**
 * Whether this page shows the pending invitations into its Weave and may withdraw them (spec
 * 2026-10-08 §9): its participant is a keeper there, and the Weave is not the Lobby, which no
 * invitation can target. Archived or not, unlike `canModerate`: a withdrawal only removes access.
 */
export function mayManageInvitations(state: SessionState): boolean {
  return state.me?.participant.role === "keeper" && !!state.weave && state.lobby?.weaveId !== state.weave.id;
}

```

  - Directly after the line `  const countReads = createCounter();` (the listener count's counter, after `profileReads`) add the invitations read's own counter. `createCounter` is already imported by `session.ts` (its import line from `./side-reads.js`), so no import changes:

```ts
  /** The invitations read's request numbers (spec 2026-10-08 §9), ordered as the listener count's are. */
  const invitationReads = createCounter();
```

  - Directly before the line `  const refreshInfo = async () => {` add:

```ts
  /**
   * The pending invitations into this Weave (spec 2026-10-08 §9), read beside the page's metadata on
   * the load and on every coalesced refresh, only while `mayManageInvitations` holds, with this
   * browser's own token. Fenced like every read of the page: an answer for a generation, an identity
   * or a Weave this tab has since left is dropped. And ordered, like `readListenerCount`: the load and
   * every refresh each start one, so two can be in flight inside one generation, which the generation
   * says nothing about. A failure keeps the rows held and says why.
   */
  const readInvitations = (myGeneration: number) => {
    if (!weaveId || !state.me || !mayManageInvitations(state)) return;
    const token = state.me.token;
    const forWeave = weaveId;
    const n = invitationReads.next();
    const left = () => disposed || myGeneration !== generation || state.me?.token !== token || weaveId !== forWeave;
    void client.withToken(token).listInvitations(forWeave).then(
      (invitations) => {
        // Re-checked immediately before publishing. An older read landing after a newer one must not
        // bring back a row the newer one saw withdrawn (by another keeper, through the CLI or MCP).
        if (left() || n <= invitationReads.applied()) return;
        invitationReads.markApplied(n);
        set({ invitations, invitationsError: undefined });
      },
      (e: unknown) => {
        // The same guards as the success path. One watermark for answers and rejections alike: an
        // older read's rejection must not replace a newer read's rows with an error.
        if (left() || n <= invitationReads.applied()) return;
        invitationReads.markApplied(n);
        set({ invitationsError: messageOf(e) });
      },
    );
  };

```

  - In `refreshInfo`, directly before the line `    if (requests && "rs" in requests) {` add:

```ts
    // The pending invitations ride on every refresh, as the requests do, for a keeper only.
    readInvitations(myGeneration);
```

  - In `doLoad`, directly before the comment line that begins `      // A load that ends with an identity fetches that identity's read state (§6.1).` add:

```ts
      // And the pending invitations, for a keeper of a Weave that is not the Lobby (spec 2026-10-08 §9).
      readInvitations(myGeneration);
```

  - In the returned object, directly before the line `    dismissNamePrompt: () => { if (state.needsName) set({ needsName: false }); },` add:

```ts
    canManageInvitations: () => mayManageInvitations(state),
    async withdrawInvitation(invitationId) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      try { await w.withdrawInvitation(weaveId, invitationId); }
      catch (e) {
        // Refused (redeemed meanwhile, or this keeper demoted): the row stays until the re-read this
        // refresh makes, which drops one that was redeemed. The view's error path shows the message.
        scheduleRefresh();
        throw e;
      }
      // Committed server-side: the row leaves at once, and the refresh brings the rest up to date.
      if (state.invitations) set({ invitations: state.invitations.filter((i) => i.invitationId !== invitationId) });
      scheduleRefresh();
    },
```

- [ ] **Step 7: The panel.** Create `src/web/src/components/InvitationsPanel.tsx`:

```tsx
import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";

/** When an invitation was made, in the browser's clock: it may be days old, so the date is shown too. */
const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * The invitations still pending into this Weave (spec 2026-10-08 §9): a keeper's view in the
 * sidebar, with Withdraw on each direct one. A request's invitation is marked and has no button, since
 * the removal from the request's Thread is what withdraws it. Behaviour and class hooks only: where it
 * sits and how it looks belong to Paw's design session. It renders nothing before the page has loaded,
 * for anyone who is not a keeper here, and on the Lobby, which no invitation can target; an archived
 * Weave keeps it, since a withdrawal only removes access.
 *
 * A row withdrawn from this panel is hidden at once and for good: a withdrawn invitation never comes
 * back as pending, and a refresh that was already in flight may still carry it.
 */
export function InvitationsPanel({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(new Set());
  if (state.status !== "ready" || !session.canManageInvitations()) return null;
  const rows = (state.invitations ?? []).filter((i) => !withdrawn.has(i.invitationId));
  const withdraw = async (id: string) => {
    if (busy.has(id)) return;
    setBusy((b) => new Set([...b, id]));
    try {
      await session.withdrawInvitation(id);
      setWithdrawn((w) => new Set([...w, id]));
    } catch (e) {
      onError(e);
    } finally {
      setBusy((b) => { const next = new Set(b); next.delete(id); return next; });
    }
  };
  return (
    <section class="nav-section invitations">
      <div class="nav-head"><span class="sec">Pending invitations</span></div>
      {state.invitationsError !== undefined && <p class="error">Could not read the pending invitations: {state.invitationsError}</p>}
      {state.invitations !== undefined && state.invitationsError === undefined && rows.length === 0 && <p class="muted">No pending invitations.</p>}
      {rows.length > 0 && (
        <ul class="invitation-list">
          {rows.map((i) => (
            <li key={i.invitationId} class="invitation">
              <strong>{i.inviteeName}</strong>{` · thread "${i.targetThreadName}" · ${when(i.createdAt)} by ${i.createdByName ?? "someone"} `}
              {i.requestId === null
                ? <button type="button" class="btn btn-xs" disabled={busy.has(i.invitationId)} onClick={() => { void withdraw(i.invitationId); }}>Withdraw</button>
                : <span class="muted">Belongs to a request: remove the agent from the request's Thread to withdraw it.</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 8: The panel in the sidebar.** In `src/web/src/components/WeaveView.tsx`, directly after the import line `import { GuidelinesPanel } from "./GuidelinesPanel.js";` add `import { InvitationsPanel } from "./InvitationsPanel.js";`, and directly after the line `          <GuidelinesPanel state={state} session={session} onError={reportError} />` add:

```tsx
          {/* A keeper's view of the ways into this Weave still open (spec 2026-10-08 §9); it renders
              nothing for anyone else and on the Lobby. Its failures take the view's one error path. */}
          <InvitationsPanel state={state} session={session} onError={reportError} />
```

- [ ] **Step 9: Run them to verify they pass**

Run: `pnpm -r build && cd src/web && npx vitest run test/fold.test.ts test/components.test.tsx test/session.test.ts`
Expected: PASS, pristine.

- [ ] **Step 10: Typecheck, then the web suite whole**

Run: `pnpm -r typecheck && cd src/web && npx vitest run`
Expected: all green, pristine. Then `git diff --stat -- src/web/src/styles.css` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/web/src/session.ts src/web/src/components/InvitationsPanel.tsx src/web/src/components/WeaveView.tsx src/web/src/components/MessageList.tsx src/web/src/components/fold.ts src/web/test/components.test.tsx src/web/test/session.test.ts src/web/test/fold.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(web): a keeper's Pending invitations panel with Withdraw, and the withdrawal's Thread line" -m "The session reads the pending invitations beside the metadata on the load and on each coalesced refresh, only for a keeper of a Weave that is not the Lobby (mayManageInvitations, archived or not), fenced by generation, identity and Weave and ordered per read by its own watermark; withdrawInvitation drops the row at once and refreshes, and a refusal re-reads. InvitationsPanel lists each row with Withdraw on a direct one and the way to withdraw a request's; a failed read is shown, never an empty list. The Lobby's Thread view and folded runs gain weave.invitation_withdrawn. No CSS. Ripple repaired: the session() fake of components.test.tsx." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 7: the skills, and spec 2026-09-28 §7 amended

Spec §10, §13.4 (`skills.test.ts`). **This task carries the `skills.test.ts` case of spec §13.4.**

**Files:**
- Modify: `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-ask-for-review/SKILL.md`, `skills/loom-do-accepted-work/SKILL.md` (by the script in Step 3)
- Modify: `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (the dated amendment line and the same edits in §7.1, §7.2, §7.4, by the same script)
- Modify: `src/mcp-tools/test/skills.test.ts` (`FIELD_NAMES`; the repaired 2026-09-30 case; the new case)

**Interfaces:**
- Consumes: Task 1's `"weave.invitation_withdrawn"` in `EVENT_TYPES` (through `@loom/core`'s `dist`); Task 3's registered tools `list_invitations(targetWeaveId)` and `withdraw_invitation(targetWeaveId, invitationId)`; `remove_participant(threadId, participantId)`.
- Produces: the three skill files with the edits of spec §10, byte for byte; `FIELD_NAMES` gains no name, and its `invitationId` entry names the new places.

- [ ] **Step 1: Write the failing case, and repair the 2026-09-30 case.** In `src/mcp-tools/test/skills.test.ts`, in `describe("the drift guard over the real skills/ folder (spec 2026-09-28 §6)", ...)`, the case `the skills carry the four edits of spec 2026-09-30 §8.3` pins three texts this spec's §10 rewrites (the known ripple). Replace its first two `expect` lines and its `loom-do-accepted-work` line, so the case reads in full:

```ts
  it("the skills carry the four edits of spec 2026-09-30 §8.3", () => {
    const text = (name: string) => skills.find((s) => s.name === name)!.text;
    // As amended by spec 2026-10-08 §10, which adds weave.invitation_withdrawn beside weave.invited.
    expect(text("loom-work-in-a-thread")).toContain("- In the Lobby, as well: `request.opened` (a request you are eligible for), `weave.invited` (an invitation into a Weave) and `weave.invitation_withdrawn` (a keeper withdrew an invitation it had sent you), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.offer_withdrawn`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; `request.closed` to everyone it lists, when a request ends; and `listener.removed` naming you, when Loom removed your profile because you had not checked in for too long, which the `loom-do-accepted-work` skill handles.\n");
    expect(text("loom-work-in-a-thread")).toContain("\n   - A Lobby request event, `weave.invited`, `weave.invitation_withdrawn` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n");
    expect(text("loom-do-accepted-work").endsWith("\n- A `listener.removed` naming you in your Lobby inbox: Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities(profile)` with your whole profile to be found again, and keep your poll running at the `pollIntervalMs` it declares.\n- A `weave.invitation_withdrawn` naming you: a keeper of that Weave withdrew the invitation. Do not redeem it; `join_weave` refuses it, and nothing else is asked of you.\n")).toBe(true);
    expect(text("loom-request-helpers")).toContain("- `request.offered`: an offer, with the offerer's `participantId`.\n- `request.offer_withdrawn`: a helper's offer was withdrawn because Loom removed that helper for not checking in; it carries the helper's `participantId`. Do not `accept` that offer.\n");
  });

  it("the skills carry the edits of spec 2026-10-08 §10, and none says revoked", () => {
    const text = (name: string) => skills.find((s) => s.name === name)!.text;
    expect(text("loom-work-in-a-thread")).toContain(" `invite_to_weave`, `list_invitations` and `withdraw_invitation` act in the target Weave, so they take your token there, not your Lobby token.\n");
    expect(text("loom-work-in-a-thread")).toContain("\n- In the Lobby, as well: `request.opened` (a request you are eligible for), `weave.invited` (an invitation into a Weave) and `weave.invitation_withdrawn` (a keeper withdrew an invitation it had sent you), which the `loom-do-accepted-work` skill handles;");
    expect(text("loom-work-in-a-thread")).toContain("\n   - A Lobby request event, `weave.invited`, `weave.invitation_withdrawn` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n");
    expect(text("loom-ask-for-review")).toContain("Pass that token, ask a keeper, or use a Weave you keep.\n- You invited the wrong agent from the Lobby, or the review no longer needs it: `withdraw_invitation(targetWeaveId, invitationId)`, with the `invitationId` that `invite_to_weave` returned or that `list_invitations(targetWeaveId)` lists, before it is redeemed; the agent is told with `weave.invitation_withdrawn`. Once it has joined, take it off the Thread with `remove_participant(threadId, participantId)` instead.\n");
    expect(text("loom-do-accepted-work")).toContain("null for a direct invitation.\n- `weave.invitation_withdrawn` in your Lobby inbox: a keeper withdrew an invitation it had sent you; it carries the `invitationId` and `targetWeaveTitle`.\n");
    expect(text("loom-do-accepted-work")).toContain("\n- `join_weave` refuses the invitation: it was used or withdrawn. On an agent-key connection,");
    expect(text("loom-do-accepted-work").endsWith("\n- A `weave.invitation_withdrawn` naming you: a keeper of that Weave withdrew the invitation. Do not redeem it; `join_weave` refuses it, and nothing else is asked of you.\n")).toBe(true);
    for (const s of skills) expect(s.text.includes("revoked"), s.name).toBe(false);
  });
```

  In `FIELD_NAMES`, replace the entry line that is today, whole, `  ...group(["invitationId", "targetWeaveTitle"], "the weave.invited payload, invitationRowAndEvent in src/core/src/lobby/invitations.ts"),` with (spec §10: the `invitationId` entry's place, and no name added):

```ts
  ...group(["invitationId"], "the weave.invited and weave.invitation_withdrawn payloads, src/core/src/lobby/invitations.ts; the argument of withdraw_invitation, tools.ts"),
  ...group(["targetWeaveTitle"], "the weave.invited payload, invitationRowAndEvent in src/core/src/lobby/invitations.ts"),
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -r build && cd src/mcp-tools && npx vitest run test/skills.test.ts`
Expected: FAIL: the repaired 2026-09-30 case and the new case, each on its first `toContain` (the skill files still carry the old texts); every other case passes, the drift guard included. Capture this output for the report.

- [ ] **Step 3: The edits, by script.** No skill is edited by hand. From the worktree root run this once; it applies each edit of spec 2026-10-08 §10 to the skill file and to the 2026-09-28 spec's §7 copy of it, and the amendment line to that spec, refusing unless each old text occurs exactly once (the spec's working copy may be CRLF; it is read as LF, and git normalises it on add):

```bash
node --input-type=module <<'EDIT'
import fs from "node:fs";
const SPEC = "docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md";
const WORK = "skills/loom-work-in-a-thread/SKILL.md";
const ASK = "skills/loom-ask-for-review/SKILL.md";
const DO = "skills/loom-do-accepted-work/SKILL.md";
const FORBIDDEN = "- `forbidden` on `invite_participant` or `invite_to_weave`: only the Thread's creator or a keeper of the Weave may invite, and `invite_to_weave` needs a keeper of the target Weave, on your token there rather than your Lobby token. Pass that token, ask a keeper, or use a Weave you keep.\n";
const INVITED = "- `weave.invited` in your Lobby inbox: an invitation into a Weave; it carries `invitationId`, `targetWeaveTitle` and `requestId`, which is the request's id when your offer was accepted and null for a direct invitation.\n";
const REMOVED = "- A `listener.removed` naming you in your Lobby inbox: Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities(profile)` with your whole profile to be found again, and keep your poll running at the `pollIntervalMs` it declares.\n";
const edits = [
  { files: [WORK, SPEC],
    from: "`invite_to_weave` acts in the target Weave, so it takes your token there, not your Lobby token.",
    to: "`invite_to_weave`, `list_invitations` and `withdraw_invitation` act in the target Weave, so they take your token there, not your Lobby token." },
  { files: [WORK, SPEC],
    from: "- In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles;",
    to: "- In the Lobby, as well: `request.opened` (a request you are eligible for), `weave.invited` (an invitation into a Weave) and `weave.invitation_withdrawn` (a keeper withdrew an invitation it had sent you), which the `loom-do-accepted-work` skill handles;" },
  { files: [WORK, SPEC],
    from: "   - A Lobby request event, `weave.invited` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n",
    to: "   - A Lobby request event, `weave.invited`, `weave.invitation_withdrawn` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n" },
  { files: [ASK, SPEC],
    from: FORBIDDEN,
    to: FORBIDDEN + "- You invited the wrong agent from the Lobby, or the review no longer needs it: `withdraw_invitation(targetWeaveId, invitationId)`, with the `invitationId` that `invite_to_weave` returned or that `list_invitations(targetWeaveId)` lists, before it is redeemed; the agent is told with `weave.invitation_withdrawn`. Once it has joined, take it off the Thread with `remove_participant(threadId, participantId)` instead.\n" },
  { files: [DO, SPEC],
    from: INVITED,
    to: INVITED + "- `weave.invitation_withdrawn` in your Lobby inbox: a keeper withdrew an invitation it had sent you; it carries the `invitationId` and `targetWeaveTitle`.\n" },
  { files: [DO, SPEC],
    from: "- `join_weave` refuses the invitation: it was used, revoked or withdrawn.",
    to: "- `join_weave` refuses the invitation: it was used or withdrawn." },
  { files: [DO, SPEC],
    from: REMOVED,
    to: REMOVED + "- A `weave.invitation_withdrawn` naming you: a keeper of that Weave withdrew the invitation. Do not redeem it; `join_weave` refuses it, and nothing else is asked of you.\n" },
  { files: [SPEC],
    from: "`listener.removed` bullet, so the binding texts and the files agree.\n",
    to: "`listener.removed` bullet, so the binding texts and the files agree.\n\nAmended 2026-10-08 by the withdraw-invitation spec\n([2026-10-08-loom-withdraw-invitation-design.md](2026-10-08-loom-withdraw-invitation-design.md)\n§10): §7.1's credential paragraph names `list_invitations` and `withdraw_invitation`, and its\ninventory and routing gain `weave.invitation_withdrawn`; §7.2 gains the bullet on withdrawing a\nmistaken invitation; §7.4 gains the two `weave.invitation_withdrawn` bullets, and its `join_weave`\nbullet now reads \"used or withdrawn\", so the binding texts and the files agree.\n" },
];
const texts = new Map();
for (const e of edits) for (const f of e.files) {
  const t = texts.get(f) ?? fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const n = t.split(e.from).length - 1;
  if (n !== 1) { console.log(`EDIT MISMATCH: ${f} holds the old text ${n} times: ${e.from.slice(0, 60)}`); process.exit(1); }
  texts.set(f, t.split(e.from).join(e.to));
}
for (const [f, t] of texts) fs.writeFileSync(f, t);
console.log("seven edits applied to three skills and to spec 2026-09-28 section 7, with its amendment line");
EDIT
```

Expected: `seven edits applied to three skills and to spec 2026-09-28 section 7, with its amendment line`. An `EDIT MISMATCH` means the files are not the ones this plan was written against: stop and report. Then prove that the 2026-09-28 spec's §7 blocks and the four files are still the same bytes:

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
Expected: PASS, pristine: the drift guard passes over the edited files (every new code span is a registered tool, a call form with that tool's required arguments, `withdraw_invitation(targetWeaveId, invitationId)`, `list_invitations(targetWeaveId)` and `remove_participant(threadId, participantId)`, the event type `weave.invitation_withdrawn`, a skill name, or the `FIELD_NAMES` entries `invitationId` and `targetWeaveTitle`), `every FIELD_NAMES entry is used by at least one skill` still passes, and the em dash case passes.

- [ ] **Step 5: The suites that read the skills**

Run: `pnpm -r typecheck && cd src/mcp-tools && npx vitest run && cd ../server && npx vitest run test/static.test.ts test/mcp.test.ts`
Expected: all green, pristine (`static.test.ts` serves the edited skill files byte for byte).

- [ ] **Step 6: Commit**

```bash
git add skills docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md src/mcp-tools/test/skills.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs(skills): withdrawing a Weave invitation, in the three skills that mention invite_to_weave" -m "loom-work-in-a-thread names list_invitations and withdraw_invitation in its credential paragraph and weave.invitation_withdrawn in its inbox inventory and routing; loom-ask-for-review says how to take back a mistaken invitation; loom-do-accepted-work says what the event means and drops 'revoked' from its join_weave bullet. Spec 2026-09-28 section 7 is amended with the same bytes and a dated line. FIELD_NAMES' invitationId entry names its new places, and no name is added. Ripple repaired: skills.test.ts 'the skills carry the four edits of spec 2026-09-30 §8.3' (its three texts as amended)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 8: the cross-cutting docs, smoke test 12, the serial run and the totals

Spec §12, §14. **This task carries spec §14 (written into TESTING.md as smoke test 12; run with Paw after the deploy) and measures the totals.** Docs only, then the whole-branch run: no code or test changes. Every edit below replaces or follows one exact line or substring; the working copies of the docs may be CRLF, so match one line at a time. Where an old text carries an em dash, this plan names the line by its start and does not quote the dash.

**Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/KNOWN-ISSUES.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md`; the ledger.

**Interfaces:** consumes the names of Tasks 1 to 7; produces no code, and the measured totals.

- [ ] **Step 1: docs/ARCHITECTURE.md.**
  - In the rule-family row that begins `| Cross-Weave invitations |`, replace the substring `` `redeemInvitation` (single-use, identity checked against the recorded invitee) `` with `` `redeemInvitation` (single-use, identity checked against the recorded invitee), `listInvitations` (a keeper's view of the pending ones) and `withdrawInvitation` (a direct one, before it is redeemed) ``.
  - In the `weave_invitations` row, replace the substring ``and `revoked_at` (withdrawn by a removal).`` with:

```text
and `revoked_at` (withdrawn: by a removal for a request's invitation, by `withdrawInvitation` for a direct one; `withdrawnAt` in every public shape).
```

  - In the event table, directly after the row that begins ``| `weave.invited` |``, add:

```markdown
| `weave.invitation_withdrawn` | `{ invitationId, participantId, targetWeaveTitle, withdrawnBy, withdrawnByName }` (Lobby General; actor the withdrawing keeper's principal, `withdrawnByName` its name or `Keeper`; `participantId` = the invitee): ids, a title and a name, **never a secret** | `lobby/invitations.ts` |
```

  - Directly after the event table, replace the line

```text
The ten Lobby types all land in the Lobby's log: `participant.capabilities_changed` and `listener.removed` in its General
```

    with

```text
The eleven Lobby types all land in the Lobby's log: `participant.capabilities_changed`, `listener.removed` and `weave.invitation_withdrawn` in its General
```

  - In the inbox paragraph (it begins `Reads: `readEvents` pages by`), replace the substring ``naming you in `participantIds`, `weave.invited` and `listener.removed` naming you), excluding your own events, always`` with ``naming you in `participantIds`, `weave.invited`, `weave.invitation_withdrawn` and `listener.removed` naming you), excluding your own events, always``.
  - In the lock-order paragraph (it begins ``**Lock order Lobby → target.**``), replace the substring ``**Lock order Lobby → target.** `accept` and `inviteToWeave` need two Weave rows, and both take them`` with ``**Lock order Lobby → target.** `accept`, `inviteToWeave` and `withdrawInvitation` need two Weave rows, and all three take them``.
  - In §12, replace the line that is today, whole, `` `thread.removed`, `listener.removed` and `request.offer_withdrawn` are addressed-only too. `` with:

```text
`thread.removed`, `listener.removed`, `request.offer_withdrawn` and `weave.invitation_withdrawn` are addressed-only too.
```

- [ ] **Step 2: docs/SECURITY.md.**
  - In the authorization table, directly after the row that begins `| Invite a Lobby participant into a Weave |`, add:

```markdown
| List the pending invitations into a Weave | A keeper of that Weave | [`listInvitations`](../src/core/src/lobby/invitations.ts) |
| Withdraw a direct invitation | A keeper of the **target** Weave, re-checked inside its lock; allowed in an archived Weave; a request's invitation is refused | [`withdrawInvitation`](../src/core/src/lobby/invitations.ts) |
```

  - In the paragraph that begins `**No secret ever appears in a Lobby event, and an invitation is single-use.**`, on its line that begins `secret is in it. Redemption is`, replace the substring `secret is in it. Redemption is` with:

```text
secret is in it. `weave.invitation_withdrawn` (`withdrawInvitation`, the same file) carries `{ invitationId, participantId, targetWeaveTitle, withdrawnBy, withdrawnByName }`: ids, a title and a name, never a secret, and a core test scans for them too. Redemption is
```

  - In item 14 (it begins `14. **Cross-Weave invitations never expire.**`), replace the line that is today, whole, `    target Weave is the only containment, as it is for a Weave secret.` with:

```text
    target Weave is the only containment, as it is for a Weave secret. A keeper of the target can
    withdraw a direct invitation before it is redeemed (`withdraw_invitation`).
```

- [ ] **Step 3: docs/KNOWN-ISSUES.md.**
  - **Remove** the `core` row that begins ``| [lobby/invitations.ts](../src/core/src/lobby/invitations.ts) | A Weave invitation handed out with `invite_to_weave` (`loom invite-weave`) outside a request cannot be withdrawn`` (this slice fixes it): the whole line.
  - In the row that begins ``| [db/schema.ts](../src/core/src/db/schema.ts) | Cross-Weave invitations have no expiry``, replace the substring `unredeemed ones, and nothing else revokes one` with `` unredeemed ones, a keeper of the target may withdraw a direct one (`withdraw_invitation`), and nothing else withdraws one ``.
  - In the row that begins `| [export.ts](../src/core/src/export.ts) |`, replace the substring ``only `listener.removed` and `request.offer_withdrawn` have words`` with ``only `listener.removed`, `request.offer_withdrawn` and `weave.invitation_withdrawn` have words``.
  - In the row that begins ``| [lobby/invitations.ts](../src/core/src/lobby/invitations.ts) | On an `inviteToWeave` with no request, the `weave.invited` event's `actor` ``, replace the substring `which a Lobby reader cannot resolve to a name |` with ``which a Lobby reader cannot resolve to a name. `weave.invitation_withdrawn` has the same actor, and carries `withdrawnByName` so its readers name the keeper |``.
  - In `## web`, directly after the table's last row (it begins `| [components/listeners/ListenersPage.tsx](../src/web/src/components/listeners/ListenersPage.tsx) | Statuses, counts and rates are as of the read that carried them`), add:

```markdown
| [components/InvitationsPanel.tsx](../src/web/src/components/InvitationsPanel.tsx), [session.ts](../src/web/src/session.ts) | The target Weave's Pending invitations list moves on its own Withdraw at once, and otherwise only at the next coalesced refresh or a reload: a withdrawal by another keeper (from the CLI or MCP), a new invitation, and a redemption by an identity already in the Weave (which writes only `thread.invited` there) are not seen live, because `weave.invited` and `weave.invitation_withdrawn` land in the Lobby's log and a Weave view streams only its own Weave (spec 2026-10-08 §9) | the list is a keeper's housekeeping view, not a feed; a second stream for one panel is not worth it | a target-side event on invitation and withdrawal, or a Lobby subscription for keepers |
```

- [ ] **Step 4: docs/TESTING.md, the coverage table.** Each package row of "## What each package's tests cover" is one long line ending ` |`. Append the sentence given, with one space before it, directly before that row's closing ` |`:
  - `core`: `The withdraw-invitation slice adds withdrawInvitation and listInvitations (lobby-invitations.test.ts: the authority matrix, the in-lock re-check, the request and redeemed refusals, the idempotent repeat's original seq, withdraw racing redeem, an archived target, no secret in the event, the inbox), get_started forgetting a withdrawn invitation, the EVENT_TYPES position and the export line.`
  - `server`: ``The withdraw-invitation slice: `GET /api/weaves/:id/invitations` and `POST /api/weaves/:id/invitations/:invitationId/withdraw` in `lobby-routes.test.ts` (keeper, member, a request's, unknown, the repeat), and over `/mcp` `list_invitations` and `withdraw_invitation` with an agent key that keeps the target.``
  - `client`: ``The withdraw-invitation slice: `listInvitations` and `withdrawInvitation` round-tripped.``
  - `mcp-tools`: in this row replace the substring `(39 tools)` with `(41 tools)`, and append: ``The withdraw-invitation slice: `list_invitations` and `withdraw_invitation` (their place after `invite_to_weave`, their descriptions, the pass-through), the `weave.invitation_withdrawn` row of `REACTION_TABLE`, and the skills' edits with no skill saying "revoked".``
  - `cli`: ``The withdraw-invitation slice: `invite-weave list` and `invite-weave withdraw`, `--thread` missing as exit 2, and the `read` line of `weave.invitation_withdrawn`.``
  - `claude-channel`: ``The withdraw-invitation slice: `weave.invitation_withdrawn` wakes the invitee in both modes whatever `invites` says and nobody else, its two texts, the instructions' `type=` list, and the stored credential reaching the target's token for the two invitation tools.``
  - `web`: ``The withdraw-invitation slice: the Pending invitations panel (a keeper only, never the Lobby, archived too, Withdraw in flight and refused, a failed read never shown as empty), the session's invitation read fenced by generation and ordered per read, and its `withdrawInvitation`, and the Thread line and folded words of `weave.invitation_withdrawn`.``

- [ ] **Step 5: docs/TESTING.md, smoke test 12.** Replace the opening words `Eleven things the automated suites cannot cover` with `Twelve things the automated suites cannot cover`. At the end of the file, after smoke test 11's `*Last run:*` paragraph, add, with one empty line before it:

```markdown
**12. Withdrawing the mistaken invitations on the live instance.** After the deploy, one step at a
time with Paw, each result reported before the next; the controller fills in the real ids and the
live CLI configuration (as Claude-Code, keeper of Loom development) at each step.

1. The controller runs `loom invite-weave list` on Loom development: it lists the two direct
   invitations of 2026-10-02 (ids beginning `0c4621df` and `434d7d1f`), for Claude-Work and
   ChatGPT-Work, by Claude-Code, plus any other pending one, which the controller names to Paw.
2. Paw opens Loom development in the web: when Paw's participant there is a keeper, the Pending
   invitations section lists the same rows; when it is a member, the section is absent, which is
   also the expected behaviour (the controller says which beforehand, from `get_weave`).
3. The controller runs `loom invite-weave withdraw <the first id>`: `Withdrew invitation ... (seq
   N)`. Run again: `Invitation ... was already withdrawn (seq N)`, the same N.
4. The second is withdrawn through MCP: Claude-Code calls `withdraw_invitation` with Loom
   development's id and the second id: `created: true`.
5. `loom invite-weave list` no longer lists either.
6. Paw opens the Lobby in the web: its General Thread shows `invitation to "Loom development" for
   Claude-Work withdrawn by Claude-Code` and the same for ChatGPT-Work, each where it arrived.
7. Paw asks Claude-Work on the work PC to call `join_weave({ inviteId })` with its invitation id: it
   answers `forbidden` "This invitation was withdrawn". Its Lobby `inbox` carries the
   `weave.invitation_withdrawn` naming it, and its `get_started` lists no invitation into Loom
   development.
8. Paw asks ChatGPT-Work to read its Lobby inbox: it carries the `weave.invitation_withdrawn` naming
   it.
```

- [ ] **Step 6: CLAUDE.md and HANDBOOK.md.** In `CLAUDE.md`, replace `build-before-test, and the eleven manual smoke tests.` with `build-before-test, and the twelve manual smoke tests.`. In `docs/HANDBOOK.md`, replace `How the suites run, and the eleven manual smoke tests with a dated last-run paragraph each.` with `How the suites run, and the twelve manual smoke tests with a dated last-run paragraph each.`.

- [ ] **Step 7: docs/REVIEW-BRIEF.md, the branch.**
  - In the paragraph at the top, replace the substring ``**This branch is `feat/offline-listener-removal`: removing offline Listeners (2026-09-30).**`` with ``**This branch is `feat/withdraw-invitation`: withdrawing a Weave invitation (2026-10-08).**``; the rest of the paragraph stays.
  - In "## 1. What Loom is, and where it stands", replace the substring `listener status and agent skills;` with `listener status, agent skills and removing offline Listeners;`, and the substring `this branch removes offline Listeners.**` with `this branch lets a keeper withdraw a Weave invitation.**`.
  - Replace the whole of "## 1a. What **this** branch changes, and the promises it does not make", from its heading line through the line before `## 2. Scope`, with:

```markdown
## 1a. What **this** branch changes, and the promises it does not make

`feat/withdraw-invitation` lets a keeper of a Weave **see the invitations still pending into it and
withdraw a direct one** before it is redeemed, which closes the KNOWN-ISSUES row that said a Weave
invitation handed out with `invite_to_weave` could not be withdrawn (two such invitations into Loom
development were sent to the work-PC agents by mistake on 2026-10-02). `withdrawInvitation` has
`inviteToWeave`'s authority exactly (a keeper of the target, or the instance keeper token, re-checked
inside the target's lock), takes the Lobby's lock, then the target's, then the invitation row
`FOR UPDATE`, sets the existing `revoked_at`, and writes `weave.invitation_withdrawn` on the Lobby's
General Thread, addressed to the invitee; a later redemption answers `forbidden` "This invitation was
withdrawn". A request's invitation is refused (the removal from its Thread withdraws it), a redeemed
one too, and a repeat answers the original seq with `created: false`. `listInvitations` is a
keeper's read of the rows neither redeemed nor withdrawn, a request's listed and marked. The spec is
[superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md](superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md),
the plan
[superpowers/plans/2026-10-08-loom-withdraw-invitation.md](superpowers/plans/2026-10-08-loom-withdraw-invitation.md);
both were approved by Paw (PR #60). No migration, one new event type, no new error code, two new
routes, two new tools (41 in all), and no authority beyond the new action's, which is
`inviteToWeave`'s.

| Layer | What this branch changed |
| --- | --- |
| core | `listInvitations`, `withdrawInvitation` and their types (`lobby/invitations.ts`); `weave.invitation_withdrawn` at the end of `EVENT_TYPES`; the `inbox` arm it shares with `weave.invited`; the facade's two methods; the export line; the `revokedAt` comment (`db/schema.ts`) |
| server | `GET /api/weaves/:id/invitations`, `POST /api/weaves/:id/invitations/:invitationId/withdraw` (`routes/weaves.ts`); the MCP backend's two methods (`mcp/backend.ts`) |
| mcp-tools | `list_invitations` and `withdraw_invitation` after `invite_to_weave` (`tools.ts`); the two `LoomToolBackend` methods; the `weave.invitation_withdrawn` row of `REACTION_TABLE` (`onboarding.ts`) |
| client | `listInvitations`, `withdrawInvitation`, `PendingInvitation`, `WithdrawResult`; the type in `EventType` |
| claude-channel | `shouldWake` and the two texts (`format.ts`); the instructions' `type=` list and `invitation=` sentence (`server.ts`); the two backend methods over the client and with the stored credential (`backend.ts`, `stored.ts`) |
| cli | `invite-weave list` and `invite-weave withdraw <invitationId>`, `--thread` checked by the invite action (`commands/request.ts`); the `read` line (`commands/messages.ts`) |
| web | the session's invitation read, `mayManageInvitations`, `canManageInvitations` and `withdrawInvitation` (`session.ts`); `InvitationsPanel.tsx` (new) in the sidebar (`WeaveView.tsx`); the Thread line and folded words; no CSS |
| repo | three skills (`loom-work-in-a-thread`, `loom-ask-for-review`, `loom-do-accepted-work`) and spec 2026-09-28 §7 amended with the same bytes |
| docs | README, the core, server, client, mcp-tools, cli and channel READMEs, ARCHITECTURE, SECURITY (two authorization rows, the Lobby-event paragraph, item 14), TESTING (smoke test 12, the coverage lines, the totals, "twelve"), CLAUDE.md and HANDBOOK ("twelve"), KNOWN-ISSUES (the "cannot be withdrawn" row removed, three core rows amended, one web row), v2-notes, this brief |

**The promises it does not make**, stated in the spec's §17 and not to be re-reported: no expiry on
invitations and no automatic withdrawal; a request's invitation is not withdrawn through this call
(the removal from its Thread stays the one way); a redemption is not undone; nobody but the invitee
is told, and the target Weave's log gets nothing; the target's web panel is not live on another
client's withdrawal, invitation or redemption (KNOWN-ISSUES, the web row); no inviting or accepting
an invitation from the web; `revoked_at` is not renamed (public shapes say `withdrawnAt`); no paging
of `listInvitations`.

**Choices** are the spec's own, each marked **(choice)** in it, and the plan's "Decisions this plan
makes", and not drift.

```

  - In "## 2. Scope", in the first bullet, replace the lines from the one that begins `  should still judge where this branch changed it (` through the one that is today, whole, ``  the web's `session.ts`, `requests-state.ts`, `MessageList.tsx` and `fold.ts`).``, with:

```text
  should still judge where this branch changed it (`types.ts`, `inbox.ts`, `index.ts` (the facade's
  `listInvitations` and `withdrawInvitation`), `db/schema.ts` (the `revokedAt` comment) and
  `export.ts` (the new line) in core; `routes/weaves.ts` and `mcp/backend.ts` in the server;
  `tools.ts`, `backend.ts` and `onboarding.ts` in mcp-tools; the client's `client.ts` and
  `types.ts`; the channel's `format.ts`, `server.ts`, `backend.ts` and `stored.ts`; the CLI's
  `request.ts` and `messages.ts`; the web's `session.ts`, `WeaveView.tsx`, `MessageList.tsx` and
  `fold.ts`).
```

  - In the same section's list of specs, replace the line that is today, whole, `    **the spec for this branch**, with` (under the offline-removal spec) with `    (the previous branch: removing offline Listeners), with`, and directly before the line that begins `  - [superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md]` add:

```markdown
  - [superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md](superpowers/specs/2026-10-08-loom-withdraw-invitation-design.md)
    **the spec for this branch**, with
    [superpowers/plans/2026-10-08-loom-withdraw-invitation.md](superpowers/plans/2026-10-08-loom-withdraw-invitation.md)
    beside it. Its quoted texts are binding, byte for byte, and Paw accepted every **(choice)** in it
    as written. It amends the agent-skills spec's §7 (its dated line), which the skill files must
    still equal, and changes no other spec.
```

  - In "## 4. Where to start", in row 6, replace the substring `(all **39** tools,` with `(all **41** tools,`.
  - In "## 5. What we want back", replace the substring `For this branch the offline-removal spec is` with `For this branch the withdraw-invitation spec is`.
  - In "## 6. Questions we would especially like answered", in question 10 (its sentence runs over two lines), replace on its first line the substring `` `accept` is the only flow that takes two Weave `` with `Four flows take two Weave`, and on the next line the substring ``    rows (`withWeaveLocks`, Lobby first). Is there`` with ``    rows, Lobby first (`withWeaveLocks`): `accept`, `inviteToWeave`, a removal from a request's Thread, and `withdrawInvitation`. Is there``; then replace the questions of "For **this branch** specifically", from the line that begins `13. **Can a pass remove a Listener that is not removable at the moment of its lock?**` through the line that is today, whole, ``    that core would refuse, or a `null` lost on the way.``, with:

```markdown
13. **Can a withdrawal and a redemption both win?** `withdrawInvitation` takes the Lobby's lock, then
    the target's, then the invitation row `FOR UPDATE`; `redeemInvitation` takes only the target's,
    then the row. Find an interleaving that leaves a row both redeemed and withdrawn, a participant
    created from a withdrawn invitation, a `weave.invitation_withdrawn` for a redeemed one, or a
    deadlock between the two or with `accept` or a removal from a request's Thread.
14. **Is the authority exactly `inviteToWeave`'s?** `assertIsKeeperOf` before anything about the
    invitation is read, `assertStillKeeperOf` inside the target's lock. Find a caller other than a
    keeper of the target or an instance keeper that lists or withdraws, a demotion that slips
    between the two checks, or an answer that tells a non-keeper whether an invitation id exists.
15. **Is the idempotent answer honest?** A repeat answers `created: false` with the original
    withdrawal's seq, read from the Lobby log, and writes nothing. Find a direct row with
    `revoked_at` set that no `weave.invitation_withdrawn` names, or a request's invitation, withdrawn
    by a removal, that answers anything but the request refusal.
16. **Does the event reach exactly the invitee?** `weave.invitation_withdrawn` names its invitee in
    `participantId`: check `inbox`, `shouldWake` in both wake modes and with `invites` off, and the
    web, and that no secret, token or key is in its payload.
17. **Does every reader say the same thing?** The web line, the Markdown export, `loom read` and the
    channel's two texts against spec §7.5 and §8.1 to §8.3; and the CLI's three forms of
    `invite-weave` under commander's parsing (a participant id never taken for a subcommand,
    `--thread` missing as exit 2).
```

- [ ] **Step 8: docs/superpowers/specs/v2-notes.md.** In the entry whose heading is, whole, `### Withdrawing a Weave invitation (Paw, 2026-10-08): spec and plan`, replace that heading with `### Withdrawing a Weave invitation (Paw, 2026-10-08): built`, and after the entry's last paragraph add, with an empty line before it:

```markdown
**Built** by the withdraw-invitation slice on `feat/withdraw-invitation`
([spec](2026-10-08-loom-withdraw-invitation-design.md), [plan](../plans/2026-10-08-loom-withdraw-invitation.md)):
a keeper lists the pending invitations into its Weave and withdraws a direct one (REST, MCP
`list_invitations` and `withdraw_invitation`, `loom invite-weave list` and `withdraw`, the web's
Pending invitations panel); the invitee is told with `weave.invitation_withdrawn`. Smoke test 12
withdraws the two live invitations of 2026-10-02 after the deploy.
```

  The controller adds the implementation PR's number to that paragraph when it opens the PR (HANDBOOK §3 step 11).

- [ ] **Step 9: Build, typecheck and run everything, serially, from a clean build**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every package passes, with no stray output. If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop. Record per package (tests and files) and overall in the ledger, beside Task 0's baseline. The expected movement, for the controller to check against (the run's figures are the record, not these): core +20 tests (`lobby-invitations.test.ts` 17, `lobby-onboarding.test.ts` 1, `units.test.ts` 1, `export.test.ts` 1), server +3 (`lobby-routes.test.ts` 2, `mcp.test.ts` 1; the repaired catalog case adds none), client +1, mcp-tools +5 (`tools.test.ts` 3, `onboarding.test.ts` 1, `skills.test.ts` 1; the repaired cases add none), claude-channel +3 (`format.test.ts` 2, `backend.test.ts` 1; the repaired `channel.test.ts` case adds none), cli +4, web +13 (`components.test.tsx` 7, `session.test.ts` 5, `fold.test.ts` 1): **+49 tests, no new test file**. A difference is reported in the ledger with its reason, never smoothed.

- [ ] **Step 10: The checks the branch must pass whole**
  - `git diff --stat origin/main -- src/web/src/styles.css src/core/drizzle` prints nothing.
  - `git ls-files --eol skills` shows every row starting `i/lf    w/lf`.
  - `git diff origin/main | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"` prints `scan clean`.
  - `git diff --stat origin/main` shows no `Bin` row.
  - The words check: `git diff origin/main -- src skills | node -e "let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && /withdraw/i.test(l) && /revok|cancel/i.test(l) && !/revokedAt|revoked_at/.test(l)); console.log(hits.length ? 'CHECK:\n' + hits.join('\n') : 'words clean'); });"`: it prints `words clean`, or lines the controller reads to confirm no new user-facing word says "cancel" or "revoke".

- [ ] **Step 11: The totals in TESTING.md.** These are measured values, written in from Step 9's record; nothing is estimated. In "## Current totals":
  - Replace the opening words of the first paragraph, `As of **the offline-removal slice** on`, with `Before it, as of **the offline-removal slice** on`.
  - Directly before that paragraph, after the heading and its empty line, add one paragraph in the house shape, built from the ledger: the slice's name and branch (`the withdraw-invitation slice` on `feat/withdraw-invitation`), the head it was measured at, the total and each package's tests and files in the order core, web, server, claude-channel, cli, client, mcp-tools, the three commands it came from (`pnpm -r build`, `pnpm -r typecheck` (clean), `pnpm --workspace-concurrency=1 -r test`), Task 0's baseline (its sha, total and files), and what the slice added, by package and by file, as Step 9 recorded it. The paragraph that begins `As of **the offline-removal slice** on `feat/offline-listener-removal`` in today's file is the model to copy the shape from.

- [ ] **Step 12: The totals in REVIEW-BRIEF.md.** In §5, in these three lines

```text
  Postgres testcontainer or a reachable compose Postgres). Give the totals you saw; on this branch
  they should be **2423 tests in 80 files** (core 761/32, web 968/17, server 244/10,
  claude-channel 149/9, cli 85/5, client 50/4, mcp-tools 166/3), with `pnpm -r typecheck` clean.
```

  keep the first line as it is and write Step 9's figures into the other two, in the same order and the same `tests/files` form per package.

- [ ] **Step 13: Commit**

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md docs/KNOWN-ISSUES.md docs/TESTING.md CLAUDE.md docs/HANDBOOK.md docs/REVIEW-BRIEF.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs: withdrawing a Weave invitation; smoke test 12; the totals" -m "ARCHITECTURE, SECURITY, KNOWN-ISSUES (the 'cannot be withdrawn' row removed, three core rows amended, one web row added), v2-notes and the review brief as spec section 12 lists; TESTING gains smoke test 12, the coverage lines and the serial run measured on the branch against Task 0's baseline, and CLAUDE.md and HANDBOOK count twelve smoke tests." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

**After this task (controller, not an implementer):** the whole-branch review (HANDBOOK §3 step 10), its fix wave, then the PR (step 11), whose number the controller adds to the v2-notes paragraph of Step 8. **After the merge, on Paw's word for that PR:** `deploy\live-update.cmd` (no migration; it stops Loom for a few seconds), then smoke test 12 with Paw, one step at a time, which withdraws the two live invitations of 2026-10-02. Then remove the worktree: `git -C D:/git/Loom worktree remove D:/git/worktrees/Loom-withdraw-invitation`, `git -C D:/git/Loom worktree prune`, delete the merged branch, and check `git -C D:/git/Loom worktree list`.

---

## Decisions this plan makes (for the controller to confirm with Paw)

1. **Task split.** Nine tasks (0 to 8) against the spec's eight-task sketch: the spec's tasks 1 to 7 map one to one onto Tasks 1 to 7, and its task 8 (documentation, KNOWN-ISSUES, smoke test 12) is Task 8 with the serial run and the totals folded in. Each package's README is updated in its own package's task; the cross-cutting docs (ARCHITECTURE, SECURITY, KNOWN-ISSUES, TESTING, REVIEW-BRIEF, v2-notes) wait for Task 8 because they describe surfaces that exist only once every adapter is in. Reason: right-sizing (a docs-only task is acceptable only as the last), and `KNOWN-ISSUES` must not say `withdraw_invitation` exists before Task 3 adds it.
2. **The client's `EventType` member is in Task 2**, before the channel (4) and the web (6). Reason: both switch on `@loom/client`'s hand-written union, and the channel's and web's test fixtures are typed by it.
3. **MCP is one task across four packages** (mcp-tools, server, channel backend and stored wrapper). Reason: `LoomToolBackend` gains two required methods, so every implementer, the test fake included, must change in the same commit for `pnpm -r typecheck` to stay green.
4. **`FIELD_NAMES`' `invitationId` entry is grouped with `targetWeaveTitle` today** (one `group([...])` line, one place). Spec §10 says only that the `invitationId` entry's place changes, so the plan splits the line: `invitationId` gets the spec's new place, `targetWeaveTitle` keeps the old one. Nothing is added.
5. **The 2026-09-30 skills case is a ripple the spec does not name.** `skills.test.ts` "the skills carry the four edits of spec 2026-09-30 §8.3" pins two lines of `loom-work-in-a-thread` and the last line of `loom-do-accepted-work`, all three of which spec §10 rewrites or follows. The plan repairs it to the amended texts, exactly (not loosened): the `endsWith` now holds both last bullets.
6. **The tool count, 39, is asserted in five places** (`tools.test.ts` three times, `mcp.test.ts`, TESTING's coverage line) and REVIEW-BRIEF says "**39**"; the spec lists none of them. All become 41 in the task that adds the tools (tests) or in Task 8 (docs).
7. **A row withdrawn from the panel is also hidden by the panel itself**, beside the session dropping it from `invitations`. Reason: spec §13.7 asks the DOM test to see the row leave on success with a fake session whose state is fixed, and a refresh already in flight when the withdrawal commits could otherwise bring the row back until the next one; a withdrawn invitation never becomes pending again, so hiding it for the mount is always right.
8. **`mayManageInvitations(state)` is exported from `session.ts`** and `canManageInvitations()` is that function on the session's state. Reason: the DOM tests then gate on the real rule (keeper, not the Lobby, archived or not) rather than on a stub, which is what spec §13.7's "drawn for a keeper and not for a member, a link reader or in the Lobby; drawn in an archived Weave" can only test that way.
9. **The panel's markup.** Spec §9 names the hook `nav-section invitations` and the heading; the plan adds `invitation-list` and `invitation` for the rows, and reuses `nav-head`, `sec`, `btn btn-xs`, `muted` and `error`. The time is `toLocaleString()` (the date too, since an invitation may be days old). No CSS.
10. **The invitations read is fenced by generation, identity and Weave, and by a per-read watermark**: an answer is dropped when the load that asked has been replaced, when the token it asked with is no longer the session's (a `join()` changes identity without a new generation), or when the Weave changed; and, within one generation, when a newer read has already been acted on (`invitationReads`, a `createCounter()` like the listener count's `countReads`, one watermark for answers and rejections alike), so an older answer cannot bring back a row a newer read saw withdrawn and an older rejection cannot replace a newer read's rows with an error (external review round 1 on PR #60). A refused withdrawal schedules a refresh, which is the spec's "the list is re-read".
11. **The CLI's `read` test passes `--since`** (the withdrawal's seq minus one). Reason: the CLI test file shares one Lobby, and `read` pages oldest first, 500 to a page; the Lobby's General could outgrow it.
12. **The Lobby as a target is tested with the instance keeper.** Spec §4.2 checks the authority (step 2) before the Lobby rule (step 3), so Paw, who is not a keeper of the Lobby, is refused `forbidden` first; the instance keeper passes step 2 for any Weave and reaches `not_found`.
13. **Sentences the plan rewrites lose their em dashes**: the `inbox` doc comment (spec §6.3 rewrites it) and the `**Invitations**` and `**Lobby**` lines of the core, client and mcp-tools READMEs. Reason: the no-em-dash rule; those sentences are rewritten anyway.
14. **REVIEW-BRIEF question 10** said `accept` is the only flow that takes two Weave rows, which was already stale (`inviteToWeave`, a removal from a request's Thread). The plan corrects it while adding `withdrawInvitation`.
15. **The new `listInvitations` resolves `createdByName` with one extra read** over the page's distinct uuid principals, in whichever Weave the participant lives, as spec §5.2 rule 5 says; a principal no row resolves is `null`, tested by pointing one row's `created_by` at an unknown uuid.
16. **Beyond the spec's list**, each in the task named: the authority-matrix case also checks the facade's "Join the Weave first" for a key with no participant in the target (1); the client case also checks a non-keeper is refused (2); the MCP round trip also checks that the invitee cannot withdraw (3); the reaction-table case also re-checks `parseSkill("join-loom", ...)` (3); the CLI list case also checks the empty-list line (5).

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §13.1 a keeper of the target withdraws a direct invitation | 1 |
| §13.1 the authority matrix | 1 |
| §13.1 a keeper demoted after its credential was resolved is refused inside the lock | 1 |
| §13.1 a request's invitation is refused, whatever its state | 1 |
| §13.1 a redeemed invitation is refused | 1 |
| §13.1 unknown, malformed, another Weave's, and the Lobby as target | 1 |
| §13.1 a repeat is idempotent | 1 |
| §13.1 redeem after withdrawal is refused | 1 |
| §13.1 withdraw racing redeem: redeem wins when it commits first | 1 |
| §13.1 withdraw racing redeem: exactly one wins | 1 |
| §13.1 an archived target Weave: withdrawal still works | 1 |
| §13.1 no withdrawal event carries a secret or a token | 1 |
| §13.1 the inbox | 1 |
| §13.1 get_started forgets a withdrawn invitation (`lobby-onboarding.test.ts`) | 1 |
| §13.1 listInvitations lists what is pending, oldest first | 1 |
| §13.1 listInvitations resolves createdByName | 1 |
| §13.1 listInvitations authority | 1 |
| §13.1 listInvitations in an archived Weave | 1 |
| §13.1 `units.test.ts`: EVENT_TYPES holds the type after weave.invited | 1 |
| §13.1 `export.test.ts`: a Lobby export after a withdrawal carries the line of §8.3 | 1 |
| §13.2 `lobby-routes.test.ts`: GET as a keeper `{ invitations }`, as a member 403 | 2 |
| §13.2 `lobby-routes.test.ts`: POST withdraw 200 created true, then created false with the same seq; a request's 400; unknown 404; a non-keeper 403 | 2 |
| §13.2 `mcp.test.ts`: list_invitations and withdraw_invitation over /mcp with an agent key whose target participant is a keeper | 3 |
| §13.2 `mcp.test.ts`: the tool list includes both | 3 |
| §13.3 listInvitations unwraps the array, withdrawInvitation round-trips both created values | 2 |
| §13.4 `tools.test.ts`: LOOM_TOOL_NAMES holds the two names after invite_to_weave | 3 |
| §13.4 `tools.test.ts`: both descriptions as §7.4 | 3 |
| §13.4 `tools.test.ts`: each passes its arguments to the backend unchanged | 3 |
| §13.4 `onboarding.test.ts`: REACTION_TABLE holds the row after the weave.invited row; renderDocument still passes parseSkill; the no-em-dash case covers it | 3 |
| §13.4 `skills.test.ts`: the existing guard passes over the edited files | 7 |
| §13.4 `skills.test.ts`: the skills carry the edits of spec 2026-10-08 §10, and no skill contains "revoked" | 7 |
| §13.5 `invite-weave list`: one line each, a request's marked, `(no pending invitations)`, `--json` `{ invitations }` | 5 |
| §13.5 `invite-weave withdraw <id>`: the seq, the repeat's line with the same seq, a request's exits non-zero with the validation message | 5 |
| §13.5 the existing `invite-weave <participantId> --thread <id>` cases unchanged; without `--thread` exit 2 with the message | 5 |
| §13.5 `loom read` renders the line of §7.5 | 5 |
| §13.6 `format.test.ts`: shouldWake for the participant named in both modes and with invites off; another in neither, wake all included | 4 |
| §13.6 `format.test.ts`: the two texts of §8.1; meta.invitation set | 4 |
| §13.6 `channel.test.ts`: the pinned instructions substring and the `invitation=` sentence | 4 |
| §13.6 `backend.test.ts`: the two methods with credential stored reach the target Weave's token | 3 |
| §13.7 `components.test.tsx`: systemLine renders the line of §8.2 | 6 |
| §13.7 `components.test.tsx`: drawn for a keeper, not for a member, a link reader or in the Lobby | 6 |
| §13.7 `components.test.tsx`: drawn in an archived Weave | 6 |
| §13.7 `components.test.tsx`: a direct row has Withdraw, a request's has none | 6 |
| §13.7 `components.test.tsx`: Withdraw calls the session once, disables while in flight, removes the row on success | 6 |
| §13.7 `components.test.tsx`: a refused withdrawal shows on the error bar and keeps the row | 6 |
| §13.7 `components.test.tsx`: a failed read shows the section's error, never "No pending invitations" | 6 |
| §13.7 `session.test.ts`: read on load and on a refresh only for a keeper | 6 |
| §13.7 `session.test.ts`: an answer for a left Weave or identity is dropped | 6 |
| §13.7 `session.test.ts`: an older answer or rejection within the same generation never replaces a newer one | 6 |
| §13.7 `session.test.ts`: withdrawInvitation removes the row and schedules a refresh | 6 |
| §13.7 `fold.test.ts`: runSummary counts the type in its words | 6 |
| §14 smoke test 12 (written into TESTING.md; run with Paw after the deploy) | 8 |

Every spec section is covered: §3 and §4 (Task 1), §5 (1), §6 (1; the client's union in 2), §7.1 (1), §7.2 and §7.3 (2), §7.4 (3), §7.5 (5), §8.1 (4), §8.2 (6), §8.3 (1), §9 (6), §10 (7), §11 (1, 2, 5), §12 (each package's README in its task, the rest in 8), §13 (above), §14 (8), §15 (this plan's split, Decision 1), §16 (1: the authority order, the in-lock re-check, the secrets scan; 8: SECURITY.md).
