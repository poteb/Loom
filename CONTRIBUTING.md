# Contributing to Loom

This file describes how the code in this repository is actually written, so that a reviewer
(human or agent) can judge a change against the same standards the existing code follows.
Everything below is derived from the current source; file references are the evidence.

## Toolchain

- **pnpm 10 via corepack.** The root [`package.json`](package.json) pins
  `"packageManager": "pnpm@10.34.5"`; [`build.sh`](build.sh) / [`build.ps1`](build.ps1) run
  `corepack enable pnpm` when `pnpm` is missing, then `pnpm install && pnpm build`.
  The workspace is `src/*` ([`pnpm-workspace.yaml`](pnpm-workspace.yaml)).
- **Node 24.** `"engines": { "node": ">=24" }`.
- **TypeScript 5.9, strict.** `typescript@5.9.3` is a root devDependency; every package extends
  [`tsconfig.base.json`](tsconfig.base.json), which sets `target: ES2022`,
  `module`/`moduleResolution: NodeNext`, `strict`, `declaration`, `sourceMap`, `esModuleInterop`,
  `skipLibCheck`, and two settings that shape the code: **`noUncheckedIndexedAccess`** (indexing
  yields `T | undefined`, hence the `rows[0]!` / `p!` style after a checked insert or select) and
  **`verbatimModuleSyntax`** (type-only imports must be written `import type { … }`).
- **ESM with explicit `.js` suffixes.** Every package is `"type": "module"`, and relative imports
  carry the compiled suffix — `import { errors } from "./errors.js";` — including in the web
  package, which resolves with the bundler but keeps the same spelling
  (`src/web/test/components.test.tsx` imports `../src/components/ThreadList.js`).
- **Vite 7 for the web package only** ([`src/web/vite.config.ts`](src/web/vite.config.ts):
  Preact preset, `/api` proxied to `http://127.0.0.1:3000` with `ws: true`). Every other package
  builds with `tsc -p tsconfig.json`.
- **Per-package scripts are uniform**: `build`, `typecheck`
  (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json` — tests are typechecked too),
  `test` (`vitest run`). Root scripts: `pnpm build`, `pnpm typecheck`, `pnpm test`.

## Layering: rules in `core`, thin adapters

All domain rules live in [`src/core`](src/core). Server routes, MCP tools, the CLI, the Claude Code
channel and the web app are adapters: they parse input, call `core`, and shape the result.
This is a rule from the design spec (`docs/superpowers/specs/2026-09-10-loom-v1-design.md`:
"REST, MCP, and CLI are thin. Every rule … lives in `core` and is tested once there") and the code
holds to it. A route is typically three lines:

```ts
r.post("/:id/invites", async (c) => {
  const actor = await requireActor(c, core);
  const { participantId } = await body(c, z.object({ participantId: z.string() }));
  const result = await core.inviteParticipant(actor, c.req.param("id"), participantId);
  return c.json(result, result.created ? 201 : 200);
});
```

A change that adds validation, authorization, or state transitions to an adapter instead of to
`core` is a review finding. Adapter-level schemas (`z.object(...)` in the routes, tool input
schemas in `src/mcp-tools/src/tools.ts`) exist only to get well-typed values into `core`; the
semantic checks stay in `core`.

### Concrete signs of the layering

**Core throws typed errors.** [`src/core/src/errors.ts`](src/core/src/errors.ts) defines
`LoomError` with `toJSON() → { code, message }` and a fixed `ErrorCode` union:

`validation`, `invalid_token`, `forbidden`, `weave_not_found`, `thread_not_found`,
`weave_archived`, `thread_closed`, `name_taken`, `message_too_long`.

Throw through the `errors` factory (`errors.validation(...)`, `errors.nameTaken(name)`, …) rather
than constructing ad-hoc `Error`s. Adding a code means adding it to the union *and* to the server
map below — the map is `Record<ErrorCode, number>`, so the compiler enforces it.

**The server maps codes to HTTP statuses** in
[`src/server/src/errors.ts`](src/server/src/errors.ts):

| code | status |
| --- | --- |
| `validation` | 400 |
| `invalid_token` | 401 |
| `forbidden` | 403 |
| `weave_not_found`, `thread_not_found` | 404 |
| `weave_archived`, `thread_closed`, `name_taken` | 409 |
| `message_too_long` | 413 |
| anything else | 500 |

`src/server/src/app.ts` turns a `LoomError` into `c.json({ code, message }, statusFor(code))`;
`src/server/src/ws.ts` uses the same `statusFor` to reject a WebSocket upgrade with the matching HTTP status before the socket opens (a credential revoked mid-stream closes the socket with code `4401`).

**MCP tools return `{ code, message }` tool errors.** Every handler in
`src/mcp-tools/src/tools.ts` wraps its call in `toToolResult`
([`src/mcp-tools/src/result.ts`](src/mcp-tools/src/result.ts)), which returns `ok(value)` on
success and, on a thrown object carrying string `code` and `message`, `fail(code, message)` —
`{ isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] }`.
Anything else becomes code `internal`. Adapters that wrap a backend throw `LoomToolError` so the
same formatting applies (see `src/claude-channel/src/stored.ts`).

**The CLI prints `{ code, message }` JSON and uses two exit codes**
([`src/cli/src/cli.ts`](src/cli/src/cli.ts)): a failed command writes
`{"code":…,"message":…}` to stderr in `--json` mode (otherwise `error: <message> (<code>)`) and
returns **1**; a usage error (any `CommanderError` that is not help or version) returns **2**;
help and version return 0. `src/cli/src/main.ts` assigns the returned code to `process.exitCode`.

## Naming and value rules

- **Participant and agent names**: 1–32 characters of `A-Z a-z 0-9 _ . -`, trimmed —
  `NAME_RE` in [`src/core/src/names.ts`](src/core/src/names.ts). Validation is
  `validateName()`, which returns the trimmed name; it is the only place the shape is checked.
  Uniqueness is **per Weave and case-insensitive**, enforced in the database by the unique index
  `participants_weave_name_idx` on `(weave_id, lower(name))` (`src/core/src/db/schema.ts`); the
  unique-violation is translated to `name_taken`.
  An agent owns at most one participant per Weave (`participants_weave_agent_idx`).
- **Secrets, tokens and agent keys**: 32 random bytes, base64url, unpadded — **43 characters**.
  `newSecret()` in [`src/core/src/ids.ts`](src/core/src/ids.ts) regenerates while the first
  character is `-`, so a secret can never be mistaken for a CLI option. `KEEPER_TOKEN_RE`
  (`/^[A-Za-z0-9_-]{43}$/`) is the shape check. Agent keys are stored only as a SHA-256 hash
  (`hashKey`, `src/core/src/agent-keys.ts`).
- **Ids are uuids, and are guarded before they reach the database.** `isUuid()` (same file)
  matches the canonical 8-4-4-4-12 form; every entry point checks it and throws the appropriate
  domain error rather than letting Postgres raise `22P02` — e.g. `getThread` throws
  `thread_not_found`, `withWeaveLock` throws `weave_not_found`, `inviteParticipant` throws
  `validation` for a malformed participant id. `src/core/test/guards.test.ts` covers this.
- **Thread URLs**: `validateThreadUrl` in [`src/core/src/threads.ts`](src/core/src/threads.ts) —
  `null`/`undefined`/empty become `null`; otherwise the trimmed value must be at most **2000**
  characters, parse as a `URL`, and use `http:` or `https:`.
- **Message length** is a setting, not a constant: `settings.maxMessageLength`, enforced once in
  `src/core/src/messages.ts` with `errors.messageTooLong(...)`.

## Concurrency conventions

- **Every core write runs inside `withWeaveLock`**
  ([`src/core/src/events.ts`](src/core/src/events.ts)): a transaction that takes
  `SELECT … FOR UPDATE` on the Weave row, runs the callback, appends the returned events with
  `appendInTx` (seq = `weave.lastSeq + 1 …`, advancing `weaves.last_seq`), commits, and only then
  publishes to the bus in seq order. The callback returns `{ result, events }`; it never publishes
  itself and never writes outside `tx`.
- **Authority is re-checked inside the lock.** Checks made before the transaction
  (`assertIsKeeperOf`) are re-verified against `tx` with `assertStillKeeperOf` / the freshly
  selected row, so a keeper removed in between loses the write
  (`src/core/test/guards.test.ts`, `src/core/test/authz.test.ts`).
- **Idempotent operations return the original result and emit no event.** Three existing examples,
  and the shape to copy for new ones:
  - `inviteParticipant` — a second invite of the same participant to the same Thread returns the
    first `thread.invited` event's `seq` with `created: false` and `events: []`
    (`src/core/src/invites.ts`).
  - `setThreadUrl` — an unchanged URL returns the current thread with `events: []`
    (`src/core/src/threads.ts`).
  - `joinWeave` with an agent key — an agent already holding a participant in that Weave gets that
    identity back with `alreadyJoined: true` and no `participant.joined` event; a lost first-join
    race (unique-index violation) resolves to the winner's identity rather than erroring
    (`src/core/src/weaves.ts`).
- **Channel state mutations are pure functions, re-applied on retry.** `ChannelState.mutate(fn)`
  in [`src/claude-channel/src/state.ts`](src/claude-channel/src/state.ts) reads a snapshot, runs
  `fn`, and commits `config.<n+1>.json` by hard-linking a fsynced temp file (an atomic
  compare-and-swap on the version number). When another process wins, `fn` is run again on a fresh
  snapshot — so `fn` must depend only on the config it is handed, and must have no side effects.

## Logging

`redact()` in [`src/server/src/log.ts`](src/server/src/log.ts) and
[`src/claude-channel/src/log.ts`](src/claude-channel/src/log.ts) blanks out the two shapes a
credential can take: a 43-character base64url run and a URL's `user:password@` segment. Server
`logError` additionally writes only an error's `name`, a stable-looking `code`, a redacted
`message` and up to five stack frames — never a Postgres driver error's `query`, `parameters`,
`detail`, `hint` or `where`, which carry bound token values. Never log a token, secret or agent
key, and route diagnostics through these helpers rather than bare `console.error` /
`process.stderr.write`.

## Tests

Full mechanics are in [docs/TESTING.md](docs/TESTING.md). The standards a reviewer checks:

- **Test-first.** Each task lands with its tests; RED-then-GREEN evidence is expected per task
  (`.superpowers/sdd/global-constraints.md`).
- **One rule, tested once, in `core`.** Adapter suites test wiring — that the route/tool/command
  reaches the right core call and renders the result and the error shape — not the rule again.
- **Real Postgres, no database mocks.** `freshDb()` (`src/core/test/helpers.ts`) migrates and
  truncates a real database; server-backed suites start a real HTTP/WS server via
  `startTestServer()` (`src/server/test/helpers.ts`). Fakes are used only at a package boundary
  the package does not own (for example the in-memory `LoomToolBackend` in
  `src/mcp-tools/test/tools.test.ts`).
- **End-to-end coverage exists for every adapter** and is expected to stay: WebSocket streaming
  (`src/server/test/ws.test.ts`), remote MCP over `/mcp` (`src/server/test/mcp.test.ts`), the CLI
  against a live server (`src/cli/test/*.test.ts`), the channel as a spawned
  `dist/server.js` process driven over stdio MCP (`src/claude-channel/test/channel.test.ts`), and
  the web app against a real server plus DOM tests
  (`src/web/test/session.test.ts`, `src/web/test/components.test.tsx`).

## Git and pull requests

- **A branch per feature, one PR against `main`.** Merges are **squash-only** — the repository has
  merge commits and rebase merges disabled, so a PR lands as a single commit.
- **Conventional-commit subjects with a scope**, as used throughout `git log`:
  `feat:`, `fix(channel):`, `test(core):`, `docs(spec):`, `chore:`, `refactor:` — e.g.
  `fix(server): re-check ws stream authority so removed keepers lose access`.
  The body explains why, in prose.
- **Every commit carries a `Co-Authored-By:` trailer** naming the Claude model that wrote it, e.g.
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Review rounds are recorded on the PR.** Implementation is subagent-driven with a per-task
  review, then a whole-branch review, then external ChatGPT review rounds whose findings and
  responses are posted as PR comments and fixed one commit per finding; the PR description
  summarises the rounds and the test totals (see PR #5).
- **Where documents live**: specs in [`docs/superpowers/specs`](docs/superpowers/specs), plans in
  [`docs/superpowers/plans`](docs/superpowers/plans), and loose ideas / deferred items in
  [`docs/superpowers/specs/v2-notes.md`](docs/superpowers/specs/v2-notes.md) — notes belong in the
  repo, not in an agent's private memory.

## Deliberately absent

- **No ESLint and no Prettier.** There is no `eslint.config.*`, no `.eslintrc*`, no
  `.prettierrc*` and no `.editorconfig` anywhere in the repository, and no lint script in any
  `package.json`. Formatting is therefore a matter of matching the surrounding code: two-space
  indentation, double quotes, semicolons, generous but purposeful doc comments explaining *why*,
  and long single-line statements where the existing files use them. Do not reformat untouched
  code, and do not add a formatter as part of an unrelated change.
- **No CI workflow.** There is no `.github/` directory: no Actions, no PR templates, no
  `CODEOWNERS`. Build, typecheck and tests are run locally by the author and the result is
  reported in the PR description — so state the commands you ran and their output.
