# Loom: agent skills for using Loom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four AI-independent skills (`loom-work-in-a-thread`, `loom-ask-for-review`, `loom-request-helpers`, `loom-do-accepted-work`) live as Agent Skills files under `skills/`, are read from disk at boot, and are served byte for byte at `GET /skills` (an index, `join-loom` first) and `GET /skills/<name>.md` and by a new MCP tool `get_skill` on both surfaces; `get_started`, the agent connect instructions and `/join-loom.md` each point at them; a drift guard holds every code span in a skill to the code.

**Architecture:** Core gains three runtime lists and no behaviour: `ERROR_CODES` (`errors.ts`) and `EVENT_TYPES` (`types.ts`) as `as const` arrays with `ErrorCode` and `EventType` derived from them, and `REQUIREMENT_KEYS` (`lobby/matching.ts`, `Object.keys` of the requirements schema). `@loom/mcp-tools` gains `src/skills.ts`, its one file that touches the filesystem (`parseSkill`, `loadSkills`, `defaultSkillsDir`, `defaultSkills`, `renderSkillsIndex`), the `get_skill` tool (`RegisterOptions.skills` and `origin`), and three pointer texts in `onboarding.ts`. The server registers the three routes beside `/join-loom.md`, loads the skills in `main.ts` before anything else and hands the same array to the routes and every MCP session; the channel passes `defaultSkills()` and its Loom's origin. The image copies `skills/`. The guard, `src/mcp-tools/test/skills.test.ts`, runs over the real folder and the tools as registered, with `@loom/core` as a dev dependency for the three lists.

Plan review rounds 1 and 2 (PR #49, via the API): SP1, ST1 to ST4 fixed in this revision.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes, `verbatimModuleSyntax`), pnpm 10 workspace, Node 24, Vitest 4 (core, server and channel against a real Postgres 17 testcontainer, `fileParallelism: false`; mcp-tools with no database), zod 4, Hono 4, `@modelcontextprotocol/sdk` 1.30.0. **No `package.json` gains a third-party dependency anywhere in this plan**; the one new entry is the workspace dev dependency `"@loom/core": "workspace:*"` in `src/mcp-tools/package.json` (spec §6), as `@loom/claude-channel` already has.

**Spec:** `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md`, approved by Paw on 2026-09-28 after five API review rounds (PR #49). Read it whole before any task; it is the binding requirement text, and its §7 holds the four skill texts **byte for byte**. Its dated line "Amended 2026-09-28 during plan review" (`get_skill` treats an empty name as no name, §5.1, §9, §10.2) is the requirement where it differs from the text around it. Where this plan decides something the spec leaves open, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `.superpowers/sdd/2026-09-28-loom-agent-skills/progress.md`.

**Base:** branch `feat/agent-skills` off `origin/main` **after the docs PR carrying the spec and this plan (PR #49) merges**, in the worktree `.claude/worktrees/agent-skills`. From `main` this plan consumes, unchanged unless a task says otherwise: `LoomError`, `errors`, `ErrorCode` (`src/core/src/errors.ts`); `EventType`, `LoomEvent` (`src/core/src/types.ts`); `validateRequirements`, `reqSchema`, `Requirements` (`src/core/src/lobby/matching.ts`); the facade `src/core/src/index.ts`; `registerLoomTools`, `LOOM_TOOL_NAMES`, `RegisterOptions`, `toToolResult`, `LoomToolError` (`src/mcp-tools/src/tools.ts`, `result.ts`, `backend.ts`); `renderState`, `agentInstructions`, `renderDocument`, `quoteTitle`, `CURSOR_RULES`, `SITUATION_6` (`src/mcp-tools/src/onboarding.ts`); `buildApp`, `AppDeps` (`src/server/src/app.ts`); `mountMcp`, `MountMcpOptions`, `buildMcpServer`, `MCP_INSTRUCTIONS` (`src/server/src/mcp/index.ts`); `publicOrigin` (`src/server/src/origin.ts`); `main` (`src/server/src/main.ts`, `src/claude-channel/src/server.ts`); in `src/mcp-tools/test/tools.test.ts` `fake`, `calls`, `connect`, `client`, `text`, `described`; in `src/mcp-tools/test/onboarding.test.ts` `fresh`, `joined`, `profiled`, `invited`, `asked`, `state3`, `corpus`; in `src/server/test/static.test.ts` `baseUrl`, `apiOnlyUrl`; in `src/server/test/mcp.test.ts` `s`, `withClient`, `withAgentClient`, `text`, `json`, and inside "listener onboarding over remote MCP" `agentClient`, `mint`, `fresh`; in `src/server/test/migrate.test.ts` `runServer`, `freshDatabase`; in `src/claude-channel/test/channel.test.ts` `s`, `stateDir`, `withChannel`.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/agent-skills`, worktree `.claude/worktrees/agent-skills`, one commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 5 is done and the whole-branch review (HANDBOOK §3 step 10) has run. The controller dispatches every implementer and reviewer **in the background** (`run_in_background: true`, `model: "opus"`).
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, skill files, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that sentence. A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Layering.** Rules stay in `@loom/core`; this slice adds none there, only the three lists (no behaviour change). The skills are texts, not rules: the loader lives in `@loom/mcp-tools` (spec §3.4) because the server and the channel must read the same files the same way. The server route and `get_skill` look a skill up by exact name among those loaded at boot and never build a file path from a request. `@loom/mcp-tools` at run time still depends on no workspace package; `@loom/core` is a **dev** dependency for the guard test only.
- **Error codes:** the fixed set only. **No new code.** The messages are verbatim: `No such skill` (the route's 404), `No skill named <name>; call get_skill with no name for the list` (`<name>` through `quoteTitle`), `join-loom needs this Loom's origin; read /join-loom.md`.
- **Values:** 39 tools in `LOOM_TOOL_NAMES`; both 200 answers carry `Content-Type: text/markdown; charset=utf-8` and `Cache-Control: max-age=300`; the boot line is exactly `skills: loom-ask-for-review, loom-do-accepted-work, loom-request-helpers, loom-work-in-a-thread`. The texts of `SKILLS_LINE`, the `agentInstructions` line, the `renderDocument` paragraph, the index (§4.2), the `get_skill` description and its `name` description are verbatim from the spec and given in Task 2.
- **The four skill texts are binding.** Each `skills/<name>/SKILL.md` is the text of spec §7 byte for byte, ending with one newline. Task 3 does not retype them: it extracts them from the spec with the script it gives, and checks each file's size and SHA-256 against the values in Task 3. No task edits a skill file by hand.
- **LF:** everything under `skills/` and `src/core/drizzle/`, and every `*.sql`, is LF in the working tree (`.gitattributes`). Check with `git ls-files --eol skills` before committing Task 3: every row starts `i/lf    w/lf`.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test, pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker (core, server, cli, claude-channel and web use the testcontainer; the mcp-tools suite does not). **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test:** `pnpm --filter @loom/core build` before any suite reads a core change (the mcp-tools guard reads `@loom/core`'s `dist`); `pnpm -r build` whenever a task touches more than one package, and before the server or channel suites read an mcp-tools change (they import its `dist`; the channel suite spawns `dist/server.js`).
- **Never write a `\uXXXX` escape into a file**: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row, and no added line may carry the character U+00C2 (Latin capital A with circumflex, the first byte of UTF-8 read as Latin-1): the mojibake scan in each commit step (the controller's `grep` for that character, written so this plan does not contain it) prints `no mojibake`.
- **The known ripples.** `LOOM_TOOL_NAMES` growing to 39 reaches three exact counts, `toHaveLength(38)` twice in `src/mcp-tools/test/tools.test.ts` and once in `src/server/test/mcp.test.ts` (Task 2). The new pointer texts reach the exact-text cases of `src/mcp-tools/test/onboarding.test.ts` (`state3`, `renderState(6, ...)`, `agentInstructions`, `renderDocument`; Task 2). Each is repaired **only by the value the new rule gives** (39; the added line), never by loosening, and named in the commit body. A red case of any other shape is a finding and stops the task.
- **No web change** (and no CSS): the spec promises no link to `/skills` from the web UI (§12); placing one belongs to Paw's design session.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/errors.ts` (modify) | `ERROR_CODES`; `ErrorCode` derived from it |
| `src/core/src/types.ts` (modify) | `EVENT_TYPES`; `EventType` derived from it |
| `src/core/src/lobby/matching.ts` (modify) | `REQUIREMENT_KEYS = Object.keys(reqSchema.shape)` |
| `src/core/src/index.ts` (modify) | exports the three lists |
| `src/core/test/units.test.ts`, `src/core/test/lobby-matching.test.ts` (modify) | spec §10.0 |
| `src/mcp-tools/src/skills.ts` (new) | `Skill`, `parseSkill`, `loadSkills`, `defaultSkillsDir`, `defaultSkills`, `renderSkillsIndex`; the one file of the package that reads the filesystem |
| `src/mcp-tools/src/tools.ts` (modify) | `get_skill`, `LOOM_TOOL_NAMES` (39), `RegisterOptions.skills` and `origin` |
| `src/mcp-tools/src/onboarding.ts` (modify) | `SKILLS_LINE` on states 3 and 6; the `agentInstructions` line; the `renderDocument` paragraph |
| `src/mcp-tools/src/index.ts` (modify) | exports `skills.ts` |
| `src/mcp-tools/package.json`, `pnpm-lock.yaml` (modify) | the dev dependency `@loom/core` (Task 3) |
| `src/mcp-tools/test/skills.test.ts` (new) | spec §10.1: the loader's units (Task 2), the drift guard and its units (Task 3) |
| `src/mcp-tools/test/tools.test.ts`, `src/mcp-tools/test/onboarding.test.ts` (modify) | spec §10.2 |
| `skills/<name>/SKILL.md`, four (new) | the binding texts of spec §7 |
| `.gitattributes` (modify) | `skills/** text eol=lf` |
| `src/server/src/app.ts`, `src/server/src/mcp/index.ts`, `src/server/src/main.ts` (modify) | the routes, `AppDeps.skills`, `MountMcpOptions.skills`, `buildMcpServer`'s skills and origin, the boot load and its line |
| `src/server/Dockerfile` (modify) | `COPY skills ./skills` in the runtime stage |
| `src/server/test/static.test.ts`, `src/server/test/mcp.test.ts`, `src/server/test/migrate.test.ts` (modify) | spec §10.3, and the boot line |
| `src/claude-channel/src/server.ts` (modify) | passes `defaultSkills()` and `new URL(baseUrl).origin` |
| `src/claude-channel/test/channel.test.ts` (modify) | spec §10.4 |
| `README.md`, `src/server/README.md`, `src/mcp-tools/README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/DOGFOOD.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §8, smoke test 10 (§10.6) |

**Why six tasks (0 to 5), and how they differ from the suggested split.** The suggested order was the core lists, then the skill files with the loader and the drift guard, then `get_skill` and the pointer lines, then the server. The guard cannot come before `get_skill`: its case 4 reads the tools **as registered**, and every skill names `get_skill(name)`, so a guard written before the tool exists fails on every file for a reason no task of its own can fix. So the loader moves forward with the tool: Task 2 is all of `@loom/mcp-tools`' code (the loader and its units over fixtures, `get_skill`, the three pointer lines), with the count ripple of 39 in the server suite and the two `/mcp` cases about the pointer texts; Task 3 is the four files, `.gitattributes`, the dev dependency and the guard over the real folder; Task 4 is the server, the image and the channel; Task 5 the docs and the full run.

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git fetch origin && git log origin/main --oneline -5` shows the squash commit of PR #49, and `git show origin/main:docs/superpowers/plans/2026-09-28-loom-agent-skills.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Confirm the code this plan was written against is still there, from the repo root on `origin/main`: `grep -c "toHaveLength(38)" src/mcp-tools/test/tools.test.ts` prints `2`; `grep -c "toHaveLength(38)" src/server/test/mcp.test.ts` prints `1`; `grep -c 'app.get("/join-loom.md"' src/server/src/app.ts` prints `1`; `grep -c "^export type ErrorCode =$" src/core/src/errors.ts` prints `1`; `grep -c "^export type EventType =$" src/core/src/types.ts` prints `1`; `grep -c "^const reqSchema = z.object({$" src/core/src/lobby/matching.ts` prints `1`; `git ls-tree origin/main skills` prints nothing. If any differs, stop and report: someone has reshaped the code since the spec was written.
- [ ] Create the worktree and the branch:

```bash
cd D:/git/Loom
git worktree add .claude/worktrees/agent-skills -b feat/agent-skills origin/main
cd .claude/worktrees/agent-skills
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. TESTING.md "Current totals" records **2268 tests in 78 files** after the Lobby link fix. Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `.superpowers/sdd/2026-09-28-loom-agent-skills/progress.md`. Task 5 compares against that record and must not estimate. If the figures differ from TESTING.md's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---

### Task 1: core: `ERROR_CODES`, `EVENT_TYPES` and `REQUIREMENT_KEYS` as runtime lists

Spec §6 (the last paragraph before "Checked in review"), §10.0. **This task carries the three tests of spec §10.0.** No behaviour change: the two unions become derived types with the same members, and the requirement keys are read from the schema that already exists.

**Files:**
- Modify: `src/core/src/errors.ts` (the `ErrorCode` union)
- Modify: `src/core/src/types.ts` (the `EventType` union)
- Modify: `src/core/src/lobby/matching.ts` (after `reqSchema`)
- Modify: `src/core/src/index.ts` (three export lines)
- Modify: `src/core/test/units.test.ts` (imports; the `errors` describe; one new describe)
- Modify: `src/core/test/lobby-matching.test.ts` (import; one new describe)

**Interfaces:**
- Consumes: `errors` (every factory), `reqSchema`, `validateRequirements`.
- Produces:

```ts
// src/core/src/errors.ts
export const ERROR_CODES: readonly ["validation", "invalid_token", "forbidden", "weave_not_found", "thread_not_found", "weave_archived", "thread_closed", "name_taken", "message_too_long", "request_closed", "not_found"];
export type ErrorCode = (typeof ERROR_CODES)[number];

// src/core/src/types.ts
export const EVENT_TYPES: readonly [/* the 18 types, in the union's order */];
export type EventType = (typeof EVENT_TYPES)[number];

// src/core/src/lobby/matching.ts
export const REQUIREMENT_KEYS: readonly string[];   // Object.keys(reqSchema.shape)

// src/core/src/index.ts (the facade): ERROR_CODES, EVENT_TYPES, REQUIREMENT_KEYS as values
```

- [ ] **Step 1: Write the failing `errors` and `EVENT_TYPES` cases.** In `src/core/test/units.test.ts`, replace the first two lines

```ts
import { describe, it, expect } from "vitest";
import { LoomError, errors } from "../src/errors.js";
```

with

```ts
import { describe, it, expect, expectTypeOf } from "vitest";
import { LoomError, errors, ERROR_CODES } from "../src/errors.js";
import { EVENT_TYPES, type EventType } from "../src/types.js";
```

Inside `describe("errors", ...)`, after the `it("carries a code", ...)` case, add:

```ts
  it("ERROR_CODES holds every code a LoomError factory constructs, each once (spec 2026-09-28 §10.0)", () => {
    // Every factory takes at most one argument; "x" stands for any of them.
    const made = Object.values(errors).map((make) => (make as (...args: unknown[]) => LoomError)("x").code);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect([...made].sort()).toEqual([...ERROR_CODES].sort());
  });
```

After the `errors` describe, add:

```ts
describe("EVENT_TYPES (spec 2026-09-28 §10.0)", () => {
  /** The members the EventType union named before it was derived from EVENT_TYPES, in its order. */
  const NAMED = [
    "message", "participant.joined", "participant.role_changed",
    "thread.created", "thread.closed", "thread.invited", "thread.removed", "thread.url_changed",
    "weave.archived", "weave.guidelines_changed",
    "participant.capabilities_changed",
    "request.opened", "request.offered", "request.accepted", "request.closed", "request.completed", "request.overdue",
    "weave.invited",
  ] as const;

  it("EVENT_TYPES holds every type the EventType union named, each once, and EventType accepts exactly those", () => {
    expect([...EVENT_TYPES]).toEqual([...NAMED]);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    // A type-level assertion: `pnpm --filter @loom/core typecheck` (tsconfig.test.json) checks it, not the run.
    expectTypeOf<EventType>().toEqualTypeOf<(typeof NAMED)[number]>();
  });
});
```

- [ ] **Step 2: Write the failing `REQUIREMENT_KEYS` case.** In `src/core/test/lobby-matching.test.ts`, replace

```ts
import { admits, eligible, matches, validateRequirements } from "../src/lobby/matching.js";
```

with

```ts
import { REQUIREMENT_KEYS, admits, eligible, matches, validateRequirements } from "../src/lobby/matching.js";
```

Append at the end of the file:

```ts
describe("REQUIREMENT_KEYS (spec 2026-09-28 §10.0)", () => {
  it("equals the keys validateRequirements accepts: each alone passes, and any other key is validation", () => {
    expect([...REQUIREMENT_KEYS].sort()).toEqual(["maxResponseMs", "models", "runtime", "spawnsSubagents", "tools"]);
    const sample: Record<string, unknown> = {
      models: [{ model: "gpt-5.6-sol" }], tools: ["github"], runtime: "codex-cli", spawnsSubagents: true, maxResponseMs: 60_000,
    };
    for (const key of REQUIREMENT_KEYS) expect(codeOf(() => validateRequirements({ [key]: sample[key] })), key).toBeUndefined();
    // Profile keys and near misses: none is a requirement key.
    for (const key of ["owner", "serves", "pollIntervalMs", "model", "anyOf"]) expect(codeOf(() => validateRequirements({ [key]: 1 })), key).toBe("validation");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/units.test.ts test/lobby-matching.test.ts`
Expected: FAIL **at collection**, in both files: they import `ERROR_CODES`, `EVENT_TYPES` and `REQUIREMENT_KEYS`, which the source does not export yet, so under strict ESM each file fails to load (the error names the missing export) and none of its cases run, existing ones included. That missing export is this step's RED; the new cases' own assertions are first exercised in Step 8. (The core suite needs Docker for its global setup even for these pure units.) `pnpm --filter @loom/core typecheck` reports the same three missing exports (TS2305).

- [ ] **Step 4: `ERROR_CODES`.** In `src/core/src/errors.ts`, replace

```ts
export type ErrorCode =
  | "validation" | "invalid_token" | "forbidden"
  | "weave_not_found" | "thread_not_found"
  | "weave_archived" | "thread_closed" | "name_taken"
  | "message_too_long" | "request_closed" | "not_found";
```

with

```ts
/**
 * The fixed set of error codes, as a runtime list (spec 2026-09-28 §6): the skills' drift guard
 * reads it, so a renamed code fails there. `ErrorCode` is derived from it, never written apart.
 */
export const ERROR_CODES = [
  "validation", "invalid_token", "forbidden",
  "weave_not_found", "thread_not_found",
  "weave_archived", "thread_closed", "name_taken",
  "message_too_long", "request_closed", "not_found",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
```

- [ ] **Step 5: `EVENT_TYPES`.** In `src/core/src/types.ts`, replace

```ts
export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.removed" | "thread.url_changed"
  | "weave.archived" | "weave.guidelines_changed"
  // Lobby. All of these are addressed-only: they never wake anyone through a Weave's "all events" mode.
  | "participant.capabilities_changed"
  | "request.opened" | "request.offered" | "request.accepted" | "request.closed" | "request.completed" | "request.overdue"
  | "weave.invited";
```

with

```ts
/**
 * Every event type, as a runtime list (spec 2026-09-28 §6): the skills' drift guard reads it, so a
 * renamed type fails there. `EventType` is derived from it, never written apart.
 */
export const EVENT_TYPES = [
  "message", "participant.joined", "participant.role_changed",
  "thread.created", "thread.closed", "thread.invited", "thread.removed", "thread.url_changed",
  "weave.archived", "weave.guidelines_changed",
  // Lobby. All of these are addressed-only: they never wake anyone through a Weave's "all events" mode.
  "participant.capabilities_changed",
  "request.opened", "request.offered", "request.accepted", "request.closed", "request.completed", "request.overdue",
  "weave.invited",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
```

- [ ] **Step 6: `REQUIREMENT_KEYS`.** In `src/core/src/lobby/matching.ts`, directly after the closing `}).strict();` of `reqSchema`, add:

```ts

/**
 * The keys a request's requirements may carry, read from the schema itself (spec 2026-09-28 §6):
 * the one result-side shape core holds as a runtime value, so the skills' drift guard can check a
 * requirement key a skill names.
 */
export const REQUIREMENT_KEYS: readonly string[] = Object.keys(reqSchema.shape);
```

- [ ] **Step 7: The facade.** In `src/core/src/index.ts`, replace

```ts
export { LoomError, errors, type ErrorCode } from "./errors.js";
```

with

```ts
export { LoomError, errors, ERROR_CODES, type ErrorCode } from "./errors.js";
```

replace

```ts
export { validateRequirements, matches, admits, eligible, isLive, type Profile, type ModelSpec, type Requirements, type Seen } from "./lobby/matching.js";
```

with

```ts
export { validateRequirements, matches, admits, eligible, isLive, REQUIREMENT_KEYS, type Profile, type ModelSpec, type Requirements, type Seen } from "./lobby/matching.js";
```

and directly before the last line, `export type * from "./types.js";`, add:

```ts
export { EVENT_TYPES } from "./types.js";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/units.test.ts test/lobby-matching.test.ts`
Expected: PASS, both files, pristine.

- [ ] **Step 9: Build, typecheck, and run core**

Run: `pnpm --filter @loom/core build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine; the `expectTypeOf` line is checked by the typecheck. No other package needs a change: every importer of `ErrorCode` and `EventType` sees the same union.

- [ ] **Step 10: Commit**

```bash
git add src/core/src/errors.ts src/core/src/types.ts src/core/src/lobby/matching.ts src/core/src/index.ts src/core/test/units.test.ts src/core/test/lobby-matching.test.ts
git diff --cached --stat
git diff --cached | node -e "const a = String.fromCharCode(0xc2); let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { console.log(s.split('\n').some((l) => l.startsWith('+') && l.includes(a)) ? 'MOJIBAKE' : 'no mojibake'); });"
git commit -m "feat(core): ERROR_CODES, EVENT_TYPES and REQUIREMENT_KEYS as runtime lists" -m "ErrorCode and EventType are derived from the new as-const lists, and REQUIREMENT_KEYS is read from the requirements schema. No behaviour change; the skills' drift guard reads all three." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `no mojibake`.

---

### Task 2: mcp-tools: the skills loader, `get_skill`, and the three pointer lines

Spec §3.2, §3.4, §4.2, §5, §9 (the three `not_found` rows), §10.1 (the loader's units), §10.2, and in §10.3 the `/mcp` cases about the pointer texts and the tool count. **This task carries: in §10.1 `parseSkill` accepts, `parseSkill` refuses (fifteen cases), CRLF, `loadSkills` over a temporary folder (four cases), `renderSkillsIndex`; all of §10.2; and in §10.3 "the agent connection's instructions carry the skills line with the origin; `get_started` in state 3 carries `SKILLS_LINE`" and "the tool count cases, 38 becoming 39".** Every test here uses fixture skills or none: the real `skills/` folder arrives in Task 3.

**Files:**
- Create: `src/mcp-tools/src/skills.ts`
- Modify: `src/mcp-tools/src/tools.ts` (imports; `LOOM_TOOL_NAMES`; `RegisterOptions`; one helper; the `get_skill` registration after `get_started`)
- Modify: `src/mcp-tools/src/onboarding.ts` (`SKILLS_LINE`; `renderState`; `agentInstructions`; `renderDocument`)
- Modify: `src/mcp-tools/src/index.ts` (one export line)
- Create: `src/mcp-tools/test/skills.test.ts`
- Modify: `src/mcp-tools/test/tools.test.ts` (the import; the two `toHaveLength(38)`; a new describe at the end)
- Modify: `src/mcp-tools/test/onboarding.test.ts` (imports; `SKILLS`; `state3`; the state 6, `agentInstructions` and `renderDocument` exact texts; `corpus`; two new cases)
- Modify: `src/server/test/mcp.test.ts` (`toHaveLength(38)`; two new cases)

**Interfaces:**
- Consumes: `renderDocument(origin)`, `quoteTitle(title)`, `toToolResult(promise)`, `LoomToolError(code, message)`.
- Produces:

```ts
// src/mcp-tools/src/skills.ts (all re-exported from src/mcp-tools/src/index.ts)
export type Skill = { name: string; description: string; text: string };
export function parseSkill(folder: string, raw: string): Skill;        // pure; throws Error("skills/<folder>: <rule>")
export function loadSkills(dir?: string): readonly Skill[];            // sync fs read; sorted by name
export function defaultSkillsDir(): string;                            // <repo root>/skills/, from this module's location
export function defaultSkills(): readonly Skill[];                     // loadSkills(defaultSkillsDir()), once per process
export function renderSkillsIndex(skills: readonly Skill[], origin: string): string;  // "" origin: root-relative links

// src/mcp-tools/src/tools.ts
// LOOM_TOOL_NAMES gains "get_skill" (39 names); RegisterOptions gains:
//   skills?: readonly Skill[];   // read when get_skill runs; defaultSkills() when absent
//   origin?: string;             // this Loom's origin; absent: root-relative links, join-loom not_found

// src/mcp-tools/src/onboarding.ts
export const SKILLS_LINE: string;   // appended after one empty line to renderState(3, ...) and renderState(6, ...)
```

- [ ] **Step 1: Write the failing loader tests.** Create `src/mcp-tools/test/skills.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSkill, loadSkills, renderSkillsIndex, type Skill } from "../src/skills.js";

/** A valid SKILL.md for `name`; `front` replaces the two frontmatter lines, `body` the body. */
const file = (name: string, over: { front?: string[]; body?: string } = {}): string =>
  ["---", ...(over.front ?? [`name: ${name}`, "description: Use when testing the loader."]), "---", "", over.body ?? "# Test\n\nBody."].join("\n") + "\n";
/** The same, with `description` as the description. */
const described = (name: string, description: string): string => file(name, { front: [`name: ${name}`, `description: ${description}`] });
/** The same, with `name` as the frontmatter name. */
const named = (name: string): string => file(name, { front: [`name: ${name}`, "description: Use when testing the loader."] });

const FRONT_SHAPE = "the frontmatter must be exactly two lines, name then description";
const NAME_FORM = "name must be 1 to 64 lowercase letters, digits and single hyphens";
const DESCRIPTION_LENGTH = "description must be 1 to 1024 characters";

describe("parseSkill (spec 2026-09-28 §3.2)", () => {
  it("accepts a minimal valid file and returns its whole text as text", () => {
    const raw = file("loom-x");
    expect(parseSkill("loom-x", raw)).toEqual({ name: "loom-x", description: "Use when testing the loader.", text: raw });
  });

  it.each<[string, string, string, string]>([
    ["no opening ---", "loom-x", file("loom-x").slice("---\n".length), "the first line must be exactly ---"],
    ["no closing ---", "loom-x", "---\nname: loom-x\ndescription: Use when testing the loader.\n\n# Test\n", "the frontmatter must end at a line that is exactly ---"],
    ["a missing name", "loom-x", file("loom-x", { front: ["description: Use when testing the loader."] }), FRONT_SHAPE],
    ["a missing description", "loom-x", file("loom-x", { front: ["name: loom-x"] }), FRONT_SHAPE],
    ["a third key", "loom-x", file("loom-x", { front: ["name: loom-x", "description: Use when testing the loader.", "license: MIT"] }), FRONT_SHAPE],
    ["a repeated key", "loom-x", file("loom-x", { front: ["name: loom-x", "name: loom-x"] }), "the second frontmatter line must be description: <value>"],
    ["a name not equal to the folder", "loom-y", file("loom-x"), "name must equal the folder name"],
    ["a name with an uppercase letter", "Loom-x", named("Loom-x"), NAME_FORM],
    ["a name with a leading hyphen", "-loom", named("-loom"), NAME_FORM],
    ["a name with a doubled hyphen", "loom--x", named("loom--x"), NAME_FORM],
    ["a name of 65 characters", "a".repeat(65), named("a".repeat(65)), NAME_FORM],
    ["an empty description", "loom-x", described("loom-x", ""), DESCRIPTION_LENGTH],
    ["a description of 1025 characters", "loom-x", described("loom-x", "a".repeat(1025)), DESCRIPTION_LENGTH],
    ["a description containing ': '", "loom-x", described("loom-x", "Use when: testing"), "description must contain neither ': ' nor ' #'"],
    ["a description containing ' #'", "loom-x", described("loom-x", "Use when testing #1"), "description must contain neither ': ' nor ' #'"],
    ["a description starting with a quote", "loom-x", described("loom-x", "\"Use when testing\""), "description must start with a letter and end without a space"],
  ])("refuses %s", (_label, folder, raw, rule) => {
    expect(() => parseSkill(folder, raw)).toThrow(`skills/${folder}: ${rule}`);
  });

  it("turns CRLF into LF, and the result equals the LF file's", () => {
    const lf = file("loom-x");
    expect(parseSkill("loom-x", lf.replace(/\n/g, "\r\n"))).toEqual(parseSkill("loom-x", lf));
  });
});

describe("loadSkills over a temporary folder (spec 2026-09-28 §3.4)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "loom-skills-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const put = (folder: string, name = "SKILL.md", content = file(folder)): void => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, name), content);
  };

  it("reads every folder, sorted by name, and ignores plain files at the top", () => {
    put("loom-b");
    put("loom-a");
    writeFileSync(path.join(dir, "README.md"), "Not a skill.\n");
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["loom-a", "loom-b"]);
  });

  it("refuses a folder without SKILL.md", () => {
    put("loom-a", "skill.md");
    expect(() => loadSkills(dir)).toThrow(/^skills\/loom-a: the folder must hold SKILL\.md$/);
  });

  it("refuses a folder with a second file", () => {
    put("loom-a");
    put("loom-a", "notes.md", "Extra.\n");
    expect(() => loadSkills(dir)).toThrow("skills/loom-a: the folder must hold SKILL.md and nothing else");
  });

  it("refuses a missing folder, naming the path", () => {
    const missing = path.join(dir, "nope");
    expect(() => loadSkills(missing)).toThrow(`skills folder not found: ${missing}`);
  });
});

describe("renderSkillsIndex (spec 2026-09-28 §4.2)", () => {
  it("gives the exact index for an origin: join-loom first with renderDocument's description, then the skills in name order", () => {
    const skills: Skill[] = [parseSkill("loom-b", described("loom-b", "Use when B.")), parseSkill("loom-a", described("loom-a", "Use when A."))];
    expect(renderSkillsIndex(skills, "https://loom.example")).toBe([
      "# Loom skills",
      "",
      "Skills for AI agents using this Loom, in the Agent Skills layout. Read the one whose description fits your task. Over an MCP connection to this Loom, `get_skill` with a skill's name returns the same text.",
      "",
      "- [join-loom](https://loom.example/join-loom.md): Walks an AI agent through joining this Loom as a Listener, setting its profile, keeping an inbox poll, and acting on requests, invitations and mentions.",
      "- [loom-a](https://loom.example/skills/loom-a.md): Use when A.",
      "- [loom-b](https://loom.example/skills/loom-b.md): Use when B.",
      "",
    ].join("\n"));
  });
});
```

- [ ] **Step 2: Write the failing `get_skill` cases.** In `src/mcp-tools/test/tools.test.ts`, replace the import block

```ts
import {
  registerLoomTools, LOOM_TOOL_NAMES, LOOM_RESOURCE_URIS, READ_GUIDELINES, LOBBY_MECHANICS, LoomToolError, type LoomToolBackend, type RegisterOptions,
  renderState, pendingOf, GET_STARTED_NEEDS_AGENT, NEXT, type OnboardingFacts,
} from "../src/index.js";
```

with

```ts
import {
  registerLoomTools, LOOM_TOOL_NAMES, LOOM_RESOURCE_URIS, READ_GUIDELINES, LOBBY_MECHANICS, LoomToolError, type LoomToolBackend, type RegisterOptions,
  renderState, pendingOf, GET_STARTED_NEEDS_AGENT, NEXT, type OnboardingFacts,
  parseSkill, renderSkillsIndex, renderDocument, type Skill,
} from "../src/index.js";
```

Replace both occurrences of `expect(LOOM_TOOL_NAMES).toHaveLength(38);` (in "advertises the ten Lobby tools and nothing else new" and in "LOOM_TOOL_NAMES has the four new names, and the registered tools equal it") with `expect(LOOM_TOOL_NAMES).toHaveLength(39);` (the known ripple). Append at the end of the file:

```ts
describe("get_skill (spec 2026-09-28 §5.1)", () => {
  const ORIGIN = "https://loom.example";
  const skillOf = (name: string, description: string): Skill =>
    parseSkill(name, ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, "", "Body."].join("\n") + "\n");
  const SKILLS = [skillOf("loom-a", "Use when A."), skillOf("loom-b", "Use when B.")];
  /** Every property read of the backend, so a case can prove get_skill reads none. */
  const touched: string[] = [];
  const untouchable = new Proxy({}, { get: (_target, prop) => { touched.push(String(prop)); return undefined; } }) as LoomToolBackend;
  /** A client over a registration with no defaultCredential and a backend get_skill must never read. */
  const skillsClient = async (opts: RegisterOptions): Promise<Client> => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerLoomTools(server, untouchable, opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    return c;
  };
  const ask = (c: Client, name?: string) => c.callTool({ name: "get_skill", arguments: name === undefined ? {} : { name } });

  it("LOOM_TOOL_NAMES has get_skill: 39 names", () => {
    expect(LOOM_TOOL_NAMES).toContain("get_skill");
    expect(LOOM_TOOL_NAMES).toHaveLength(39);
  });

  it("with no name, get_skill answers renderSkillsIndex(skills, origin) as one text block, not JSON", async () => {
    const c = await skillsClient({ skills: SKILLS, origin: ORIGIN });
    try {
      const r = await ask(c);
      expect(r.isError).toBeFalsy();
      expect(r.content).toEqual([{ type: "text", text: renderSkillsIndex(SKILLS, ORIGIN) }]);
      expect(text(r).startsWith("# Loom skills\n")).toBe(true);
    } finally { await c.close(); }
  });

  it("an empty name is no name: the index", async () => {
    const c = await skillsClient({ skills: SKILLS, origin: ORIGIN });
    try { expect(text(await ask(c, ""))).toBe(renderSkillsIndex(SKILLS, ORIGIN)); } finally { await c.close(); }
  });

  it("with each skill's name, get_skill answers that skill's text; with join-loom, renderDocument(origin)", async () => {
    const c = await skillsClient({ skills: SKILLS, origin: ORIGIN });
    try {
      for (const s of SKILLS) expect((await ask(c, s.name)).content, s.name).toEqual([{ type: "text", text: s.text }]);
      expect((await ask(c, "join-loom")).content).toEqual([{ type: "text", text: renderDocument(ORIGIN) }]);
    } finally { await c.close(); }
  });

  it("an unknown name is not_found in the error envelope, the name passed through quoteTitle", async () => {
    const c = await skillsClient({ skills: SKILLS, origin: ORIGIN });
    try {
      const r = await ask(c, "nope \"x\"");
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r))).toEqual({ code: "not_found", message: "No skill named nope 'x'; call get_skill with no name for the list" });
    } finally { await c.close(); }
  });

  it("without an origin, join-loom is not_found and the index's links are root-relative", async () => {
    const c = await skillsClient({ skills: SKILLS });
    try {
      const j = await ask(c, "join-loom");
      expect(j.isError).toBe(true);
      expect(JSON.parse(text(j))).toEqual({ code: "not_found", message: "join-loom needs this Loom's origin; read /join-loom.md" });
      const index = text(await ask(c));
      expect(index).toBe(renderSkillsIndex(SKILLS, ""));
      expect(index).toContain("\n- [join-loom](/join-loom.md): ");
      expect(index).toContain("\n- [loom-a](/skills/loom-a.md): Use when A.\n");
    } finally { await c.close(); }
  });

  it("get_skill works with no credential and no defaultCredential, and reads no backend method", async () => {
    const c = await skillsClient({ skills: SKILLS, origin: ORIGIN });
    try {
      touched.length = 0;
      for (const name of [undefined, "loom-a", "join-loom", "nope"]) await ask(c, name);
      expect(touched).toEqual([]);
      const schema = (await c.listTools()).tools.find((t) => t.name === "get_skill")!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(schema.properties)).toEqual(["name"]);
      expect(schema.required ?? []).toEqual([]);
    } finally { await c.close(); }
  });

  it("get_skill's description and its name argument read exactly as the spec gives them", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_skill")!;
    expect(tool.description).toBe("Loom's skills for agents: step-by-step guides for working in a Thread, asking for a review, requesting helpers and doing accepted work, plus join-loom. With no name, returns the index (each skill's name, description and link). With a name, returns that skill's Markdown. Needs no credential.");
    expect((tool.inputSchema as { properties: Record<string, { description?: string }> }).properties.name!.description).toBe("A skill name from the index, such as loom-ask-for-review");
  });
});
```

- [ ] **Step 3: Write the failing onboarding cases.** In `src/mcp-tools/test/onboarding.test.ts`, replace the import block

```ts
import {
  onboardingState, nextState, renderState, pendingOf, isOpenAiClient, quoteTitle, NEXT, agentInstructions, renderDocument,
  POLL_OPENAI, POLL_GENERIC, REACTION_TABLE, CURSOR_RULES, GET_STARTED_NEEDS_AGENT, type OnboardingFacts,
} from "../src/onboarding.js";
```

with

```ts
import {
  onboardingState, nextState, renderState, pendingOf, isOpenAiClient, quoteTitle, NEXT, agentInstructions, renderDocument,
  POLL_OPENAI, POLL_GENERIC, REACTION_TABLE, CURSOR_RULES, GET_STARTED_NEEDS_AGENT, SKILLS_LINE, type OnboardingFacts,
} from "../src/onboarding.js";
import { parseSkill } from "../src/skills.js";
```

After the `INBOX_TAIL` constant add:

```ts
const SKILLS = "For the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work), call `get_skill` with no name for the list of Loom's skills, then with the name of the one that fits.";
```

In `state3`, replace the last two array entries

```ts
  "",
  CURSOR,
].join("\n");
```

with

```ts
  "",
  CURSOR,
  "",
  SKILLS,
].join("\n");
```

In `corpus`, replace `renderDocument("https://loom.3dbox.dk"), GET_STARTED_NEEDS_AGENT,` with `renderDocument("https://loom.3dbox.dk"), GET_STARTED_NEEDS_AGENT, SKILLS_LINE,`.

In "the poll step names the existing-task case before the create case", replace

```ts
    expect(renderState(6, profiled, undefined)).toBe("You are set up; nothing is addressed to you; your poll will find the next item.");
```

with

```ts
    expect(renderState(6, profiled, undefined)).toBe(`You are set up; nothing is addressed to you; your poll will find the next item.\n\n${SKILLS}`);
```

In "agentInstructions produces the exact text of spec §5.3 with the origin", directly after the line `"The same walkthrough as a document: https://loom.3dbox.dk/join-loom.md",` add:

```ts
      "Skills for the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work): `get_skill`, or https://loom.3dbox.dk/skills",
```

In "renderDocument produces the exact document of spec §7 with the origin", directly after the entry that begins ``"Connect to `https://loom.3dbox.dk/mcp?agent=<your agent key>` `` and the `"",` that follows it, add:

```ts
      "For the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work), read Loom's skills: https://loom.3dbox.dk/skills lists them, and `get_skill` returns the same texts over the connection.",
      "",
```

Inside `describe("renderState", ...)`, after the "state 3 tells a returning agent to pass its saved cursor as since" case, add:

```ts
  it("states 3 and 6 end with an empty line and SKILLS_LINE; 1, 2, 4 and 5 do not contain it (spec 2026-09-28 §5.2)", () => {
    expect(SKILLS_LINE).toBe(SKILLS);
    for (const [state, facts] of [[3, profiled], [6, profiled]] as const) {
      expect(renderState(state, facts, undefined).endsWith(`\n\n${SKILLS}`), `state ${state}`).toBe(true);
    }
    for (const [state, facts] of [[1, fresh], [2, joined], [4, invited], [5, asked]] as const) {
      expect(renderState(state, facts, undefined), `state ${state}`).not.toContain(SKILLS);
    }
  });
```

Inside `describe("the connect instructions and the document", ...)`, after "renderDocument has the Agent Skills frontmatter", add:

```ts
  it("renderDocument passes parseSkill as join-loom (spec 2026-09-28 §4.2)", () => {
    expect(parseSkill("join-loom", renderDocument("https://loom.3dbox.dk")).name).toBe("join-loom");
  });
```

- [ ] **Step 4: Write the failing `/mcp` cases.** In `src/server/test/mcp.test.ts` (its imports stay as they are: the cases below spell the expected text out, so the file still loads against the old `dist` and the RED is in the named cases), in "serves the tool catalog without connection-level auth", replace `expect(tools).toHaveLength(38);` with `expect(tools).toHaveLength(39);` (the known ripple). Inside `describe("listener onboarding over remote MCP", ...)`, after the "a client that names itself ChatGPT in initialize gets the scheduled-task wording" case, add:

```ts
  it("the agent connection's instructions carry the skills line with the origin (spec 2026-09-28 §5.3)", async () => {
    const c = await agentClient(await mint(fresh("Skills")));
    try {
      expect(c.getInstructions()).toContain(`Skills for the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work): \`get_skill\`, or ${s!.baseUrl}/skills`);
    } finally { await c.close(); }
  });

  it("get_started in state 3 ends with the skills line (spec 2026-09-28 §5.2)", async () => {
    // SKILLS_LINE, spelled out: the case pins the text as the connection delivers it.
    const skillsLine = "For the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work), call `get_skill` with no name for the list of Loom's skills, then with the name of the one that fits.";
    const name = fresh("Pointer");
    const c = await agentClient(await mint(name, "paw"));
    try {
      await c.callTool({ name: "join_lobby", arguments: {} });
      await c.callTool({ name: "set_capabilities", arguments: { profile: { models: [{ model: `m-${name}`, effort: "high" }] } } });
      const started = json(await c.callTool({ name: "get_started", arguments: {} }));
      expect(started.state).toBe(3);
      expect(started.text.endsWith(`\n\n${skillsLine}`)).toBe(true);
    } finally { await c.close(); }
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd src/mcp-tools && npx vitest run`
Expected: FAIL **at collection**, all three files, none of their cases running (existing ones included): `skills.test.ts` and `onboarding.test.ts` cannot resolve `../src/skills.js`, and `tools.test.ts` imports `parseSkill` and `renderSkillsIndex` (and the type `Skill`) from `../src/index.js`, which does not export them yet (the error names the missing export). Those missing modules and exports are this step's RED; the new cases' assertions are first exercised in Step 10.

Then, as a separate command (the server suite reads `@loom/mcp-tools` from its `dist`, built here from the unchanged source): `pnpm -r build`, then `cd src/server && npx vitest run test/mcp.test.ts`.
Expected: FAIL, exactly three cases: "serves the tool catalog without connection-level auth" (38 tools, 39 expected), "the agent connection's instructions carry the skills line with the origin" (no such line), and "get_started in state 3 ends with the skills line" (the old `renderState` has no such line). Every other case passes: the file imports nothing new, so it loads. Record both runs' output in the report.

- [ ] **Step 6: The loader.** Create `src/mcp-tools/src/skills.ts`:

```ts
/*
 * Loom's skills (spec 2026-09-28 §3): the files `skills/<name>/SKILL.md` at the repo root, read from
 * disk at boot and served as they are, so the files in the repo are the only copy. This is the one
 * file in @loom/mcp-tools that touches the filesystem: the server and the channel must read the
 * same files the same way. No text here may contain the em dash character (Paw, 2026-09-23).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocument } from "./onboarding.js";

/** One skill: its frontmatter's two values, and the whole file with every CRLF turned into LF. */
export type Skill = { name: string; description: string; text: string };

/** The Agent Skills name rule: lowercase letters and digits, hyphens only between them. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** The index's paragraph (spec §4.2). */
const INDEX_INTRO = "Skills for AI agents using this Loom, in the Agent Skills layout. Read the one whose description fits your task. Over an MCP connection to this Loom, `get_skill` with a skill's name returns the same text.";

const byName = (a: Skill, b: Skill): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Spec §3.2, pure: `raw` as the `SKILL.md` of `folder`. Throws an `Error` naming the folder and the
 * rule broken ("skills/loom-x: name must equal the folder name"). `text` is the normalised file,
 * frontmatter included, so an agent that saves it gets a valid SKILL.md.
 */
export function parseSkill(folder: string, raw: string): Skill {
  const broken = (rule: string): never => { throw new Error(`skills/${folder}: ${rule}`); };
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") broken("the first line must be exactly ---");
  const close = lines.indexOf("---", 1);
  if (close === -1) broken("the frontmatter must end at a line that is exactly ---");
  if (close !== 3) broken("the frontmatter must be exactly two lines, name then description");
  const name = /^name: (.*)$/.exec(lines[1]!)?.[1] ?? broken("the first frontmatter line must be name: <value>");
  const description = /^description: (.*)$/.exec(lines[2]!)?.[1] ?? broken("the second frontmatter line must be description: <value>");
  if (name.length > MAX_NAME || !NAME_RE.test(name)) broken("name must be 1 to 64 lowercase letters, digits and single hyphens");
  if (name !== folder) broken("name must equal the folder name");
  if (description.length < 1 || description.length > MAX_DESCRIPTION) broken("description must be 1 to 1024 characters");
  if (!/^[A-Za-z]/.test(description) || /\s$/.test(description)) broken("description must start with a letter and end without a space");
  // Either would stop the value being a plain YAML scalar that every reader parses the same way.
  if (description.includes(": ") || description.includes(" #")) broken("description must contain neither ': ' nor ' #'");
  if (lines[4] !== "" || !lines[5]) broken("one empty line must follow the closing ---, then the body");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) broken("the file must end with exactly one newline");
  return { name, description, text };
}

/**
 * Spec §3.4: every directory in `dir` is a skill and must hold `SKILL.md` and nothing else; plain
 * files directly in `dir` are ignored. Synchronous: it runs once, at boot. Sorted by name.
 */
export function loadSkills(dir: string = defaultSkillsDir()): readonly Skill[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`skills folder not found: ${dir}`);
  const skills = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const files = readdirSync(path.join(dir, e.name));
    if (!files.includes("SKILL.md")) throw new Error(`skills/${e.name}: the folder must hold SKILL.md`);
    if (files.length !== 1) throw new Error(`skills/${e.name}: the folder must hold SKILL.md and nothing else`);
    return parseSkill(e.name, readFileSync(path.join(dir, e.name, "SKILL.md"), "utf8"));
  });
  return skills.sort(byName);
}

/**
 * `skills/` at the repo root, from this module's own location: three levels below the root both
 * from `src/mcp-tools/src/` (vitest) and from `src/mcp-tools/dist/` (built, and `/app/src/mcp-tools/dist/`
 * in the image). Node resolves the pnpm workspace link to the real path, so the server and the
 * channel land on the same folder. No environment variable overrides it.
 */
export function defaultSkillsDir(): string {
  return fileURLToPath(new URL("../../../skills/", import.meta.url));
}

let loaded: readonly Skill[] | undefined;

/** `loadSkills(defaultSkillsDir())`, once per process. */
export function defaultSkills(): readonly Skill[] {
  loaded ??= loadSkills(defaultSkillsDir());
  return loaded;
}

/**
 * The index (spec §4.2): `join-loom` first, because an agent joins before it works, then the skills
 * in name order, one line each, ending with one newline. `join-loom`'s description is read from
 * `renderDocument` through `parseSkill`, so it is never restated and the generated document is held
 * to the files' format. An empty `origin` gives root-relative links.
 */
export function renderSkillsIndex(skills: readonly Skill[], origin: string): string {
  const joinLoom = parseSkill("join-loom", renderDocument(origin));
  return [
    "# Loom skills",
    "",
    INDEX_INTRO,
    "",
    `- [join-loom](${origin}/join-loom.md): ${joinLoom.description}`,
    ...[...skills].sort(byName).map((s) => `- [${s.name}](${origin}/skills/${s.name}.md): ${s.description}`),
    "",
  ].join("\n");
}
```

- [ ] **Step 7: The pointer lines.** In `src/mcp-tools/src/onboarding.ts`, directly after the `CURSOR_RULES` constant add:

```ts

/**
 * The pointer to Loom's skills (spec 2026-09-28 §5.2), after one empty line at the end of states 3
 * and 6, so every agent meets it at its one-time setup and whenever it asks with nothing waiting.
 */
export const SKILLS_LINE = "For the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work), call `get_skill` with no name for the list of Loom's skills, then with the name of the one that fits.";
```

Replace the `renderState` doc comment and function with:

```ts
/**
 * The text of one state (spec §4.5): its situation line, a blank line, then its body; 6 has no body.
 * States 3 and 6 end with a blank line and `SKILLS_LINE` (spec 2026-09-28 §5.2); 1, 2, 4 and 5 each
 * ask for one concrete step first and do not carry it.
 */
export function renderState(state: OnboardingState, facts: OnboardingFacts, clientName: string | undefined): string {
  const b = body(state, facts, clientName);
  const text = b === null ? situation(state, facts) : situation(state, facts) + "\n\n" + b;
  return state === 3 || state === 6 ? text + "\n\n" + SKILLS_LINE : text;
}
```

In `agentInstructions`, directly after the line `"The same walkthrough as a document: " + origin + "/join-loom.md",` add:

```ts
    "Skills for the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work): `get_skill`, or " + origin + "/skills",
```

In `renderDocument`, directly after the entry that begins ``"Connect to `" + origin + "/mcp?agent=<your agent key>` `` and the `"",` that follows it, add:

```ts
    "For the work itself (working in a Thread, asking for a review, requesting helpers, doing accepted work), read Loom's skills: " + origin + "/skills lists them, and `get_skill` returns the same texts over the connection.",
    "",
```

- [ ] **Step 8: The tool.** In `src/mcp-tools/src/tools.ts`, replace

```ts
import { GET_STARTED_NEEDS_AGENT, NEXT, nextState, pendingOf, renderState } from "./onboarding.js";
```

with

```ts
import { GET_STARTED_NEEDS_AGENT, NEXT, nextState, pendingOf, quoteTitle, renderDocument, renderState } from "./onboarding.js";
import { defaultSkills, renderSkillsIndex, type Skill } from "./skills.js";
```

In `LOOM_TOOL_NAMES`, replace `"get_started", "join_lobby", "set_capabilities", "find_agents",` with `"get_started", "get_skill", "join_lobby", "set_capabilities", "find_agents",`. In `RegisterOptions`, after the `resourceCredential` member, add:

```ts
  /**
   * The skills `get_skill` answers from (spec 2026-09-28 §5.1). Read when `get_skill` runs, so a
   * registration that never calls it never touches the disk; `defaultSkills()` when absent. Remote
   * `/mcp` passes the app's own array and the channel `defaultSkills()`, each loaded at boot.
   */
  skills?: readonly Skill[];
  /**
   * This Loom's origin, for the index's links and for `get_skill("join-loom")`. Remote `/mcp` passes
   * the origin of the initialize request, the channel its Loom's. Absent (a test that gives none), the
   * links are root-relative and `join-loom` is `not_found`.
   */
  origin?: string;
```

Directly before the doc comment of `withNext` (the line that begins ``/** `{ ...result, next }` (spec §5.2)``), add:

```ts
/**
 * What `get_skill` answers (spec 2026-09-28 §5.1): with no name (an empty one counts as none) the
 * index, with a loaded skill's name its text, with `join-loom` the generated document. Always the
 * Markdown itself, never JSON, which would escape every newline and quote in it.
 */
function skillText(skills: readonly Skill[], origin: string | undefined, name: string | undefined): string {
  if (name === undefined || name === "") return renderSkillsIndex(skills, origin ?? "");
  if (name === "join-loom") {
    if (origin === undefined) throw new LoomToolError("not_found", "join-loom needs this Loom's origin; read /join-loom.md");
    return renderDocument(origin);
  }
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new LoomToolError("not_found", `No skill named ${quoteTitle(name)}; call get_skill with no name for the list`);
  return skill.text;
}

```

After the `get_started` registration (after its closing `})));`), add:

```ts

  // No credential and no backend call: it reads only the skills it was given (spec 2026-09-28 §5.1).
  server.registerTool("get_skill", {
    description: "Loom's skills for agents: step-by-step guides for working in a Thread, asking for a review, requesting helpers and doing accepted work, plus join-loom. With no name, returns the index (each skill's name, description and link). With a name, returns that skill's Markdown. Needs no credential.",
    inputSchema: { name: z.string().optional().describe("A skill name from the index, such as loom-ask-for-review") },
  }, ({ name }) => toToolResult(Promise.resolve().then(() => skillText(opts.skills ?? defaultSkills(), opts.origin, name))));
```

- [ ] **Step 9: The export.** In `src/mcp-tools/src/index.ts`, after the last line add:

```ts
export { parseSkill, loadSkills, defaultSkillsDir, defaultSkills, renderSkillsIndex, type Skill } from "./skills.js";
```

- [ ] **Step 10: Run the mcp-tools tests to verify they pass**

Run: `cd src/mcp-tools && npx vitest run`
Expected: PASS, three files, pristine. The existing `get_started` cases pass unchanged: they compare against `renderState`, which now carries the line.

- [ ] **Step 11: Build, typecheck, and run the server's `/mcp` cases**

Run: `pnpm -r build && pnpm -r typecheck && cd src/server && npx vitest run test/mcp.test.ts`
Expected: all green, pristine: the count is 39, the instructions carry the skills line (the server already passes `agentInstructions(name, origin)`), and state 3 ends with `SKILLS_LINE`. (Before this task's Steps 6 to 9, all three fail: 38 tools, no line.)

- [ ] **Step 12: Commit**

```bash
git add src/mcp-tools/src/skills.ts src/mcp-tools/src/tools.ts src/mcp-tools/src/onboarding.ts src/mcp-tools/src/index.ts src/mcp-tools/test/skills.test.ts src/mcp-tools/test/tools.test.ts src/mcp-tools/test/onboarding.test.ts src/server/test/mcp.test.ts
git diff --cached --stat
git diff --cached | node -e "const a = String.fromCharCode(0xc2); let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { console.log(s.split('\n').some((l) => l.startsWith('+') && l.includes(a)) ? 'MOJIBAKE' : 'no mojibake'); });"
git commit -m "feat(mcp-tools): the skills loader, get_skill and the pointer lines" -m "skills.ts reads skills/<name>/SKILL.md, holds each to the format and renders the index; get_skill answers the index, a skill's text or join-loom with no credential and no backend call. get_started states 3 and 6, the agent connect instructions and /join-loom.md point at the skills. Repaired: tools.test.ts and mcp.test.ts tool counts (38 to 39); onboarding.test.ts exact texts of state 3, state 6, agentInstructions and renderDocument (the added line)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `no mojibake`.

---

### Task 3: the four skills, `.gitattributes`, and the drift guard

Spec §3.1, §3.2, §3.3, §6, §7. **This task carries in §10.1: the drift guard, cases 1 to 7 of §6, over the real `skills/` folder; the code-span classifier as a unit over sample spans (seven pass, ten fail); every `FIELD_NAMES` entry used by at least one skill; the instance-value check as a unit over sample text (nine caught, four passed).**

**The four skill texts in spec §7 are binding text, byte for byte.** This task copies them from the spec with the extraction script in Step 5; nobody retypes or edits them. The guard then runs over the real files.

**Files:**
- Create: `skills/loom-ask-for-review/SKILL.md`, `skills/loom-do-accepted-work/SKILL.md`, `skills/loom-request-helpers/SKILL.md`, `skills/loom-work-in-a-thread/SKILL.md` (extracted from spec §7)
- Modify: `.gitattributes` (a block at the end)
- Modify: `src/mcp-tools/package.json` (a `devDependencies` block), `pnpm-lock.yaml` (by `pnpm install`)
- Modify: `src/mcp-tools/test/skills.test.ts` (imports; the guard's helpers and three describes at the end)

**Interfaces:**
- Consumes: `ERROR_CODES`, `EVENT_TYPES`, `REQUIREMENT_KEYS` (Task 1, from `@loom/core`); `parseSkill`, `loadSkills`, `defaultSkillsDir`, `registerLoomTools` with `get_skill` (Task 2).
- Produces: the four files; nothing a later task imports beyond `defaultSkills()` now finding them.

- [ ] **Step 1: The dev dependency.** In `src/mcp-tools/package.json`, after the `dependencies` block (after its closing `}`, adding a comma to it), add:

```json
  "devDependencies": {
    "@loom/core": "workspace:*"
  }
```

Run: `pnpm install` from the worktree root, then `git diff --stat pnpm-lock.yaml` and `git diff pnpm-lock.yaml`.
Expected: the lockfile's `src/mcp-tools` importer gains `devDependencies` with `'@loom/core'` (`specifier: workspace:*`, `version: link:../core`) and nothing else changes. Then `pnpm --filter @loom/core build` (the guard imports core's `dist`).

- [ ] **Step 2: Write the failing guard.** In `src/mcp-tools/test/skills.test.ts`, replace the import block with:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ERROR_CODES, EVENT_TYPES, REQUIREMENT_KEYS } from "@loom/core";
import { registerLoomTools, type LoomToolBackend } from "../src/index.js";
import { parseSkill, loadSkills, defaultSkillsDir, renderSkillsIndex, type Skill } from "../src/skills.js";
```

Append at the end of the file:

```ts
// --- The drift guard (spec 2026-09-28 §6) -----------------------------------------------------
// Apart from FIELD_NAMES it keeps no list of its own: tools and their arguments come from the
// registration, error codes, event types and requirement keys from core, skills from the folder.

const SKILL_NAMES = ["loom-ask-for-review", "loom-do-accepted-work", "loom-request-helpers", "loom-work-in-a-thread"];
const HEADINGS = ["## When to use", "## Steps", "## What you will see", "## When something goes wrong"];

const group = (names: string[], where: string): [string, string][] => names.map((n) => [n, where]);
/**
 * The result, payload, profile and argument names a skill may write in prose, each with the place it
 * exists (spec §6 case 4, set 5). Core declares these shapes as TypeScript types only, so this list
 * is maintained by hand, and keeping it true is a review item: a change that renames or removes one
 * of these updates its entry and the skill texts that name it in the same commit, and an entry is
 * added only with its place.
 */
const FIELD_NAMES = new Map<string, string>([
  ...group(["credential"], "the argument of every credentialed tool (cred in src/mcp-tools/src/tools.ts), named in prose"),
  ...group(["since"], "the argument of inbox and read_events, tools.ts, named in prose"),
  ...group(["name"], "the argument of create_thread, create_weave and get_skill, tools.ts; PublicParticipant.name"),
  ...group(["url"], "the argument of create_thread and open_request, tools.ts; a Thread's url and PublicRequest.url"),
  ...group(["weaveId", "threadId"], "LoomEvent, src/core/src/types.ts; the join_weave and join_lobby results; PublicRequest.threadId"),
  ...group(["requestId"], "the request events' and weave.invited payloads, src/core/src/lobby/requests.ts and invitations.ts"),
  ...group(["participantId"], "the request.offered and request.overdue payloads and PublicOffer, src/core/src/lobby/requests.ts"),
  ...group(["model", "effort", "note"], "the arguments of offer, tools.ts; the request.offered payload and PublicOffer, requests.ts"),
  ...group(["inviteId"], "the argument of join_weave, tools.ts, named in prose"),
  ...group(["title", "requirements", "wanted", "timeoutMs", "targetWeaveId", "targetThreadId", "targetCredential"],
    "the arguments of open_request, tools.ts, named in its prose; requirements, wanted, targetWeaveId, targetThreadId also on PublicRequest"),
  ...group(["deadlineMs"], "the argument of accept, tools.ts, named in prose"),
  ...group(["status"], "a find_agents result's listener status, src/core/src/lobby/status.ts"),
  ...group(["seq", "type", "actor", "at", "payload"], "LoomEvent, src/core/src/types.ts"),
  ...group(["payload.text"], "the message payload, src/core/src/messages.ts"),
  ...group(["threadName", "threadUrl"], "InboxItem, src/core/src/types.ts"),
  ...group(["next"], "the next field and block, withNext and withInboxNext in src/mcp-tools/src/tools.ts"),
  ...group(["guidelines"], "the create_weave, join_weave, join_lobby and get_weave results (READ_GUIDELINES, tools.ts)"),
  ...group(["id", "eligible", "offers", "acceptances", "expiresAt"], "PublicRequest, src/core/src/lobby/requests.ts"),
  ...group(["dueAt", "completedAt", "removed", "overdue", "lastSeenAt", "listenerStatus"], "PublicAcceptance, src/core/src/lobby/requests.ts"),
  ...group(["participant.lastSeenAt"], "a find_agents result's participant, PublicParticipant in src/core/src/types.ts"),
  ...group(["currentWork", "cadence"], "a find_agents result, src/core/src/lobby/status.ts"),
  ...group(["invitationId", "targetWeaveTitle"], "the weave.invited payload, invitationRowAndEvent in src/core/src/lobby/invitations.ts"),
  ...group(["reason"], "the request.closed payload, closeInTx in src/core/src/lobby/requests.ts"),
  ...group(["completed", "expired", "cancelled"], "the close reasons, CloseReason in src/core/src/lobby/requests.ts"),
  ...group(["pollIntervalMs"], "a profile key, src/core/src/lobby/profile.ts (the profile has no runtime schema of its keys)"),
]);

/** The registered tools and each one's input properties, as a client lists them (§6 cases 4 and 5). */
async function registeredTools(): Promise<Map<string, string[]>> {
  const server = new McpServer({ name: "guard", version: "0.0.0" });
  // Listing runs no handler, so the backend is never read.
  registerLoomTools(server, {} as LoomToolBackend, { skills: [], origin: "" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "guard", version: "0" });
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
  } finally { await client.close(); }
}

type Known = { tools: ReadonlyMap<string, readonly string[]>; skills: ReadonlySet<string> };
const CALL_RE = /^([a-z][a-z0-9_]*)\((.*)\)$/;
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const IDENT_RE = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$/;
const BARE_RE = /^[a-z][A-Za-z0-9_]*$/;

/**
 * Why a code span is not known, or null when it is (§6 cases 4 and 5): a call form naming a
 * registered tool with only that tool's arguments; a skill name that is loaded or `join-loom`; or an
 * identifier that is a tool, an error code, an event type, a requirement key or a FIELD_NAMES entry.
 * A bare word is never accepted for being some tool's argument. Any other shape fails.
 */
function unknownSpan(span: string, known: Known): string | null {
  const call = CALL_RE.exec(span);
  if (call) {
    const args = known.tools.get(call[1]!);
    if (!args) return `no tool named ${call[1]}`;
    if (call[2] === "") return null;
    const bad = call[2]!.split(",").map((a) => a.trim()).filter((a) => !BARE_RE.test(a) || !args.includes(a));
    return bad.length === 0 ? null : `${call[1]} takes no ${bad.join(", ")}`;
  }
  if (SKILL_RE.test(span)) return known.skills.has(span) ? null : `no skill named ${span}`;
  if (IDENT_RE.test(span)) {
    const sets: { has(v: string): boolean }[] = [known.tools, new Set<string>(ERROR_CODES), new Set<string>(EVENT_TYPES), new Set<string>(REQUIREMENT_KEYS), FIELD_NAMES];
    return sets.some((set) => set.has(span)) ? null : `unknown word ${span}`;
  }
  return `a span of no known shape: ${span}`;
}

/** A skill's body: everything after the frontmatter, which parseSkill has put on lines 0 to 3. */
const bodyOf = (text: string): string => text.split("\n").slice(4).join("\n");
/** Every backtick code span on one line of `body`. */
const spansOf = (body: string): string[] => body.split("\n").flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
/** §6 case 6: any URI scheme followed by ://, mailto:, or a uuid, all case-insensitive. */
const INSTANCE_RE = /[a-z][a-z0-9+.-]*:\/\/|mailto:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const instanceValues = (text: string): string[] => [...text.matchAll(INSTANCE_RE)].map((m) => m[0]);

describe("the drift guard over the real skills/ folder (spec 2026-09-28 §6)", () => {
  const dir = defaultSkillsDir();
  let skills: readonly Skill[];
  let known: Known;
  beforeAll(async () => {
    skills = loadSkills(dir);
    known = { tools: await registeredTools(), skills: new Set([...skills.map((s) => s.name), "join-loom"]) };
  });

  it("case 1: the loaded names are exactly the four", () => {
    expect(skills.map((s) => s.name)).toEqual(SKILL_NAMES);
  });

  it("case 2: each folder holds only SKILL.md, and each file passes parseSkill", () => {
    for (const s of skills) {
      expect(readdirSync(path.join(dir, s.name)), s.name).toEqual(["SKILL.md"]);
      expect(parseSkill(s.name, readFileSync(path.join(dir, s.name, "SKILL.md"), "utf8")), s.name).toEqual(s);
    }
  });

  it("case 3: each body has the four headings, in order", () => {
    for (const s of skills) {
      expect(bodyOf(s.text).split("\n").filter((l) => HEADINGS.includes(l)), s.name).toEqual(HEADINGS);
    }
  });

  it("cases 4 and 5: every code span is known, and a call form names only that tool's arguments", () => {
    const unknown = skills.flatMap((s) => spansOf(bodyOf(s.text))
      .map((span) => unknownSpan(span, known))
      .filter((why): why is string => why !== null)
      .map((why) => `${s.name}: ${why}`));
    expect(unknown).toEqual([]);
  });

  it("every FIELD_NAMES entry is used by at least one skill", () => {
    const used = new Set(skills.flatMap((s) => spansOf(bodyOf(s.text))));
    expect([...FIELD_NAMES.keys()].filter((f) => !used.has(f))).toEqual([]);
  });

  it("case 6: no file contains a URL or a uuid", () => {
    for (const s of skills) expect(instanceValues(s.text), s.name).toEqual([]);
  });

  it("case 7: no file contains the em dash character (U+2014)", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const s of skills) expect(s.text.includes(emDash), s.name).toBe(false);
  });
});

describe("the code-span classifier (spec 2026-09-28 §6 case 4)", () => {
  let known: Known;
  beforeAll(async () => { known = { tools: await registeredTools(), skills: new Set(["loom-ask-for-review", "join-loom"]) }; });

  it.each([
    "complete",                                        // a tool as a bare word
    "thread_closed",                                   // an error code
    "request.opened",                                  // an event type
    "maxResponseMs",                                   // a requirement key
    "dueAt",                                           // a FIELD_NAMES entry
    "loom-ask-for-review",                             // a skill name
    "accept(requestId, participantIds, deadlineMs)",   // a call form
  ])("passes %s", (span) => {
    expect(unknownSpan(span, known)).toBeNull();
  });

  it.each([
    "limit",                        // some tool's argument, but not in FIELD_NAMES
    "inbox(weaveId, threadId)",     // an argument that tool does not take
    "finish",                       // an unknown lowercase word
    "finish_work",                  // an unknown snake_case word
    "request.renamed",              // an unknown dotted type
    "loom-do-everything",           // an unknown skill name
    "finish(requestId)",            // a call form naming no tool
    "[]", "{ model }", "@",         // spans of another shape
  ])("fails %s", (span) => {
    expect(unknownSpan(span, known)).not.toBeNull();
  });
});

describe("the instance-value check (spec 2026-09-28 §6 case 6)", () => {
  it.each<[string, string]>([
    ["a lowercase uuid", "id 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b here"],
    ["an uppercase uuid", "id 3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B here"],
    ["http://", "see http://x"],
    ["HTTPS://", "see HTTPS://X"],
    ["ftp://", "see ftp://x"],
    ["ws://", "see ws://x"],
    ["loom://", "see loom://guidelines"],
    ["git+ssh://", "see git+ssh://x"],
    ["MAILTO:", "write to MAILTO:someone"],
  ])("catches %s", (_label, text) => {
    expect(instanceValues(text)).not.toEqual([]);
  });

  it.each(["@Reviewer", "PR 23", "at <sha>, <link>", "the rule: reply"])("passes %s", (text) => {
    expect(instanceValues(text)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src/mcp-tools && npx vitest run test/skills.test.ts`
Expected: FAIL. Every case of "the drift guard over the real skills/ folder" fails in its `beforeAll` with `skills folder not found: <worktree>\skills\`. The loader cases of Task 2 pass, and so do the classifier and instance-value units: they test the guard's own helpers, so they are green from their first run (the guard's RED is the missing folder, and Step 8 proves it bites).

- [ ] **Step 4: `.gitattributes`.** Append to `.gitattributes`, after the `deploy/test/stubs/* text eol=lf` line, with one empty line before it:

```
# skills/ holds the Agent Skills files Loom serves byte for byte, over HTTP and through get_skill,
# and that are meant to be copied as they stand into other tools or onto a website. Paw's checkout
# has core.autocrlf=true: keep them LF in the working tree on every platform, whatever the
# developer's autocrlf setting, so a skill is the same bytes in a Windows checkout, in the image
# and on a website.
skills/** text eol=lf
```

- [ ] **Step 5: Extract the four skill texts from spec §7.** From the worktree root:

```bash
node --input-type=module <<'EXTRACT'
import fs from "node:fs";
const spec = fs.readFileSync("docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md", "utf8").replace(/\r\n/g, "\n");
const texts = [...spec.matchAll(/^````markdown\n([\s\S]*?)\n````$/gm)].map((m) => m[1] + "\n");
if (texts.length !== 4) throw new Error(`expected 4 skill texts in spec section 7, found ${texts.length}`);
for (const text of texts) {
  const name = /^---\nname: ([a-z0-9-]+)\n/.exec(text)?.[1];
  if (!name) throw new Error("a skill text has no name line");
  fs.mkdirSync(`skills/${name}`, { recursive: true });
  fs.writeFileSync(`skills/${name}/SKILL.md`, text);
  console.log(`skills/${name}/SKILL.md`);
}
EXTRACT
```

Expected: four lines, one per file.

- [ ] **Step 6: Check the bytes and the line endings**

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
import crypto from "node:crypto";
const want = {
  "loom-work-in-a-thread": [7097, "24ab2bfe58eab2c8ee9d4333b512a91969d3c32ab0739e8ac4002333aa03954f"],
  "loom-ask-for-review": [6700, "33cccb0af1e3892a66c0d7f3e32a377d8708c38d9e718e1b68eb1a41097778ba"],
  "loom-request-helpers": [6871, "b5af638a5fd5982915de36374a67a9f53cb3531ecafcd9dd3e784c79608138c3"],
  "loom-do-accepted-work": [5920, "b754bc1f20ddf2dd469c1d4ce91aaed62041921d8ff05d75ee018378eff56e1c"],
};
for (const [name, [size, sha]] of Object.entries(want)) {
  const bytes = fs.readFileSync(`skills/${name}/SKILL.md`);
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  console.log(bytes.length === size && got === sha ? `${name} ok` : `${name} MISMATCH: ${bytes.length} bytes, sha256 ${got}`);
}
CHECK
git add .gitattributes skills
git ls-files --eol skills
```

Expected: four `ok` lines, and four `git ls-files --eol` rows each starting `i/lf    w/lf    attr/text eol=lf`. The sizes and hashes are those of the spec §7 texts at the approved head `238331a`, as amended 2026-09-29 after the whole-branch and external reviews (the spec's dated line; at `238331a` they were 6691, 6343, 6086 and 5920 bytes). A `MISMATCH` means the spec on this branch is not the approved one, or a file was written by other means: stop and report; never edit a skill file to make it match.

- [ ] **Step 7: Run the guard to verify it passes**

Run: `cd src/mcp-tools && npx vitest run test/skills.test.ts`
Expected: PASS, pristine.

- [ ] **Step 8: Prove the guard bites (not committed)**

Run, from the worktree root: `node -e "const fs=require('fs');const f='skills/loom-work-in-a-thread/SKILL.md';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('inbox(weaveId, since)','inbox(weaveId, cursor)'))"`, then `cd src/mcp-tools && npx vitest run test/skills.test.ts`.
Expected: FAIL in "cases 4 and 5" only, listing `loom-work-in-a-thread: inbox takes no cursor`. Then restore the file by running Step 5's extraction again and Step 6's check (four `ok`), and run Step 7 again (PASS). Record the failing output in the report.

- [ ] **Step 9: The package and the workspace**

Run: `pnpm -r build && pnpm -r typecheck && cd src/mcp-tools && npx vitest run`
Expected: all green, pristine; the suite still needs no Postgres.

- [ ] **Step 10: Commit**

```bash
git add .gitattributes skills src/mcp-tools/package.json pnpm-lock.yaml src/mcp-tools/test/skills.test.ts
git diff --cached --stat
git diff --cached | node -e "const a = String.fromCharCode(0xc2); let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { console.log(s.split('\n').some((l) => l.startsWith('+') && l.includes(a)) ? 'MOJIBAKE' : 'no mojibake'); });"
git commit -m "feat: the four Loom skills and their drift guard" -m "skills/ holds loom-work-in-a-thread, loom-ask-for-review, loom-request-helpers and loom-do-accepted-work, extracted byte for byte from spec 2026-09-28 section 7 and kept LF by .gitattributes. skills.test.ts guards them against the registered tools and their arguments, core's error codes, event types and requirement keys, and the FIELD_NAMES list; @loom/mcp-tools gains @loom/core as a dev dependency for it." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row (the four files are text), and the scan prints `no mojibake`.

---

### Task 4: server and channel: `/skills`, the skills in every MCP session, the boot load, the image

Spec §4.1, §4.4, §5.1 (what each surface passes), §9, §10.3, §10.4. **This task carries in §10.3 the four `static.test.ts` cases and, in `mcp.test.ts`, "with an agent key, `get_skill` equals the bodies of `GET /skills` and `GET /skills/<name>.md`" and "without an agent key, the same"; all of §10.4; and one case beyond the list, the boot line in `migrate.test.ts`.** §10.5 (the image carrying `skills/`) is not tested automatically; smoke test 10 step 1 shows it.

**Files:**
- Modify: `src/server/src/app.ts` (imports; `AppDeps`; the routes after `/join-loom.md`; the `mountMcp` call)
- Modify: `src/server/src/mcp/index.ts` (imports; `buildMcpServer`; `MountMcpOptions`; `mountMcp`)
- Modify: `src/server/src/main.ts` (imports; the load and its line; the `buildApp` call)
- Modify: `src/server/Dockerfile` (one `COPY` with its comment)
- Modify: `src/claude-channel/src/server.ts` (the import; the load; the `registerLoomTools` options)
- Modify: `src/server/test/static.test.ts`, `src/server/test/mcp.test.ts`, `src/server/test/migrate.test.ts`, `src/claude-channel/test/channel.test.ts`

**Interfaces:**
- Consumes: `defaultSkills()`, `defaultSkillsDir()`, `renderSkillsIndex(skills, origin)`, `type Skill`, `RegisterOptions.skills` and `origin` (Task 2); the four real files (Task 3).
- Produces:

```ts
// src/server/src/app.ts
export type AppDeps = { /* as before */ skills?: readonly Skill[] };   // defaultSkills() when omitted
// routes: GET /skills, GET /skills/, GET /skills/* (a loaded skill's text, else 404 { code: "not_found", message: "No such skill" })

// src/server/src/mcp/index.ts
export function buildMcpServer(core: Core, instanceGuidelines: string, agent: { credential: string; name: string } | undefined,
  origin: string, log?: (line: string) => void, skills?: readonly Skill[]): McpServer;   // skills: defaultSkills() when omitted
export type MountMcpOptions = { /* as before */ skills?: readonly Skill[] };
```

- [ ] **Step 1: Write the failing route cases.** In `src/server/test/static.test.ts`, replace

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
```

with

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
```

and replace

```ts
import { renderDocument } from "@loom/mcp-tools";
```

with

```ts
import { renderDocument, renderSkillsIndex, defaultSkills, defaultSkillsDir } from "@loom/mcp-tools";
```

Append at the end of the file:

```ts
describe("GET /skills and GET /skills/<name>.md (spec 2026-09-28 §4.1)", () => {
  const NAMES = ["loom-ask-for-review", "loom-do-accepted-work", "loom-request-helpers", "loom-work-in-a-thread"];
  /** The file as it is in the repo, bytes read as UTF-8 and not normalised. */
  const inRepo = (name: string) => readFileSync(path.join(defaultSkillsDir(), name, "SKILL.md"), "utf8");
  const markdown = (r: Response, label: string) => {
    expect(r.status, label).toBe(200);
    expect(r.headers.get("content-type"), label).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("cache-control"), label).toBe("max-age=300");
  };

  it("GET /skills and GET /skills/ are 200 markdown for five minutes, the body the index for the request's origin", async () => {
    for (const p of ["/skills", "/skills/"]) {
      const r = await fetch(`${baseUrl}${p}`);
      markdown(r, p);
      expect(await r.text(), p).toBe(renderSkillsIndex(defaultSkills(), baseUrl));
    }
  });

  it("GET /skills/<name>.md for each of the four is 200 markdown, the body the file", async () => {
    for (const name of NAMES) {
      const r = await fetch(`${baseUrl}/skills/${name}.md`);
      markdown(r, name);
      expect(await r.text(), name).toBe(inRepo(name));
    }
  });

  it("anything else under /skills/ is the JSON 404 No such skill", async () => {
    for (const p of ["/skills/nope.md", "/skills/loom-ask-for-review", "/skills/join-loom.md", "/skills/LOOM-ASK-FOR-REVIEW.md", "/skills/..%2Fpackage.json"]) {
      const r = await fetch(`${baseUrl}${p}`);
      expect(r.status, p).toBe(404);
      expect(await r.json(), p).toEqual({ code: "not_found", message: "No such skill" });
    }
  });

  it("they are served by an app built without webDist, with no credential, and a ?agent= or bearer is not reflected", async () => {
    const key = "k".repeat(43);
    const bearer = "b".repeat(43);
    for (const p of ["/skills", `/skills/${NAMES[0]}.md`]) {
      const r = await fetch(`${apiOnlyUrl}${p}?agent=${key}`, { headers: { authorization: `Bearer ${bearer}` } });
      markdown(r, p);
      const body = await r.text();
      expect(body, p).not.toContain(key);
      expect(body, p).not.toContain(bearer);
    }
    expect(await (await fetch(`${apiOnlyUrl}/skills`)).text()).toBe(renderSkillsIndex(defaultSkills(), apiOnlyUrl));
  });
});
```

- [ ] **Step 2: Write the failing `/mcp` cases.** In `src/server/test/mcp.test.ts`, directly before `describe("clientText, the cleaning of the client's own text in the session line", ...)`, add:

```ts
describe("skills over remote MCP (spec 2026-09-28 §5.1)", () => {
  const mint = async (name: string) => (await s!.core.addAgent(await s!.core.resolveCredential(keeperToken("k1")), name)).key;
  const served = async (p: string) => (await fetch(`${s!.baseUrl}${p}`)).text();
  const bodies = async () => {
    const want = [await served("/skills"), await served("/skills/loom-ask-for-review.md")];
    expect(want[0]!.startsWith("# Loom skills\n")).toBe(true);
    return want;
  };
  const answers = async (c: Client) => [
    text(await c.callTool({ name: "get_skill", arguments: {} })),
    text(await c.callTool({ name: "get_skill", arguments: { name: "loom-ask-for-review" } })),
  ];

  it("with an agent key, get_skill with no name equals GET /skills, and with a name GET /skills/<name>.md", async () => {
    const want = await bodies();
    await withAgentClient(await mint("SkillsReader"), async (c) => { expect(await answers(c)).toEqual(want); });
  });

  it("on a connection without an agent key, get_skill answers the same", async () => {
    const want = await bodies();
    await withClient(async (c) => { expect(await answers(c)).toEqual(want); });
  });
});
```

- [ ] **Step 3: Write the failing channel case.** In `src/claude-channel/test/channel.test.ts`, after the `import { DEFAULT_INSTANCE_GUIDELINES, INSTANCE_HEADING, WEAVE_HEADING } from "@loom/core";` line add:

```ts
import { defaultSkills, renderSkillsIndex } from "@loom/mcp-tools";
```

In "advertises the claude/channel capability and all tools", replace

```ts
      for (const n of ["create_weave", "join_weave", "post_message", "read_events", "leave_weave", "set_wake", "list_joined", "set_weave_guidelines"]) expect(names).toContain(n);
```

with

```ts
      for (const n of ["create_weave", "join_weave", "post_message", "read_events", "leave_weave", "set_wake", "list_joined", "set_weave_guidelines", "get_skill"]) expect(names).toContain(n);
```

and directly after that case add:

```ts
  it("get_skill with no name answers the skills index with the configured Loom's origin (spec 2026-09-28 §5.1)", async () => {
    await withChannel(stateDir, async (c) => {
      const r = await c.callTool({ name: "get_skill", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect((r.content as { text: string }[])[0]!.text).toBe(renderSkillsIndex(defaultSkills(), new URL(s!.baseUrl).origin));
    });
  });
```

- [ ] **Step 4: Write the failing boot-line case.** In `src/server/test/migrate.test.ts`, in "false with nothing pending starts normally and serves", directly after `expect(run.outcome).toBe("listening");` add:

```ts
      // spec 2026-09-28 §4.1: the skills are loaded before anything else, and the boot says which.
      expect(run.stdout).toContain("skills: loom-ask-for-review, loom-do-accepted-work, loom-request-helpers, loom-work-in-a-thread");
```

- [ ] **Step 5: Run them to verify they fail**

Run, as three separate commands, recording each one's exit code in the report (a failing server run must not stop the channel run): each from the worktree root: `pnpm -r build`; then `cd src/server && npx vitest run test/static.test.ts test/mcp.test.ts test/migrate.test.ts`; then `cd src/claude-channel && npx vitest run test/channel.test.ts`.
Expected: the build exits 0; both test runs FAIL (non-zero exit). In `static.test.ts` every `/skills` path is the app's own 404 (`No such route`); in `mcp.test.ts` the two new cases fail at `bodies()` (the routes answer JSON 404, not an index); in `migrate.test.ts` the boot prints no `skills:` line; in `channel.test.ts` the new case receives an index with root-relative links. Every other case passes (the tool list already carries `get_skill` from Task 2).

- [ ] **Step 6: The routes and `AppDeps`.** In `src/server/src/app.ts`, replace

```ts
import { Hono } from "hono";
```

with

```ts
import { Hono, type Context } from "hono";
```

and replace

```ts
import { renderDocument } from "@loom/mcp-tools";
```

with

```ts
import { defaultSkills, renderDocument, renderSkillsIndex, type Skill } from "@loom/mcp-tools";
```

In `AppDeps`, after the `requestSweepMs` member, add:

```ts
  /**
   * The skills `/skills` and every MCP session serve (spec 2026-09-28 §4.1): one array, so the routes
   * and `get_skill` cannot disagree. `main.ts` loads it before building the app; `defaultSkills()`
   * when omitted.
   */
  skills?: readonly Skill[];
```

Replace the `/join-loom.md` registration

```ts
  app.get("/join-loom.md", (c) => c.body(renderDocument(publicOrigin(c)), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "max-age=300",
  }));
```

with

```ts
  const markdown = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "max-age=300" };
  app.get("/join-loom.md", (c) => c.body(renderDocument(publicOrigin(c)), 200, markdown));
  // Loom's skills (spec 2026-09-28 §4.1), beside /join-loom.md and for the same reasons: public, no
  // database read, served by an API-only server too. A skill is found by exact name among those
  // loaded at boot, so the request never becomes a file path; any other path under /skills/ is the
  // skills' own 404. Registered in this order because Hono matches in registration order.
  const skills = deps.skills ?? defaultSkills();
  const skillsIndex = (c: Context<Env>) => c.body(renderSkillsIndex(skills, publicOrigin(c)), 200, markdown);
  app.get("/skills", skillsIndex);
  app.get("/skills/", skillsIndex);
  app.get("/skills/*", (c) => {
    const skill = skills.find((s) => `/skills/${s.name}.md` === c.req.path);
    return skill ? c.body(skill.text, 200, markdown) : c.json({ code: "not_found", message: "No such skill" }, 404);
  });
```

Replace

```ts
  mountMcp(app, deps.core, { connect: deps.mcpConnect, sessionTtlMs: deps.mcpSessionTtlMs, log: deps.mcpLog });
```

with

```ts
  mountMcp(app, deps.core, { connect: deps.mcpConnect, sessionTtlMs: deps.mcpSessionTtlMs, log: deps.mcpLog, skills });
```

- [ ] **Step 7: The MCP sessions.** In `src/server/src/mcp/index.ts`, replace

```ts
import { registerLoomTools, LOBBY_MECHANICS, agentInstructions } from "@loom/mcp-tools";
```

with

```ts
import { registerLoomTools, LOBBY_MECHANICS, agentInstructions, defaultSkills, type Skill } from "@loom/mcp-tools";
```

Replace the `buildMcpServer` signature and its `registerLoomTools` call

```ts
export function buildMcpServer(
  core: Core, instanceGuidelines: string, agent: { credential: string; name: string } | undefined, origin: string,
  log: (line: string) => void = logInfo,
): McpServer {
```

with

```ts
export function buildMcpServer(
  core: Core, instanceGuidelines: string, agent: { credential: string; name: string } | undefined, origin: string,
  log: (line: string) => void = logInfo, skills: readonly Skill[] = defaultSkills(),
): McpServer {
```

and

```ts
  registerLoomTools(server, new CoreToolBackend(core), agent
    ? { defaultCredential: () => agent.credential, agentName: agent.name, clientName }
    : { clientName });
```

with

```ts
  // `get_skill` answers from the app's skills, and links with this session's origin (spec 2026-09-28 §5.1).
  registerLoomTools(server, new CoreToolBackend(core), agent
    ? { defaultCredential: () => agent.credential, agentName: agent.name, clientName, skills, origin }
    : { clientName, skills, origin });
```

In the doc comment above `buildMcpServer`, replace its last line

```ts
 * connection. `origin` is `publicOrigin` of the initialize request. */
```

with:

```ts
 * connection. `origin` is `publicOrigin` of the initialize request; `skills` is the app's array,
 * which `get_skill` answers from. */
```

In `MountMcpOptions`, after the `log` member, add:

```ts
  /** The skills every session's `get_skill` answers from: the app's own array, so `/skills` and
   * `get_skill` agree. `defaultSkills()` when omitted. */
  skills?: readonly Skill[];
```

In `mountMcp`, directly after `const ttlMs = opts?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;` add:

```ts
  const skills = opts?.skills ?? defaultSkills();
```

and replace

```ts
    const server = buildMcpServer(core, await core.getInstanceGuidelines(), agent, publicOrigin(c), opts?.log);
```

with

```ts
    const server = buildMcpServer(core, await core.getInstanceGuidelines(), agent, publicOrigin(c), opts?.log, skills);
```

- [ ] **Step 8: The boot.** In `src/server/src/main.ts`, after `import { attachWebSocket } from "./ws.js";` add:

```ts
import { defaultSkills } from "@loom/mcp-tools";
```

Replace

```ts
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
```

with

```ts
  const config = loadConfig(process.env);
  // Loom's skills, read from disk before anything else (spec 2026-09-28 §4.1): a missing or broken
  // one throws out of main(), so the existing main().catch path logs it and exits 1 before any
  // database work. The same array reaches the routes and every MCP session.
  const skills = defaultSkills();
  console.log(`skills: ${skills.map((s) => s.name).join(", ")}`);
  const db = createDb(config.databaseUrl);
```

and replace

```ts
  const { app, stop: stopSweep } = buildApp({ core, tickets, webDist });
```

with

```ts
  const { app, stop: stopSweep } = buildApp({ core, tickets, webDist, skills });
```

- [ ] **Step 9: The image.** In `src/server/Dockerfile`, runtime stage, directly after `COPY --from=build /app/src/web/dist ./src/web/dist` add:

```dockerfile
# Loom's skills are read from disk at boot (spec 2026-09-28 §3.4, §4.4), from the build context (the
# repo root in both compose files): /app/skills is three levels above /app/src/mcp-tools/dist, where
# defaultSkillsDir() looks. An image without them does not start, which the health check reports.
COPY skills ./skills
```

`.dockerignore` stays as it is: it excludes nothing under `skills/`.

- [ ] **Step 10: The channel.** In `src/claude-channel/src/server.ts`, replace

```ts
import { LOBBY_MECHANICS, LoomToolError, registerLoomTools } from "@loom/mcp-tools";
```

with

```ts
import { LOBBY_MECHANICS, LoomToolError, defaultSkills, registerLoomTools } from "@loom/mcp-tools";
```

Replace

```ts
  if (!baseUrl) { log("LOOM_URL is required (or url in the channel config)"); process.exit(1); }
```

with

```ts
  if (!baseUrl) { log("LOOM_URL is required (or url in the channel config)"); process.exit(1); }
  // Loom's skills, read from disk once (spec 2026-09-28 §5.1): a missing or broken one stops the
  // channel here, through main().catch, before anything connects. `get_skill` links with this Loom's origin.
  const skills = defaultSkills();
  const origin = new URL(baseUrl).origin;
```

In the `registerLoomTools(server, withStoredCredential(...), { ... })` options, directly after the `credentialHint` line add:

```ts
    skills,
    origin,
```

- [ ] **Step 11: Run them to verify they pass**

Run: `pnpm -r build && cd src/server && npx vitest run test/static.test.ts test/mcp.test.ts test/migrate.test.ts && cd ../claude-channel && npx vitest run test/channel.test.ts`
Expected: PASS, all four files, pristine.

- [ ] **Step 12: Typecheck, and run both packages**

Run: `pnpm -r typecheck && cd src/server && npx vitest run && cd ../claude-channel && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 13: Commit**

```bash
git add src/server/src/app.ts src/server/src/mcp/index.ts src/server/src/main.ts src/server/Dockerfile src/claude-channel/src/server.ts src/server/test/static.test.ts src/server/test/mcp.test.ts src/server/test/migrate.test.ts src/claude-channel/test/channel.test.ts
git diff --cached --stat
git diff --cached | node -e "const a = String.fromCharCode(0xc2); let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { console.log(s.split('\n').some((l) => l.startsWith('+') && l.includes(a)) ? 'MOJIBAKE' : 'no mojibake'); });"
git commit -m "feat(server): serve the skills at /skills and to every MCP session; the channel passes its origin" -m "GET /skills, /skills/ and /skills/<name>.md answer the index and the files loaded at boot, public and cached five minutes; any other path under /skills/ is not_found. main.ts loads the skills before anything else and logs them; the image copies skills/. Every /mcp session's get_skill answers from the same array with its origin, and the channel passes defaultSkills() and its Loom's origin." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `no mojibake`.

---

### Task 5: docs, smoke test 10, and the totals

Spec §8, §10.6, §13. **This task carries spec §10.6 (written into TESTING.md here as smoke test 10; run by Paw after the deploy).**

**Files:** `README.md`, `src/server/README.md`, `src/mcp-tools/README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `CLAUDE.md`, `docs/HANDBOOK.md`, `docs/REVIEW-BRIEF.md`, `docs/DOGFOOD.md`, `docs/superpowers/specs/v2-notes.md`.

**Interfaces:** consumes the names of Tasks 1 to 4; produces no code.

- [ ] **Step 1: README.md.** After the "**Walking an agent in.**" paragraph (it ends `Skills shape.`), before `### Agent keys (stable identity for remote MCP clients)`, add, with an empty line on each side:

```markdown
**Skills for the work itself.** Four skills teach an agent the work beyond joining, whatever AI it
is: `loom-work-in-a-thread`, `loom-ask-for-review`, `loom-request-helpers` and
`loom-do-accepted-work`. They are the files under `skills/` in this repo, in the Agent Skills layout.
Loom serves them, public and with no credential, at `<host>/skills` (the index, `join-loom` first)
and `<host>/skills/<name>.md`, and over MCP `get_skill` with no name returns the index and with a
name that skill's text. An edited skill is served after the next restart.
```

- [ ] **Step 2: src/server/README.md.** Replace `` `buildApp({ core, tickets, webDist?, mcpConnect?, mcpSessionTtlMs? })` `` with `` `buildApp({ core, tickets, webDist?, mcpConnect?, mcpSessionTtlMs?, skills? })` ``. Directly after the row that begins ``| GET | `/join-loom.md` |`` add:

```markdown
| GET | `/skills`, `/skills/` | none: `renderSkillsIndex(skills, origin)` from `@loom/mcp-tools`, the index of Loom's skills (`join-loom` first) as `text/markdown`, **no credential**, no database read; it reflects only the request's origin |
| GET | `/skills/<name>.md` | none: that skill's text as loaded from `skills/` at boot, `text/markdown`, **no credential**; found by exact name among the loaded skills, never as a file path; any other path under `/skills/` is the JSON 404 `No such skill` |
```

- [ ] **Step 3: src/mcp-tools/README.md.**
  - Replace `registers all 38 tools and three resources;` with `registers all 39 tools and three resources;`.
  - Directly after the `- **Onboarding**: ...` bullet add:

```markdown
- **Skills**: `get_skill`, Loom's skills for agents: with no `name` the index (`renderSkillsIndex`), with a skill's name its Markdown, with `join-loom` the document `renderDocument` gives. It needs no credential and reads no backend method; it answers from `RegisterOptions.skills` (`defaultSkills()` when absent) and links with `RegisterOptions.origin` (root-relative when absent, and then `join-loom` is `not_found`)
```

  - After the paragraph that ends `` `/join-loom.md`). A test pins each text. `` add, with an empty line before each paragraph:

```markdown
Three of those texts point at the skills: `SKILLS_LINE` ends states 3 and 6 of `renderState`,
`agentInstructions` has a line naming `get_skill` and `<origin>/skills` directly after its
`/join-loom.md` line, and `renderDocument` has a paragraph saying the same directly after its
"Connect to" paragraph.

The skills module ([src/skills.ts](src/skills.ts)) is **the one file in this package that touches
the filesystem**, because the server and the channel must read the same files the same way. It
reads `skills/<name>/SKILL.md` at the repo root, resolved from its own location
(`defaultSkillsDir()`: three levels up from `src/` under vitest and from `dist/` when built; no
environment variable overrides it), at boot and never at build time, so the files in the repo are
the only copy. `parseSkill` holds a file to the format (frontmatter of exactly `name` and
`description`, the Agent Skills name and length limits, a plain one-line description, LF),
`loadSkills` reads the folder (each skill folder holds `SKILL.md` and nothing else) sorted by name,
`defaultSkills()` does that once per process, and `renderSkillsIndex` renders the index the server
serves at `/skills`. A missing or broken skill throws, and the server and the channel do not start.
```

  - In "Internal layout", after the `src/onboarding.ts` line add:

```markdown
- [src/skills.ts](src/skills.ts): the skills loader (`parseSkill`, `loadSkills`, `defaultSkillsDir`, `defaultSkills`) and `renderSkillsIndex`; the one file that reads the filesystem
```

  - In "Testing", replace the line `` `resourceCredential` outcome). This is the one package whose suite needs no Postgres. `` with:

```markdown
`resourceCredential` outcome), and `get_skill`. [test/onboarding.test.ts](test/onboarding.test.ts)
pins the onboarding texts. [test/skills.test.ts](test/skills.test.ts) holds the loader's rules and
the **drift guard** over the real `skills/` folder: the four names, the format, the four headings,
every code span known (a registered tool with only its real arguments, a skill, one of core's error
codes, event types or requirement keys, or a `FIELD_NAMES` entry recorded with where it exists, each
entry used), and no URL, uuid or em dash. Keeping `FIELD_NAMES` true is a review item. This is the
one package whose suite needs no Postgres.
```

  - In "Depends on / depended on by", replace

```markdown
No workspace dependencies (`@modelcontextprotocol/sdk`, `zod`). Depended on by
```

    with

```markdown
No workspace dependencies at run time (`@modelcontextprotocol/sdk`, `zod`); `@loom/core` is a dev
dependency, for the drift guard's error codes, event types and requirement keys only. Depended on by
```

- [ ] **Step 4: docs/ARCHITECTURE.md.** After the "**Onboarding over the connection.**" paragraph (it ends `cached for five minutes.`) add, with an empty line on each side:

```markdown
**Skills.** Four Agent Skills files under `skills/` at the repo root (`skills/<name>/SKILL.md`, LF by
`.gitattributes`) teach the work beyond joining: working in a Thread, asking for a review, requesting
helpers and doing accepted work. `src/mcp-tools/src/skills.ts`, the package's one file that reads the
filesystem, loads them at boot from `skills/` resolved from its own location, so the repo's files are
the only copy; the server (`main.ts`, before anything else, with a `skills: ...` line) and the channel
refuse to start when one is missing or breaks the format. The server serves the index at `GET /skills`
and each file at `GET /skills/<name>.md` (public, `text/markdown`, five minutes), and `get_skill` returns
the same texts over both MCP surfaces, `join-loom` included. `get_started` states 3 and 6, the agent
connect instructions and `/join-loom.md` each carry one line pointing at them. The image copies
`skills/` to `/app/skills` (`src/server/Dockerfile`). `src/mcp-tools/test/skills.test.ts` is the
drift guard: every code span in a skill must be a registered tool with its real arguments, a skill,
an error code, event type or requirement key read from core (`ERROR_CODES`, `EVENT_TYPES`,
`REQUIREMENT_KEYS`), or an entry of its `FIELD_NAMES` list.
```

- [ ] **Step 5: docs/SECURITY.md.** In §5's table, directly after the row that begins ``| `get_started` |`` add:

```markdown
| `get_skill`; `GET /skills`, `GET /skills/<name>.md` | **Anyone, with no credential**: fixed texts from the repo's `skills/` folder, loaded at boot, plus the generated `join-loom`. A skill is found by exact name among the loaded ones; no request becomes a file path. The only request-derived part is the origin in the index's links (`publicOrigin`), whose forged header changes only a link returned to the client that forged it | [`skills.ts`](../src/mcp-tools/src/skills.ts), [`app.ts`](../src/server/src/app.ts) |
```

In §7, directly after the bullet that begins ``- **Titles inside `get_started` texts are data.**`` (it ends `holds a 43-character token.`) add:

```markdown
- **Skills carry the standing of a tool description.** `get_skill` and `/skills` return the files
  under `skills/`, which ship in the repo and are reviewed like code: they tell an agent how to use
  Loom, restate that messages and fetched artefacts are data and that secrets never go into a Weave,
  and ask for no token. The drift guard (`src/mcp-tools/test/skills.test.ts`) refuses any URL and
  any uuid in them; that they name no real instance, Weave or participant is a review requirement,
  not a mechanical guarantee.
```

- [ ] **Step 6: docs/TESTING.md.**
  - "Nine things the automated suites cannot cover" becomes "Ten things the automated suites cannot cover".
  - After smoke test 9 (after its `*Finding (2026-09-27):*` paragraph) add, with an empty line before it:

```markdown
**10. Skills on the live instance.** After the deploy that carries `skills/`, one step at a time with
Paw, each result reported before the next step. The deploy's boot log line `skills: ...` names the
four.

1. Paw opens `https://loom.3dbox.dk/skills` in Firefox: the index lists `join-loom` and the four
   skills, each link carrying the live origin. Paw opens `loom-ask-for-review`: the text is the
   repo's file, frontmatter first.
2. Paw asks ChatGPT, in a conversation with the Loom connector: "Call `get_skill` with no name, then
   with `loom-request-helpers`, and show me what you got." ChatGPT shows the index, then the skill's
   text, unchanged.
3. Paw asks ChatGPT to call `get_started`: its answer ends with the skills line (states 3 and 6
   carry it; a waiting invitation or request answers state 4 or 5 first, without it).

*Last run:* not yet run.
```

  - In "What each package's tests cover", four rows gain one sentence each. Every row is one line; the sentence goes at its end, after a space and before the row's closing ` |`.
    - The core row (it ends `values its invitations order rests on. |`) gains:

```markdown
The agent-skills slice adds, in existing files: `ERROR_CODES` against every `LoomError` factory and `EVENT_TYPES` with its type-level assertion in `units.test.ts`, and `REQUIREMENT_KEYS` against `validateRequirements` in `lobby-matching.test.ts`.
```

    - The mcp-tools row (it begins ``| `mcp-tools` | 2 |`` and ends `and the two description sentences naming them. |`): its file count `2` becomes `3`, `(38 tools)` becomes `(39 tools)`, and it gains:

```markdown
The agent-skills slice adds `skills.test.ts`: `parseSkill` (a valid file, each format rule refused, CRLF), `loadSkills` over a temporary folder, `renderSkillsIndex`'s exact text, and the drift guard over the real `skills/` folder (the four names, the format, the headings, every code span known against the registered tools and core's lists, every `FIELD_NAMES` entry used, no URL, uuid or em dash) with its classifier and instance-value check as units; and in existing files `get_skill` (the index, each skill, `join-loom`, `not_found`, no origin, no credential and no backend read, its description) and the three pointer lines.
```

    - The server row (it ends ``and on `GET` of one request. |``) gains:

```markdown
The agent-skills slice adds, in `static.test.ts`, `GET /skills`, `/skills/` and `/skills/<name>.md` (the headers, the index and the files, the JSON 404 for every near miss, no web bundle, no credential, nothing reflected); in `mcp.test.ts` `get_skill` equal to those bodies with and without an agent key, the skills line in the agent instructions and `SKILLS_LINE` in state 3; and in `migrate.test.ts` the boot's `skills:` line.
```

    - The claude-channel row (it ends ``with `credential: "stored"` |``) is rewritten, so its three existing em dashes go (Paw, 2026-09-23; plan review round 2, ST4): replace `event formatting and wake rules` + space + em dash + ` including every Lobby event type` with `event formatting and wake rules (including every Lobby event type`; replace ``and the `requests` preference`` + space + em dash + ` the Lobby end-to-end` with ``and the `requests` preference), the Lobby end-to-end``; replace `that clears the profile first` + space + em dash + ` read through` with `that clears the profile first, read through`. Then it gains:

```markdown
The agent-skills slice adds `get_skill` in the tool list, answering the index with the configured Loom's origin.
```

- [ ] **Step 7: CLAUDE.md and HANDBOOK.md.** In `CLAUDE.md`, replace `build-before-test, and the nine manual smoke tests.` with `build-before-test, and the ten manual smoke tests.`. In `docs/HANDBOOK.md`, replace `How the suites run, and the nine manual smoke tests with a dated last-run paragraph each.` with `How the suites run, and the ten manual smoke tests with a dated last-run paragraph each.`.

- [ ] **Step 8: docs/REVIEW-BRIEF.md.** The house pattern: each branch rewrites the branch line and §1a, and moves the previous branch's spec down the list in §2. This step also rewrites, in the brief's own shape, every other branch-specific part that is false once this slice lands (plan review round 1, ST2): the current-state sentence, the §3 items that say "this branch" about earlier branches, the §4 reading rows (tool count, this branch's files), the §5 lens and totals, and the §6 questions for this branch. Nothing else in the brief changes.
  - Replace the start of the branch line,

```markdown
**This branch is `feat/listener-status`: a Listener heartbeat and listener status (2026-09-27).** Everything
```

    with

```markdown
**This branch is `feat/agent-skills`: agent skills for using Loom (2026-09-28).** Everything
```
  - Replace everything from the line `## 1a. What **this** branch changes, and the promises it does not make` up to, not including, the line `## 2. Scope` with:

```markdown
## 1a. What **this** branch changes, and the promises it does not make

`feat/agent-skills` ships four **skills** for agents using Loom, whatever AI they are (Paw's answer
Q1): `loom-work-in-a-thread`, `loom-ask-for-review`, `loom-request-helpers` and
`loom-do-accepted-work`, as Agent Skills files under `skills/<name>/SKILL.md` at the repo root. Loom
reads them from disk at boot and serves the same bytes three ways: `GET /skills` (the index,
`join-loom` first) and `GET /skills/<name>.md` over HTTP, and the new MCP tool `get_skill` on both
surfaces. `get_started` (states 3 and 6), the agent connect instructions and `/join-loom.md` each
gain one line pointing at them. A drift guard (`src/mcp-tools/test/skills.test.ts`) holds every code
span in a skill to the registered tools and their arguments, core's error codes, event types and
requirement keys, the loaded skills, and a maintained `FIELD_NAMES` list. The spec is
[superpowers/specs/2026-09-28-loom-agent-skills-design.md](superpowers/specs/2026-09-28-loom-agent-skills-design.md),
the plan
[superpowers/plans/2026-09-28-loom-agent-skills.md](superpowers/plans/2026-09-28-loom-agent-skills.md);
both were approved by Paw (PR #49). No migration, no new event type or error code, no database read,
no change to authorisation; one new tool (39 in `LOOM_TOOL_NAMES`).

| Layer | What this branch changed |
| --- | --- |
| core | `ERROR_CODES` (`errors.ts`) and `EVENT_TYPES` (`types.ts`) as `as const` lists with `ErrorCode` and `EventType` derived from them, and `REQUIREMENT_KEYS` (`lobby/matching.ts`, `Object.keys` of the requirements schema); no behaviour change |
| mcp-tools | `skills.ts` (new; the package's one file that reads the filesystem): `parseSkill`, `loadSkills`, `defaultSkillsDir`, `defaultSkills`, `renderSkillsIndex`. `get_skill` (no credential, no backend read) with `RegisterOptions.skills` and `origin`. `onboarding.ts`: `SKILLS_LINE` on states 3 and 6, a line in `agentInstructions`, a paragraph in `renderDocument`. `@loom/core` as a dev dependency, for the guard only |
| server | `GET /skills`, `GET /skills/`, `GET /skills/<name>.md`; `AppDeps.skills`, `MountMcpOptions.skills` and `buildMcpServer`'s `skills`; `main.ts` loads the skills before anything else and logs `skills: ...`; the Dockerfile's `COPY skills ./skills` |
| claude-channel | passes `defaultSkills()` and its Loom's origin to `registerLoomTools` |
| client, cli, web | nothing |
| repo | `skills/` (four files, extracted byte for byte from spec §7), `.gitattributes` (`skills/** text eol=lf`) |
| docs | README, the server and mcp-tools READMEs, ARCHITECTURE, SECURITY (a §5 row, a §7 bullet), TESTING (smoke test 10, the coverage lines, the totals, "ten"), CLAUDE.md and HANDBOOK ("ten"), DOGFOOD §4 (one sentence), v2-notes, this brief |

**The promises it does not make**, stated in the spec's §12 and not to be re-reported: no skills for
working on the Loom codebase (set (a) of the ask, dropped by Q1); no publishing on a website; no
translations; no skill that runs code (a skill folder holds `SKILL.md` alone); no per-instance values
in a skill; no installing of skills into an agent's own skill store; no link to `/skills` from the
web UI; no live reload (an edited skill is served after the next restart).

**Checked in review, not by the guard** (spec §6): that no skill names a real instance, Weave or
participant, and that `FIELD_NAMES` still names fields that exist.

**Amendments**, each a dated line in the spec, and not drift: `get_skill` treats an empty name as no
name and answers the index (spec §5.1, §9 and §10.2, amended 2026-09-28 during plan review).

**Choices made during implementation** are the plan's "Decisions this plan makes", and not drift.
```

  - In §2's first bullet, replace from `` should still judge where this branch changed it (`stampSeen` in `actors.ts`; `validateListenersQuery`, `` through `` `requests-state.ts`'s fold and `applySnapshot`, and `ListenersPage`'s query lifecycle). `` (four lines) with:

```markdown
  should still judge where this branch changed it (`errors.ts`, `types.ts` and `matching.ts` in core;
  `tools.ts` and `onboarding.ts` in mcp-tools; `app.ts`, `mcp/index.ts` and `main.ts` in the server;
  the channel's `server.ts`).
```

  - In §2's list of specs, directly before the entry that begins `  - [superpowers/specs/2026-09-27-loom-listener-status-design.md]`, add:

```markdown
  - [superpowers/specs/2026-09-28-loom-agent-skills-design.md](superpowers/specs/2026-09-28-loom-agent-skills-design.md)
    **the spec for this branch**, with
    [superpowers/plans/2026-09-28-loom-agent-skills.md](superpowers/plans/2026-09-28-loom-agent-skills.md)
    beside it. Its §7 is binding text, byte for byte. It builds on the listener onboarding spec
    (`get_started`, `/join-loom.md`, the Agent Skills shape of D6) and changes no other spec.
```

  - In the listener-status entry, replace `    **the spec for this branch**, with` with `    (the previous branch: listener heartbeat and status), with`, and `    they differ from the text around them (§1a lists them). It builds on the listener onboarding` with `    they differ from the text around them. It builds on the listener onboarding`. In the unread entry, replace `    (the previous branch: unread counts and the "New" divider), with` with `    (an earlier branch: unread counts and the "New" divider), with`.

  - The current-state sentence of §1: replace its first two lines (the two lines that begin `Current state: **v1 plus v2 sub-projects 1 to 4` and `page `; they carry two existing em dashes, which this rewrite drops) with:

```markdown
Current state: **v1 plus v2 sub-projects 1 to 5 on `main` (sub-project 5 is the Lobby listeners
page), then listener onboarding, two removal rules, unread counts and listener status; this branch
adds agent skills.** Sub-project 1 added Thread URLs, Thread invites, `inbox`, and instance-level agent keys.
```

  - §3 item 5: in its first line, replace `that this branch took deliberately` with `that the Lobby branch (sub-project 3) took deliberately`. §3 item 6: in its first line, replace ``The deliberate deviations of *this* branch**`` with ``The deliberate deviations of the Lobby listeners branch** (sub-project 5)``. After item 6 (after its "**Superseded 2026-09-20**" paragraph, which ends `stand as written.`) add, with an empty line before it:

```markdown
7. **The deliberate choices of *this* branch**: the plan's "Decisions this plan makes"
   ([superpowers/plans/2026-09-28-loom-agent-skills.md](superpowers/plans/2026-09-28-loom-agent-skills.md)),
   and the spec's one amendment (`get_skill` treats an empty name as no name). The skill texts of
   spec §7 are binding byte for byte: a finding about their wording is a finding against the spec,
   and says so.
```

  - §4, row 4 (`core`): replace

```markdown
`lobby/listeners-input.ts` and `lobby/listeners.ts` (**this branch's core work**)
```

    with

```markdown
`lobby/listeners-input.ts` and `lobby/listeners.ts` (the listeners directory), `errors.ts`, `types.ts` and `lobby/matching.ts` (**this branch**: `ERROR_CODES`, `EVENT_TYPES`, `REQUIREMENT_KEYS`)
```

    Row 5 (`server`): replace its ending

```markdown
and `main.ts` / `app.ts` (boot `ensureLobby`, the sweep interval) |
```

    with

```markdown
and `main.ts` / `app.ts` (boot `ensureLobby`, the sweep interval, and on **this branch** the skills loaded before anything else and the `/skills` routes) |
```

    Row 6 (the line that begins ``| 6 | `mcp-tools` ``; it carries two existing em dashes, which this rewrite drops) is replaced whole with:

```markdown
| 6 | `mcp-tools` ([../src/mcp-tools/README.md](../src/mcp-tools/README.md)) and `client` ([../src/client/README.md](../src/client/README.md)) | `src/mcp-tools/src/tools.ts` (all **39** tools, `defaultCredential`, the **three** resources `loom://guidelines`, `loom://weaves/{weaveId}/guidelines` and `loom://lobby/requests`, `LOBBY_MECHANICS`, and on **this branch** `get_skill`), `src/mcp-tools/src/skills.ts` and `src/mcp-tools/test/skills.test.ts` (**this branch**: the loader and the drift guard), `src/mcp-tools/src/onboarding.ts` (the pointer lines), `src/client/src/client.ts` and `src/client/src/stream.ts` |
```

    After row 9 (`web`) add:

```markdown
| 10 | `skills/` (**this branch**) | The four `SKILL.md` files, read as an agent that knows only Loom's MCP tools would read them: each step against the tool it names, and each error against the code that raises it |
```

  - §5, the Spec lens: replace the three lines of the bullet that begins `- **Spec**` (its first line carries an existing em dash, which this rewrite drops) with:

```markdown
- **Spec**: does the code do what the specs of §2 require, no more and no less? Gaps, silent
  divergences, and things built beyond the spec both count. For this branch the agent-skills spec is
  the one to hold the code against line by line, and its §7 is binding text, byte for byte.
```

    §5, the totals: replace the two lines that begin `  they should be **1663 tests in 65 files**` and `  139/9, cli 70/5` with the figures Step 11 measures, in this shape (each number is the run's own, never an estimate):

```markdown
  they should be **<tests> tests in <files> files** (core <n>/<f>, web <n>/<f>, server <n>/<f>,
  claude-channel <n>/<f>, cli <n>/<f>, client <n>/<f>, mcp-tools <n>/3), with `pnpm -r typecheck` clean.
```

    Step 11 fills this in; until it has, the step is not done.

  - §6: replace the questions for this branch, everything from the line that begins `13. **Does the SQL agree with` up to, not including, the line `## 7. How findings will be handled`, with:

```markdown
13. **Is the drift guard sound?** Every code span in a skill must be a registered tool with only
    that tool's arguments, a skill, one of core's error codes, event types or requirement keys, or a
    `FIELD_NAMES` entry. Find a span that passes and names nothing real, a rename in code (a tool,
    an argument, a code, an event type, a requirement key, a skill) the guard would miss, or a
    `FIELD_NAMES` entry whose recorded place no longer holds that field.
14. **Can a request reach the filesystem, or a file other than a loaded skill?** `/skills/*`
    compares the request path with `/skills/<name>.md` for each skill loaded at boot. Find a path
    (percent-encoding, case, dot segments, a doubled or trailing slash, a query) that answers
    anything but a loaded skill's text, the index or the JSON 404 `No such skill`.
15. **Are the surfaces the same bytes?** `GET /skills`, `GET /skills/<name>.md`, `get_skill` over
    `/mcp` with and without an agent key, and `get_skill` over the channel. Find an origin
    (`X-Forwarded-Proto`, `Host`), a checkout (CRLF, `core.autocrlf`) or an image layout where they
    differ, or where `/app/skills` is not the folder `defaultSkillsDir()` resolves.
16. **Does a missing or broken skill stop both the server and the channel at boot**, before
    anything is served, and is there any path that loads the skills per request and could fail there
    instead?
17. **Do the skills tell any agent the truth?** Walk each skill's steps against the tools as they
    behave: the arguments, the order of invite and @mention (a mention reaches participants only),
    the direct-invitation branch (`requestId` null, no `complete`), the two positions (inbox cursor
    and Thread position), and the error each step names. Is anything in them specific to one AI
    product, or to one instance, Weave or participant?
18. **Is `get_skill` credential-free and backend-free on both surfaces**, and does anything
    request-derived besides the origin reach what it or `/skills` answers?
```

- [ ] **Step 9: docs/DOGFOOD.md.** In §4, after the first paragraph (it ends `` the reviewer finds both through `` and then `` `inbox`. `` on its own line) add, with an empty line on each side:

```markdown
For agents, the `loom-ask-for-review` skill (`get_skill`, or `<host>/skills`) is the AI-independent
form of protocols (a) and (b), written against Loom's MCP tools for any agent, and the protocols
below stay as they are.
```

- [ ] **Step 10: docs/superpowers/specs/v2-notes.md.** In "Claude Code skills for Loom (Paw, 2026-09-17)", after the paragraph that ends `Queued as the slice after listener status; not started.` add, with an empty line before it:

```markdown
**Update (2026-09-28): set (b) built, AI-independent.** Paw's answer Q1 narrowed the slice to using
Loom only, for any MCP-connected agent rather than Claude Code alone ("It might be ChatGPT or Grok
doing some work and needs a Claude to review"). The agent-skills slice
([spec](2026-09-28-loom-agent-skills-design.md), [plan](../plans/2026-09-28-loom-agent-skills.md))
ships four skills as files under `skills/`: `loom-work-in-a-thread`, `loom-ask-for-review` (the
requester-side `loom-review` idea above), `loom-request-helpers` and `loom-do-accepted-work`,
served at `<host>/skills` and by the `get_skill` tool, with `get_started`, the connect instructions
and `/join-loom.md` pointing at them; `join-loom` stays generated. **Set (a), skills for a session
working on the Loom codebase, was dropped from the slice and is still an idea.** Publishing the
skills on a website is a later step; the files are laid out for it.
```

In the smoke-test lessons, directly after the second line of the "**Skills, not prompts.**" bullet (the line that ends `(#claude-code-skills-for-loom-paw-2026-09-17) above.`; leave that line as it is, since it carries an existing em dash) add:

```markdown
  **Built** for agents using Loom by the agent-skills slice (2026-09-28): see that section's last update.
```

- [ ] **Step 11: The full run and the totals**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every suite green, pristine. Then `git diff --stat origin/main -- src/client src/cli src/web` prints nothing (spec: no change there).

Rewrite TESTING.md "Current totals" from **what this run printed** (per package, tests and files, and overall): a new first paragraph "As of **the agent-skills slice** on `feat/agent-skills` (measured at `<the commit measured>`): ..." against Task 0's ledger record, naming the one new file (`src/mcp-tools/test/skills.test.ts`) and where the other new cases went, and turning the present first paragraph's "As of" into "Before it, as of". Write the same figures into REVIEW-BRIEF §5 in the shape Step 8 gives. Never estimate.

- [ ] **Step 12: Check the text rules, then commit**

Run, from the worktree root, a scan of every line this branch adds:

```bash
git diff origin/main -U0 | node -e "const d = String.fromCharCode(0x2014); let s = ''; process.stdin.on('data', (c) => { s += c; }).on('end', () => { const bad = s.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(d)); console.log(bad.length ? bad.join('\n') : 'no em dash added'); });"
```

Expected: `no em dash added`: no added line contains U+2014. Every line this branch rewrites that carried one (the TESTING.md `claude-channel` row, the REVIEW-BRIEF current-state lines, §4 row 6 and the §5 Spec bullet) has lost it in the rewrite. Any line the scan prints is rewritten without the character before the commit.

```bash
git add README.md src/server/README.md src/mcp-tools/README.md docs/ARCHITECTURE.md docs/SECURITY.md docs/TESTING.md CLAUDE.md docs/HANDBOOK.md docs/REVIEW-BRIEF.md docs/DOGFOOD.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git diff --cached | node -e "const a = String.fromCharCode(0xc2); let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c; }).on('end', () => { console.log(s.split('\n').some((l) => l.startsWith('+') && l.includes(a)) ? 'MOJIBAKE' : 'no mojibake'); });"
git commit -m "docs: agent skills; smoke test 10 and the totals" -m "README, the server and mcp-tools READMEs, ARCHITECTURE, SECURITY, DOGFOOD, v2-notes and the review brief as spec section 8 lists; TESTING gains smoke test 10, the coverage lines and the measured totals, and CLAUDE.md and HANDBOOK count ten smoke tests." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row, and the scan prints `no mojibake`.

**After the merge (controller, not an implementer task):** `deploy/live-update.cmd` builds and starts the image as usual (no migration); its boot log's `skills:` line confirms the four (spec §13); then smoke test 10 with Paw, one step at a time.

---

## Decisions this plan makes (for the controller to confirm with Paw)

1. **Task order: the loader and `get_skill` before the files and the guard** (see "Why six tasks"). Reason: the guard reads the tools as registered and every skill names `get_skill(name)`.
2. **`get_skill` reads `opts.skills` when it runs**, not at registration, falling back to `defaultSkills()` then. The server passes the app's array and the channel `defaultSkills()`, each loaded eagerly at boot, so a broken skill still stops both at start (spec §9). Reason: a registration that never calls `get_skill` (most tool tests, the guard's own listing) never touches the disk.
3. **An empty `name` is no name**: `get_skill` with `name: ""` answers the index. Reason: MCP clients commonly send an empty string for an optional argument they mean to leave out, and answering `not_found` there would send the agent in a circle. Plan review round 1 (SP1) found that the approved text gave the index only for an omitted name; the controller kept this behaviour and **the spec is amended to match** ("Amended 2026-09-28 during plan review", §5.1, §9 and §10.2), so this is now the spec's rule, not a deviation.
4. **`parseSkill`'s rule messages** are fixed wordings (Task 2 Step 6), each naming the folder as `skills/<folder>: <rule>`. A missing `name`, a missing `description` and a third key share one message ("the frontmatter must be exactly two lines, name then description"); a repeated key is reported as the second line not being `description: <value>`. The name's form is checked before its equality with the folder. Reason: the spec requires the folder and the rule, not the words; the test pins each case.
5. **"One empty line, then the body"** is read as: line 4 is empty and line 5 is not. Reason: "one empty line" excludes two, and a body is text.
6. **`loadSkills`' refusals**: a missing path or one that is not a directory is `skills folder not found: <path>`; a skill folder holding anything besides `SKILL.md`, a hidden file included, is refused. Reason: spec §3.1 says a folder holds nothing but `SKILL.md`.
7. **The route** is three registrations, `/skills`, `/skills/`, then `/skills/*`, which compares `c.req.path` with `/skills/<name>.md` for each loaded skill; so a nested path (`/skills/a/b.md`) is also "No such skill". Reason: spec §4.1's `GET /skills/<anything else>` row, and no request text ever reaches a file path.
8. **The index's `join-loom` description is read on every render** (`parseSkill("join-loom", renderDocument(origin))`), and `renderSkillsIndex` sorts a copy of what it is given. Reason: spec §4.2; the render is cheap and the caller's order cannot leak into the index.
9. **The boot order.** `main.ts` loads the skills right after `loadConfig`, before the database, and prints the `skills:` line there; the channel loads them right after its `baseUrl` check. Reason: spec §4.1 says "before `buildApp`"; earliest fails fastest, before any database work.
10. **`buildMcpServer` gains a trailing `skills` parameter** (default `defaultSkills()`) and `MountMcpOptions` a `skills` member, fed from `AppDeps.skills`. Reason: the smallest change that gives the routes and every session one array (spec §4.1).
11. **`EVENT_TYPES`' type-level assertion** is `expectTypeOf<EventType>().toEqualTypeOf<...>()`, checked by `pnpm --filter @loom/core typecheck`, beside a runtime equality with the literal list. **`ERROR_CODES`' test** calls every `errors` factory with `"x"` and compares the codes made. Reason: spec §10.0's wording, with no new dependency.
12. **The channel has no tool count to change**: the spec's "38 becoming 39" in §10.4 has no literal in `channel.test.ts`, so its tool-list case gains `get_skill` among the names it checks.
13. **`FIELD_NAMES` is a `Map` from name to where it exists**, built from groups that copy spec §6's table row by row. Reason: "each entry with the place it exists, recorded beside it".
14. **The skill files are written by a script** that extracts the four `markdown` blocks (four-backtick fences) of spec §7, checked by size and SHA-256 against the approved head `238331a`. Reason: byte for byte, with no retyping.
15. **REVIEW-BRIEF**: beyond spec §8's "the slice's row in the per-layer table", the branch line and §1a are rewritten for this branch and §2's spec list gains this spec first. Reason: the brief's own pattern, which every earlier branch followed; the listener-status §1a is recorded in its spec, plan and PR #45.
16. **Test placement.** The two `/mcp` cases about the pointer texts (the instructions line, state 3) and the server's count of 39 go to Task 2, the task whose change they pin; the `get_skill`-over-`/mcp` cases go to Task 4. `tools.test.ts` uses fixture skills; the server and channel cases use the real ones.
17. **`get_skill` sits after `get_started` in `LOOM_TOOL_NAMES`.**
18. **Smoke test 10 step 3** says which states carry the line. Reason: a waiting invitation or request answers state 4 or 5 first, which do not carry it (spec §5.2), so the step could otherwise fail for a correct build.
19. **DOGFOOD's sentence** goes after §4's first paragraph; v2-notes' pointer is a new line under "Skills, not prompts", so that bullet's existing line (which carries an em dash) is untouched.
20. **Beyond the list:** `get_skill's description and its name argument read exactly as the spec gives them` (Task 2, the house habit of pinning every description); the boot's `skills:` line in `migrate.test.ts` (Task 4, spec §4.1's log line, otherwise untested).

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §10.0 `ERROR_CODES` holds every code a `LoomError` factory constructs, each once | 1 |
| §10.0 `EVENT_TYPES` holds every type the union named, each once; `EventType` accepts exactly those | 1 |
| §10.0 `REQUIREMENT_KEYS` equals the keys `validateRequirements` accepts | 1 |
| §10.1 the drift guard, case 1 (the four names) | 3 |
| §10.1 the drift guard, case 2 (only `SKILL.md`; each passes `parseSkill`) | 3 |
| §10.1 the drift guard, case 3 (the four headings in order) | 3 |
| §10.1 the drift guard, cases 4 and 5 (every code span known; call-form arguments) | 3 |
| §10.1 the drift guard, case 6 (no URL, no uuid) | 3 |
| §10.1 the drift guard, case 7 (no em dash) | 3 |
| §10.1 the code-span classifier as a unit (seven passes, ten fails) | 3 |
| §10.1 every `FIELD_NAMES` entry is used by at least one skill | 3 |
| §10.1 the instance-value check as a unit (nine caught, four passed) | 3 |
| §10.1 `parseSkill` accepts a minimal valid file and returns its whole text | 2 |
| §10.1 `parseSkill` refuses, fifteen cases | 2 |
| §10.1 `parseSkill` turns CRLF into LF | 2 |
| §10.1 `loadSkills` over a temporary folder (sorted, plain files ignored, no `SKILL.md`, a second file, a missing folder) | 2 |
| §10.1 `renderSkillsIndex` gives the exact text | 2 |
| §10.2 `LOOM_TOOL_NAMES` has 39 names including `get_skill`; the registered tools equal it | 2 |
| §10.2 `get_skill` with no name answers the index as one text block, not JSON | 2 |
| §10.2 `get_skill` with an empty name answers the index (amended 2026-09-28): `an empty name is no name: the index` | 2 |
| §10.2 `get_skill` with each skill's name; with `join-loom` | 2 |
| §10.2 unknown name `not_found`; `join-loom` without origin `not_found`; no origin root-relative | 2 |
| §10.2 no credential, no `defaultCredential`, no backend call | 2 |
| §10.2 `renderState(3)` and `(6)` end with `SKILLS_LINE`; 1, 2, 4, 5 do not | 2 |
| §10.2 `agentInstructions` has the skills line after the `/join-loom.md` line | 2 |
| §10.2 `renderDocument` has the skills paragraph and passes `parseSkill("join-loom", ...)` | 2 |
| §10.2 the no-em-dash case covers `SKILLS_LINE` and both new lines | 2 |
| §10.3 `GET /skills` and `/skills/`: 200, headers, the index | 4 |
| §10.3 `GET /skills/<name>.md` for each of the four: 200, headers, the file | 4 |
| §10.3 the five 404s | 4 |
| §10.3 without `webDist`, no credential, nothing reflected | 4 |
| §10.3 `/mcp` with an agent key: `get_skill` equals the two bodies | 4 |
| §10.3 `/mcp` without an agent key: the same | 4 |
| §10.3 the agent instructions carry the skills line; `get_started` state 3 carries `SKILLS_LINE` | 2 |
| §10.3 the tool count, 38 becoming 39 | 2 |
| §10.4 `get_skill` in the channel's tool list; the index with the configured Loom's origin | 4 |
| §10.5 the image carrying `skills/` (not automated; smoke test 10 step 1) | 5 (written) |
| §10.6 smoke test 10, written into TESTING.md (run by Paw after the deploy) | 5 |

Cases this plan adds beyond the spec's list, each in the task named: `get_skill's description and its name argument read exactly as the spec gives them` (2); the boot's `skills:` line in `migrate.test.ts` "false with nothing pending starts normally and serves" (4). Known ripples repaired, each named in its commit: `tools.test.ts` "advertises the ten Lobby tools and nothing else new" and "LOOM_TOOL_NAMES has the four new names, and the registered tools equal it" (38 to 39), `mcp.test.ts` "serves the tool catalog without connection-level auth" (38 to 39), and in `onboarding.test.ts` `state3`, the state 6 exact text, "agentInstructions produces the exact text of spec §5.3 with the origin" and "renderDocument produces the exact document of spec §7 with the origin" (the added line) (all 2).
