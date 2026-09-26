# Loom: two removal rules (M1 and M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A removal that leaves only completed acceptances closes the request as `completed` (M1), and a Weave keeper removed from a Thread may invite itself back (M3).

**Architecture:** Both rules are core's. M1 is a few lines at the end of `removeFromRequestThread` in `src/core/src/removals.ts`, reusing `closeInTx` from `src/core/src/lobby/requests.ts` (exported for it). M3 is a narrowed self-invite check in `src/core/src/invites.ts`. `@loom/mcp-tools` changes two texts. No route, shape, event type or migration changes, so no other package changes.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Vitest against a real Postgres, drizzle-orm. No dependency changes.

**Spec:** `docs/superpowers/specs/2026-09-26-loom-removal-rules-design.md`. Read it whole before any task; it is the binding text. §2.4 and §3.3 are texts to transcribe, not to paraphrase. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `.superpowers/sdd/2026-09-26-loom-removal-rules/progress.md`.

**Base:** branch `feat/removal-rules` off `main` after the docs PR carrying this plan merges, in the worktree `.claude/worktrees/removal-rules`. Consumes from `main`: `removeParticipant`, `removeFromRequestThread`, `latestMarker`, `lastRemovalSeq` (`src/core/src/removals.ts`); `closeInTx`, `isActive`, `versionOf` (`src/core/src/lobby/requests.ts`); `inviteParticipant` (`src/core/src/invites.ts`); `assertIsKeeperOf`, `assertStillKeeperOf`, `actorId` (`src/core/src/actors.ts`); the fixtures in `src/core/test/thread-removal.test.ts` and `src/core/test/invites.test.ts`.

**Commit trailer.** Every implementer commit ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

- **Branch** `feat/removal-rules`, worktree `.claude/worktrees/removal-rules`, one commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 3 is done and the whole-branch review has run.
- **No em dash** (U+2014) anywhere: code, comments, test names, strings, Markdown, commit messages (Paw, 2026-09-23). A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Text that refers to Paw says "Paw".
- **Layering:** both rules live in `@loom/core` and are tested once there.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test, pristine output, exact expectations never loosened to pass. Real Postgres. Full run is serial: `pnpm --workspace-concurrency=1 -r test` (needs Docker; if the daemon does not answer, stop and report so Paw can start Docker Desktop).
- **Build before test:** `pnpm --filter @loom/core build` before the `mcp-tools` suite reads a core change.
- **Never write a `\uXXXX` escape into a file.** After staging, `git diff --cached --stat` must show no `Bin` row.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/lobby/requests.ts` (modify) | export `closeInTx` (and `isActive` if not exported) for `removals.ts` |
| `src/core/src/removals.ts` (modify) | M1: close as `completed` after a removal that leaves only completed acceptances |
| `src/core/src/invites.ts` (modify) | M3: a keeper removed from the Thread may invite itself |
| `src/core/test/thread-removal.test.ts` (modify) | spec §5.1 |
| `src/core/test/invites.test.ts` (modify) | spec §5.2 |
| `src/mcp-tools/src/onboarding.ts`, `src/mcp-tools/src/tools.ts` (modify) | spec §2.4 row, §3.3 description |
| `src/mcp-tools/test/onboarding.test.ts`, `src/mcp-tools/test/tools.test.ts` (modify) | spec §5.3 |
| `docs/KNOWN-ISSUES.md`, `docs/SECURITY.md`, `docs/superpowers/specs/v2-notes.md`, `docs/superpowers/specs/2026-09-23-loom-listener-onboarding-design.md`, and any doc stating an old rule (modify) | spec §4 |

### Task 0: Branch and baseline

- [ ] `git fetch && git worktree add .claude/worktrees/removal-rules -b feat/removal-rules origin/main`
- [ ] In the worktree: `pnpm install`, `pnpm -r build && pnpm -r typecheck`, then `pnpm --workspace-concurrency=1 -r test`.
- [ ] Record the totals (tests and files, per package and overall) in the ledger. No commit.

### Task 1: core: a removal can close the request (M1)

**Files:** `src/core/src/lobby/requests.ts`, `src/core/src/removals.ts`, `src/core/test/thread-removal.test.ts`.

**Interfaces:** consumes `closeInTx(tx, row, reason, actor, now): Promise<NewEvent[]>` and `isActive(offer)`; produces no new export beyond making those two importable.

- [ ] RED: add the seven tests of spec §5.1 to the `describe("remove_participant on a request Thread")` block, with the exact names the spec gives (for "removing every acceptance leaves the request working", first check whether an existing test already asserts it; if one does, name it in the report and do not duplicate it). Use the file's existing request fixture and extend it only as far as `wanted: 2` and `wanted: 3` need; the Lobby-keeper case uses a Lobby keeper actor as the existing keeper tests in this file do. Run `pnpm --filter @loom/core test -- thread-removal` and capture the failing output.
- [ ] GREEN: export `closeInTx` (and `isActive`) from `requests.ts`. In `removeFromRequestThread`, after `lobbyEvents` is built and before `lastEventSeq` is written:

```ts
    // Spec 2026-09-26 §2.2 (M1): a removal that leaves only completed acceptances closes the request.
    if (active && req.status === "working") {
      const after = await tx.select().from(requestOffers).where(eq(requestOffers.requestId, req.id));
      const remaining = after.filter(isActive);
      if (remaining.length > 0 && remaining.every((o) => o.completedAt !== null)) {
        lobbyEvents.push(...await closeInTx(tx, req, "completed", me, now));
      }
    }
```

  `req` is the row read before the lock; if `req.status` can be stale there, re-read the row inside the transaction and use the fresh one for both the check and `closeInTx` (say which in the report). Update the `removeParticipant` doc comment with one sentence naming the rule.
- [ ] Run the core suite green; `pnpm -r typecheck`.
- [ ] Commit: `feat(core): a removal that leaves only completed work closes the request`

### Task 2: core: a keeper may readmit itself (M3)

**Files:** `src/core/src/invites.ts`, `src/core/test/invites.test.ts`.

- [ ] RED: add the six tests of spec §5.2 with the exact names given, in `describe("inviteParticipant")`. The existing "rejects self-invite, ..." test stays as it is and must stay green (it is the never-removed keeper case or the non-keeper case; name which in the report). A keeper is removed from a Thread by that Thread's creator (`removeParticipant` from `../src/removals.js`). Capture the failing output.
- [ ] GREEN: replace the up-front `if (me === participantId) throw ...` with: a self-invite is allowed to continue only when the actor is a participant whose `weaveId` is the Thread's Weave and whose `role` is `keeper`; otherwise `validation` "You cannot invite yourself". Inside the lock, for a self-invite: `assertStillKeeperOf(tx, actor, t.weaveId)` (also when the actor created the Thread), then `lastRemovalSeq(tx, threadId, me) === 0` gives `validation` "You cannot invite yourself". Keep the archived and closed checks' order as it is today (spec §3.2: `weave_archived`, `thread_closed` still apply). The rest of the function (idempotence from the last removal, the event) is unchanged. Update the function's doc comment with one sentence.
- [ ] Run the core suite green; `pnpm -r typecheck`.
- [ ] Commit: `feat(core): a Weave keeper removed from a Thread may invite itself back`

### Task 3: texts and docs

**Files:** `src/mcp-tools/src/onboarding.ts`, `src/mcp-tools/src/tools.ts`, their two tests, and the docs of spec §4.

- [ ] RED: in `src/mcp-tools/test/onboarding.test.ts` change the pinned `request.overdue` row to spec §2.4's full row; in `src/mcp-tools/test/tools.test.ts` add a case that `invite_participant`'s description contains spec §3.3's sentence. Build core, run `pnpm --filter @loom/mcp-tools test`, capture the failures.
- [ ] GREEN: transcribe the two texts into `onboarding.ts` and `tools.ts`. Run the mcp-tools suite green (the served-document tests render from the module and must follow without edits; if one pins the old row, update it to the new row and name it in the report).
- [ ] Docs, each as spec §4 says: delete the two KNOWN-ISSUES rows (M1 on `lobby/requests.ts`/`removals.ts`, M3 on `removals.ts`/`invites.ts`); add the two dated answer lines in v2-notes; add the one dated "Amended" line under the onboarding spec's title; change the SECURITY row; grep `docs/`, `README.md` and `src/*/README.md` for `invite yourself`, `stays \`working\`` and `only \`complete\`` and fix each place that states an old rule (list them in the report; do not touch plans or old specs other than the one "Amended" line).
- [ ] Full serial suite green: `pnpm -r build && pnpm --workspace-concurrency=1 -r test`. Record totals.
- [ ] Commit: `docs: record the two removal rules; texts for the requester and the invite tool`

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §5.1, all seven | 1 |
| §5.2, all six | 2 |
| §5.3, both | 3 |
