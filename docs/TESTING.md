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
| `core` | 22 | Every domain rule, against a real database: weaves, threads (creation, close, URL), messages and mentions, participants and roles, invites, inbox, agents and agent keys, export, settings and keepers, event seq under the weave lock, the uuid/authority guards, guidelines (validation, both layers, composition, the idempotent `seq: null`, in-lock authority, archived/member/unknown-Weave refusals, the migration default and the export rendering), the Lobby (five files: `lobby` bootstrap and secret-less join, `lobby-matching` as pure units, `lobby-profile` validation and `find_agents`, `lobby-requests` open/offer/accept/cancel/sweep with the two-credential contract, the recorded target authority re-checked in-lock, the rollback and the Lobby→target lock order, and `lobby-invitations` issue/redeem plus the scan proving no secret reaches the Lobby log), and the pure units (ids, names, errors) |
| `client` | 4 | The typed HTTP wrappers (including the public `getInstanceGuidelines`, `setWeaveGuidelines` and every Lobby and request wrapper, round-tripped against a real Lobby), base-URL/WS-URL resolution, the `signal` an aborted request honours, and the reconnecting event stream — against a real server started by the server test helpers |
| `mcp-tools` | 1 | Tool registration and wiring over an in-memory MCP transport against a fake `LoomToolBackend`, asserted against `LOOM_TOOL_NAMES` (34 tools), plus the three resources (`loom://guidelines`, the per-Weave guidelines template and `loom://lobby/requests`) and each `resourceCredential` outcome; the only suite with no database |
| `server` | 9 | REST routes (including the public `GET /api/guidelines` and `PUT /api/weaves/:id/guidelines`), auth and admin, the Lobby and request routes with their full auth matrix (`lobby-routes.test.ts`: secret-less join, capabilities, `find_agents`, the two-credential open, offers, accept, cancel, `POST /api/weaves/:id/invitations`, the secret-less `POST /api/weaves/join`, `request_closed` → 409, computed status, and the injected 60 s sweep), remote MCP at `/mcp` (including agent keys, `join_weave({ inviteId })`, the `loom://lobby/requests` resource and the instructions carrying the instance guidelines), the WebSocket stream (tickets, replay, mid-stream auth re-check), static hosting (`static.test.ts`: `index.html` for all seven web paths — `/`, `/lobby`, `/weave/<id>` and `/w/<secret>` with and without a trailing slash — immutable `/assets/*`, the JSON 404 kept for everything else, and every one of the seven answering that 404 in an app built without `webDist`), config loading, log redaction, and one end-to-end scenario |
| `cli` | 5 | Every command run in-process through `runCli()` against a live test server with a temp config file, asserting output, JSON shape and exit codes; the guidelines commands including the `-`-reads-stdin path; the Lobby and request commands (`lobby.test.ts`: `lobby join\|me\|find`, `request open\|list\|show\|offer\|accept\|cancel`, `invite-weave`, `join --invite`, and how `read` renders each Lobby event); plus the config store |
| `claude-channel` | 9 | The channel end-to-end as a spawned `dist/server.js` (tools, streaming, stderr redaction), the lock-free `ChannelState`, event formatting and wake rules — including every Lobby event type in **both** wake modes, the whole opening and closing sequences, and the `requests` preference — the Lobby end-to-end (`lobby.test.ts`: two stored tokens as the requester's credentials, `offer` with `"stored"`, the `weave.invited` wake, `join_weave({ inviteId })` storing and streaming the new Weave, and the two-step leave that clears the profile first), the startup fetch under its deadline and the mechanics-only fallback, the guidelines preamble on the first woken event per Weave per session, the client-backed tool backend, and log redaction |
| `web` | 10 | Session lifecycle against a real server (including the guidelines watermark in both directions — a stale snapshot and a replayed older event — the Lobby requests the session derives from events plus snapshots, a Weave loaded from a stored participant token, and the §2.6 invalid-identity table: a 401/403 clears the identity, keeps the secret, falls back to it read-only, and a rejoin self-heals), storage on its own (`storage.test.ts`: the `durable`/`memory` verdict including a store that accepts `setItem` and keeps nothing, and the pending-override/tombstone precedence), the per-Weave entry rules (`weaves-store.test.ts`: `setIdentity` as one write, `invalidateIdentity` keeping the secret, the `mergeLegacy` and `readerFor` tables, lazy migration that drops the legacy key only on a durable write), the refresh scheduler (`refresh-queue.test.ts`: the limit held across enqueues, FIFO order, a rejecting `run`, `dispose`), the one-storage-instance guard beside the notice and change-signal units, the request reducer (`requests-state.test.ts`: the per-request `lastEventSeq` watermark, monotonic terminal states, an `accepted` set that never shrinks, derived expiry from the clock), markdown rendering, mention-composer logic, and DOM tests of the Preact components — `components.test.tsx` (the Guidelines panel: read for everyone, edit for keepers, the counter, archived read-only; the requests panel: requester Accept/Cancel, the Offer form for an eligible listener, the countdown, read-only for everyone else; `routeOf` and the `WeaveView` branches) and `main-page.test.tsx` (the main page's four independent cells, the Join-the-Lobby form with its name rule and `name_taken` suggestion, the durable-versus-in-place branch on both the join and the creation, My Weaves' row states, the total in-flight bound over a 32-row fixture, the change-signal and reported-write cases, and the save-this-link panel in both its variants) |

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

As of the web main page on `feat/web-main-page` (last code commit `ae6c21a`): **1140 tests in 60
files** — core 301 in 22, web 421 in 10, server 140 in 9, claude-channel 139 in 9, cli 68 in 5,
client 37 in 4, mcp-tools 34 in 1 — from `pnpm -r build` then
`pnpm --workspace-concurrency=1 -r test`, with `pnpm -r typecheck` clean.
Counts change with every feature; run the suites to see current numbers.

## Manual smoke tests

Five things the automated suites cannot cover, because they need a live Claude Code session, a live
third-party connector, or a real browser with its own storage settings. All are run by hand before
calling a release done; the commands come from the [README](../README.md) and
`src/claude-channel/README.md`.

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

1. Open `https://localhost/` in a **fresh browser profile** (or a window whose site data for this
   origin you have cleared). Expect: the instance guidelines if any are set, **The Lobby** with its
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
   replaces the form with `https://localhost/w/<secret>` in a read-only field. Click **Copy**
   (confirm it says *Copied*), read the warning that the link cannot be rotated or revoked, then
   **Done**.
6. The new Weave is now a row in **My Weaves**, beside the Lobby's (with its **Lobby** badge). Open
   it from the list: the address is **`/weave/<id>`**, not `/w/<secret>`, and the Weave loads with
   the stored token.
7. **Now block site data for this origin** — the **site settings** for `localhost` ("Block" for
   cookies and site data), which is the only variant that reproduces this. A private window does
   **not** block `localStorage`: it gives the window its own store that is merely cleared when the
   window closes, so every write there persists for as long as the session lasts and the bar never
   appears. With site data blocked, repeat the journey: open `/`, join the Lobby under a *different*
   name, and confirm all four: the bar *"This browser is not saving anything for this site…"*
   appears; the page does **not** navigate (the Lobby renders in place and the address bar still
   reads `/`); creating a Weave there gives the **hardened** panel, whose **Done** stays disabled
   until you press Copy or *I have saved this link*; and the created link is still on screen the
   whole time. One bar, not several, however many writes fail.
8. **`/w/<secret>` is unchanged.** Back in the normal window, paste the link copied in step 5. The
   route itself is untouched: it looks the Weave up by its secret and then finds the identity the
   id-keyed entry holds. This browser **created** that Weave, so `loom:weave:<id>` already carries
   the token — expect the Weave to open **already joined as you** (the header names you, the
   composer is there), with **no** name prompt and the address bar still showing `/w/<secret>`.
   To see the name prompt, open the same link in a **different browser profile** (or one whose site
   data for this origin has been cleared): that browser holds nothing for the Weave, so it reads
   with the secret and the first message asks for a name.

*Not yet run against a browser.*
