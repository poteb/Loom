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
review loop: a review reaches the people and agents who need it as messages in a Thread, answered in
place, with the human reading rather than relaying. (Where this project puts its own findings — on
the PR, or in the Thread — is [DOGFOOD.md](DOGFOOD.md) §5.)

### Vocabulary

Enough to speak the language; [ARCHITECTURE.md](ARCHITECTURE.md) §4, §6 and §12 have the depth.

| Word | Means |
| --- | --- |
| Weave | A room and its event log. A working session, or one piece of work. |
| Thread | A conversation inside a Weave, optionally carrying a `url` (the PR, or the document under review). `General` is the one born with the Weave. |
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
| Accept | The requester taking up to `wanted` offers, giving each accepted agent a deadline (`deadlineMs`) to call `complete`. |
| Complete | An accepted agent's own statement that its work on a request is done; the request closes as `completed` once every accepted agent has completed. |
| Invitation | The single-use way into the target Weave an accepted helper is given — an id, never a secret. |

## 2. The people and the agents

**Paw** owns the project and is the only one who decides. Paw does **black-box vibe coding**: Paw
does not read the code but behaviour, screenshots and summaries. So every report to Paw is
about what the software now does, what it cost and what Paw must decide — extremely concise,
grammar sacrificed for concision, no code unless asked. Paw runs the manual smoke tests personally,
in Firefox, and runs a **separate design session** for visuals.

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
plan rounds arrive by Paw pasting them in, or, when the live Loom is in use, run in the document's
own Thread ([DOGFOOD.md](DOGFOOD.md) §4).

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
   its findings and the commit that fixed them, in the brainstorm file. When the live Loom is in
   use, the round runs in the document's Thread — see [DOGFOOD.md](DOGFOOD.md) §4. *Done when:* Paw
   says "spec approved".
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
    (`.superpowers/sdd/2026-09-19-loom-lobby-listeners/pr20-reply-1.md` is the worked example). The
    findings and the answers stay on the PR; when the live Loom is in use, announce each round in
    the PR's Thread (see [DOGFOOD.md](DOGFOOD.md) §4). Every Thread line meant for the reviewer
    @mentions it, *fixes pushed* included: its `inbox` returns nothing else. *Done when:* the
    reviewer's post says no actionable findings remain.
13. **Merge, then update the live instance.** Squash-only. **Only on Paw's explicit word, given for
    that PR.** A previous authorisation is not a standing one. Then run the one update command from
    the repository root and report what it printed. The first deployment of spec §9 ran on
    2026-09-22 ([DOGFOOD.md](DOGFOOD.md) §2), so there is always an instance for it to update:

        deploy\live-update.cmd

    It is `ssh SpoolServer` into `~/git/Loom/deploy/live-update.sh` and nothing else
    ([DOGFOOD.md](DOGFOOD.md) §2). It **stops Loom for a few seconds** while it dumps the database
    and applies the migrations, so `https://loom.3dbox.dk` answers **502** for that window and a
    reviewer polling `inbox` mid-update sees a failed call — that is expected, and the run's own
    output is the thing to read rather than the reviewer's complaint. *Done when:* Paw has said
    merge, `main` carries it, and the update printed `health: ok` with the merged commit in
    `deploy/.verified-sha`.
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
- **If Docker is down, ask Paw to start Docker Desktop.** Paw said "I'll start docker" after a
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
- **Reports to Paw are extremely concise.** What changed, what it cost, what Paw must decide.

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
- **Paw's browser is Firefox and it refuses Caddy's local certificate** — give Paw
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
- **A session cannot hand Paw a credential through the conversation** — an agent key or a Weave
  secret must not be printed into chat. Give Paw the **path** of the file that holds it
  (`~/.loom/agent-<name>.json`) plus a one-line command that prints the connector URL, and let Paw
  copy the value out of a terminal (Loom dogfood run, 2026-09-20).

### Deployment, shell and migrations — the live-instance slice, 2026-09-22

Every one of these was paid for in writing that slice's spec and in answering its twelve review
rounds; the spec's §10 is where each keeps its full reasoning. **The first twelve were paid for
twice** — each one survived a reading, shipped, and had to be fixed again.

- **`pgrep -f` matches the shell that runs it.** `-f` searches whole *command lines*, so a verdict
  wrapper written as `sh -c '… pgrep -f pg_dump …'` finds its own parent shell (`pgrep` excludes only
  itself, never the process that launched it) and answers "a dump is still running" on an empty
  container, every time and for good: a hazard marker cleared only by the opposite answer latches
  shut permanently. Match the process **name** with `pgrep -x`, which a full path or a long argument
  list cannot change — and note that the bare `pgrep -af` / `pkill -f` a container runs *as its own
  argv*, with no wrapper shell, are not the same case and are still right.
- **A one-word fix to a string a container executes is verified by executing it in a container**, in
  both of the states it must tell apart, because that defect was invisible to three readings.
- **A reaper that guards one run does not guard the next one.** The run that finds an interrupted
  update on disk is not the run that started the migrator, so the applying container can still be
  alive while the *new* process asks the database what happened: reap it, with the same proof the
  original run required, **before** the cheap "is it already healthy" probe and before any status is
  read, and refuse without restoring when the reap proves nothing.
- **A marker whose lifetime is the box's must not live inside a record whose lifetime is one run's.**
  The run that records "a `pg_dump` may still be running" is the run whose recovery then removes its
  own intent record, taking the marker with it — so the hazard goes in a file of its own and is
  cleared only by the check that disproves it.
- **`drizzle-kit generate` diffs against the newest snapshot file, not against the journal.** Deleting
  a migration's `.sql` and its journal entry and leaving `meta/<NNNN>_snapshot.json` behind makes the
  regeneration see its own change as already present and emit nothing at all, so restore `meta/` to
  the merged baseline as well ([CONTRIBUTING.md](../CONTRIBUTING.md) §"Migrations").
- **`git checkout <ref> -- <dir>` does not restore a directory, it overlays one** — it rewrites the
  files the ref has and leaves every branch-only file exactly where it was, so the obsolete snapshot
  survives the command written to remove it. Use `git restore --source=<ref> --staged --worktree --
  <dir>`, which is non-overlay by default.
- **A migrator's own rule is not a safety property.** Drizzle applies what is newer than the newest
  applied row, so a migration generated on a long-lived branch and merged after a newer one is
  reported applied and silently skipped — a healthy deployment with a missing table in it. Validate
  that the journal increases and that the rows are an exact prefix of it, and refuse instead of
  reporting.
- **`cmd | grep -q` under `pipefail` can report 141.** `grep -q` exits on the first match, the
  producer dies of `SIGPIPE`, and a guard written as `producer | grep -q … && refuse` therefore waves
  through the very case it was written to catch — **and collecting the output into a variable is not
  the fix**, because `printf '%s\n' "$VAR" | grep -q …` has the same defect with `printf` as the
  victim. The pipe itself has to go: `grep -q … <<<"$VAR"`, or a variable and a `case`, and then the
  *whole* file audited for the shape, because one instance is never the population.
- **`docker compose run <service> <args>` replaces the service's `command:`** rather than appending to
  it, so a status flag on its own becomes the program the container tries to execute. Name the whole
  command.
- **A failure to ask is not an answer.** `docker inspect … || return 0` reads a daemon that is not
  answering as "the container is not there", which is precisely the outage that left the container
  running — so classify the error text and treat anything but "No such object" as unknown. **And one
  classified call site does not classify the file:** put the three-way classification in one helper
  and route every inspection through it, so the next call site cannot be written the old way.
- **"The container was created" is not "the application is serving".** `up -d` returns 0 as soon as
  Docker has started the process, so a state variable set there disarms a recovery on the strength of
  nothing. Only a request the application answered may do that.
- **A trap cannot recover an interruption that is not an exit.** A power loss or a `SIGKILL` runs no
  handler at all, so write an intent record before the first irreversible step, reconcile it at the
  top of every later invocation, and remove it only once the thing it intended is a durable fact.

And the rest, in the spec's own order:

- **An environment aimed at one instance stays aimed at it.** A runbook that ends by touching a
  *different* instance has to select that instance's config store, identity and URL explicitly and
  then put the first one back, because the CLI resolves its Weave and its token from `$LOOM_CONFIG`
  and `LOOM_AGENT_KEY` and will otherwise fail with `no_weave` on a Weave it has never heard of.
- **A `timeout` is not a bound when the kernel will not kill the child.** A process wedged in
  uninterruptible I/O on a stalled or full filesystem survives `TERM` and `KILL`, and `timeout` then
  waits for it — so a deadline on every command is still not a ceiling on the outage. Sum the
  deadlines if you like, but say which waits sit outside the sum and who ends them.
- **A signal sent is not a process gone.** `pkill` inside a container proves only that a signal was
  delivered somewhere, so ask afterwards, treat anything but a definite "gone" as still running, and
  leave a durable marker that makes the *next* run refuse rather than queue behind it.
- **A remote command's exit status is not the remote command's answer.** `docker compose exec …
  pgrep` returns 1 with empty stdout both when `pgrep` matched nothing and when Compose never ran it
  at all, so a gate that reads that as "nothing matched" clears its own hazard on a daemon error:
  make the container print a verdict token of its own, require a successful transport *and* that
  token, and treat every other shape — non-zero exit, empty stdout, unrecognised stdout, a timeout —
  as unanswered and therefore as the hazard.
- **A path spelled in a script is a path a test cannot avoid touching.** Absolute literals make a
  harness either unrunnable on a laptop or dangerous on the server, so make every operational path a
  constant with its production default, move them only under one explicit test-mode variable that
  announces itself, and assert the defaults by *reading* the file rather than by running it.
- **A timeout on a client is not a timeout on the work.** `docker compose exec … pg_dump` under a
  killed client leaves `pg_dump` running inside the container, holding a snapshot of the database the
  script is about to migrate — so kill the server side too, and bound that as well.
- **An exit handler is not a timeout.** A script blocked in a command has not exited, so no trap
  runs, the lock stays held and the outage has no end: put a deadline on every command that runs while
  the application is stopped, and state the ones that still have none.
- **A retry count is not a deadline.** `for _ in $(seq 1 30); do curl …` bounds nothing when one call
  can hang, so give the call `--connect-timeout` / `--max-time` and the loop an absolute clock.
- **A mutable tag and a canonical name do not identify a container.** The same commit rebuilt over a
  newer base image is a different image id under the same tag, so a recovery that starts "the previous
  deployment" by name starts the wrong binary while every record tells the truth. Compare the
  recorded **image id**.
- **`docker compose up <service>` returns 0 even when the service failed**, and `--exit-code-from`
  implies `--abort-on-container-exit`, which would stop the live database — use `docker compose run
  --rm`.
- **HSTS `includeSubDomains` does not cover a sibling host**, so `loom.3dbox.dk` needs its own.
- **A compose project is named after its directory unless the file says otherwise** — two `deploy/`
  directories are two projects called `deploy`, so put `name:` in the file.
- **And `name:` is not enough** — `COMPOSE_PROJECT_NAME` outranks it, so pass `-p <project>` on every
  command and refuse to run with that variable set.
- **`git pull --ff-only` does not mean "the checkout equals origin".** It succeeds over a local commit
  the remote has not passed and leaves a dirty tracked file alone, so assert `HEAD ==
  refs/remotes/origin/main` on a clean tree instead.
- **A stopped Postgres container is not an empty database** — ask the volume, or a migration runs with
  no dump behind it.
- **A checkout whose `origin` is a local bundle cannot see a commit merged on GitHub.** A `pull` says
  "already up to date" and the prerequisite is silently not deployed, so re-bundle and `scp` it.
- **A backup is worth only the window between it and the change it insures against** — dump
  immediately before the migration, not before a two-minute build.
- **"Wait until it is healthy" with no bound is a hang holding a lock** — poll with a timeout, fail
  fast on `unhealthy`, and print the logs.
- **`--env-file` hands a container every line of the file**, so build a two-variable temporary file
  instead of passing a neighbour's whole environment.
- **`-f` does not move compose's `.env` lookup** — it follows the caller's directory, so a `-f`-only
  command run from elsewhere silently takes every default in the file, and `--env-file` belongs beside
  every `-p`.
- **A guard placed after the mutation it guards is disarmed by a retry** — compare against the
  deployed state *before* fast-forwarding, and persist what is deployed.
- **A dump taken while the application still accepts writes is a snapshot with a live tail** — stop
  the application, or stop claiming the restore loses nothing.
- **A single mutable image tag means there is no previous image** — tag per commit if a failure has to
  be able to go back.
- **`grep | cut` under `set -euo pipefail` defeats the `${VAR:-default}` on the next line.** `grep`
  exits 1 on no match, `pipefail` propagates it and `set -e` kills the script before the default is
  read — use `sed -n 's/^KEY=//p'`, which exits 0.
- **`git fetch origin` does not move the local `main`** — a bundle cut afterwards advertises the stale
  branch while containing the new commit, so `switch` and `pull --ff-only` before bundling.
- **An instance keeper is not a Lobby participant** — `loom lobby` needs a stored Lobby token or an
  agent key, so join before reading, and read as the keeper because only a keeper is told the Lobby's
  secret ([KNOWN-ISSUES.md](KNOWN-ISSUES.md), `commands/lobby.ts`).
- **A non-zero exit from a database client does not prove the transaction rolled back.** PostgreSQL
  can commit and the connection can drop before the client hears it, so record the pending set before
  migrating and *ask* afterwards instead of asserting.
- **One record cannot hold two facts** — "which commit's image and schema are active" and "which
  commit was proved over the public hostname" have different lifetimes, and a single file holding both
  will aim a recovery at an image the schema has moved past.
- **An old image inside a new compose definition is not the old deployment** — `stop` keeps the
  container with its image id, command, environment and networks, so `docker start` it rather than
  re-`up`-ing a tag through a file that has changed.
- **A guarantee a future merge can void from inside a file is not a guarantee** — one `COMMIT` or
  `CREATE INDEX CONCURRENTLY` in a migration ends the transaction everything else relies on, so
  enforce it in code and test it over the real files.
- **An A record that resolves is not a complete DNS answer** — a stale or wildcard `AAAA` sends ACME's
  validator and every IPv6 client elsewhere while the A check passes, and a `CNAME` beside an `A` is
  invalid outright.
- **A runbook that reads files out of a local checkout has to say which commit that checkout is on**,
  or it fails three-quarters of the way through on a missing helper.
- **Running a deployment's steps by hand is not running the deployment** — exercise the wrapper the
  merge will actually use, on the first day, or its first real use is the test.
- **A shell pipeline that ends in `grep` fails on the empty result** — `grep -v '^$'` exits 1 with
  nothing to filter, and under `pipefail` the most ordinary outcome there is kills the script, so
  delete blank lines with `sed` instead.
- **`docker compose run` allocates a pseudo-TTY when its stdin is a terminal**, so output a script
  parses arrives CR-terminated from an interactive SSH shell and matches nothing — pass `-T` on
  anything whose output is read, and keep its stderr out of the file being parsed.
- **A record written before the thing it records is live is a record that lies** — with no migration
  to apply, the new commit is only deployed once its container is actually up, so write the record
  after the start, not at the quiesce.
- **A trap armed half-way down a script reads variables the script may not have assigned yet** — under
  `set -u` the handler dies instead of recovering, so initialise every input first and install one
  handler at the top, and clear `errexit` before classifying inside it.
- **`timeout` bounds the client, not the container** — a killed `docker compose run` leaves the
  one-off running with its transaction open, so name the container, kill it, wait for it under a bound
  and reap it before asking the database anything, and bound that question too. **And reap on every
  non-success, not only on the timeout's exit codes**, because a client that loses its connection to
  the daemon exits 1 while the container keeps running.
- **`ABORT` is PostgreSQL's alias for `ROLLBACK`** — a guard that lists the transaction-control
  statements by sample rather than taking the group whole will miss one, and one is enough.
- **`docker compose ps` omits stopped containers** — a completed one-shot is invisible without
  `--all`, so a correct startup can fail a done-check written against plain `ps`.
- **A line an application prints on purpose is still a credential when somebody else reads the log.**
  Loom's first boot prints the Lobby's secret link by design, so a session running `docker compose
  logs` over SSH puts it in the controller's transcript: redact at the **reader** as well as at the
  writer, and let a done-check match on the server and print only its verdict.
- **Arm a recovery before the command it recovers from, never after it** — `docker compose stop` can
  stop the container and still exit non-zero, and a flag set only on success leaves the handler
  disarmed over a stopped application, so set it first and clear it again only on positive evidence
  that nothing was stopped.
- **A comment stripper that does not understand quoting deletes the statement the guard exists to
  find** — `VALUES ('--')` turns the rest of the line into a comment for any scanner that strips
  comments as a phase, so a SQL guard must be one stateful pass in which a comment is only a comment
  in the code state.
- **A printed recovery command is only a recovery if it works in the shell that reads it** — a `docker
  compose …` that relies on the script's own working directory fails in the `/root` shell the operator
  actually opens, so print `cd <absolute path> && …`, name the environment file, and name every record
  by its absolute path.
- **A stop you did not verify is not a stop** — `docker stop`, `docker kill` and `docker wait` can all
  fail quietly, so re-inspect and require `exited` or `dead` before believing anything about the
  database, and make the unprovable case its own state rather than a warning.
- **`docker compose up -d <service>` REPLACES that service's container** — compose finds it by project
  and service *labels*, stops it, renames it aside and removes it, so the container a recovery meant to
  restart is gone the moment the new one is created — **and `docker rename` does not hide it**, because
  the labels are what the lookup uses. Keep the *image id* and the *deployed commit's own compose file*
  instead, and reconstruct from those two.

## 6. Where the state of the project lives

| Where | What it holds |
| --- | --- |
| [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md) | The living roadmap: every idea with its shipped/deferred status, the north-star scenario, the dogfood findings, and the smoke-test narratives. The source of truth Paw's other accounts read. |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Deliberately deferred findings, per package. Never re-report a row; delete it in the PR that fixes it. |
| [TESTING.md](TESTING.md) | How the suites run, and the six manual smoke tests with a dated last-run paragraph each. |
| `.superpowers/HANDOFF.md` | Local and git-ignored: the last session's handoff. **Read it first if it is present** — it beats this file on anything current. |
| `.superpowers/sdd/<plan>/progress.md` | The per-plan ledger: task outcomes, commits, totals, deviations, recorded minors. The recovery map. |
| `Tasks/` | Paw's untracked docket of queued work. |

### The current state, 2026-09-23

`main` is at **74c2c10**; shipped through **[PR #28](https://github.com/poteb/Loom/pull/28)** (the
live instance: `deploy/`, the standalone migrate entry with drift detection, `live-update.sh` and
its harness; merged as `fa107f6`) and **#29** (the paste helper reads the reviewer brief as UTF-8,
and the two committed texts carry no em dashes; merged as `74c2c10`). Only `main` is in play.

**The live instance is `https://loom.3dbox.dk`, and it is deployed.** It runs on the Spool server
beside the shop, as its own compose project `loom` out of the checkout `/root/git/Loom`, fronted by
Spool's Caddy through the shared `/root/caddy-sites` folder (Loom's `loom.caddy` there, imported by
the generic sites hook of Spool PR #395) and the external `web` network, publishing nothing but
`127.0.0.1:3100`. Its first deployment, §9 of
[the live-instance spec](superpowers/specs/2026-09-21-loom-live-instance-design.md), ran on
2026-09-22 from 21:00Z to 22:20Z, steps 0 to 13. **Every update is now one command** from Paw's PC
after a merge, `D:\git\Loom\deploy\live-update.cmd` (§3 step 13); the first real one deployed
`74c2c10` and printed `health: ok`. [DOGFOOD.md](DOGFOOD.md) §2 is where it runs and how it is
updated.

**The review loop is proven on the live instance.** The agents `Claude-Code` and `ChatGPT` are
minted there; Claude-Code stands in the live Lobby and created the live Weave "Loom development"
(`7718207a-1fbb-4369-bbfe-e773121d9aab`), and ChatGPT joined it through the prepared paste, over the
connector `https://loom.3dbox.dk/mcp?agent=<key>`. PR #29 was the first review on it: round 1 found
one P3, round 2 closed with "no actionable findings remain". ChatGPT had no poll running, so Paw
prompted each round with "check your Loom inbox and act on it", the documented fallback. The run's
one protocol change: every Thread line meant for the reviewer @mentions it, *fixes pushed* included
([DOGFOOD.md](DOGFOOD.md) §4). The interim setup (the dev server behind a Cloudflare quick tunnel,
and its dev Weave `924408e6-0af2-4912-b02a-aa041962a55b`) is retired. One follow-up is open: the
live Weave still holds the pre-#29 guidelines text
([superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md), the live-instance entry).

**Its credentials, by file path and never by value.** A credential never enters a session's
transcript — it moves by file, by `scp` or on Paw's own clipboard. The full inventory is the spec's
§8.1; these are the paths:

| File | Holds |
| --- | --- |
| `/root/git/Loom/deploy/.env` (server, mode 600) | the live Postgres password and the instance keeper tokens |
| `C:\Users\paw\.loom\live.env` | the only copy of those two lines off the server |
| `C:\Users\paw\.loom\live-keeper.json` | the live URL and one keeper token |
| `C:\Users\paw\.loom\live-claude-code.json`, `…\live-chatgpt.json` | each agent's id, name and key |
| `C:\Users\paw\.loom\live-lobby.json` | the Lobby's weave id and its secret |
| `C:\Users\paw\.loom\live-weave.json` | the development Weave's id, secret, participant and token |
| `C:\Users\paw\.loom\live-config.json` | the CLI's own store for the live instance — set `LOOM_CONFIG` to it for every live command, so live tokens never land in the dev store |

**PR #25 is the first pull request reviewed through Loom.** On the evening of 2026-09-20 the review
was requested in a Loom Thread, ChatGPT picked it up on the next beat of its own five-minute `inbox`
heartbeat with no human prompt — about five minutes to pickup, about twelve to the posted review —
built and ran the whole suite itself (**1697 tests in 66 files**) and posted
`# CHATGPT REVIEW Round 1` on the pull request — Standards 0 findings, Spec 0 findings, "no
actionable findings remain" — then the one-line notification in the Thread. It could not do a
browser check or manual smoke test 6, and said so. The run's findings about Loom are in
[superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md); the corrections it forced are in
[DOGFOOD.md](DOGFOOD.md) §3 step 5 and §8.

On 2026-09-20 Paw also settled the dogfood questions: **a pull request's review is the record on
GitHub and its Thread carries only the notifications**, while a spec or plan review lives in its
Thread; the old reviewer agent keys were revoked and fresh `Claude-Code` and `ChatGPT` keys minted;
and an **always-on Loom instance is wanted**, with a **stable public hostname** the top item in it
because the reviewer cannot reach a loopback connector URL. That slice shipped as PR #28, and the
hostname is `loom.3dbox.dk`.
