# Known issues

Deliberately deferred findings, verified against `main` as of this branch. Everything here is
already known: a reviewer should **not** re-report it, and anything **not** listed is fair game.

How items get here:

- **Task reviews and final reviews** during implementation record minors that were judged not worth
  a fix round at the time (mostly test-coverage gaps and micro-inefficiencies).
- **ChatGPT PR reviews**: findings accepted as real but explicitly deferred, plus follow-ups spotted
  during a re-review after the fix wave landed.

Each row says where it lives, what it is, why it was left, and the obvious fix where there is one.
Items that were fixed since being recorded have been removed rather than kept as history.

Product-level gaps (features not built yet, as opposed to defects) live in
[superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md); see [Product-level gaps](#product-level-gaps) below.

## core

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [actors.ts](../src/core/src/actors.ts) | `resolveCredential` hashes the credential and queries `agents` for every credential, including Weave secrets | micro-cost, one extra query per call | order lookups by likelihood, or give credentials a type prefix |
| [actors.ts](../src/core/src/actors.ts) | Agent error asymmetry: a malformed `weaveId` is `weave_not_found`, an unknown-but-valid one is `forbidden` ("Join the Weave first") | both are safe answers; deliberate about not leaking existence | pick one code if clients ever switch on it |
| [agents.ts](../src/core/src/agents.ts) | `revokeAgent` is read-then-write (select, check, update), not atomic | no user-visible effect: concurrent revokes converge on revoked | `update … where revoked_at is null returning *` |
| [agents.ts](../src/core/src/agents.ts) | `listAgents` selects every column including `key_hash`, then strips it in `toPublicAgent` | the hash never leaves the process | select explicit columns |
| [db/schema.ts](../src/core/src/db/schema.ts) | Agent names are not unique instance-wide; two agents may share a name | design choice: agents are addressed by key, participants are unique per Weave | unique index on `lower(name)` if names become addressable |
| [db/schema.ts](../src/core/src/db/schema.ts) | No GIN index on `events.payload`: inbox (`->>'participantId'`, `? mentions`) and the invite idempotency predicate scan | scans are thread- or Weave-scoped and volumes are small | `jsonb_path_ops` GIN index when a Weave's log grows |
| [inbox.ts](../src/core/src/inbox.ts) | Row→event mapping duplicates `toEvent` in [events.ts](../src/core/src/events.ts) (module-private there) | copied verbatim from the brief; drift is test-visible | export `toEvent` and reuse it |
| [threads.ts](../src/core/src/threads.ts) | Thread URLs are not normalized: `…/pull/7` and `…/pull/7/` are distinct values | design choice — store what the human typed | normalize on write if dedupe ever matters |
| [weaves.ts](../src/core/src/weaves.ts) | `joinWeave`'s `alreadyJoined` early return skips the archived check: an agent that already joined gets its token back for an archived Weave | ruled read-shaped in the v2 final review (writes still fail) | check `archivedAt` before returning |
| [guidelines.ts](../src/core/src/guidelines.ts), [export.ts](../src/core/src/export.ts) | `getInstanceGuidelines` falls back to `getSettings`, which **inserts** the `settings` row when it is missing, and `getWeave` calls it — so `exportWeave`, whose transaction is `{ isolationLevel: "repeatable read", accessMode: "read only" }`, attempts a write inside a read-only transaction. Postgres rejects it with SQLSTATE `25006` and the **export fails** as `internal`; `onConflictDoNothing` does not help, because the statement never runs | unreachable in practice, not benign when reached: it needs a `settings` row that has never been created, and `createWeave` calls `getSettings` before it inserts anything, so no Weave can exist without that row. Every other entry point that could reach `getWeave` therefore runs after the row exists | return `DEFAULT_INSTANCE_GUIDELINES` without inserting when the row is missing, or hoist the settings read outside the export transaction |
| [index.ts](../src/core/src/index.ts) | `forThread` loads the Thread, then the delegate loads it again (`setThreadUrl`, `closeThread`, `postMessage`, `inviteParticipant`) | one extra primary-key read | pass the loaded row through |
| [export.ts](../src/core/src/export.ts) | `exportWeave` holds one pooled connection and a repeatable-read snapshot open for the whole paging loop, so a large log pins that connection (pool `max: 10`) and holds back the vacuum horizon | the snapshot is the point — metadata and events must describe one moment — and exports are rare and small today | page outside the snapshot against a recorded `lastSeq`, or stream the export |
| [test/](../src/core/test) | `resolveCredential` precedence (participant → keeper → agent → secret) untested | test coverage only | one table-driven test |
| [test/](../src/core/test) | [bus.ts](../src/core/src/bus.ts) bad-listener isolation (a throwing subscriber must not break `publish`) untested | test coverage only | subscribe a thrower plus a good listener |
| [test/weaves.test.ts](../src/core/test/weaves.test.ts) | No assertion that `createWeave` returns `lastSeq === 3` | test coverage only | assert the result's `lastSeq` |
| [test/db.test.ts](../src/core/test/db.test.ts) | v2 column queries lack a `table_schema = 'public'` filter; FK and unique indexes (`participants_weave_agent_idx`, `agents.key_hash`) not asserted | test coverage only | filter the schema, assert `pg_indexes` |
| [test/agents.test.ts](../src/core/test/agents.test.ts) | Guard tests assert only the error code for `assertCanRead`/`assertParticipantOf`/`assertIsKeeperOf`, not the "Join the Weave first" message | test coverage only (`actorId` and `assertStillKeeperOf` do assert it) | assert the message too |
| [test/export.test.ts](../src/core/test/export.test.ts) | Thread `<url>` line and the `thread.invited` / cleared-`thread.url_changed` system lines unasserted | test coverage only | extend the md assertions |
| [test/threads.test.ts](../src/core/test/threads.test.ts) | `setThreadUrl` against an unknown thread id untested | test coverage only | one `thread_not_found` case |
| [test/invites.test.ts](../src/core/test/invites.test.ts) | Cross-Weave invitee (a real participant id from another Weave) untested; facade pass-through (`core.inviteParticipant`) untested | test coverage only | add both cases |
| [test/agents.test.ts](../src/core/test/agents.test.ts) | Concurrent-join tests assert the invariant (`a \|\| b` already joined) rather than pinning the catch branch; `joinWeave`'s own per-Weave early-return lookup untested | the race cannot be forced deterministically | pin via an injected failure seam |
| [test/inbox.test.ts](../src/core/test/inbox.test.ts) | The accepted upper bound is proven only against 3 events (`limit: 1000` returns all of them), so a page genuinely truncated at the maximum is untested; default limit 100 unasserted; `helpers.js` imported twice | test coverage only | assert against a seeded page; merge the imports |

## server

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [package.json](../src/server/package.json) | `hono-rate-limiter@0.5.4` is a declared runtime dependency but imported nowhere; no rate limiting is wired up | dependency hygiene, no behaviour today | wire it on the public routes, or drop the dependency |
| [auth.ts](../src/server/src/auth.ts) | The bearer middleware builds `new URL(c.req.url)` per request only to test the path | negligible cost | use `c.req.path` |
| [routes/weaves.ts](../src/server/src/routes/weaves.ts), [mcp/backend.ts](../src/server/src/mcp/backend.ts) | `POST /api/weaves` (and `CoreToolBackend.createWeave`) resolve a present credential strictly: a stale token gets 401 on an open instance instead of creating anonymously | matches the deliberate strict-join ruling (ChatGPT F5) | document it, or swallow `invalid_token` while creation is open |
| [mcp/index.ts](../src/server/src/mcp/index.ts) | Remote MCP `initialize` reads the database on **every** new session (`core.getInstanceGuidelines()`), so a handshake that used to be pure now fails with a 500 during a database outage | deliberate: `McpServer` fixes `instructions` at construction, and reading per session is what makes a keeper's edit reach the next connection without a restart | give it the deadline-and-fallback the channel has (`fetchInstanceGuidelines`, 2 s, mechanics text alone), or cache the text with a short TTL |
| [app.ts](../src/server/src/app.ts) | Route order (`/api/weaves/:secret/lookup` before `/api/weaves/:id`) is not pinned by a test | works today, fragile to reordering | a regression test on both paths |
| [routes/weaves.ts](../src/server/src/routes/weaves.ts) | A malformed `threadId` filter on `read_events` is `validation` (400) over REST, from the route's `z.string().uuid()`, but `thread_not_found` over MCP, from core's guard | both are correct answers and neither leaks anything; the REST schema predates the core guard | drop `.uuid()` so the route carries a type only and core owns the rule, as everywhere else |
| [test/](../src/server/test) | No direct tests for bearer parsing / `requireActor` / error mapping beyond the route tests | test coverage only | unit-test the middleware |
| [test/ws.test.ts](../src/server/test/ws.test.ts) | Live-phase tests use fixed 150 ms sleeps to prove the absence of duplicates | proving a negative needs a wait or a seam | inject a scheduler seam |
| [test/mcp.test.ts](../src/server/test/mcp.test.ts) | `set_thread_url`, `invite_participant`, `create_thread(url)` and `keeper_agents_*` are not exercised at the MCP level (only against the fake backend in mcp-tools) | wiring is thin and typed | one round-trip per tool |

## mcp-tools

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [tools.ts](../src/mcp-tools/src/tools.ts) | 20 × `toToolResult(Promise.resolve().then(() => …))` boilerplate | readability only | a small `call()` helper |
| [tools.ts](../src/mcp-tools/src/tools.ts) | The keeper-token hint does not mention that `credential` is optional on an agent connection | cosmetic | reuse the agent-aware hint |
| [test/tools.test.ts](../src/mcp-tools/test/tools.test.ts) | The `credential is required on this connection` branch is untested (an empty-string `credential` now reaches it, since the schemas carry types only); `join_weave`'s credential forwarding is not asserted by the fake; no table-driven test over all 24 tool→backend mappings; `result.ts` edge cases (non-`Error` throw, string payload) untested | test coverage only | call `registerLoomTools` directly for the branch; add the table |

## client

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [client.ts](../src/client/src/client.ts) | `weaveId` / `threadId` path segments are interpolated without `encodeURIComponent` (secrets are encoded) | ids are server-generated uuids | encode for house style |
| [http.ts](../src/client/src/http.ts) | `redirect: "error"` means an `http://` base URL behind a proxy that answers 301/308 with the https location now fails as `network` ("Server redirected the request") instead of being followed silently | deliberate: following a redirect escapes the one-time https-only URL policy. No documented flow redirects — the CLI, the channel and the web app all address the server directly | none; configure the client with the https URL the proxy terminates at |
| [test/client.test.ts](../src/client/test/client.test.ts) | `thread.url_changed` never asserted; the `listAgents` assertion assumes exactly one agent | test coverage only | assert the event; assert by `find` |

## cli

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [commands/invite.ts](../src/cli/src/commands/invite.ts) | `--since` / `--limit` integer parsers are duplicated inline instead of reusing the parser in [commands/messages.ts](../src/cli/src/commands/messages.ts) | duplication only | export and reuse `intParser` |
| [cli.ts](../src/cli/src/cli.ts) | A valueless `--url` reports "unknown option '--url'" rather than "option requires a value"; `takeBaseUrl` stops at the first token matching a command name (an option *value* equal to a command name ends the scan) | both are odd-shaped inputs; the global `--url` must stay out of commander's reach | parse the head with a tiny explicit scanner |
| [context.ts](../src/cli/src/context.ts) | `LOOM_AGENT_KEY` silently wins over a stored participant token for the Weave | plan choice, flagged for the owner | warn on stderr, or add an explicit `--as` |
| [config.ts](../src/cli/src/config.ts) | `ConfigStore.update` is a sequence of separate operations, none of them atomic against the others. The dead-owner check and the `rmSync` that reclaims the lock are two operations, so two reclaimers can observe the same dead lock, and a reclaimer delayed between its check and its unlink can remove the *live* lock its successor has already taken — admitting a third writer. The lease re-check before `save()` catches a writer that lost the lock that way everywhere except inside its own check/save window, where a stale snapshot can still be written over a successor's | mutual exclusion here rests on windows between operations rather than on an atomic primitive; the exposure is narrow, not closed, and a duration is not a synchronization guarantee. It needs a dead owner process *and* a writer descheduled between two adjacent statements, which single-user CLI use does not produce | compare-and-swap on the config file (write a temp and link it against an expected version), as the channel's `ChannelState` does |
| [main.ts](../src/cli/src/main.ts) | The `stdin.read()` passed to `runCli` is not idempotent: each call attaches a fresh set of `data`/`end` listeners to `process.stdin`, so a second call in one process (two `-` arguments, or a retry) sees a stream that has already ended and resolves `""` | no command reads stdin twice today, and the CLI process runs one command | read once and memoize the promise |
| [test/](../src/cli/test) | The `--url=<value>` form is untested (only `--url <value>`) | test coverage only | one case |

## claude-channel

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [streams.ts](../src/claude-channel/src/streams.ts) | `applyToNames` folds a foreign `thread.created` into the names cache but does not register it in `threadToWeave`/`threadIds`, so `credential="stored"` resolution by that thread id waits for the next successful refresh | only reachable when the refresh right after the event fails | register the thread there, guarded like `noteThread` |
| [streams.ts](../src/claude-channel/src/streams.ts) | `preambleDone` is process memory, not persisted session state, so a `--resume` (a new channel process for the same `CLAUDE_CODE_SESSION_ID`) re-sends the guidelines preamble. Conversely, in `wake: "mentions"` a Weave that never mentions you produces no first *woken* event, so that session never receives its preamble at all | both are the safe side: re-sending current rules costs a few hundred tokens, and persisting the flag would let a resumed session act on rules it was never shown. The mentions-only gap is inherent to folding the preamble into a woken event — the text is still reachable through `list_joined` and the per-Weave resource | persist the flag per session alongside the delivery cursor if the repeat becomes noisy; for the mentions-only case, deliver the preamble on the first *delivered* event instead of the first woken one |
| [backend.ts](../src/claude-channel/src/backend.ts) | A nameless `join_weave` over the channel plugin returns `validation: name is required` instead of reusing the stored participant name (the channel is not an agent connection) | the agent-key path covers remote clients; the channel always passes a name today | fall back to the stored `participantName` |
| [state.ts](../src/claude-channel/src/state.ts) | `ChannelState.setWake` is `@deprecated` and used only by its own test; `JoinedWeave.wake` is read only as a legacy fallback in `prefs()` | vestigial API kept for a migration window | remove both once no stored config carries a machine-wide wake |
| [state.ts](../src/claude-channel/src/state.ts) | The temp-file sweep keys on the writer pid in the file name, so a `.tmp` whose dead writer's pid has since been reused by an unrelated live process is never swept and leaks | leaking one small file is the safe side of the trade: the alternative deletes a live writer's file and turns a join into a lost participant token | record the writer's process start time alongside the pid, or fall back to the age cutoff once the file is far older than any plausible write |
| [test/](../src/claude-channel/test) | Backend pass-throughs (`set_thread_url`, `invite_participant`, `inbox` at the channel tool level) untested; the e2e drives them through core instead | wiring is thin | one tool call each |
| [test/channel.test.ts](../src/claude-channel/test/channel.test.ts) | The second `set_wake({invites:false})` return is unasserted (wake preservation on a partial patch); the suppression assertion is a bare boolean with a weak failure message; `dirB` is a pointless alias of `stateDir`; two live channel processes share one state dir | test hygiene only | assert the patch result; name the suppressed event in the message |

## web

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [components/ThreadTools.tsx](../src/web/src/components/ThreadTools.tsx) | The URL field seeds from the thread once per mount: saving after another editor changed it silently reverts their value | single-editor use in practice | re-seed on change, or compare-and-set on save |
| [components/GuidelinesPanel.tsx](../src/web/src/components/GuidelinesPanel.tsx) | The over-length gate uses the **untrimmed** draft (`draft.length > MAX`), while the value sent and the value core validates are trimmed: a draft of 4000 characters plus a trailing newline disables Save even though it would be accepted | the counter has to count what the textarea shows, and the discrepancy is one keystroke wide at the very limit | gate on `text.length` and keep the counter on `draft.length`, or show both |
| [components/GuidelinesPanel.tsx](../src/web/src/components/GuidelinesPanel.tsx) | Saving text equal to what is stored is only *prevented* (Save is disabled while `unchanged`) — there is no "Guidelines unchanged" feedback, so core's `seq: null` case has no UI counterpart the way `loom guidelines set` prints one | the disabled button makes the state visible before the click; a message with nothing to report after it is noise | surface `seq === null` as a transient line if the panel ever allows submitting an unchanged draft |
| [session.ts](../src/web/src/session.ts) | `deriveInvites` rescans the whole event log on every event | logs are small in practice | maintain the map incrementally |
| [components/InviteBanner.tsx](../src/web/src/components/InviteBanner.tsx) | The banner is not an `aria-live` region, and its text is not clickable to open the Thread (only the × dismisses) | accessibility polish | wrap in `aria-live="polite"`, make the line a button |
| [test/](../src/web/test), [tsconfig.test.json](../src/web/tsconfig.test.json) | `shortUrl`'s truncation branch and `MessageList`'s "no longer links to an artefact" (`url: null`) branch untested; the test tsconfig lists individual source files instead of a glob | test coverage / config noise | add both branches; widen the include |

## tooling/docs

| Area | Issue | Why deferred | Suggested fix |
| --- | --- | --- | --- |
| [pnpm-workspace.yaml](../pnpm-workspace.yaml) | `onlyBuiltDependencies` approves `cpu-features` / `ssh2` (pulled in by `@testcontainers`): install prints native-build noise, and fails those builds, on Windows without a VS toolchain | optional native deps; tests pass regardless | note it in [CONTRIBUTING.md](../CONTRIBUTING.md), or drop them from the allowlist |

## Product-level gaps

Not defects — features consciously out of scope. They are listed in
[superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md) and should not be reported as
findings either:

- **Deferred from v1**: pushing into a remote agent's platform (no inbound path exists today),
  `claude/channel/permission` relay, event-sourced projections/replay, per-Thread keepers,
  GitHub/PR integration, publishing the channel plugin through a marketplace.
- **Dogfood findings**: org policy silently blocking channel delivery (needs a README note), keeper
  tools always advertised (9 of 24) even on an agent connection where they can never apply,
  Cloudflare quick-tunnel flags needed on some networks, and `run.cmd`/`run.ps1` dying with a raw
  `EADDRINUSE` stack trace when port 3000 is held.

See that file for the full text and context.

## How to close an item

Fix it and delete its row in the same PR — the register must never describe something that is
already fixed. If the fix turns out to be bigger than the row suggests, either leave the row alone
or rewrite it to say what was learned; do not mark rows as done in place.
