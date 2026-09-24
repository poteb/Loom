# Brainstorm Web Main Page

## Status
done  <!-- todo | in progress | blocked | done -->

## Task
Run a brainstorm (superpowers:brainstorming) on a **main page for the web client** (`/`), so a human can join the Lobby from a browser without being handed a secret. Today the web client only routes `/w/<secret>` and `/` answers 404.

Output: a spec under `docs/superpowers/specs/` capturing the design; no implementation.

## Notes
- Found during the Lobby manual smoke test (2026-09-17, after PR #14 merged at c818ed3).
- The non-trivial part: Lobby join is secret-less (`POST /api/lobby/join`) and returns a participant token, never the Weave secret (only instance keepers can read it via `GET /api/lobby`). The web session (`src/web/src/session.ts`, `createSession({ secret })`) loads a Weave by secret, so a human who joins from `/` gets a token but no URL the client can open. The session needs a token-based load path (Weave id + participant token), and the router (`src/web/src/app.tsx:15`) a route for it (e.g. `/lobby`).
- Rough shape to start from: `/` shows instance title + guidelines, a "Join the Lobby" form (name) calling `joinLobby`, stores the token, opens the Lobby view; it could also list the Weaves this browser holds tokens for (`src/web/src/storage.ts` `storedWeaves()`, already used by the open-request target picker).
- Server side is expected to be small: serve `index.html` at `/` (see how `/w/*` is served in `src/server/src/app.ts`). No core change expected.
- Related docs: `docs/superpowers/specs/2026-09-16-loom-lobby-design.md` §6 (web), `docs/SECURITY.md` §4a (public Lobby join).
- 2026-09-17: read the Lobby spec (§2/§3/§6), SECURITY §4a/§8/§9, ARCHITECTURE §9/§10, KNOWN-ISSUES, v2-notes, CONTRIBUTING, TESTING; then the code — `web/src/{app.tsx,session.ts,storage.ts,useSession.ts}`, `client/src/client.ts`, `server/src/{app.ts,auth.ts,ws.ts,routes/{weaves,lobby,requests,auth}.ts}`, `core/src/{actors,weaves,names,index}.ts` and `core/src/lobby/{lobby,requests}.ts`.
- 2026-09-17: verified the load-path claim against code — every read the session makes (`getWeave`, `readEvents`, `listRequests`, the WS upgrade) goes through `assertCanRead`, which admits a participant token scoped to that Weave. The only secret-only call is `lookupWeave`, which a token session never makes. So no core or server rule change is needed; the server only gains `index.html` routes.
- 2026-09-17: spec written to `docs/superpowers/specs/2026-09-17-loom-web-main-page-design.md`; v2-notes annotated in two places (the idea entry and the smoke-test bullet). Branch `docs/web-main-page-spec`, commit `cd211e7`, not pushed.

## Decisions (Paw, 2026-09-17)
- **Web identity in the Lobby is read-only**: a human joins to watch and to open/accept requests; no profile form (no owner/serves/capabilities from the web). Profiles are for agents that can be woken.
- **Route shape**: a general `/weave/<id>` that loads any Weave this browser holds a token for; `/lobby` is a shortcut to the Lobby's id. `/w/<secret>` keeps working unchanged.
- **Main page `/` shows**: the Join-the-Lobby form, a "My Weaves" list (from local storage), the instance guidelines, a Lobby summary (title, listener count, open-request count — decide whether that needs a new public read or is shown only after joining; weigh it against SECURITY §4a), and a **Create a Weave** form (today only CLI/MCP can create; check what `POST /api/weaves` needs and returns, and where the creator's secret/token is shown and stored).
- Scale note from the same session: the web client needs a layout overhaul for 100s of listeners/Weaves/Threads (v2-notes idea); the spec should not make that worse (e.g. "My Weaves" must be a list that can grow) but the overhaul itself is out of scope.

## Questions

## Outcome
Spec written to `docs/superpowers/specs/2026-09-17-loom-web-main-page-design.md` (10 sections, ~470 lines); `docs/superpowers/specs/v2-notes.md` annotated under the web-main-page idea and in the smoke-test bullet. Branch `docs/web-main-page-spec` off `main` (b9e59a7), one commit `cd211e7`, not pushed.

Key decisions:
- The session takes a `target` union — `{ kind: "secret", secret }` or `{ kind: "id", weaveId }` — and `reader` is the secret when there is one, the stored participant token otherwise. One `createSession`, one `load()`; `/w/<secret>` unchanged.
- Storage moves to `loom:weave:<weaveId>` carrying `{ token, participantId, secret?, title?, archived?, lastOpenedAt? }`; legacy `loom:<secret>` entries are read forever and migrated lazily (new entry written before the old key is removed), never deleted on a failed read.
- No core or server rule change: every session read passes `assertCanRead` with a participant token; the server only gains `index.html` at `/`, `/lobby`, `/weave/:id` (no SPA catch-all — the JSON 404 stays).
- The Lobby summary shows title only to an anonymous visitor and counts only once the browser holds a Lobby token — rejecting a new public read, to keep SECURITY §4a's line ("join is public, reading contents needs a credential") where it is.
- My Weaves renders from cached titles in storage with zero network calls, refreshed lazily with bounded concurrency, so it survives hundreds of rows without pre-empting the layout overhaul.
- A created Weave's secret is shown once in a "save this link" panel and kept in the storage entry (copyable later); the address bar never carries it — `/weave/<id>` is the token-loaded page, which narrows SECURITY §9.9.

Assumptions Paw should confirm (§10 of the spec): no public Lobby counts; the landing page ships ungated on a tunnelled instance; creation is always offered with the 403 surfaced in place.
