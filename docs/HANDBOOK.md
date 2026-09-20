# The Loom handbook

How this project is run, for the agent running it. The code is documented elsewhere and this file
does not repeat it: [ARCHITECTURE.md](ARCHITECTURE.md) is how the system is put together,
[../CONTRIBUTING.md](../CONTRIBUTING.md) how the code is written, [../README.md](../README.md) how
it is run and how agents connect. What is here is the part that is in nobody's head but the last
session's: the roles, the cycle, the rules the owner has stated, and the mistakes already paid for.

## 1. What Loom is, in five lines

Loom is a standalone chat hub where humans and external AI agents collaborate as peers; it hosts no
AI of its own. Work happens in **Weaves**, addressed by a secret; conversations inside one are
**Threads**, typically one per pull request, each carrying that artefact's URL. A Weave is an
append-only event log with a single monotonic `seq`, so any client catches up by asking for
everything after the last `seq` it saw. Agents reach it three ways: the REST/WebSocket API, the
remote MCP endpoint `/mcp`, and the Claude Code channel plugin. The point of the whole thing is the
review loop: a finding is a message in the PR's Thread, answered in place, with the human reading
rather than relaying.

### Vocabulary

Enough to speak the language; [ARCHITECTURE.md](ARCHITECTURE.md) §4, §6 and §12 have the depth.

| Word | Means |
| --- | --- |
| Weave | A room and its event log. A working session, or one piece of work. |
| Thread | A conversation inside a Weave, optionally carrying a `url` (the PR). `General` is the one born with the Weave. |
| Participant | An identity **inside one Weave**: a name, a kind (`human`/`agent`), a role, and a token. |
| Keeper | A participant with `role = keeper` — the Weave's admin. |
| Instance keeper | An instance-wide administrator, holding a keeper token. Counts as a keeper of every Weave, but cannot post and has no `inbox`. |
| Weave secret | The 43-character string that addresses a Weave. **Read-only**, and the thing you hand someone so they can join. |
| Participant token | One participant's credential in one Weave. Everything a member can do there. |
| Agent key | An instance-level identity for a remote MCP client, minted by an instance keeper. Maps to the agent's participant in whichever Weave it has joined; never grants keeper rights. |
| Lobby | The one Weave per instance that every agent joins so it can be found. Joining it needs no secret. |
| Listener | A participant standing in the Lobby. |
| Profile | A listener's machine-readable capabilities: `models`, `tools`, `runtime`, `spawnsSubagents`, `owner`, `serves`. |
| Request | A first-class ask posted in the Lobby for work that lives in another Weave: requirements, `wanted: N`, a timeout. |
| Offer | An eligible listener's "I can take this now". Matching **wakes**, never assigns. |
| Accept | The requester taking up to `wanted` offers. |
| Invitation | The single-use way into the target Weave an accepted helper is given — an id, never a secret. |

## 2. The people and the agents

**Paw** owns the project and is the only one who decides. Paw does **black-box vibe coding**: he
does not read the code, he reads behaviour, screenshots and summaries. So every report to him is
about what the software now does, what it cost and what he must decide — extremely concise,
grammar sacrificed for concision, no code unless he asks. He runs the manual smoke tests himself,
in Firefox, and he runs a **separate design session** for visuals.

**The controller** is the main Claude Code session — this one. It brainstorms, writes the spec and
the plan, dispatches every implementer, reviews every diff itself, opens the PR, answers review
rounds, and keeps the ledger. It writes no feature code inline.

**Implementer and reviewer subagents** are fresh Opus subagents, one per plan task: an implementer
that works test-first from a written brief, and a read-only reviewer that gets a review package.
Neither survives a session restart — a new one must be briefed with file paths, never with "as we
discussed".

**The external reviewer** is **ChatGPT** (`gpt-5.6-sol`), not GitHub Copilot. Since 2026-09-19 it
watches the pull request itself: it posts a `# CHATGPT REVIEW` review, and re-reviews automatically
after each push. Its post states when no findings remain — that is the signal to stop. Spec and
plan rounds still arrive by Paw pasting them in.

## 3. The development cycle

Each step ends where its completion criterion says, and not before.

1. **Idea.** From Paw, from a smoke-test finding, or from
   [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md). Ideas Paw wants queued rather
   than done now go in the `Tasks/` docket at the repo root — untracked, one Markdown file per task
   with a `## Status` line (`todo | in progress | blocked | done`), driven by the `add-docket` skill
   and by Paw saying "Proceed". *Done when:* the idea is written down somewhere Paw's other
   accounts can see it.
2. **Brainstorm.** Classify it first — spike, bounded, or architectural — because that decides how
   much design it earns. Ask **one question at a time**; offer approaches with trade-offs, not a
   single answer. Record every decision in a brainstorm file under `.superpowers/`. *Done when:*
   Paw says the design is approved.
3. **Spec.** `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, on a **docs branch that is
   pushed** (see §4). It is the binding requirement text: numbered sections, an explicit test list,
   and a statement of what it does *not* promise. *Done when:* it is written and pushed.
4. **Spec review rounds.** Paw runs it past ChatGPT and pastes the findings. **Verify every finding
   against the code before accepting it** — nothing is accepted on the reviewer's authority, and a
   wrong finding is answered with reasons. Fixes go through a fresh subagent. Record each round,
   its findings and the commit that fixed them, in the brainstorm file. *Done when:* Paw says
   "spec approved".
5. **Plan.** `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`, in the format of the superpowers
   `writing-plans` skill: Goal, Architecture, Tech Stack, Spec, Base, the commit trailer, a
   **Global Constraints** section every task implicitly includes, then one section per task with
   **Files**, **Interfaces** (consumes / produces) and checkbox steps ending in RED, GREEN and the
   exact commit subject. Task 0 cuts the branch and records the baseline totals. **Every test the
   spec lists is assigned to exactly one task.** *Done when:* written, and every spec test is
   traceable to a task.
6. **Plan review rounds.** Same discipline as step 4. *Done when:* Paw says "plan approved".
7. **Docs PR merged first.** Open the spec+plan docs branch as its own PR and get it merged to
   `main` **before** cutting the feature branch. *Done when:* the docs PR is merged on Paw's word
   and `main` carries the spec and the plan.
8. **Feature branch off `main`.** `feat/<slug>`, cut from the merged `main`. Install, build, run the
   full suite. *Done when:* the baseline totals are green and written into the ledger.
9. **Subagent-driven execution**, one task at a time:
   - Write the brief with the superpowers SDD scripts, so the task text never passes through the
     controller's context. They live in the plugin cache —
     `C:/Users/paw/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development/scripts/`
     — and there are three: `task-brief PLAN_FILE TASK_NUMBER [OUTFILE]`,
     `review-package PLAN_FILE BASE HEAD [OUTFILE]` and `sdd-workspace PLAN_FILE`.
   - Dispatch a **fresh Opus implementer**: strict TDD with the **RED output captured** in its
     report, one rule tested once and in `core`, and **pristine output** — a passing suite prints
     nothing unexplained.
   - Dispatch an **Opus reviewer**, read-only, against the review package. It may run in parallel
     with the next implementer when their files do not overlap.
   - **The controller reads the diff itself** before dispatching the next task or pushing anything.
   - Fix rounds are **one commit per finding**.
   - Append the outcome to the ledger `.superpowers/sdd/<plan-basename>/progress.md` — commits,
     test totals, deviations, and notes for later tasks. It is git-ignored and it is the recovery
     map if the session dies: trust it and `git log` over memory.

   *Done when:* every task is complete in the ledger and the suite is green.
10. **Whole-branch review.** One Opus reviewer over the whole diff, then a fix wave that the
    controller reviews. *Done when:* the review's verdict is ready and its fix wave is committed.
11. **Pull request.** The house PR body, in this order: a one-paragraph what-and-why with the spec
    and plan paths; a **What** table (piece → where); **Tasks → commits** with covering tests;
    **found and fixed** by the per-task and whole-branch reviews, in prose; **Decisions to confirm**
    — every deviation from the spec or plan text, numbered; **Known limits**, cross-referencing
    [KNOWN-ISSUES.md](KNOWN-ISSUES.md); and **Verification** with the real totals (`pnpm -r build`,
    `pnpm -r typecheck`, `pnpm --workspace-concurrency=1 -r test`) and an honest list of what was
    *not* run. `.superpowers/sdd/2026-09-19-loom-lobby-listeners/pr-body.md` is the worked example.
    *Done when:* the PR is open with that body.
12. **External PR review rounds.** Poll for a new `CHATGPT REVIEW`; verify each finding against the
    code; fix via a subagent, one commit per finding; review the diff; push; post a PR comment
    headed `# Response to review round N` stating the head SHA, each finding accepted-and-fixed
    with its commit or pushed back with reasons, and a Verification section with the new totals
    (`.superpowers/sdd/2026-09-19-loom-lobby-listeners/pr20-reply-1.md` is the worked example).
    *Done when:* the
    reviewer's post says no actionable findings remain.
13. **Merge.** Squash-only. **Only on Paw's explicit word, given for that PR.** A previous
    authorisation is not a standing one. *Done when:* Paw has said merge, and `main` carries it.
14. **Cleanup.** Delete the merged local and remote branches and remove the worktrees. *Done when:*
    `git branch` and `git worktree list` show only what is still in play.
15. **Manual smoke test with Paw**, one step at a time, real values filled in, waiting for each
    result. The tests are in [TESTING.md](TESTING.md) §"Manual smoke tests". *Done when:* every
    step has a PASS or a recorded finding.
16. **Record the run.** The results, the doc fixes the run produced, and Paw's change requests go
    into the repo as a docs PR: the smoke test's own last-run paragraph in [TESTING.md](TESTING.md),
    rows in [KNOWN-ISSUES.md](KNOWN-ISSUES.md), and the narrative plus change requests in
    [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md). *Done when:* that PR is merged
    and the next slice's change requests are written down.

## 4. Standing rules from Paw

Each with the reason it exists, because the reason is what tells you how to apply it to a case it
does not name.

- **Every subagent runs `model: "opus"`.** Paw pays for the quality and has said so globally.
- **Never execute a plan inline.** Plans are executed subagent-driven, always. Paw answered
  "Always subagents" when offered the choice (2026-09-12), so the question is not re-asked.
- **Review every subagent diff yourself before pushing or dispatching the next task.** A subagent's
  report is its own account of its work; the diff is the evidence.
- **Merge authorisation is per PR.** Ask for it, for that PR, every time.
- **If Docker is down, ask Paw to start Docker Desktop.** He said "I'll start docker" after a
  session tried to launch it; bringing the project's containers up once the daemon is running is
  fine.
- **Hand-run steps go one at a time, with the real ids and secrets already substituted**, then wait
  for the result. A numbered list full of `<placeholders>` was unusable with this many ids.
- **Project notes, ideas and decisions go in the repo**, in
  [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md) — not in agent memory. Paw works
  from several Claude accounts and memory on one is invisible to the others.
- **Visual design is Paw's separate design session.** Log behaviour, not styling; a spec may name
  class hooks and prescribe no colour, spacing or layout.
- **Approved docs never sit on an unpushed branch.** A cleanup deleted the worktree and every local
  branch but `main` while an approved spec was unpushed; it was recovered from the object store.
  Push the docs branch as soon as it exists.
- **Reports to Paw are extremely concise.** What changed, what it cost, what he must decide.

## 5. Traps learned

Each bit once, in this repository. The plan's Global Constraints section is where the live ones are
enforced; this is the index.

- `cb?.(write())` skips the **write**, not just the callback — write into a variable first, report
  after (web session identity invalidation).
- **The liveness guard comes before any side effect, on rejections as much as on answers** — fixed
  three times: the own-profile read, the listener count read, the directory's rejection handler.
- **Every async continuation re-checks liveness inside itself**, not only in its caller.
- **Every session loop and every refresh slot is owned by a generation** — load, refresh and the
  Lobby board retry each needed one.
- **A handler owned by a keyed mount must die with it**: a `mounted` ref checked first, or a retired
  handler acts on the surviving parent (the web `WeaveMount` / `reloadKey` case).
- **Exact request and write counts are fragile** across a reload or a refresh — assert the rule, not
  the arithmetic.
- The Lobby's **count read shares the directory query's pathname**; a test stub tells them apart by
  `limit=0`.
- **A test may only press what its script rendered**: a chip exists only where an answer carried
  facets, *Show more* only where one carried a cursor.
- **happy-dom's `fetch` is same-origin.** `window.happyDOM.setURL(server.baseUrl + path)` makes the
  ambient `fetch` *and* `WebSocket` reach a real test server (measured). happy-dom also **prints 4xx
  responses** to the console, so a fixture must answer 2xx everywhere to keep output pristine.
- **Paw's Docker Postgres clock can step backwards ~1 s** — never order test expectations by wall
  clock. A real core bug hid behind this: `General` was picked as oldest-by-`created_at` at four
  sites, now `generalThreadOf` selects `is_general`.
- **`tsx watch` hangs** started non-interactively; run the dev server through the preview harness
  (`.claude/launch.json` → `.claude/run-server.ps1`, both git-excluded).
- **No backticks inside SQL `--` comments** in drizzle `sql\`\`` templates.
- **A squash-merged docs branch plus a feature branch cut from it = add/add conflicts.** Merge the
  docs PR before cutting the feature branch; if it is too late, verify `main`'s copies equal the
  branch's base and take the branch's.
- **`git worktree remove` can leave `node_modules` behind on Windows** — finish with PowerShell
  `Remove-Item -LiteralPath "\\?\<path>" -Recurse -Force`.
- **Paw's browser is Firefox and it refuses Caddy's local certificate** — give him
  `http://127.0.0.1:3000`, which is still a secure context, so the clipboard API works.
- **The dev Lobby holds 60 `seed-N` listeners** left by smoke test 6 (62 listeners / 69
  participants); participants cannot be removed, so expected counts on the dev database are not the
  fresh-database counts.
- **`.superpowers/` is ignored only through `.git/info/exclude`**, which is local and has fallen out
  once. It holds real Weave secrets and participant tokens — check
  `git check-ignore -v .superpowers` after any clone, and never copy a value out of it into a
  tracked file.
- **The Edit/Write tools can decode escape sequences such as `\uXXXX` in tool input into literal
  bytes.** Never write one; after staging, check `git diff --cached --stat` for `Bin` rows.

## 6. Where the state of the project lives

| Where | What it holds |
| --- | --- |
| [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md) | The living roadmap: every idea with its shipped/deferred status, the north-star scenario, the dogfood findings, and the smoke-test narratives. The source of truth Paw's other accounts read. |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Deliberately deferred findings, per package. Never re-report a row; delete it in the PR that fixes it. |
| [TESTING.md](TESTING.md) | How the suites run, and the six manual smoke tests with a dated last-run paragraph each. |
| `.superpowers/HANDOFF.md` | Local and git-ignored: the last session's handoff. **Read it first if it is present** — it beats this file on anything current. |
| `.superpowers/sdd/<plan>/progress.md` | The per-plan ledger: task outcomes, commits, totals, deviations, recorded minors. The recovery map. |
| `Tasks/` | Paw's untracked docket of queued work. |

### The current state — 2026-09-20

`main` is at **19d4461**; shipped through **PR #22**; **1663 tests in 65 files**. Only `main` exists
locally and there are no worktrees. The next slice, **the Lobby listeners view** (the directory
becomes a view inside the Lobby layout), has an **approved spec and an approved plan on `main`**:
`docs/superpowers/specs/2026-09-20-loom-lobby-listeners-view-design.md` and
`docs/superpowers/plans/2026-09-20-loom-lobby-listeners-view.md`, six tasks.

**Paw has said not to start development until he says so.** Do not cut `feat/lobby-listeners-view`
and do not execute the plan before that word.
