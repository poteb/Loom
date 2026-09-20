# Loom — how this project is run

Paw owns this project and decides everything. He does black-box vibe coding: he reads behaviour and
summaries, not code. Report in a few lines — what changed, what it cost, what he must decide.

## Every turn

- **Subagents** run `model: "opus"`, always, and plans are executed by them — never inline.
- **Read every subagent's diff yourself** before you push, merge, or dispatch the next task.
- **Merge on Paw's explicit word, given for that PR.** A past yes is not a standing yes.
- **Hand-run steps go to Paw one at a time**, real ids and secrets already filled in; wait for his
  result before the next one.
- **Ideas, decisions and notes belong in the repo** — `docs/superpowers/specs/v2-notes.md` — because
  Paw works from several Claude accounts and cannot see one account's memory from another.
- **Push a docs branch as soon as it exists.** An approved spec was once lost on an unpushed branch.
- **Docker down?** Ask Paw to start Docker Desktop; bring the project's containers up yourself once
  the daemon answers.
- **Visual design belongs to Paw's separate design session.** Record behaviour, not styling.
- **Never write an escape such as `\uXXXX` into a file** — the editing tools decode it into literal
  bytes. After staging, `git diff --cached --stat` must show no `Bin` rows.

## Read before you act

- **Starting** a session → `.superpowers/HANDOFF.md` if it exists: the last session's state and
  Paw's standing word. It beats every doc below on anything current.
- **Anything past a one-line answer** → `docs/HANDBOOK.md`: the roles, the development cycle step by
  step, Paw's standing rules with their reasons, the traps already paid for, and where the state of
  the project lives.
- **Posting a PR review request into Loom itself, or standing up the instance that carries it** →
  `docs/DOGFOOD.md`: what is proven, what is missing, the setup, and the per-PR protocol.
- **Reading the system for the first time, or changing how a mechanism works** →
  `docs/ARCHITECTURE.md`: packages, the layering invariant, the event log, credentials, the three
  ways in.
- **Writing code** → `CONTRIBUTING.md`: toolchain, layering, naming and value rules, concurrency
  conventions, logging, test standards, git and PR conventions.
- **Writing or running tests** → `docs/TESTING.md`: database provisioning, the serial run,
  build-before-test, and the six manual smoke tests.
- **Running it, connecting an agent, minting an agent key, or using the CLI** → `README.md`.
- **Reviewing a branch, or answering a review round** → `docs/REVIEW-BRIEF.md` for the finding
  format and the severity scale, `docs/KNOWN-ISSUES.md` for what is already deferred and must not
  be re-reported.
- **Touching authorization, credentials or anything that could leak a secret** → `docs/SECURITY.md`.
- **Wondering what is next, or what an idea's status is** → `docs/superpowers/specs/v2-notes.md`.
- **Executing an approved plan** → `docs/superpowers/plans/`, the ledger under
  `.superpowers/sdd/<plan>/progress.md`, and `docs/HANDBOOK.md` §3 step 9 for the dispatch loop.

## Commands worth knowing

Everything else is in `package.json` and `--help`.

    pnpm -r build && pnpm -r typecheck
    pnpm --workspace-concurrency=1 -r test   # serial; needs Docker for the Postgres testcontainer
    run.cmd                                  # Postgres + Caddy in Docker, server on the host

Paw's browser is Firefox and it refuses Caddy's local certificate — give him
`http://127.0.0.1:3000`, not `https://localhost`.
