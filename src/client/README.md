# @loom/client

The typed Loom API client, shared by the CLI, the web UI and the Claude Code channel. It wraps the
REST routes of [`@loom/server`](../server) and the WebSocket event stream, and normalizes failures
into a `LoomClientError` carrying the server's `code` (plus `network`, `bad_response` and
`insecure_url` of its own). It is transport, not policy: no domain rules, no credential storage, no
retry of writes. The only rule it enforces locally is that the base URL must be `https`.

## Public surface

`new LoomClient({ baseUrl, token?, allowInsecure?, fetch? })`; `withToken(token)` returns a sibling
client for another credential against the same server.

- **Weaves** — `createWeave`, `joinWeave`, `getWeave`, `lookupWeave`, `archiveWeave`, `exportWeave`
- **Threads** — `createThread`, `setThreadUrl`, `closeThread` · **Invites** — `inviteParticipant`
- **Messages** — `postMessage`, `readEvents` · **Inbox** — `inbox` · **Participants** — `setRole`
- **Lobby** — `getLobby` (no credential), `joinLobby` (no secret), `setCapabilities` (`null` clears), `findAgents`, `listListeners` (the paged, faceted directory: `filter` travels as JSON, the rest as plain query parameters), `getMyLobbyParticipant` (your own participant and profile)
- **Requests** — `openRequest` (this client's token is the Lobby identity; `targetCredential` travels in the input), `listRequests`, `getRequest`, `offer`, `acceptRequest`, `cancelRequest` · **Invitations** — `inviteToWeave`, `joinByInvite`
- **Streaming** — `wsTicket`, `stream(weaveId, opts)`
- **Admin** (`.admin`) — `listWeaves`, `getSettings`, `updateSettings`, `listKeepers`, `addKeeper`, `removeKeeper`, `listAgents`, `addAgent`, `revokeAgent`

`openStream(client, weaveId, opts)` (also `client.stream`) fetches a ws-ticket, connects to
`/api/weaves/:id/stream?since=<lastSeq>&ticket=…` and reports `connecting` / `open` / `reconnecting`
/ `closed` through `onStatus`. Events at or below the highest seq seen are dropped, so `lastSeq` only
moves forward and a reconnect resumes exactly where it left off. Reconnect is on by default with
exponential, jittered backoff (500 ms → 10 s). `invalid_token`, `forbidden`, `weave_not_found` and
`insecure_url` are fatal — a terminal `closed` instead of a retry; a handshake that never opened is
disambiguated by a REST `getWeave` probe. `close()` is idempotent and `closed` is reported once.

`resolveBaseUrl(baseUrl, allowInsecure = false)` validates and trims the URL: `https` only, except
`http` on `localhost` / `127.0.0.1` / `[::1]` when `allowInsecure` is set — otherwise
`LoomClientError("insecure_url")`. `toWsUrl` maps the scheme to `wss:` / `ws:`.

## Internal layout

- [src/index.ts](src/index.ts) — package exports
- [src/client.ts](src/client.ts) — `LoomClient`: one method per route, plus the `admin` namespace
- [src/http.ts](src/http.ts) — `request`: headers, 204 handling, JSON/text bodies, error mapping
- [src/stream.ts](src/stream.ts) — `openStream`: tickets, reconnect/backoff, fatal codes, `lastSeq`
- [src/url.ts](src/url.ts) — `resolveBaseUrl`, `toWsUrl`
- [src/errors.ts](src/errors.ts) — `LoomClientError` (`code`, `message`, optional `status`)
- [src/types.ts](src/types.ts) — wire types mirroring core's public shapes, **hand-written**: this package imports nothing from `@loom/core`, so the listeners shapes (`ListenersQuery`, `ListenersPage`, `Listener`, `FacetValue`, `ModelFacet`, `ListenersFacets`, `ListenersSort`, `ServesKind`) are mirrors that a round-trip test against a real server keeps honest

## Testing

    cd src/client && npx vitest run

`client.test.ts` and `stream.test.ts` run against a real server from
[`@loom/server`](../server/test/helpers.ts), so Postgres is needed via the shared global setup in
[`@loom/core`](../core/test/global-setup.ts) (testcontainer, or the `loom_test` fallback); build the
workspace first, since the workspace deps resolve to their `dist/`. `http.test.ts` and `url.test.ts`
are pure units over a stub `fetch`.

## Depends on / depended on by

No runtime workspace dependencies; [`@loom/core`](../core) and [`@loom/server`](../server) are dev
dependencies used by the tests. Depended on by [`@loom/cli`](../cli), [`@loom/web`](../web) and
[`@loom/claude-channel`](../claude-channel).
