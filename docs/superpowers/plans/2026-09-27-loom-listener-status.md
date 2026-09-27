# Loom: a Listener heartbeat and listener status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every check-in (a throttled liveness stamp) is also kept in a per-participant history of the last 20; each Lobby listener carries a status (working, idle or offline), its current work and its measured cadence, computed at read time, on the Listeners directory (with status tabs, counts and a server-side filter), `find_agents`, a request's acceptances, the sidebar's three stat tiles, the profile card and the requests panel.

**Architecture:** Core gains one nullable column (`participants.seen_history`, migration 0007) written by the existing `stampSeen` statement, and one module, `src/core/src/lobby/status.ts`, holding the status rule twice (TypeScript `listenerStatus` for rows, SQL `statusSql` for the filter and the counts, asserted to agree), the work lookup (`workFor`, `currentWorkOf`), the cadence (`cadenceOf`) and `listenerFacts`, which `listListeners` and `findAgents` both use. `hydrate` in `requests.ts` adds `listenerStatus` to every acceptance. REST gains no route, the client and MCP only fields and descriptions. The web adds the tabs, two columns and the rate text to the directory, the tiles to the sidebar line, the status word to the profile card and the acceptance line, and a visibility-driven re-read; behaviour, data and class hooks only.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Vitest 4 against a real Postgres 17 (`fileParallelism: false`), drizzle-orm 0.45.2 with drizzle-kit 0.31.10 on postgres-js 3.4.9, zod 4, Hono, Preact with happy-dom for the DOM tests. **No `package.json` gains a dependency anywhere in this plan.**

**Spec:** `docs/superpowers/specs/2026-09-27-loom-listener-status-design.md`, approved by Paw on 2026-09-27 after a clean ChatGPT review round (PR #43). Read it whole before any task; it is the binding requirement text. Where this plan decides something the spec leaves open, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `.superpowers/sdd/2026-09-27-loom-listener-status/progress.md`.

**Base:** branch `feat/listener-status` off `origin/main` **after the docs PR carrying the spec and this plan (PR #43) merges**, in the worktree `.claude/worktrees/listener-status`. From `main` this plan consumes, unchanged unless a task says otherwise: `stampSeen`, `SEEN_THROTTLE_MS`, `resolveCredential`, `resolveInWeave`, `toPublicParticipant` (`src/core/src/actors.ts`); `isLive`, `Profile` (`src/core/src/lobby/matching.ts`); `validateListenersQuery`, `QUERY_KEYS`, `CleanQuery`, `Listener`, `ListenersQuery`, `ListenersPage` (`src/core/src/lobby/listeners-input.ts`); `filterSql`, `whereFor`, `facetBase`, `listListeners` (`src/core/src/lobby/listeners.ts`); `findAgents`, `FoundAgent` (`src/core/src/lobby/profile.ts`); `hydrate`, `toAcceptance`, `PublicAcceptance`, `openRequest`, `offer`, `accept`, `getRequest` (`src/core/src/lobby/requests.ts`); `freshDb`, `closeTestDb`, `keeperToken` (`src/core/test/helpers.ts`); `startTestServer`, `api` (`src/server/test/helpers.ts`) and in `src/server/test/lobby-routes.test.ts` `directory`, `scenario`, `acceptedRequest`, `listenersUrl`, `listenerIds`, `sqlUnsafe`, `REQUIREMENTS`; in `src/client/test/client.test.ts` the `lobby()` fixture; in `src/mcp-tools/test/tools.test.ts` `fake`, `client`, `text`, `described`; in `src/web/src/session.ts` `readListenerCount`, `offVisibility`, `onLobby`, `generation`; `agoText`, `seenText` (`src/web/src/components/ProfileCard.tsx`); `viewFromSearch`, `searchFromView`, `queryFromView`, `EMPTY_VIEW` (`src/web/src/components/listeners/listeners-query.ts`); in `src/web/test/listeners-page.test.tsx` `mountLobby`, `settle`, `joined`, `listener`, `directory`, `json`, `weaveBody`, `GENERAL`, `LISTENERS`, `WEAVE`; in `src/web/test/session.test.ts` `lobbyFixture`, `makeSession`, `sideReadClient`, `onCall`, `UNREACHABLE`, `LISTENERS`, `fakeVisibility`, `waitFor`, `anon`, `fixtureN`; in `src/web/test/components.test.tsx` the `state()`, `session()`, `lobbyState()`, `request()`, `anOffer()`, `helper`, `NOW` fixtures.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/listener-status`, worktree `.claude/worktrees/listener-status`, one commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 7 is done and the whole-branch review (HANDBOOK §3 step 10) has run. The controller dispatches every implementer and reviewer **in the background** (`run_in_background: true`, `model: "opus"`).
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that sentence. A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Layering:** every rule (the status rule, the default interval, what counts as active work, the current-work order, the cadence, the filter's validation and the counts) lives in `@loom/core` and is tested once there. The REST route passes the `filter` JSON through as it already does; the client and MCP carry types and words only. The web owns only presentation: `rateText` and `durationText`, the tabs and the tiles.
- **Error codes:** the fixed set only. **No new code.** The one new `validation` message is verbatim: `status must be a list of working, idle or offline`.
- **Values:** `DEFAULT_POLL_INTERVAL_MS = 900_000`; 20 check-ins kept; the throttle stays `SEEN_THROTTLE_MS = 10_000` (exactly 10 000 ms still skips); offline when `now - last_seen_at > 2 x interval` (exactly twice is online). The MCP `find_agents` sentence is verbatim from spec §5. The web class hooks are exactly: `status-tab`, `status-tab-all`, `status-tab-working`, `status-tab-idle`, `status-tab-offline`, `status-tab-count`, `listener-status`, `listener-status-<word>`, `current-work` (with `link`), `current-work-more` (`aria-label` "N more", text `+N`), `listener-rate`, `listener-tiles`, `listener-tile`, `listener-tile-<word>`, `acceptance-seen`; plus three this plan adds for the design session to hold on to: `status-tabs` (the tabs' wrapper), `listener-tile-count` and `listener-tile-word` (a tile's two parts).
- **Migration 0007** is generated by `drizzle-kit generate` (`pnpm --filter @loom/core db:generate`), contains only `ALTER TABLE "participants" ADD COLUMN "seen_history" timestamp with time zone[];`, has its journal entry (idx 7, `when` greater than 1790451744064) and `meta/0007_snapshot.json`, and passes `assertTransactionSafe` (the existing "case 9" in `src/core/test/migration-status.test.ts` runs it over every real migration file). Nothing is backfilled.
- **LF:** every `*.sql` and everything under `src/core/drizzle/` is LF in the working tree (`.gitattributes`); check with `git ls-files --eol` before committing Task 1.
- **One clock per read.** Every read that computes statuses reads `now` once (`new Date()` unless a test passes one) and uses it for every row, every count and the filter. SQL never reads Postgres's `now()` for a status; `now` is a bind parameter.
- **`seen_history` is never returned.** `toPublicParticipant` does not read it; only `cadenceOf`'s summary leaves core.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test, pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker. **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test:** `pnpm --filter @loom/core build` before the server, client or web suites read a core change; `pnpm --filter @loom/client build` before the web suite reads a client change; `pnpm -r build` whenever a task touches more than one package.
- **Never write a `\uXXXX` escape into a file**: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row.
- **Visual design is Paw's separate design session.** The web tasks add behaviour, data and class hooks only; **no CSS**, no `styles.css` edit. Reusing an existing class on a new element (`link` on the Current work button) is allowed; writing a rule is not.
- **The known ripples.** New required fields reach exact assertions elsewhere. Each is repaired **only by adding the new field(s) with the value the new rule gives**, never by loosening an assertion, and each repaired test is named in the commit body. The ones known at plan time are listed in the task that causes them (Task 3: `lobby-requests.test.ts` "getRequest returns acceptances with dueAt ..."; Task 4: the web and components fixtures; Task 5: the two "a row of the table" tests; Task 6: the acceptance-line test and the `Session` fixture). A red case of any other shape is a finding and stops the task.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/db/schema.ts` (modify) | `participants.seenHistory` (`seen_history timestamptz[]`) |
| `src/core/drizzle/0007_<generated>.sql`, `src/core/drizzle/meta/0007_snapshot.json`, `src/core/drizzle/meta/_journal.json` (generated) | migration 0007 |
| `src/core/src/actors.ts` (modify) | `stampSeen` appends to the history in the same statement |
| `src/core/src/lobby/status.ts` (new) | `Cadence`, `cadenceOf` (Task 1); `ListenerStatus`, `DEFAULT_POLL_INTERVAL_MS`, `StatusCounts`, `CurrentWork`, `WorkItem`, `ListenerFacts`, `listenerStatus`, `statusSql`, `workFor`, `currentWorkOf`, `listenerFacts` (Task 2) |
| `src/core/src/lobby/listeners-input.ts` (modify) | `Listener` gains the three fields; `ListenersQuery.status`, `ListenersPage.statusCounts`, `CleanQuery.status`; the validation |
| `src/core/src/lobby/listeners.ts` (modify) | the `Scope` (query plus `now`), the status filter, `readStatusCounts`, the row facts |
| `src/core/src/lobby/profile.ts` (modify) | `FoundAgent` gains the three fields; `findAgents(…, now)` |
| `src/core/src/lobby/requests.ts` (modify) | `PublicAcceptance.listenerStatus`; `hydrate` and `toAcceptance` |
| `src/core/src/index.ts` (modify) | type exports `ListenerStatus`, `CurrentWork`, `Cadence`, `StatusCounts` |
| `src/core/test/status.test.ts` (new) | spec §9.1 `status.test.ts` |
| `src/core/test/liveness.test.ts` (modify) | spec §9.1, the five new liveness cases |
| `src/core/test/lobby-requests.test.ts` (modify) | the Task 3 ripple |
| `src/server/test/lobby-routes.test.ts` (modify) | spec §9.2 |
| `src/client/src/types.ts`, `src/client/src/client.ts` (modify) | the types; `listListeners` sends `status` inside `filter` |
| `src/client/test/client.test.ts` (modify) | spec §9.3 |
| `src/mcp-tools/src/tools.ts`, `src/mcp-tools/src/backend.ts` (modify) | the two descriptions; a comment |
| `src/mcp-tools/test/tools.test.ts` (modify) | spec §9.4 |
| `src/web/src/requests-state.ts` (modify) | an acceptance made from an event carries `listenerStatus` (Task 4) |
| `src/web/src/components/listeners/listener-status.ts` (new) | `durationText`, `rateText` |
| `src/web/src/components/listeners/listeners-query.ts` (modify) | `ListenersView.status`, the URL codec, the query |
| `src/web/src/components/listeners/ListenersPage.tsx` (modify) | the tabs, the two columns, the rate text, `onOpenThread` (Task 5); the card's status and the re-run on visible (Task 6) |
| `src/web/src/components/WeaveView.tsx` (modify) | supplies `onOpenThread` |
| `src/web/src/session.ts` (modify) | `listenerStatusCounts`, `onVisible`, the count read on visible |
| `src/web/src/components/ListenersLink.tsx`, `ProfileCard.tsx`, `RequestsPanel.tsx` (modify) | the tiles; the status word; the acceptance's seen and status |
| `src/web/test/listener-status.test.ts` (new) | the pure rate functions |
| `src/web/test/listeners-page.test.tsx`, `session.test.ts`, `components.test.tsx`, `requests-state.test.ts` (modify) | spec §9.5 and the ripples |
| `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`, `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §7 |

**Why eight tasks (0 to 7), and how they differ from the suggested split.** The suggested seven are kept, with two moves. `findAgents` goes to Task 2, not Task 4: it takes its three fields from the same `listenerFacts` and `workFor` the directory rows use, and a reviewer judging "the rule and its two readers" wants both readers in one diff. Task 4 also carries the web type ripple (the fixtures that construct `Listener`, `ListenersPage` and `Acceptance`, and `requests-state.ts`'s `accepting`), because the moment the client types gain required fields `pnpm -r typecheck` fails in `@loom/web`, and no task may end with a red typecheck. The web keeps its two slices: the directory itself (5), then everything outside the table plus freshness (6).

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git fetch origin && git log origin/main --oneline -5` shows the squash commit of PR #43, and `git show origin/main:docs/superpowers/plans/2026-09-27-loom-listener-status.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Confirm the code this plan was written against is still there: `node -e "console.log(require('./src/core/drizzle/meta/_journal.json').entries.at(-1).tag)"` prints `0006_big_ricochet`; `grep -c "export async function stampSeen" src/core/src/actors.ts` prints `1`; `grep -c "const readListenerCount = (myGeneration: number) =>" src/web/src/session.ts` prints `1`. If any differs, stop and report: someone has added a migration or reshaped the code since the spec was written.
- [ ] Create the worktree and the branch:

```bash
cd D:/git/Loom
git worktree add .claude/worktrees/listener-status -b feat/listener-status origin/main
cd .claude/worktrees/listener-status
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. TESTING.md "Current totals" records **2169 tests in 76 files** at `1f38798`. Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `.superpowers/sdd/2026-09-27-loom-listener-status/progress.md`. Task 7 compares against that record and must not estimate. If the figures differ from TESTING.md's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---

### Task 1: core: migration 0007, the check-in history, and `cadenceOf`

Spec §3, §4.1, §4.4. **This task carries the five new `liveness.test.ts` cases of spec §9.1, the three `cadenceOf` cases, and the migration case.**

**Files:**
- Modify: `src/core/src/db/schema.ts` (the `participants` table, after `lastSeenAt`)
- Generate: `src/core/drizzle/0007_<drizzle-kit's name>.sql`, `src/core/drizzle/meta/0007_snapshot.json`, `src/core/drizzle/meta/_journal.json`
- Modify: `src/core/src/actors.ts` (`stampSeen`)
- Create: `src/core/src/lobby/status.ts`
- Create: `src/core/test/status.test.ts`
- Modify: `src/core/test/liveness.test.ts` (imports; one helper; a new `describe` at the end)

**Interfaces:**
- Consumes: `stampSeen(db, which, now)`, `SEEN_THROTTLE_MS`, `resolveCredential(db, credential, now?)`, `createCore(db).readEvents(actor, weaveId, opts)`, `getWeave(db, actor, weaveId)`.
- Produces:

```ts
// src/core/src/db/schema.ts
participants.seenHistory; // column "seen_history" timestamptz[], nullable; $inferSelect: Date[] | null

// src/core/src/lobby/status.ts
export type Cadence = { typicalGapMs: number | null; longestGapMs: number | null; samples: number };
export function cadenceOf(history: Date[] | null): Cadence;
```

- [ ] **Step 1: Write the failing liveness cases.** In `src/core/test/liveness.test.ts`, after the last `import` line add:

```ts
import { createCore } from "../src/index.js";
```

(`ensureLobby`, `joinLobby`, `joinWeave`, `getWeave`, `addAgent` and `setCapabilities` are already imported there.) After the `seenOf` helper add:

```ts
const historyOf = async (participantId: string): Promise<Date[] | null> =>
  (await db.select({ h: participants.seenHistory }).from(participants).where(eq(participants.id, participantId)))[0]!.h;
```

Append at the end of the file:

```ts
describe("the check-in history (spec 2026-09-27 §4.1)", () => {
  it("a check-in appends to seen_history in the same write as last_seen_at, and a throttled stamp appends nothing", async () => {
    const r = await newWeave();
    expect(await historyOf(r.participant.id)).toBeNull();
    await resolveCredential(db, r.token, T0);
    expect([await seenOf(r.participant.id), await historyOf(r.participant.id)]).toEqual([T0, [T0]]);
    await resolveCredential(db, r.token, at(9_999));
    await resolveCredential(db, r.token, at(10_000));
    expect(await historyOf(r.participant.id)).toEqual([T0]);
    await resolveCredential(db, r.token, at(10_001));
    const history = await historyOf(r.participant.id);
    expect([history, history!.at(-1)]).toEqual([[T0, at(10_001)], await seenOf(r.participant.id)]);
  });

  it("seen_history keeps the last 20, oldest first", async () => {
    const r = await newWeave();
    for (let i = 0; i < 25; i++) await resolveCredential(db, r.token, at(i * 10_001));
    expect(await historyOf(r.participant.id)).toEqual(Array.from({ length: 20 }, (_, k) => at((k + 5) * 10_001)));
    expect(await seenOf(r.participant.id)).toEqual(at(24 * 10_001));
  });

  it("an agent-key call in another Weave checks in the agent's Lobby participant", async () => {
    await ensureLobby(db);
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    // Resolved before either join, so nothing is stamped until the call under test.
    const agent = await resolveCredential(db, key);
    const inLobby = await joinLobby(db, bus, { kind: "agent" }, agent);
    const elsewhere = await newWeave();
    await joinWeave(db, bus, elsewhere.secret, { kind: "agent" }, agent);
    const calling = await resolveCredential(db, key, T0);
    await createCore(db).readEvents(calling, elsewhere.weave.id, {});
    expect([await seenOf(inLobby.participant.id), await historyOf(inLobby.participant.id)]).toEqual([T0, [T0]]);
  });

  it("a participant token of another Weave does not check in the Lobby participant", async () => {
    await ensureLobby(db);
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    const agent = await resolveCredential(db, key);
    const inLobby = await joinLobby(db, bus, { kind: "agent" }, agent);
    const elsewhere = await newWeave();
    // Joined with the key, so this participant row carries the agent's agent_id (spec §4.1's choice).
    const inWeave = await joinWeave(db, bus, elsewhere.secret, { kind: "agent" }, agent);
    await resolveCredential(db, inWeave.token, T0);
    expect([await seenOf(inLobby.participant.id), await historyOf(inLobby.participant.id)]).toEqual([null, null]);
    expect(await historyOf(inWeave.participant.id)).toEqual([T0]);
  });

  it("PublicParticipant carries no seen history", async () => {
    const { weaveId: lobbyId } = await ensureLobby(db);
    const j = await joinLobby(db, bus, { name: "Listener", kind: "agent" });
    const actor = await resolveCredential(db, j.token, T0);
    await setCapabilities(db, bus, actor, { owner: "paw" });
    const mine = (await getWeave(db, actor, lobbyId)).participants.find((p) => p.id === j.participant.id)!;
    expect(Object.keys(mine).sort()).toEqual(["agentId", "capabilities", "id", "joinedAt", "kind", "lastSeenAt", "name", "role", "weaveId"]);
  });
});
```

- [ ] **Step 2: Write the failing `cadenceOf` cases.** Create `src/core/test/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cadenceOf } from "../src/lobby/status.js";

describe("cadenceOf (spec 2026-09-27 §4.4)", () => {
  const T = Date.parse("2026-09-27T10:00:00.000Z");
  /** Check-ins at T and then after each gap in turn, oldest first, as `seen_history` stores them. */
  const history = (gaps: number[]): Date[] =>
    gaps.reduce<Date[]>((out, g) => [...out, new Date(out.at(-1)!.getTime() + g)], [new Date(T)]);

  it("fewer than two check-ins gives null gaps", () => {
    expect([cadenceOf(null), cadenceOf([]), cadenceOf([new Date(T)])]).toEqual([
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 0 },
      { typicalGapMs: null, longestGapMs: null, samples: 1 },
    ]);
  });

  it("twenty check-ins give nineteen gaps", () => {
    // 11 000 to 29 000 ms in steps of 1 000, shuffled (7 is coprime with 19): the median must be sorted for.
    const gaps = Array.from({ length: 19 }, (_, i) => 11_000 + ((i * 7) % 19) * 1_000);
    expect(cadenceOf(history(gaps))).toEqual({ typicalGapMs: 20_000, longestGapMs: 29_000, samples: 20 });
  });

  it("an even number of gaps takes the floor of the mean of the two middle ones", () => {
    // Sorted 11 000, 20 001, 20 004, 40 000: the mean of the middle two is 20 002.5.
    expect(cadenceOf(history([40_000, 20_001, 11_000, 20_004]))).toEqual({ typicalGapMs: 20_002, longestGapMs: 40_000, samples: 5 });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/status.test.ts test/liveness.test.ts`
Expected: FAIL. `status.test.ts` fails to resolve `../src/lobby/status.js`; the five new liveness cases fail (`participants.seenHistory` is undefined, so the select errors); the existing eight liveness cases still pass.

- [ ] **Step 4: The column.** In `src/core/src/db/schema.ts`, inside `participants`, directly after the `lastSeenAt` line, add:

```ts
  // The last 20 check-ins, oldest first (spec 2026-09-27 §3): appended by `stampSeen` in the same
  // statement that writes `last_seen_at`, so its last element always equals it. Never returned as
  // such: only `cadenceOf`'s summary leaves core. Null until the first check-in after migration 0007.
  seenHistory: timestamp("seen_history", { withTimezone: true }).array(),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @loom/core db:generate`
Expected: drizzle-kit prints one new migration, `drizzle/0007_<name>.sql`. Then prove its content, the journal entry and the line endings, from the worktree root:

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
const dir = "src/core/drizzle";
const file = fs.readdirSync(dir).find((n) => n.startsWith("0007_") && n.endsWith(".sql"));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const got = fs.readFileSync(`${dir}/${file}`, "utf8").split("--> statement-breakpoint").map(norm).filter(Boolean);
const want = ['ALTER TABLE "participants" ADD COLUMN "seen_history" timestamp with time zone[];'];
const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8")).entries.at(-1);
console.log(JSON.stringify(got) === JSON.stringify(want) ? `0007 statements ok: ${file}` : `0007 MISMATCH:\n${got.join("\n")}`);
console.log(journal.idx === 7 && journal.when > 1790451744064 && `${journal.tag}.sql` === file ? "journal ok" : `journal MISMATCH: ${JSON.stringify(journal)}`);
console.log(fs.existsSync(`${dir}/meta/0007_snapshot.json`) ? "snapshot ok" : "snapshot MISSING");
CHECK
git add src/core/drizzle && git ls-files --eol src/core/drizzle/0007_*.sql src/core/drizzle/meta/0007_snapshot.json src/core/drizzle/meta/_journal.json
```

Expected: `0007 statements ok: 0007_<name>.sql`, `journal ok`, `snapshot ok`, and three `git ls-files --eol` rows each starting `i/lf    w/lf`. A `MISMATCH` means the schema edit is not exactly Step 4. To regenerate: delete the `.sql` and `meta/0007_snapshot.json`, restore the journal with `git restore --source=HEAD --staged --worktree -- src/core/drizzle/meta/_journal.json`, fix the schema and generate again. A `w/crlf` row means the working copy was written with CRLF: `rm` that file and `git checkout -- <file>` to renormalise it.

- [ ] **Step 6: The stamp.** In `src/core/src/actors.ts`, replace the `stampSeen` doc comment and function with:

```ts
/**
 * Liveness (spec §6.6), and the check-in history (spec 2026-09-27 §4.1): sets `last_seen_at = now`
 * on the participants `which` selects, unless one was written ten seconds or less before `now`
 * (exactly ten seconds still skips), and in the **same statement** appends `now` to `seen_history`,
 * cut to its last 20 entries, oldest first. The `WHERE` is the throttle alone, so a skipped stamp
 * appends nothing and the history's last element always equals `last_seen_at`. It is not an event
 * and takes no Weave lock, so a poll neither grows the log nor wakes anyone. A stamp that fails fails
 * the call, which was about to use the same database anyway.
 */
export async function stampSeen(db: Db, which: SQL, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SEEN_THROTTLE_MS);
  const at = sql`${now.toISOString()}::timestamptz`;
  await db.update(participants).set({
    lastSeenAt: now,
    // The previous history plus `now`: n + 1 entries, of which the last 20 start at index n - 18
    // (Postgres arrays are 1-based, and an open upper bound runs to the end).
    seenHistory: sql`(array_append(coalesce(${participants.seenHistory}, '{}'), ${at}))[greatest(coalesce(cardinality(${participants.seenHistory}), 0) - 18, 1):]`,
  }).where(and(which, or(isNull(participants.lastSeenAt), lt(participants.lastSeenAt, cutoff))));
}
```

(`sql` and `SQL` are already imported in `actors.ts`.)

- [ ] **Step 7: The cadence.** Create `src/core/src/lobby/status.ts`:

```ts
/*
 * Listener status, current work and cadence (spec 2026-09-27 §4), computed at read time from
 * `last_seen_at`, `seen_history` and the acceptances: never stored and never an event.
 */

export type Cadence = {
  /** The median gap between consecutive stored check-ins, in ms; null with fewer than two. */
  typicalGapMs: number | null;
  /** The longest of those gaps, in ms; null with fewer than two. */
  longestGapMs: number | null;
  /** How many check-ins are stored: 0 to 20. */
  samples: number;
};

/**
 * §4.4. The gaps are only those **between** stored check-ins, in stored order: the time since the
 * last one is not a gap. The median of an even count is the mean of the two middle gaps, rounded
 * down to a whole millisecond. `samples` counts check-ins, not gaps.
 */
export function cadenceOf(history: Date[] | null): Cadence {
  const h = history ?? [];
  if (h.length < 2) return { typicalGapMs: null, longestGapMs: null, samples: h.length };
  const gaps = h.slice(1).map((d, i) => d.getTime() - h[i]!.getTime()).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const typicalGapMs = gaps.length % 2 === 1 ? gaps[mid]! : Math.floor((gaps[mid - 1]! + gaps[mid]!) / 2);
  return { typicalGapMs, longestGapMs: gaps.at(-1)!, samples: h.length };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/status.test.ts test/liveness.test.ts test/migration-status.test.ts`
Expected: PASS, all three files; `migration-status.test.ts` "case 9: assertTransactionSafe accepts every real migration file" now covers eight files.

- [ ] **Step 9: Build and typecheck the workspace, then run core**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. A core test that compared a whole raw `db.select().from(participants)` row with `toEqual` now also sees `seenHistory`: repair it per the known-ripples rule (add `seenHistory` with the value the stamp gave) and name it in the commit body. None is known at plan time.

- [ ] **Step 10: Commit**

```bash
git add src/core/src/db/schema.ts src/core/drizzle src/core/src/actors.ts src/core/src/lobby/status.ts src/core/test/status.test.ts src/core/test/liveness.test.ts
git diff --cached --stat
git commit -m "feat(core): migration 0007 and the check-in history, with cadenceOf" -m "Migration 0007 adds participants.seen_history. stampSeen appends each check-in in the statement that writes last_seen_at, keeping the last 20; cadenceOf summarises them. Nothing reads it yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row.

---

### Task 2: core: status, current work, the status filter and the counts, on `listListeners` and `findAgents`

Spec §4.2, §4.3, §4.5 (`Listener`, `FoundAgent`, `ListenersQuery`, `ListenersPage`), §4.6, §4.7, §4.8, §8, §10. **This task carries spec §9.1 `status.test.ts`: the five `listenerStatus` cases and every "Against Postgres" case except `getRequest acceptances carry listenerStatus` (Task 3).**

**Files:**
- Modify: `src/core/src/lobby/status.ts` (replace the whole file)
- Modify: `src/core/src/lobby/listeners-input.ts`
- Modify: `src/core/src/lobby/listeners.ts`
- Modify: `src/core/src/lobby/profile.ts` (`FoundAgent`, `findAgents`)
- Modify: `src/core/src/index.ts` (one export line)
- Modify: `src/core/test/status.test.ts` (replace the import block; append)

**Interfaces:**
- Consumes: `cadenceOf`, `Cadence` (Task 1); `isLive(profile, seen)`; `participants`, `requestOffers`, `requests`, `threads` (schema); `openRequest`, `offer`, `accept` for the fixtures.
- Produces:

```ts
// src/core/src/lobby/status.ts
export type ListenerStatus = "working" | "idle" | "offline";
export const DEFAULT_POLL_INTERVAL_MS = 900_000;
export type StatusCounts = { working: number; idle: number; offline: number };
export type CurrentWork = { requestId: string; title: string; threadId: string; more: number };
export type WorkItem = { requestId: string; threadId: string; title: string; dueAt: Date | null; createdAt: Date };
export type ListenerFacts = { status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence };
export function listenerStatus(profile: Profile | null, lastSeenAt: Date | null, holdsWork: boolean, now: Date): ListenerStatus;
export function statusSql(now: Date): SQL;                       // a CASE over one participants row
export function workFor(db: Queryable, participantIds: string[]): Promise<Map<string, WorkItem[]>>; // ordered; only ids with items
export function currentWorkOf(items: WorkItem[] | undefined): CurrentWork | null;
export function listenerFacts(row: { capabilities: unknown; lastSeenAt: Date | null; seenHistory: Date[] | null }, items: WorkItem[] | undefined, now: Date): ListenerFacts;

// src/core/src/lobby/listeners-input.ts
export type Listener = { participant: PublicParticipant; capabilities: Profile; status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence };
// ListenersQuery gains  status?: ListenerStatus[];   ListenersPage gains  statusCounts: StatusCounts;

// src/core/src/lobby/listeners.ts
export function listListeners(db: Db, actor: Actor, query?: ListenersQuery, now?: Date): Promise<ListenersPage>;

// src/core/src/lobby/profile.ts
export type FoundAgent = { participant: PublicParticipant; capabilities: Profile; status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence };
export function findAgents(db: Db, actor: Actor, filter: AgentFilter, now?: Date): Promise<FoundAgent[]>;

// src/core/src/index.ts
export { type ListenerStatus, type CurrentWork, type Cadence, type StatusCounts } from "./lobby/status.js";
```

- [ ] **Step 1: Write the failing tests.** In `src/core/test/status.test.ts`, replace the import block (the two `import` lines) with:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants, requestOffers, requests as requestsTable } from "../src/db/schema.js";
import { resolveCredential } from "../src/actors.js";
import { createWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities, findAgents } from "../src/lobby/profile.js";
import { accept, offer, openRequest } from "../src/lobby/requests.js";
import { listListeners } from "../src/lobby/listeners.js";
import { cadenceOf, listenerStatus, DEFAULT_POLL_INTERVAL_MS, type ListenerStatus } from "../src/lobby/status.js";
import type { Listener, ListenersPage, ListenersQuery } from "../src/lobby/listeners-input.js";
import type { Profile } from "../src/lobby/matching.js";
import type { Db } from "../src/db/index.js";
```

Append to the end of the file:

```ts
afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

/** The one clock every status read in this file uses; every listener's last check-in is set against it. */
const NOW = new Date("2026-09-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** A profile, cast because the cases include a value `validateProfile` would refuse (a non-numeric `pollIntervalMs`). */
const P = (over: Record<string, unknown> = {}): Profile => ({ owner: "paw", ...over }) as Profile;

describe("listenerStatus (spec 2026-09-27 §4.2)", () => {
  it("never seen is offline", () => {
    expect([listenerStatus(null, null, false, NOW), listenerStatus(P({ pollIntervalMs: 300_000 }), null, true, NOW)])
      .toEqual(["offline", "offline"]);
  });

  it("exactly twice the declared interval is online; one millisecond more is offline", () => {
    const p = P({ pollIntervalMs: 300_000 });
    expect([listenerStatus(p, ago(600_000), false, NOW), listenerStatus(p, ago(600_001), false, NOW)]).toEqual(["idle", "offline"]);
  });

  it("the 15 minute default: seen 30 min ago is online, 30 min and 1 ms ago is offline", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(900_000);
    for (const p of [null, P(), P({ pollIntervalMs: "5 min" })]) {
      expect({ p, got: [listenerStatus(p, ago(1_800_000), false, NOW), listenerStatus(p, ago(1_800_001), false, NOW)] })
        .toEqual({ p, got: ["idle", "offline"] });
    }
  });

  it("offline wins over working", () => {
    expect(listenerStatus(P({ pollIntervalMs: 300_000 }), ago(600_001), true, NOW)).toBe("offline");
  });

  it("online with work is working; online without is idle", () => {
    const p = P({ pollIntervalMs: 300_000 });
    expect([listenerStatus(p, ago(60_000), true, NOW), listenerStatus(p, ago(60_000), false, NOW)]).toEqual(["working", "idle"]);
  });
});

/**
 * The Lobby's reader (its own secret), a requester **with no profile** (so it is no listener, and
 * the listeners each test makes are the whole population), and a target Weave with a Thread.
 */
async function world() {
  const lobby = await ensureLobby(db);
  const reader = await resolveCredential(db, lobby.secret);
  const target = await createWeave(db, bus, { title: "Session", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const keeper = await resolveCredential(db, target.token);
  const thread = await createThread(db, bus, keeper, target.weave.id, "PR 14");
  const asker = await joinLobby(db, bus, { name: "Asker", kind: "human" });
  const requester = await resolveCredential(db, asker.token);
  return { reader, target, keeper, thread, requester };
}
type World = Awaited<ReturnType<typeof world>>;

/** A listener serving anyone (the requester's owner is ""). Its last check-in is set by `seenAt`. */
async function listener(name: string, profile: Record<string, unknown> = {}) {
  const j = await joinLobby(db, bus, { name, kind: "agent" });
  const actor = await resolveCredential(db, j.token);
  await setCapabilities(db, bus, actor, { owner: `${name}-owner`, serves: "anyone", ...profile });
  return { id: j.participant.id, actor };
}
type L = Awaited<ReturnType<typeof listener>>;

/** A request every listener is eligible for: `taking` offer and are accepted with an hour, `offeringOnly` only offer. */
async function work(w: World, title: string, taking: L[], offeringOnly: L[] = []) {
  const r = await openRequest(db, bus, w.requester, w.keeper, {
    title, requirements: {}, wanted: Math.max(1, taking.length),
    targetWeaveId: w.target.weave.id, targetThreadId: w.thread.id, url: null,
  });
  for (const l of [...taking, ...offeringOnly]) await offer(db, bus, l.actor, r.id, {});
  if (taking.length > 0) await accept(db, bus, w.requester, r.id, taking.map((l) => l.id), { deadlineMs: 3_600_000 });
  return r;
}

/** Sets the last check-in, and a history that agrees with it (spec §4.1: the two never disagree). */
const seenAt = (l: { id: string }, at: Date | null) =>
  db.update(participants).set({ lastSeenAt: at, seenHistory: at === null ? null : [at] }).where(eq(participants.id, l.id));
const setOffer = (requestId: string, l: { id: string }, change: Partial<typeof requestOffers.$inferInsert>) =>
  db.update(requestOffers).set(change).where(and(eq(requestOffers.requestId, requestId), eq(requestOffers.participantId, l.id)));
const setRequest = (requestId: string, change: Partial<typeof requestsTable.$inferInsert>) =>
  db.update(requestsTable).set(change).where(eq(requestsTable.id, requestId));
const rowOf = (page: ListenersPage, l: { id: string }) => page.listeners.find((x) => x.participant.id === l.id)!;

describe("status and current work against Postgres (spec 2026-09-27 §4.2, §4.3)", () => {
  it("working needs an accepted, not removed, not completed acceptance on a request stored working", async () => {
    const w = await world();
    const unaccepted = await listener("unaccepted"), removed = await listener("removed"), completed = await listener("completed");
    const overdue = await listener("overdue"), legacy = await listener("legacy"), closed = await listener("closed");
    const shared = await work(w, "Shared", [removed, completed, overdue], [unaccepted]);
    await setOffer(shared.id, removed, { removedAt: NOW });
    await setOffer(shared.id, completed, { completedAt: NOW });
    await setOffer(shared.id, overdue, { dueAt: ago(1) });            // overdue is still an active work item
    const old = await work(w, "Legacy", [legacy]);
    await setRequest(old.id, { status: "open" });                     // stored open never makes anyone working
    const gone = await work(w, "Closed", [closed]);
    await setRequest(gone.id, { status: "cancelled", closedAt: NOW });
    const all = [unaccepted, removed, completed, overdue, legacy, closed];
    for (const l of all) await seenAt(l, ago(60_000));
    const page = await listListeners(db, w.reader, {}, NOW);
    expect(all.map((l) => rowOf(page, l).status)).toEqual(["idle", "idle", "idle", "working", "idle", "idle"]);
    expect((await listListeners(db, w.reader, { status: ["working"] }, NOW)).listeners.map((l) => l.participant.id)).toEqual([overdue.id]);
  });

  it("currentWork is the soonest due active item, with more counting the others", async () => {
    const w = await world();
    const busy = await listener("busy");
    const later = await work(w, "Later", [busy]);
    const first = await work(w, "First", [busy]);
    const tie = await work(w, "Tie", [busy]);
    const done = await work(w, "Done", [busy]);
    const due = new Date("2026-09-27T13:00:00.000Z");
    await setOffer(later.id, busy, { dueAt: new Date("2026-09-27T14:00:00.000Z") });
    await setOffer(first.id, busy, { dueAt: due });
    await setOffer(tie.id, busy, { dueAt: due });
    // The tie is broken by the request's created_at; pinned so it does not rest on two now() calls.
    await setRequest(first.id, { createdAt: new Date("2026-09-27T09:00:00.000Z") });
    await setRequest(tie.id, { createdAt: new Date("2026-09-27T10:00:00.000Z") });
    // Due soonest of all, but completed: not an active item, so neither current nor counted.
    await setOffer(done.id, busy, { dueAt: new Date("2026-09-27T12:30:00.000Z"), completedAt: NOW });
    await seenAt(busy, ago(60_000));
    const [row] = (await listListeners(db, w.reader, {}, NOW)).listeners;
    expect(row!.currentWork).toEqual({ requestId: first.id, title: "First", threadId: first.threadId, more: 2 });
  });

  it("currentWork carries the request's title and its Lobby Thread, and nothing of the target Weave", async () => {
    const w = await world();
    const busy = await listener("busy");
    const r = await work(w, "Review PR 14", [busy]);
    await seenAt(busy, ago(60_000));
    const current = (await listListeners(db, w.reader, {}, NOW)).listeners[0]!.currentWork!;
    expect(current).toEqual({ requestId: r.id, title: "Review PR 14", threadId: r.threadId, more: 0 });
    expect(Object.keys(current).sort()).toEqual(["more", "requestId", "threadId", "title"]);
    const text = JSON.stringify(current);
    expect([text.includes(w.target.weave.id), text.includes(w.thread.id), text.includes("Session")]).toEqual([false, false, false]);
  });

  it("an offline listener keeps its currentWork", async () => {
    const w = await world();
    const busy = await listener("busy");
    const r = await work(w, "Review PR 14", [busy]);
    await seenAt(busy, ago(2 * DEFAULT_POLL_INTERVAL_MS + 1));
    const [row] = (await listListeners(db, w.reader, {}, NOW)).listeners;
    expect([row!.status, row!.currentWork?.requestId]).toEqual(["offline", r.id]);
  });
});

describe("the status filter and the counts (spec 2026-09-27 §4.6)", () => {
  it("the status filter and the counts agree with the TypeScript rule", async () => {
    const w = await world();
    const DECLARED = 300_000;
    const cases: { name: string; profile: Record<string, unknown>; seen: Date | null }[] = [
      { name: "never", profile: { pollIntervalMs: DECLARED }, seen: null },
      { name: "at-twice", profile: { pollIntervalMs: DECLARED }, seen: ago(2 * DECLARED) },
      { name: "past-twice", profile: { pollIntervalMs: DECLARED }, seen: ago(2 * DECLARED + 1) },
      { name: "default-at", profile: {}, seen: ago(2 * DEFAULT_POLL_INTERVAL_MS) },
      { name: "default-past", profile: {}, seen: ago(2 * DEFAULT_POLL_INTERVAL_MS + 1) },
    ];
    const made = new Map<string, L>();
    let i = 0;
    for (const c of cases) {
      for (const suffix of ["free", "busy"]) {
        // Every third one lists a tool, so the tools filter crosses both statuses and both work states.
        made.set(`${c.name}-${suffix}`, await listener(`${c.name}-${suffix}`, { ...c.profile, ...(i++ % 3 === 0 ? { tools: ["shell"] } : {}) }));
      }
    }
    const storedOpen = await listener("stored-open");
    const busyOnes = [...made].filter(([name]) => name.endsWith("-busy")).map(([, l]) => l);
    await work(w, "Busy", busyOnes);
    const legacy = await work(w, "Legacy", [storedOpen]);
    await setRequest(legacy.id, { status: "open" });
    for (const c of cases) for (const suffix of ["free", "busy"]) await seenAt(made.get(`${c.name}-${suffix}`)!, c.seen);
    await seenAt(storedOpen, ago(60_000));
    // Who holds active work is what the fixture made, known here independently of `workFor`.
    const holding = new Set(busyOnes.map((l) => l.id));
    const want = (l: Listener): ListenerStatus => listenerStatus(l.capabilities,
      l.participant.lastSeenAt === null ? null : new Date(l.participant.lastSeenAt), holding.has(l.participant.id), NOW);

    // The rule, pinned by hand once, on the unfiltered read.
    const all = await listListeners(db, w.reader, { limit: 1000 }, NOW);
    expect(Object.fromEntries(all.listeners.map((l) => [l.participant.name, l.status]))).toEqual({
      "at-twice-busy": "working", "at-twice-free": "idle", "default-at-busy": "working", "default-at-free": "idle",
      "default-past-busy": "offline", "default-past-free": "offline", "never-busy": "offline", "never-free": "offline",
      "past-twice-busy": "offline", "past-twice-free": "offline", "stored-open": "idle",
    });

    const filters: ListenerStatus[][] = [[], ["working"], ["idle"], ["offline"], ["working", "idle"],
      ["working", "offline"], ["idle", "offline"], ["working", "idle", "offline"]];
    const extras: ListenersQuery[] = [{}, { q: "busy" }, { tools: ["shell"] }];
    for (const extra of extras) {
      const base = await listListeners(db, w.reader, { ...extra, limit: 1000 }, NOW);
      const counts = { working: 0, idle: 0, offline: 0 };
      for (const l of base.listeners) counts[want(l)]++;
      for (const status of filters) {
        const page = await listListeners(db, w.reader, { ...extra, status, limit: 1000 }, NOW);
        const expected = base.listeners.filter((l) => status.length === 0 || status.includes(want(l)));
        expect({ extra, status, names: page.listeners.map((l) => l.participant.name),
          statuses: page.listeners.map((l) => l.status), matched: page.matched, counts: page.statusCounts })
          .toEqual({ extra, status, names: expected.map((l) => l.participant.name),
            statuses: expected.map(want), matched: expected.length, counts });
      }
    }
  });

  it("statusCounts ignores the status filter and honours every other; the four facets honour it", async () => {
    const w = await world();
    const ada = await listener("ada", { tools: ["shell"], runtime: "node", models: [{ model: "opus-5", effort: "high" }] });
    const bo = await listener("bo", { tools: ["shell"], runtime: "deno", models: [{ model: "opus-5", effort: "high" }] });
    const cy = await listener("cy", { tools: ["git"], runtime: "node", models: [{ model: "sonnet-5", effort: "low" }] });
    await seenAt(ada, ago(60_000));
    await seenAt(bo, null);
    await seenAt(cy, null);
    const page = await listListeners(db, w.reader, { status: ["offline"], runtime: "node" }, NOW);
    expect(page.listeners.map((l) => l.participant.name)).toEqual(["cy"]);
    // Over runtime node, the status filter left out: ada idle, cy offline.
    expect(page.statusCounts).toEqual({ working: 0, idle: 1, offline: 1 });
    // Each facet over the other filters, the status filter included: the offline ones are bo and cy.
    expect(page.facets!.runtimes.values).toEqual([{ value: "deno", count: 1 }, { value: "node", count: 1 }]);
    expect(page.facets!.tools.values).toEqual([{ value: "git", count: 1 }]);
    expect(page.facets!.models.values.map((m) => [m.model, m.count])).toEqual([["sonnet-5", 1]]);
    expect(page.facets!.serves.values).toEqual([{ value: "anyone", count: 1 }, { value: "owner", count: 0 }, { value: "list", count: 0 }]);
  });

  it("statusCounts is present with facets false and with limit 0", async () => {
    const w = await world();
    await seenAt(await listener("ada"), ago(60_000));
    await seenAt(await listener("bo"), null);
    for (const q of [{ facets: false }, { limit: 0 }, { limit: 0, facets: false }] as ListenersQuery[]) {
      expect({ q, counts: (await listListeners(db, w.reader, q, NOW)).statusCounts })
        .toEqual({ q, counts: { working: 0, idle: 1, offline: 1 } });
    }
  });

  it("a status filter of [] is no filter; an unknown word, a non-array and four entries are validation", async () => {
    const w = await world();
    await seenAt(await listener("ada"), null);
    const none = await listListeners(db, w.reader, { status: [] }, NOW);
    expect([none.listeners.map((l) => l.participant.name), none.matched, none.total]).toEqual([["ada"], 1, 1]);
    // Duplicates mean the same as one.
    expect((await listListeners(db, w.reader, { status: ["offline", "offline"] }, NOW)).matched).toBe(1);
    for (const bad of [["busy"], "idle", ["idle", "idle", "offline", "working"], null, [1]]) {
      await expect(listListeners(db, w.reader, { status: bad } as unknown as ListenersQuery, NOW))
        .rejects.toMatchObject({ code: "validation", message: "status must be a list of working, idle or offline" });
    }
  });
});

describe("findAgents (spec 2026-09-27 §4.7)", () => {
  it("findAgents results carry status, currentWork and cadence", async () => {
    const w = await world();
    const busy = await listener("busy", { pollIntervalMs: 300_000 });
    const r = await work(w, "Review PR 14", [busy]);
    const history = [ago(900_000), ago(600_000), ago(300_000)];
    await db.update(participants).set({ lastSeenAt: history.at(-1)!, seenHistory: history }).where(eq(participants.id, busy.id));
    const [found] = await findAgents(db, w.reader, {}, NOW);
    expect(found).toMatchObject({
      status: "working",
      currentWork: { requestId: r.id, title: "Review PR 14", threadId: r.threadId, more: 0 },
      cadence: { typicalGapMs: 300_000, longestGapMs: 300_000, samples: 3 },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/status.test.ts`
Expected: FAIL. The whole file fails to import (`listenerStatus` and `DEFAULT_POLL_INTERVAL_MS` are not exported by `status.ts`); once those exist, every Postgres case fails on the missing `status`, `currentWork`, `cadence` and `statusCounts` fields and on the `status` key being refused as `unknown query key "status"`.

- [ ] **Step 3: The module.** Replace `src/core/src/lobby/status.ts` with:

```ts
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../db/index.js";
import { participants, requestOffers, requests, threads } from "../db/schema.js";
import { isLive, type Profile } from "./matching.js";

/*
 * Listener status, current work and cadence (spec 2026-09-27 §4), computed at read time from
 * `last_seen_at`, `seen_history` and the acceptances: never stored and never an event, so a status is
 * true as of the `now` of the read that computed it. The status rule is written twice: here in
 * TypeScript (`listenerStatus`, what a row carries) and in SQL (`statusSql`, what the directory's
 * status filter and counts read). `status.test.ts` asserts the two agree across every boundary.
 */

export type ListenerStatus = "working" | "idle" | "offline";
/** Q2: the interval assumed for a listener that declares none. Offline after twice this. */
export const DEFAULT_POLL_INTERVAL_MS = 900_000;
/** The directory's three per-status counts: always all three words, zeros included. */
export type StatusCounts = { working: number; idle: number; offline: number };

export type CurrentWork = {
  requestId: string;
  /** The request's title: the name of its Lobby Thread. */
  title: string;
  /** The request's Thread in the Lobby. */
  threadId: string;
  /** How many other active work items the listener holds. */
  more: number;
};

export type Cadence = {
  /** The median gap between consecutive stored check-ins, in ms; null with fewer than two. */
  typicalGapMs: number | null;
  /** The longest of those gaps, in ms; null with fewer than two. */
  longestGapMs: number | null;
  /** How many check-ins are stored: 0 to 20. */
  samples: number;
};

/** One active work item (§4.2 step 2): what `workFor` reads, ordered as `currentWork` picks. */
export type WorkItem = { requestId: string; threadId: string; title: string; dueAt: Date | null; createdAt: Date };

/** The three fields a directory row and a `find_agents` result carry beside the profile. */
export type ListenerFacts = { status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence };

/** The declared interval when it is a number, the default otherwise (no profile, no key, or not a number). */
const intervalOf = (profile: Profile | null): number =>
  profile !== null && typeof profile.pollIntervalMs === "number" ? profile.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;

/**
 * §4.2, in TypeScript. Online is exactly `isLive` with the interval above (so exactly twice the
 * interval is still online), never seen is offline, offline wins over working.
 */
export function listenerStatus(profile: Profile | null, lastSeenAt: Date | null, holdsWork: boolean, now: Date): ListenerStatus {
  if (!isLive({ pollIntervalMs: intervalOf(profile) }, { lastSeenAt, now })) return "offline";
  return holdsWork ? "working" : "idle";
}

/** `intervalOf` in SQL: a JSON number, which is the TypeScript `typeof === "number"` test, or the default. */
const intervalSql = sql`(CASE WHEN jsonb_typeof(${participants.capabilities}->'pollIntervalMs') = 'number'
  THEN (${participants.capabilities}->>'pollIntervalMs')::numeric ELSE ${sql.raw(String(DEFAULT_POLL_INTERVAL_MS))} END)`;

/** §4.2 step 2 in SQL: the participant on the row holds at least one active work item. */
const holdsWorkSql = sql`EXISTS (SELECT 1 FROM ${requestOffers}
  INNER JOIN ${requests} ON ${requests.id} = ${requestOffers.requestId}
  WHERE ${requestOffers.participantId} = ${participants.id} AND ${requestOffers.accepted}
    AND ${requestOffers.removedAt} IS NULL AND ${requestOffers.completedAt} IS NULL
    AND ${requests.status} = 'working')`;

/**
 * §4.2, in SQL: a CASE over one `participants` row yielding `'offline'`, `'working'` or `'idle'`.
 * `now` is the same `Date` the TypeScript side of the read uses, as a bind parameter, never
 * Postgres's `now()`. The elapsed time is compared in exact milliseconds, on the millisecond value a
 * JavaScript `Date` holds (`date_trunc`), so the boundary is the one `isLive` draws.
 */
export function statusSql(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`(CASE
    WHEN ${participants.lastSeenAt} IS NULL
      OR EXTRACT(EPOCH FROM (${at} - date_trunc('milliseconds', ${participants.lastSeenAt}))) * 1000 > 2 * ${intervalSql}
      THEN 'offline'
    WHEN ${holdsWorkSql} THEN 'working'
    ELSE 'idle' END)`;
}

/**
 * §4.3: every active work item of each participant, in one query, ordered `due_at ASC NULLS LAST`,
 * then the request's `created_at`, then its id. Only participants holding at least one appear.
 */
export async function workFor(db: Queryable, participantIds: string[]): Promise<Map<string, WorkItem[]>> {
  const out = new Map<string, WorkItem[]>();
  if (participantIds.length === 0) return out;
  const rows = await db.select({
    participantId: requestOffers.participantId, requestId: requests.id, threadId: requests.threadId,
    title: threads.name, dueAt: requestOffers.dueAt, createdAt: requests.createdAt,
  }).from(requestOffers)
    .innerJoin(requests, eq(requests.id, requestOffers.requestId))
    .innerJoin(threads, eq(threads.id, requests.threadId))
    .where(and(inArray(requestOffers.participantId, participantIds), eq(requestOffers.accepted, true),
      isNull(requestOffers.removedAt), isNull(requestOffers.completedAt), eq(requests.status, "working")))
    .orderBy(sql`${requestOffers.dueAt} ASC NULLS LAST`, asc(requests.createdAt), asc(requests.id));
  for (const { participantId, ...item } of rows) {
    const list = out.get(participantId);
    if (list) list.push(item); else out.set(participantId, [item]);
  }
  return out;
}

/**
 * The first of a participant's ordered items, and how many others. Computed from the items alone,
 * never from the status: an offline listener still shows its work (Q3). Names the request and its
 * Lobby Thread only, never the target Weave's Thread, name or title (§4.3, security).
 */
export function currentWorkOf(items: WorkItem[] | undefined): CurrentWork | null {
  const first = items?.[0];
  return first ? { requestId: first.requestId, title: first.title, threadId: first.threadId, more: items!.length - 1 } : null;
}

/**
 * §4.4. The gaps are only those **between** stored check-ins, in stored order: the time since the
 * last one is not a gap. The median of an even count is the mean of the two middle gaps, rounded
 * down to a whole millisecond. `samples` counts check-ins, not gaps.
 */
export function cadenceOf(history: Date[] | null): Cadence {
  const h = history ?? [];
  if (h.length < 2) return { typicalGapMs: null, longestGapMs: null, samples: h.length };
  const gaps = h.slice(1).map((d, i) => d.getTime() - h[i]!.getTime()).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const typicalGapMs = gaps.length % 2 === 1 ? gaps[mid]! : Math.floor((gaps[mid - 1]! + gaps[mid]!) / 2);
  return { typicalGapMs, longestGapMs: gaps.at(-1)!, samples: h.length };
}

/** The three fields of one participant row, with its work items from `workFor`, at `now`. */
export function listenerFacts(
  row: { capabilities: unknown; lastSeenAt: Date | null; seenHistory: Date[] | null },
  items: WorkItem[] | undefined, now: Date,
): ListenerFacts {
  return {
    status: listenerStatus((row.capabilities as Profile | null) ?? null, row.lastSeenAt, (items?.length ?? 0) > 0, now),
    currentWork: currentWorkOf(items),
    cadence: cadenceOf(row.seenHistory),
  };
}
```

- [ ] **Step 4: The input shapes and the validation.** In `src/core/src/lobby/listeners-input.ts`:

After the `import { validateRequirements, type Profile } from "./matching.js";` line add:

```ts
import type { Cadence, CurrentWork, ListenerStatus, StatusCounts } from "./status.js";
```

Replace the `Listener` type and its comment with:

```ts
/** One directory entry. Shaped like `FoundAgent` on purpose: the same fields, the same order. */
export type Listener = {
  participant: PublicParticipant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};
```

In `ListenersQuery`, directly after the `serves?: ServesKind;` line add:

```ts
  /** Any-of: one or more of working, idle, offline (spec 2026-09-27 §4.6). An empty array is no filter. */
  status?: ListenerStatus[];
```

In `ListenersPage`, after the `facets?: ListenersFacets;` line add:

```ts
  /** Per-status counts over the search and every filter except `status`. Always present, `facets: false` and `limit: 0` included. */
  statusCounts: StatusCounts;
```

In `CleanQuery`, change `runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";` to `runtime?: string; serves?: ServesKind; status?: ListenerStatus[]; sort: ListenersSort; dir: "asc" | "desc";`.

In `QUERY_KEYS`, add `"status"` after `"serves"`. After the `QUERY_KEYS` line add:

```ts
/** The three words a status filter may name (spec 2026-09-27 §4.6). */
const STATUS_WORDS: readonly string[] = ["working", "idle", "offline"];
```

In `validateListenersQuery`, directly after the `serves` check (the line that throws `serves must be anyone, owner or list`) add:

```ts
  // Spec 2026-09-27 §4.6: any-of over three fixed words. An actually empty array is no filter, as
  // for `tools` and `models`; duplicates mean the same as one. The words reach SQL as a bind
  // parameter, so no value from the query ever reaches SQL text.
  const status = emptyArrayToAbsent(input.status as unknown);
  if (status !== undefined && (!Array.isArray(status) || status.length > 3
      || !status.every((w) => typeof w === "string" && STATUS_WORDS.includes(w)))) {
    throw errors.validation("status must be a list of working, idle or offline");
  }
```

and in its `return`, change `q: q || undefined, models, tools, runtime, serves: input.serves, sort, dir, limit,` to `q: q || undefined, models, tools, runtime, serves: input.serves, status: status as ListenerStatus[] | undefined, sort, dir, limit,`.

- [ ] **Step 5: The directory's SQL and rows.** In `src/core/src/lobby/listeners.ts`:

After the `import type { Profile } from "./matching.js";` line add:

```ts
import { listenerFacts, statusSql, workFor, type StatusCounts } from "./status.js";
```

Change the `FacetKey` type to:

```ts
/** The filter a facet or the status counts leave out: each is computed over the others (spec §2.7, 2026-09-27 §4.6). */
type FacetKey = "models" | "tools" | "runtime" | "serves" | "status";
```

Directly after it add:

```ts
/** The clean query plus the one clock this read uses for every row, count, facet and filter (spec 2026-09-27 §4.2). */
type Scope = CleanQuery & { now: Date };
```

Replace **every** `c: CleanQuery` parameter annotation in this file with `c: Scope` (in `filterSql`, `whereFor`, `afterCursor`, `pageRows`, `facetBase`, `rankedFacet`, `modelsFacet`, `servesFacet`, `foldModels`, `readFacets`). Check: `grep -c "c: CleanQuery" src/core/src/lobby/listeners.ts` prints `0` afterwards.

In `filterSql`, directly before `return out;` add:

```ts
  if (c.status !== undefined && omit !== "status") {
    // Any-of, one bind parameter; the words were checked against three fixed ones in core.
    out.push(sql`${statusSql(c.now)} = ANY(${sql.param(c.status)}::text[])`);
  }
```

Directly before the `listListeners` doc comment add:

```ts
/**
 * The three status counts over the base predicate, the search and every filter **except** status
 * (spec 2026-09-27 §4.6), so they sum to what an "All" tab shows. One query, with the read's `now`.
 */
async function readStatusCounts(db: Db, lobbyId: string, c: Scope): Promise<StatusCounts> {
  const rows = await db.execute<StatusCounts>(sql`
    WITH s AS (SELECT ${statusSql(c.now)} AS st FROM ${participants} WHERE ${whereFor(lobbyId, c, "status")})
    SELECT count(*) FILTER (WHERE st = 'working')::int AS working,
           count(*) FILTER (WHERE st = 'idle')::int AS idle,
           count(*) FILTER (WHERE st = 'offline')::int AS offline
    FROM s
  `);
  const r = rows[0]!;
  return { working: r.working, idle: r.idle, offline: r.offline };
}
```

Replace the `listListeners` function (keep its doc comment) with:

```ts
export async function listListeners(db: Db, actor: Actor, query: ListenersQuery = {}, now: Date = new Date()): Promise<ListenersPage> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  // One clock read for the whole answer (spec 2026-09-27 §4.2): the rows, the filter, the counts, the facets.
  const c: Scope = { ...validateListenersQuery(query), now };
  // The cursor is a position, not a filter: it decides the page and never either count.
  const filtering = c.q !== undefined || c.models !== undefined || c.tools !== undefined
    || c.runtime !== undefined || c.serves !== undefined || c.status !== undefined;
  // Nothing here depends on anything else here. `limit: 0` skips the page, `facets: false` skips the
  // four facet queries, and with nothing filtering the two counts are the same `count(*)`. The status
  // counts are read on every answer, because the sidebar's tiles come from the `{ limit: 0, facets:
  // false }` count read.
  //
  // These are independent reads on pooled connections, not one snapshot: there is no surrounding
  // transaction, so a profile set or cleared, a check-in or an acceptance can land between two of
  // them and leave a page disagreeing with its counts or its facets by one. That is the tolerance
  // the page is built for (spec §5.5's "list changed, reload" hint), not an error.
  const [total, matched, rows, facets, statusCounts] = await Promise.all([
    countRows(db, base(lobbyId)!),
    filtering ? countRows(db, whereFor(lobbyId, c)) : undefined,
    c.limit === 0 ? undefined : pageRows(db, lobbyId, c),
    c.facets ? readFacets(db, lobbyId, c) : undefined,
    readStatusCounts(db, lobbyId, c),
  ]);
  const page = rows ?? [];
  const hasNext = page.length > c.limit;
  const shown = hasNext ? page.slice(0, c.limit) : page;
  const last = shown.at(-1);
  // One work lookup for every row on the page (spec 2026-09-27 §4.3).
  const work = await workFor(db, shown.map(({ row }) => row.id));
  const listeners: Listener[] = shown.map(({ row }) => ({
    participant: toPublicParticipant(row), capabilities: row.capabilities as Profile,
    ...listenerFacts(row, work.get(row.id), now),
  }));
  return {
    total, matched: matched ?? total, listeners,
    ...(hasNext && last ? { nextCursor: encodeCursor({ s: c.sort, d: c.dir, k: last.cursorKey, i: last.row.id }) } : {}),
    ...(facets ? { facets } : {}),
    statusCounts,
  };
}
```

- [ ] **Step 6: `findAgents`.** In `src/core/src/lobby/profile.ts`, after the `matching.js` import add:

```ts
import { listenerFacts, workFor, type Cadence, type CurrentWork, type ListenerStatus } from "./status.js";
```

Replace `export type FoundAgent = { participant: PublicParticipant; capabilities: Profile };` with:

```ts
/** The same fields, in the same order, as a directory `Listener` (spec 2026-09-27 §4.5). */
export type FoundAgent = {
  participant: PublicParticipant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};
```

Replace the `findAgents` function (keep its doc comment) with:

```ts
export async function findAgents(db: Db, actor: Actor, filter: AgentFilter, now: Date = new Date()): Promise<FoundAgent[]> {
  const { weaveId: lobbyId } = await getLobby(db);
  assertCanRead(actor, lobbyId);
  const { owner, ...rest } = filter ?? {};
  if (owner !== undefined && (typeof owner !== "string" || owner.trim().length === 0 || owner.length > 64)) {
    throw errors.validation("owner must be 1-64 characters");
  }
  const req = validateRequirements(rest);
  const rows = await db.select().from(participants)
    .where(and(eq(participants.weaveId, lobbyId), isNotNull(participants.capabilities)))
    .orderBy(asc(participants.joinedAt));
  // One clock read for the whole list: the liveness term a request's snapshot applies, and every
  // result's status (spec 2026-09-27 §4.7).
  const found = rows.filter((p) => {
    const capabilities = p.capabilities as Profile;
    return matches(capabilities, req) && (owner === undefined || admits(capabilities, owner.trim()))
      && (req.maxResponseMs === undefined || isLive(capabilities, { lastSeenAt: p.lastSeenAt, now }));
  });
  const work = await workFor(db, found.map((p) => p.id));
  return found.map((p) => ({
    participant: toPublicParticipant(p), capabilities: p.capabilities as Profile,
    ...listenerFacts(p, work.get(p.id), now),
  }));
}
```

- [ ] **Step 7: The facade's types.** In `src/core/src/index.ts`, directly after the line that begins `export { type Listener, type ListenersFacets,` add:

```ts
export { type ListenerStatus, type CurrentWork, type Cadence, type StatusCounts } from "./lobby/status.js";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/status.test.ts test/lobby-listeners.test.ts test/lobby-listeners-input.test.ts test/lobby-profile.test.ts test/liveness.test.ts`
Expected: PASS, every file. The existing "the SQL agrees with matches and admits" property test and the `EXPLAIN` plan test still pass unchanged.

- [ ] **Step 9: Build and typecheck the workspace, then run core**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. If the typecheck of `@loom/server`, `@loom/cli`, `@loom/claude-channel` or `@loom/web` fails, it is on a literal typed as core's `Listener` or `FoundAgent`; none is known at plan time (the adapters use the client's types), so a failure there is a finding.

- [ ] **Step 10: Commit**

```bash
git add src/core/src/lobby/status.ts src/core/src/lobby/listeners-input.ts src/core/src/lobby/listeners.ts src/core/src/lobby/profile.ts src/core/src/index.ts src/core/test/status.test.ts
git diff --cached --stat
git commit -m "feat(core): listener status, current work and cadence on listListeners and findAgents" -m "status.ts holds the status rule in TypeScript and in SQL, asserted to agree over every boundary, the work lookup and currentWork. listListeners gains the status filter and statusCounts on every answer; findAgents results carry the same three fields." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row.

---

### Task 3: core: every acceptance carries the listener's status

Spec §4.5 (`PublicAcceptance`). **This task carries spec §9.1 `getRequest acceptances carry listenerStatus, including an offline one and one that completed this request while working on another`.**

**Files:**
- Modify: `src/core/src/lobby/requests.ts` (`PublicAcceptance`, `toAcceptance`, `hydrate`, one import)
- Modify: `src/core/test/status.test.ts` (one import; append)
- Modify: `src/core/test/lobby-requests.test.ts` (the known ripple)

**Interfaces:**
- Consumes: `listenerStatus`, `workFor` (Task 2).
- Produces: `PublicAcceptance` gains `listenerStatus: ListenerStatus`, on every read that returns a `PublicRequest` (`getRequest`, `listRequests`, the `loom://lobby/requests` resource, and the answers of `openRequest`, `accept`, `complete`, `cancelRequest`).

- [ ] **Step 1: Write the failing test.** In `src/core/test/status.test.ts`, change `import { accept, offer, openRequest } from "../src/lobby/requests.js";` to `import { accept, getRequest, offer, openRequest } from "../src/lobby/requests.js";` and append:

```ts
describe("a request's acceptances (spec 2026-09-27 §4.5)", () => {
  it("getRequest acceptances carry listenerStatus, including an offline one and one that completed this request while working on another", async () => {
    const w = await world();
    const gone = await listener("gone"), doubled = await listener("doubled"), fresh = await listener("fresh");
    const r = await work(w, "Review PR 14", [gone, doubled, fresh]);
    await work(w, "Review PR 15", [doubled]);
    await setOffer(r.id, doubled, { completedAt: NOW });              // done here, still working on PR 15
    await seenAt(gone, ago(2 * DEFAULT_POLL_INTERVAL_MS + 1));
    await seenAt(doubled, ago(60_000));
    await seenAt(fresh, ago(60_000));
    const req = await getRequest(db, w.reader, r.id, NOW);
    expect(req.acceptances.map((a) => [a.participantId, a.listenerStatus]))
      .toEqual([[gone.id, "offline"], [doubled.id, "working"], [fresh.id, "working"]]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src/core && npx vitest run test/status.test.ts -t "getRequest acceptances"`
Expected: FAIL: every `listenerStatus` is `undefined`.

- [ ] **Step 3: The acceptance.** In `src/core/src/lobby/requests.ts`:

After the `matching.js` import add:

```ts
import { listenerStatus, workFor, type ListenerStatus } from "./status.js";
```

In `PublicAcceptance`, change the last line `lastSeenAt: string | null;` to:

```ts
  lastSeenAt: string | null;
  /** The accepted participant's listener status now (spec 2026-09-27 §4.2): not the acceptance's own state. */
  listenerStatus: ListenerStatus;
```

Replace `toAcceptance` with:

```ts
function toAcceptance(
  o: OfferRow, who: { lastSeenAt: Date | null; capabilities: unknown } | undefined, holdsWork: boolean, now: Date,
): PublicAcceptance {
  const removed = o.removedAt !== null;
  const lastSeenAt = who?.lastSeenAt ?? null;
  return {
    participantId: o.participantId, dueAt: iso(o.dueAt), completedAt: iso(o.completedAt),
    note: o.completionNote ?? null, removed, removedAt: iso(o.removedAt),
    overdue: o.dueAt !== null && o.completedAt === null && !removed && now.getTime() >= o.dueAt.getTime(),
    overdueNotifiedAt: iso(o.overdueAt), lastSeenAt: iso(lastSeenAt),
    listenerStatus: listenerStatus((who?.capabilities as Profile | null) ?? null, lastSeenAt, holdsWork, now),
  };
}
```

In `hydrate`, replace the two lines that build `seen` (from `const seen = new Map(acceptedIds.length === 0` through `.map((p) => [p.id, p.lastSeenAt]));`) with:

```ts
  const seen = new Map(acceptedIds.length === 0 ? [] : (await db.select({
    id: participants.id, lastSeenAt: participants.lastSeenAt, capabilities: participants.capabilities,
  }).from(participants).where(inArray(participants.id, acceptedIds))).map((p) => [p.id, p]));
  // One work lookup for every accepted participant, for the listener status beside each acceptance
  // (spec 2026-09-27 §4.5), on the same `now` as the rest of the request.
  const work = await workFor(db, acceptedIds);
```

and change `if (o.accepted) pushTo(acceptancesByRequest, o.requestId, toAcceptance(o, seen.get(o.participantId) ?? null, now));` to:

```ts
    if (o.accepted) pushTo(acceptancesByRequest, o.requestId, toAcceptance(o, seen.get(o.participantId), work.has(o.participantId), now));
```

- [ ] **Step 4: The known ripple.** In `src/core/test/lobby-requests.test.ts`, "getRequest returns acceptances with dueAt, completion, removal, computed overdue and lastSeenAt" compares both acceptances whole. Both listeners are offline at the `now` it reads with (`due - 1`, an hour after the real clock; Pawbot was last seen at the real clock with no declared interval, Shared at `2026-09-23T09:00Z`). Add `listenerStatus: "offline"` as the last key of each of the two objects in that `toEqual`, and nothing else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/status.test.ts test/lobby-requests.test.ts test/lobby-overdue.test.ts test/thread-removal.test.ts`
Expected: PASS, all four files.

- [ ] **Step 6: Build and typecheck, then run core**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine. (`@loom/web` still typechecks: the client's `Acceptance` type does not gain the field until Task 4.)

- [ ] **Step 7: Commit**

```bash
git add src/core/src/lobby/requests.ts src/core/test/status.test.ts src/core/test/lobby-requests.test.ts
git diff --cached --stat
git commit -m "feat(core): acceptances carry the listener's status" -m "hydrate reads the accepted participants' profiles beside last_seen_at and one workFor, so every PublicRequest's acceptances carry listenerStatus. Repaired: lobby-requests.test.ts 'getRequest returns acceptances with dueAt, completion, removal, computed overdue and lastSeenAt' (listenerStatus added)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: REST, client, MCP: the new fields through every adapter

Spec §5. **This task carries spec §9.2, §9.3 and §9.4.** It also carries the web type ripple (see "Why eight tasks").

**Files:**
- Modify: `src/server/test/lobby-routes.test.ts` (a new `describe` at the end; no server source changes: the route already spreads `filter`)
- Modify: `src/client/src/types.ts`, `src/client/src/client.ts` (`listListeners`)
- Modify: `src/client/test/client.test.ts` (one case in "Lobby wrappers")
- Modify: `src/mcp-tools/src/tools.ts` (two descriptions), `src/mcp-tools/src/backend.ts` (one comment)
- Modify: `src/mcp-tools/test/tools.test.ts`
- Modify: `src/web/src/requests-state.ts` (`accepting`)
- Modify: `src/web/test/listeners-page.test.tsx`, `src/web/test/components.test.tsx`, `src/web/test/requests-state.test.ts` (fixtures; one new case)

**Interfaces:**
- Consumes: core's shapes of Tasks 2 and 3 over REST.
- Produces (`@loom/client`, what Tasks 5 and 6 import):

```ts
export type ListenerStatus = "working" | "idle" | "offline";
export type CurrentWork = { requestId: string; title: string; threadId: string; more: number };
export type Cadence = { typicalGapMs: number | null; longestGapMs: number | null; samples: number };
export type StatusCounts = { working: number; idle: number; offline: number };
// FoundAgent and Listener gain  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
// ListenersQuery gains  status?: ListenerStatus[];   ListenersPage gains  statusCounts: StatusCounts;
// Acceptance gains  listenerStatus: ListenerStatus;
```

- [ ] **Step 1: Write the failing server tests.** Append to `src/server/test/lobby-routes.test.ts`:

```ts
describe("listener status over REST (spec 2026-09-27 §5)", () => {
  it("GET /api/lobby/listeners?filter={\"status\":[\"offline\"]} answers only offline rows, with statusCounts; a bad status is 400", async () => {
    const d = await directory();
    // Never seen: the history agrees with last_seen_at, as the stamp keeps them.
    await sqlUnsafe("update participants set last_seen_at = null, seen_history = null where id = $1", [d.bo.id]);
    const r = await api(s.baseUrl, "GET", listenersUrl({ q: d.tag, filter: JSON.stringify({ status: ["offline"] }) }), undefined, d.ada.token);
    expect(r.status).toBe(200);
    expect(listenerIds(r.json.listeners)).toEqual([d.bo.id]);
    expect(r.json.listeners[0]).toMatchObject({ status: "offline", currentWork: null,
      cadence: { typicalGapMs: null, longestGapMs: null, samples: 0 } });
    // Over the search, the status filter left out: Ada and Cy checked in when they set their profiles.
    expect(r.json.statusCounts).toEqual({ working: 0, idle: 2, offline: 1 });
    const bad = await api(s.baseUrl, "GET", listenersUrl({ filter: JSON.stringify({ status: ["busy"] }) }), undefined, d.ada.token);
    expect([bad.status, bad.json.code, bad.json.message]).toEqual([400, "validation", "status must be a list of working, idle or offline"]);
  });

  it("GET /api/lobby/agents results and GET of one request carry the new fields", async () => {
    const f = await scenario();
    const req = await acceptedRequest(f);
    const filter = encodeURIComponent(JSON.stringify({ ...REQUIREMENTS, owner: f.owner }));
    const agents = await api(s.baseUrl, "GET", `/api/lobby/agents?filter=${filter}`, undefined, f.claude.token);
    expect(agents.json.agents).toEqual([expect.objectContaining({
      status: "working",
      currentWork: { requestId: req.id, title: "Review PR 14", threadId: req.threadId, more: 0 },
      cadence: expect.objectContaining({ samples: expect.any(Number) }),
    })]);
    const one = await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, f.claude.token);
    expect(one.json.acceptances[0]).toMatchObject({ participantId: f.pawbot.id, listenerStatus: "working" });
  });
});
```

- [ ] **Step 2: Write the failing client test.** In `src/client/test/client.test.ts`, inside `describe("Lobby wrappers", ...)`, directly after the case "opens a request, lists and reads it, offers on it and accepts the offer", add:

```ts
  it("round trips listener status: listListeners with a status filter, findAgents and getRequest", async () => {
    const f = await lobby();
    const req = await f.claude.openRequest(f.input);
    await f.bot.offer(req.id, {});
    await f.claude.acceptRequest(req.id, [f.botId], 3_600_000);
    // `q` isolates this scenario's listener in the Lobby every test in this file shares. The idle
    // query is what proves the wrapper sends `status`: without it, the working listener comes back.
    const q = `Pawbot-${f.t}`;
    const idle = await f.claude.listListeners({ q, status: ["idle"] });
    expect([idle.listeners, idle.matched, idle.statusCounts]).toEqual([[], 0, { working: 1, idle: 0, offline: 0 }]);
    const page = await f.claude.listListeners({ q, status: ["working"] });
    expect(page.listeners.map((l) => [l.participant.id, l.status, l.currentWork?.requestId])).toEqual([[f.botId, "working", req.id]]);
    const [found] = await f.claude.findAgents({ models: [MODEL], owner: f.owner });
    expect(found).toMatchObject({ status: "working", currentWork: { requestId: req.id, title: "Review PR 14", threadId: req.threadId, more: 0 } });
    expect(found!.cadence.samples).toBeGreaterThanOrEqual(1);
    expect((await f.claude.getRequest(req.id)).acceptances[0]!.listenerStatus).toBe("working");
  });
```

- [ ] **Step 3: Write the failing MCP tests.** In `src/mcp-tools/test/tools.test.ts`, inside `describe("lobby tools", ...)`, directly after "find_agents forwards the filter as given, and defaults it to an empty one", add:

```ts
  it("find_agents and get_request return status, currentWork, cadence and listenerStatus as the backend answers them", async () => {
    const found = [{ participant: { id: "p-1" }, capabilities: { owner: "paw" }, status: "working",
      currentWork: { requestId: "r1", title: "Review PR 14", threadId: "th1", more: 1 },
      cadence: { typicalGapMs: 300_000, longestGapMs: 540_000, samples: 20 } }];
    const request = { id: "r9", offers: [], acceptances: [{ participantId: "p-1", listenerStatus: "offline" }] };
    const saved = { findAgents: fake.findAgents, getRequest: fake.getRequest };
    fake.findAgents = async () => found;
    fake.getRequest = async () => request;
    try {
      expect(JSON.parse(text(await client.callTool({ name: "find_agents", arguments: { credential: "c" } })))).toEqual(found);
      expect(JSON.parse(text(await client.callTool({ name: "get_request", arguments: { credential: "c", requestId: "r9" } })))).toEqual(request);
    } finally { Object.assign(fake, saved); }
  });
```

Inside `describe("the tool descriptions are the spec's", ...)`, directly after "find_agents names maxResponseMs among its filter keys", add:

```ts
  it("find_agents names status, currentWork and cadence", async () => {
    expect((await described()).get("find_agents")).toContain("Each result carries status (working, idle or offline: offline when not seen within twice its pollIntervalMs, 15 minutes when none is declared), currentWork (the request it is working on, soonest due, and how many more) and cadence (median and longest gap between its last 20 check-ins, in ms).");
  });

  it("get_request names each acceptance's listenerStatus", async () => {
    expect((await described()).get("get_request")).toContain("Each acceptance also carries listenerStatus: the accepted agent's status now (working, idle or offline), as find_agents reports it.");
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @loom/core build && cd src/server && npx vitest run test/lobby-routes.test.ts -t "listener status over REST"` then `cd src/client && npx vitest run test/client.test.ts -t "round trips listener status"` then `cd src/mcp-tools && npx vitest run test/tools.test.ts`
Expected: the two server cases PASS already (the route spreads `filter` and core answers the fields): record that in the report as the evidence that REST needs no source change, which is spec §5's claim. The client case FAILS: `listListeners` drops `status` (it is not in the wrapper's `filter` object), so the `idle` query answers the working listener; `status` is also not yet a `ListenersQuery` key (Vitest runs it regardless of types). The two MCP description cases FAIL (`toContain`); the pass-through case PASSES (the tools forward what the backend answers), recorded the same way.

- [ ] **Step 5: The client types.** In `src/client/src/types.ts`, directly before `/** A \`requirements\` filter, plus the owner whose requests the agent would have to serve. */` add:

```ts
/**
 * A listener's status now (spec 2026-09-27 §4.2): offline when not seen within twice its
 * `pollIntervalMs` (15 minutes when none is declared), working when it holds accepted work on a
 * working request, otherwise idle. True as of the read that carried it.
 */
export type ListenerStatus = "working" | "idle" | "offline";
/** The request a listener is working on, the soonest due, and how many more. Names the request and its Lobby Thread only. */
export type CurrentWork = { requestId: string; title: string; threadId: string; more: number };
/** The median and longest gap between a listener's last 20 check-ins, in ms; both null with fewer than two. */
export type Cadence = { typicalGapMs: number | null; longestGapMs: number | null; samples: number };
/** The directory's per-status counts: all three words, zeros included. */
export type StatusCounts = { working: number; idle: number; offline: number };
```

Replace `export type FoundAgent = { participant: Participant; capabilities: Profile };` with:

```ts
export type FoundAgent = {
  participant: Participant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};
```

Replace the `Listener` type and its comment with:

```ts
/** One directory entry. Shaped like `FoundAgent` on purpose: the same fields, the same order. */
export type Listener = {
  participant: Participant; capabilities: Profile;
  status: ListenerStatus; currentWork: CurrentWork | null; cadence: Cadence;
};
```

In `ListenersQuery`, after `serves?: ServesKind;` add:

```ts
  /** Any-of: working, idle, offline. An empty array is no filter. */
  status?: ListenerStatus[];
```

In `ListenersPage`, after `facets?: ListenersFacets;` add:

```ts
  /** Per-status counts over the search and every filter except `status`. Always present. */
  statusCounts: StatusCounts;
```

In `Acceptance`, change its last line `lastSeenAt: string | null;` to:

```ts
  lastSeenAt: string | null;
  /** The accepted listener's status now: not the acceptance's own state (that is `completedAt`, `removed`, `overdue`). */
  listenerStatus: ListenerStatus;
```

- [ ] **Step 6: The wrapper.** In `src/client/src/client.ts`, in `listListeners`, replace

```ts
    const { models, tools, runtime, serves, ...rest } = query;
    const q = new URLSearchParams();
    const filter = { models, tools, runtime, serves };
```

with

```ts
    const { models, tools, runtime, serves, status, ...rest } = query;
    const q = new URLSearchParams();
    const filter = { models, tools, runtime, serves, status };
```

- [ ] **Step 7: The MCP words.** In `src/mcp-tools/src/tools.ts`, in the `find_agents` description, change the ending `Each result's participant carries lastSeenAt."` to `Each result's participant carries lastSeenAt. Each result carries status (working, idle or offline: offline when not seen within twice its pollIntervalMs, 15 minutes when none is declared), currentWork (the request it is working on, soonest due, and how many more) and cadence (median and longest gap between its last 20 check-ins, in ms)."`. In the `get_request` description, change the ending `can still act on a later one by reading it here."` to `can still act on a later one by reading it here. Each acceptance also carries listenerStatus: the accepted agent's status now (working, idle or offline), as find_agents reports it."`. In `src/mcp-tools/src/backend.ts`, change the trailing comment of `findAgents` from `// [{ participant, capabilities }]` to `// [{ participant, capabilities, status, currentWork, cadence }]`.

- [ ] **Step 8: The web type ripple.** The client types now require the new fields, so these repairs keep `@loom/web`'s typecheck green; each adds the field with the value the rule gives, and nothing else.

In `src/web/src/requests-state.ts`, in `accepting`, change the object in `ids.map((participantId): Acceptance => ({ ... }))` so its last line reads:

```ts
    lastSeenAt: held.find((a) => a.participantId === participantId)?.lastSeenAt ?? null,
    // The accept just gave it active work; the held word is kept when there is one (it may say
    // offline), until the request read this event triggers brings the server's.
    listenerStatus: held.find((a) => a.participantId === participantId)?.listenerStatus ?? "working",
```

In `src/web/test/listeners-page.test.tsx`: in `listener(...)`, after the `capabilities: …` line add `status: "idle", currentWork: null, cadence: { typicalGapMs: null, longestGapMs: null, samples: 0 },`; in `directory(...)`, directly before `...over,` add `statusCounts: { working: 0, idle: listeners.length, offline: 0 },`; in "carries the profile in columns, with the tools cut at three", in the `row: Listener` literal after its `capabilities: …` entry add `status: "idle", currentWork: null, cadence: { typicalGapMs: null, longestGapMs: null, samples: 0 },`.

In `src/web/test/components.test.tsx`: in `session()`, change `page: Promise.resolve({ total: 0, matched: 0, listeners: [] })` to `page: Promise.resolve({ total: 0, matched: 0, listeners: [], statusCounts: { working: 0, idle: 0, offline: 0 } })`; in "the panel shows a working request's acceptances ...", in `acc(...)`, change `overdue: false, overdueNotifiedAt: null, lastSeenAt: null, ...over,` to `overdue: false, overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "idle", ...over,`.

In `src/web/test/requests-state.test.ts`: in "a request snapshot fetched before a removal cannot overwrite the applied removal", in the acceptance literal change `overdueNotifiedAt: null, lastSeenAt: null }` to `overdueNotifiedAt: null, lastSeenAt: null, listenerStatus: "idle" }`. And inside `describe("deadlines, completion and removal", ...)`, add:

```ts
  it("an acceptance made from a request.accepted event reads working until the next request read", () => {
    expect(accept(two(), 6, ["p2"]).r1!.acceptances.map((a) => [a.participantId, a.listenerStatus])).toEqual([["p2", "working"]]);
  });
```

- [ ] **Step 9: Build, typecheck and run the four suites**

Run: `pnpm -r build && pnpm -r typecheck && cd src/server && npx vitest run && cd ../client && npx vitest run && cd ../mcp-tools && npx vitest run && cd ../web && npx vitest run && cd ../cli && npx vitest run && cd ../claude-channel && npx vitest run`
Expected: all green, pristine. `git diff --stat HEAD -- src/cli src/claude-channel src/server/src` prints nothing (spec §5: no new command, the CLI's human lines unchanged, `--json` carries the fields because it prints the shapes; the channel passes both through; no server source change).

- [ ] **Step 10: Commit**

```bash
git add src/server/test/lobby-routes.test.ts src/client/src/types.ts src/client/src/client.ts src/client/test/client.test.ts src/mcp-tools/src/tools.ts src/mcp-tools/src/backend.ts src/mcp-tools/test/tools.test.ts src/web/src/requests-state.ts src/web/test/listeners-page.test.tsx src/web/test/components.test.tsx src/web/test/requests-state.test.ts
git diff --cached --stat
git commit -m "feat: listener status through REST, the client and MCP" -m "No new route or tool: the listeners filter carries status, the client types gain ListenerStatus, CurrentWork, Cadence and StatusCounts, and find_agents and get_request name the fields. Web fixtures gain the new required fields (listeners-page listener() and directory() and the columns row, components session() and acc(), requests-state's snapshot acceptance); requests-state's accepting reads working." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: web: the directory's status tabs, the Status and Current work columns, the rate text

Spec §6.1, §6.2, §6.3. **This task carries spec §9.5: `rateText` and `durationText`; the four tab tests; the Status and Current work column test; the offline row with work; the Last seen rate text.**

**Files:**
- Create: `src/web/src/components/listeners/listener-status.ts`
- Modify: `src/web/src/components/listeners/listeners-query.ts`
- Modify: `src/web/src/components/listeners/ListenersPage.tsx`
- Modify: `src/web/src/components/WeaveView.tsx` (the `ListenersPage` element)
- Create: `src/web/test/listener-status.test.ts`
- Modify: `src/web/test/listeners-page.test.tsx` (two new `describe`s; the known ripple)

**Interfaces:**
- Consumes: `Listener`, `ListenerStatus`, `Cadence`, `StatusCounts`, `Profile` from `@loom/client` (Task 4).
- Produces:

```ts
// src/web/src/components/listeners/listener-status.ts
export function durationText(ms: number): string;
export function rateText(cadence: Cadence, profile: Profile): string;
// src/web/src/components/listeners/listeners-query.ts
export type ListenersView = { …; status?: ListenerStatus };
// src/web/src/components/listeners/ListenersPage.tsx
export function ListenersPage(props: { session: Session; invite?: InviteTarget; onOpenThread?: (threadId: string) => void }): JSX.Element;
```

- [ ] **Step 1: Write the failing pure tests.** Create `src/web/test/listener-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Profile } from "@loom/client";
import { durationText, rateText } from "../src/components/listeners/listener-status.js";

const none = { typicalGapMs: null, longestGapMs: null, samples: 0 };
/** A stored profile whose `pollIntervalMs` is not a number reads as declaring none. */
const notANumber = { owner: "a", pollIntervalMs: "5 min" } as unknown as Profile;

describe("rateText and durationText (spec 2026-09-27 §6.3)", () => {
  it("writes each of the four forms", () => {
    expect([
      rateText({ typicalGapMs: 300_000, longestGapMs: 2_400_000, samples: 20 }, { owner: "a", pollIntervalMs: 300_000 }),
      rateText(none, { owner: "a", pollIntervalMs: 300_000 }),
      rateText({ typicalGapMs: 720_000, longestGapMs: 1_800_000, samples: 8 }, { owner: "a" }),
      rateText(none, notANumber),
    ]).toEqual([
      "every ~5 min (declares 5 min), longest 40 min",
      "rate unknown (declares 5 min)",
      "every ~12 min (no declared interval), longest 30 min",
      "rate unknown (no declared interval)",
    ]);
  });

  it("rounds at the edges: 89 s, 90 s, 89 min, 90 min", () => {
    expect([durationText(89_000), durationText(90_000), durationText(5_340_000), durationText(5_400_000)])
      .toEqual(["89 s", "2 min", "89 min", "2 h"]);
  });

  it("writes no 0 at the floors a gap and a declared interval can reach", () => {
    expect([durationText(10_001), durationText(60_000)]).toEqual(["10 s", "60 s"]);
  });
});
```

- [ ] **Step 2: Write the failing directory tests.** In `src/web/test/listeners-page.test.tsx`, directly after the `describe("a row of the table (Listeners.dc.html)", ...)` block, add:

```tsx
describe("the status tabs (spec 2026-09-27 §6.1)", () => {
  const tab = (v: { container: Element }, key: string) => v.container.querySelector(`.status-tab-${key}`) as HTMLButtonElement;
  const tabs = (v: { container: Element }) =>
    [...v.container.querySelectorAll(".status-tab")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
  const counted = () => json(directory([listener("ada", "ada@example.com")], { statusCounts: { working: 2, idle: 58, offline: 2 } }));
  const linkTo = (filter: string) => `/lobby/listeners?filter=${encodeURIComponent(filter)}`;

  it("the directory shows All, Working, Idle and Offline tabs with the server's counts, All the sum", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: counted } });
    await settle();
    expect(tabs(v)).toEqual([["All 62", "true"], ["Working 2", "false"], ["Idle 58", "false"], ["Offline 2", "false"]]);
  });

  it("pressing a tab queries the server with that status and marks it pressed; All sends none", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: counted } });
    await settle();
    fireEvent.click(tab(v, "idle"));
    await settle();
    expect([v.queries().at(-1)!.get("filter"), tab(v, "idle").getAttribute("aria-pressed"), tab(v, "all").getAttribute("aria-pressed")])
      .toEqual(['{"status":["idle"]}', "true", "false"]);
    fireEvent.click(tab(v, "all"));
    await settle();
    expect([v.queries().at(-1)!.has("filter"), tab(v, "all").getAttribute("aria-pressed"), v.asked()]).toEqual([false, "true", 3]);
  });

  it("a tab's status is carried in the URL; a link with two statuses or an unknown one is reported and dropped", async () => {
    const v = mountLobby({ storage: joined() });
    await settle();
    fireEvent.click(tab(v, "offline"));
    await settle();
    expect(new URLSearchParams(location.search).get("filter")).toBe('{"status":["offline"]}');
    v.unmount();
    const kept = mountLobby({ path: linkTo('{"status":["idle"]}'), storage: joined() });
    await settle();
    expect([tab(kept, "idle").getAttribute("aria-pressed"), kept.queries()[0]!.get("filter")]).toEqual(["true", '{"status":["idle"]}']);
    kept.unmount();
    for (const bad of ['{"status":["idle","offline"]}', '{"status":["busy"]}', '{"status":"idle"}']) {
      const b = mountLobby({ path: linkTo(bad), storage: joined() });
      await settle();
      expect({ bad, note: !!screen.queryByText("Part of this link was not understood, so it was ignored."),
        filter: b.queries()[0]!.has("filter"), all: tab(b, "all").getAttribute("aria-pressed") })
        .toEqual({ bad, note: true, filter: false, all: "true" });
      b.unmount();
    }
  });

  it("Clear filters returns the tab to All", async () => {
    const v = mountLobby({ path: linkTo('{"status":["working"]}'), storage: joined() });
    await settle();
    const clear = screen.getByRole("button", { name: "Clear filters" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    await settle();
    expect([tab(v, "all").getAttribute("aria-pressed"), v.queries().at(-1)!.has("filter")]).toEqual(["true", false]);
  });
});

describe("the Status and Current work columns, and the rate (spec 2026-09-27 §6.2, §6.3)", () => {
  const REQ_THREAD = { ...GENERAL, id: "th-req", name: "Review PR 14", isGeneral: false };
  const busy = (over: Partial<Listener> = {}): Listener => ({
    ...listener("ada", "ada@example.com"), status: "working",
    currentWork: { requestId: "r1", title: "Review PR 14", threadId: "th-req", more: 2 }, ...over,
  });
  const row = (v: { container: Element }, n = 0) => v.container.querySelectorAll(".listeners tbody tr.listener-row")[n]!;

  it("the Status column shows each row's word; Current work shows the title and +N, and pressing it opens that Thread in the thread view", async () => {
    const v = mountLobby({ storage: joined(), routes: {
      [LISTENERS]: () => json(directory([busy(), listener("bo", "bo@example.com")])),
      [WEAVE]: () => json(weaveBody({ threads: [GENERAL, REQ_THREAD] })),
    } });
    await settle();
    const word = (n: number) => row(v, n).querySelector(".listener-status")!;
    expect([[word(0).className, word(0).textContent], [word(1).className, word(1).textContent]]).toEqual([
      ["listener-status listener-status-working", "working"], ["listener-status listener-status-idle", "idle"]]);
    const more = row(v).querySelector(".current-work-more")!;
    expect([row(v).querySelector("button.current-work")!.textContent, more.textContent, more.getAttribute("aria-label"),
      row(v, 1).querySelector(".current-work")]).toEqual(["Review PR 14", "+2", "2 more", null]);
    fireEvent.click(row(v).querySelector("button.current-work")!);
    await settle();
    expect([v.directory(), v.container.querySelector(".thread-header h2")!.textContent]).toEqual([false, "# Review PR 14"]);
  });

  it("an offline row with work shows both", async () => {
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory([busy({ status: "offline" })])) } });
    await settle();
    expect([row(v).querySelector(".listener-status-offline")?.textContent, row(v).querySelector("button.current-work")?.textContent])
      .toEqual(["offline", "Review PR 14"]);
  });

  it("the Last seen cell shows the rate text", async () => {
    const measured = busy({
      capabilities: { owner: "ada@example.com", models: [{ model: "opus-5", effort: "high" }], tools: ["shell"], runtime: "node", pollIntervalMs: 300_000 },
      cadence: { typicalGapMs: 300_000, longestGapMs: 540_000, samples: 20 },
    });
    const v = mountLobby({ storage: joined(), routes: { [LISTENERS]: () => json(directory([measured])) } });
    await settle();
    expect(row(v).querySelector(".listener-rate")!.textContent).toBe("every ~5 min (declares 5 min), longest 9 min");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/web && npx vitest run test/listener-status.test.ts test/listeners-page.test.tsx -t "status tabs|Status and Current work|rateText"`
Expected: FAIL. `listener-status.test.ts` fails to resolve its import; the tab tests find no `.status-tab`; the column tests find no `.listener-status`, `.current-work` or `.listener-rate`.

- [ ] **Step 4: The rate text.** Create `src/web/src/components/listeners/listener-status.ts`:

```ts
import type { Cadence, Profile } from "@loom/client";

/**
 * A duration as the directory writes it (spec 2026-09-27 §6.3): under 90 s whole seconds, under 90
 * minutes whole minutes, otherwise whole hours, each `Math.round`ed (halves up). Every gap exceeds
 * the 10 s throttle and a declared interval is at least a minute, so nothing reads `0`.
 */
export function durationText(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/**
 * The rate beside Last seen: the measured part (`every ~<typical>`, or `rate unknown` with fewer
 * than two check-ins), the declared part in parentheses, then `, longest <longest>` when measured.
 */
export function rateText(cadence: Cadence, profile: Profile): string {
  const declared = typeof profile.pollIntervalMs === "number"
    ? ` (declares ${durationText(profile.pollIntervalMs)})` : " (no declared interval)";
  if (cadence.typicalGapMs === null || cadence.longestGapMs === null) return `rate unknown${declared}`;
  return `every ~${durationText(cadence.typicalGapMs)}${declared}, longest ${durationText(cadence.longestGapMs)}`;
}
```

- [ ] **Step 5: The view and the URL.** In `src/web/src/components/listeners/listeners-query.ts`:

Change the first import to `import type { ListenerStatus, ListenersQuery, ListenersSort, ServesKind } from "@loom/client";`.

Change `ListenersView` to:

```ts
export type ListenersView = {
  q: string; models: { model: string; effort?: string }[]; tools: string[];
  runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";
  /** The selected status tab (spec 2026-09-27 §6.1); absent is All. */
  status?: ListenerStatus;
};
```

Change `const FILTER_KEYS = ["models", "tools", "runtime", "serves"];` to `const FILTER_KEYS = ["models", "tools", "runtime", "serves", "status"];` and after it add:

```ts
/** The three status words a link may name, one at a time (spec 2026-09-27 §6.1). */
const STATUS_WORDS = ["working", "idle", "offline"] as const;
```

In `viewFromSearch`, directly after the `const serves = …` line add:

```ts
  // The tabs show one status, so a link names exactly one (spec 2026-09-27 §6.1). An empty array is
  // no filter, as core reads it; two words, an unknown word or a non-array are dropped and reported.
  const status = given(filter.status, (v) => {
    if (Array.isArray(v) && v.length === 0) return undefined;
    if (!Array.isArray(v) || v.length !== 1) return drop();
    return oneOf(v[0], STATUS_WORDS);
  });
```

and change its return to `return { view: { q, models, tools, runtime, serves, status, sort, dir }, partial };`.

In `searchFromView`, after `if (view.serves !== undefined) filter.serves = view.serves;` add `if (view.status !== undefined) filter.status = [view.status];`. In `queryFromView`, after `if (view.serves !== undefined) query.serves = view.serves;` add `if (view.status !== undefined) query.status = [view.status];`.

- [ ] **Step 6: The page.** In `src/web/src/components/listeners/ListenersPage.tsx`:

Change the second `@loom/client` import to `import type { Listener, ListenerStatus, ListenersFacets, ListenersSort, Profile, ServesKind, StatusCounts } from "@loom/client";` and after the `FacetChips.js` import add `import { rateText } from "./listener-status.js";`.

In `PageState`, after `facets?: ListenersFacets;` add:

```ts
  /** The newest answer's status counts: what the tabs show, once an answer has given them. */
  statusCounts?: StatusCounts;
```

Replace the `COLUMNS` line with:

```ts
/** The table's columns, in order; the details row spans all of them. Status and Current work follow Owner (spec 2026-09-27 §6.2). */
const COLUMNS = ["Listener", "Owner", "Status", "Current work", "Models", "Tools", "Runtime", "Serves", "Last seen", "Joined", "Actions"];

/** The four status tabs, in order (spec 2026-09-27 §6.1): All is no status filter. */
const STATUS_TABS: { key: "all" | ListenerStatus; label: string }[] = [
  { key: "all", label: "All" }, { key: "working", label: "Working" }, { key: "idle", label: "Idle" }, { key: "offline", label: "Offline" },
];
```

Change the component's signature to:

```tsx
export function ListenersPage({ session, invite, onOpenThread }: {
  session: Session; invite?: InviteTarget;
  /** Opens a Lobby Thread in the thread view, as a Thread list entry does: the Current work button's target. */
  onOpenThread?: (threadId: string) => void;
}) {
```

In `run`'s answer, change `facets: page.facets ?? s.facets, nextCursor: page.nextCursor,` to `facets: page.facets ?? s.facets, nextCursor: page.nextCursor, statusCounts: page.statusCounts ?? s.statusCounts,`.

After `toggleServes` add:

```ts
  /** One tab, single-select: the status the server filters by, or none for All. Pressing the selected tab does nothing. */
  const pickStatus = (status?: ListenerStatus) => {
    if (status === viewRef.current.status) return;
    apply((v) => ({ ...v, status }));
  };
```

In `atDefaults`, change the end `&& view.sort === "name" && view.dir === "asc";` to `&& view.status === undefined && view.sort === "name" && view.dir === "asc";`.

Change `<Table state={state} invite={invite} onInvite={inviteOne} />` to:

```tsx
      <StatusTabs selected={view.status} counts={state.statusCounts} onPick={pickStatus} />
      <Table state={state} invite={invite} onInvite={inviteOne} onOpenThread={onOpenThread} />
```

Directly before the `Table` doc comment add:

```tsx
/**
 * The four tabs above the table (spec 2026-09-27 §6.1): single-select, each with its count from the
 * newest answer (All is the sum), shown only once an answer has given one. The filtering is the
 * server's: a tab never filters rows here.
 */
function StatusTabs({ selected, counts, onPick }: {
  selected?: ListenerStatus; counts?: StatusCounts; onPick: (status?: ListenerStatus) => void;
}) {
  return (
    <div class="status-tabs">
      {STATUS_TABS.map((t) => {
        const count = counts === undefined ? undefined
          : t.key === "all" ? counts.working + counts.idle + counts.offline : counts[t.key];
        const pressed = t.key === "all" ? selected === undefined : selected === t.key;
        return (
          <button key={t.key} type="button" class={`status-tab status-tab-${t.key}`} aria-pressed={pressed ? "true" : "false"}
            onClick={() => onPick(t.key === "all" ? undefined : t.key)}>
            {t.label}{count !== undefined && <>{" "}<span class="status-tab-count">{count.toLocaleString()}</span></>}
          </button>
        );
      })}
    </div>
  );
}
```

Change `Table`'s signature and its row line to pass `onOpenThread` through:

```tsx
function Table({ state, invite, onInvite, onOpenThread }: {
  state: PageState; invite?: InviteTarget;
  onInvite: (threadId: string, participantId: string) => Promise<boolean>;
  onOpenThread?: (threadId: string) => void;
}) {
```

and `{state.rows.map((l) => <Row key={l.participant.id} listener={l} now={now} invite={invite} onInvite={onInvite} onOpenThread={onOpenThread} />)}`.

Change `Row`'s signature to:

```tsx
function Row({ listener: l, now, invite, onInvite, onOpenThread }: {
  listener: Listener; now: number; invite?: InviteTarget;
  onInvite: (threadId: string, participantId: string) => Promise<boolean>;
  onOpenThread?: (threadId: string) => void;
}) {
```

After `const details = …;` in `Row` add `const work = l.currentWork;`. In the row's cells, directly after the Owner cell (`<td>{profile.owner ? String(profile.owner) : ""}</td>`) add:

```tsx
        <td><span class={`listener-status listener-status-${l.status}`}>{l.status}</span></td>
        {/* A button, not an anchor: it changes the view of the page it is on, as the sidebar's
            Listeners control does. Shown for an offline listener too (Q3). */}
        <td>{work && <>
          <button type="button" class="link current-work" onClick={() => onOpenThread?.(work.threadId)}>{work.title}</button>
          {work.more > 0 && <>{" "}<span class="current-work-more" aria-label={`${work.more} more`}>+{work.more}</span></>}
        </>}</td>
```

and change the Last seen cell to:

```tsx
        <td class="mono muted">{agoText(p.lastSeenAt, now)}<div class="listener-rate">{rateText(l.cadence, profile)}</div></td>
```

- [ ] **Step 7: The Thread opener.** In `src/web/src/components/WeaveView.tsx`, change `<ListenersPage key={viewKey} session={session} invite={inviteTarget} />` to:

```tsx
              <ListenersPage key={viewKey} session={session} invite={inviteTarget}
                onOpenThread={(threadId) => { session.selectThread(threadId); onView?.("thread"); }} />
```

- [ ] **Step 8: The known ripple.** In `src/web/test/listeners-page.test.tsx`, `describe("a row of the table (Listeners.dc.html)", ...)`: in "carries the profile in columns, with the tools cut at three", change `cells(v).slice(0, 7)` to `cells(v).slice(0, 9)` and the two expected arrays to

```ts
      ["Listener", "Owner", "Status", "Current work", "Models", "Tools", "Runtime", "Serves", "Last seen", "Joined", "Actions"],
      ["ada", "ada@example.com", "idle", "", "opus-5/high, fable/max", "shell, git, web +2", "node", "anyone", "3 min agorate unknown (no declared interval)"],
```

and in "says never for a listener that has not been seen, and its owner for a default serves" change `expect([cells(v)[5], cells(v)[6]]).toEqual(["its owner", "never"]);` to `expect([cells(v)[7], cells(v)[8]]).toEqual(["its owner", "neverrate unknown (no declared interval)"]);`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run test/listener-status.test.ts test/listeners-page.test.tsx test/listeners-query.test.ts test/components.test.tsx`
Expected: PASS, all four files.

- [ ] **Step 10: Typecheck and run web**

Run: `pnpm --filter @loom/web typecheck && cd src/web && npx vitest run`
Expected: all green, pristine. `git diff --stat HEAD -- src/web/src/styles.css` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/web/src/components/listeners/listener-status.ts src/web/src/components/listeners/listeners-query.ts src/web/src/components/listeners/ListenersPage.tsx src/web/src/components/WeaveView.tsx src/web/test/listener-status.test.ts src/web/test/listeners-page.test.tsx
git diff --cached --stat
git commit -m "feat(web): directory status tabs, Status and Current work columns, rate text" -m "Four single-select tabs send status to the server and live in the link's filter; each row shows its status word, its current work (opening that Thread) and the rate beside Last seen. Repaired: 'carries the profile in columns, with the tools cut at three' and 'says never for a listener that has not been seen, and its owner for a default serves' (two new columns and the rate text)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: web: the sidebar tiles, status on the profile card and on acceptances, and freshness on visible

Spec §6.4, §6.5, §6.6. **This task carries spec §9.5: the sidebar tiles; a failed count read keeps the last tiles; the profile card; the requests panel; becoming visible re-reads the tiles and re-runs the directory's view.**

**Files:**
- Modify: `src/web/src/session.ts` (state, `Session`, the count read, the visibility handler, `onVisible`, `dispose`)
- Modify: `src/web/src/components/ListenersLink.tsx`
- Modify: `src/web/src/components/ProfileCard.tsx`
- Modify: `src/web/src/components/RequestsPanel.tsx`
- Modify: `src/web/src/components/listeners/ListenersPage.tsx` (the re-run on visible; the card's status)
- Modify: `src/web/test/session.test.ts`, `src/web/test/listeners-page.test.tsx`, `src/web/test/components.test.tsx`

**Interfaces:**
- Consumes: `StatusCounts`, `ListenerStatus` (Task 4); `ListenersPage` (Task 5); `fakeVisibility`, `sideReadClient` (existing test helpers).
- Produces:

```ts
// src/web/src/session.ts
SessionState.listenerStatusCounts?: StatusCounts;          // set, guarded and kept exactly as listenerCount
Session.onVisible(fn: () => void): () => void;             // called each time the tab becomes visible
// src/web/src/components/ProfileCard.tsx
ProfileCard(props: { participant: Participant; now?: number; status?: ListenerStatus });
```

- [ ] **Step 1: Write the failing session tests.** In `src/web/test/session.test.ts`, inside `describe("the Lobby's listener count (spec §5.1)", ...)`, after "keeps the last number it had when a later count read fails", add:

```ts
  it("stores the count read's statusCounts for the tiles", async () => {
    const f = await lobbyFixture();
    const session = await makeSession({ kind: "secret", secret: f.secret }, f.storage);
    try {
      await waitFor(() => session.getState().listenerStatusCounts !== undefined);
      expect(session.getState().listenerStatusCounts)
        .toEqual((await anon.withToken(f.requester.token).listListeners({ limit: 0, facets: false })).statusCounts);
    } finally { session.dispose(); }
  });

  it("a failed count read keeps the last tiles", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient({ [LISTENERS]: onCall(2, UNREACHABLE) });
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerStatusCounts !== undefined);
      const answered = session.getState().listenerStatusCounts;
      await waitFor(() => session.getState().connection === "open");
      await anon.joinLobby({ name: `Late-${++fixtureN}`, kind: "human" });
      await waitFor(() => session.getState().listenerCountError === true);
      expect(session.getState().listenerStatusCounts).toBe(answered);
    } finally { session.dispose(); }
  });

  it("becoming visible re-reads the tiles", async () => {
    const f = await lobbyFixture();
    const c = sideReadClient();
    const vis = fakeVisibility();
    const session = createSession({ client: c.client, target: { kind: "secret", secret: f.secret }, storage: f.storage, visibility: vis });
    await session.load();
    try {
      await waitFor(() => session.getState().listenerStatusCounts !== undefined);
      const before = c.calls(LISTENERS);
      vis.set(false);
      expect(c.calls(LISTENERS)).toBe(before);                           // hiding reads nothing
      vis.set(true);
      await waitFor(() => c.calls(LISTENERS) > before);
    } finally { session.dispose(); }
  });
```

(`fakeVisibility` is a function declaration further down the file, so it is in scope here.)

- [ ] **Step 2: Write the failing component tests.** In `src/web/test/listeners-page.test.tsx`, inside `describe("the Lobby sidebar's listeners line (spec §5.1)", ...)`, add:

```tsx
  it("the Lobby sidebar shows the three tiles once the count read answers; none before, none off the Lobby", () => {
    const tiles = (c: Element) => [...c.querySelectorAll(".listener-tiles .listener-tile")].map((t) => [t.className, t.textContent]);
    const counts = { working: 2, idle: 58, offline: 2 };
    const on = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState({ listenerCount: 62, listenerStatusCounts: counts })} />);
    expect(tiles(on.container)).toEqual([
      ["listener-tile listener-tile-working", "2 Working"],
      ["listener-tile listener-tile-idle", "58 Idle"],
      ["listener-tile listener-tile-offline", "2 Offline"],
    ]);
    on.unmount();
    const before = render(<ListenersLink active={false} onToggle={() => {}} state={lobbyState()} />);
    expect(before.container.querySelector(".listener-tiles")).toBeNull();
    before.unmount();
    const off = render(<ListenersLink active={false} onToggle={() => {}}
      state={lobbyState({ weave: { ...LOBBY_WEAVE, id: "22222222-2222-4222-8222-222222222222" }, listenerStatusCounts: counts })} />);
    expect(off.container.innerHTML).toBe("");
  });
```

In `describe("a row's Invite and Profile", ...)`, after "opens the full profile under its row, and closes it again", add:

```tsx
  it("hands the row's status to the card it opens", async () => {
    const v = mountLobby({ storage: joined() });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Profile of ada" }));
    await settle();
    expect(v.container.querySelector(".listener-details .profile-card .listener-status")!.className).toBe("listener-status listener-status-idle");
  });
```

In `src/web/test/components.test.tsx`: add `import { ListenersPage } from "../src/components/listeners/ListenersPage.js";` after the `WeaveView` import and `type ListenersQuery` to the `@loom/client` type import. In `session()`, directly before `...over };` add `onVisible: () => () => {},`. Inside the `describe` that holds "ProfileCard shows 'seen N min ago' ...", after that case add:

```tsx
  it("the profile card shows the status word beside seen", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    const { container, rerender } = render(<ProfileCard participant={{ ...helper, lastSeenAt: "2026-09-23T11:55:00.000Z" }} now={now} status="offline" />);
    const word = container.querySelector(".listener-status")!;
    expect([container.querySelector(".profile-seen")!.textContent, word.className, word.textContent, word.previousElementSibling?.className])
      .toEqual(["seen 5 min ago", "listener-status listener-status-offline", "offline", "profile-seen"]);
    rerender(<ProfileCard participant={{ ...helper, lastSeenAt: "2026-09-23T11:55:00.000Z" }} now={now} />);
    expect(container.querySelector(".listener-status")).toBeNull();
  });
```

After "the panel shows a working request's acceptances with due, completed, removed and overdue", add:

```tsx
  it("the requests panel's acceptance shows seen and the listener status beside the acceptance badge", () => {
    const working = request({ status: "working", offers: [anOffer("p2", { accepted: true })], acceptances: [{
      participantId: "p2", dueAt: "2026-09-16T14:30:00.000Z", completedAt: null, note: null, removed: false, removedAt: null,
      overdue: false, overdueNotifiedAt: null, lastSeenAt: "2026-09-16T13:25:00.000Z", listenerStatus: "offline" }] });
    const { container } = render(<RequestsPanel state={lobbyState({ requests: { r1: working } })} session={session()} onError={() => {}} now={NOW} />);
    const li = container.querySelector(".acceptance")!;
    const status = li.querySelector(".listener-status")!;
    expect([li.querySelector(".badge")!.textContent, li.querySelector(".acceptance-seen")!.textContent, status.className, status.textContent])
      .toEqual(["working", "seen 5 min ago", "listener-status listener-status-offline", "offline"]);
  });
```

At the end of the file add:

```tsx
describe("the directory on becoming visible (spec 2026-09-27 §6.6)", () => {
  it("becoming visible re-runs the directory's view: the first page, with facets", async () => {
    let visible: (() => void) | undefined;
    const page = { total: 1, matched: 1, listeners: [], statusCounts: { working: 0, idle: 1, offline: 0 } };
    const listListeners = vi.fn((_q: ListenersQuery) => ({ issue: { generation: 0 }, page: Promise.resolve(page) }));
    render(<ListenersPage session={session({ listListeners, onVisible: (fn) => { visible = fn; return () => {}; } })} />);
    await new Promise((r) => setTimeout(r, 0));
    visible!();
    await new Promise((r) => setTimeout(r, 0));
    expect(listListeners.mock.calls.map((c) => c[0])).toEqual([{ sort: "name", dir: "asc", limit: 50 }, { sort: "name", dir: "asc", limit: 50 }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/web && npx vitest run test/session.test.ts -t "tiles|statusCounts" && npx vitest run test/listeners-page.test.tsx test/components.test.tsx`
Expected: FAIL. `listenerStatusCounts` never appears; no `.listener-tiles`, no `.listener-status` on the card or the acceptance, and `visible` is never registered (`visible!()` throws).

- [ ] **Step 4: The session.** In `src/web/src/session.ts`:

In the first import, add `type StatusCounts` after `type Participant,`.

In `SessionState`, after the `listenerCountError?: boolean;` field add:

```ts
  /** The Lobby's listeners by status, from the same count read as `listenerCount` (spec 2026-09-27
   *  §6.4): set, guarded and kept on failure exactly as it is. Absent means not known. */
  listenerStatusCounts?: StatusCounts;
```

In `Session`, after `reportCredentialFailure(e: unknown, issue: QueryIssue): void;` add:

```ts
  /** Called each time the tab becomes visible (spec 2026-09-27 §6.6); answers the unsubscribe. */
  onVisible(fn: () => void): () => void;
```

In `readListenerCount`, change `set({ listenerCount: page.total, listenerCountError: false });` to `set({ listenerCount: page.total, listenerStatusCounts: page.statusCounts, listenerCountError: false });`.

Replace the `offVisibility` definition (and its doc comment) with:

```ts
  /** Told when the tab becomes visible: the directory re-runs its view (spec 2026-09-27 §6.6). */
  const visibleFns = new Set<() => void>();
  /**
   * The visibility rule's two edges (§6.2): hiding flushes what was read while visible; showing
   * reloads the positions, and their answer marks the open Thread (if the tab is still visible then).
   * Showing also re-reads the Lobby's count, so the tiles are as fresh as the tab (spec 2026-09-27 §6.6).
   */
  const offVisibility = visibility.onChange(() => {
    if (disposed) return;
    if (!visibility.visible()) { throttle.flush(); return; }
    loadReadState();
    if (onLobby()) readListenerCount(generation);
    for (const fn of [...visibleFns]) fn();
  });
```

In the returned object, directly after `reportCredentialFailure(e, issue) { … },` add:

```ts
    onVisible(fn) {
      visibleFns.add(fn);
      return () => { visibleFns.delete(fn); };
    },
```

In `dispose`, after `offVisibility();` add `visibleFns.clear();`.

- [ ] **Step 5: The tiles.** In `src/web/src/components/ListenersLink.tsx`, after the imports add:

```tsx
/** The three tiles, in order (spec 2026-09-27 §6.4): display only, not controls. */
const TILES = [["working", "Working"], ["idle", "Idle"], ["offline", "Offline"]] as const;
```

and directly after the closing `</div>` of `nav-head` (before the `count unavailable` line) add:

```tsx
      {/* Only once a count read has answered; the section's gate above keeps them to the Lobby. */}
      {state.listenerStatusCounts && (
        <div class="listener-tiles">
          {TILES.map(([word, label]) => (
            <div key={word} class={`listener-tile listener-tile-${word}`}>
              <span class="listener-tile-count">{state.listenerStatusCounts![word].toLocaleString()}</span>{" "}
              <span class="listener-tile-word">{label}</span>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 6: The profile card.** In `src/web/src/components/ProfileCard.tsx`, change the import to `import type { ListenerStatus, Participant, Profile } from "@loom/client";`, the signature to `export function ProfileCard({ participant, now, status }: { participant: Participant; now?: number; status?: ListenerStatus }) {`, and after the `profile-seen` line add:

```tsx
      {/* The directory row hands its status down (spec 2026-09-27 §6.5); without it, as before. */}
      {status && <span class={`listener-status listener-status-${status}`}>{status}</span>}
```

In `src/web/src/components/listeners/ListenersPage.tsx`, change `<ProfileCard participant={{ ...p, capabilities: profile }} now={now} />` to `<ProfileCard participant={{ ...p, capabilities: profile }} now={now} status={l.status} />`, and directly after the `useEffect(() => { run(view); }, [view, session]);` line add:

```tsx
  // Spec 2026-09-27 §6.6: becoming visible re-runs the view on screen, the first page with facets as
  // "Reload the list" asks, rows kept until the answer. Pages Show more appended are replaced by it.
  useEffect(() => session.onVisible(() => { if (live.current) run(viewRef.current); }), [session]);
```

- [ ] **Step 7: The acceptance line.** In `src/web/src/components/RequestsPanel.tsx`, change `import { modelSpecs } from "./ProfileCard.js";` to `import { modelSpecs, seenText } from "./ProfileCard.js";` and replace the acceptance `<li>`'s content line pair

```tsx
              <span>{name(a.participantId)}</span> <span class="acceptance-due">due {a.dueAt ?? "-"}</span>{" "}
              <span class="badge">{acceptanceState(a, nowMs)}</span>
```

with

```tsx
              <span>{name(a.participantId)}</span> <span class="acceptance-due">due {a.dueAt ?? "-"}</span>{" "}
              <span class="badge">{acceptanceState(a, nowMs)}</span>{" "}
              {/* The badge is the acceptance's state; these two are the listener's (spec 2026-09-27 §6.5). */}
              <span class="acceptance-seen">{seenText(a.lastSeenAt, nowMs)}</span>{" "}
              <span class={`listener-status listener-status-${a.listenerStatus}`}>{a.listenerStatus}</span>
```

- [ ] **Step 8: The known ripple.** In `src/web/test/components.test.tsx`, "the panel shows a working request's acceptances with due, completed, removed and overdue": each of the four expected lines gains ` never seen idle` at its end (the fixture's `lastSeenAt: null` and `listenerStatus: "idle"`), and nothing else:

```ts
      "Helper due 2026-09-16T14:30:00.000Z completed never seen idle",
      "Other due 2026-09-16T14:30:00.000Z removed never seen idle",
      "Fourth due 2026-09-16T13:00:00.000Z overdue never seen idle",
      "Fifth due 2026-09-16T14:30:00.000Z working never seen idle",
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run test/session.test.ts test/listeners-page.test.tsx test/components.test.tsx`
Expected: PASS, all three files.

- [ ] **Step 10: Typecheck and run web**

Run: `pnpm --filter @loom/web typecheck && cd src/web && npx vitest run`
Expected: all green, pristine. `git diff --stat HEAD -- src/web/src/styles.css` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/web/src/session.ts src/web/src/components/ListenersLink.tsx src/web/src/components/ProfileCard.tsx src/web/src/components/RequestsPanel.tsx src/web/src/components/listeners/ListenersPage.tsx src/web/test/session.test.ts src/web/test/listeners-page.test.tsx src/web/test/components.test.tsx
git diff --cached --stat
git commit -m "feat(web): sidebar status tiles, status on the profile card and acceptances, refresh on visible" -m "The session keeps statusCounts from its count read beside listenerCount and re-reads it when the tab becomes visible; the directory re-runs its view then. The card and each acceptance show the listener's status word; the acceptance also its last seen. Repaired: components 'the panel shows a working request's acceptances with due, completed, removed and overdue' (seen and status added); the Session fixture gains onVisible." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: docs, the manual check, and the totals

Spec §7, §9.6, §12. **This task carries spec §9.6 (written into TESTING.md here as smoke test 9; run by Paw after the deploy).**

**Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`, `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `docs/superpowers/specs/v2-notes.md`.

**Interfaces:** consumes the names of Tasks 1 to 6; produces no code.

- [ ] **Step 1: ARCHITECTURE.md.** In the §3 rule table, replace the `| Liveness | … |` row with:

```markdown
| Liveness | `actors.ts`: `stampSeen`, called from `resolveCredential` and `resolveInWeave`; at most once per 10 s per participant, no event, no lock. The same statement appends the stamp to `participants.seen_history`, the last 20 |
```

and after the "Read positions" row add:

```markdown
| Listener status, current work and cadence | `lobby/status.ts`: `listenerStatus` (TypeScript, what a row carries) and `statusSql` (SQL, what the directory's status filter and counts read), asserted to agree in `status.test.ts`; `workFor`, `currentWorkOf`, `cadenceOf`, `listenerFacts`. Computed at read time, never stored, never an event |
```

In the §4 table's `participants` row, replace the text

```markdown
and `last_seen_at` (liveness).
```

with

```markdown
`last_seen_at` (liveness) and `seen_history` (the last 20 check-ins, oldest first; never returned, only summarised).
```

After the paragraph that begins "Migration 0006 creates `read_positions`" add:

```markdown
Migration 0007 adds `participants.seen_history` (`timestamptz[]`, nullable) and nothing else;
nothing is backfilled. A **check-in** is a stamp that writes: the throttled `stampSeen` update sets
`last_seen_at` and appends the same moment to `seen_history`, cut to the last 20, in one statement,
so the history's last element always equals `last_seen_at`. A Lobby listener's **status** (working,
idle or offline), its **current work** (the soonest due request it holds accepted work on) and its
**cadence** (the median and longest gap of those 20) are computed at read time in
`lobby/status.ts`, never stored and never an event: a status is true as of the read that computed
it, and time alone moves a listener to offline.
```

- [ ] **Step 2: SECURITY.md.** In §4a, directly after the paragraph that begins "**The directory makes those profiles searchable.**", add:

```markdown
**Status, current work and cadence summarise what a Lobby reader already sees.** Each directory
row and each `find_agents` result carries a listener's status (working, idle or offline), its current
work and its cadence (the median and longest gap between its last 20 check-ins), and each acceptance
of a request its status. They reach exactly the callers who read the directory and `find_agents`
today (Lobby participants, holders of the Lobby secret, instance keepers), and they are computed from
what those callers could already read: `lastSeenAt`, and the requests and acceptances `list_requests`
shows every Lobby reader. The raw check-in history (`participants.seen_history`) is never returned by
any read. Current work names the request, its title and its Lobby Thread only, never the target
Weave's Thread, name or title. For a keyed agent the check-ins include its calls in other Weaves, so a
Lobby reader can tell the agent was active somewhere, never where; `lastSeenAt` already said as much.
The status filter is validated in core against three fixed words and travels as a bind parameter.
```

- [ ] **Step 3: README.md.** Run `grep -n "filter by model, tools, runtime and serving policy" README.md`. It prints one line (the Lobby paragraph). In that line replace

```markdown
filter by model, tools, runtime and serving policy with a count beside every choice, sort, and a
```

with

```markdown
filter by model, tools, runtime and serving policy with a count beside every choice, pick the
working, idle or offline ones (the `status` key of the listeners `filter`, as in
`?filter={"status":["idle"]}`), sort, and a
```

Nothing else in the README lists the listeners query or its REST surface.

- [ ] **Step 4: KNOWN-ISSUES.md.** Append to the `## core` table:

```markdown
| [actors.ts](../src/core/src/actors.ts) | A keyed agent's **participant-token** call in another Weave does not check in its Lobby listing; only its agent-key calls do, in any Weave | spec 2026-09-27 §4.1: a keyed agent calls with its key, and extending the token path would put a join on every token call for a case no client produces | stamp the Lobby participant of `participants.agent_id` from the token path too |
| [lobby/status.ts](../src/core/src/lobby/status.ts) | The working lookup, the status filter and the status counts read `request_offers` by `participant_id`, which has no index | spec 2026-09-27 §10: a few rows per request at this instance's scale, and the planner's hashed semi-join is cheap | a partial index on `request_offers(participant_id)` over accepted, not removed, not completed rows |
| [actors.ts](../src/core/src/actors.ts) | `seen_history` starts empty at the deploy of migration 0007, so every listener reads "rate unknown" until it has checked in twice | spec 2026-09-27 §3: seeding it from `last_seen_at` would enter a possibly days-old moment as a false longest gap | none needed: it fills within two polls |
```

Append to the `## web` table:

```markdown
| [components/listeners/ListenersPage.tsx](../src/web/src/components/listeners/ListenersPage.tsx) | Statuses, counts and rates are as of the read that carried them: a tab left visible and untouched shows its last read until something triggers another, and time alone (which no event reports) moves a listener to offline | spec 2026-09-27 §6.6, §11: no push and no timer, by choice | re-read on an interval while visible, or push status changes |
```

- [ ] **Step 5: v2-notes.md.** In "Web redesign from the design session", replace the bullet

```markdown
- Listener work status (working / idle / offline) and the sidebar's three stat tiles: the server
  knows `lastSeenAt` and accepted work, but exposes no status word.
```

with

```markdown
- Listener work status (working / idle / offline) and the sidebar's three stat tiles: **built** by
  the listener-status slice ([spec](2026-09-27-loom-listener-status-design.md),
  [plan](../plans/2026-09-27-loom-listener-status.md)).
```

In "A Listener heartbeat, and removing inactive Listeners", replace the last paragraph (`Not started. It meets the redesign's left-out …`) with:

```markdown
**Built: the heartbeat, the observed cadence and the status**, by the listener-status slice
([spec](2026-09-27-loom-listener-status-design.md), [plan](../plans/2026-09-27-loom-listener-status.md)).
Paw's answer Q4 changed one point of the idea above: the heartbeat is **any authenticated call**, not
only the poll ("Listener might stop polling when doing work"), so the cadence measured is that of
check-ins. The last 20 are kept per participant; the directory and `find_agents` show the status, the
current work and the cadence beside the declared interval, and `get_request` each acceptance's
status. **Still open, the next slice:** removing or hiding inactive Listeners, with the open
questions of "Inactive Listeners leave the directory" above.
```

Directly after that section, before `### Leaving Loom, and archiving a Weave for oneself`, add:

```markdown
### Sort the directory by last seen or status (listener-status slice, 2026-09-27)

The redesign artboard (`Listeners.dc.html`) has a sort menu that includes last seen and status. The
directory sorts by name, owner and joined only; a status is computed at read time while the cursor is
keyed on stored columns, so either sort needs a cursor design of its own. Not part of the
listener-status slice (spec 2026-09-27 §11).
```

- [ ] **Step 6: TESTING.md.** "Eight things the automated suites cannot cover" becomes "Nine things the automated suites cannot cover". After smoke test 8 (after its `*Last run:*` paragraph) add:

```markdown
**9. Listener status on the live instance.** After the deploy that applies migration 0007, one step
at a time with Paw, each result reported before the next step. Wait until the ChatGPT listener has
polled at least twice after the deploy (about ten minutes on its five-minute poll).

1. Paw opens the Lobby's Listeners view at the live URL: the four tabs (All, Working, Idle, Offline)
   show counts that sum to the listener total, and the sidebar's three tiles show the same three
   numbers.
2. ChatGPT's row: "idle", a Last seen of a few minutes, and a rate text close to "every ~5 min
   (declares 5 min)". A seeded listener that never called reads "offline" and "rate unknown".
3. Paw presses Offline: only offline rows, and the URL carries the tab; a reload keeps it.
4. Claude Code opens a request ChatGPT is eligible for; ChatGPT offers; Claude Code accepts. After
   the next refresh (or switching tabs away and back), ChatGPT reads "working" with the request's
   title in Current work; pressing it opens the request's Thread.
5. ChatGPT completes: its row reads "idle" again after the next refresh.

*Last run:* not yet run.
```

In "What each package's tests cover": the core row's file count goes up by one and its text gains, at the end:

```markdown
The listener-status slice adds `status.test.ts`: the status rule as pure units (never seen, the exact twice-the-interval boundary, the 15 minute default, offline over working), `cadenceOf` (fewer than two check-ins, nineteen gaps, the even-count floor), and against Postgres what makes a listener working, `currentWork` (soonest due, the tie-break, exactly four keys, kept when offline), the property test that the status filter and `statusCounts` agree with the TypeScript rule on every boundary, the counts and facets rules, the filter's validation, and `findAgents` and `getRequest` carrying the fields; and five `liveness.test.ts` cases (the history written with `last_seen_at` and not on a throttled stamp, the last 20 kept, the agent-key rule across Weaves, another Weave's token not checking in the Lobby, no history on `PublicParticipant`); the existing migration case runs over 0007.
```

The server row gains the listeners status filter and the new fields on agents and a request; the client row the status round trip; the mcp-tools row the pass-through of the new fields and the two description sentences; the web row's file count goes up by one and its text gains `listener-status.test.ts` (the rate text and its rounding), the status tabs and the two columns in `listeners-page.test.tsx`, the tiles and the visibility re-read in `session.test.ts` and `components.test.tsx`, and the status word on the card and the acceptance.

- [ ] **Step 7: The full run and the totals**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every suite green, pristine. Then `git diff --stat origin/main -- src/cli src/claude-channel src/server/src` prints nothing (spec §5).

Rewrite TESTING.md "Current totals" from **what this run printed** (per package, tests and files, and overall), against Task 0's ledger record, naming the new files (`src/core/test/status.test.ts`, `src/web/test/listener-status.test.ts`) and where the other new cases went. Never estimate.

- [ ] **Step 8: Check the text rules, then commit**

Run, from the worktree root, a scan of every line this branch adds:

```bash
git diff origin/main -U0 | node -e "const d = String.fromCharCode(0x2014); let s = ''; process.stdin.on('data', (c) => { s += c; }).on('end', () => { const bad = s.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(d)); console.log(bad.length ? bad.join('\n') : 'no em dash added'); });"
```

Expected: exactly one line, the `find_agents` description in `src/mcp-tools/src/tools.ts`: that description is one string on one line, Task 4 appended a sentence to it, and its two characters sit in its existing, untouched sentences (left alone by the rule above). Any other line it prints is rewritten without the character before the commit.

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md README.md docs/TESTING.md docs/KNOWN-ISSUES.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git commit -m "docs: listener heartbeat and status; smoke test 9 and the totals" -m "ARCHITECTURE, SECURITY, README, KNOWN-ISSUES and v2-notes as spec 7 lists; TESTING gains smoke test 9, the coverage lines and the measured totals." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**After the merge (controller, not an implementer task):** `deploy/live-update.cmd` applies migration 0007 as it applied 0006, then both health checks (spec §12); then smoke test 9 with Paw, one step at a time.

---

## Decisions this plan makes (for the controller to confirm with Paw)

1. **One helper for the three fields.** `status.ts` also exports `StatusCounts`, `WorkItem`, `ListenerFacts`, `currentWorkOf` and `listenerFacts`, so `listListeners` and `findAgents` build `status`, `currentWork` and `cadence` through one function. `workFor` answers a `Map` holding only participants with at least one item. Reason: spec §4.8 names the module's contents, not how its two readers share them; one builder is the layering rule applied.
2. **The read's clock travels with the query.** `listeners.ts` carries `now` as `Scope = CleanQuery & { now }`, so every predicate builder reads the same `Date` without a new parameter on each function. Reason: spec §4.2's one-clock rule with the smallest diff.
3. **The status filter is `statusSql(now) = ANY($1::text[])`**, not `IN (...)`: the same meaning, one bind parameter, the shape the facet queries already use for their selections.
4. **The status counts are one CTE query**, and `listListeners` answers them on every call (spec §4.6), after which the page's work lookup runs as one more query (it needs the page's ids).
5. **The history slice is the literal `- 18`** of spec §4.1 with a comment, not a named constant.
6. **The client also exports `StatusCounts`**, beside the three types spec §5 names, because `ListenersPage.statusCounts` and the session's tiles need a name for it.
7. **The `get_request` sentence** is `Each acceptance also carries listenerStatus: the accepted agent's status now (working, idle or offline), as find_agents reports it.` Reason: spec §5 says what it must say, not its words.
8. **An acceptance the web builds from a `request.accepted` event** carries the held `listenerStatus` if there is one, else `working`, until the request read that event triggers. Reason: the client type makes the field required, and the accept has just given that listener active work.
9. **The tabs.** Pressing the selected tab does nothing (no second query). A link carrying `"status":[]` is no filter and is not reported (core reads an empty array as no filter; `searchFromView` never writes one). Each tab reads `<label> <count>` ("All 62"); the tiles read `<count> <word>` ("2 Working"), with the words capitalised.
10. **The Last seen cell** keeps its text node and adds a `div.listener-rate` after it; the two existing "a row of the table" tests are updated to the new columns and the concatenated cell text.
11. **The profile card's status word** is a sibling element directly after `.profile-seen`, so the "seen" line's own text is unchanged.
12. **The acceptance line reads**: name, due, badge, seen, status, each separated by a space.
13. **`Session.onVisible(fn)`** is how the directory hears the session's visibility source. On becoming visible the session re-reads the count when it is on the Lobby, and the directory re-runs `viewRef.current` (the view on screen, not a pending keystroke) without resetting the "list has changed" baseline.
14. **SECURITY.md §4a is prose**, so the spec's "one row" is one paragraph there.
15. **README.md** gains the `status` key in the one sentence that lists the directory's filters; the README has no REST listing of the listeners query.
16. **ARCHITECTURE's "module map"** is the §3 rule table; the Liveness row is rewritten to name the history.
17. **Test placement.** Two spec tests are each written as two cases in the same task: "the Lobby sidebar shows the three tiles once the count read answers ..." (the rendering in `listeners-page.test.tsx`, the session storing `statusCounts` in `session.test.ts`), and "becoming visible re-reads the tiles and re-runs the directory's view" (the session half in `session.test.ts`, the directory half in `components.test.tsx`). The core status tests use a requester with **no profile**, so it is no listener and each test's listeners are the whole population.
18. **`findAgents` moves to Task 2 and the web type ripple into Task 4** (see "Why eight tasks").
19. **Beyond the list:** `hands the row's status to the card it opens` (Task 6) and `an acceptance made from a request.accepted event reads working until the next request read` (Task 4), each pinning a behaviour this plan adds.

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §9.1 `listenerStatus`: `never seen is offline`, with and without a profile | 2 |
| §9.1 `exactly twice the declared interval is online; one millisecond more is offline` | 2 |
| §9.1 `the 15 minute default: seen 30 min ago is online, 30 min and 1 ms ago is offline` (no profile, no key, non-numeric) | 2 |
| §9.1 `offline wins over working` | 2 |
| §9.1 `online with work is working; online without is idle` | 2 |
| §9.1 `cadenceOf`: `fewer than two check-ins gives null gaps` | 1 |
| §9.1 `twenty check-ins give nineteen gaps` | 1 |
| §9.1 `an even number of gaps takes the floor of the mean of the two middle ones` | 1 |
| §9.1 `working needs an accepted, not removed, not completed acceptance on a request stored working` (six cases) | 2 |
| §9.1 `currentWork is the soonest due active item, with more counting the others` | 2 |
| §9.1 `currentWork carries the request's title and its Lobby Thread, and nothing of the target Weave` | 2 |
| §9.1 `an offline listener keeps its currentWork` | 2 |
| §9.1 `the status filter and the counts agree with the TypeScript rule` | 2 |
| §9.1 `statusCounts ignores the status filter and honours every other; the four facets honour it` | 2 |
| §9.1 `statusCounts is present with facets false and with limit 0` | 2 |
| §9.1 `a status filter of [] is no filter; an unknown word, a non-array and four entries are validation` | 2 |
| §9.1 `findAgents results carry status, currentWork and cadence` | 2 |
| §9.1 `getRequest acceptances carry listenerStatus`, including an offline one and one that completed this request while working on another | 3 |
| §9.1 liveness `a check-in appends to seen_history in the same write as last_seen_at, and a throttled stamp appends nothing` | 1 |
| §9.1 liveness `seen_history keeps the last 20, oldest first` | 1 |
| §9.1 liveness `an agent-key call in another Weave checks in the agent's Lobby participant` | 1 |
| §9.1 liveness `a participant token of another Weave does not check in the Lobby participant` | 1 |
| §9.1 liveness `PublicParticipant carries no seen history` | 1 |
| §9.1 the migration test covers 0007 (existing "case 9", run in Task 1 Step 8) | 1 |
| §9.2 `GET /api/lobby/listeners?filter={"status":["offline"]}` answers only offline rows, with `statusCounts`; a bad `status` is 400 | 4 |
| §9.2 `GET /api/lobby/agents` results and `GET` of one request carry the new fields | 4 |
| §9.3 `listListeners` with a status filter, `findAgents` and `getRequest` round trip the new fields | 4 |
| §9.4 `find_agents` and `get_request` return the new fields | 4 |
| §9.4 the two descriptions name them | 4 |
| §9.5 `rateText` and `durationText` (pure): the four forms, the rounding edges, no `0` | 5 |
| §9.5 `the directory shows All, Working, Idle and Offline tabs with the server's counts, All the sum` | 5 |
| §9.5 `pressing a tab queries the server with that status and marks it pressed; All sends none` | 5 |
| §9.5 `a tab's status is carried in the URL; a link with two statuses or an unknown one is reported and dropped` | 5 |
| §9.5 `Clear filters returns the tab to All` | 5 |
| §9.5 `the Status column shows each row's word; Current work shows the title and +N, and pressing it opens that Thread in the thread view` | 5 |
| §9.5 `an offline row with work shows both` | 5 |
| §9.5 `the Last seen cell shows the rate text` | 5 |
| §9.5 `the Lobby sidebar shows the three tiles once the count read answers; none before, none off the Lobby` (rendering, and `stores the count read's statusCounts for the tiles`) | 6 |
| §9.5 `a failed count read keeps the last tiles` | 6 |
| §9.5 `the profile card shows the status word beside seen` | 6 |
| §9.5 `the requests panel's acceptance shows seen and the listener status beside the acceptance badge` | 6 |
| §9.5 `becoming visible re-reads the tiles and re-runs the directory's view` (two cases: `becoming visible re-reads the tiles`, `becoming visible re-runs the directory's view: the first page, with facets`) | 6 |
| §9.6 the manual check, written into TESTING.md as smoke test 9 (run by Paw after the deploy) | 7 |

Cases this plan adds beyond the spec's list, each in the task named: `an acceptance made from a request.accepted event reads working until the next request read` (4); `hands the row's status to the card it opens` (6). Known ripples repaired, each named in its commit: `lobby-requests.test.ts` "getRequest returns acceptances with dueAt, completion, removal, computed overdue and lastSeenAt" (3); the web fixtures `listener()`, `directory()`, the columns row, `session()`, `acc()` and the requests-state snapshot acceptance (4); "carries the profile in columns, with the tools cut at three" and "says never for a listener that has not been seen, and its owner for a default serves" (5); "the panel shows a working request's acceptances with due, completed, removed and overdue" and the `Session` fixture's `onVisible` (6).
