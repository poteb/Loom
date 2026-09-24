# Web redesign: implement Paw's design session mockup

**Goal:** the browser UI looks and is laid out like Paw's design session mockup (Claude Design canvas
"Loom redesign", 2026-09-21), as close as the data allows. Paw's word of 2026-09-24: look and layout,
UI-only behaviour; anything that needs a server change is left out and logged in v2-notes. Short
plan, no ChatGPT spec or plan rounds.

**Reference:** the two artboards, copied verbatim into the repo:
[docs/design/2026-09-24-redesign/Main.dc.html](../../design/2026-09-24-redesign/Main.dc.html) (Thread view)
and [docs/design/2026-09-24-redesign/Listeners.dc.html](../../design/2026-09-24-redesign/Listeners.dc.html)
(listeners directory). Each is plain HTML with inline styles and a `<style>` block in `<helmet>`: that
block and the inline styles ARE the spec for colours, sizes, spacing, radii and type. Its data (62
listeners, seed-14, PR 14, "Reconnecting... retry in 4s") is sample content, never copy to ship.

**Architecture:** `src/web` only (Preact + one stylesheet). No server, client or core change. The
session store (`src/web/src/session.ts`) is not changed except, if truly needed, a pure read helper.

**Base:** `main` at 03e0d64. Branch `feat/web-redesign`.

**Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Global Constraints (every task)

- Read `CONTRIBUTING.md` and `src/web/README.md` first. Keep every behaviour the README describes:
  the in-place rules (`openMainInPlace`, `leavingIsSafe`), the `hidden` composer slot, `showListeners`
  as the one predicate, the listeners directory's generation guards, debounce, cursor and URL codec.
  This is a re-skin and re-layout, not a rewrite of logic.
- Tests: `cd src/web && npx vitest run <file>` for the DOM files (happy-dom, no database).
  `session.test.ts` needs Postgres via Docker; run it only if `docker ps` answers, else say so.
  Build first when a test imports another package: `pnpm -r build` from the repo root. Also
  `pnpm --filter @loom/web typecheck` and `pnpm --filter @loom/web build`.
- Existing tests that pin DOM structure you change must be updated to the new structure, never
  deleted to make them pass; every behaviour they assert must still be asserted. New UI behaviour
  (folding, the thread filter, the details panel toggle, row Invite) gets a test. RED first.
- Accessible markup: real `<button>`, `<a href>`, `<input>` with `<label>`; `aria-label` on
  icon-only buttons; `aria-current` conventions kept. Icons are inline stroke SVG copied from the
  artboards (`fill="none" stroke="currentColor"`), `aria-hidden="true"`. No emoji.
- Dark theme only, exactly the artboards' palette, as CSS custom properties on `:root` in
  `src/web/src/styles.css`. No colour literal outside `:root` except where the artboard itself uses
  a one-off.
- Never write an escape such as `\uXXXX` into a file (the tools decode it into literal bytes); type
  the character itself, or an HTML entity in JSX text. After staging, `git diff --cached --stat`
  must show no `Bin` rows.
- **No em dashes** in anything you write: user-visible strings, comments, commit messages. Use
  commas, colons or parentheses. (Existing comments may keep theirs.)
- No new runtime dependency except the two self-hosted font packages of Task 1.
- Do not fake data. A mockup element with nothing behind it is left out (see "Left out" below).
- One commit per task with the subject given; pristine test output.

## Left out (needs a server change; logged in v2-notes by the controller)

Top-bar search and `Ctrl K`; the Weave switcher dropdown; unread counts and the red "New" divider;
listener work status (working / idle / offline) and the sidebar's three stat tiles; Export CSV;
table row selection and "Invite selected to thread"; numbered pagination (the directory is cursor
paged: keep Show more); notification preferences; attach file; "messages queued until reconnected"
(nothing queues).

## Task 1: theme foundation

**Files:** `src/web/src/styles.css`, `src/web/src/main.tsx` (font imports), `src/web/package.json`.

- Add `@fontsource/ibm-plex-sans` (weights 400, 500, 600) and `@fontsource/ibm-plex-mono` (400, 500)
  as dependencies, pinned exact like the others, imported in `main.tsx`. Self-hosted so no visitor
  request goes to Google.
- Replace the light/dark `:root` pair with one dark token set from the artboards: page `#0e1319`,
  chrome `#0b0f14`, sunken `#11161d`, raised `#171d26`, hover `#1e2632`, line `#1c2430`, line-strong
  `#2b3441`, row line `#151c25`, fg `#e6eaf0`, fg-2 `#c9d1dc`, muted `#8f9aa8`, faint `#7f8a99`,
  pill-text `#a3adbb`, accent `#2f6fe0` (hover `#3b7cf0`), link `#7fb3ff` (hover `#a9ccff`),
  selected `#1a2a44`, info text `#8ab8ff`, ok `#6fe3a5` on `#123524` / `#10271b`, warn `#f0b35a`
  on `#2a2210`, danger `#ff8b8b` (line `#7a2f2f`), neutral pill `#242b35`, offline `#4a5563`.
  `color-scheme: dark`. Body font IBM Plex Sans 14px; `.mono` IBM Plex Mono.
- Base components as classes, copied from the artboards' `<style>`: `.btn` (default), `.btn-primary`,
  `.btn-ghost`, `.btn-sm` (26 to 28px high variants the artboards use inline), `.pill` with
  `-open -closed -working -idle -offline`, `.sec` (section label), `.muted`, `.kbd`, `.chip` / `.chip.on`,
  inputs, selects and textareas (32px, `#11161d`, `#2b3441` border, 6px radius), focus ring visible
  (2px accent outline), `a` link colours. Plain `button` gets the `.btn` look by default so
  untouched components are already in style.
- Restyle the main page `/` (`.main-page` and its cells, join/create forms, My Weaves rows,
  persistence bar, the `.center` cards, the name prompt modal) onto the tokens: sections as
  `#0b0f14` cards with `#1c2430` border, 8px radius. Class names only; no markup change is needed
  unless a class hook is missing.
- Tests: existing suites stay green (`components`, `main-page`, `listeners-page`). No new test
  needed for pure CSS.
- Commit: `feat(web): dark theme tokens and IBM Plex, from the design session`

## Task 2: the Weave page shell (top bar, left nav, thread header, details panel)

**Files:** `WeaveView.tsx`, `Header.tsx`, `ThreadList.tsx`, `ThreadTools.tsx` (split up),
`ListenersLink.tsx`, `GuidelinesPanel.tsx`, `RequestsPanel.tsx` (classes only), new
`components/ThreadHeader.tsx`, new `components/ThreadDetails.tsx`, `styles.css`, tests in
`test/components.test.tsx` / `test/listeners-page.test.tsx` / `test/lobby-view-live.test.tsx`.

Match `Main.dc.html`:
- **Top bar** (48px, chrome background): `LOOM` wordmark (the existing home link or in-place button,
  same rule), `/`, the Weave title (an `<h1>`, plain text, no switcher), archived pill, spacer, the
  connection pill (`open` = green "Connected", `connecting` = amber "Connecting...", `reconnecting`
  = amber "Reconnecting...", `closed` = red "Disconnected"; `role="status"`, keep the `conn` /
  `conn-<state>` classes), the identity (24px round initials avatar, name, role in muted; "reading as
  guest" when no identity), and the keepers' Archive Weave as a ghost danger button.
- **Left nav** (260px): section `Threads` with `+ New` (the existing new-thread form, inline below);
  filter tabs `Open · n`, `Closed · n`, `All` (UI state, default Open; the current thread is always
  listed even if the filter would hide it); thread rows `# name`, a mono tag for a linked artefact
  (`PR <n>` for a GitHub pull URL, else the host), closed pill, the invited badge in the blue count
  badge position; row = the existing `thread-pick` button (keep `aria-current`, `markCurrent`). The
  artefact link row under the name goes away (it moves to the details panel). Then, Lobby only:
  `Listeners` section header with `View all <n>` (the existing ListenersLink toggle button, same
  gate, same count states, `aria-current` while open); `Requests` (RequestsPanel, `+ Open` as its
  open-request toggle); then `Guidelines` (GuidelinesPanel, `Edit` in the section header). Footer
  line: `Weave <title> · <n> threads` (plus `· <n> listeners` on the Lobby when the count is known).
  Divider lines between sections as drawn.
- **Thread header** (52px, center column): `# name`, open/closed pill, a muted subtitle ("Weave-wide
  thread" for the General thread, else the artefact link as an `<a>` when `http(s)`, else nothing),
  spacer, `Fold system events` checkbox (state lives in WeaveView, default on, Task 3 uses it), and
  an icon button toggling the details panel (`aria-label="Thread details"`, `aria-expanded`). Not
  drawn while the listeners directory is the main area; that view gets its own header in Task 4.
- **Details panel** (300px, right, chrome background, hidden by the toggle; open by default at
  widths >= 1200px, closed below; UI state only): `Thread` facts grid (Status pill; Created: time
  and creator name; Linked artefact: link or "none"; Messages: `<n> · <m> system events`); buttons
  for whoever `canEditThread`: the artefact link form (from ThreadTools, "Save link") and, for
  moderators on a non-General open thread, `Close thread` (moved from the list row's "close" link).
  `In this thread · <n>`: participants with a dot, name (mono for agents), `you · role` or role;
  for `canEditThread`, the invite action per participant (from ThreadTools: `invite <name>` button,
  or `invited` mark). Not drawn while the listeners directory is open.
- Keep: invite banners, archived / read-only banners, refreshError bar, error bar, the hidden
  composer slot, NamePrompt.
- Tests: update selectors that moved (close link now in the panel, url form in the panel, invite
  buttons in the panel). New: the thread filter (Open hides closed threads, current always shown,
  counts), the panel toggle (`aria-expanded`, panel hidden/shown), the connection pill text per
  state.
- Commit: `feat(web): three-column Weave shell with thread details panel`

## Task 3: the message stream and the composer

**Files:** `MessageList.tsx`, `Composer.tsx`, `WeaveView.tsx` (pass `fold`), `styles.css`, tests.

Match the center column of `Main.dc.html`:
- **Message**: 32px square avatar (6px radius) with initials (humans: accent fill, white; agents:
  `#1a2a44` fill, `#8ab8ff` mono text), then a head line: name (600), an `agent` pill for
  `kind === "agent"`, role muted when keeper, time mono muted (`toLocaleTimeString`, keep `<time
  dateTime>`); body 14px / 1.5, markdown as now. Keeper actor: "Keeper", no avatar initials beyond K.
- **System events** as `.sysrow` (28px, `#11161d`, dashed `#263040` border, 6px radius, muted 12px).
  The guidelines-changed body still renders under its line.
- **Folding** (the header checkbox, default on): a run of two or more consecutive system events is
  one `.sysrow` with a chevron: a summary by kind ("3 joined · 10 profile updates · 1 invited"),
  the time range in mono (`13:07:09-13:07:11`, one time when equal), and a `Show <n> events` button
  that expands that run in place (and `Hide` collapses it). A single system event is shown as is.
  Fold off: every system event is its own sysrow. Pure grouping in a small tested helper
  (`src/web/src/components/fold.ts`).
- **Connection row**: while `connection` is `reconnecting` or `closed`, a solid-border sysrow at the
  end of the stream with an amber (reconnecting) or red (closed) dot: "Connection lost. Reconnecting..."
  / "Disconnected." No claim about queued messages.
- **Composer**: the bordered box (`#11161d`, 8px radius) with the textarea (min 72px, no own border)
  and a footer strip: `Markdown · Enter send · Shift Enter newline` with `.kbd` keys, spacer, primary
  `Send` (28px). Placeholder `Message #<thread name>, @name to mention` (closed thread: keep "This
  thread is closed"). A visually hidden `<label>` for the textarea. Mention popup restyled on tokens.
- Tests: the fold helper (runs, singles, messages break runs, summary words, time range); the list
  folds and expands; fold off shows every line; the connection row per state; composer still sends
  on Enter and the mention logic tests stay green.
- Commit: `feat(web): message stream with folded system events and the new composer`

## Task 4: the listeners directory as a table

**Files:** `listeners/ListenersPage.tsx`, `listeners/FacetChips.tsx`, `ProfileCard.tsx` (kept for
the requests panel and the row details), `WeaveView.tsx` (the directory's header), `styles.css`,
`test/listeners-page.test.tsx`.

Match `Listeners.dc.html`, keeping every behaviour of the current page (debounce, generations,
cursor, facets, URL codec, partial-link notice, changed line, the four states, Clear filters):
- **Header** (52px): `Listeners` as the view's heading (keep it an `<h2>`, the page `<h1>` is the
  Weave title), muted "`<total>` listeners on `<Lobby title>`" when known.
- **Toolbar** (padding 12px 20px, bottom line): the search field (320px, magnifier icon, placeholder
  "Filter by name or owner"), then sort and direction selects labelled `Sort`, and Clear filters as a
  ghost button. Below it the facet rows, restyled as the artboard's 28px round `.chip` / `.chip.on`
  with counts; the effort row keeps its nesting under a selected model.
- **Table** instead of the card grid: columns `Listener` (mono, 500), `Owner`, `Models`
  (`model/effort, ...`), `Tools` (first three, then `+n`), `Runtime`, `Serves`, `Last seen`
  (mono muted, "n min ago" / "never"), `Joined` (mono muted time or date), and `Actions` right
  aligned: `Invite` (only when this browser `canEditThread` the current Thread and the listener is
  not in it yet: calls `session.invite(currentThreadId, id)`; label `Invited` disabled after, errors
  shown in the page's own error line) and a ghost `Profile` toggle that expands a details row under
  it with the full `ProfileCard`. Header 36px uppercase 11px faint; rows 44px with `#151c25` lines and
  the `#11161d` hover. Stale rows dim while a query runs, as now. Empty and error states unchanged in
  words.
- **Footer strip** (padding 10px 20px, top line, muted 12px): the counts sentence as now, spacer,
  `Show more` as a ghost button with its own error beside it.
- Tests: update card-based selectors to rows (`tbody tr`), keep every assertion's meaning; new: the
  row Invite (shown only with authority, calls invite once, then disabled) and the Profile toggle.
- Commit: `feat(web): listeners directory as a table`

## Task 5 (controller): screenshots and polish

The controller runs the dev server, compares each view with the artboards in Chrome, and sends
fixes as small follow-up tasks. Then v2-notes gets the "Left out" list, and the PR.
