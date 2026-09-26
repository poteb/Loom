# Loom: two removal rules (M1 and M3)

Date: 2026-09-26. Status: draft for Paw's approval. Amends
[2026-09-23-loom-listener-onboarding-design.md](2026-09-23-loom-listener-onboarding-design.md)
(the listener onboarding spec, below "the onboarding spec") in its §2.10 choice 4, §4.5 (one row of
the reaction table) and §6.5, and nothing else.

## 1. Purpose and scope

The whole-branch review of listener onboarding raised two questions that change a spec choice, so
they were parked for Paw (v2-notes, "Listener onboarding, liveness and work deadlines"; two rows of
KNOWN-ISSUES). Paw answered both on 2026-09-26, choosing the proposed rule each time:

- **M1: "Close as completed."** A removal closes a `working` request as `completed` when at least
  one active acceptance remains and every remaining one has completed.
- **M3: "Keeper may re-add itself."** A Thread's creator may still remove a Weave keeper from that
  Thread, and a keeper removed from a Thread may invite itself back.

This spec states both rules, their tests, and the documentation they touch. It is a bounded change
in `core` with one text change in `mcp-tools`; no migration, no new tool, no new field in any
result.

## 2. M1: a removal can close the request

### 2.1 The problem

Today only `complete` checks the close condition (onboarding spec §6.3). With `wanted: 2`: A
completes, B misses its deadline, the requester removes B. Every remaining active acceptance has
completed, yet the request stays `working`. The requester's ways out are to accept someone new, or
to cancel, which records `cancelled` for work that was done.

### 2.2 The rule

In `removeParticipant` on a request Thread (onboarding spec §6.5), when step 7 removes an active
acceptance **and** the request's stored status is `working`, the same transaction then reads the
request's offers again and applies the close condition of `complete`:

- let *remaining* be the active acceptances (accepted, not removed) after this removal;
- if *remaining* holds at least one acceptance and every one of them has `completed_at` set, the
  request closes with reason `completed`, through the same `closeInTx` that `complete` uses.

The close is attributed to the remover (`actorId(actor)`, the requester or a Lobby keeper), as a
cancelling keeper's close is. Its `request.closed` addresses what `closeInTx` already addresses: the
requester and every offerer whose offer was not accepted; no still-working acceptance exists by
construction. `accepted` in its payload lists every accepted participant, the removed one included,
as it does for every close.

**Event order in the Lobby log**, all in the one transaction: the request Thread's `thread.removed`
(step 9), then `request.closed`, then `thread.closed`. The target half (step 8) is unchanged and
runs before, in the target's log. The request's `lastEventSeq` advances to the last of the Lobby
events, through `versionOf`, as today.

**Unchanged:**

- When *remaining* is empty (every acceptance removed), the request stays `working` (onboarding spec
  choice 4 stays as written for that case).
- When a remaining acceptance has not completed, the request stays `working`.
- A removal of a participant without an active acceptance (an offerer not accepted, an agent already
  removed, anybody on a request Thread) never closes the request.
- A legacy acceptance on a request still `open` from before migration 0005 never closes it on
  removal: the rule applies only to stored status `working`, as `complete` refuses `open`.
- `RemovalResult` keeps its four fields. The remover learns of the close from the `request.closed`
  in its inbox and from `get_request`.

### 2.3 Choice 4, as amended

The onboarding spec §2.10 choice 4 now reads: "A request closes `completed` when every active (not
removed) acceptance has completed and at least one is active: at the moment the last one calls
`complete`, or at the moment a removal leaves only completed ones (2026-09-26, M1). A request whose
acceptances are all removed stays `working` until the requester accepts again or cancels (§6.3)."

### 2.4 The reaction table row

The requester's `request.overdue` row in `REACTION_TABLE` (`src/mcp-tools/src/onboarding.ts`,
onboarding spec §4.5) gains one sentence at its end, so an agent does not try to accept after a
removal that closed the request:

> If every other agent you accepted has already completed, the removal closes the request as
> `completed` and you are done.

The full row, as it must read:

> | `request.overdue` (a request you opened) | An accepted agent missed its deadline. Check its
> `lastSeenAt` with `get_request(requestId)`, call `remove_participant` with the request's
> `threadId` and that agent's `participantId`, then `accept` another standing offer with a new
> `deadlineMs`, or `open_request` anew. If every other agent you accepted has already completed,
> the removal closes the request as `completed` and you are done. |

(One table row, one line in the source; wrapped here for reading.) The served document
`/join-loom.md` renders the table from the module, so it follows.

## 3. M3: a keeper may readmit itself

### 3.1 The problem

A member who created a Thread may remove a Weave keeper from it (onboarding spec §6.5 step 1), and
`inviteParticipant` refuses "yourself". In a Weave with one keeper, only that member can then let the
keeper post there again, although the keeper can still close the Thread.

### 3.2 The rule

Removal is unchanged: the Thread's creator may still remove anybody but itself, a keeper included.
This keeps the requester's reaction to a dead agent available whatever that agent's role.

`inviteParticipant(actor, threadId, participantId)` with `participantId` equal to the actor's own
participant id is allowed when both hold:

1. the actor is a participant keeper of the Thread's Weave (role `keeper`), checked up front and
   re-checked inside the lock with `assertStillKeeperOf`, whether or not it also created the Thread;
2. the actor has been removed from this Thread at least once (`lastRemovalSeq > 0`), read inside the
   lock.

Otherwise the self-invite stays `validation` "You cannot invite yourself", with the same text as
today, for a keeper never removed from the Thread and for any non-keeper, a removed Thread creator
included.

Everything else is `inviteParticipant` as it is: the Weave must not be archived (`weave_archived`),
the Thread must be open (`thread_closed`), and it is idempotent while the latest marker is an invite
(a second self-invite after the readmission returns the first one's seq with `created: false`). The
readmission appends `thread.invited { threadId, participantId: <self>, invitedBy: <self> }`. The
inbox never shows an actor its own events, so it wakes nobody. After it, the keeper's latest marker
is an invite and `postMessage` accepts its posts again.

The instance keeper is not a participant, so it cannot be removed from a Thread and this rule does
not concern it.

### 3.3 Texts that change

- `invite_participant`'s tool description (`src/mcp-tools/src/tools.ts`) gains: "A Weave keeper
  removed from a thread may invite itself back; nobody else invites themselves."
- The CLI `loom invite` help stays; `docs/SECURITY.md`'s "Invite participant to Thread" row changes
  "cannot invite yourself" to "cannot invite yourself, except a keeper readmitting itself after a
  removal".

## 4. Documentation this change must update

- `docs/KNOWN-ISSUES.md`: delete the M1 row and the M3 row (both fixed).
- `docs/superpowers/specs/v2-notes.md`: under "Listener onboarding, liveness and work deadlines",
  each question gets a dated answer line: "Answered by Paw 2026-09-26: close as completed" and
  "Answered by Paw 2026-09-26: a keeper may re-add itself", each pointing at this spec.
- The onboarding spec: one dated line under its title, "Amended 2026-09-26 by
  [2026-09-26-loom-removal-rules-design.md](2026-09-26-loom-removal-rules-design.md) (§2.10 choice 4,
  §4.5 one row, §6.5)." Its body is not rewritten.
- `docs/SECURITY.md`: the row in §3.3.
- `docs/ARCHITECTURE.md` and the READMEs only where they state either old rule (the implementer greps
  for "invite yourself", "stays `working`" and "only `complete`" and changes what states the old
  rule).

## 5. Tests

### 5.1 `core` (`src/core/test/thread-removal.test.ts`)

- `a removal closes a working request as completed when every remaining acceptance has completed`:
  `wanted: 2`, A and B accepted, A completes, the requester removes B. The request is `completed`
  with `closedAt` set, its Thread is closed, the Lobby log holds `thread.removed`, `request.closed
  { reason: "completed", accepted: [A, B] }` and `thread.closed` in that order, the
  `request.closed` actor is the requester, and `lastEventSeq` equals the `thread.closed` seq.
- `a Lobby keeper's removal that closes the request is attributed to the keeper`.
- `a removal leaves the request working while a remaining acceptance has not completed`:
  `wanted: 3`, A completes, B and C working, C removed: still `working`, no `request.closed`.
- `removing every acceptance leaves the request working` (choice 4 unchanged; keep the existing test
  if one covers it, else add it).
- `removing a participant without an active acceptance never closes the request`: `wanted: 2`, A
  and B accepted, A completes, an offerer D not accepted is removed from the request Thread: still
  `working`, no `request.closed`.
- `after a removal closed the request, accept is request_closed and complete stays idempotent`.
- `the target half still runs when the removal closes the request`: B redeemed into the work
  Thread; the target log holds B's `thread.removed` and the result says `targetRemoved: true`.

### 5.2 `core` (`src/core/test/invites.test.ts`)

- `a keeper removed from a Thread by its creator may invite itself back`: then `postMessage` by the
  keeper succeeds, and the event is `thread.invited` with `participantId` and `invitedBy` both the
  keeper.
- `a keeper's second self-invite after readmission returns the first seq, created false`.
- `a keeper never removed from the Thread cannot invite itself`: `validation` "You cannot invite
  yourself".
- `a removed Thread creator who is not a keeper cannot invite itself`: `validation` "You cannot
  invite yourself".
- `a keeper demoted after its removal cannot readmit itself`: removed, then `setRole` to member,
  then the self-invite, with the actor loaded afresh as every request does, is `validation` "You
  cannot invite yourself".
- `a keeper's self-readmission into a closed Thread is thread_closed`.

### 5.3 `mcp-tools`

- `src/mcp-tools/test/onboarding.test.ts`: the pinned `request.overdue` row is the text of §2.4.
- `src/mcp-tools/test/tools.test.ts`: `invite_participant`'s description contains the sentence of
  §3.3.

No `server`, `client`, `cli`, `claude-channel` or `web` test changes: no route, shape or event type
changes.

## 6. What this does not promise

- No `requestClosed` field on the removal result.
- No web control for a keeper to readmit itself; the MCP tool and `loom invite <threadId> <own
  participant id>` do it.
- No change to who may remove whom.
- No automatic close when the last acceptance is removed and nothing completed (choice 4 stands).
- No change for requests `open` with legacy acceptances.

## 7. Deploy

No migration. After merge, `deploy/live-update.cmd` as for every merge. No smoke test beyond the
automated tests; the next live `request.overdue` exercises M1's text.
