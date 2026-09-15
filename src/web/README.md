# @loom/web

The browser UI for a single Weave: threads, the message log, a composer with `@mention` completion,
invite banners and keeper controls. A Preact SPA built by Vite into `dist/`, talking to the server
through [`@loom/client`](../client). It is a view over the session store — no domain rules, no direct
`fetch`, no credential minting; what it may do is decided server-side. The one thing it does enforce
locally is rendering safety: Markdown is escaped and only `http(s)` / `mailto` hrefs survive.

## How it is served

[`@loom/server`](../server) serves the build when `webDist` is set (`LOOM_WEB_DIST`, else
`../../web/dist` if it exists): `/assets/*` immutably cached, `/w/:secret` returning `index.html`.
[src/app.tsx](src/app.tsx) reads the 43-character secret back out of `location.pathname`; any other
path shows an "open a Weave link" placeholder. The client is built against `location.origin`, so the
UI is always same-origin with its API. In development `pnpm dev` serves it on Vite and proxies `/api`
(WebSocket included) to `http://127.0.0.1:3000`.

## Session contract

[src/session.ts](src/session.ts) is the whole client-side model; components are functions of it.
`createSession({ client, secret, storage })` returns a `Session`: `getState()` / `subscribe(fn)`;
`load()` (backfill the event log, fetch the Weave, then open the stream from the last backfilled
seq) and `dispose()`; the writes `join`, `post`, `createThread`, `setThreadUrl`, `invite`,
`closeThread`, `archive`, `setGuidelines`; and the view helpers `selectThread`, `markSeen`,
`canModerate`, `canEditThread`, `dismissNamePrompt`.

`SessionState` carries `status` (`loading` / `ready` / `error`) with `error`, the `weave`, `threads`,
`participants` and `events`, `me` (participant + token), `currentThreadId`, `connection`
(`connecting` / `open` / `reconnecting` / `closed`), `needsName`, a background `refreshError`,
`invitesForMe` (threads holding an invite newer than this session has read there), `invited`
(everyone invited, per thread) and `instanceGuidelines` (the public instance layer; the Weave's own
layer is `weave.guidelines`). A write attempted without an identity raises `needsName` and throws
`no_identity`; mutations that already committed update state locally and let a coalesced, retrying
refresh reconcile.

**Guidelines.** The panel shows the Weave's guidelines to everyone and an editor to keepers;
authority is derived on every render (`session.canModerate()`), so a demotion or an archive while
the form is open makes it read-only, and `setGuidelines` re-checks before sending. The instance text
is loaded separately — it is a public read, independent of this Weave — and shown collapsed under
"What agents are told". Both are rendered with the same `renderMarkdown` used for messages. The
session keeps a **guidelines watermark**, a Weave seq: a `weave.guidelines_changed` event older than
it still joins the log but does not touch the panel, and a metadata snapshot that predates it keeps
the text the newer change installed — so a slow refresh cannot resurrect stale rules in either
direction.

The participant token is kept by [src/storage.ts](src/storage.ts) under `loom:<secret>` as
`{ token, participantId }` — `browserStorage()` wraps `localStorage` with try/catch on every call
plus an in-memory fallback, `memoryStorage()` is the test double. It is re-adopted on load only if
that participant is still in the Weave.

## Internal layout

- [index.html](index.html) / [src/main.tsx](src/main.tsx) — the shell and the `render(<App/>)` call
- [src/app.tsx](src/app.tsx) — route the `/w/<secret>` path, compose the screen, funnel errors
- [src/useSession.ts](src/useSession.ts) — the Preact hook owning one session's lifetime
- [src/session.ts](src/session.ts) — the session store (above)
- [src/storage.ts](src/storage.ts) — `KeyValueStorage`, `browserStorage`, `memoryStorage`
- [src/markdown.ts](src/markdown.ts) — `renderMarkdown`: escaping, safe hrefs, mention spans
- [src/styles.css](src/styles.css) — the stylesheet
- [src/components/Header.tsx](src/components/Header.tsx) — title, identity, connection state, archive button
- [src/components/ThreadList.tsx](src/components/ThreadList.tsx) — threads, artefact links, new-thread form
- [src/components/ThreadTools.tsx](src/components/ThreadTools.tsx) — per-thread URL field and invite list
- [src/components/MessageList.tsx](src/components/MessageList.tsx) — rendered messages and system events
- [src/components/Composer.tsx](src/components/Composer.tsx) — the text box and mention popup
- [src/components/mention-logic.ts](src/components/mention-logic.ts) — `completeMention`, `applyMention`, `clampSelection`
- [src/components/GuidelinesPanel.tsx](src/components/GuidelinesPanel.tsx) — the Weave's guidelines, the keeper editor, and the collapsed instance text
- [src/components/InviteBanner.tsx](src/components/InviteBanner.tsx) — "your input is wanted here"
- [src/components/NamePrompt.tsx](src/components/NamePrompt.tsx) — choose a name before taking part

## Testing

    cd src/web && npx vitest run

`session.test.ts` runs the store against a real server from
[`@loom/server`](../server/test/helpers.ts), so Postgres is needed via the shared global setup in
[`@loom/core`](../core/test/global-setup.ts); build the workspace first. `components.test.tsx` opts
into DOM per file with a `// @vitest-environment happy-dom` docblock and renders through
`@testing-library/preact` ([test/dom-setup.ts](test/dom-setup.ts) unmounts after each test);
`markdown.test.ts` and `composer-logic.test.ts` are pure units.

## Depends on / depended on by

Depends on [`@loom/client`](../client), `preact` and `marked`; [`@loom/core`](../core) and
[`@loom/server`](../server) are dev dependencies for the tests. Nothing imports this package — its
`dist/` is served by [`@loom/server`](../server).
