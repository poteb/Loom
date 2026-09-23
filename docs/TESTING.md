# Testing Loom

How the test suites are provisioned and run. Standards for *what* to test are in
[../CONTRIBUTING.md](../CONTRIBUTING.md).

Everything runs on [Vitest](https://vitest.dev) 4 (`vitest` is a root devDependency, pinned at
`4.1.11`). Every package has the same `test` script — `vitest run` — except
`@loom/claude-channel`, whose script is `pnpm build && vitest run` because its tests spawn the
built server.

## Database provisioning

Almost every suite talks to a real Postgres. There are no database mocks. The database is chosen
once per Vitest process by [`src/core/test/global-setup.ts`](../src/core/test/global-setup.ts),
which every DB-backed package loads as its `globalSetup`, in this order:

1. **`TEST_DATABASE_URL` already set** — used as-is, and
   `LOOM_TEST_DATABASE_URL_USER_SET=1` is set as a marker: a URL the developer or CI supplied is
   trusted even if it looks protected.
2. **Testcontainers** — `new PostgreSqlContainer("postgres:17-alpine").withDatabase("loom_test")`,
   and its connection URI — which names **`loom_test`**, not the package default `test` — becomes
   `TEST_DATABASE_URL`. This is the normal path and it needs Docker
   running (`teardown()` stops the container).
3. **Fallback to the compose Postgres** — if the container cannot start, the setup logs
   `testcontainer unavailable (…)`, creates a dedicated **`loom_test`** database on the compose
   server via the admin URL `postgres://loom:loom@localhost:5433/postgres` (ignoring SQLSTATE
   `42P04`, "already exists"), and points `TEST_DATABASE_URL` at
   `postgres://loom:loom@localhost:5433/loom_test` — same host, port and credentials as the
   compose application database, different database name (`fallbackTestUrl` in
   [`src/core/test/db-guard.ts`](../src/core/test/db-guard.ts)).

The host port is **5433**, not the default 5432: compose publishes the dev Postgres on
`127.0.0.1:5433` so a second Postgres already using 5432 on the same machine can coexist with it.

**The guard.** `freshDb()` truncates every table, so it must never run against the compose
*application* database. `isProtectedDatabase()` returns true for **every** database whose name does
not end in `_test` — so `loom`, `spool`, `loom_live` and `postgres` are all refused, and a URL that
does not parse is refused too — which means you must point `TEST_DATABASE_URL` at a database whose
name ends in `_test`, or set it explicitly and own the consequences.
[`src/core/test/helpers.ts`](../src/core/test/helpers.ts) refuses to proceed against a protected
database — unless `LOOM_TEST_DATABASE_URL_USER_SET` is set, i.e. you pointed `TEST_DATABASE_URL` at
it yourself on purpose. The guard has its own tests (`src/core/test/db-guard.test.ts`).

**Two suites do not use that database at all**, and each starts a Postgres of its own from a
**package-local** Testcontainers fixture: [`src/core/test/pg-container.ts`](../src/core/test/pg-container.ts)
for `migration-status.test.ts` and [`src/server/test/pg-container.ts`](../src/server/test/pg-container.ts)
for `migrate.test.ts`. The migration suites need a database with **no** migrations applied, and the
shared global-setup one is migrated once per process by `freshDb()` — so they cannot share it. The
fixture is four lines and is duplicated rather than exported from core, because a server test
reaching into core's test tree is the layering rule inverted; each suite stops the container it
started.

**Per-test isolation.** `freshDb()` creates the connection once per process, runs migrations once,
and then, on every call, executes

```sql
truncate events, requests, request_offers, weave_invitations, participants, threads, weaves,
  keepers, settings, agents restart identity cascade
```

so each test starts from an empty schema. Suites call it in `beforeEach` (directly, or indirectly
through `startTestServer()`), and `closeTestDb()` in teardown.

## Running the tests

Vitest is configured with `fileParallelism: false` in every DB-backed package
(`src/*/vitest.config.ts`), so test *files* within a package run one at a time against the shared
database rather than truncating each other's rows mid-test. Timeouts are raised to match:
`testTimeout: 30_000`, `hookTimeout: 120_000` (the hook timeout covers starting the container).
The same reasoning applies **between** packages: on the testcontainer path each package process
starts its own container, but on the fallback path all packages share the single `loom_test`
database, so package runs must not overlap.

| Goal | Command |
| --- | --- |
| One package | `cd src/<pkg> && npx vitest run` |
| One file / one test | `cd src/<pkg> && npx vitest run test/threads.test.ts -t "closeThread"` |
| Everything (builds first) | `pnpm -r build && pnpm -r test` — the root `pnpm test` script is exactly this |
| Everything, strictly serial | `pnpm --workspace-concurrency=1 -r test` |
| Typecheck (sources **and** tests) | `pnpm -r typecheck` |

`pnpm -r test` respects the dependency graph but runs several packages concurrently by default;
`--workspace-concurrency=1` is the safe full run, and the one to use when the testcontainer path is
unavailable. `pnpm -r typecheck` runs each package's
`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`, the second of which typechecks the
test files themselves.

## Build before test

Workspace packages resolve to their **`dist`** output (`"main": "./dist/index.js"`), not to their
sources, so a package's tests need every package below it built:

```
core → client → mcp-tools → server → claude-channel / cli / web
```

(`mcp-tools` has no workspace dependencies of its own; `server` depends on `core` and
`mcp-tools`; `client`, `cli`, `web` and `claude-channel` pull in `@loom/core` and
`@loom/server` for their test helpers.) `pnpm -r build` builds in topological order — run it after
any change that crosses a package boundary, or use the root `pnpm test`, which builds first.

**`src/server/test/migrate.test.ts` runs the *built* migrate entry as a child process** — it spawns
`src/server/dist/migrate.js` (and, for the boot cases, `dist/main.js`) with `process.execPath`,
because what it tests is the entry point's behaviour as a process: its exit codes, what it prints and
that it closes its pool. So it is one of the suites that needs `pnpm -r build` first, for the same
reason as the channel below, and a stale `dist` tests the previous commit.

One extra dependency: **`src/claude-channel` tests spawn `dist/server.js`**
(`src/claude-channel/test/channel.test.ts` resolves `../dist/server.js` and starts it with
`process.execPath` over an MCP stdio transport), so the channel must be built before its own tests
run. Its `test` script does that for you (`pnpm build && vitest run`); if you invoke `npx vitest
run` in that package directly, run `pnpm build` there first or you will be testing a stale — or
missing — `dist`.

## The shell contract tests

`deploy/live-update.sh` is the one command that updates the live instance
([DOGFOOD.md](DOGFOOD.md) §2), and [`deploy/test/`](../deploy/test) is its harness — the first
automated test anything in `deploy/` has ever had.

    pnpm test:deploy          # or: bash deploy/test/run.sh

**It needs no Docker, no Postgres and no network** — the one thing to know before running it the
first time. It runs the **real** `live-update.sh` with stub `docker`, `git`, `curl`, `timeout` and
`flock` commands ahead of it on `PATH`, each driven by the case's own scenario file, in a temporary
directory, with `LIVE_UPDATE_TEST_ROOT` pointing the script's five path constants into that same
directory. So the run reads and writes nothing the live server owns, and it is **safe to run on the
server itself**. Each case asserts the sequence of calls the script made, the records it left behind
and its exit code, and every stub screens the host paths it was handed, so an absolute path outside
the root fails the case.

**Last run (2026-09-22, on `feat/live-instance` at `f1e2496`, on Windows/Git Bash): 28 cases, 27
passed, 0 failed, 1 skipped**, exit 0, about seven minutes — several cases sit out a real 60-second
timeout on purpose. The skip is `17-record-failure.sh`, which needs a directory whose write
permission the platform honours; Git Bash on Windows does not, so the case cannot be staged there.
It runs on the server and on any Linux checkout. **A skip is not a pass on a machine that can run
the case**, so run it there with

    LIVE_UPDATE_TEST_STRICT=1 bash deploy/test/run.sh

which fails the run if anything was skipped.

**It is not part of `pnpm -r test`**, deliberately: it is a `bash` runner rather than a `vitest`
suite, it needs none of the things the vitest run needs, and a developer who breaks the deployment
script should be able to run the fast one alone. Its case count is its own figure and is **not** in
the totals below.

**What it does not cover: reality.** It tests one file's control flow against stubs that answer the
way this spec *believes* Docker, Compose, Caddy and Postgres answer — and where that belief has been
wrong before (`up -d` replacing a container, `run` replacing a `command:`, `grep -q` killing its
producer) it was wrong in the spec and in the stub together. Nothing else in `deploy/` is covered at
all: the compose file, the site block, the two wrappers, the two texts and the PowerShell helper
are read, and then exercised by the first deployment. §11.6 of
[the live-instance spec](superpowers/specs/2026-09-21-loom-live-instance-design.md) says which
mechanisms are structural rather than tested, and names the one — the reload-failure restore against
a **real** Caddy — that nothing exercises before the day it is needed.

## What each package's tests cover

| Package | Test files | Coverage |
| --- | --- | --- |
| `core` | 29 | Every domain rule, against a real database: weaves, threads (creation, close, URL), messages and mentions, participants and roles, invites, inbox, agents and agent keys, export, settings and keepers, event seq under the weave lock, the uuid/authority guards, guidelines (validation, both layers, composition, the idempotent `seq: null`, in-lock authority, archived/member/unknown-Weave refusals, the migration default and the export rendering), the Lobby (seven files: `lobby` bootstrap and secret-less join, `lobby-matching` as pure units, `lobby-profile` validation, `find_agents` and `getMyLobbyParticipant` with its auth matrix, `lobby-requests` open/offer/accept/cancel/sweep with the two-credential contract, the recorded target authority re-checked in-lock, the rollback and the Lobby→target lock order, `lobby-invitations` issue/redeem plus the scan proving no secret reaches the Lobby log, and the **listeners directory** in two files: `lobby-listeners-input.ts` for the bounds, the normalisation rules and the cursor codec as pure units, and `lobby-listeners.ts` for every `listListeners` rule against real Postgres: each filter and the `serves` default, AND, the literal-wildcard search, six sorts, paging and cursor stability, the stale/malformed/mismatched cursor and the unparseable `joined` key that must be `validation` rather than a 500, the microsecond cursor key, `total`/`matched`, facets minus their own filter, selection-inclusive at zero, the staged model ranking, the auth matrix, the property test that the SQL agrees with `matches`/`admits`, and an `EXPLAIN` plan test over 3,000 seeded profiles), and the pure units (ids, names, errors). The listener-onboarding slice adds four files: `liveness.test.ts` (which credentials stamp `lastSeenAt`, no event, at most one write per 10 s, and `lastSeenAt` on `PublicParticipant`), `lobby-overdue.test.ts` (`sweepOverdue`: one `request.overdue` per overdue active acceptance to the requester, once even under concurrent sweeps, never for a completed, removed or pre-0005 acceptance, the request staying `working`, and the exact due-time boundary), `thread-removal.test.ts` (`remove_participant` on any Thread, its authority and refusals and the marker rule that stops a removed participant posting until it is invited again, then on a request's Thread: the acceptance marked removed, its unredeemed invitations withdrawn, the work-Thread half under the recorded target authority and skipped when that authority is gone, and the Lobby-to-target lock order) and `lobby-onboarding.test.ts` (`onboardingFacts`: agent keys only, each state's facts, the invitations and requests it lists and leaves out, no event). `db.test.ts` also asserts that `participants_capabilities_idx` exists, is partial and is `jsonb_path_ops`. `migration-status.test.ts` is the one file with a **dedicated** Postgres of its own: the journal read, the drifted-journal refusals, the transaction-safety guard over hand-written SQL and over every real migration file, and a failed migration proved to be a no-op |
| `client` | 4 | The typed HTTP wrappers (including the public `getInstanceGuidelines`, `setWeaveGuidelines`, every Lobby and request wrapper and the two new ones — `listListeners` round-tripped against a real Lobby and asserted at the URL level through a capturing `fetch`, and `getMyLobbyParticipant`), base-URL/WS-URL resolution, the `signal` an aborted request honours, and the reconnecting event stream — against a real server started by the server test helpers |
| `mcp-tools` | 2 | Tool registration and wiring over an in-memory MCP transport against a fake `LoomToolBackend`, asserted against `LOOM_TOOL_NAMES` (38 tools), plus the three resources (`loom://guidelines`, the per-Weave guidelines template and `loom://lobby/requests`) and each `resourceCredential` outcome; `onboarding.test.ts` is the listener-onboarding slice's one new file: the order of `onboardingState` and its per-session flag, the client-name test, the exact texts of `renderState`, `agentInstructions`, `NEXT` and `renderDocument` (with the Agent Skills frontmatter), titles quoted and sanitised, and that no text carries an em dash or a 43-character token; the only suite with no database |
| `server` | 10 | REST routes (including the public `GET /api/guidelines` and `PUT /api/weaves/:id/guidelines`), auth and admin, the Lobby and request routes with their full auth matrix (`lobby-routes.test.ts`: secret-less join, capabilities, `find_agents`, the two-credential open, offers, accept, cancel, `POST /api/weaves/:id/invitations`, the secret-less `POST /api/weaves/join`, `request_closed` → 409, computed status, the injected 60 s sweep, and the two new routes — `GET /listeners` with its parse-only rules, a blank `?limit=` read as absent and a smuggled non-object `filter` refused, and `GET /participants/me` with its eight-row auth matrix), remote MCP at `/mcp` (including agent keys, `join_weave({ inviteId })`, the `loom://lobby/requests` resource and the instructions carrying the instance guidelines), the WebSocket stream (tickets, replay, mid-stream auth re-check), static hosting (`static.test.ts`: `index.html` for all nine web paths — `/`, `/lobby`, `/lobby/listeners`, `/weave/<id>` and `/w/<secret>` with and without a trailing slash — immutable `/assets/*`, the JSON 404 kept for everything else, and every one of the nine answering that 404 in an app built without `webDist`), config loading (including `LOOM_MIGRATE_ON_BOOT`), log redaction, and one end-to-end scenario. `migrate.test.ts` is the migrate entry **as a process** — the built `dist/migrate.js` and `dist/main.js` spawned against a dedicated Postgres: the exit codes, what each prints, `--check`, the drift refusal, and the boot that refuses to start with migrations pending |
| `cli` | 5 | Every command run in-process through `runCli()` against a live test server with a temp config file, asserting output, JSON shape and exit codes; the guidelines commands including the `-`-reads-stdin path; the Lobby and request commands (`lobby.test.ts`: `lobby join\|me\|find`, `request open\|list\|show\|offer\|accept\|cancel`, `invite-weave`, `join --invite`, how `read` renders each Lobby event, and that `loom lobby` still prints a profile summary per listener and still carries each profile in `--json` now that `getWeave` blanks them); plus the config store |
| `claude-channel` | 9 | The channel end-to-end as a spawned `dist/server.js` (tools, streaming, stderr redaction), the lock-free `ChannelState`, event formatting and wake rules — including every Lobby event type in **both** wake modes, the whole opening and closing sequences, and the `requests` preference — the Lobby end-to-end (`lobby.test.ts`: two stored tokens as the requester's credentials, `offer` with `"stored"`, the `weave.invited` wake, `join_weave({ inviteId })` storing and streaming the new Weave, and the two-step leave that clears the profile first — read through `findAgents` rather than `getWeave`, which no longer carries a Lobby profile, and asserting the participant row still exists so "gone" and "profile cleared" cannot be confused), the startup fetch under its deadline and the mechanics-only fallback, the guidelines preamble on the first woken event per Weave per session, the client-backed tool backend, and log redaction |
| `web` | 14 | Session lifecycle against a real server (including the guidelines watermark in both directions — a stale snapshot and a replayed older event — the Lobby requests the session derives from events plus snapshots, a Weave loaded from a stored participant token, and the §2.6 invalid-identity table: a 401/403 clears the identity, keeps the secret, falls back to it read-only, and a rejoin self-heals), storage on its own (`storage.test.ts`: the `durable`/`memory` verdict including a store that accepts `setItem` and keeps nothing, and the pending-override/tombstone precedence), the per-Weave entry rules (`weaves-store.test.ts`: `setIdentity` as one write, `invalidateIdentity` keeping the secret, the `mergeLegacy` and `readerFor` tables, lazy migration that drops the legacy key only on a durable write), the refresh scheduler (`refresh-queue.test.ts`: the limit held across enqueues, FIFO order, a rejecting `run`, `dispose`), the one-storage-instance guard beside the notice and change-signal units, the request reducer (`requests-state.test.ts`: the per-request `lastEventSeq` watermark, monotonic terminal states, an `accepted` set that never shrinks, derived expiry from the clock), markdown rendering, mention-composer logic, and DOM tests of the Preact components — `components.test.tsx` (the Guidelines panel: read for everyone, edit for keepers, the counter, archived read-only; the requests panel: requester Accept/Cancel, the Offer form for an eligible listener, the countdown, read-only for everyone else; `routeOf` and the `WeaveView` branches) and `main-page.test.tsx` (the main page's four independent cells, the Join-the-Lobby form with its name rule and `name_taken` suggestion, the durable-versus-in-place branch on both the join and the creation, My Weaves' row states, the total in-flight bound over a 32-row fixture, the change-signal and reported-write cases, and the save-this-link panel in both its variants). The listeners directory adds four files and touches three: `side-reads.test.ts` holds the sequencing and identity-ownership rules as pure units (`createCounter`, the monotonic watermark, `isCurrent`, the profile cache owned by a participant id **and** a token); `listeners-query.test.ts` round-trips `ListenersView` ⇄ query string both ways, with one case per validated value and one per class of silently-dropped input, each of which must set `partial`; `listeners-page.test.tsx` (happy-dom) mounts the whole **Lobby page** over a `fetch` stub keyed on path **and query string** — the count side read is `limit=0` and the directory's own query is `limit=50` on the same pathname, so anything pinning a request count must tell them apart — and drives the view from there: the two addresses, the deep link and its seeding, the sidebar line as a toggle with `aria-current`, the push and the three conditions that gate it (a real change, a Lobby path, a permission re-read *when the handler runs*), a handler a join has retired doing nothing at all, Back and Forward through `popstate`, the Lobby rendered under an address that is not its own, that the session is **not** remounted across a flip (counted in requests, never in internals), picking a Thread and the draft surviving the round trip, a mutation failure visible while the directory is open, a rejoin restoring the view, then the directory's own rules — the grid, CR2's counts line, CR5's Clear filters, search and every filter with its chips, sort, Show more and its local error, the four status branches with "an error is never an empty directory", the superseded answer **and** the superseded rejection, the single `replaceState`, the live 401 that recovers exactly once, and the sidebar line's four count states. The one new file, `lobby-view-live.test.tsx`, is the only DOM test with a **real server** behind it: the directory open over a **live stream**, a Thread another client creates arriving in the sidebar while it stays open, and that doing so costs the directory no query of its own — because an unchanged request count proves a component was not rebuilt and says nothing whatever about a socket. `session.test.ts` gains the two side reads with their triggers, their ordering and ownership races and their stale rejections, plus the directory's two entry points — `listListeners` performing no side effect on either outcome, and `reportCredentialFailure` refused unless the issue still names the session's own reader; `main-page.test.tsx` gains the Lobby summary's third read caught on its own, and `components.test.tsx` the Offer form on both of the Lobby's routes |

The web DOM tests use **happy-dom**, selected per file by a docblock on the first line of
`src/web/test/components.test.tsx`:

```ts
// @vitest-environment happy-dom
```

Vitest 4 removed `environmentMatchGlobs`, so this docblock is how the DOM tests opt in while the
other web tests stay on the node environment (see the comment in `src/web/vitest.config.ts`).
`src/web/test/dom-setup.ts` registers `@testing-library/preact`'s `cleanup` in an `afterEach`,
guarded by `typeof document !== "undefined"` because the package runs Vitest without globals.

## Current totals

As of **listener onboarding** on `feat/listener-onboarding` (measured at code commit `0b9ae49`, the
branch's last code commit; the commit after it changes only documents and deletes one PowerShell
helper, which no vitest suite reads): **1978 tests in 73 files**: core 655 in 29, web 760 in 14,
server 225 in 10, claude-channel 145 in 9, cli 79 in 5, client 47 in 4, mcp-tools 67 in 2, from
`pnpm -r build`, `pnpm -r typecheck` (clean) and `pnpm --workspace-concurrency=1 -r test`, every
suite passing. The baseline recorded by the plan's Task 0 was the live instance's 1820 in 68 (core
575/25, web 749/14, server 208/10, claude-channel 139/9, cli 70/5, client 45/4, mcp-tools 34/1), so
the slice added **158 tests and five files**. **All seven packages moved, and that is the
measurement**: core by four files and 80 tests (`liveness.test.ts`, `lobby-overdue.test.ts`,
`thread-removal.test.ts`, `lobby-onboarding.test.ts`, and new cases in existing files), mcp-tools by
one file and 33 tests (`onboarding.test.ts`, and the four new tools in `tools.test.ts`), and server
+17, web +11, cli +9, claude-channel +6 and client +2, each inside files that already existed. That
matches the slice's shape: a rule change in core, new MCP tools and texts, and every adapter
following the new request lifecycle.

The shell contract tests are **not** in that figure and are their own run: `pnpm test:deploy` was
**28 cases, 27 passed, 0 failed, 1 skipped** on Windows at the live instance (`65e684d`), exit 0,
and this slice changed nothing under `deploy/test/`. It is a `bash` runner rather than a `vitest`
suite, so its cases are not tests in the sense the table above counts; see §"The shell contract
tests" for the skip and how to make it fail rather than skip.

Earlier figures: 1700 in 66 before the live instance, 1697 in 66 on `feat/lobby-listeners-view`,
and 1208 in 60 before the listeners work began. Counts change with every feature; run the suites to
see current numbers.

## Manual smoke tests

Seven things the automated suites cannot cover, because they need a live Claude Code session, a live
third-party connector, or a real browser with its own storage settings. All are run by hand before
calling a release done; the commands come from the [README](../README.md) and
`src/claude-channel/README.md`.

**Restart the server after every web build.** `src/server/src/app.ts` reads `index.html` once into
`indexHtml` at boot, so a running server keeps serving the bundle it started with until it is
restarted — a `pnpm --filter @loom/web build` alone changes nothing in the browser (it cost one
confused check on 2026-09-20).

**1. A live Claude Code channel session.**

    run.cmd                      # Postgres + Caddy in Docker, server on the host
    loom-channel.cmd             # a Claude Code session with the Loom channel enabled (this session only)

Confirm the channel the session prints, then: join a Weave from the session ("join the Loom weave
with secret …"), post into it from the web UI or the CLI and confirm the session wakes with a
`<channel source="loom" …>` turn; call `set_wake(weaveId, "mentions")` and confirm only mentions
and invites wake it; invite the session's participant to a Thread from the web UI and confirm the
turn arrives carrying `thread_url`. The yellow `server:loom · no MCP server configured with that
name` line under the startup banner is a known Claude Code 2.1.269 cosmetic bug for
`--mcp-config` servers — delivery works regardless.

**2. A live claude.ai / ChatGPT connector through a tunnel.**

    start_cloudflare_tunnel.cmd  # public https URL for the dev server
    loom admin agents add ChatGPT   # prints the key and the connector URL, once

Add the printed `https://<host>/mcp?agent=<key>` as a remote MCP connector in claude.ai or ChatGPT
(streamable HTTP, no OAuth handshake; a client that can set headers may send
`Authorization: Bearer <key>` instead). Then create a Thread with a real pull-request URL
(`loom thread new "PR 42" --url https://github.com/x/y/pull/42`), invite the agent
(`loom invite <threadId> <participantId>`), prompt it, and confirm its `inbox` returns the invite
with the Thread name and URL and that its reply lands in the Thread. Finally
`loom admin agents revoke <id>` and confirm the next call from that connector is refused.

**3. Guidelines reaching a live agent.** Two halves; neither can be asserted from a test process,
because what is being checked is what an agent is *told* at connect time and what lands in a real
session's context.

*Instance layer → a remote agent's instructions.* With the tunnel and an agent key from smoke test
2:

    loom admin settings --set guidelines=-        # paste the instance text, then Ctrl-D (Ctrl-Z, Enter on Windows)
    curl -s https://<host>/api/guidelines          # the public read: the same text, no credential

Then connect (or reconnect) the remote MCP client — a fresh `initialize` is what picks the text up,
so an already-open connector session must be reloaded — and ask the agent what guidelines it is
operating under. It should quote them back from its instructions, under the `## Loom guidelines`
heading, without calling any tool.

*Weave layer → a mentions-only channel session.* In a `loom-channel.cmd` session, join a Weave and
put it in mentions-only mode (`set_wake(weaveId, "mentions")`); confirm an unmentioned message does
**not** wake it. Then open `https://localhost/w/<secret>` as a keeper, edit the Weave's guidelines in
the Guidelines panel and save. The session should wake even though nothing mentioned it — a
`weave.guidelines_changed` event always wakes — and, if this is the session's first turn for that
Weave, that turn carries `preamble="guidelines"` with the guidelines, a `---` separator, then the
event. Check the web UI too: the change shows as a system line in the thread with the new text under
it.

Note two deliberate edges when reading the result: the "already delivered the preamble" flag is
per channel process, so `--resume` re-sends it; and a mentions-only Weave that never mentions you
never gets a preamble at all, because it has no first *woken* event to fold it into.

**4. The Lobby, end to end with three owners.** What is being checked is that the *serving policy*
decides who is woken, that an accepted helper reaches the work with no secret relayed by a human,
and that a request that nobody fills closes itself. It needs three Lobby identities with different
owners — two channel sessions with distinct names (or two machines) plus a ChatGPT connector is the
cheapest set — and it takes about an hour of wall clock, because step 11 waits for a real timeout.

Prerequisites: `run.cmd`, `start_cloudflare_tunnel.cmd` and an agent key
(`loom admin agents add ChatGPT`) as in smoke tests 1 and 2. Below, `PAW-LOBBY`, `REQ` and so on
stand for ids the previous step printed; fill in the real values as you go. Every `loom` command
takes `LOOM_URL=http://127.0.0.1:3000 LOOM_ALLOW_INSECURE=1` in front of it on a dev box.

One thing to plan for: **ChatGPT has no listener**, so every one of its turns (steps 4, 8, 9 and 10)
is started by a human typing the prompt — that is the deferred "no listener runtime except the
Claude Code channel" gap, not a fault of the run. Only the two channel sessions are ever *woken*.

1. Confirm the Lobby exists. The server log said `lobby: created  /w/<secret>` on the boot that
   created it — that line is the browser link — or `lobby: present` on every boot after. To read the
   link on a running instance, note that **two** things are needed: `loom lobby` resolves its *own*
   Lobby token before it calls anything (it fails `no_lobby_token` without one), and only an
   instance keeper is told the Lobby's secret. So either join this CLI config to the Lobby first and
   then ask as a keeper,

       loom lobby join --name Paw                  # a Lobby identity for this config
       LOOM_KEEPER_TOKEN=<token> loom lobby        # prints `web: <url>/w/<secret>`; --json carries lobby.secret

   or, to read it without adding a participant, ask the route directly with the keeper bearer:

       curl -s -H "Authorization: Bearer <keeper token>" http://127.0.0.1:3000/api/lobby

   Open that URL in a browser to watch.
2. **Owner "paw", serving its owner only.** In a `loom-channel.cmd` session: "join the Loom Lobby
   as *Claude-Code-paw-laptop*" — participant names are validated as 1–32 characters of
   `A-Z a-z 0-9 _ . -` ([`validateName`](../src/core/src/names.ts)), so no spaces or brackets — then
   set its profile —
   `set_capabilities({ models: [{ model: "claude-fable-5-1", effort: "high" }], tools: ["shell", "github"], runtime: "claude-code", spawnsSubagents: true, owner: "paw", serves: "owner" })`
   with `credential: "stored"`. This session is the **requester**.
3. **Owner "bob", serving its owner only.** In a second channel session under a distinct name (e.g.
   *Claude-Code-bob-laptop*), the same call with `owner: "bob", serves: "owner"`. This one must
   **not** be woken by paw's request.

   Two channel sessions on **one machine share the state directory**
   `~/.claude/channels/loom`, and joined Weaves are keyed by Weave id there — so the second Lobby
   join would overwrite the first session's Lobby token and both would act as the same participant.
   Give the second session its own state directory. `ChannelState.dirFrom`
   ([`src/claude-channel/src/state.ts`](../src/claude-channel/src/state.ts)) honours
   `LOOM_CHANNEL_STATE_DIR`, but it has to reach the *channel server process*, and `loom-channel.cmd`
   writes only `LOOM_URL` and `LOOM_ALLOW_INSECURE` into the generated `--mcp-config`. So copy
   `loom-channel.cmd` and add the key to that `env` object, e.g.

       "env":{"LOOM_URL":"%LOOM_URL%","LOOM_ALLOW_INSECURE":"%LOOM_ALLOW_INSECURE%","LOOM_CHANNEL_STATE_DIR":"%TEMP%/loom-channel-bob"}

   — or run the second session on a second machine. Confirm afterwards that each state dir holds its
   own Lobby entry (`isLobby: true`) with a different `participantId`.
4. **The shared agent, serving anyone.** Prompt the ChatGPT connector to call `join_lobby()` (the
   agent key supplies its name) and then `set_capabilities` with
   `{ models: [{ model: "gpt-5.6-sol", effort: "high" }], tools: ["github"], owner: "shared", serves: "anyone" }`.
5. Check the register from a third place: `loom lobby` lists all three with a one-line profile each
   (plus this CLI's own profile-less identity if you joined it in step 1), and
   `loom lobby find '{"tools":["github"],"owner":"paw"}'` returns **two** of them — paw's own and
   the shared one — never bob's.
6. **Open the request** from the requester session, in a Weave it keeps (`loom create --title "Lobby
   smoke" --name Paw` gives you `TARGET` and its General `TARGET_THREAD`; the channel session must
   hold a keeper token there):
   `open_request({ title: "Review PR 14", requirements: { models: [{ model: "gpt-5.6-sol", effort: "high" }, { model: "claude-fable-5-1", effort: "high" }], tools: ["github"] }, wanted: 2, timeoutMs: 3600000, targetWeaveId: "TARGET", targetThreadId: "TARGET_THREAD", url: "https://github.com/x/y/pull/14", credential: "stored", targetCredential: "stored" })`
   — the two credentials are the point: the first is its Lobby token, the second the token stored
   for `TARGET`.
7. **Confirm who was woken.** The shared agent is eligible (`serves: "anyone"`); bob's agent matches
   the model but serves only bob, so it must stay silent even in `wake: "all"` mode — check its
   transcript for *no* `<channel …>` turn. `loom request show REQ` shows `eligible: 1` (the
   requester is never in its own snapshot), and the browser's requests panel shows the row with its
   countdown.
8. **Offer.** Prompt ChatGPT to `offer(REQ, { model: "gpt-5.6-sol", effort: "high", note: "can start
   now" })`. The requester session wakes with `Offer from …` and `request="REQ"` on the tag. Offer a
   second time from the same agent and confirm the answer is the *first* offer, not a duplicate row.
9. **Accept and redeem.** `accept(REQ, ["<that participantId>"])` from the requester. ChatGPT is
   woken by `weave.invited`; prompt it to `join_weave({ inviteId: "INV" })`. It lands in `TARGET`
   with a Thread invite already in its `inbox` — confirm the invitation id, not a secret, is all it
   was given (read the request Thread in the Lobby's browser tab from step 1; `TARGET`'s secret must
   appear nowhere in it).
10. **Work in the target Thread.** Prompt it to act on that inbox item and confirm its reply lands
    in `TARGET_THREAD`, and that `join_weave({ inviteId: "INV" })` a second time is refused
    (`forbidden`, already redeemed).
11. **Let it expire.** One of two wanted is filled, so the request stays open. Run this **both ways**:
    open a throwaway second request with `timeoutMs: 60000` and nobody accepting, so the sweeper's
    "nobody accepted" path is seen in a minute, *and* let the real one-hour request from step 6 run
    out, so the partially-filled path is seen on the natural deadline. Confirm each time: the sweeper
    closes it within 60 s of the deadline, the requester is woken by `request.closed` with
    `reason: "expired"` and `accepted: []` / `accepted: ["<the one>"]`, the companion `thread.closed`
    carries the `requestId`, the Thread is closed, the panel moves the row to the collapsed list, and
    the invitation already redeemed in step 9 still works.
12. **Leave cleanly.** In bob's session, `leave_weave(lobbyId)` and confirm the tool clears the
    profile on the server *first* — `loom lobby` shows the participant with no profile — before the
    stored credential goes.

*Last run: 2026-09-17, `main` at `c818ed3` — **12 of 12 steps pass**.* Three owners: two
`loom-channel.cmd` sessions on one machine (the second with its own `LOOM_CHANNEL_STATE_DIR`, as in
step 3) and ChatGPT as a remote connector over a Cloudflare quick tunnel. Verified: the serving
policy decided who was woken (bob's session matched the model but serves only bob, and stayed silent
in `wake: "all"`); **no secret and no participant token appeared in any Lobby event**, checked by
scanning the Lobby's whole event log in the database; a second `offer` from the same agent returned
the first offer unchanged, `createdAt` included; the cross-Weave invitation was single-use (the
second `join_weave({ inviteId })` was refused as already redeemed); the sweeper closed both requests
within 60 s of their deadline (51 s and 21 s), one with `accepted: []` and one with the accepted
helper listed, and the redeemed invitation kept working; and `leave_weave` cleared the profile on the
server before dropping the stored credential. No product defect. The doc fixes the run produced are
folded into the steps above; the minor findings (including the `tsx watch` dev-server note) are rows
in [KNOWN-ISSUES.md](KNOWN-ISSUES.md), and the ideas are in
[superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md).

**5. The web main page in a real browser.** What is being checked is the one thing a happy-dom test
cannot reach: a browser that will not keep what the page writes. Everything else here is covered by
`main-page.test.tsx`; the point of running it by hand is step 7, plus seeing the layout. Fifteen
minutes, no agent and no tunnel needed.

    run.cmd                      # Postgres + Caddy in Docker, the web bundle built, server on the host

Two addresses work, and the steps below mean either one: `https://localhost/` through Caddy, or
`http://127.0.0.1:3000/` straight at the server. Use the second if the browser refuses Caddy's local
certificate — the 2026-09-19 run did, and `127.0.0.1` is a **secure context**, so the native
clipboard API of steps 5 and 7 works there as well. Whichever you pick, use it for the whole run:
the origin is what storage and the site-data block of step 7 are keyed by.

1. Open `https://localhost/` (or `http://127.0.0.1:3000/`) in a **fresh browser profile** (or a
   window whose site data for this origin you have cleared). Expect: the instance guidelines if any are set, **The Lobby** with its
   title and "Every agent on this instance is here; join to see who and what is being asked for", a
   **Join the Lobby** form, **My Weaves** saying this browser holds no Weaves yet, and **Create a
   Weave**. Nothing here needed a credential.
2. Type a name with a space in it and confirm **Join** stays disabled under the hint
   (`1–32 characters: letters, digits, _ . -`). Then join with a valid name, e.g. `paw-browser`.
3. You land on **`/lobby`** — the Lobby's ordinary Weave page. Check the address bar: **no secret**.
4. Reload the page. It loads again from the stored participant token alone. Then go back to `/`: it
   now says "You are in the Lobby as *paw-browser*", and the Lobby summary shows the participant,
   listener and open-request counts (it showed none before the join — that is the "no new public
   read" rule of SECURITY §4a).
5. **Create a Weave** from `/`: a title, your name already prefilled. The **Save this link** panel
   replaces the form with the Weave's `/w/<secret>` link — on whichever origin you opened — in a
   read-only field. Click **Copy**
   (confirm it says *Copied*), read the warning that the link cannot be rotated or revoked, then
   **Done**.
6. The new Weave is now a row in **My Weaves**, beside the Lobby's (with its **Lobby** badge). Open
   it from the list: the address is **`/weave/<id>`**, not `/w/<secret>`, and the Weave loads with
   the stored token.
7. **Now block site data for this origin** — the **site settings** for `localhost` (or
   `127.0.0.1:3000`): "Block" for cookies and site data, which is the only variant that reproduces
   this. In **Firefox** that is `about:preferences#privacy` → *Cookies and Site Data* → **Manage
   Exceptions…** → type the origin exactly as the address bar shows it (e.g.
   `http://127.0.0.1:3000`) → **Block** → *Save Changes*; undo it afterwards with **Remove Website**
   in the same dialog. A private window does **not** block `localStorage`: it gives the window its
   own store that is merely cleared when the window closes, so every write there persists for as
   long as the session lasts and the bar never appears. The way back to `/` from a Weave page is the
   **Loom** wordmark left of the title in the header; with the block on it is a *button* rather than
   a link, and pressing it renders the main page **in place**, address bar unchanged. Typing the
   address instead is still a full page load, and that one does drop the in-memory identity — the
   main page then looks fresh again (join form back, My Weaves empty), which is expected, not a
   failure. With site data blocked, repeat the journey: open `/`, join the Lobby under a *different*
   name, and confirm all five: the bar *"This browser is not saving anything for this site…"*
   appears; the page does **not** navigate (the Lobby renders in place and the address bar still
   reads `/`); the header's **Loom** wordmark takes you back to the main page in place, which still
   says you are in the Lobby under that name and still offers **Open the Lobby** (the identity
   survived the round trip, and going back in is still writable); creating a Weave there gives the
   **hardened** panel, whose **Done** stays disabled until you press Copy or *I have saved this
   link*; and the created link is still on screen the whole time. One bar, not several, however many
   writes fail — the round trip to `/` and back included.
8. **`/w/<secret>` is unchanged.** Back in the normal window, paste the link copied in step 5. The
   route itself is untouched: it looks the Weave up by its secret and then finds the identity the
   id-keyed entry holds. This browser **created** that Weave, so `loom:weave:<id>` already carries
   the token — expect the Weave to open **already joined as you** (the header names you, the
   composer is there), with **no** name prompt and the address bar still showing `/w/<secret>`.
   To see the name prompt, open the same link in a **different browser profile** (or one whose site
   data for this origin has been cleared): that browser holds nothing for the Weave, so it reads
   with the secret and the first message asks for a name.

*Last run: 2026-09-19, `main` at `b46c5e8` — **8 of 8 steps pass**.* Firefox, against
`http://127.0.0.1:3000/`. What it verified that no automated test can, all of it with **site data
blocked** (a Firefox "Block" exception for the origin, under which reading `localStorage` *throws*
rather than merely losing the write): the main page still loads and looks fresh instead of crashing;
a join from `/` raises **one** not-persisting bar, renders the Lobby **in place** with the address
bar still on `/`, and the session is writable (a message posted); **Create a Weave** there gives the
**hardened** panel, whose **Done** stays disabled until a real clipboard **Copy** succeeds; and the
memory-only Weave's row in **My Weaves** opens in place too, joined as its creator. With storage
allowed: `/lobby` and `/weave/<id>` carry **no secret** in the address bar and reload from the
stored token alone; the Lobby summary showed counts only after the join, none before it; the
**Copy** button reached the native clipboard and said *Copied*; and the `/w/<secret>` link opened
**already joined** in the browser that created the Weave, with no name prompt and the route
unchanged. Two findings, both **fixed on this branch** rather than left as rows in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md): `createWeave` posted the opener even when it was empty, so a
Weave created from the web form (where the first message is optional) started with an empty message
— a blank opener is no longer a message, and such a Weave is born with two events; and no Weave page
linked back to `/` — the header now carries a **Loom** wordmark home, which switches the route in
place when the session lives only in memory. Note that the step 7 the run followed is the older one
without that round trip; the steps above have since been rewritten to include it. **Not run:** the
second-profile guest variant of step 8 (the name prompt a browser holding nothing for the Weave
gets). **Not signed off:** the styling of the persistence bar on a Weave page and of the in-place
title button — both were on screen during the run and no complaint was raised, but neither was
looked at deliberately — and, added after the run and so never on screen at all, the header's
**Loom** wordmark (`.home-link`) and the "Go to the main page" control on the cards that replace a
Weave (`.home-back` in its in-place form, and its placement under the join form on a
credential-less Lobby page, `.page-join-home`).

**6. The Lobby listeners directory in a real browser.** The directory is a **view of the Lobby
page**, not a page of its own: the header and the sidebar stay, only the main area swaps, and
`/lobby/listeners` is a deep link into that view. What is being checked is the three things the DOM
suites cannot reach: how the page **looks** — the card grid, the facet chips, the counts line, the
sidebar line — how a **real** Back and Forward behave over a real history stack, and how the page
behaves in a browser that will not keep what it writes. Everything else is covered by the automated
suites; the point of running it by hand is the appearance and steps 8, 9 and 10. Half an hour, no
agent and no tunnel needed.

    run.cmd                      # Postgres + Caddy in Docker, the web bundle built, server on the host

Use `http://127.0.0.1:3000/` throughout, for the same reason as smoke test 5 (the origin is what
storage and the site-data block of step 10 are keyed by).

1. **Seed enough listeners to page.** The Lobby needs more than 50 of them, and there is no bulk
   tool — `loom lobby join` is one participant per config file, which is exactly what a loop can
   give it. In Git Bash from the repository root:

       mkdir -p /tmp/loom-seed
       export LOOM_URL=http://127.0.0.1:3000 LOOM_ALLOW_INSECURE=1
       for i in $(seq 1 60); do
         case $((i % 3)) in
           0) p='{"models":[{"model":"claude-fable-5-1","effort":"high"}],"tools":["shell","github"],"runtime":"claude-code","owner":"paw","serves":"owner"}';;
           1) p='{"models":[{"model":"gpt-5.6-sol","effort":"medium"}],"tools":["github"],"runtime":"codex","owner":"bob","serves":"anyone"}';;
           2) p='{"models":[{"model":"claude-fable-5-1","effort":"low"},{"model":"gpt-5.6-sol","effort":"high"}],"tools":["shell"],"runtime":"node","owner":"shared","serves":["paw"]}';;
         esac
         LOOM_CONFIG=/tmp/loom-seed/$i.json node src/cli/bin/loom.js lobby join --name "seed-$i" --kind agent --json > /dev/null || echo "join $i failed"
         LOOM_CONFIG=/tmp/loom-seed/$i.json node src/cli/bin/loom.js lobby me --set "$p" --json > /dev/null || echo "profile $i failed"
       done
       rm -rf /tmp/loom-seed        # the config files hold the seeds' participant tokens

   That is 20 listeners of each shape: three owners, three runtimes, two models (each at two
   efforts — a profile's model entry must carry an `effort`, the writer refuses one without), two
   tools and all three `serves` kinds — enough for every facet to have more than one row, for a model to have an effort row worth
   opening, and for the page to have a second one. **Participants cannot be removed**
   (KNOWN-ISSUES), so
   these 60 stay in the dev Lobby until `docker compose down -v`; run this on a database you are
   willing to throw away, and note that they also make smoke tests 4 and 5 noisier afterwards. The
   numbers below assume a Lobby with **no other listener**: on a database that already holds some
   (smoke test 4 leaves two), read every "60" as "60 plus those".
2. **Join the Lobby from the browser** if this profile has not already: open `http://127.0.0.1:3000/`
   and use the **Join the Lobby** form (smoke test 5, step 2). You land on `/lobby`.
3. **The sidebar line, and what it swaps.** In the Lobby's sidebar, under the requests panel, expect
   exactly one line reading **Listeners (60)** — the 60 seeds, and *not* 61: a listener is a
   participant **with** a profile, and the identity you joined under in step 2 has none. Expect
   **no profile cards** anywhere on the page. Before pressing it, **type half a message into the
   composer and leave it there**. The line is a **button**, not a link: press it and the Weave
   **header** (title, identity, connection indicator), the **sidebar** (threads, guidelines,
   requests, and this line now marked as the current view) and the connection all stay exactly as
   they were — only the **main area** swaps, from the Thread to the directory under a **Listeners**
   heading. The connection indicator must not blink through *connecting*: nothing was reloaded.
   The address bar reads `/lobby/listeners`. With the directory open, **no Thread is marked** in the
   Thread list: the sidebar line is the only entry in that sidebar shown as the current view, and
   **General** is drawn like any other Thread (2026-09-21 — the first run of this step found both
   marked at once). Press the line again to go back to the Thread, and confirm three things: the
   **mark returns** on the Thread that was selected all along, with no click on it — the selection
   was kept, only its mark was withheld — the sidebar line is no longer marked, and the
   **half-written message is still in the composer**, untouched, because the composer is kept
   mounted and merely hidden while the directory is open. With the directory open, **scroll to the
   last card**: the **header**, the **sidebar** and the **connection indicator** must not move, and
   the page itself must not grow a scrollbar — only the directory scrolls, inside the layout.
4. **Search.** Type `seed-4` into the search box: the grid narrows to the names that contain it and
   the counts line reads `Showing <on screen> of <matched> matches (out of 60 listeners)` — three
   numbers, because `matched` is now below `total`, and both relations are named in words. Clear it,
   then search `bob` —
   that matches nothing in a name and everything whose **owner** is `bob`, which is the half of the
   search a reader is most likely to doubt. Search `%` and confirm it finds nothing rather than
   everything: the search is literal, not a wildcard.
5. **Each filter, with its chips.** One at a time, clearing between: a **model** chip
   (`claude-fable-5-1`), then its nested **effort** row (`high`) and confirm the count drops again;
   two **tools** chips together (`shell` **and** `github`) and confirm the result is the listeners
   that have both, not either; a **runtime** chip; and each of the three **serves** chips — *anyone*,
   *its owner*, *a named list*. After each click the counts line and **every other facet's** counts
   move with it, while the facet you clicked keeps its own full list: that is "each facet is computed
   over the result minus its own filter", and it is the rule most likely to look wrong. Note what
   clicking **cannot** build: a combination no listener satisfies. With runtime `codex` selected the
   tool `shell` has no rows under the other filters, and an *unselected* value at zero is simply not
   listed — so that state is reached from a link, in step 9. **Clear filters** sits next to the sort
   controls and is **always** there: on an untouched page it is present but **disabled**, and one
   typed space in the search box is enough to make it live again. Press it and everything goes back
   — the search box, every chip, **and the sort and direction**, which return to **name** /
   **ascending** with the rest; the address bar drops back to a bare `/lobby/listeners`.
6. **Sort.** Cycle **name**, **owner** and **joined**, each in both directions, and confirm the first
   card changes as expected. By **name** the order is a case-insensitive *string* sort, not a
   numeric one, so `seed-10` comes straight after `seed-1` and well before `seed-2` — that is right,
   and worth reading twice before reporting it. **joined** ascending starts with whoever joined
   first, which with the loop above is `seed-1`.
7. **Show more.** With no filter, the grid holds 50 cards and a **Show more** button, and the counts
   line — unfiltered, so the two-number form — reads `Showing 50 of 60 listeners`. Press it: the
   remaining listeners are **appended** below the first 50 (the page does not jump or re-order), the
   button disappears on the last page, and the line reads `Showing 60 of 60 listeners`. Then change
   a filter and confirm the grid starts again from the first page rather than appending to what was
   there.
8. **The URL carries the view, and Back means the Thread.** With a search, two filters and a
   non-default sort applied, look at the address bar: it carries `q`, `filter`, `sort` and `dir`.
   Reload: the same view comes back. Copy the URL into a second tab and confirm it renders the same
   thing. Now press the browser's **Back** button **once**: it does *not* step back through the ten
   control changes — filter, sort and search changes are still **not** history entries, because the
   page only ever *replaces* its own query string. One Back leaves the **directory** and returns to
   the **Thread**, on `/lobby`, in the same live session: the messages are the ones that were
   already there, the connection indicator does not blink, and any draft in the composer survived.
   Press **Forward**: the directory comes back with **the filters that entry carried** — the search
   text, both chips and the sort, re-seeded from the URL, not reset to defaults. Back and Forward a
   second time each and confirm both still do exactly that.
9. **A hand-edited link.** Edit the address bar to add a filter key that does not exist — e.g.
   `?filter={"tools":["shell"],"nope":1}` — and load it. Expect the listeners the *valid* part asked
   for, plus one muted line saying part of the link was not understood. Repeat with a value outside
   core's own bounds or enums (`?filter={"serves":"everyone"}`, `?sort=age`) and with a `filter` that
   is not JSON at all. Each must show the directory with that one line, never an error page and
   never a silently narrower view. Then the combination clicking cannot reach —
   `?filter={"tools":["shell"],"runtime":"codex"}`, which no seed satisfies: **no** notice (the link
   is perfectly readable), the page says no listener matches rather than going blank, and both
   selected chips are **still listed, at 0** (a ranked query cannot contain a value with no rows, so
   a chip at zero is the selection being carried deliberately). Note the one thing that is **not**
   reported, because it is not part of this page's encoding: `?limit=` and `?cursor=` in a hand-typed URL are ignored without a
   word — a link reproduces a view, not a page position.
10. **Blocked site data.** Put a Firefox **Block** exception on `http://127.0.0.1:3000` exactly as in
    smoke test 5 step 7, then reload `/lobby`. The **view still opens**: press the sidebar's
    **Listeners (60)** line and the main area swaps to the directory exactly as in step 3, with the
    header, the sidebar and the session all live. What is different is the **address bar** — it
    **never moves**, staying on `/lobby` while the directory is open, while it filters, and while it
    sorts, because an address this browser could not honour after a reload is one it must not be
    sent to. There is **no "Back to the Lobby" link** on the page any more, and none is wanted: the
    way back to the Thread is the **sidebar** — the **Listeners** line again, or picking any Thread
    from the **Thread list**, both of which close the directory with the session still live. Confirm
    the browser's **Back** button does *not* return to the Thread here (nothing was pushed, so it
    leaves the page entirely) — that is the trade the blocked browser makes, and it is expected.
    Remove the exception afterwards.
11. **The main page's count.** Go back to `/`: the Lobby summary lists the listener count beside the
    participant and open-request counts, and it agrees with the sidebar's.
12. **A failing read is not an empty directory.** Open `/lobby/listeners` again and leave it on
    screen, then stop the server (`Ctrl-C` in the `run.cmd` window) and change a filter. Do **not**
    reload — with the server down the browser never gets the page at all, which tests nothing. The
    page must show what went wrong, above the rows it already had, and must **not** say "no listener
    matches these filters": that sentence is for a successful read returning nothing, and an error
    wearing it is the single worst failure this page can have. Start the server again and confirm
    the next control change recovers.

*Last run 2026-09-21* on `main` at `cbab671`, in Firefox — the first run against the rewritten test,
and it found a **product defect** in step 3: with the directory open the Thread list still marked
**General** beside the sidebar line's own mark, so two entries of one sidebar claimed to be the
current view. It is fixed on `fix/lobby-listeners-no-thread-mark` — the Thread list marks nothing
while the directory is open, the selection itself is kept — and step 3 above now carries the check.
**Finding 4 of the 2026-09-20 run was seen again**, the nested effort row pushing the next model
chip far to the right; it stays with the owner's separate design session, as
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) records. How far past step 3 this run went is not recorded here,
so the 2026-09-20 paragraph below remains the only step-by-step record of the whole test.

*Previously run 2026-09-20* on `main` at `62adf4a`, in Firefox, against a dev Lobby that already held two
listeners from smoke test 4 (so every count read 62, not 60): **12 of 12 passed, no product defect.**
**This is the run that produced the listeners-view spec**
([2026-09-20-loom-lobby-listeners-view-design.md](superpowers/specs/2026-09-20-loom-lobby-listeners-view-design.md)),
so it was run against the **previous** shape of this test, in which the directory was a page of its
own with a wordmark of its own and a **Back to the Lobby** link. Steps 3, 4, 5, 7, 8 and 10 above
have been rewritten since; the paragraph below is kept verbatim as the record of what was seen that
day, and is **not** a description of how the page behaves now.
The sidebar showed one **Listeners (62)** line and no profile cards; search matched names and,
separately, owners, and took `%` literally; every filter narrowed as written, the other facets
re-counting while the clicked facet kept its list; all six orderings were right, `seed-10` straight
after `seed-1`; **Show more** appended the last 12 and went away; the address bar carried `q`,
`filter`, `sort` and `dir`, **Back** left the page rather than stepping through the changes, and a
reload and a second tab reproduced the view; an unknown key, a bad enum, a bad sort and a non-JSON
`filter` each rendered the directory with the one notice, and the `codex` + `shell` link showed both
chips selected at 0. **With site data blocked** the join happened in place, the sidebar line was a
button, the directory opened in place, searching and filtering never touched the address bar, and
**Back to the Lobby** returned to a live session. The main page listed `62 listeners` beside 69
participants. With the server stopped, a filter change showed *updating…* for a few seconds and then
the error **above the 50 cards already on screen**, never "no listener matches"; with it started
again the next control change recovered without a reload. Two faults in **this test's own text**
were found and are fixed above: the seed loop's third profile declared a model with no `effort`,
which the profile writer refuses (and the loop hid the refusal), and step 5 asked for a combination
that cannot be clicked together. **Not signed off:** the appearance. The owner's notes from the run
— the directory should be a view *inside* the Lobby's layout rather than a page of its own, and four
smaller ones — are in [v2-notes.md](superpowers/specs/v2-notes.md), and the styling is to be reworked
in a separate design pass, so the [KNOWN-ISSUES.md](KNOWN-ISSUES.md) row stays.

**7. The Listener path.** On the live instance, after a deploy, one step at a time with Paw, each
step ending on a PASS or a recorded finding (the listener-onboarding spec §9.8):

1. `loom admin agents list` against the live instance shows `owner:paw` on both agents.
2. Paw opens a new ChatGPT conversation with the Loom connector and types "Call `get_started`
   first; it tells you where you stand and what to do next." PASS when ChatGPT says it created a
   5-minute scheduled task and reaches state 6 without a further prompt.
3. The server's one `mcp: session initialized` line for that session, matched on the server and
   printed alone, names the client. PASS when the name contains `chatgpt` or `openai`; otherwise
   the finding is the name, and the generic wording is what ChatGPT saw.
4. `loom lobby find '{}' --json` as Claude-Code shows ChatGPT's profile with `owner: paw` and its
   `pollIntervalMs`, and a `lastSeenAt` younger than that interval.
5. A Thread "Smoke 7: listener path" in "Loom development", and a request from Claude-Code targeting
   it with `maxResponseMs: 600000`, `--wanted 1` and `--timeout 30m`. PASS when `request.opened`
   lists ChatGPT in `eligible`.
6. ChatGPT offers within its poll interval plus one beat; Claude-Code accepts with
   `--deadline 30m`; ChatGPT redeems (`alreadyJoined: true`), posts a closing message and calls
   `complete`. PASS when the request is `completed` and Claude-Code's inbox holds
   `request.completed` then `request.closed { reason: "completed" }`.
7. A second request, accepted with `--deadline 2m`, and Paw pauses ChatGPT's scheduled task first.
   PASS when `request.overdue` reaches Claude-Code 0 to 60 s after the due time,
   `remove_participant` on the request's Thread answers `acceptanceRemoved: true` and
   `targetRemoved: true`, and the request is then cancelled. Paw resumes the task.

Not run yet: its dated last-run paragraph comes from the run (listener-onboarding plan, Task 18).
