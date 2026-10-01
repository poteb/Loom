# Loom: removing offline Listeners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Lobby Listener that has not checked in for longer than the instance setting `removeOfflineListenersAfterMs` (a day by default, an hour to 30 days, `null` for never) and reads offline is taken out of the directory by a third pass of the server's one-minute sweep: Loom clears its profile, deletes its open offers, and writes `listener.removed` (to the Listener) and one `request.offer_withdrawn` per withdrawn offer (to the requester); everything else stays, and it comes back with `set_capabilities`.

**Architecture:** Core gains one nullable `bigint` column (`settings.remove_offline_listeners_after_ms`, migration 0009) with its one validation rule in `settings.ts`, a new module `src/core/src/lobby/removal.ts` (`isRemovable`, pure; `sweepOfflineListeners`, one candidate query then one transaction per Listener under the Lobby lock, re-reading the participant row `FOR UPDATE`), `isOnline` in `lobby/status.ts` (the status rule's step 1, now shared), two event types and two `inbox` arms, and `me.removed` in the onboarding facts. The server runs the pass third in `sweepNow`; REST, the client and the CLI carry the setting; `@loom/mcp-tools` carries the texts (state 2, the reaction table, the `keeper_set_settings` description) and three skills gain a line; the channel wakes on both events; the web session re-runs the open directory on `listener.removed` and the request reducer drops a withdrawn offer. Behaviour only on the web: no CSS.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes, `verbatimModuleSyntax`), pnpm 10 workspace, Node 24, Vitest 4 against a real Postgres 17 testcontainer (`fileParallelism: false`; mcp-tools with no database), drizzle-orm 0.45.2 with drizzle-kit 0.31.10 on postgres-js 3.4.9, zod 4.6.1, Hono 4, Preact with happy-dom for the DOM tests. **No `package.json` gains a dependency anywhere in this plan.**

**Spec:** `docs/superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md`, approved by Paw on 2026-10-01 after its review rounds, internal and external, and their fixes (PR #53, head 955ff2f). Read it whole before any task; it is the binding requirement text, and every text it quotes (messages, payloads, the state 2 lines, the reaction table row, the skill edits, the channel `type=` list, the Thread lines) is transcribed into this plan byte for byte, never paraphrased. The spec's **(choice)** marks are requirements. Where this plan decides something the spec leaves open, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `D:/git/Loom/.superpowers/sdd/2026-09-30-loom-offline-listener-removal/progress.md`.

**Base:** branch `feat/offline-listener-removal` off `origin/main` **after the docs PR carrying the spec and this plan (PR #53) merges**, in the worktree `D:/git/worktrees/Loom-offline-listener-removal`. From `main` this plan consumes, unchanged unless a task says otherwise: `getSettings`, `updateSettings`, `patchSchema`, `toSettings` (`src/core/src/settings.ts`); `Settings`, `EVENT_TYPES`, `EventType`, `LoomEvent` (`src/core/src/types.ts`); `withWeaveLock`, `NewEvent`, `readEvents` (`src/core/src/events.ts`); `stampSeen`, `resolveCredential`, `resolveInWeave`, `participantForAgent` (`src/core/src/actors.ts`); `isLive`, `Profile` (`src/core/src/lobby/matching.ts`); `listenerStatus`, `intervalOf`, `DEFAULT_POLL_INTERVAL_MS` (`src/core/src/lobby/status.ts`); `getLobby`, `lobbyGeneralThreadId`, `ensureLobby`, `joinLobby` (`src/core/src/lobby/lobby.ts`); `stillRunning`, `openRequest`, `offer`, `accept`, `complete`, `cancelRequest`, `getRequest`, `sweepRequests`, `sweepOverdue` (`src/core/src/lobby/requests.ts`); `setCapabilities`, `findAgents` (`src/core/src/lobby/profile.ts`); `listListeners` (`src/core/src/lobby/listeners.ts`); `inbox` (`src/core/src/inbox.ts`); `onboardingFacts`, `OnboardingFacts` (`src/core/src/lobby/onboarding.ts`); the facade `createCore` (`src/core/src/index.ts`); `freshDb`, `closeTestDb`, `keeperToken` (`src/core/test/helpers.ts`); in `src/core/test/migration-status.test.ts` `freshDatabase`, `writeTruncatedRealFolder`; in `src/core/test/settings-keepers.test.ts` `keeperActor`; in `src/core/test/lobby-onboarding.test.ts` `listener`, `agentKey`, `keeper`, `MODEL`, `core`, `db`, `lobbyId`; in `src/core/test/status.test.ts` `NOW`, `ago`, `P`; `buildApp`, `SweepResult` (`src/server/src/app.ts`); `adminRoutes` (`src/server/src/routes/admin.ts`); `startTestServer`, `api` (`src/server/test/helpers.ts`); in `src/server/test/lobby-routes.test.ts` `scenario`, `openRequest`, `acceptedRequest`, `sqlUnsafe`, `KEEPER`; in `src/server/test/routes.test.ts` `KEEPER`, `creator`; `Settings`, `EventType` (`src/client/src/types.ts`); in `src/client/test/client.test.ts` `anon`; `SETTING_PARSERS`, the `admin settings` command (`src/cli/src/commands/admin.ts`); `formatEvent` (`src/cli/src/commands/messages.ts`), `hhmm` (`src/cli/src/commands/request.ts`); in `src/cli/test/cli-more.test.ts` `run`; in `src/cli/test/lobby.test.ts` `run`, `scenario`, `open`, `hhmm`, `lobbyWeaveId`, `s`; `OnboardingFacts`, `situation`, `REACTION_TABLE`, `renderState`, `renderDocument` (`src/mcp-tools/src/onboarding.ts`); the `keeper_set_settings` registration (`src/mcp-tools/src/tools.ts`); in `src/mcp-tools/test/onboarding.test.ts` `fresh`, `joined`, `profiled`, `PROFILE_LINES`, `TABLE`, `corpus`, `ME`; in `src/mcp-tools/test/tools.test.ts` `SET_UP`, `client`, `text`, `described`; in `src/mcp-tools/test/skills.test.ts` the drift guard's `skills`; `formatEvent`, `shouldWake`, `hhmm` (`src/claude-channel/src/format.ts`), `INSTRUCTIONS` (`src/claude-channel/src/server.ts`); in `src/claude-channel/test/format.test.ts` `ev`, `weave`, `names`; in `src/claude-channel/test/channel.test.ts` `withChannel`, `stateDir`; in `src/web/src/session.ts` `onEvent`, `workFns`, `readMyProfile`, `scheduleRefresh`; `REQUEST_EVENTS`, `isRequestEvent`, `changesWork`, `applyEvent` (`src/web/src/requests-state.ts`); `systemLine`, `clock` (`src/web/src/components/MessageList.tsx`); `WORDS`, `runSummary` (`src/web/src/components/fold.ts`); in `src/web/test/session.test.ts` `s`, `anon`, `lobbyFixture`, `asListener`, `sideReadClient`, `onCall`, `parks`, `makeGate`, `MY_PROFILE`, `aProfile`, `fixtureN`, `lobbyId`, `waitFor`; in `src/web/test/requests-state.test.ts` `ev`, `two`, `accept`; in `src/web/test/components.test.tsx` `lobbyState`; in `src/web/test/fold.test.ts` `ev`.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/offline-listener-removal`, worktree `D:/git/worktrees/Loom-offline-listener-removal`. **All git worktrees go under `D:/git/worktrees`, never inside the repo** (no `.claude/worktrees`, no `.worktrees`). One commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 8 is done and the whole-branch review (HANDBOOK §3 step 10) has run. The controller dispatches every implementer and reviewer **in the background** (`run_in_background: true`, `model: "opus"`), and reads every diff itself before the next dispatch.
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, skill files, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that sentence. A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Never write a `\uXXXX` escape into a file**: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row.
- **The scan, before every commit.** After staging, run exactly this from the worktree root; it must print `scan clean`. It looks at added lines only, for the two mojibake openers (U+00C2, and U+00E2 followed by U+20AC) and the em dash, built with `String.fromCharCode` so this plan does not contain them:

```bash
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
```

- **Never run `vitest list`** (it once overwrote test files). Run tests with `npx vitest run <files>` inside the package, or the scripts below.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test and the rule tested once, in `core`; adapters test wiring. Pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker (core, server, client, cli, claude-channel and web use the testcontainer; mcp-tools does not). **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test across packages:** `pnpm -r build` whenever a task touches more than one package, and before any suite reads another package's change (workspace packages resolve to `dist`; the channel suite spawns `dist/server.js`; the mcp-tools drift guard reads `@loom/core`'s `dist`). `pnpm -r typecheck` (sources and tests) is green at the end of every task.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.
- **Layering:** every rule lives in `@loom/core` and is tested there once: the removal rule (`isRemovable`), the pass (`sweepOfflineListeners`), the setting's bounds (`validateRemoveOfflineListenersAfterMs`), who an event reaches (`inbox`) and the removal fact (`onboardingFacts`). REST passes the value through with a type-only schema; the client and the CLI carry types and words; `@loom/mcp-tools`, the channel and the web carry text and presentation only.
- **`skills/** text eol=lf`** (`.gitattributes`, unchanged): every file under `skills/` is LF in the working tree. Check with `git ls-files --eol skills` before committing Task 4: every row starts `i/lf    w/lf`. Everything under `src/core/drizzle/` and every `*.sql` is LF too; check `git ls-files --eol src/core/drizzle` before committing Task 1.
- **Error codes:** the fixed set only. **No new code.** The two new messages are verbatim:
  - core: `removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)`
  - CLI: `removeOfflineListenersAfterMs must be a whole number of milliseconds, or off`
- **Values:** `MIN_REMOVE_OFFLINE_MS = 3_600_000`, `MAX_REMOVE_OFFLINE_MS = 2_592_000_000`, `DEFAULT_REMOVE_OFFLINE_MS = 86_400_000`; the column `remove_offline_listeners_after_ms bigint DEFAULT 86400000`, nullable; exactly the limit is kept, 1 ms more is removed; the Listener must also read offline by `isOnline` (twice its declared `pollIntervalMs`, 15 minutes when none, never seen is offline); `reason` is always `"offline"`; actor `system` on both events; `listener.removed` on the Lobby's General Thread, `request.offer_withdrawn` on the request's Thread; `listener.removed` takes `lobby.lastSeq + 1` and the i-th withdrawal (0-based) `lobby.lastSeq + 2 + i`; `EVENT_TYPES` gains `"listener.removed"` directly after `"participant.capabilities_changed"` and `"request.offer_withdrawn"` directly after `"request.offered"`.
- **Migration 0009** is generated by `drizzle-kit generate` (`pnpm --filter @loom/core db:generate`), contains only `ALTER TABLE "settings" ADD COLUMN "remove_offline_listeners_after_ms" bigint DEFAULT 86400000;`, has its journal entry (idx 9, `when` greater than 1790524135149) and `meta/0009_snapshot.json`, and passes `assertTransactionSafe`.
- **One clock per pass.** `sweepOfflineListeners` reads the setting once and decides every candidate at the `now` it was given; the cutoff and `now` travel as bind parameters, never Postgres's `now()`.
- **Visual design is Paw's separate design session.** The web task adds behaviour and text only; **no CSS**, no `styles.css` edit, no new class.
- **The known ripples.** A new required field or a changed list reaches exact assertions elsewhere. Each is repaired **only by adding what the new rule gives**, never by loosening an assertion, and each repaired test is named in the commit body. The ones known at plan time are listed in the task that causes them (Task 1: `settings-keepers.test.ts` "returns defaults on first read"; Task 2: `units.test.ts` "EVENT_TYPES holds every type the EventType union named..."; Task 3: `lobby-routes.test.ts` "sweepNow runs the expiry pass and the overdue pass with one now and resolves to { closed, overdue }"; Task 4: `lobby-onboarding.test.ts` "facts with a participant and no profile have hasProfile false", and in mcp-tools the fixtures `joined`, `profiled` (`onboarding.test.ts`) and `SET_UP` (`tools.test.ts`) and the `TABLE` constant (`onboarding.test.ts`); Task 5: `channel.test.ts` "the instructions list the three new types"). A red case of any other shape is a finding and stops the task.
- **Shared test databases.** The server, client, cli, channel and web suites share one database per file and run a real sweep interval (60 s). A test there that makes a Listener removable ages **only its own** Listener, and restores any setting it changes before it ends.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/db/schema.ts` (modify) | `settings.removeOfflineListenersAfterMs` (`bigint`, `mode: "number"`, default 86400000) |
| `src/core/drizzle/0009_<generated>.sql`, `src/core/drizzle/meta/0009_snapshot.json`, `src/core/drizzle/meta/_journal.json` (generated) | migration 0009 |
| `src/core/src/settings.ts` (modify) | the three bounds, `validateRemoveOfflineListenersAfterMs`, the patch key, `toSettings` |
| `src/core/src/types.ts` (modify) | `Settings.removeOfflineListenersAfterMs` (Task 1); the two event types in `EVENT_TYPES` (Task 2) |
| `src/core/src/lobby/status.ts` (modify) | `isOnline`; `listenerStatus` rewritten to call it, no behaviour change |
| `src/core/src/lobby/removal.ts` (new) | `isRemovable`, `RemovalOptions`, `sweepOfflineListeners` |
| `src/core/src/inbox.ts` (modify) | the `listener.removed` arm; `request.offer_withdrawn` joins the `to` arm of `request.completed` and `request.overdue` |
| `src/core/src/index.ts` (modify) | the facade's `sweepOfflineListeners` |
| `src/core/src/lobby/onboarding.ts` (modify) | `OnboardingFacts.me.removed` and the read behind it (Task 4) |
| `src/core/test/lobby-removal.test.ts` (new) | spec §13.1 `isRemovable` and the twenty Postgres cases |
| `src/core/test/settings-keepers.test.ts`, `migration-status.test.ts`, `units.test.ts`, `status.test.ts`, `lobby-onboarding.test.ts` (modify) | spec §13.1, the existing files |
| `src/server/src/app.ts`, `src/server/src/routes/admin.ts` (modify) | the third pass and `SweepResult.removed`; the body schema's new key |
| `src/server/test/routes.test.ts`, `src/server/test/lobby-routes.test.ts` (modify) | spec §13.2 |
| `src/client/src/types.ts` (modify) | `Settings.removeOfflineListenersAfterMs`; the two types in `EventType` |
| `src/client/test/client.test.ts` (modify) | spec §13.3 |
| `src/cli/src/commands/admin.ts`, `src/cli/src/commands/messages.ts` (modify) | the parser, the help, the `off` output; the two `loom read` lines |
| `src/cli/test/cli-more.test.ts`, `src/cli/test/lobby.test.ts` (modify) | spec §13.4 |
| `src/mcp-tools/src/onboarding.ts`, `src/mcp-tools/src/tools.ts` (modify) | `me.removed` in the declared facts, state 2's two texts, the reaction table row; the `keeper_set_settings` description |
| `src/mcp-tools/test/onboarding.test.ts`, `tools.test.ts`, `skills.test.ts` (modify) | spec §13.5 |
| `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-do-accepted-work/SKILL.md`, `skills/loom-request-helpers/SKILL.md` (modify) | the four edits of spec §8.3 |
| `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (modify) | the dated amendment line and the same four edits in §7.1, §7.3, §7.4 |
| `src/claude-channel/src/format.ts`, `src/claude-channel/src/server.ts` (modify) | `shouldWake` and the two notification texts; the instructions' `type=` list |
| `src/claude-channel/test/format.test.ts`, `src/claude-channel/test/channel.test.ts` (modify) | spec §13.6 |
| `src/web/src/session.ts`, `src/web/src/requests-state.ts`, `src/web/src/components/MessageList.tsx`, `src/web/src/components/fold.ts` (modify) | spec §9.1 |
| `src/web/test/requests-state.test.ts`, `session.test.ts`, `components.test.tsx`, `fold.test.ts` (modify) | spec §13.7 |
| `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`, `src/server/README.md`, `src/cli/README.md`, `src/mcp-tools/README.md`, `src/claude-channel/README.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/KNOWN-ISSUES.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §11, §12, §14 (Task 7); the totals (Task 8) |

**Why nine tasks (0 to 8).** Each carries its own test cycle and could be rejected alone: the setting and its migration (1) before the rule that reads it (2); the rule with its events and its inbox in one diff, because a reviewer judging "who is removed, what is written, who is told" wants all three together; then every adapter of the setting plus the sweep wiring and the CLI's event lines (3), since the client type and the CLI's `Record<keyof Settings, ...>` parser must change in the same commit to keep `pnpm -r typecheck` green, and the client's `EventType` union must exist before the channel and the web can switch on the new types. Task 4 holds everything an agent is told: the core fact `me.removed` goes here, not in Task 2, because spec §13.5 asks that the task adding the key also repair the mcp-tools fixtures that declare it. The channel (5) and the web (6) are separate readers. Docs (7) and the whole-branch run with the totals (8) close.

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git -C D:/git/Loom fetch origin && git -C D:/git/Loom log origin/main --oneline -5` shows the squash commit of PR #53, and `git -C D:/git/Loom show origin/main:docs/superpowers/plans/2026-09-30-loom-offline-listener-removal.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Create the worktree and the branch, outside the repo:

```bash
cd D:/git/Loom
git worktree add D:/git/worktrees/Loom-offline-listener-removal -b feat/offline-listener-removal origin/main
cd D:/git/worktrees/Loom-offline-listener-removal
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Confirm the code this plan was written against is still there, from the worktree root: `node -e "console.log(require('./src/core/drizzle/meta/_journal.json').entries.at(-1).tag)"` prints `0008_fluffy_tomas`; `grep -c "guidelines: z.string().transform(validateGuidelines).optional()," src/core/src/settings.ts` prints `1`; `grep -c "export async function sweepOverdue" src/core/src/lobby/requests.ts` prints `1`; `grep -c "export function listenerStatus" src/core/src/lobby/status.ts` prints `1`; `grep -c "export type SweepResult = { closed: number; overdue: number };" src/server/src/app.ts` prints `1`; `grep -c '|request.completed|request.overdue|thread.removed" from=' src/claude-channel/src/server.ts` prints `1`; `ls src/core/src/lobby/removal.ts` fails. If any differs, stop and report: someone has added a migration or reshaped the code since the spec was written.
- [ ] Confirm the ledger folder is ignored: `git -C D:/git/Loom check-ignore -v .superpowers` prints a rule. If it prints nothing, stop and report (the folder holds real secrets; HANDBOOK §5).
- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. TESTING.md "Current totals" records **2368 tests in 79 files** after the agent-skills slice. Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `D:/git/Loom/.superpowers/sdd/2026-09-30-loom-offline-listener-removal/progress.md` (create the folder). Task 8 compares against that record and must not estimate. If the figures differ from TESTING.md's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---

### Task 1: core: migration 0009 and the `removeOfflineListenersAfterMs` setting

Spec §4. **This task carries the three `settings-keepers.test.ts` cases and the `migration-status.test.ts` case of spec §13.1.**

**Files:**
- Modify: `src/core/src/db/schema.ts` (the import line; the `settings` table, after `lobbyTitle`)
- Generate: `src/core/drizzle/0009_<drizzle-kit's name>.sql`, `src/core/drizzle/meta/0009_snapshot.json`, `src/core/drizzle/meta/_journal.json`
- Modify: `src/core/src/settings.ts`
- Modify: `src/core/src/types.ts` (the `Settings` type)
- Test: `src/core/test/settings-keepers.test.ts`, `src/core/test/migration-status.test.ts`

**Interfaces:**
- Consumes: `getSettings(db)`, `updateSettings(db, actor, patch)`, `errors.validation(msg)`, `runMigrations(db, folder?)`, `writeTruncatedRealFolder(drop)`, `freshDatabase()`.
- Produces:

```ts
// src/core/src/db/schema.ts
settings.removeOfflineListenersAfterMs; // column "remove_offline_listeners_after_ms" bigint, nullable, default 86400000; $inferSelect: number | null

// src/core/src/settings.ts
export const MIN_REMOVE_OFFLINE_MS = 3_600_000;       // 1 hour
export const MAX_REMOVE_OFFLINE_MS = 2_592_000_000;   // 30 days
export const DEFAULT_REMOVE_OFFLINE_MS = 86_400_000;  // 1 day
export function validateRemoveOfflineListenersAfterMs(v: unknown): number | null;

// src/core/src/types.ts
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string;
  removeOfflineListenersAfterMs: number | null };
```

- [ ] **Step 1: Write the failing settings cases.** In `src/core/test/settings-keepers.test.ts`, change the import `import type { Actor } from "../src/types.js";` to:

```ts
import type { Actor, Settings } from "../src/types.js";
```

In the case "returns defaults on first read", replace the expectation with (the known ripple: the exact shape gains the key with the column default):

```ts
    expect(await getSettings(db)).toEqual({ instanceName: "Loom", maxMessageLength: 20000, openWeaveCreation: true, guidelines: DEFAULT_INSTANCE_GUIDELINES,
      removeOfflineListenersAfterMs: 86_400_000 });
```

After the closing `});` of `describe("settings", ...)` add:

```ts
describe("the offline-removal limit (spec 2026-09-30 §4.1)", () => {
  const MESSAGE = "removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)";

  it("updateSettings accepts 3600000, 2592000000 and null, and each reads back", async () => {
    const k = await keeperActor();
    for (const v of [3_600_000, 2_592_000_000, null]) {
      expect((await updateSettings(db, k, { removeOfflineListenersAfterMs: v })).removeOfflineListenersAfterMs).toBe(v);
      expect((await getSettings(db)).removeOfflineListenersAfterMs).toBe(v);
    }
  });

  it("updateSettings refuses 3599999, 2592000001, 1.5, the string 1h, true and {} with the exact message", async () => {
    const k = await keeperActor();
    for (const v of [3_599_999, 2_592_000_001, 1.5, "1h", true, {}]) {
      await expect(updateSettings(db, k, { removeOfflineListenersAfterMs: v } as unknown as Partial<Settings>))
        .rejects.toMatchObject({ code: "validation", message: MESSAGE });
    }
    expect((await getSettings(db)).removeOfflineListenersAfterMs).toBe(86_400_000);
  });
});
```

- [ ] **Step 2: Write the failing migration case.** In `src/core/test/migration-status.test.ts`, inside `describe("migrationStatus against the real migrations", ...)`, directly before the case "a database ahead of the journal is drift, and the message carries the remedy", add:

```ts
  it("migration 0009 gives an existing settings row the 1 day default (spec 2026-09-30 §4.2)", async () => {
    const db = await freshDatabase();
    // Every migration but the last (0009), then a settings row as an instance that existed before it holds one.
    await runMigrations(db, writeTruncatedRealFolder(1));
    await db.execute(sql`insert into settings (id) values (1)`);
    await runMigrations(db);
    const rows = (await db.execute(sql`select remove_offline_listeners_after_ms::text as v from settings where id = 1`)) as unknown as Array<{ v: string }>;
    expect(rows.map((r) => r.v)).toEqual(["86400000"]);
  });
```

(The raw read casts to text because postgres-js hands a raw `bigint` back as a string; drizzle's `mode: "number"` does the conversion on every other read.)

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/settings-keepers.test.ts test/migration-status.test.ts`
Expected: FAIL. "returns defaults on first read" lacks the key; the two new settings cases fail on core's `.strict()` patch schema (`Unrecognized key`), so the message differs; the migration case fails with `column "remove_offline_listeners_after_ms" does not exist` (the truncated folder drops 0008 today, and the real folder has no 0009). Every other case passes.

- [ ] **Step 4: The column.** In `src/core/src/db/schema.ts`, change the first import to:

```ts
import {
  pgTable, text, timestamp, integer, bigint, jsonb, uuid, boolean, uniqueIndex, index, primaryKey,
} from "drizzle-orm/pg-core";
```

and inside `settings`, directly after the `lobbyTitle` line, add:

```ts
  // How long a Lobby Listener may go without a check-in before the sweep removes its profile, once
  // it also reads offline (spec 2026-09-30 §4); null is off. bigint, because 30 days in milliseconds
  // (2 592 000 000) does not fit integer; mode "number" reads it as a JavaScript number, exact here.
  removeOfflineListenersAfterMs: bigint("remove_offline_listeners_after_ms", { mode: "number" }).default(86_400_000),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @loom/core db:generate`
Expected: drizzle-kit prints one new migration, `drizzle/0009_<name>.sql`. Then prove its content, the journal entry and the line endings, from the worktree root:

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
const dir = "src/core/drizzle";
const file = fs.readdirSync(dir).find((n) => n.startsWith("0009_") && n.endsWith(".sql"));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const got = fs.readFileSync(`${dir}/${file}`, "utf8").split("--> statement-breakpoint").map(norm).filter(Boolean);
const want = ['ALTER TABLE "settings" ADD COLUMN "remove_offline_listeners_after_ms" bigint DEFAULT 86400000;'];
const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8")).entries.at(-1);
console.log(JSON.stringify(got) === JSON.stringify(want) ? `0009 statements ok: ${file}` : `0009 MISMATCH:\n${got.join("\n")}`);
console.log(journal.idx === 9 && journal.when > 1790524135149 && `${journal.tag}.sql` === file ? "journal ok" : `journal MISMATCH: ${JSON.stringify(journal)}`);
console.log(fs.existsSync(`${dir}/meta/0009_snapshot.json`) ? "snapshot ok" : "snapshot MISSING");
CHECK
git add src/core/drizzle && git ls-files --eol src/core/drizzle/0009_*.sql src/core/drizzle/meta/0009_snapshot.json src/core/drizzle/meta/_journal.json
```

Expected: `0009 statements ok: 0009_<name>.sql`, `journal ok`, `snapshot ok`, and three `git ls-files --eol` rows each starting `i/lf    w/lf`. A `MISMATCH` means the schema edit is not exactly Step 4. To regenerate: delete the `.sql` and `meta/0009_snapshot.json`, restore the journal with `git restore --source=HEAD --staged --worktree -- src/core/drizzle/meta/_journal.json`, fix the schema and generate again. A `w/crlf` row means the working copy was written with CRLF: `rm` that file and `git checkout -- <file>` to renormalise it.

- [ ] **Step 6: The type.** In `src/core/src/types.ts`, replace the `Settings` line with:

```ts
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string;
  /** How long a Lobby Listener may go without a check-in before Loom removes its profile, once it also reads offline; null never removes (spec 2026-09-30 §4.1). */
  removeOfflineListenersAfterMs: number | null };
```

- [ ] **Step 7: The rule.** In `src/core/src/settings.ts`, directly after the imports add:

```ts
/** The offline-removal limit's bounds and default (spec 2026-09-30 §4.1). */
export const MIN_REMOVE_OFFLINE_MS = 3_600_000;       // 1 hour
export const MAX_REMOVE_OFFLINE_MS = 2_592_000_000;   // 30 days
export const DEFAULT_REMOVE_OFFLINE_MS = 86_400_000;  // 1 day

/**
 * The one rule for `removeOfflineListenersAfterMs`: `null` is off, a whole number from 1 hour to
 * 30 days inclusive is a limit, anything else (a fraction, a number out of range, a string, a
 * boolean, an object) is refused with one message.
 */
export function validateRemoveOfflineListenersAfterMs(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= MIN_REMOVE_OFFLINE_MS && v <= MAX_REMOVE_OFFLINE_MS) return v;
  throw errors.validation("removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)");
}
```

In `patchSchema`, directly after the `guidelines` line, add:

```ts
  // z.unknown(), so the refusal is the rule's own message and not zod's; .optional() keeps an absent
  // key out of the patch, and `updateSettings` keeps a null, which writes "off".
  removeOfflineListenersAfterMs: z.unknown().transform(validateRemoveOfflineListenersAfterMs).optional(),
```

Replace `toSettings` with:

```ts
function toSettings(r: typeof settings.$inferSelect): Settings {
  return { instanceName: r.instanceName, maxMessageLength: r.maxMessageLength, openWeaveCreation: r.openWeaveCreation,
    guidelines: r.guidelines, removeOfflineListenersAfterMs: r.removeOfflineListenersAfterMs };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/settings-keepers.test.ts test/migration-status.test.ts`
Expected: PASS, both files; "case 9: assertTransactionSafe accepts every real migration file" now covers ten files.

- [ ] **Step 9: Build, typecheck, then run core**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. (`migration-status.test.ts` imports `@loom/core`'s `dist`, which is why the build comes first.)

- [ ] **Step 10: Commit**

```bash
git add src/core/src/db/schema.ts src/core/drizzle src/core/src/settings.ts src/core/src/types.ts src/core/test/settings-keepers.test.ts src/core/test/migration-status.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(core): migration 0009 and the removeOfflineListenersAfterMs setting" -m "Migration 0009 adds settings.remove_offline_listeners_after_ms (bigint, nullable, default 86400000), which the existing row takes at once. validateRemoveOfflineListenersAfterMs is the one rule: null is off, 3600000 to 2592000000 a limit. Nothing reads it yet. Ripple repaired: settings-keepers 'returns defaults on first read' gains the key." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 2: core: the removal pass, its two events and their inbox

Spec §3, §5, §6. **This task carries the five `isRemovable` cases and the twenty Postgres cases of `lobby-removal.test.ts`, the `units.test.ts` case and the `status.test.ts` case of spec §13.1.**

**Files:**
- Modify: `src/core/src/lobby/status.ts` (`isOnline`; `listenerStatus`)
- Create: `src/core/src/lobby/removal.ts`
- Modify: `src/core/src/types.ts` (`EVENT_TYPES`)
- Modify: `src/core/src/inbox.ts` (two arms)
- Modify: `src/core/src/index.ts` (the import block and the facade)
- Create: `src/core/test/lobby-removal.test.ts`
- Modify: `src/core/test/units.test.ts`, `src/core/test/status.test.ts`

**Interfaces:**
- Consumes: Task 1's `getSettings(db).removeOfflineListenersAfterMs` and `updateSettings`; `isLive`, `intervalOf` (module-private in `status.ts`), `getLobby`, `lobbyGeneralThreadId`, `withWeaveLock(db, bus, weaveId, fn)`, `stillRunning(row, now)`, `stampSeen(db, which, now)`.
- Produces:

```ts
// src/core/src/lobby/status.ts
export function isOnline(profile: Profile | null, lastSeenAt: Date | null, now: Date): boolean;

// src/core/src/lobby/removal.ts
export function isRemovable(row: { capabilities: unknown; lastSeenAt: Date | null; joinedAt: Date }, limitMs: number | null, now: Date): boolean;
export type RemovalOptions = { beforeLock?: (participantId: string) => Promise<void> };
export async function sweepOfflineListeners(db: Db, bus: EventBus, now?: Date, opts?: RemovalOptions): Promise<number>;

// src/core/src/types.ts: EVENT_TYPES gains "listener.removed" and "request.offer_withdrawn"
// listener.removed payload:        { participantId: string; reason: "offline"; lastSeenAt: string | null; afterMs: number; previous: Profile; withdrawn: string[] }
// request.offer_withdrawn payload: { requestId: string; participantId: string; reason: "offline"; to: string }

// the facade (createCore)
sweepOfflineListeners: (now?: Date) => Promise<number>;
```

- [ ] **Step 1: Write the failing pure and list cases.** In `src/core/test/units.test.ts`, inside `describe("EVENT_TYPES (spec 2026-09-28 §10.0)", ...)`, replace the `NAMED` list's two Lobby lines (the known ripple: the list the union names gains the two types where §5.4 puts them):

```ts
    "participant.capabilities_changed", "listener.removed",
    "request.opened", "request.offered", "request.offer_withdrawn", "request.accepted", "request.closed", "request.completed", "request.overdue",
```

and after that `describe`'s existing case add:

```ts
  it("EVENT_TYPES holds listener.removed after participant.capabilities_changed and request.offer_withdrawn after request.offered (spec 2026-09-30 §5.4)", () => {
    const at = (t: string) => (EVENT_TYPES as readonly string[]).indexOf(t);
    expect([at("listener.removed") - at("participant.capabilities_changed"), at("request.offer_withdrawn") - at("request.offered")]).toEqual([1, 1]);
  });
```

In `src/core/test/status.test.ts`, change the status import to:

```ts
import { cadenceOf, isOnline, listenerStatus, workFor, DEFAULT_POLL_INTERVAL_MS, type ListenerStatus } from "../src/lobby/status.js";
```

and at the end of `describe("listenerStatus (spec 2026-09-27 §4.2)", ...)` add:

```ts
  it("isOnline agrees with listenerStatus across the boundary fixture: online exactly when the status is not offline (spec 2026-09-30 §3.2)", () => {
    const profiles = [null, P(), P({ pollIntervalMs: "5 min" }), P({ pollIntervalMs: 300_000 })];
    const seen = [null, ago(60_000), ago(600_000), ago(600_001), ago(1_800_000), ago(1_800_001)];
    for (const p of profiles) for (const s of seen) for (const work of [false, true]) {
      expect({ p, s, work, online: isOnline(p, s, NOW) }).toEqual({ p, s, work, online: listenerStatus(p, s, work, NOW) !== "offline" });
    }
  });
```

- [ ] **Step 2: Write the failing removal file.** Create `src/core/test/lobby-removal.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, readPositions, requestOffers, requests as requestsTable, weaves } from "../src/db/schema.js";
import { readEvents } from "../src/events.js";
import { resolveCredential, stampSeen } from "../src/actors.js";
import { createWeave, getWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { markRead } from "../src/reads.js";
import { inbox } from "../src/inbox.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { updateSettings } from "../src/settings.js";
import { removeParticipant } from "../src/removals.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { findAgents, setCapabilities } from "../src/lobby/profile.js";
import { listListeners } from "../src/lobby/listeners.js";
import { accept, cancelRequest, complete, getRequest, offer, openRequest, sweepOverdue, sweepRequests } from "../src/lobby/requests.js";
import { isRemovable, sweepOfflineListeners } from "../src/lobby/removal.js";
import type { Db } from "../src/db/index.js";
import type { Actor, LoomEvent } from "../src/types.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("isRemovable (spec 2026-09-30 §3.2)", () => {
  const NOW = new Date("2026-09-30T18:00:00.000Z");
  const back = (ms: number) => new Date(NOW.getTime() - ms);
  const PROFILE = { owner: "paw" };
  const L = (lastSeenAt: Date | null, capabilities: unknown = PROFILE, joinedAt: Date = back(30 * DAY)) => ({ capabilities, lastSeenAt, joinedAt });

  it("seen exactly the limit ago is kept; one millisecond more is removable", () => {
    expect([isRemovable(L(back(DAY)), DAY, NOW), isRemovable(L(back(DAY + 1)), DAY, NOW)]).toEqual([false, true]);
  });

  it("never seen counts from joinedAt: exactly the limit after joining is kept, one millisecond more is removable", () => {
    expect([isRemovable(L(null, PROFILE, back(DAY)), DAY, NOW), isRemovable(L(null, PROFILE, back(DAY + 1)), DAY, NOW)]).toEqual([false, true]);
  });

  it("off: a null limit removes nobody", () => {
    // Never seen and joined 30 days ago: removable under any limit, and kept with none.
    expect(isRemovable(L(null), null, NOW)).toBe(false);
  });

  it("no profile is never removable", () => {
    expect([isRemovable(L(null, null), DAY, NOW), isRemovable(L(back(30 * DAY), null), DAY, NOW)]).toEqual([false, false]);
  });

  it("an online Listener is kept past the limit", () => {
    const daily = { owner: "paw", pollIntervalMs: DAY };
    expect([
      isRemovable(L(back(2 * HOUR), daily), HOUR, NOW),
      isRemovable(L(back(172_800_001), daily), HOUR, NOW),
      isRemovable(L(back(172_800_000), daily), HOUR, NOW),
    ]).toEqual([false, true, false]);
  });
});

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

/**
 * The Lobby's reader (its own secret), a requester **with no profile** (so it is no Listener and is
 * never removed), a target Weave with a Thread, and `ask`, which opens a request wanting two that
 * every Listener of this file is eligible for (they serve anyone; the requester's owner is "").
 */
async function world() {
  const lobby = await ensureLobby(db);
  const reader = await resolveCredential(db, lobby.secret);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const keeper = await resolveCredential(db, target.token);
  const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
  const asker = await joinLobby(db, bus, { name: "Asker", kind: "human" });
  const requester = await resolveCredential(db, asker.token);
  const general = (await getWeave(db, reader, lobby.weaveId)).threads.find((t) => t.isGeneral)!;
  const ask = (title: string) => openRequest(db, bus, requester, keeper, {
    title, requirements: {}, wanted: 2, targetWeaveId: target.weave.id, targetThreadId: thread.id, url: null,
  });
  return { lobbyId: lobby.weaveId, reader, requester, requesterId: asker.participant.id, generalId: general.id, ask };
}
type World = Awaited<ReturnType<typeof world>>;

/** A Listener serving anyone. Its check-in is then set by `seenAt`, against the `now` the test passes. */
async function listener(name: string, profile: Record<string, unknown> = {}) {
  const j = await joinLobby(db, bus, { name, kind: "agent" });
  const actor = await resolveCredential(db, j.token);
  await setCapabilities(db, bus, actor, { owner: `${name}-owner`, serves: "anyone", ...profile });
  return { id: j.participant.id, token: j.token, actor };
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);
const seenAt = (id: string, at: Date | null) => db.update(participants).set({ lastSeenAt: at }).where(eq(participants.id, id));
const joinedAt = (id: string, at: Date) => db.update(participants).set({ joinedAt: at }).where(eq(participants.id, id));
const row = async (id: string) => (await db.select().from(participants).where(eq(participants.id, id)))[0]!;
const log = (w: World) => readEvents(db, w.lobbyId, {});
const lastSeq = async (w: World) => (await log(w)).at(-1)!.seq;
const after = async (w: World, seq: number) => (await log(w)).filter((e) => e.seq > seq);
const ofType = (events: LoomEvent[], type: string) => events.filter((e) => e.type === type);
const keeper = async (): Promise<Actor> => { await seedKeepers(db, [keeperToken("k")]); return resolveCredential(db, keeperToken("k")); };

describe("sweepOfflineListeners against Postgres (spec 2026-09-30 §5, §6)", () => {
  it("the boundary: seen exactly the limit before now is kept, 1 ms earlier is removed, one pass returns 1 and writes one listener.removed", async () => {
    const w = await world();
    const kept = await listener("Kept");
    const gone = await listener("Gone");
    const now = new Date();
    await seenAt(kept.id, ago(now, DAY));
    await seenAt(gone.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(kept.id)).capabilities !== null, (await row(gone.id)).capabilities]).toEqual([true, null]);
    expect(ofType(await log(w), "listener.removed").map((e) => e.payload.participantId)).toEqual([gone.id]);
  });

  it("a never-seen Listener is removed a limit after it joined, not before", async () => {
    const w = await world();
    const late = await listener("Late");
    const early = await listener("Early");
    const now = new Date();
    for (const l of [late, early]) await seenAt(l.id, null);
    await joinedAt(late.id, ago(now, DAY));
    await joinedAt(early.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(late.id)).capabilities !== null, (await row(early.id)).capabilities]).toEqual([true, null]);
    expect(ofType(await log(w), "listener.removed").map((e) => [e.payload.participantId, e.payload.lastSeenAt])).toEqual([[early.id, null]]);
  });

  it("off: with the setting null a pass returns 0 and writes nothing, however old the Listeners are; after setting 3600000 the next pass removes them", async () => {
    const w = await world();
    const k = await keeper();
    await updateSettings(db, k, { removeOfflineListenersAfterMs: null });
    const old = await listener("Old");
    const never = await listener("Never");
    const now = new Date();
    await seenAt(old.id, ago(now, 30 * DAY));
    await seenAt(never.id, null);
    await joinedAt(never.id, ago(now, 30 * DAY));
    const before = await log(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect(await log(w)).toEqual(before);
    await updateSettings(db, k, { removeOfflineListenersAfterMs: 3_600_000 });
    expect(await sweepOfflineListeners(db, bus, now)).toBe(2);
  });

  it("a participant with no profile is left alone and nothing is written", async () => {
    const w = await world();
    const bare = await joinLobby(db, bus, { name: "Bare", kind: "agent" });
    const now = new Date();
    await seenAt(bare.participant.id, ago(now, 30 * DAY));
    await seenAt(w.requesterId, null);
    await joinedAt(w.requesterId, ago(now, 30 * DAY));
    const before = await log(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect(await log(w)).toEqual(before);
  });

  it("a removal clears the profile and keeps the participant: row, name, token, lastSeenAt, seen_history, messages and read positions", async () => {
    const w = await world();
    const l = await listener("Historian");
    const said = await postMessage(db, bus, l.actor, w.generalId, "hello");
    await markRead(db, l.actor, w.generalId, said.seq);
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const before = await row(l.id);
    const positions = () => db.select().from(readPositions).where(eq(readPositions.participantId, l.id));
    const positionsBefore = await positions();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await row(l.id)).toEqual({ ...before, capabilities: null });
    expect(await positions()).toEqual(positionsBefore);
    expect((await log(w)).find((e) => e.seq === said.seq)).toEqual(said);
    expect((await getWeave(db, w.reader, w.lobbyId)).participants.map((p) => p.id)).toContain(l.id);
  });

  it("listener.removed: payload, actor, Thread and order", async () => {
    const w = await world();
    const l = await listener("Payload", { tools: ["github"], pollIntervalMs: 300_000 });
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    const seen = ago(now, DAY + 1);
    await seenAt(l.id, seen);
    const stored = (await row(l.id)).capabilities;
    const from = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const fresh = await after(w, from);
    expect(fresh.map((e) => [e.seq, e.type, e.threadId, e.actor])).toEqual([
      [from + 1, "listener.removed", w.generalId, "system"],
      [from + 2, "request.offer_withdrawn", r.threadId, "system"],
    ]);
    expect(fresh[0]!.payload).toEqual({ participantId: l.id, reason: "offline", lastSeenAt: seen.toISOString(), afterMs: DAY, previous: stored, withdrawn: [r.id] });
  });

  it("open offers are withdrawn: an open request inside its window and a working one; a closed one and an open one past expiresAt are left alone", async () => {
    const w = await world();
    const l = await listener("Offerer");
    const helper = await listener("Helper");
    const inWindow = await w.ask("Open");
    const working = await w.ask("Working");
    const closed = await w.ask("Closed");
    const lapsed = await w.ask("Lapsed");
    for (const r of [inWindow, working, closed, lapsed]) await offer(db, bus, l.actor, r.id, {});
    // Offer order is created_at; the database clock can step backwards (HANDBOOK §5), so it is pinned.
    const pin = (requestId: string, at: string) => db.update(requestOffers).set({ createdAt: new Date(at) })
      .where(and(eq(requestOffers.requestId, requestId), eq(requestOffers.participantId, l.id)));
    await pin(inWindow.id, "2026-09-30T10:00:00.000Z");
    await pin(working.id, "2026-09-30T10:00:01.000Z");
    await offer(db, bus, helper.actor, working.id, {});
    await accept(db, bus, w.requester, working.id, [helper.id], { deadlineMs: HOUR });
    await cancelRequest(db, bus, w.requester, closed.id);
    await db.update(requestsTable).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(requestsTable.id, lapsed.id));
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const untouched = async () => ({
      offers: await db.select().from(requestOffers).where(inArray(requestOffers.requestId, [closed.id, lapsed.id])).orderBy(asc(requestOffers.requestId)),
      requests: await db.select().from(requestsTable).where(inArray(requestsTable.id, [closed.id, lapsed.id])).orderBy(asc(requestsTable.id)),
    });
    const before = await untouched();
    const from = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const fresh = await after(w, from);
    expect(fresh.map((e) => [e.type, e.threadId, e.actor, e.type === "listener.removed" ? e.payload.withdrawn : e.payload])).toEqual([
      ["listener.removed", w.generalId, "system", [inWindow.id, working.id]],
      ["request.offer_withdrawn", inWindow.threadId, "system", { requestId: inWindow.id, participantId: l.id, reason: "offline", to: w.requesterId }],
      ["request.offer_withdrawn", working.threadId, "system", { requestId: working.id, participantId: l.id, reason: "offline", to: w.requesterId }],
    ]);
    const version = async (id: string) => (await db.select().from(requestsTable).where(eq(requestsTable.id, id)))[0]!.lastEventSeq;
    expect([await version(inWindow.id), await version(working.id)]).toEqual([fresh[1]!.seq, fresh[2]!.seq]);
    expect(await db.select().from(requestOffers)
      .where(and(eq(requestOffers.participantId, l.id), inArray(requestOffers.requestId, [inWindow.id, working.id])))).toEqual([]);
    expect(await untouched()).toEqual(before);
  });

  it("accepted work is untouched: an active, a completed and a removed acceptance stay, the request stays working, overdue still fires, getRequest shows offline, and complete still succeeds", async () => {
    const w = await world();
    const l = await listener("Worker");
    const active = await w.ask("Active");
    const done = await w.ask("Done");
    const dropped = await w.ask("Dropped");
    for (const r of [active, done, dropped]) {
      await offer(db, bus, l.actor, r.id, {});
      await accept(db, bus, w.requester, r.id, [l.id], { deadlineMs: HOUR });
    }
    await complete(db, bus, l.actor, done.id, { note: "done" });
    await removeParticipant(db, bus, w.requester, dropped.threadId, l.id);
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const mine = () => db.select().from(requestOffers).where(eq(requestOffers.participantId, l.id)).orderBy(asc(requestOffers.requestId));
    const before = await mine();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await mine()).toEqual(before);
    expect((await getRequest(db, w.reader, active.id, now)).status).toBe("working");
    const dueAt = before.find((o) => o.requestId === active.id)!.dueAt!;
    expect(await sweepOverdue(db, bus, new Date(dueAt.getTime() + 1))).toBe(1);
    expect(ofType(await readEvents(db, w.lobbyId, { threadId: active.threadId }), "request.overdue").map((e) => e.payload.participantId)).toEqual([l.id]);
    expect((await getRequest(db, w.reader, active.id, now)).acceptances).toEqual([expect.objectContaining({ participantId: l.id, listenerStatus: "offline" })]);
    await expect(complete(db, bus, l.actor, active.id, { note: "late" })).resolves.toMatchObject({ status: "completed" });
  });

  it("the inbox: listener.removed reaches only the removed Listener, request.offer_withdrawn only the requester", async () => {
    const w = await world();
    const l = await listener("Removed");
    const coOfferer = await listener("CoOfferer");
    const bystander = await listener("Bystander");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    await offer(db, bus, coOfferer.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const since = await lastSeq(w);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const types = async (actor: Actor) => (await inbox(db, actor, w.lobbyId, { since })).map((i) => i.type);
    expect(await types(l.actor)).toEqual(["listener.removed"]);
    expect(await types(w.requester)).toEqual(["request.offer_withdrawn"]);
    expect(await types(coOfferer.actor)).toEqual([]);
    expect(await types(bystander.actor)).toEqual([]);
  });

  it("a daily poller seen 25 hours ago is a candidate and kept: the pass returns 0, writes nothing, and its profile and offers are unchanged", async () => {
    const w = await world();
    const l = await listener("Daily", { pollIntervalMs: DAY });
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, 25 * HOUR));
    const state = async () => ({ row: await row(l.id), offers: await db.select().from(requestOffers).where(eq(requestOffers.participantId, l.id)), log: await log(w) });
    const before = await state();
    const candidates: string[] = [];
    expect(await sweepOfflineListeners(db, bus, now, { beforeLock: async (id) => { candidates.push(id); } })).toBe(0);
    expect(candidates).toEqual([l.id]);
    expect(await state()).toEqual(before);
  });

  it("joined_at with microseconds: 500 microseconds inside the limit is kept, 500 microseconds past it is removed", async () => {
    await world();
    const inside = await listener("Inside");
    const past = await listener("Past");
    const now = new Date();
    const cutoff = ago(now, DAY).toISOString();
    for (const l of [inside, past]) await seenAt(l.id, null);
    await db.execute(sql`update participants set joined_at = ${cutoff}::timestamptz + interval '500 microseconds' where id = ${inside.id}`);
    await db.execute(sql`update participants set joined_at = ${cutoff}::timestamptz - interval '500 microseconds' where id = ${past.id}`);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect([(await row(inside.id)).capabilities !== null, (await row(past.id)).capabilities]).toEqual([true, null]);
  });

  it("accept naming a withdrawn offer is refused, and getRequest lists it no more", async () => {
    const w = await world();
    const l = await listener("Withdrawn");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    await expect(accept(db, bus, w.requester, r.id, [l.id], { deadlineMs: HOUR }))
      .rejects.toMatchObject({ code: "validation", message: "That participant has not offered on this request" });
    expect((await getRequest(db, w.reader, r.id)).offers.map((o) => o.participantId)).not.toContain(l.id);
  });

  it("a withdrawn offerer is not told when the request later closes", async () => {
    const w = await world();
    const l = await listener("Gone");
    const other = await listener("Stays");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    await offer(db, bus, other.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect(await sweepRequests(db, bus, new Date(Date.parse(r.expiresAt) + 1))).toBe(1);
    const closed = ofType(await readEvents(db, w.lobbyId, { threadId: r.threadId }), "request.closed");
    expect(closed.map((e) => e.payload.to)).toEqual([[w.requesterId, other.id]]);
  });

  it("no removal event carries a secret or a token", async () => {
    const w = await world();
    const { key } = await addAgent(db, await keeper(), "ChatGPT", "paw");
    const joined = await joinLobby(db, bus, { kind: "agent" }, await resolveCredential(db, key));
    const keyed = await resolveCredential(db, joined.token);
    await setCapabilities(db, bus, keyed, { serves: "anyone" });          // the owner comes from the key
    for (const title of ["Review PR 14", "Review PR 15"]) await offer(db, bus, keyed, (await w.ask(title)).id, {});
    const now = new Date();
    await seenAt(joined.participant.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const secrets = [
      key,
      ...(await db.select({ s: weaves.secret }).from(weaves)).map((x) => x.s),
      ...(await db.select({ t: participants.token }).from(participants)).map((p) => p.t),
    ];
    const events = await log(w);
    expect(events.map((e) => e.type).filter((t) => t === "listener.removed" || t === "request.offer_withdrawn"))
      .toEqual(["listener.removed", "request.offer_withdrawn", "request.offer_withdrawn"]);
    for (const e of events) for (const s of secrets) expect(JSON.stringify(e.payload)).not.toContain(s);
  });

  it("concurrent sweeps write one event per removal", async () => {
    const w = await world();
    const ls = [await listener("One"), await listener("Two"), await listener("Three")];
    for (const title of ["Review PR 14", "Review PR 15"]) await offer(db, bus, ls[0]!.actor, (await w.ask(title)).id, {});
    const now = new Date();
    for (const l of ls) await seenAt(l.id, ago(now, DAY + 1));
    const [a, b] = await Promise.all([sweepOfflineListeners(db, bus, now), sweepOfflineListeners(db, bus, now)]);
    expect(a! + b!).toBe(3);
    const events = await log(w);
    expect([ofType(events, "listener.removed").length, ofType(events, "request.offer_withdrawn").length]).toEqual([3, 2]);
  });

  it("a check-in racing the pass wins: stamped after the candidates are read and before the lock, the Listener is kept and nothing is written", async () => {
    const w = await world();
    const l = await listener("Racer");
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    const before = await log(w);
    const removed = await sweepOfflineListeners(db, bus, now, {
      beforeLock: async (id) => { await stampSeen(db, eq(participants.id, id), new Date(now.getTime() + 1)); },
    });
    expect(removed).toBe(0);
    expect((await row(l.id)).capabilities).not.toBeNull();
    expect(await log(w)).toEqual(before);
  });

  it("the directory, the counts and find_agents drop a removed Listener", async () => {
    const w = await world();
    const stays = await listener("Stays");
    const goes = await listener("Goes");
    const now = new Date();
    await seenAt(stays.id, ago(now, 2 * HOUR));        // offline, and inside the limit
    await seenAt(goes.id, ago(now, DAY + 1));
    const page = () => listListeners(db, w.reader, {}, now);
    const found = async () => (await findAgents(db, w.reader, {}, now)).map((a) => a.participant.id);
    const before = await page();
    const foundBefore = await found();
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const afterPage = await page();
    expect([afterPage.total, afterPage.matched, afterPage.statusCounts.offline])
      .toEqual([before.total - 1, before.matched - 1, before.statusCounts.offline - 1]);
    expect(foundBefore).toContain(goes.id);
    expect(await found()).toEqual(foundBefore.filter((id) => id !== goes.id));
  });

  it("a request opened after the removal does not address it", async () => {
    const w = await world();
    const gone = await listener("Gone");
    const here = await listener("Here");
    const now = new Date();
    await seenAt(gone.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    expect((await w.ask("Review PR 14")).eligible).toEqual([here.id]);
  });

  it("a returning Listener rejoins by setting its profile: listed, found, a participant.capabilities_changed, a new offer, and kept by the next pass", async () => {
    const w = await world();
    const l = await listener("Returner");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const now = new Date();
    await seenAt(l.id, ago(now, DAY + 1));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(1);
    const back = await resolveCredential(db, l.token, now);            // its first call after the removal stamps it
    await setCapabilities(db, bus, back, { owner: "Returner-owner", serves: "anyone" });
    expect((await log(w)).at(-1)).toMatchObject({ type: "participant.capabilities_changed", payload: { participantId: l.id } });
    expect((await listListeners(db, w.reader, {}, now)).listeners.map((x) => x.participant.id)).toContain(l.id);
    expect((await findAgents(db, w.reader, {}, now)).map((a) => a.participant.id)).toContain(l.id);
    await offer(db, bus, back, r.id, {});
    expect(ofType(await readEvents(db, w.lobbyId, { threadId: r.threadId }), "request.offered").map((e) => e.payload.participantId)).toEqual([l.id, l.id]);
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
  });

  it("set_capabilities(null) by the Listener itself writes only participant.capabilities_changed: its offers stand, and no listener.removed is written then or by a later pass", async () => {
    const w = await world();
    const l = await listener("Leaver");
    const r = await w.ask("Review PR 14");
    await offer(db, bus, l.actor, r.id, {});
    const from = await lastSeq(w);
    await setCapabilities(db, bus, l.actor, null);
    const now = new Date();
    await seenAt(l.id, ago(now, 30 * DAY));
    expect(await sweepOfflineListeners(db, bus, now)).toBe(0);
    expect((await after(w, from)).map((e) => e.type)).toEqual(["participant.capabilities_changed"]);
    expect(await db.select({ requestId: requestOffers.requestId }).from(requestOffers).where(eq(requestOffers.participantId, l.id))).toEqual([{ requestId: r.id }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/lobby-removal.test.ts test/units.test.ts test/status.test.ts`
Expected: FAIL. `lobby-removal.test.ts` fails to resolve `../src/lobby/removal.js`; `units.test.ts`' two EVENT_TYPES cases fail (the types are missing); `status.test.ts`' new case fails (`isOnline` is not a function); every other case passes.

- [ ] **Step 4: `isOnline`.** In `src/core/src/lobby/status.ts`, replace `listenerStatus` and its doc comment with:

```ts
/**
 * Online by §4.2 step 1: seen within twice the declared `pollIntervalMs`, the 15 minute default when
 * none is declared (so exactly twice is still online); never seen is not online. The status rule's
 * first step, shared with the offline-removal rule (spec 2026-09-30 §3.2 condition 3).
 */
export function isOnline(profile: Profile | null, lastSeenAt: Date | null, now: Date): boolean {
  return isLive({ pollIntervalMs: intervalOf(profile) }, { lastSeenAt, now });
}

/** §4.2, in TypeScript: offline unless `isOnline`, and offline wins over working. */
export function listenerStatus(profile: Profile | null, lastSeenAt: Date | null, holdsWork: boolean, now: Date): ListenerStatus {
  if (!isOnline(profile, lastSeenAt, now)) return "offline";
  return holdsWork ? "working" : "idle";
}
```

- [ ] **Step 5: The event types.** In `src/core/src/types.ts`, replace the two Lobby lines of `EVENT_TYPES` (the comment above them stays) with:

```ts
  "participant.capabilities_changed", "listener.removed",
  "request.opened", "request.offered", "request.offer_withdrawn", "request.accepted", "request.closed", "request.completed", "request.overdue",
```

- [ ] **Step 6: The pass.** Create `src/core/src/lobby/removal.ts`:

```ts
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { participants, requestOffers, requests } from "../db/schema.js";
import type { EventBus } from "../bus.js";
import { withWeaveLock, type NewEvent } from "../events.js";
import { getSettings } from "../settings.js";
import { getLobby, lobbyGeneralThreadId } from "./lobby.js";
import { stillRunning } from "./requests.js";
import { isOnline } from "./status.js";
import type { Profile } from "./matching.js";

/*
 * Removing offline Listeners (spec 2026-09-30): the sweep's third pass. A Listener is a Lobby
 * participant with a profile. One that has gone longer than the instance's
 * `removeOfflineListenersAfterMs` without a check-in, and also reads offline, loses its profile and
 * its open offers; its row, its history, its accepted work and the requests it opened stay, and it
 * comes back by setting its profile again. An action, not a status: until the moment of its removal
 * it reads offline exactly as before.
 */

/**
 * §3.2, pure. `limitMs` null is off. The row is a `participants` row as drizzle reads it. The
 * reference is the last check-in, or the join when it was never seen; exactly `limitMs` after it is
 * kept, one millisecond more is removable, and only while it reads offline (`isOnline`), so one that
 * declares a long `pollIntervalMs` is kept until twice that interval.
 */
export function isRemovable(
  row: { capabilities: unknown; lastSeenAt: Date | null; joinedAt: Date },
  limitMs: number | null, now: Date,
): boolean {
  if (limitMs === null || row.capabilities === null) return false;
  const reference = row.lastSeenAt ?? row.joinedAt;
  if (now.getTime() - reference.getTime() <= limitMs) return false;
  return !isOnline(row.capabilities as Profile, row.lastSeenAt, now);
}

export type RemovalOptions = {
  /** Test seam: runs after the candidates are read and before each one's transaction takes the lock. */
  beforeLock?: (participantId: string) => Promise<void>;
};

/**
 * §5.1. Reads the setting once (off: nothing else is read), then the candidates in one query without
 * a lock (conditions 1 and 2 of §3.2 on the millisecond value a JavaScript `Date` holds, a superset
 * of the removable set), then decides each one again in its own transaction under the Lobby lock,
 * on its participant row re-read `FOR UPDATE`: a check-in that committed first is what the re-read
 * sees, and of two passes racing the second finds the profile already gone and writes nothing.
 * `stampSeen` takes no Weave lock and locks that one row, so no lock cycle exists. Returns how many
 * Listeners it removed.
 */
export async function sweepOfflineListeners(db: Db, bus: EventBus, now = new Date(), opts: RemovalOptions = {}): Promise<number> {
  const limit = (await getSettings(db)).removeOfflineListenersAfterMs;
  if (limit === null) return 0;
  const { weaveId: lobbyId } = await getLobby(db);
  const generalThreadId = await lobbyGeneralThreadId(db, lobbyId);
  const cutoff = new Date(now.getTime() - limit);
  // The truncation `statusSql` uses, so the candidate test and the `Date` the re-read hands
  // `isRemovable` agree on a stored microsecond.
  const reference = sql`date_trunc('milliseconds', coalesce(${participants.lastSeenAt}, ${participants.joinedAt}))`;
  const candidates = await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities),
      sql`${reference} < ${cutoff.toISOString()}::timestamptz`))
    .orderBy(asc(reference), asc(participants.id));
  let removed = 0;
  for (const { id } of candidates) {
    if (opts.beforeLock) await opts.beforeLock(id);
    const didRemove = await withWeaveLock<boolean>(db, bus, lobbyId, async (tx, lobby) => {
      const [row] = await tx.select().from(participants).where(eq(participants.id, id)).for("update");
      if (!row || row.capabilities === null || !isRemovable(row, limit, now)) return { result: false, events: [] };
      // §5.2: its unaccepted offers on requests still running, in offer order, then by request id.
      // Accepted rows (active, completed, or removed by a requester) are never touched (Q4).
      const open = (await tx.select({
        requestId: requestOffers.requestId, threadId: requests.threadId, requesterId: requests.requesterId,
        status: requests.status, expiresAt: requests.expiresAt,
      }).from(requestOffers).innerJoin(requests, eq(requests.id, requestOffers.requestId))
        .where(and(eq(requestOffers.participantId, id), eq(requestOffers.accepted, false)))
        .orderBy(asc(requestOffers.createdAt), asc(requestOffers.requestId)))
        .filter((o) => stillRunning(o, now));
      if (open.length > 0) {
        await tx.delete(requestOffers).where(and(eq(requestOffers.participantId, id), eq(requestOffers.accepted, false),
          inArray(requestOffers.requestId, open.map((o) => o.requestId))));
      }
      // Each request's version is its own withdrawal's seq: `listener.removed` takes lastSeq + 1.
      for (const [i, o] of open.entries()) {
        await tx.update(requests).set({ lastEventSeq: lobby.lastSeq + 2 + i }).where(eq(requests.id, o.requestId));
      }
      await tx.update(participants).set({ capabilities: null }).where(eq(participants.id, id));
      const news: NewEvent[] = [
        { threadId: generalThreadId, type: "listener.removed", actor: "system",
          payload: { participantId: id, reason: "offline", lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
            afterMs: limit, previous: row.capabilities as Profile, withdrawn: open.map((o) => o.requestId) } },
        // Addressed to the requester (Review F1 = A): it was told of the offer by request.offered.
        ...open.map((o): NewEvent => ({ threadId: o.threadId, type: "request.offer_withdrawn", actor: "system",
          payload: { requestId: o.requestId, participantId: id, reason: "offline", to: o.requesterId } })),
      ];
      return { result: true, events: news };
    });
    if (didRemove) removed++;
  }
  return removed;
}
```

- [ ] **Step 7: The inbox.** In `src/core/src/inbox.ts`, directly after the `thread.removed` arm add:

```ts
      // Loom's offline sweep removed my profile (spec 2026-09-30 §5.4): it names me in `participantId`.
      and(eq(events.type, "listener.removed"), sql`${events.payload}->>'participantId' = ${me.id}`),
```

and replace the last arm and its comment with:

```ts
      // Work an accepted agent finished, a deadline it missed, or an offer the offline sweep withdrew
      // (spec 2026-09-30 §5.3): all addressed to the requester, the way request.offered is.
      and(inArray(events.type, ["request.completed", "request.overdue", "request.offer_withdrawn"]), sql`${events.payload}->>'to' = ${me.id}`),
```

- [ ] **Step 8: The facade.** In `src/core/src/index.ts`, directly after the line `import * as invitations from "./lobby/invitations.js";` add:

```ts
import * as removal from "./lobby/removal.js";
```

and directly after the `sweepOverdue:` line of the facade add:

```ts
    // The sweep's third pass (spec 2026-09-30 §5.5): the server runs it after the other two, with their `now`.
    sweepOfflineListeners: (now?: Date) => removal.sweepOfflineListeners(db, bus, now),
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/lobby-removal.test.ts test/units.test.ts test/status.test.ts`
Expected: PASS, all three files: 25 cases in `lobby-removal.test.ts`.

- [ ] **Step 10: Build, typecheck, then run core and the mcp-tools guard**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run && cd ../mcp-tools && npx vitest run`
Expected: all green, pristine. (The mcp-tools drift guard reads `EVENT_TYPES` from core's `dist`; it must still pass, since no skill names the new types yet.)

- [ ] **Step 11: Commit**

```bash
git add src/core/src/lobby/status.ts src/core/src/lobby/removal.ts src/core/src/types.ts src/core/src/inbox.ts src/core/src/index.ts src/core/test/lobby-removal.test.ts src/core/test/units.test.ts src/core/test/status.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(core): the sweep removes offline Listeners, with listener.removed and request.offer_withdrawn" -m "lobby/removal.ts: isRemovable (past the limit and offline by isOnline, now shared with listenerStatus) and sweepOfflineListeners (one candidate query, then one transaction per Listener under the Lobby lock on its row re-read FOR UPDATE). A removal clears the profile, deletes its unaccepted offers on running requests, and writes listener.removed (to the Listener) and one request.offer_withdrawn per withdrawal (to the requester); inbox addresses both. The facade gains sweepOfflineListeners; nothing runs it yet. Ripple repaired: units 'EVENT_TYPES holds every type the EventType union named' gains the two types." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 3: server, REST, client and CLI: the third pass and the setting's surface

Spec §5.5, §7 (REST, client, CLI), §9.2, §10. **This task carries spec §13.2, §13.3 and §13.4.**

**Files:**
- Modify: `src/server/src/app.ts` (`SweepResult`, `sweepNow` and its comment)
- Modify: `src/server/src/routes/admin.ts` (the `PUT /settings` body schema)
- Modify: `src/client/src/types.ts` (`EventType`, `Settings`)
- Modify: `src/cli/src/commands/admin.ts` (`SETTING_PARSERS`, the `--set` help, the human output)
- Modify: `src/cli/src/commands/messages.ts` (`formatEvent`)
- Test: `src/server/test/routes.test.ts`, `src/server/test/lobby-routes.test.ts`, `src/client/test/client.test.ts`, `src/cli/test/cli-more.test.ts`, `src/cli/test/lobby.test.ts`

**Interfaces:**
- Consumes: Task 1's setting and message; Task 2's facade `sweepOfflineListeners(now?)` and the two event payloads.
- Produces:

```ts
// src/server/src/app.ts
export type SweepResult = { closed: number; overdue: number; removed: number };

// src/client/src/types.ts
export type EventType = ... | "participant.capabilities_changed" | "listener.removed"
  | "request.opened" | "request.offered" | "request.offer_withdrawn" | "request.accepted" | ... ;
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string;
  removeOfflineListenersAfterMs: number | null };

// src/cli/src/commands/admin.ts: SETTING_PARSERS.removeOfflineListenersAfterMs: (v: string) => number | null
```

- [ ] **Step 1: Write the failing server cases.** At the end of `src/server/test/routes.test.ts` add:

```ts
describe("the offline-removal setting over REST (spec 2026-09-30 §7)", () => {
  it("GET /api/admin/settings carries removeOfflineListenersAfterMs; PUT takes 3600000 and null; 1000 and the string 1h are 400; a non-keeper is refused", async () => {
    const put = (body: unknown, token = KEEPER) => api(s.baseUrl, "PUT", "/api/admin/settings", body, token);
    const got = await api(s.baseUrl, "GET", "/api/admin/settings", undefined, KEEPER);
    expect([got.status, got.json.removeOfflineListenersAfterMs]).toEqual([200, 86_400_000]);
    const hour = await put({ removeOfflineListenersAfterMs: 3_600_000 });
    expect([hour.status, hour.json.removeOfflineListenersAfterMs]).toEqual([200, 3_600_000]);
    const off = await put({ removeOfflineListenersAfterMs: null });
    expect([off.status, off.json.removeOfflineListenersAfterMs]).toEqual([200, null]);
    const small = await put({ removeOfflineListenersAfterMs: 1000 });
    expect([small.status, small.json.code, small.json.message]).toEqual([400, "validation",
      "removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)"]);
    const word = await put({ removeOfflineListenersAfterMs: "1h" });
    expect([word.status, word.json.code]).toEqual([400, "validation"]);
    const member = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect((await put({ removeOfflineListenersAfterMs: null }, member.json.token)).status).toBe(403);
    expect((await put({ removeOfflineListenersAfterMs: 86_400_000 })).status).toBe(200);
  });
});
```

In `src/server/test/lobby-routes.test.ts`, inside `describe("the request sweep", ...)`, replace the whole case "sweepNow runs the expiry pass and the overdue pass with one now and resolves to { closed, overdue }" with (the known ripple: the pass list and the result gain the third):

```ts
  it("sweepNow runs the expiry, overdue and offline-removal passes with one now and resolves to { closed, overdue, removed }", async () => {
    const f = await scenario();
    const expiring = await openRequest(f, { timeoutMs: 60_000 });
    const working = await acceptedRequest(f, { title: "Review PR 15" });
    const seen: Date[] = [];
    const core = {
      ...s.core,
      sweepRequests: (now?: Date) => { seen.push(now!); return s.core.sweepRequests(now); },
      sweepOverdue: (now?: Date) => { seen.push(now!); return s.core.sweepOverdue(now); },
      sweepOfflineListeners: (now?: Date) => { seen.push(now!); return s.core.sweepOfflineListeners(now); },
    } as Core;
    const tickets = new TicketStore();
    const { sweepNow, stop } = buildApp({ core, tickets });
    const at = new Date(Date.now() + 2 * 3_600_000);
    try {
      const out = await sweepNow(at);
      expect(out.closed).toBeGreaterThanOrEqual(1);
      expect(out.overdue).toBeGreaterThanOrEqual(1);
      // Two hours ahead, a day's limit removes nobody this file has made: all of them checked in during the run.
      expect(out.removed).toBe(0);
      expect(seen).toEqual([at, at, at]);
    } finally { stop(); tickets.stop(); }
    expect((await api(s.baseUrl, "GET", `/api/requests/${expiring.id}`, undefined, f.claude.token)).json.status).toBe("expired");
    const w = (await api(s.baseUrl, "GET", `/api/requests/${working.id}`, undefined, f.claude.token)).json;
    expect(w.status).toBe("working");
    expect(w.acceptances[0].overdueNotifiedAt).toEqual(expect.any(String));
  });

  it("for a Listener holding an overdue acceptance and past the limit, one sweepNow writes request.overdue before listener.removed (spec 2026-09-30 §5.5)", async () => {
    const f = await scenario();
    await acceptedRequest(f);                                  // Pawbot accepted, due in an hour
    // Seen 23 hours ago: inside the day's limit for this server's own real-time sweep, past it at `at`.
    await sqlUnsafe("update participants set last_seen_at = now() - interval '23 hours' where id = $1", [f.pawbot.id]);
    const at = new Date(Date.now() + 2 * 3_600_000);
    const out = await s.sweepNow(at);
    expect([out.overdue >= 1, out.removed >= 1]).toEqual([true, true]);
    const lobbyId = (await s.core.getLobby()).weaveId;
    const order = await sqlUnsafe<{ type: string }>(
      "select type from events where weave_id = $1 and type in ('request.overdue', 'listener.removed') and payload->>'participantId' = $2 order by seq",
      [lobbyId, f.pawbot.id]);
    expect(order.map((r) => r.type)).toEqual(["request.overdue", "listener.removed"]);
  });
```

- [ ] **Step 2: Write the failing client case.** At the end of `src/client/test/client.test.ts` add:

```ts
describe("the offline-removal setting (spec 2026-09-30 §7)", () => {
  it("getSettings and updateSettings round-trip removeOfflineListenersAfterMs, a number and null", async () => {
    const k = anon.withToken(keeperToken("k1"));
    expect((await k.admin.getSettings()).removeOfflineListenersAfterMs).toBe(86_400_000);
    expect((await k.admin.updateSettings({ removeOfflineListenersAfterMs: 3_600_000 })).removeOfflineListenersAfterMs).toBe(3_600_000);
    expect((await k.admin.getSettings()).removeOfflineListenersAfterMs).toBe(3_600_000);
    expect((await k.admin.updateSettings({ removeOfflineListenersAfterMs: null })).removeOfflineListenersAfterMs).toBeNull();
    expect((await k.admin.getSettings()).removeOfflineListenersAfterMs).toBeNull();
    expect((await k.admin.updateSettings({ removeOfflineListenersAfterMs: 86_400_000 })).removeOfflineListenersAfterMs).toBe(86_400_000);
  });
});
```

- [ ] **Step 3: Write the failing CLI cases.** In `src/cli/test/cli-more.test.ts`, at the end of `describe("admin", ...)` add:

```ts
  it("admin settings --set removeOfflineListenersAfterMs takes off and a whole number, and refuses anything else (spec 2026-09-30 §7)", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const off = await run(["admin", "settings", "--set", "removeOfflineListenersAfterMs=off"], K);
    expect(off.code).toBe(0);
    expect(off.out).toContain("removeOfflineListenersAfterMs: off");
    expect((await run(["admin", "settings", "--json"], K)).json().removeOfflineListenersAfterMs).toBeNull();
    const hour = await run(["admin", "settings", "--set", "removeOfflineListenersAfterMs=3600000", "--json"], K);
    expect([hour.code, hour.json().removeOfflineListenersAfterMs]).toEqual([0, 3_600_000]);
    const bad = await run(["admin", "settings", "--set", "removeOfflineListenersAfterMs=1h", "--json"], K);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err)).toEqual({ code: "validation", message: "removeOfflineListenersAfterMs must be a whole number of milliseconds, or off" });
    expect((await run(["admin", "settings", "--set", "removeOfflineListenersAfterMs=86400000"], K)).code).toBe(0);
  });
```

In `src/cli/test/lobby.test.ts`, after the `hhmm` helper add:

```ts
/** Raw SQL against the test server's database, for the one thing no command can do: age a check-in. */
async function sqlUnsafe<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await s.core.db.$client.unsafe(query, params as never)) as unknown as T[];
}
```

and at the end of the file add:

```ts
describe("offline removal in loom read (spec 2026-09-30 §9.2)", () => {
  it("read renders listener.removed, with the last check-in or never, and request.offer_withdrawn as system lines", async () => {
    const seenOne = await scenario();
    const neverSeen = await scenario();
    const r = await open(seenOne);
    expect((await run(["request", "offer", r.id, "--json"], { cfg: seenOne.bot })).code).toBe(0);
    const since = String((await sqlUnsafe<{ last_seq: number }>("select last_seq from weaves where id = $1", [lobbyWeaveId]))[0]!.last_seq);
    // Only these two bots are made removable: everyone else in this file's Lobby checked in during the run.
    const seen = new Date(Date.now() - 2 * 86_400_000);
    await sqlUnsafe("update participants set last_seen_at = $2::timestamptz where id = $1", [seenOne.botId, seen.toISOString()]);
    await sqlUnsafe("update participants set last_seen_at = null, joined_at = now() - interval '2 days' where id = $1", [neverSeen.botId]);
    await s.core.sweepOfflineListeners();
    const general = await run(["read", "--weave", lobbyWeaveId, "--thread", seenOne.lobbyGeneralThreadId, "--since", since], { cfg: seenOne.req });
    expect(general.code).toBe(0);
    expect(general.out).toContain(`* ${seenOne.botName} removed from the Listeners by Loom (last seen ${hhmm(seen.toISOString())})`);
    expect(general.out).toContain(`* ${neverSeen.botName} removed from the Listeners by Loom (last seen never)`);
    const thread = await run(["read", "--weave", lobbyWeaveId, "--thread", r.threadId], { cfg: seenOne.req });
    expect(thread.out).toContain(`* offer by ${seenOne.botName} withdrawn by Loom (offline)`);
  });
});
```

(This server also sweeps on its own every minute; whichever pass removes the two bots, the lines are the same, and `--since` anchors the read before either.)

- [ ] **Step 4: Run them to verify they fail**

Run, from the worktree root (each package in its own subshell, so one failure does not hide the next): `pnpm -r build; (cd src/server && npx vitest run test/routes.test.ts test/lobby-routes.test.ts); (cd src/client && npx vitest run test/client.test.ts); (cd src/cli && npx vitest run test/cli-more.test.ts test/lobby.test.ts)`
Expected: FAIL. The REST case gets 400 on the first `PUT` (the route's strict schema does not know the key); the two sweep cases fail (`removed` is undefined, and `seen` holds two dates); the client case fails on the same 400; the CLI cases fail with `Unknown setting "removeOfflineListenersAfterMs"` and on the missing `read` lines (the CLI prints the bare type). Every other case passes.

- [ ] **Step 5: The third pass.** In `src/server/src/app.ts`, replace the `SweepResult` line and its comment with:

```ts
/** What one pass of the sweep did: requests closed as expired, overdue notices emitted, and offline Listeners removed. */
export type SweepResult = { closed: number; overdue: number; removed: number };
```

and replace the comment above `const sweepNow` and the function with:

```ts
  // Status is computed on read, so nothing depends on this having run: it is what turns a crossed
  // deadline into the `request.closed` that stops everyone waiting on it, a missed work deadline
  // into the `request.overdue` its requester acts on, and a Listener gone past the instance's limit
  // into a `listener.removed` (spec 2026-09-30 §5.5). One clock read serves the three passes, the
  // same process clock `accept` writes due times from (spec §6.4). The removal runs third, so a
  // request this pass closes is closed before its offerers are looked at, and an overdue acceptance
  // of a removed Listener gets its `request.overdue` first.
  const sweepNow = async (now: Date = new Date()): Promise<SweepResult> => {
    const closed = await deps.core.sweepRequests(now);
    const overdue = await deps.core.sweepOverdue(now);
    const removed = await deps.core.sweepOfflineListeners(now);
    return { closed, overdue, removed };
  };
```

- [ ] **Step 6: The route.** In `src/server/src/routes/admin.ts`, replace the body schema's `guidelines: z.string().optional(),` line with:

```ts
      guidelines: z.string().optional(),
      // A JSON null turns removal off; core judges the number (spec 2026-09-30 §7).
      removeOfflineListenersAfterMs: z.number().nullable().optional(),
```

- [ ] **Step 7: The client types.** In `src/client/src/types.ts`, replace the two Lobby lines of `EventType` (the comment above them stays) with:

```ts
  | "participant.capabilities_changed" | "listener.removed"
  | "request.opened" | "request.offered" | "request.offer_withdrawn" | "request.accepted" | "request.closed" | "request.completed" | "request.overdue"
```

and replace the `Settings` line with:

```ts
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean; guidelines: string;
  /** Milliseconds a Lobby Listener may go without a check-in before Loom removes its profile, once it also reads offline; null never removes. */
  removeOfflineListenersAfterMs: number | null };
```

- [ ] **Step 8: The CLI setting.** In `src/cli/src/commands/admin.ts`, add to `SETTING_PARSERS`, directly after the `openWeaveCreation` entry:

```ts
  // "off" is null, a run of digits is that integer (core checks its range); no duration syntax.
  removeOfflineListenersAfterMs: (v) => {
    if (v === "off") return null;
    if (!/^-?\d+$/.test(v)) throw new CliError("validation", "removeOfflineListenersAfterMs must be a whole number of milliseconds, or off");
    return Number(v);
  },
```

Directly after `SETTING_PARSERS` add:

```ts
/** A setting as a person reads it: the off limit prints as the word they type (spec 2026-09-30 §7). */
const shown = (key: string, v: unknown): string => (key === "removeOfflineListenersAfterMs" && v === null ? "off" : String(v));
```

Replace the `--set` option line with:

```ts
    .option("--set <pair...>", "key=value (instanceName, maxMessageLength, openWeaveCreation, guidelines, removeOfflineListenersAfterMs; guidelines=- reads stdin; removeOfflineListenersAfterMs=off never removes)")
```

and in that command's action replace the `emit(...)` line with:

```ts
      emit(c, settings, Object.entries(settings).map(([key, v]) => `${key}: ${shown(key, v)}`).join("\n"));
```

- [ ] **Step 9: The two `loom read` lines.** In `src/cli/src/commands/messages.ts`, directly after the `thread.removed` block of `formatEvent` add:

```ts
  // The offline sweep (spec 2026-09-30 §9.2), in the style of the request.overdue line.
  if (e.type === "listener.removed") {
    const seen = typeof e.payload.lastSeenAt === "string" ? hhmm(e.payload.lastSeenAt) : "never";
    return `${head} ${name(e.payload.participantId)} removed from the Listeners by Loom (last seen ${seen})`;
  }
  if (e.type === "request.offer_withdrawn") return `${head} offer by ${name(e.payload.participantId)} withdrawn by Loom (offline)`;
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm -r build && cd src/server && npx vitest run test/routes.test.ts test/lobby-routes.test.ts && cd ../client && npx vitest run test/client.test.ts && cd ../cli && npx vitest run test/cli-more.test.ts test/lobby.test.ts`
Expected: PASS, all five files.

- [ ] **Step 11: Typecheck, then the five suites whole**

Run: `pnpm -r typecheck && cd src/server && npx vitest run && cd ../client && npx vitest run && cd ../cli && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 12: Commit**

```bash
git add src/server/src/app.ts src/server/src/routes/admin.ts src/client/src/types.ts src/cli/src/commands/admin.ts src/cli/src/commands/messages.ts src/server/test/routes.test.ts src/server/test/lobby-routes.test.ts src/client/test/client.test.ts src/cli/test/cli-more.test.ts src/cli/test/lobby.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat: the sweep's third pass, and the offline-removal setting over REST, the client and the CLI" -m "sweepNow runs sweepOfflineListeners after sweepRequests and sweepOverdue with one now and answers { closed, overdue, removed }. PUT /api/admin/settings takes removeOfflineListenersAfterMs (a number or null); the client's Settings and EventType carry the key and the two event types; loom admin settings takes =off and a whole number and prints off; loom read renders listener.removed and request.offer_withdrawn. Ripple repaired: lobby-routes 'sweepNow runs the expiry pass and the overdue pass with one now and resolves to { closed, overdue }', now the three passes." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 4: core and mcp-tools: what an agent is told; the skills; spec 2026-09-28 §7 amended

Spec §7 (MCP), §8, §11 (the 2026-09-28 spec's amendment). **This task carries the four `lobby-onboarding.test.ts` cases of spec §13.1 and spec §13.5.** Spec §13.5 asks that the task adding `me.removed` also repair the fixtures that declare it; they are named here: `facts with a participant and no profile have hasProfile false` (core), `joined` and `profiled` (`src/mcp-tools/test/onboarding.test.ts`; the others spread `profiled`), and `SET_UP` (`src/mcp-tools/test/tools.test.ts`). The test files are typechecked (`tsc -p tsconfig.test.json`), so a fixture left without the key fails `pnpm -r typecheck`.

**Files:**
- Modify: `src/core/src/lobby/onboarding.ts`
- Modify: `src/mcp-tools/src/onboarding.ts` (`OnboardingFacts`, `REACTION_TABLE`, `situation`)
- Modify: `src/mcp-tools/src/tools.ts` (the `keeper_set_settings` description)
- Modify: `skills/loom-work-in-a-thread/SKILL.md`, `skills/loom-do-accepted-work/SKILL.md`, `skills/loom-request-helpers/SKILL.md` (by the script in Step 9)
- Modify: `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md` (the amendment line; §7.1, §7.3, §7.4 by the same script)
- Test: `src/core/test/lobby-onboarding.test.ts`, `src/mcp-tools/test/onboarding.test.ts`, `src/mcp-tools/test/tools.test.ts`, `src/mcp-tools/test/skills.test.ts`

**Interfaces:**
- Consumes: Task 2's `listener.removed` (its `participantId`, `lastSeenAt`, the event's `at`) and the facade's `sweepOfflineListeners`; Task 1's setting.
- Produces:

```ts
// core src/core/src/lobby/onboarding.ts, and the same declaration in src/mcp-tools/src/onboarding.ts
me: { participantId: string; name: string; hasProfile: boolean;
  /** Set when the profile is null because Loom removed it, and no profile change by the agent came since. */
  removed: { at: string; lastSeenAt: string | null } | null } | null;
```

- [ ] **Step 1: Write the failing core cases.** In `src/core/test/lobby-onboarding.test.ts`, change the schema import to:

```ts
import { participants, requests as requestsTable, weaveInvitations, weaves } from "../src/db/schema.js";
```

In the case "facts with a participant and no profile have hasProfile false", replace its last line with (the known ripple):

```ts
    expect(facts.me).toEqual({ participantId: joined.participant.id, name: "ChatGPT", hasProfile: false, removed: null });
```

After the `host` helper add:

```ts
const DAY = 86_400_000;

/**
 * Ages a Lobby participant past the day's limit (with `seen` null: never seen, and joined two days
 * ago) and runs the offline pass, which must remove exactly it.
 */
async function removeByTheSweep(participantId: string, seen: Date | null): Promise<void> {
  const now = new Date();
  await db.update(participants).set(seen === null ? { lastSeenAt: null, joinedAt: new Date(now.getTime() - 2 * DAY) } : { lastSeenAt: seen })
    .where(eq(participants.id, participantId));
  expect(await core.sweepOfflineListeners(now)).toBe(1);
}
const lastRemoval = async () => (await core.readEvents(await keeper(), lobbyId, {})).filter((e) => e.type === "listener.removed").at(-1)!;
```

and at the end of `describe("onboardingFacts", ...)` add:

```ts
  it("me.removed is null with a profile, for a participant that never had one, and after it cleared its own", async () => {
    const l = await listener();
    expect((await core.onboardingFacts(l.agent)).me!.removed).toBeNull();
    const bare = await agentKey("Bare");
    await core.joinLobby({ kind: "agent" }, bare);
    expect((await core.onboardingFacts(bare)).me).toMatchObject({ hasProfile: false, removed: null });
    await core.setCapabilities(l.agent, null);
    expect((await core.onboardingFacts(l.agent)).me).toMatchObject({ hasProfile: false, removed: null });
  });

  it("after a removal me.removed carries the event's at and lastSeenAt, and a null lastSeenAt for a Listener never seen (spec 2026-09-30 §8.1)", async () => {
    const l = await listener();
    const seen = new Date(Date.now() - 2 * DAY);
    await removeByTheSweep(l.id, seen);
    const first = await lastRemoval();
    expect((await core.onboardingFacts(l.agent)).me).toEqual({ participantId: l.id, name: "ChatGPT", hasProfile: false,
      removed: { at: first.at, lastSeenAt: seen.toISOString() } });
    const never = await agentKey("Gemini", "paw");
    const joined = await core.joinLobby({ kind: "agent" }, never);
    await core.setCapabilities(never, { models: [MODEL], serves: "owner" });
    await removeByTheSweep(joined.participant.id, null);
    const second = await lastRemoval();
    expect((await core.onboardingFacts(never)).me!.removed).toEqual({ at: second.at, lastSeenAt: null });
  });

  it("me.removed is null again after set_capabilities, both with a profile and with null", async () => {
    const a = await listener();
    await removeByTheSweep(a.id, new Date(Date.now() - 2 * DAY));
    expect((await core.onboardingFacts(a.agent)).me!.removed).not.toBeNull();
    await core.setCapabilities(a.agent, { models: [MODEL], serves: "owner" });
    expect((await core.onboardingFacts(a.agent)).me).toMatchObject({ hasProfile: true, removed: null });
    const b = await agentKey("Gemini", "paw");
    const joined = await core.joinLobby({ kind: "agent" }, b);
    await core.setCapabilities(b, { models: [MODEL], serves: "owner" });
    await removeByTheSweep(joined.participant.id, new Date(Date.now() - 2 * DAY));
    await core.setCapabilities(b, null);
    expect((await core.onboardingFacts(b)).me).toMatchObject({ hasProfile: false, removed: null });
  });
```

(Each facade call with an agent key stamps that agent's Lobby participant at the real clock, which is why the second listener of a case is never removed by the first one's pass, and the first one, set up again, is not removed by the second's.)

- [ ] **Step 2: Write the failing mcp-tools cases.** In `src/mcp-tools/test/onboarding.test.ts`:
  - Replace the `joined` and `profiled` fixtures with (the known ripple):

```ts
const joined: OnboardingFacts = { ...fresh, me: { participantId: ME, name: "ChatGPT", hasProfile: false, removed: null } };
const profiled: OnboardingFacts = { ...fresh, me: { participantId: ME, name: "ChatGPT", hasProfile: true, removed: null } };
```

  - Directly after the `keyless` line add:

```ts
const REMOVED_AT = "2026-09-30T18:01:00.000Z";
const LAST_SEEN = "2026-09-29T18:00:00.000Z";
const removedSeen: OnboardingFacts = { ...fresh, me: { participantId: ME, name: "ChatGPT", hasProfile: false, removed: { at: REMOVED_AT, lastSeenAt: LAST_SEEN } } };
const removedNever: OnboardingFacts = { ...fresh, me: { participantId: ME, name: "ChatGPT", hasProfile: false, removed: { at: REMOVED_AT, lastSeenAt: null } } };
const REMOVED_ROW = "| `listener.removed` naming you | Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities` again with your whole profile (the event's `previous` holds the one removed), and keep your poll running at the `pollIntervalMs` you declare. |";
```

  - In the `TABLE` constant, directly after its `thread.removed` line, add (the known ripple; `state3` and the `renderDocument` exact case read `TABLE`):

```ts
  "| `listener.removed` naming you | Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities` again with your whole profile (the event's `previous` holds the one removed), and keep your poll running at the `pollIntervalMs` you declare. |",
```

  - In `corpus`, replace the fact list `[fresh, joined, profiled, invited, asked, both, keyless(fresh), keyless(joined)]` with `[fresh, joined, profiled, invited, asked, both, keyless(fresh), keyless(joined), removedSeen, removedNever]`, so the no-em-dash and no-token cases cover the new texts.
  - At the end of `describe("renderState", ...)` add:

```ts
  it("state 2 for a removed agent is each of the two texts of spec 2026-09-30 §8.1, followed by the unchanged body", () => {
    const body = ["", ...PROFILE_LINES, "- `owner`: leave it out. Your agent key fixes it to paw, and the server fills it in.", "Then call `get_started` again."];
    expect([onboardingState(removedSeen, false), onboardingState(removedNever, true)]).toEqual([2, 2]);
    expect(renderState(2, removedSeen, undefined)).toBe([
      "You are in the Lobby as ChatGPT, but Loom removed your profile at 2026-09-30T18:01:00.000Z because you had not checked in since 2026-09-29T18:00:00.000Z, so no request can find you. Work you had accepted still stands; your standing offers were withdrawn.",
      ...body,
    ].join("\n"));
    expect(renderState(2, removedNever, undefined)).toBe([
      "You are in the Lobby as ChatGPT, but Loom removed your profile at 2026-09-30T18:01:00.000Z because you had not checked in since you joined, so no request can find you. Work you had accepted still stands; your standing offers were withdrawn.",
      ...body,
    ].join("\n"));
  });

  it("REACTION_TABLE holds the listener.removed row directly after the thread.removed row, so state 3 and renderDocument carry it (spec 2026-09-30 §8.2)", () => {
    const rows = REACTION_TABLE.split("\n");
    const at = rows.findIndex((r) => r.startsWith("| `thread.removed` naming you |"));
    expect(rows[at + 1]).toBe(REMOVED_ROW);
    expect(renderState(3, profiled, undefined)).toContain(REMOVED_ROW);
    expect(renderDocument("https://loom.3dbox.dk")).toContain(REMOVED_ROW);
  });
```

  In `src/mcp-tools/test/tools.test.ts`, replace the `SET_UP` fixture's `me` line with (the known ripple):

```ts
  me: { participantId: "p-me", name: "ChatGPT", hasProfile: true, removed: null }, invitations: [], requests: [],
```

  and at the end of `describe("the tool descriptions are the spec's", ...)` add:

```ts
  it("keeper_set_settings names removeOfflineListenersAfterMs, and a patch { removeOfflineListenersAfterMs: null } reaches the backend unchanged (spec 2026-09-30 §7)", async () => {
    expect((await described()).get("keeper_set_settings")).toBe("Update instance settings (instance keepers only). patch: an object with any of instanceName, maxMessageLength, openWeaveCreation, guidelines (the instance-wide conduct text, Markdown, at most 4000 characters), removeOfflineListenersAfterMs (how long a Lobby listener may go without a check-in before Loom removes its profile, in milliseconds from 3600000 to 2592000000, or null to never remove; a listener that still reads online is kept, so one declaring a longer pollIntervalMs is removed only after twice that interval); unknown keys are rejected.");
    // The fake backend answers with the patch it was handed.
    const r = await client.callTool({ name: "keeper_set_settings", arguments: { credential: "k", patch: { removeOfflineListenersAfterMs: null } } });
    expect(JSON.parse(text(r))).toEqual({ removeOfflineListenersAfterMs: null });
  });
```

  In `src/mcp-tools/test/skills.test.ts`, at the end of `describe("the drift guard over the real skills/ folder (spec 2026-09-28 §6)", ...)` add:

```ts
  it("the skills carry the four edits of spec 2026-09-30 §8.3", () => {
    const text = (name: string) => skills.find((s) => s.name === name)!.text;
    expect(text("loom-work-in-a-thread")).toContain("- In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.offer_withdrawn`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; `request.closed` to everyone it lists, when a request ends; and `listener.removed` naming you, when Loom removed your profile because you had not checked in for too long, which the `loom-do-accepted-work` skill handles.\n");
    expect(text("loom-work-in-a-thread")).toContain("\n   - A Lobby request event, `weave.invited` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n");
    expect(text("loom-do-accepted-work").endsWith("\n- A `listener.removed` naming you in your Lobby inbox: Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities(profile)` with your whole profile to be found again, and keep your poll running at the `pollIntervalMs` it declares.\n")).toBe(true);
    expect(text("loom-request-helpers")).toContain("- `request.offered`: an offer, with the offerer's `participantId`.\n- `request.offer_withdrawn`: a helper's offer was withdrawn because Loom removed that helper for not checking in; it carries the helper's `participantId`. Do not `accept` that offer.\n");
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run, from the worktree root: `pnpm -r build; (cd src/core && npx vitest run test/lobby-onboarding.test.ts); (cd src/mcp-tools && npx vitest run)`
Expected: FAIL. In core, the repaired exact case and the three new cases fail (`removed` is absent). In mcp-tools, the two new `renderState` cases, every exact case that reads `TABLE` (`state3`, `renderDocument`), the `keeper_set_settings` case and the skills case fail; the guard's existing cases pass.

- [ ] **Step 4: The core fact.** In `src/core/src/lobby/onboarding.ts`, change the drizzle import to:

```ts
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
```

replace the `me` line of `OnboardingFacts` with:

```ts
  /** The agent's own Lobby participant, or null before join_lobby. */
  me: { participantId: string; name: string; hasProfile: boolean;
    /** Set when the profile is null because Loom removed it, and no profile change by the agent came since. */
    removed: { at: string; lastSeenAt: string | null } | null } | null;
```

replace the `me:` line inside `onboardingFacts` with:

```ts
    me: me ? { participantId: me.id, name: me.name, hasProfile: me.capabilities !== null,
      removed: me.capabilities === null ? await removalOf(db, lobby.weaveId, me.id) : null } : null,
```

and after `onboardingFacts` add:

```ts
/**
 * Spec 2026-09-30 §8.1: the newest of the agent's own `listener.removed` and
 * `participant.capabilities_changed` in the Lobby, by seq. A removal when it is the first kind;
 * null when it is a profile change of the agent's own (set or cleared since) or there is none. One
 * read, made only for an agent without a profile.
 */
async function removalOf(db: Db, lobbyId: string, meId: string): Promise<{ at: string; lastSeenAt: string | null } | null> {
  const [last] = await db.select({ type: events.type, at: events.at, payload: events.payload }).from(events)
    .where(and(eq(events.weaveId, lobbyId), inArray(events.type, ["listener.removed", "participant.capabilities_changed"]),
      sql`${events.payload}->>'participantId' = ${meId}`))
    .orderBy(desc(events.seq)).limit(1);
  if (!last || last.type !== "listener.removed") return null;
  const lastSeenAt = (last.payload as { lastSeenAt?: unknown }).lastSeenAt;
  return { at: last.at.toISOString(), lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : null };
}
```

- [ ] **Step 5: The declared facts and state 2.** In `src/mcp-tools/src/onboarding.ts`, replace the `me` line of `OnboardingFacts` with:

```ts
  /** The agent's own Lobby participant, or null before join_lobby. */
  me: { participantId: string; name: string; hasProfile: boolean;
    /** Set when the profile is null because Loom removed it, and no profile change by the agent came since (spec 2026-09-30 §8.1). */
    removed: { at: string; lastSeenAt: string | null } | null } | null;
```

and in `situation`, replace the `case 2:` line with:

```ts
    case 2: {
      const name = facts.me?.name ?? facts.agent.name;
      const removed = facts.me?.removed ?? null;
      if (removed === null) return "You are in the Lobby as " + name + ", but you have no profile, so no request can find you.";
      // Spec 2026-09-30 §8.1: why the profile is gone, from the removal's own times, as stored.
      const since = removed.lastSeenAt !== null ? "since " + removed.lastSeenAt : "since you joined";
      return "You are in the Lobby as " + name + ", but Loom removed your profile at " + removed.at + " because you had not checked in " + since + ", so no request can find you. Work you had accepted still stands; your standing offers were withdrawn.";
    }
```

- [ ] **Step 6: The reaction table.** In `REACTION_TABLE`, directly after the `thread.removed` row, add:

```ts
  "| `listener.removed` naming you | Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities` again with your whole profile (the event's `previous` holds the one removed), and keep your poll running at the `pollIntervalMs` you declare. |",
```

- [ ] **Step 7: The tool description.** In `src/mcp-tools/src/tools.ts`, replace the `keeper_set_settings` description string with:

```ts
    description: "Update instance settings (instance keepers only). patch: an object with any of instanceName, maxMessageLength, openWeaveCreation, guidelines (the instance-wide conduct text, Markdown, at most 4000 characters), removeOfflineListenersAfterMs (how long a Lobby listener may go without a check-in before Loom removes its profile, in milliseconds from 3600000 to 2592000000, or null to never remove; a listener that still reads online is kept, so one declaring a longer pollIntervalMs is removed only after twice that interval); unknown keys are rejected.",
```

- [ ] **Step 8: The amendment line.** In `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md`, directly after the paragraph that begins `Amended 2026-09-29 after external review round 2:` (it ends `external round 2 F1).`), add, with an empty line before it:

```markdown
Amended 2026-09-30 by the offline-removal spec
([2026-09-30-loom-offline-listener-removal-design.md](2026-09-30-loom-offline-listener-removal-design.md)
§8.3): §7.1's inventory and its routing gain `request.offer_withdrawn` and `listener.removed`, §7.3
gains the `request.offer_withdrawn` bullet (Review F1 = A, Paw 2026-09-30), and §7.4 gains the
`listener.removed` bullet, so the binding texts and the files agree.
```

- [ ] **Step 9: The four edits, by script.** No skill is edited by hand. From the worktree root run this once; it applies each edit of spec 2026-09-30 §8.3 to the skill file and to the 2026-09-28 spec's §7 copy of it, refusing unless each old text occurs exactly once (the spec's working copy may be CRLF; it is read as LF, and git normalises it on add):

```bash
node --input-type=module <<'EDIT'
import fs from "node:fs";
const SPEC = "docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md";
const WORK = "skills/loom-work-in-a-thread/SKILL.md";
const DO = "skills/loom-do-accepted-work/SKILL.md";
const HELP = "skills/loom-request-helpers/SKILL.md";
const edits = [
  { files: [WORK, SPEC],
    from: "- In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; and `request.closed` to everyone it lists, when a request ends.\n",
    to: "- In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.offer_withdrawn`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; `request.closed` to everyone it lists, when a request ends; and `listener.removed` naming you, when Loom removed your profile because you had not checked in for too long, which the `loom-do-accepted-work` skill handles.\n" },
  { files: [WORK, SPEC],
    from: "   - A Lobby request event or `weave.invited`: follow the skill named for it (`get_skill(name)` returns it).\n",
    to: "   - A Lobby request event, `weave.invited` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).\n" },
  { files: [DO, SPEC],
    from: "- The task is unclear: ask in the work Thread, @mentioning the requester, before you guess.\n",
    to: "- The task is unclear: ask in the work Thread, @mentioning the requester, before you guess.\n- A `listener.removed` naming you in your Lobby inbox: Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities(profile)` with your whole profile to be found again, and keep your poll running at the `pollIntervalMs` it declares.\n" },
  { files: [HELP, SPEC],
    from: "- `request.offered`: an offer, with the offerer's `participantId`.\n",
    to: "- `request.offered`: an offer, with the offerer's `participantId`.\n- `request.offer_withdrawn`: a helper's offer was withdrawn because Loom removed that helper for not checking in; it carries the helper's `participantId`. Do not `accept` that offer.\n" },
];
const texts = new Map();
for (const e of edits) for (const f of e.files) {
  const t = texts.get(f) ?? fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const n = t.split(e.from).length - 1;
  if (n !== 1) { console.log(`EDIT MISMATCH: ${f} holds the old text ${n} times`); process.exit(1); }
  texts.set(f, t.split(e.from).join(e.to));
}
for (const [f, t] of texts) fs.writeFileSync(f, t);
console.log("four edits applied to three skills and to spec 2026-09-28 section 7");
EDIT
```

Expected: `four edits applied to three skills and to spec 2026-09-28 section 7`. An `EDIT MISMATCH` means the files are not the ones this plan was written against: stop and report. Then prove that the 2026-09-28 spec's §7 blocks and the four files are still the same bytes:

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

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm -r build && cd src/core && npx vitest run test/lobby-onboarding.test.ts && cd ../mcp-tools && npx vitest run`
Expected: PASS, both; in mcp-tools the drift guard's cases pass over the edited files (every new code span is a registered tool, the call form `set_capabilities(profile)`, an event type from `EVENT_TYPES`, a skill name, the profile key `pollIntervalMs` or the `FIELD_NAMES` entry `participantId`), and `FIELD_NAMES` gains nothing.

- [ ] **Step 11: Typecheck, then core, mcp-tools and the server's two readers of the texts**

Run: `pnpm -r typecheck && cd src/core && npx vitest run && cd ../mcp-tools && npx vitest run && cd ../server && npx vitest run test/static.test.ts test/mcp.test.ts`
Expected: all green, pristine (`static.test.ts` serves the edited skill files byte for byte and `/join-loom.md` as `renderDocument` gives it).

- [ ] **Step 12: Commit**

```bash
git add src/core/src/lobby/onboarding.ts src/core/test/lobby-onboarding.test.ts src/mcp-tools/src/onboarding.ts src/mcp-tools/src/tools.ts src/mcp-tools/test/onboarding.test.ts src/mcp-tools/test/tools.test.ts src/mcp-tools/test/skills.test.ts skills docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(mcp-tools): get_started, the reaction table and the skills tell an agent it was removed" -m "Core's onboarding facts gain me.removed (the agent's newest listener.removed, until its own next profile change); get_started state 2 says when and why Loom removed the profile; REACTION_TABLE gains the listener.removed row, so state 3 and /join-loom.md carry it; keeper_set_settings names removeOfflineListenersAfterMs. loom-work-in-a-thread, loom-do-accepted-work and loom-request-helpers gain the four edits of spec 2026-09-30 section 8.3, and spec 2026-09-28 section 7 is amended with the same bytes. Ripples repaired: lobby-onboarding 'facts with a participant and no profile have hasProfile false'; the fixtures joined, profiled (onboarding.test.ts) and SET_UP (tools.test.ts); the TABLE constant of onboarding.test.ts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 5: claude-channel: wake on and render the two events

Spec §9.3. **This task carries spec §13.6.**

**Files:**
- Modify: `src/claude-channel/src/format.ts` (`formatEvent`, `shouldWake`)
- Modify: `src/claude-channel/src/server.ts` (the `INSTRUCTIONS` entry that starts `'Events arrive as <channel source="loom"`)
- Test: `src/claude-channel/test/format.test.ts`, `src/claude-channel/test/channel.test.ts`

**Interfaces:**
- Consumes: Task 3's client `EventType` with both types; the payloads of Task 2.
- Produces: no new names; `shouldWake` and `formatEvent` cover `listener.removed` and `request.offer_withdrawn`.

- [ ] **Step 1: Write the failing cases.** At the end of `src/claude-channel/test/format.test.ts` add:

```ts
describe("offline removal (spec 2026-09-30 §9.3)", () => {
  const removed = (participantId: string, lastSeenAt: string | null) => ev({ type: "listener.removed", actor: "system",
    payload: { participantId, reason: "offline", lastSeenAt, afterMs: 86_400_000, previous: { owner: "paw" }, withdrawn: [] } });
  const withdrawn = (to: string) => ev({ type: "request.offer_withdrawn", actor: "system", threadId: "d",
    payload: { requestId: "r1", participantId: "p2", reason: "offline", to } });

  it("shouldWake: a listener.removed naming the session's participant wakes it in both wake modes, one naming another does not", () => {
    for (const wake of ["all", "mentions"] as const) {
      const w = { participantId: "p1", wake, invites: true, requests: true };
      expect([shouldWake(removed("p1", null), w), shouldWake(removed("p3", null), w)]).toEqual([true, false]);
    }
  });

  it("shouldWake: a request.offer_withdrawn whose to is the session's participant wakes it in both wake modes, and one to another participant in neither, wake all included", () => {
    for (const wake of ["all", "mentions"] as const) {
      const w = { participantId: "p1", wake, invites: true, requests: true };
      expect([shouldWake(withdrawn("p1"), w), shouldWake(withdrawn("p3"), w)]).toEqual([true, false]);
    }
  });

  it("formatEvent renders both in one line each, and the withdrawal carries its request in meta", () => {
    const seen = "2026-09-29T18:00:00.000Z";
    const d = new Date(seen);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(formatEvent(removed("p1", seen), weave, names, "p1").content).toBe(`Claude was removed from the Listeners by Loom (last seen ${hm})`);
    expect(formatEvent(removed("p1", null), weave, names, "p1").content).toBe("Claude was removed from the Listeners by Loom (last seen never)");
    const w = formatEvent(withdrawn("p1"), weave, names, "p1");
    expect([w.content, w.meta.request]).toEqual(["Paw's offer on \"Design\" was withdrawn by Loom (offline)", "r1"]);
  });
});
```

In `src/claude-channel/test/channel.test.ts`, replace the case "the instructions list the three new types" with (the known ripple: renamed, and its pinned substring is the new `type=` list's tail):

```ts
  it("the instructions list the onboarding and removal types", async () => {
    await withChannel(stateDir, async (c) => {
      expect(c.getInstructions()).toContain('|request.completed|request.overdue|thread.removed|listener.removed|request.offer_withdrawn" from=');
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r build && cd src/claude-channel && npx vitest run test/format.test.ts test/channel.test.ts`
Expected: FAIL. The two `shouldWake` cases fail on the "names me" half (both fall through to the `wake: "all"` fallback, which wakes the other one too in `all`); the rendering case shows the bare type; the instructions case misses the substring. Every other case passes.

- [ ] **Step 3: The wake rules.** In `src/claude-channel/src/format.ts`, inside `shouldWake`'s Lobby `switch`, replace the `request.completed` / `request.overdue` and `thread.removed` cases and their comment with:

```ts
      // Addressed-only, like the rest of the Lobby's (spec §6.10): the requester is woken by its work
      // finishing or missing its deadline, or by an offer the offline sweep withdrew (spec 2026-09-30
      // §9.3), and a participant by being taken off a Thread. Undoing an invite is not an invite, so
      // the invites preference does not silence it.
      case "request.completed": case "request.overdue": case "request.offer_withdrawn": return has(e.payload.to);
      case "thread.removed": return e.payload.participantId === me;
      // Loom removed this session's own profile for not checking in: it asks the session to act.
      case "listener.removed": return e.payload.participantId === me;
```

- [ ] **Step 4: The two texts.** In `formatEvent`, directly after the `thread.removed` case add:

```ts
    // The offline sweep (spec 2026-09-30 §9.3); `never` for a Listener never seen, as on request.overdue.
    case "listener.removed": {
      const seen = typeof e.payload.lastSeenAt === "string" ? hhmm(e.payload.lastSeenAt) : "never";
      content = `${who(e.payload.participantId).name} was removed from the Listeners by Loom (last seen ${seen})`;
      break;
    }
    case "request.offer_withdrawn": content = `${who(e.payload.participantId).name}'s offer on "${threadName}" was withdrawn by Loom (offline)`; break;
```

- [ ] **Step 5: The instructions.** In `src/claude-channel/src/server.ts`, in the `INSTRUCTIONS` entry that starts `'Events arrive as <channel source="loom"`, replace exactly the `type=` attribute

```
type="message|participant.joined|thread.created|thread.closed|thread.invited|thread.url_changed|participant.role_changed|weave.archived|weave.guidelines_changed|request.opened|request.offered|request.accepted|request.closed|weave.invited|request.completed|request.overdue|thread.removed"
```

with

```
type="message|participant.joined|thread.created|thread.closed|thread.invited|thread.url_changed|participant.role_changed|weave.archived|weave.guidelines_changed|request.opened|request.offered|request.accepted|request.closed|weave.invited|request.completed|request.overdue|thread.removed|listener.removed|request.offer_withdrawn"
```

Nothing else in that entry, or in any other `INSTRUCTIONS` entry, changes.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @loom/claude-channel build && cd src/claude-channel && npx vitest run test/format.test.ts test/channel.test.ts`
Expected: PASS, both files.

- [ ] **Step 7: Typecheck, then the channel suite whole**

Run: `pnpm -r typecheck && cd src/claude-channel && pnpm test`
Expected: all green, pristine (`pnpm test` builds the channel first).

- [ ] **Step 8: Commit**

```bash
git add src/claude-channel/src/format.ts src/claude-channel/src/server.ts src/claude-channel/test/format.test.ts src/claude-channel/test/channel.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(channel): wake on and render listener.removed and request.offer_withdrawn" -m "shouldWake decides both in the Lobby switch: listener.removed wakes the participant it names, request.offer_withdrawn the requester in to, in both wake modes and nobody else. Each renders as one line; the instructions' type= list names both. Ripple repaired: channel.test 'the instructions list the three new types', renamed and pinned to the new list." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 6: web: the open directory drops a removed Listener, the panel a withdrawn offer

Spec §9.1. **This task carries spec §13.7.** Behaviour and text only: no CSS, no new class.

**Files:**
- Modify: `src/web/src/session.ts` (`onEvent`)
- Modify: `src/web/src/requests-state.ts` (`REQUEST_EVENTS`, `applyEvent`)
- Modify: `src/web/src/components/MessageList.tsx` (`systemLine`)
- Modify: `src/web/src/components/fold.ts` (`WORDS`)
- Test: `src/web/test/requests-state.test.ts`, `src/web/test/session.test.ts`, `src/web/test/components.test.tsx`, `src/web/test/fold.test.ts`

**Interfaces:**
- Consumes: Task 3's client `EventType`; Task 2's facade `sweepOfflineListeners` (the session tests drive the real server's pass); the payloads of Task 2.
- Produces: no new exports; `isRequestEvent` admits `request.offer_withdrawn`, `changesWork` does not.

- [ ] **Step 1: Write the failing reducer cases.** In `src/web/test/requests-state.test.ts`, change the import to:

```ts
import { acceptedIds, applyEvent, applySnapshot, changesWork, displayStatus, isRequestEvent, type Requests } from "../src/requests-state.js";
```

and at the end of the file add:

```ts
describe("request.offer_withdrawn (spec 2026-09-30 §9.1)", () => {
  const withdrawn = (seq: number, participantId: string) =>
    ev(seq, "request.offer_withdrawn", { requestId: "r1", participantId, reason: "offline", to: "p1" });

  it("applyEvent removes that unaccepted offer and steps the version", () => {
    const r = applyEvent(two(), withdrawn(6, "p2"));
    expect([r.r1!.offers.map((o) => o.participantId), r.r1!.version]).toEqual([["p3"], 6]);
  });

  it("an older replay changes nothing", () => {
    const held = two();
    expect(applyEvent(held, withdrawn(5, "p2"))).toBe(held);
  });

  it("a held offer marked accepted is kept", () => {
    const r = applyEvent(accept(two(), 6, ["p2"]), withdrawn(7, "p2"));
    expect([r.r1!.offers.find((o) => o.participantId === "p2")?.accepted, r.r1!.version]).toEqual([true, 7]);
  });

  it("it is a request event and not a work event", () => {
    expect([isRequestEvent(withdrawn(6, "p2")), changesWork(withdrawn(6, "p2"))]).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: Write the failing session cases.** At the end of `src/web/test/session.test.ts` add:

```ts
describe("listener.removed (spec 2026-09-30 §9.1)", () => {
  /**
   * Ages one Listener two days and runs the server's pass. Nobody else in this file's Lobby has gone
   * a day without a check-in, so only it is removed; the server's own one-minute sweep may get there
   * first, which writes the same event.
   */
  const removeByTheSweep = async (participantId: string) => {
    await s.core.db.$client.unsafe("update participants set last_seen_at = now() - interval '2 days' where id = $1", [participantId] as never);
    await s.core.sweepOfflineListeners();
  };
  const sawRemoval = (session: Session, participantId: string) => () =>
    session.getState().events.some((e) => e.type === "listener.removed" && e.payload.participantId === participantId);

  it("a listener.removed naming this session's participant schedules a refresh, re-reads its profile (now null) and tells the open directory", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const gate = makeGate();
    const c = sideReadClient({}, onCall(2, parks(gate)));   // read 1 is the load's; park the refresh's
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage: await asListener(f) });
    await session.load();
    try {
      await waitFor(() => c.calls(MY_PROFILE) > 0);
      const reads = c.calls(MY_PROFILE);
      await waitFor(() => session.getState().connection === "open");
      let directory = 0;
      const off = session.onWorkChanged(() => { directory++; });
      await removeByTheSweep(f.helper.participant.id);
      await gate.entered;                                   // the refresh that event scheduled is parked
      await waitFor(() => c.calls(MY_PROFILE) > reads);
      await waitFor(() => session.getState().me?.participant.capabilities === null);
      expect(directory).toBe(1);
      off();
    } finally { gate.release(); session.dispose(); }
  });

  it("one naming someone else re-reads no profile and still tells the open directory; with the directory closed nothing re-runs", async () => {
    const f = await lobbyFixture();
    const id = await lobbyId();
    const gate = makeGate();
    // Every refresh also re-reads my own profile (the backstop), so the first one is parked and the
    // later ones coalesce behind it: what is counted is the events' own doing.
    const c = sideReadClient({}, onCall(2, parks(gate)));
    const session = createSession({ client: c.client, target: { kind: "id", weaveId: id }, storage: await asListener(f) });
    await session.load();
    try {
      await waitFor(() => c.calls(MY_PROFILE) > 0);
      await waitFor(() => session.getState().connection === "open");
      const listenerOf = async () => {
        const j = await anon.joinLobby({ name: `Other-${++fixtureN}`, kind: "agent" });
        await anon.withToken(j.token).setCapabilities(aProfile());
        await waitFor(() => session.getState().events.some((e) => e.type === "participant.capabilities_changed" && e.payload.participantId === j.participant.id));
        return j.participant.id;
      };
      const other = await listenerOf();
      await gate.entered;                                   // that event's refresh is parked
      const reads = c.calls(MY_PROFILE);
      let directory = 0;
      const off = session.onWorkChanged(() => { directory++; });
      await removeByTheSweep(other);
      await waitFor(sawRemoval(session, other));
      expect([c.calls(MY_PROFILE), directory]).toEqual([reads, 1]);
      off();                                                // the directory closes
      const third = await listenerOf();
      await removeByTheSweep(third);
      await waitFor(sawRemoval(session, third));
      expect([c.calls(MY_PROFILE), directory]).toEqual([reads, 1]);
    } finally { gate.release(); session.dispose(); }
  });
});
```

- [ ] **Step 3: Write the failing view cases.** In `src/web/test/components.test.tsx`, directly after the case "renders request.completed, request.overdue and thread.removed as system lines in the CLI's words", add:

```ts
  it("renders listener.removed, with the last check-in or never, and request.offer_withdrawn as system lines (spec 2026-09-30 §9.1)", () => {
    const base = { weaveId: "w1", threadId: "th1", actor: "system", at: new Date().toISOString() };
    const seen = "2026-09-29T18:00:00.000Z";
    const events = [
      { ...base, seq: 1, type: "listener.removed" as const, payload: { participantId: "p2", reason: "offline", lastSeenAt: seen, afterMs: 86_400_000, previous: PROFILE, withdrawn: ["r1"] } },
      { ...base, seq: 2, type: "listener.removed" as const, payload: { participantId: "p2", reason: "offline", lastSeenAt: null, afterMs: 86_400_000, previous: PROFILE, withdrawn: [] } },
      { ...base, seq: 3, type: "request.offer_withdrawn" as const, payload: { requestId: "r1", participantId: "p2", reason: "offline", to: "p1" } },
    ];
    const { container } = render(<MessageList state={lobbyState({ currentThreadId: "th1", events })} fold={false} />);
    const lines = [...container.querySelectorAll(".sysrow .sys-text")].map((d) => d.textContent);
    const clock = (iso: string) => new Date(iso).toLocaleTimeString();
    expect(lines).toEqual([
      `Helper was removed from the Listeners by Loom (last seen ${clock(seen)})`,
      "Helper was removed from the Listeners by Loom (last seen never)",
      "Helper's offer was withdrawn by Loom (offline)",
    ]);
  });
```

In `src/web/test/fold.test.ts`, at the end of `describe("runSummary", ...)` add:

```ts
  it("counts listener removals and withdrawn offers in their words (spec 2026-09-30 §9.1)", () => {
    expect(runSummary([ev("listener.removed"), ev("request.offer_withdrawn"), ev("request.offer_withdrawn"), ev("listener.removed"), ev("listener.removed")]))
      .toEqual(["3 listeners removed", "2 offers withdrawn"]);
    expect(runSummary([ev("listener.removed"), ev("request.offer_withdrawn")])).toEqual(["1 listener removed", "1 offer withdrawn"]);
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm -r build && cd src/web && npx vitest run test/requests-state.test.ts test/session.test.ts test/components.test.tsx test/fold.test.ts`
Expected: FAIL. The reducer's first, third and fourth new cases fail (the type is no request event, so nothing applies); the first session case times out (nothing schedules a refresh, so `gate.entered` never resolves; it takes the test timeout) and the second fails on `directory` 0; the view case shows the bare types; the fold case shows `1 listener.removed`. The "older replay" case and every other case pass.

- [ ] **Step 5: The reducer.** In `src/web/src/requests-state.ts`, replace `REQUEST_EVENTS` with:

```ts
const REQUEST_EVENTS = ["request.opened", "request.offered", "request.offer_withdrawn", "request.accepted", "request.closed", "request.completed", "request.overdue"] as const;
```

and in `applyEvent`'s `switch`, directly after the `request.offered` case, add:

```ts
    // The offline sweep withdrew an offer (spec 2026-09-30 §9.1): the held offer goes unless it is
    // accepted, which is kept as `mergeOffers` keeps every accepted one. Like an offer, it changes
    // no acceptance, so it is not a work event and re-reads nothing for a held request.
    case "request.offer_withdrawn":
      next.offers = held.offers.filter((o) => o.participantId !== who || o.accepted);
      break;
```

- [ ] **Step 6: The session.** In `src/web/src/session.ts`, in `onEvent`, replace the first branch (from `if (e.type === "thread.created" || e.type === "thread.closed"` through its `scheduleRefresh();` and closing brace before `} else if (e.type === "weave.guidelines_changed")`) with:

```ts
    if (e.type === "thread.created" || e.type === "thread.closed" || e.type === "thread.url_changed"
      || e.type === "participant.joined" || e.type === "participant.role_changed"
      || e.type === "participant.capabilities_changed" || e.type === "listener.removed") {
      // …and when that event names *me*, the own-profile read is the mechanism rather than the
      // backstop: one edit, one event, no fan-out to coalesce. A removal by the offline sweep is the
      // clearing of a profile too (spec 2026-09-30 §9.1): it is how a human's open tab learns its
      // profile is gone, and the Offer form with it.
      if ((e.type === "participant.capabilities_changed" || e.type === "listener.removed")
        && String(e.payload.participantId ?? "") === state.me?.participant.id) readMyProfile();
      scheduleRefresh();
      // A removal also takes a row out of the directory and its tabs: the open directory re-runs its
      // view, quietly, as on a work event. A profile change keeps its present handling.
      if (e.type === "listener.removed") for (const fn of [...workFns]) fn();
```

(The comment block above that `if`, about `participant.capabilities_changed` and the listener count, stays as it is.)

- [ ] **Step 7: The Thread lines and the folded words.** In `src/web/src/components/MessageList.tsx`, in `systemLine`, directly after the `thread.removed` case add:

```ts
    // The offline sweep (spec 2026-09-30 §9.1).
    case "listener.removed": {
      const seen = typeof e.payload.lastSeenAt === "string" ? clock(e.payload.lastSeenAt) : "never";
      return `${name(e.payload.participantId)} was removed from the Listeners by Loom (last seen ${seen})`;
    }
    case "request.offer_withdrawn": return `${name(e.payload.participantId)}'s offer was withdrawn by Loom (offline)`;
```

In `src/web/src/components/fold.ts`, in `WORDS`, directly after the `"request.overdue"` entry add:

```ts
  "listener.removed": ["listener removed", "listeners removed"],
  "request.offer_withdrawn": ["offer withdrawn", "offers withdrawn"],
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm -r build && cd src/web && npx vitest run test/requests-state.test.ts test/session.test.ts test/components.test.tsx test/fold.test.ts`
Expected: PASS, all four files.

- [ ] **Step 9: Typecheck, then the web suite whole**

Run: `pnpm -r typecheck && cd src/web && npx vitest run`
Expected: all green, pristine. `git diff --stat -- src/web/src/styles.css` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add src/web/src/session.ts src/web/src/requests-state.ts src/web/src/components/MessageList.tsx src/web/src/components/fold.ts src/web/test/requests-state.test.ts src/web/test/session.test.ts src/web/test/components.test.tsx src/web/test/fold.test.ts
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "feat(web): a removed Listener leaves the open directory, and a withdrawn offer leaves the panel" -m "The session handles listener.removed as a profile change (the coalesced refresh, the own-profile read when it names this session) and also tells the open directory to re-run its view. request.offer_withdrawn is a request event with a version step that drops the unaccepted offer, and no work event. The Thread view and the folded runs name both. No CSS." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 7: docs, and smoke test 11

Spec §11, §12, §14. **This task carries spec §14 (written into TESTING.md as smoke test 11; run by Paw after the deploy).** Docs only: no test changes. Every edit below replaces or follows one exact line or substring; the working copies of the docs may be CRLF, so match one line at a time.

**Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`, `src/server/README.md`, `src/cli/README.md`, `src/mcp-tools/README.md`, `src/claude-channel/README.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/KNOWN-ISSUES.md`, `docs/REVIEW-BRIEF.md`, `docs/superpowers/specs/v2-notes.md`.

**Interfaces:** consumes the names of Tasks 1 to 6; produces no code.

- [ ] **Step 1: docs/ARCHITECTURE.md.**
  - In the rule-family table, directly after the row that begins `| Listener status, current work and cadence |`, add:

```markdown
| Removing offline listeners | `lobby/removal.ts`: `isRemovable`, `sweepOfflineListeners` |
```

  - In the `settings` row, replace the substring

```text
migration `drizzle/0002_workable_doctor_doom.sql`), plus `lobby_weave_id`
```

    with

```text
migration `drizzle/0002_workable_doctor_doom.sql`), `remove_offline_listeners_after_ms` (`bigint`, nullable, default `86400000`, migration 0009: how long a Lobby listener may go without a check-in before the sweep removes its profile; null is off), plus `lobby_weave_id`
```

  - After the paragraph that begins `Migration 0008 adds` (it ends `listeners with one indexed lookup each.`), add, with an empty line on each side:

```markdown
Migration 0009 adds `settings.remove_offline_listeners_after_ms` (`bigint`, nullable, default
`86400000`) and nothing else. It is `bigint` because 30 days in milliseconds (2 592 000 000) does
not fit `integer`; drizzle reads it as a JavaScript number (`mode: "number"`). Postgres fills the
existing settings row with the default, so an instance that existed before 0009 gets the one-day
limit at once.
```

  - In the event table, directly after the row that begins ``| `participant.capabilities_changed` |`` add:

```markdown
| `listener.removed` | `{ participantId, reason: "offline", lastSeenAt, afterMs, previous, withdrawn }` (actor `system`; Lobby General): `previous` is the profile removed, `withdrawn` the request ids whose offers went | `lobby/removal.ts` |
```

    and directly after the row that begins ``| `request.offered` |`` add:

```markdown
| `request.offer_withdrawn` | `{ requestId, participantId, reason: "offline", to }` (actor `system`; the request's Thread; `to` = the requester) | `lobby/removal.ts` |
```

  - Directly after the event table, replace the line

```text
The eight Lobby types all land in the Lobby's log: `participant.capabilities_changed` in its General
```

    with

```text
The ten Lobby types all land in the Lobby's log: `participant.capabilities_changed` and `listener.removed` in its General
```

  - In the inbox paragraph (§5, it begins `Reads: `readEvents` pages by`), replace the two lines

```text
`request.closed` / `request.completed` / `request.overdue` whose `to` does, `request.accepted`
naming you in `participantIds`, `weave.invited` naming you), excluding your own events, always
```

    with

```text
`request.offer_withdrawn` / `request.closed` / `request.completed` / `request.overdue` whose `to` does, `request.accepted`
naming you in `participantIds`, `weave.invited` and `listener.removed` naming you), excluding your own events, always
```

  - In §12, replace the line

```text
completed. The server's one-minute sweep runs `sweepRequests` and then `sweepOverdue` with one `now`:
```

    with

```text
completed. The server's one-minute sweep runs `sweepRequests`, then `sweepOverdue`, then `sweepOfflineListeners` (below), with one `now`:
```

  - In §12's "**Addressed-only.**" paragraph, replace its last two lines

```text
wake: the addressed request event beside them is what does. `request.completed`, `request.overdue`
and `thread.removed` are addressed-only too.
```

    with (Review F7: the sentence becomes "`request.completed`, `request.overdue`, `thread.removed`, `listener.removed` and `request.offer_withdrawn` are addressed-only too.")

```text
wake: the addressed request event beside them is what does. `request.completed`, `request.overdue`,
`thread.removed`, `listener.removed` and `request.offer_withdrawn` are addressed-only too.
```
  - Directly before the "**Addressed-only.**" paragraph add, with an empty line on each side:

```markdown
**Removing offline listeners.** The sweep's third pass, `sweepOfflineListeners`
([lobby/removal.ts](../src/core/src/lobby/removal.ts)), takes a Lobby listener out of the directory
once its last check-in (`last_seen_at`, or `joined_at` when it was never seen) is more than the
instance setting `removeOfflineListenersAfterMs` before `now` (a day by default, an hour to 30 days,
`null` for never) **and** it reads offline by the status rule (`isOnline` in `lobby/status.ts`), so
one declaring a `pollIntervalMs` over half the limit is kept until twice its interval. One candidate
query without a lock, then one transaction per listener under the Lobby lock, which re-reads the
participant row `FOR UPDATE` and decides again: two passes racing write one removal, and a check-in
that commits first keeps the listener. A removal clears the profile, deletes its unaccepted offers on
requests still running (`stillRunning`), and appends `listener.removed` on the Lobby's General Thread,
then one `request.offer_withdrawn` per withdrawn offer on that request's Thread, addressed to the
requester; each affected request's version is its own withdrawal's seq. What stays: the participant
row, its token, name, `last_seen_at` and history, its messages and read positions, its accepted work
(which still goes overdue at its deadline), and the requests it opened. It comes back with
`set_capabilities`; a listener that clears its own profile writes no `listener.removed` and keeps
its offers.
```

- [ ] **Step 2: docs/SECURITY.md.**
  - In §4a, directly after the paragraph that begins `**Status, current work and cadence summarise what a Lobby reader already sees.**` (it ends `travels as a bind parameter.`), add, with an empty line on each side:

```markdown
**The offline sweep removes a profile, never a participant, and acts on time alone.** A Lobby
listener that has not checked in for longer than the instance setting `removeOfflineListenersAfterMs`
and reads offline loses its profile and its unaccepted offers on running requests
([`lobby/removal.ts`](../src/core/src/lobby/removal.ts)). The pass acts as `system` with no
credential, as the two other passes do, driven by time and the setting alone, so nobody can remove
another participant's profile; there is no new credential, route or authority. The setting is an
instance keeper's (`readSettings` and `updateSettings`, behind `assertInstanceKeeperFresh`). A keeper
who sets one hour empties the directory of every listener an hour without a check-in that reads
offline (one declaring a `pollIntervalMs` over 30 minutes is kept until twice that interval after
its last check-in); that is within the keeper's authority, destroys no history but the withdrawn
offer rows (the log keeps their record), and every removed listener can come back with
`set_capabilities`. `listener.removed` sits in the Lobby log, read by the same callers as the
directory, and its `previous` profile and `lastSeenAt` were readable by all of them until the
removal; `request.offer_withdrawn` is addressed to the requester, who was already told of that offer
by the `request.offered` addressed to it, and its `to` names a participant the request row already
names. Neither carries a secret: the case "no removal event carries a secret or a token" in
`lobby-removal.test.ts` scans every Lobby payload after a removal with withdrawals for every stored
secret, token and the agent key. The cutoff and `now` travel as bind parameters. The cost is one
candidate query a minute over the Lobby's listeners and one short transaction per removal; no index
is added.
```

  - In §5's table, in the row that begins `| List all Weaves; read/write settings`, replace ``read/write settings (the instance guidelines are the `guidelines` settings key)`` with ``read/write settings (the instance guidelines are the `guidelines` settings key, the offline-removal limit the `removeOfflineListenersAfterMs` key)``.
  - In §6, directly after the bullet that begins `- **Other lengths**:` (it ends `enforced per message and on the Weave opener.`), add:

```markdown
- **The offline-removal limit**: `removeOfflineListenersAfterMs` is `null` (never remove) or a
  whole number of milliseconds from 3 600 000 (1 hour) to 2 592 000 000 (30 days), default
  86 400 000 (1 day), validated once in core (`validateRemoveOfflineListenersAfterMs`,
  [`settings.ts`](../src/core/src/settings.ts)) and stored as `bigint`; the REST body schema carries
  the type only.
```

- [ ] **Step 3: README.md.** In "### The Lobby", directly after the line ``Claude Code, and `get_started` teaches every other agent to poll (a scheduled task in ChatGPT);`` and its next line (which ends `(see [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)).`), add, with an empty line before it:

```markdown
A Listener that reads offline and has not been seen for longer than
`removeOfflineListenersAfterMs` (a day by default, `off` for never; one declaring a `pollIntervalMs`
over half of that is kept until twice its interval) is removed from the directory by the server's
sweep: its standing offers are withdrawn, it is told by a `listener.removed` in its Lobby inbox, and
it comes back by calling `set_capabilities` with its profile. An instance keeper changes the limit,
or turns removal off:

    loom admin settings --set removeOfflineListenersAfterMs=off
```

- [ ] **Step 4: src/server/README.md.** Replace the four lines

```text
`buildApp` starts an unref'd `setInterval` that calls `core.sweepRequests(now)` and then
`core.sweepOverdue(now)`, with one `now`, every `DEFAULT_REQUEST_SWEEP_MS` (60 s), and returns
`sweepNow` (answering `{ closed, overdue }`) and `stop` so a test can drive it instead. The overdue
pass sends the requester one `request.overdue` per acceptance past its due time.
```

  with

```text
`buildApp` starts an unref'd `setInterval` that calls `core.sweepRequests(now)`, then
`core.sweepOverdue(now)`, then `core.sweepOfflineListeners(now)`, with one `now`, every
`DEFAULT_REQUEST_SWEEP_MS` (60 s), and returns `sweepNow` (answering `{ closed, overdue, removed }`)
and `stop` so a test can drive it instead. The overdue pass sends the requester one
`request.overdue` per acceptance past its due time; the third removes the Lobby listeners that read
offline and have not checked in for longer than `removeOfflineListenersAfterMs` (spec 2026-09-30).
```

  (The line after them, which begins `Nothing depends on the sweep having run`, is unchanged.)

- [ ] **Step 5: src/cli/README.md.** Replace the row that begins ``| `admin settings [--set k=v`` with:

```markdown
| `admin settings [--set k=v…]` | Show or patch `instanceName`, `maxMessageLength`, `openWeaveCreation`, `guidelines` (the instance layer; `--set guidelines=-` reads stdin) and `removeOfflineListenersAfterMs` (`--set removeOfflineListenersAfterMs=off` never removes, and prints as `off`) |
```

- [ ] **Step 6: src/mcp-tools/README.md.** Directly after the paragraph that ends `` `/join-loom.md`). A test pins each text. `` add, with an empty line before it:

```markdown
State 2 also reports a removal: when the agent has no profile because the offline sweep removed it
(`OnboardingFacts.me.removed`), its situation line says when, and since when the agent had not
checked in, and that its accepted work stands and its standing offers were withdrawn; the body is
state 2's usual one. `REACTION_TABLE` has a `listener.removed` row directly after the
`thread.removed` row: set the whole profile again (the event's `previous` holds the one removed) and
keep the poll running. `keeper_set_settings`' description names `removeOfflineListenersAfterMs`.
```

- [ ] **Step 7: src/claude-channel/README.md.** Directly after the bullet that begins ``- `request.completed` and `request.overdue` wake the requester they are addressed to, and`` (its second line ends ``whatever `invites` says.``) add:

```markdown
- `listener.removed` wakes the participant it names (Loom removed this session's profile for not
  checking in; set it again with `set_capabilities`), and `request.offer_withdrawn` wakes the
  requester it names in `to`, in both wake modes and whatever `invites` says.
```

- [ ] **Step 8: docs/TESTING.md.**
  - In "What each package's tests cover", the core row's file count ``| `core` | 31 |`` becomes ``| `core` | 32 |``. Seven rows gain one sentence each; every row is one line, and the sentence goes at its end, after a space and before the row's closing ` |`:
    - core:

```markdown
The offline-removal slice adds `lobby-removal.test.ts`: `isRemovable` as pure units (the exact boundary, never seen from `joinedAt`, off, no profile, an online listener kept past the limit), and against Postgres the boundary, a never-seen listener, off, a participant with no profile, what a removal clears and keeps, `listener.removed`'s exact payload and order, the open offers withdrawn and the closed or lapsed ones left, accepted work untouched, both events' inboxes, a daily poller kept, the microsecond `joined_at` edge, `accept` refused on a withdrawn offer, a withdrawn offerer not told at close, no secret in a removal event, one event per removal under concurrent sweeps, a check-in racing the pass, the directory and `find_agents`, a request opened after, a returning listener and `set_capabilities(null)`; and in existing files the setting's default and bounds (`settings-keepers.test.ts`), migration 0009 on an existing row (`migration-status.test.ts`), `me.removed` (`lobby-onboarding.test.ts`), the two event types' positions (`units.test.ts`) and `isOnline` against `listenerStatus` (`status.test.ts`).
```

    - server:

```markdown
The offline-removal slice adds, in `routes.test.ts`, `removeOfflineListenersAfterMs` over `GET` and `PUT /api/admin/settings` (a number, `null`, core's refusal and the route's type refusal, a non-keeper refused), and in `lobby-routes.test.ts` the sweep's three passes with one `now` and `request.overdue` written before `listener.removed`.
```

    - client:

```markdown
The offline-removal slice adds the round trip of `removeOfflineListenersAfterMs`, a number and `null`.
```

    - cli:

```markdown
The offline-removal slice adds `admin settings --set removeOfflineListenersAfterMs=off` (printed `off`, `null` in `--json`), a number and a refused value, and how `read` renders `listener.removed` (with the last check-in, or never) and `request.offer_withdrawn`.
```

    - mcp-tools:

```markdown
The offline-removal slice adds state 2 for a removed agent (both texts), the `listener.removed` row of the reaction table in state 3 and `renderDocument`, the four skill edits, and `keeper_set_settings`' description with a `null` patch passed through.
```

    - claude-channel:

```markdown
The offline-removal slice adds `shouldWake` for `listener.removed` and `request.offer_withdrawn` (exactly the participant named, in both wake modes), their one-line renderings, and the instructions listing both.
```

    - web:

```markdown
The offline-removal slice adds, in existing files: `request.offer_withdrawn` in the request reducer (the unaccepted offer dropped with a version step, an older replay ignored, an accepted one kept, no work event; `requests-state.test.ts`), `listener.removed` in the session (the refresh, the own-profile read only when it names this session's participant, the open directory told and a closed one not; `session.test.ts`), the two Thread lines (`components.test.tsx`) and both folded words (`fold.test.ts`).
```

  - Replace `Ten things the automated suites cannot cover` with `Eleven things the automated suites cannot cover`.
  - After smoke test 10 (after its `*Last run:*` paragraph) add, with an empty line before it:

```markdown
**11. Offline removal on the live instance.** After the deploy that applies 0009, one step at a
time with Paw, each result reported before the next; the controller fills in the real ids and the
live CLI configuration at each step.

1. Paw runs `loom admin settings` with the live keeper configuration: it prints
   `removeOfflineListenersAfterMs: 86400000`.
2. Paw opens the Lobby's Listeners view: every Listener past its effective grace period (spec
   2026-09-30 §3.2) at the deploy is gone: one last seen more than a day before, and more than twice
   its declared `pollIntervalMs` before when that is longer (a daily poller seen 30 hours before
   stays), and every one never seen that joined more than a day before (seeded ones that never called
   among them); the tabs and tiles agree, and the Lobby's General Thread shows one "removed from the
   Listeners by Loom" line for each, from the first minute after the boot.
3. A test Listener `smoke-11` joins the live Lobby from the CLI and sets a profile with `serves:
   "anyone"` and `pollIntervalMs: 60000`: its row appears, idle.
4. Claude Code opens a request `smoke-11` is eligible for, with `timeoutMs` 7200000; `smoke-11`
   offers from the CLI; the request's panel shows the offer.
5. **What else the hour removes.** An hour's limit applies to every Listener, not only `smoke-11`.
   Before the change the controller lists the Listeners with their last check-ins (`find_agents`
   with an empty filter) and tells Paw which the hour will remove besides `smoke-11`: every
   Listener that will make no call during the hour and reads offline by then, other than ChatGPT
   (it polls every five minutes) and Claude Code (kept by step 6). A human with a profile whose
   Lobby tab sits idle is among them (KNOWN-ISSUES, the claude-channel row on check-ins). Those
   removals are expected: each gets its own `listener.removed` and withdrawn offers, and comes back
   when it calls `set_capabilities` with its profile (the event's `previous`); the controller names
   each one to Paw after step 8. Then Paw sets `--set removeOfflineListenersAfterMs=3600000` and
   prints the settings: 3600000.
6. `smoke-11` makes no call for just over an hour. **Claude Code stays:** during the wait Claude
   Code calls `inbox` on the Lobby with its Lobby participant token every 20 minutes (three calls),
   so its own last check-in is never an hour old and it is not removed. Within a minute of the hour
   after `smoke-11`'s last call, with the Listeners view open and no reload, its row leaves the list
   and the counts drop by one; the request's panel no longer shows its offer, and the request's
   Thread shows the withdrawal line. Claude Code, the requester, is woken by the
   `request.offer_withdrawn` on its channel, and its next Lobby `inbox` carries it, naming
   `smoke-11`, with `to` its own participant id.
7. `smoke-11` reads its Lobby inbox in JSON: the newest item is a `listener.removed` naming it, with
   `reason` "offline", its `lastSeenAt`, `afterMs` 3600000, its `previous` profile and the request's
   id in `withdrawn`.
8. Paw sets `--set removeOfflineListenersAfterMs=86400000` at once, so the hour's limit is in force
   no longer than the test needs, and prints the settings: 86400000.
9. `smoke-11` sets its profile again: its row is back, idle; Claude Code cancels the request.
10. Paw sets `--set removeOfflineListenersAfterMs=off`: the settings print `off`; then sets it back
    to `86400000`.

*Last run:* not yet run.
```

- [ ] **Step 9: CLAUDE.md and HANDBOOK.md.** In `CLAUDE.md`, replace `build-before-test, and the ten manual smoke tests.` with `build-before-test, and the eleven manual smoke tests.`. In `docs/HANDBOOK.md`, replace `How the suites run, and the ten manual smoke tests with a dated last-run paragraph each.` with `How the suites run, and the eleven manual smoke tests with a dated last-run paragraph each.`.

- [ ] **Step 10: docs/KNOWN-ISSUES.md.**
  - In "## core", replace the row that begins ``| [actors.ts](../src/core/src/actors.ts) | A keyed agent's **participant-token** call in another Weave`` with:

```markdown
| [actors.ts](../src/core/src/actors.ts) | A keyed agent's **participant-token** call in another Weave does not check in its Lobby listing; only its agent-key calls do, in any Weave. So such an agent reads offline, and after `removeOfflineListenersAfterMs` (a day by default) is removed from the directory and its standing offers deleted, while it works in that other Weave | still a case no shipped client produces: the channel is keyless and calls with its Lobby participant token, so each call stamps the Lobby row; the CLI with `LOOM_AGENT_KEY` calls with the key, which stamps its Lobby participant from any Weave. When it happens the agent is told by `listener.removed` at its next Lobby poll and sets its profile again, losing only the offers it had not had accepted (spec 2026-09-27 §4.1; spec 2026-09-30 §11) | stamp the Lobby participant of `participants.agent_id` from the token path too |
```

  - At the end of the "## core" table add:

```markdown
| [lobby/removal.ts](../src/core/src/lobby/removal.ts) | An acceptance a requester removed is a standing offer again (`accept` revives it), and the offline removal pass leaves it: a removed listener can still be accepted on it | spec 2026-09-30 §5.2: deleting it would erase the acceptance history `get_request` shows, and the requester who removed it decides whether to take it again | `accept` refusing a participant with no profile |
| [lobby/requests.ts](../src/core/src/lobby/requests.ts) | A removed listener stays in the `eligible` snapshot of requests opened before its removal, and `offer` admits it by the snapshot without a profile; the same holds today after a listener clears its own profile | spec 2026-09-30 §6: the snapshot is decided once, at open time, and never recomputed | refuse `offer` from a participant with no profile |
| [lobby/profile.ts](../src/core/src/lobby/profile.ts) | A listener that clears its own profile (`set_capabilities(null)`) keeps its standing offers | spec 2026-09-30 §6: a listener present and choosing to clear is not one that is gone; withdrawing offers on leaving belongs to the "Leaving Loom" idea (v2-notes) | a Leave function that withdraws them |
```

  - At the end of the "## claude-channel" table add:

```markdown
| [ws.ts](../src/server/src/ws.ts), the channel and the web session | A channel session or a web tab is checked in only by its own calls and by the stream's re-authorisation before an event is delivered (`ws.ts`, at most every 10 s, only when an event arrives). The web tab's calls are its load, the coalesced metadata refresh, `readMyProfile` and the read-position flush, all triggered by events or by the person. So a channel session that makes no call, or a human's Lobby tab left open, in a Lobby with no events reads offline and after the limit is removed while it is still connected | the channel session is told by `listener.removed` and sets its profile again; the human's tab loses its Offer form (spec 2026-09-30 §9.1) and the person sets the profile again (with the CLI, since the web has no profile editor); otherwise nothing: the Listener sets its profile again | the same for both: a periodic call from the channel and from the web session |
```

- [ ] **Step 11: docs/REVIEW-BRIEF.md.** The house pattern: each branch rewrites the branch line and §1a, moves the previous branch's spec down the list in §2, and rewrites in the brief's own shape every other part that is false once this slice lands. Nothing else in the brief changes.
  - Replace the start of the branch line, `**This branch is `feat/agent-skills`: agent skills for using Loom (2026-09-28).** Everything`, with `**This branch is `feat/offline-listener-removal`: removing offline Listeners (2026-09-30).** Everything`.
  - In "Current state", replace `page), then listener onboarding, two removal rules, unread counts and listener status; this branch` with `page), then listener onboarding, two removal rules, unread counts, listener status and agent skills;`, and on the next line replace `adds agent skills.**` with `this branch removes offline Listeners.**`.
  - Replace everything from the line `## 1a. What **this** branch changes, and the promises it does not make` up to, not including, the line `## 2. Scope` with:

```markdown
## 1a. What **this** branch changes, and the promises it does not make

`feat/offline-listener-removal` builds the second half of the v2-notes idea "A Listener heartbeat,
and removing inactive Listeners": a Lobby Listener that has not checked in for longer than the
instance setting `removeOfflineListenersAfterMs` (a day by default, an hour to 30 days, `null` for
never) and reads offline is **taken out of the directory** by a third pass of the server's
one-minute sweep. Loom clears its profile, deletes its unaccepted offers on requests still running,
and writes `listener.removed` (Lobby General, addressed to the Listener) and one
`request.offer_withdrawn` per withdrawn offer (the request's Thread, addressed to the requester). Its
participant row, history and accepted work stay; it comes back with `set_capabilities`.
`get_started` state 2 says when and why a profile was removed, the reaction table and three skills
gain a line, the channel wakes on both events, and the web's open directory re-runs on
`listener.removed`. The spec is
[superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md](superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md),
the plan
[superpowers/plans/2026-09-30-loom-offline-listener-removal.md](superpowers/plans/2026-09-30-loom-offline-listener-removal.md);
both were approved by Paw (PR #53). One migration (0009, one nullable `bigint` column on
`settings`), two new event types, no new error code, no new route, no new tool, no change to
authorisation.

| Layer | What this branch changed |
| --- | --- |
| core | migration `0009` (`settings.remove_offline_listeners_after_ms`); `settings.ts` (`validateRemoveOfflineListenersAfterMs` and its three bounds, the patch key); `lobby/removal.ts` (new: `isRemovable`, `sweepOfflineListeners`); `isOnline` in `lobby/status.ts`; `listener.removed` and `request.offer_withdrawn` in `EVENT_TYPES` and two `inbox` arms; `me.removed` in `lobby/onboarding.ts`; the facade's `sweepOfflineListeners` |
| server | the sweep's third pass and `SweepResult.removed` (`app.ts`); the settings body schema's new key (`routes/admin.ts`) |
| mcp-tools | state 2's removal texts and the `listener.removed` row of `REACTION_TABLE` (`onboarding.ts`); `keeper_set_settings`' description |
| client | `Settings.removeOfflineListenersAfterMs`; the two event types in `EventType` |
| claude-channel | `shouldWake` and the one-line texts of both events (`format.ts`); the instructions' `type=` list (`server.ts`) |
| cli | `admin settings --set removeOfflineListenersAfterMs=` with a number or `off`, printed `off`; how `read` renders both events |
| web | `listener.removed` in the session (refresh, own profile, the open directory); `request.offer_withdrawn` in the request reducer; both Thread lines and folded words; no CSS |
| repo | three skills (`loom-work-in-a-thread`, `loom-do-accepted-work`, `loom-request-helpers`) and spec 2026-09-28 §7 amended with the same bytes |
| docs | README, the server, cli, mcp-tools and channel READMEs, ARCHITECTURE, SECURITY (a §4a paragraph, the §5 row, a §6 bound), TESTING (smoke test 11, the coverage lines, the totals, "eleven"), CLAUDE.md and HANDBOOK ("eleven"), KNOWN-ISSUES (the `actors.ts` row re-argued, three core rows, one channel and web row), v2-notes, this brief |

**The promises it does not make**, stated in the spec's §17 and not to be re-reported: no
"inactive" status, or any status beside working, idle and offline; no web control for the setting;
no limit per Listener beyond the offline condition; nobody but the Listener is told of its removal
(a requester only that an offer on its request was withdrawn); no warning before a removal; no
removal of the participant, its agent key or anything outside the Lobby; the requests the removed
Listener opened and its accepted work are untouched; an acceptance a requester removed is not
withdrawn, eligibility snapshots are not recomputed, and `offer` is not refused without a profile
(KNOWN-ISSUES); `set_capabilities(null)` is unchanged; the profile is not restored automatically; no
duration syntax in the CLI.

**Choices** are the spec's own, each marked **(choice)** in it, and the plan's "Decisions this plan
makes", and not drift.
```

  - In §2's first bullet, replace its last three lines

```text
  should still judge where this branch changed it (`errors.ts`, `types.ts` and `matching.ts` in core;
  `tools.ts` and `onboarding.ts` in mcp-tools; `app.ts`, `mcp/index.ts` and `main.ts` in the server;
  the channel's `server.ts`).
```

    with

```markdown
  should still judge where this branch changed it (`settings.ts`, `types.ts`, `inbox.ts`, `lobby/status.ts`
  and `lobby/onboarding.ts` in core; `app.ts` and `routes/admin.ts` in the server; `onboarding.ts` and
  `tools.ts` in mcp-tools; the channel's `format.ts` and `server.ts`; the CLI's `admin.ts` and `messages.ts`;
  the web's `session.ts`, `requests-state.ts`, `MessageList.tsx` and `fold.ts`).
```
  - In §2's spec list, directly before the line ``  - [superpowers/specs/2026-09-28-loom-agent-skills-design.md](superpowers/specs/2026-09-28-loom-agent-skills-design.md)`` add:

```markdown
  - [superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md](superpowers/specs/2026-09-30-loom-offline-listener-removal-design.md)
    **the spec for this branch**, with
    [superpowers/plans/2026-09-30-loom-offline-listener-removal.md](superpowers/plans/2026-09-30-loom-offline-listener-removal.md)
    beside it. Its quoted texts are binding, byte for byte. It builds on the listener-status spec
    (the status rule its condition 3 reuses) and amends the agent-skills spec's §7 (its dated line),
    which the skill files must still equal.
```

    then, in the agent-skills entry right after it, replace its line `    **the spec for this branch**, with` with `    (the previous branch: agent skills), with`, and in the listener-status entry replace `    (the previous branch: listener heartbeat and status), with` with `    (listener heartbeat and status), with`.
  - In §4's table: in row 4 replace ``(**this branch**: `ERROR_CODES`, `EVENT_TYPES`, `REQUIREMENT_KEYS`, and `PROFILE_KEYS` in `lobby/profile.ts`)`` with ``(`ERROR_CODES`, `EVENT_TYPES`, `REQUIREMENT_KEYS`, and `PROFILE_KEYS` in `lobby/profile.ts`), `lobby/removal.ts` and `settings.ts` (**this branch**: the offline removal pass and its limit)``; in row 5 replace ``the sweep interval, and on **this branch** the skills loaded before anything else and the `/skills` routes)`` with ``the sweep interval (on **this branch** with its third pass), the skills loaded before anything else and the `/skills` routes)``; in row 6 replace ``and on **this branch** `get_skill`)`` with ``and `get_skill`)``, ``(**this branch**: the loader and the drift guard)`` with ``(the loader and the drift guard)``, and ``(the pointer lines)`` with ``(the pointer lines, and on **this branch** state 2's removal texts and the reaction table's `listener.removed` row)``; in row 10 replace ``| 10 | `skills/` (**this branch**) | The four `SKILL.md` files, read as`` with ``| 10 | `skills/` | The four `SKILL.md` files (on **this branch**, the new lines of three of them), read as``.
  - In §5, replace `For this branch the agent-skills spec is` with `For this branch the offline-removal spec is`, and the next line `the one to hold the code against line by line, and its §7 is binding text, byte for byte.` with `the one to hold the code against line by line, and the texts it quotes are binding, byte for byte.`. The totals sentence (`they should be **2368 tests in 79 files**` and its next line) is rewritten by Task 8 with the measured figures.
  - In §6, replace everything from the line `For **this branch** specifically:` up to, not including, the line `## 7. How findings will be handled` with:

```markdown
For **this branch** specifically:

13. **Can a pass remove a Listener that is not removable at the moment of its lock?** The candidate
    query runs without a lock; each removal re-reads the participant `FOR UPDATE` under the Lobby
    lock and decides `isRemovable` again. Find an interleaving (a check-in through `stampSeen`, a
    `set_capabilities`, a second pass, a setting change) that removes a Listener that had checked
    in, writes two `listener.removed` for one removal, or deadlocks.
14. **Is the boundary exact everywhere?** Exactly the limit is kept and one millisecond more is
    removed; the candidate query truncates to milliseconds as a JavaScript `Date` does; a Listener
    never seen counts from `joined_at`; condition 3 is the status rule's own (`isOnline`). Find a
    reference value, a declared `pollIntervalMs` or a microsecond timestamp where the SQL and the
    TypeScript disagree.
15. **Are exactly the right offers withdrawn?** Unaccepted offers on requests still running
    (`stillRunning`) go; accepted, completed and removed acceptances, and offers on closed or lapsed
    requests, stay. Find a request whose `last_event_seq` is not its own withdrawal's seq, a reader
    (`get_request`, `accept`, `closeInTx`, the web panel) that still sees a withdrawn offer, or
    accepted work that changes.
16. **Do the two events reach exactly whom they name?** `listener.removed` the removed Listener's
    Lobby inbox and channel session; `request.offer_withdrawn` the requester's. Check `inbox`,
    `shouldWake` in both wake modes and the web session against that.
17. **Does an agent learn of its removal and come back?** `get_started` state 2's two texts, the
    reaction table row and the three skill lines, against what `set_capabilities` and the next pass
    do.
18. **Is the setting held to its bounds on every surface?** Core's one rule
    (`validateRemoveOfflineListenersAfterMs`), the REST body schema (type only), the CLI's `off`
    and number parsing, and `keeper_set_settings`' pass-through: find a value one surface accepts
    that core would refuse, or a `null` lost on the way.
```

- [ ] **Step 12: docs/superpowers/specs/v2-notes.md.**
  - In "### A Listener heartbeat, and removing inactive Listeners (Paw, 2026-09-27)", after its last paragraph (the one that begins `**Built: the heartbeat, the observed cadence and the status**`), add, with an empty line before each paragraph:

```markdown
**Built: removing offline Listeners**, by the offline-removal slice
([spec](2026-09-30-loom-offline-listener-removal-design.md), [plan](../plans/2026-09-30-loom-offline-listener-removal.md)),
which answers the "Still open" line above as Paw did on 2026-09-30: removed, not hidden (the
profile is cleared and the standing offers withdrawn; history stays, and the Listener comes back by
setting its profile again); one limit per instance, `removeOfflineListenersAfterMs`, a day by
default, 1 hour to 30 days or off; not marked "inactive" (offline stays the only status: "I think
it's misleading to have both offline and inactive"); the Listener itself is told (`listener.removed`
in its Lobby inbox, and `get_started`), its owner is not; and `maxResponseMs` is unchanged: a
removable Listener already reads offline, so a request asking `maxResponseMs` passed it over before
its removal, and the removal extends that to every request.

*Idea, not taken:* **telling a keyed agent's owner** when its Listener is removed (an open question
of the idea above).
```

  - Directly after the "### Sort the directory by last seen or status (listener-status slice, 2026-09-27)" entry (before "### Leaving Loom, and archiving a Weave for oneself"), add, with an empty line on each side:

```markdown
### A web control for the offline-removal setting (2026-09-30)

The setting `removeOfflineListenersAfterMs` has no web control yet, like every instance setting (the
web has no settings page); it is changed with `loom admin settings`, `PUT /api/admin/settings` or
`keeper_set_settings`. Placing a control belongs to Paw's design session.
```

  - In "### Leaving Loom, and archiving a Weave for oneself", after its last paragraph (it begins `Not started. Meets the Listener heartbeat idea above`), add, with an empty line before it:

```markdown
The offline removal (2026-09-30) clears a profile and withdraws standing offers for a Listener that
is gone, but `set_capabilities(null)` still withdraws nothing, so a Leave function that should
withdraw offers must do it itself.
```

- [ ] **Step 13: Commit**

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md README.md src/server/README.md src/cli/README.md src/mcp-tools/README.md src/claude-channel/README.md docs/TESTING.md CLAUDE.md docs/HANDBOOK.md docs/KNOWN-ISSUES.md docs/REVIEW-BRIEF.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs: removing offline Listeners; smoke test 11" -m "README, the server, cli, mcp-tools and channel READMEs, ARCHITECTURE, SECURITY, KNOWN-ISSUES, v2-notes and the review brief as spec section 11 and 12 list; TESTING gains smoke test 11 and the coverage lines, and CLAUDE.md and HANDBOOK count eleven smoke tests. The totals follow in Task 8." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

---

### Task 8: the whole branch: the serial run and the totals

**Files:** `docs/TESTING.md` ("Current totals"), `docs/REVIEW-BRIEF.md` (§5's totals sentence); the ledger.

**Interfaces:** consumes the whole branch; produces the measured totals.

- [ ] **Step 1: Build, typecheck and run everything, serially, from a clean build**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every package passes, with no stray output. If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop. Record per package (tests and files) and overall in the ledger, beside Task 0's baseline. The expected movement, for the controller to check against (the run's figures are the record, not these): core +33 tests and +1 file (`lobby-removal.test.ts` 25, `settings-keepers.test.ts` 2, `migration-status.test.ts` 1, `lobby-onboarding.test.ts` 3, `units.test.ts` 1, `status.test.ts` 1; the repaired cases add none), server +2 (`routes.test.ts` 1, `lobby-routes.test.ts` 1; the renamed case adds none), client +1, cli +2, mcp-tools +4 (`onboarding.test.ts` 2, `tools.test.ts` 1, `skills.test.ts` 1), claude-channel +3 (`format.test.ts` 3; the renamed case adds none), web +8 (`requests-state.test.ts` 4, `session.test.ts` 2, `components.test.tsx` 1, `fold.test.ts` 1): **+53 tests, +1 file**. A difference is reported in the ledger with its reason, never smoothed.

- [ ] **Step 2: The checks the branch must pass whole**
  - `git diff --stat origin/main -- src/web/src/styles.css` prints nothing.
  - `git ls-files --eol skills src/core/drizzle` shows every row starting `i/lf    w/lf`.
  - `git diff origin/main | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"` prints `scan clean`.
  - `git diff --stat origin/main` shows no `Bin` row.

- [ ] **Step 3: The totals in TESTING.md.** These are measured values, written in from Step 1's record; nothing is estimated. In "## Current totals":
  - Replace the opening words of the first paragraph, `As of **the agent-skills slice** on`, with `Before it, as of **the agent-skills slice** on`.
  - Directly before that paragraph, after the heading and its empty line, add one paragraph in the house shape, built from the ledger: the slice's name and branch (`the offline-removal slice` on `feat/offline-listener-removal`), the head it was measured at, the total and each package's tests and files in the order core, web, server, claude-channel, cli, client, mcp-tools, the three commands it came from (`pnpm -r build`, `pnpm -r typecheck` (clean), `pnpm --workspace-concurrency=1 -r test`), Task 0's baseline (its sha, total and files), and what the slice added, by package and by file, as Step 1 recorded it (the new `src/core/test/lobby-removal.test.ts` first). The paragraph that begins `As of **the agent-skills slice** on `feat/agent-skills`` in today's file is the model to copy the shape from.
- [ ] **Step 4: The totals in REVIEW-BRIEF.md.** In §5, in these three lines

```text
  Postgres testcontainer or a reachable compose Postgres). Give the totals you saw; on this branch
  they should be **2368 tests in 79 files** (core 727/31, web 960/17, server 242/10,
  claude-channel 146/9, cli 82/5, client 49/4, mcp-tools 162/3), with `pnpm -r typecheck` clean.
```

  keeping the first of those three lines as it is and writing Step 1's figures into the other two, in the same order and the same `tests/files` form per package.

- [ ] **Step 5: Commit**

```bash
git add docs/TESTING.md docs/REVIEW-BRIEF.md
git diff --cached --stat
git diff --cached | node -e "const bad = [String.fromCharCode(0xc2), String.fromCharCode(0xe2, 0x20ac), String.fromCharCode(0x2014)]; let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { const hits = s.split('\n').filter((l) => l.startsWith('+') && bad.some((b) => l.includes(b))); console.log(hits.length ? 'FOUND:\n' + hits.join('\n') : 'scan clean'); });"
git commit -m "docs: offline listener removal, the totals" -m "TESTING's current totals and the review brief carry the serial run measured on the branch, against Task 0's baseline." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `scan clean`.

**After this task (controller, not an implementer):** the whole-branch review (HANDBOOK §3 step 10), its fix wave, then the PR (step 11). **After the merge, on Paw's word for that PR:** `deploy\live-update.cmd` applies 0009 (it stops Loom for a few seconds); the first sweep, within a minute of the boot, removes every live Listener past its effective grace period (spec §15), each told by `listener.removed`; then smoke test 11 with Paw, one step at a time. Then remove the worktree: `git -C D:/git/Loom worktree remove D:/git/worktrees/Loom-offline-listener-removal`, `git -C D:/git/Loom worktree prune`, delete the merged branch, and check `git -C D:/git/Loom worktree list`.

---

## Decisions this plan makes (for the controller to confirm with Paw)

1. **Task order and the core fact's home.** `me.removed` (core `onboardingFacts`) is in Task 4 with the mcp-tools texts, not in Task 2 with the pass. Reason: spec §13.5 says the task that adds the key repairs the mcp-tools fixtures that declare it, and core's `OnboardingFacts` and the mcp-tools copy are one shape.
2. **The client's `EventType` union and the CLI's `read` lines are in Task 3** with the setting's surface, before the channel (5) and the web (6). Reason: the channel and the web `switch` on `@loom/client`'s union; and `SETTING_PARSERS` is a `Record<keyof Settings, ...>`, so the client type and the CLI parser must change in one commit for `pnpm -r typecheck` to stay green.
3. **The CLI number form** is `/^-?\d+$/`, then `Number(v)`; core checks the range. Reason: spec §7 says "the integer `n`"; the regex refuses `1e6`, `0x10`, ` 5` and the empty string, which `Number` would turn into integers.
4. **The channel's `listener.removed` text prints `never` for a null `lastSeenAt`.** Spec §9.3 gives only `(last seen <hh:mm>)`; §9.1 and §9.2 say `never`, and so does the channel's own `request.overdue` line.
5. **KNOWN-ISSUES `actors.ts` row.** Spec §11 speaks of its "consequence column" changing from "reads offline"; the row has no such column or words today (Issue, Why deferred, Suggested fix). The plan appends the consequence to the Issue column, replaces Why deferred with the spec's re-argued text, and keeps the fix.
6. **The channel-and-web KNOWN-ISSUES row** is one row, in the claude-channel section, naming `ws.ts`, the channel and the web session. Reason: the spec describes one row with one fix for both.
7. **README's `--set removeOfflineListenersAfterMs=off` example** goes in the Lobby section with the new sentence. Reason: the only existing `loom admin settings` example sits in the Guidelines section's CLI block, about guidelines.
8. **Spec 2026-09-28 is amended in its §7 texts and with a dated line only**; its §7.1 "Content:" prose paragraph (which lists inbox kinds but is not binding text) is left. Reason: spec §11 names "the §7.1, §7.3 and §7.4 texts".
9. **The skill edits are applied by a script** (Task 4 Step 9) that refuses unless each old text occurs exactly once, to the skill file and the 2026-09-28 spec's copy alike, and a second script proves the spec's four blocks equal the four files. Reason: byte for byte, with no retyping.
10. **The withdrawal deletes with an extra `accepted = false` guard** beside the request ids, so a row accepted between the read and the delete (impossible under the Lobby lock today) could never go.
11. **`removalOf` reads `lastSeenAt` defensively** (a string, else null) from the event payload. Reason: the log is data; a malformed payload must not throw in `get_started`.
12. **The web session fires the directory's re-run on every `listener.removed` it applies**, inside the branch it shares with `participant.capabilities_changed`; the existing seq dedupe at the top of `onEvent` is the only replay guard. Reason: spec §9.1, and a re-run is quiet and fenced.
13. **Test placement and seams.** The REST case and the sweep cases are server tests (§13.2); the CLI `read` case runs a real removal through `s.core.sweepOfflineListeners()` against the CLI's test server after aging only its own bots by SQL; the web session cases do the same. The server's sweep-order case ages its Listener to 23 hours, so the test server's own real-time sweep (a day's limit) can never remove it before the case's `sweepNow` two hours ahead.
14. **The existing server case** "sweepNow runs the expiry pass and the overdue pass with one now and resolves to { closed, overdue }" is renamed and extended to the three passes rather than duplicated; **`units.test.ts`' `NAMED` list** gains the two types (a ripple) and a new case pins their positions.
15. **The ledger lives in the main checkout**, `D:/git/Loom/.superpowers/sdd/2026-09-30-loom-offline-listener-removal/progress.md`. Reason: the worktree is outside the repo now and is removed after the merge; `.superpowers/` is ignored through `.git/info/exclude`, which covers every worktree.
16. **TESTING.md's client row** also gains a sentence, though spec §11 names only the server, cli, mcp-tools, claude-channel and web rows. Reason: §13.3 adds a client case.
17. **ARCHITECTURE's "The eight Lobby types"** becomes "The ten Lobby types", with `listener.removed` in General beside `participant.capabilities_changed`. Reason: the sentence is otherwise false once the two types exist; the spec's §11 list does not name it.
18. **REVIEW-BRIEF** is rewritten beyond spec §11's "the branch paragraph and the slice's row": the current-state sentence, §1a, §2's scope and spec list, §4's rows, §5's lens and totals and §6's questions. Reason: the brief's own pattern, which every earlier branch followed.
19. **Beyond the spec's list**, each in the task named: the case "a never-seen Listener is removed a limit after it joined, not before" also asserts the payload's null `lastSeenAt` (2); the daily-poller case observes the candidate through `beforeLock` (2); the CLI `read` case also renders a never-seen removal (3); the channel's rendering case asserts the withdrawal's `meta.request` (5); the web session's first case asserts the own profile reads null afterwards (6).

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §13.1 `isRemovable`: seen exactly the limit ago is kept; one millisecond more is removable | 2 |
| §13.1 `isRemovable`: never seen counts from joinedAt | 2 |
| §13.1 `isRemovable`: off, a null limit removes nobody | 2 |
| §13.1 `isRemovable`: no profile is never removable | 2 |
| §13.1 `isRemovable`: an online Listener is kept past the limit | 2 |
| §13.1 the boundary | 2 |
| §13.1 a never-seen Listener is removed a limit after it joined, not before | 2 |
| §13.1 off: with the setting null a pass returns 0 and writes nothing; after 3600000 the next pass removes them | 2 |
| §13.1 a participant with no profile is left alone and nothing is written | 2 |
| §13.1 a removal clears the profile and keeps the participant | 2 |
| §13.1 listener.removed: payload, actor, Thread and order | 2 |
| §13.1 open offers are withdrawn | 2 |
| §13.1 accepted work is untouched | 2 |
| §13.1 the inbox | 2 |
| §13.1 a daily poller seen 25 hours ago is a candidate and kept | 2 |
| §13.1 joined_at with microseconds | 2 |
| §13.1 accept naming a withdrawn offer is refused, and getRequest lists it no more | 2 |
| §13.1 a withdrawn offerer is not told when the request later closes | 2 |
| §13.1 no removal event carries a secret or a token | 2 |
| §13.1 concurrent sweeps write one event per removal | 2 |
| §13.1 a check-in racing the pass wins | 2 |
| §13.1 the directory, the counts and find_agents drop a removed Listener | 2 |
| §13.1 a request opened after the removal does not address it | 2 |
| §13.1 a returning Listener rejoins by setting its profile | 2 |
| §13.1 set_capabilities(null) by the Listener itself writes only participant.capabilities_changed | 2 |
| §13.1 `settings-keepers.test.ts`: `getSettings` on a fresh database has the key (the exact-shape case) | 1 |
| §13.1 `settings-keepers.test.ts`: `updateSettings` accepts 3600000, 2592000000 and null | 1 |
| §13.1 `settings-keepers.test.ts`: `updateSettings` refuses six values with the exact message | 1 |
| §13.1 `migration-status.test.ts`: migration 0009 gives an existing settings row the 1 day default | 1 |
| §13.1 `migration-status.test.ts`: the existing "assertTransactionSafe accepts every real migration file" covers 0009 | 1 |
| §13.1 `lobby-onboarding.test.ts`: me.removed is null with a profile, never had one, cleared its own | 4 |
| §13.1 `lobby-onboarding.test.ts`: after a removal me.removed carries at and lastSeenAt, null when never seen | 4 |
| §13.1 `lobby-onboarding.test.ts`: me.removed is null again after set_capabilities, with a profile and with null | 4 |
| §13.1 `lobby-onboarding.test.ts`: the existing "facts with a participant and no profile have hasProfile false" gains `removed: null` | 4 |
| §13.1 `units.test.ts`: `EVENT_TYPES` holds the two new types at the positions of §5.4 | 2 |
| §13.1 `status.test.ts`: `isOnline` agrees with `listenerStatus` across the boundary fixture | 2 |
| §13.2 `routes.test.ts`: GET carries the key; PUT 3600000 and null; 1000 is 400 with the message; "1h" is 400; a non-keeper refused | 3 |
| §13.2 the sweep: `sweepNow(now)` answers `{ closed, overdue, removed }` | 3 |
| §13.2 the sweep: `request.overdue` before `listener.removed` in one `sweepNow` | 3 |
| §13.3 `getSettings` and `updateSettings` round-trip the key, a number and null | 3 |
| §13.4 `admin settings --set removeOfflineListenersAfterMs=off`, `=3600000`, `=1h` | 3 |
| §13.4 `loom read` prints the two lines of §9.2 | 3 |
| §13.5 `onboarding.test.ts`: state 2 for a removed agent, both exact texts, then the unchanged body | 4 |
| §13.5 `onboarding.test.ts`: state 2 with `me.removed` null is unchanged (the existing exact case, its fixture repaired) | 4 |
| §13.5 `onboarding.test.ts`: `REACTION_TABLE` row after `thread.removed`, in state 3 and `renderDocument` | 4 |
| §13.5 `onboarding.test.ts`: `renderDocument` still passes `parseSkill` (the existing case) | 4 |
| §13.5 `onboarding.test.ts`: the no-em-dash case covers the new texts (the corpus gains both fixtures) | 4 |
| §13.5 the fixtures `SET_UP`, `joined` and `profiled` gain `removed: null` | 4 |
| §13.5 `skills.test.ts`: the guard passes over the edited files; the texts contain the four edits | 4 |
| §13.5 `tools.test.ts`: `keeper_set_settings`' description names the key; a null patch reaches the backend unchanged | 4 |
| §13.6 `shouldWake`: listener.removed wakes the participant it names in both modes, not another | 5 |
| §13.6 `shouldWake`: request.offer_withdrawn wakes the `to` participant in both modes, another in neither | 5 |
| §13.6 the two notification texts of §9.3 | 5 |
| §13.6 the instructions case renamed, with the new `type=` substring | 5 |
| §13.7 `requests-state`: removes the unaccepted offer and steps the version; an older replay changes nothing; not a work event | 6 |
| §13.7 the session: refresh, own-profile re-read only when it names this session, onWorkChanged; closed directory re-runs nothing | 6 |
| §13.7 `MessageList`: the two lines, `never` for a null `lastSeenAt` | 6 |
| §13.7 `runSummary` counts both kinds in their words | 6 |
| §14 smoke test 11, written into TESTING.md (run by Paw after the deploy) | 7 |

Cases this plan adds beyond the spec's list are under decision 19. Known ripples repaired, each named in its commit: `settings-keepers.test.ts` "returns defaults on first read" (1); `units.test.ts` "EVENT_TYPES holds every type the EventType union named, each once, and EventType accepts exactly those" (2); `lobby-routes.test.ts` "sweepNow runs the expiry pass and the overdue pass with one now and resolves to { closed, overdue }" (3); `lobby-onboarding.test.ts` "facts with a participant and no profile have hasProfile false", the mcp-tools fixtures `joined`, `profiled` and `SET_UP`, and the `TABLE` constant (4); `channel.test.ts` "the instructions list the three new types" (5).
