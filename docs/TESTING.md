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
2. **Testcontainers** — `new PostgreSqlContainer("postgres:17-alpine").start()`, and its
   connection URI becomes `TEST_DATABASE_URL`. This is the normal path and it needs Docker
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
*application* database. `isProtectedDatabase()` returns true when the URL's database name is
`loom`, and [`src/core/test/helpers.ts`](../src/core/test/helpers.ts) refuses to proceed in that
case — unless `LOOM_TEST_DATABASE_URL_USER_SET` is set, i.e. you pointed `TEST_DATABASE_URL` at it
yourself on purpose. The guard has its own tests (`src/core/test/db-guard.test.ts`).

**Per-test isolation.** `freshDb()` creates the connection once per process, runs migrations once,
and then, on every call, executes

```sql
truncate events, participants, threads, weaves, keepers, settings, agents restart identity cascade
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

One extra dependency: **`src/claude-channel` tests spawn `dist/server.js`**
(`src/claude-channel/test/channel.test.ts` resolves `../dist/server.js` and starts it with
`process.execPath` over an MCP stdio transport), so the channel must be built before its own tests
run. Its `test` script does that for you (`pnpm build && vitest run`); if you invoke `npx vitest
run` in that package directly, run `pnpm build` there first or you will be testing a stale — or
missing — `dist`.

## What each package's tests cover

| Package | Test files | Coverage |
| --- | --- | --- |
| `core` | 16 | Every domain rule, against a real database: weaves, threads (creation, close, URL), messages and mentions, participants and roles, invites, inbox, agents and agent keys, export, settings and keepers, event seq under the weave lock, the uuid/authority guards, and the pure units (ids, names, errors) |
| `client` | 4 | The typed HTTP wrappers, base-URL/WS-URL resolution, and the reconnecting event stream — against a real server started by the server test helpers |
| `mcp-tools` | 1 | Tool registration and wiring over an in-memory MCP transport against a fake `LoomToolBackend`; the only suite with no database |
| `server` | 8 | REST routes, auth and admin, remote MCP at `/mcp` (including agent keys), the WebSocket stream (tickets, replay, mid-stream auth re-check), static hosting, config loading, log redaction, and one end-to-end scenario |
| `cli` | 3 | Every command run in-process through `runCli()` against a live test server with a temp config file, asserting output, JSON shape and exit codes; plus the config store |
| `claude-channel` | 6 | The channel end-to-end as a spawned `dist/server.js` (tools, streaming, stderr redaction), the lock-free `ChannelState`, event formatting and wake rules, the client-backed tool backend, and log redaction |
| `web` | 4 | Session lifecycle against a real server, markdown rendering, mention-composer logic, and DOM tests of the Preact components |

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

As of the 2026-09-15 dogfood UX fixes (commit `300a8f5`): **399 tests** — core 130,
mcp-tools 11, server 83, client 30, cli 33, claude-channel 75, web 37 — run serially with
`pnpm --workspace-concurrency=1 -r test`, and with `pnpm -r build` and `pnpm -r typecheck` clean.
Counts change with every feature; run the suites to see current numbers.

## Manual smoke tests

Two things the automated suites cannot cover, because they need a live Claude Code session and a
live third-party connector. Both are run by hand before calling a release done; the commands come
from the [README](../README.md) and `src/claude-channel/README.md`.

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
