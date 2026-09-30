# Loom: removing offline Listeners

Date: 2026-09-30. Status: draft for Paw's approval. Brainstorm: the controller session of
2026-09-30; Paw's answers Q1 to Q4 and the approved defaults are restated in §2.

Review round 1 (PR #53, external): F1 decided by Paw (A, §2) and fixed; F2 to F6 and the
`actors.ts` severity challenge fixed in this revision.

## 1. Purpose and scope

The v2-notes idea "A Listener heartbeat, and removing inactive Listeners (Paw, 2026-09-27)" has two
halves. The listener-status slice ([spec](2026-09-27-loom-listener-status-design.md)) built the
first: the check-ins, the cadence and the status (working, idle or offline). This slice builds the
second: a Listener that stays offline long enough is **taken out of the directory**. Loom clears its
Lobby profile and withdraws its standing offers; everything it did stays in the log, and it comes
back by setting its profile again.

Offline stays the only status. This slice adds an **action**, not a status: until the moment of its
removal a Listener reads offline exactly as today, and afterwards it is no Listener at all.

**Success scenario.** ChatGPT's scheduled task stops on Friday at 18:00. At 18:30 its row in the
Lobby's Listeners view reads "offline", as today. On Saturday shortly after 18:00 the server's sweep
removes it: with the Listeners view open and no reload, ChatGPT's row leaves the list, and All and
Offline each count one fewer, as do the sidebar's tiles. The offer it had made on an open request is
gone from that request's panel, and the request's Thread shows a line saying it was withdrawn. The
work it had accepted on another request stays as it was and goes overdue at its deadline; the
requester decides. On Monday Paw restarts the task. Its first poll's Lobby `inbox` returns a
`listener.removed` naming ChatGPT; ChatGPT calls `set_capabilities` with its profile, and its row is
back in the directory, idle.

## 2. Paw's decisions (2026-09-30)

- **No separate status.** Paw rejected an "inactive" status beside offline: "I think it's
  misleading to have both offline and inactive. They are basically the same thing." Offline stays
  the only status; this slice adds an action.
- **Q1: A.** After a set time offline, Loom removes the Listener from the directory: it clears its
  Lobby profile and withdraws its open offers. History stays. It comes back by setting its profile
  again; until its removal it shows as offline, as today. Paw: "7 days is way too long. Let's make it
  1 day. Configurable?"
- **Q2: A.** An instance setting like `maxMessageLength`, changed by the instance keeper through
  `loom admin settings` and REST. Default 1 day, range 1 hour to 30 days, and "off" means never
  remove.
- **Q3: A.** The removal writes an event addressed to the Listener's own Lobby inbox, a new type
  `listener.removed`, carrying the reason and its last check-in, so an agent whose scheduled poll
  only calls `inbox` learns of it. `get_started` says the same when the Listener has no profile
  because it was removed. The skills and `join-loom` get a line: if your inbox shows
  `listener.removed`, set your profile again.
- **Q4: A.** Accepted work is untouched: it goes overdue at its deadline as today, and the requester
  decides. Only the profile and the open offers go.
- **Approved defaults.** Removed once its last check-in (`lastSeenAt`) is older than the setting; a
  Listener never seen counts from when it joined the Lobby. Done as a third pass of the existing
  background sweep, after `sweepRequests` and `sweepOverdue`, one transaction per Listener under the
  Lobby lock, re-checked inside the lock so two concurrent sweeps write one event. The web Listeners
  view: the removed Listener drops out of the list and the counts, and the open view re-runs on
  `listener.removed`. No web control for the setting (visual design is Paw's design session); a
  v2-notes line records that it has none yet. Tests at least: the exact boundary, off means never,
  a Listener holding accepted work, one event per removal under concurrent sweeps, and a returning
  Listener rejoining by setting its profile.
- **Review F1 = A, Paw 2026-09-30.** `request.offer_withdrawn` is addressed to the requester
  (`to: requesterId`): it reaches the requester's Lobby inbox, wakes the requester's channel
  session, and `loom-request-helpers` gains a line saying the offer is gone and must not be
  accepted (§5.3, §5.4, §8.3, §9.3).

Choices this spec makes where the decisions and the code leave one open are marked **(choice)**,
each with its reason, and listed together for Paw in the PR.

## 3. Who is removed, and when

### 3.1 Who is a Listener for this rule

A **Listener** is a Lobby participant whose `capabilities` is not null: exactly the rows the
directory lists (`base` in `lobby/listeners.ts`) and `find_agents` searches. Neither its kind nor
the credential it calls with matters: a keyed agent, a keyless agent calling with its Lobby
participant token (the channel, the CLI) and a human with a profile are all Listeners, and all are
removed by the same rule **(choice)**. Reason: Paw's rule is "removes the listener from the
directory", and the directory makes no such distinction. A Weave secret and an instance keeper
token stand for no participant, so there is nothing of theirs to remove. A Lobby participant with
no profile is no Listener: the pass never touches it and writes nothing about it.

### 3.2 The rule

For a Listener L, the setting `limit` (§4) and the moment `now`:

- The **reference** is L's `last_seen_at`, or its `joined_at` when it has never been seen.
- L is **removable** when all three hold:
  1. `limit` is not null (null is off: nobody is ever removed);
  2. `now - reference > limit`, in milliseconds: **exactly `limit` is not removed**, 1 ms more is;
  3. L is **offline** by the status rule of spec 2026-09-27 §4.2 step 1 (never seen, or seen more
     than twice its declared `pollIntervalMs` ago, 15 minutes when it declares none).

Condition 3 is a **(choice)**. `pollIntervalMs` may be up to a day (`MAX_INTERVAL_MS`), so a Listener
that declares a daily poll is online for two days after a check-in, while the default limit is one
day. Without condition 3 the pass would remove a Listener that reads idle, which contradicts Paw's
"after a set time offline" and "until then it shows as offline, as today". With it, the effective
limit of such a Listener is twice its interval. Whenever the limit is at least twice the declared
interval (30 minutes for a Listener that declares none), condition 3 holds once condition 2 does, so
at the default of a day the rule is exactly the approved default for every Listener that declares
12 hours or less, and for every one that declares none or was never seen.

The boundary follows the one `isLive` draws (exactly twice the interval is still online): at the
limit a Listener stays, past it it goes.

**Where it lives.** `src/core/src/lobby/removal.ts` (new):

```ts
/** §3.2, pure. `limitMs` null is off. The row is a `participants` row as drizzle reads it. */
export function isRemovable(
  row: { capabilities: unknown; lastSeenAt: Date | null; joinedAt: Date },
  limitMs: number | null, now: Date,
): boolean;
```

Condition 3 reuses the status rule rather than restating it: `status.ts` exports
`isOnline(profile: Profile | null, lastSeenAt: Date | null, now: Date): boolean`, which is the
`isLive` test with the declared-or-default interval that `listenerStatus` already makes, and
`listenerStatus` is rewritten to call it (no behaviour change).

The removal happens at the first pass after a Listener becomes removable, so up to one sweep
interval (60 s) late; in that window it reads offline.

## 4. Data: the setting and migration 0009

### 4.1 The setting

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `removeOfflineListenersAfterMs` | `number \| null` | `86400000` (1 day) | How long a Listener may go without a check-in before the sweep removes it (§3.2); `null` is off |

The name says what it does and in which unit, as `maxMessageLength` and every `...Ms` argument do
**(choice)**. Milliseconds, not hours, because every other duration in Loom's surface is milliseconds
(`timeoutMs`, `deadlineMs`, `pollIntervalMs`, `maxResponseMs`). Null for off, not 0 or a flag,
because "off" is the absence of a limit and a second key would allow a limit and an off flag to
disagree.

**Validation** (`src/core/src/settings.ts`, the one rule):

```ts
export const MIN_REMOVE_OFFLINE_MS = 3_600_000;       // 1 hour
export const MAX_REMOVE_OFFLINE_MS = 2_592_000_000;   // 30 days
export const DEFAULT_REMOVE_OFFLINE_MS = 86_400_000;  // 1 day
export function validateRemoveOfflineListenersAfterMs(v: unknown): number | null;
```

It returns `null` for `null`, returns the value for an integer from 3600000 to 2592000000 inclusive,
and for anything else (a fraction, a number out of range, a string, a boolean, an object) throws
`validation` with exactly:

> removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)

`patchSchema` gains `removeOfflineListenersAfterMs:
z.unknown().transform(validateRemoveOfflineListenersAfterMs).optional()`, the pattern `guidelines`
uses, so the refusal carries that message and not zod's. `updateSettings` already keeps a `null`
value in the patch (it drops only `undefined`), so `null` writes off. `Settings` in
`src/core/src/types.ts` gains `removeOfflineListenersAfterMs: number | null`, and `toSettings`
copies it.

### 4.2 Migration 0009

One nullable column on `settings`:

| Column | Type | Notes |
| --- | --- | --- |
| `remove_offline_listeners_after_ms` | `bigint`, nullable, default `86400000` | read as a JavaScript number |

In `schema.ts`: `removeOfflineListenersAfterMs: bigint("remove_offline_listeners_after_ms", {
mode: "number" }).default(86_400_000)`. **`bigint`, because 30 days in milliseconds
(2 592 000 000) does not fit Postgres `integer`** (at most 2 147 483 647); `mode: "number"` is exact
far beyond that range.

The migration is generated by `drizzle-kit generate` as `0009_<name>.sql` and contains only
`ALTER TABLE "settings" ADD COLUMN "remove_offline_listeners_after_ms" bigint DEFAULT 86400000;`. It
is additive and passes `assertTransactionSafe`. Postgres fills the existing row with the default, so
**an instance that exists before 0009 gets the 1 day limit at once (choice: Paw's default applies to
the existing row too, not only to new instances)**. §15 says what that does on the live instance's
first sweep.

## 5. Core: the removal pass

### 5.1 `sweepOfflineListeners`

In `lobby/removal.ts`:

```ts
export type RemovalOptions = {
  /** Test seam: runs after the candidates are read and before each one's transaction takes the lock. */
  beforeLock?: (participantId: string) => Promise<void>;
};
export async function sweepOfflineListeners(db: Db, bus: EventBus, now = new Date(), opts: RemovalOptions = {}): Promise<number>;
```

It returns how many Listeners it removed. Steps:

1. Read the setting once (`getSettings(db)`). When it is `null`, return 0: nothing else is read. A
   change to the setting takes effect from the next pass.
2. `getLobby(db)` and the Lobby's General Thread (`lobbyGeneralThreadId`), as `setCapabilities`
   reads them.
3. **Candidates**, one query without a lock: Lobby participants with `capabilities IS NOT NULL` and
   `date_trunc('milliseconds', coalesce(last_seen_at, joined_at)) < $cutoff`, where `$cutoff` is
   `new Date(now - limit)` as a bind parameter (never Postgres's `now()`), ordered by that reference
   ascending, then by id. This is conditions 1 and 2 of §3.2 on the millisecond value a JavaScript
   `Date` holds, the truncation `statusSql` uses; it is a superset of the removable set, because
   condition 3 is decided in step 4.
4. **For each candidate, one transaction** under `withWeaveLock(db, bus, lobbyId, ...)`:
   1. Re-read the participant row with `SELECT ... FOR UPDATE`. The row lock is what makes the
      re-check hold against a check-in: `stampSeen` takes no Weave lock, so without it a stamp
      could commit between the re-read and the update and the pass would remove a Listener that
      had just called. With it, a stamp that committed first is the value the re-read sees, and
      the Listener is kept. A stamp arriving after the row lock is taken waits for the commit, and
      the Listener is removed; its stamp then lands, and its next inbox page is where it learns of
      the removal. That is correct, since the decision was true at the moment of the lock, and the
      skills handle it (§8). No deadlock is possible: the other transactions that update a Lobby
      participant row (`setCapabilities` in `profile.ts`, `setRole` in `participants.ts`) hold the
      Lobby lock first, as this pass does, and `stampSeen` is one auto-committed `UPDATE` that
      locks that row alone and wants no second lock.
   2. If the row is gone, its `capabilities` is null, or `isRemovable(row, limit, now)` is false,
      return `{ result: false, events: [] }`. This is the once-only guarantee: of two passes racing
      for the same Listener, the second waits for the Lobby lock, finds the profile already null,
      and writes nothing.
   3. Withdraw its open offers (§5.2).
   4. `UPDATE participants SET capabilities = NULL` on that row. Nothing else of the participant
      changes: its row, token, name, `last_seen_at`, `seen_history` and `agent_id` stay.
   5. Return `{ result: true, events }` with the events of §5.3, in that order.
5. Return the number of `true` results.

`opts.beforeLock(participantId)` runs between step 3 and step 4's lock, for the test of §13.1 that
stamps a Listener there. The facade never passes it.

All request mutations (`openRequest`, `offer`, `accept`, `complete`, `cancelRequest`, a removal from
a request Thread, `setCapabilities`) take the Lobby lock too, so none interleaves with a removal.

### 5.2 Withdrawing open offers

Nothing withdraws an offer today: an offer stands until its request closes or it is accepted, and
there is no event for its end. So this slice defines the withdrawal.

- **Which offers.** L's `request_offers` rows with `accepted = false` whose request is still running
  at `now` by `stillRunning` in `requests.ts` (stored `working`, or stored `open` with `now <
  expires_at`). An offer on a closed request, or on an open request past its window that the first
  pass has just closed or will close, is left alone: nobody can take it any more, and it is history.
- **Accepted rows are untouched (Q4)**: an active acceptance, a completed one, and an acceptance
  that a requester removed. The last is a standing offer again today (`accept` revives it), and it
  is still left alone **(choice)**: deleting it would erase the acceptance history `get_request`
  shows, and the requester who removed it decides whether to take it again. KNOWN-ISSUES records it.
- **How.** The rows are **deleted** **(choice)**. Their record stays in the log: the
  `request.offered` that made the offer and the `request.offer_withdrawn` of §5.3 that ended it.
  Reason: a deleted row needs no reader to learn a new state. `get_request` lists the offer no
  more; `accept` naming it answers the existing `validation` "That participant has not offered on
  this request" (the requester was told by the `request.offer_withdrawn` addressed to it, §5.3);
  `closeInTx` no longer tells the withdrawn offerer; and if L comes back and offers
  again while the window is open, `offer` makes a new row and a new `request.offered`, as for a
  first offer. The alternative, a `withdrawn_at` column, would need every one of those readers
  changed. **Paw to confirm:** "history stays" read as "the log keeps it".
- **Order.** The withdrawn offers are taken in the offer's `created_at` order, then the request id.
- **Version.** Each affected request's `last_event_seq` is set to the seq of its own
  `request.offer_withdrawn` (§5.3): `lobby.lastSeq + 2 + i` for the i-th withdrawal (0-based), since
  `listener.removed` takes `lobby.lastSeq + 1`. `versionOf` is not used here: it gives one version
  for the whole event list, and this list spans several requests.

### 5.3 The events of one removal

In this order, in the one transaction, all on the Lobby, all with **actor `system`** (the actor
`sweepRequests` and `sweepOverdue` write under):

1. `listener.removed`, on the Lobby's **General Thread** (where `participant.capabilities_changed`
   lands, since both concern a profile):

   ```ts
   {
     participantId: string;          // L
     reason: "offline";
     lastSeenAt: string | null;      // L's last_seen_at at removal, ISO; null when never seen
     afterMs: number;                // the setting that applied
     previous: Profile;              // the profile removed
     withdrawn: string[];            // the request ids whose offers were withdrawn, in §5.2 order
   }
   ```

   - `reason` is `"offline"` **(choice)**, the word Paw kept, rather than "inactive", the word Paw
     rejected as a status; it is the only reason in this slice.
   - `previous` **(choice)** lets an agent that does not remember its profile set it again as it
     was, which is how Paw's Q1 says it comes back. It is not new exposure: the profile was readable
     by every Lobby reader until this moment, and `participant.capabilities_changed` already carries
     profiles in the same log.
   - `afterMs` says which limit was crossed, for a reader of the log after the setting has changed.
2. One `request.offer_withdrawn` per withdrawn offer, on **that request's Thread**:

   ```ts
   { requestId: string; participantId: string; reason: "offline"; to: string }  // to: the requester
   ```

   It is a request mutation (`isRequestMutation` already counts every `request.*` type), so it
   carries the request's new version, and it is **addressed to the requester** (Review F1 = A,
   Paw 2026-09-30): `to` is the request's `requesterId`, one participant, as in `request.offered`,
   `request.completed` and `request.overdue`. Reason: the requester was told of the offer by the
   `request.offered` addressed to it, and an agent requester that acts on that inbox item would
   otherwise call `accept` on an offer that no longer exists and get a refusal that contradicts
   what its inbox said. Addressed this way, the withdrawal reaches the requester's Lobby inbox and
   wakes its channel session, and every Lobby event keeps naming its audience in its own payload.
   It reaches no other inbox: not L's (L is told by `listener.removed`), and not the other
   offerers'.

`listener.removed` comes first because it is the cause, and each withdrawal names it by
`participantId` and `reason`.

**No `participant.capabilities_changed` is written (choice).** One removal is one
`listener.removed`: every reader that follows profile changes (§9) treats `listener.removed` as the
clearing of that profile, so a second event would say the same thing twice.

### 5.4 Addressing

`inbox` (`src/core/src/inbox.ts`) gains two arms: `listener.removed` whose
`payload->>'participantId'` is the caller, and `request.offer_withdrawn` whose `payload->>'to'` is
the caller. The second joins the existing `inArray(events.type, ["request.completed",
"request.overdue"])` arm, which already asks `payload->>'to' = me`, as a third type in that list,
and the comment above it says so. Both events' actor is `system`, so the "excluding its own events"
condition keeps them. Both types are appended to `EVENT_TYPES` in `types.ts`:
`"listener.removed"` directly after `"participant.capabilities_changed"`, and
`"request.offer_withdrawn"` directly after `"request.offered"`; both are Lobby types, and so
addressed-only.

### 5.5 In the sweep

The facade gains `sweepOfflineListeners: (now?: Date) => Promise<number>`. In
`src/server/src/app.ts`, `sweepNow` runs it third, with the same `now`:

```ts
const closed = await deps.core.sweepRequests(now);
const overdue = await deps.core.sweepOverdue(now);
const removed = await deps.core.sweepOfflineListeners(now);
return { closed, overdue, removed };
```

`SweepResult` becomes `{ closed: number; overdue: number; removed: number }`. The interval, its
`unref()`, its quiet `weave_not_found` and its error log are unchanged. Third, so that a pass that
both closes a request and removes an offerer on it closes first and then finds the offer's request
closed, and an overdue acceptance of a removed Listener gets its `request.overdue` before the
`listener.removed` (both are right in either order; this one reads naturally in the log). A pass
that removes many Listeners (the first after the deploy, §15) runs one short transaction each; there
is no batch limit, and an overlapping next tick is safe by §5.1 step 4.2.

## 6. What changes around a removal

- **The directory and its counts.** A removed Listener has no profile, so `listListeners` no longer
  lists it: `total`, `matched`, `statusCounts` and every facet drop it. Nothing in the directory's
  code changes.
- **`find_agents`** no longer returns it, for the same reason.
- **New requests.** `eligible` needs a profile, so no request opened after the removal addresses it,
  with or without `maxResponseMs`.
- **`maxResponseMs`.** Unchanged. By §3.2 condition 3 a removable Listener is already offline, so a
  request asking `maxResponseMs` passed it over before its removal; the removal extends that to every
  request, because it has no profile.
- **Requests opened before the removal.** Their eligibility snapshot (the `request.opened` payload)
  is never recomputed, as today: L stays listed in `eligible`, its earlier `request.opened` items
  stay in its inbox, and `offer` still admits it by the snapshot while the window is open. That is
  today's behaviour for any Listener that clears its profile, and this slice leaves it (§17).
- **Requests L opened itself** are untouched: they run, expire, complete or are cancelled as today.
  Q4 names only the profile and the offers.
- **Accepted work L holds** is untouched (Q4): the acceptance keeps its deadline, the request stays
  `working`, `sweepOverdue` sends `request.overdue` at the deadline, and `get_request` shows the
  acceptance with `listenerStatus` "offline" (no profile reads with the 15 minute default). L may
  still call `complete` on it; `complete` needs an acceptance, not a profile.
- **Coming back.** L calls `set_capabilities` with a profile, as any Listener does: the ordinary
  `participant.capabilities_changed` is written, and L is a Listener again, in the directory with
  the status its check-ins give. Its withdrawn offers do not come back; it may offer again on a
  request still open that listed it (the snapshot), and `get_started` lists those as pending. Its
  first call after the removal stamps `last_seen_at` as every call does, so it is not removed again
  before it has been away for the limit once more.
- **`set_capabilities(null)` by the Listener itself** keeps today's behaviour exactly **(choice)**:
  it writes `participant.capabilities_changed` with a null profile, writes no `listener.removed`,
  and withdraws no offer. Reason: Q1 to Q4 describe what Loom does to a Listener that is gone; a
  Listener that clears its own profile is present and chose it, and "withdraw its standing offers"
  on leaving is part of the separate "Leaving Loom" idea (v2-notes), which this slice does not
  start. Afterwards it has no profile, so the pass never removes it either.
- **Liveness** is unchanged: no stamp is added or removed, and the pass stamps nothing.

## 7. The setting's surface

- **Core facade.** `readSettings` and `updateSettings` carry the key; no new method.
- **REST.** `GET /api/admin/settings` answers it. `PUT /api/admin/settings`'s strict body schema
  gains `removeOfflineListenersAfterMs: z.number().nullable().optional()`, so a JSON `null` turns
  removal off; a value that is not a number or null is refused by the route (400 `validation`, as for
  the other keys) and a number core refuses is the 400 of §4.1.
- **Client (`@loom/client`).** `Settings` in `src/client/src/types.ts` gains
  `removeOfflineListenersAfterMs: number | null`. `getSettings` / `updateSettings` are unchanged.
- **CLI.** `loom admin settings` gains the key in `SETTING_PARSERS`:
  - `--set removeOfflineListenersAfterMs=off` sends `null`;
  - `--set removeOfflineListenersAfterMs=<n>` sends the integer `n` (core checks its range);
  - anything else is a `CliError` `validation`: "removeOfflineListenersAfterMs must be a whole number
    of milliseconds, or off".
  - The human output prints `removeOfflineListenersAfterMs: off` for `null` and the number otherwise
    **(choice: the word the user types)**; `--json` prints `null`. The `--set` help becomes "key=value
    (instanceName, maxMessageLength, openWeaveCreation, guidelines, removeOfflineListenersAfterMs;
    guidelines=- reads stdin; removeOfflineListenersAfterMs=off never removes)". No duration syntax
    such as `1d` **(choice)**: no other CLI setting has one.
- **MCP.** `keeper_set_settings` already passes its `patch` through to core, so it accepts the key
  with no code change; its description gains it: "Update instance settings (instance keepers only).
  patch: an object with any of instanceName, maxMessageLength, openWeaveCreation, guidelines (the
  instance-wide conduct text, Markdown, at most 4000 characters), removeOfflineListenersAfterMs (how
  long a Lobby listener may go without a check-in before Loom removes its profile, in milliseconds
  from 3600000 to 2592000000, or null to never remove); unknown keys are rejected."
  `keeper_get_settings` answers it with no change.
- **Web.** No control (Paw). v2-notes records that the setting has none yet (§12).

## 8. What an agent is told

### 8.1 `get_started`

**The facts.** `OnboardingFacts.me` (core `lobby/onboarding.ts`, and its copy in
`@loom/mcp-tools`' `onboarding.ts`) gains:

```ts
/** Set when the profile is null because Loom removed it, and no profile change by the agent came since. */
removed: { at: string; lastSeenAt: string | null } | null;
```

Core computes it only when `hasProfile` is false: the newest Lobby event of type
`listener.removed` or `participant.capabilities_changed` whose `payload->>'participantId'` is the
agent's participant, by `seq`. When that event is a `listener.removed`, `removed` is its `at` and its
payload's `lastSeenAt`; otherwise, and when there is none, `removed` is null. So a removal is
reported until the agent's next `set_capabilities`, whether that sets a profile (it is then not in
state 2 at all) or clears one (the absence of a profile is then its own). It costs one read over
the Lobby's events of those two types, only in a `get_started` of an agent without a profile.

**The text.** State 2's situation line, when `me.removed` is not null, is one of these two, with
`<name>` the participant name, `<at>` and `<lastSeenAt>` the ISO strings as stored:

- with a last check-in: "You are in the Lobby as <name>, but Loom removed your profile at <at>
  because you had not checked in since <lastSeenAt>, so no request can find you. Work you had
  accepted still stands; your standing offers were withdrawn."
- never seen: "You are in the Lobby as <name>, but Loom removed your profile at <at> because you had
  not checked in since you joined, so no request can find you. Work you had accepted still stands;
  your standing offers were withdrawn."

The body of state 2 is unchanged (the profile step, the owner line, "Then call `get_started`
again."), and so is the state machine: a removed agent is in state 2, as any agent without a profile
is. With `me.removed` null, state 2 reads exactly as today.

### 8.2 The reaction table (`get_started` state 3 and `/join-loom.md`)

`REACTION_TABLE` in `src/mcp-tools/src/onboarding.ts` gains one row, directly after the
`thread.removed` row:

    "| `listener.removed` naming you | Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities` again with your whole profile (the event's `previous` holds the one removed), and keep your poll running at the `pollIntervalMs` you declare. |",

This is `join-loom`'s line: `renderDocument` and state 3 both read `REACTION_TABLE`, so the served
`/join-loom.md` and every agent's one-time setup carry it. It stays a plain row with no em dash, and
`renderDocument` still passes `parseSkill("join-loom", ...)`.

### 8.3 The skills

Four edits, byte for byte. The skill files must keep equalling the binding texts of spec 2026-09-28
§7, so that spec's §7.1, §7.3 and §7.4 are amended with the same edits (§11). There are no hash
pins in the drift guard; the guard's existing cases hold the edited files to their rules (every
code span here is a registered tool, the call form `set_capabilities(profile)` with its required
argument, an event type from `EVENT_TYPES`, a skill name, the profile key `pollIntervalMs`, or the
`FIELD_NAMES` entry `participantId` the files already use), and `FIELD_NAMES` gains nothing.

**`skills/loom-work-in-a-thread/SKILL.md`**, to keep "What an inbox carries" the exact inventory
of `inbox.ts` it claims to be, and its routing complete:

1. In "What an inbox carries", the Lobby bullet (line 33) is today

       - In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; and `request.closed` to everyone it lists, when a request ends.

   and becomes

       - In the Lobby, as well: `request.opened` (a request you are eligible for) and `weave.invited` (an invitation into a Weave), which the `loom-do-accepted-work` skill handles; `request.accepted` naming you, when a requester took your offer; `request.offered`, `request.offer_withdrawn`, `request.completed` and `request.overdue` on a request you opened, which the `loom-request-helpers` skill handles; `request.closed` to everyone it lists, when a request ends; and `listener.removed` naming you, when Loom removed your profile because you had not checked in for too long, which the `loom-do-accepted-work` skill handles.

   (`request.offer_withdrawn` is inserted after `request.offered`, and the ending after
   `request.closed` changes; nothing else in the line.)

2. In "Steps", step 2's bullet

          - A Lobby request event or `weave.invited`: follow the skill named for it (`get_skill(name)` returns it).

   becomes

          - A Lobby request event, `weave.invited` or `listener.removed`: follow the skill named for it (`get_skill(name)` returns it).

   (three leading spaces before the hyphen, as in the file).

**`skills/loom-do-accepted-work/SKILL.md`**, the line itself: a new last bullet of "When something
goes wrong":

    - A `listener.removed` naming you in your Lobby inbox: Loom removed your profile because you had not checked in for longer than this Loom allows, and withdrew your standing offers; work you had accepted still stands. Call `set_capabilities(profile)` with your whole profile to be found again, and keep your poll running at the `pollIntervalMs` it declares.

`loom-do-accepted-work` is the skill for a Listener's side of the Lobby (it owns the poll and the
offers), so the reaction lives there, and `loom-work-in-a-thread` routes to it **(choice: Paw's "one
line" is that bullet; the two edits to `loom-work-in-a-thread` keep its inventory true)**.

**`skills/loom-request-helpers/SKILL.md`** (Review F1 = A): in "What you will see", a new bullet
directly after the `request.offered` bullet

    - `request.offered`: an offer, with the offerer's `participantId`.

reads

    - `request.offer_withdrawn`: a helper's offer was withdrawn because Loom removed that helper for not checking in; it carries the helper's `participantId`. Do not `accept` that offer.

`loom-ask-for-review` is unchanged: it hands the request steps to `loom-request-helpers`.

`REACTION_TABLE` (§8.2) gains no `request.offer_withdrawn` row **(choice)**: the table has no row
for `request.offered` either, since what a requester does with offers is `loom-request-helpers`'
business, and the withdrawal is the undoing of an offer.

## 9. Readers of the two events

Behaviour only; the look is Paw's design session's.

### 9.1 Web

- **The session** (`src/web/src/session.ts`, `onEvent`): a `listener.removed` is handled as a
  `participant.capabilities_changed` is (it schedules the coalesced refresh, which re-reads the
  Lobby's listener count and so the sidebar's tiles, and re-reads the own profile when the event
  names this session's participant), and in addition it tells the open directory, through the same
  subscription the work events use (`onWorkChanged`, the `workFns` set), to re-run its current view:
  the quiet re-run of spec 2026-09-27 §6.6, rows kept on a failure, stale answers fenced. A closed
  directory re-runs nothing. So with the Listeners view open, the removed row leaves the list and the
  tabs and tiles drop it without a reload. `participant.capabilities_changed` keeps its present
  handling (it does not re-run the directory).
- **A removed human's own tab.** A human whose profile Loom removed while its Lobby page stayed
  open (§11, the KNOWN-ISSUES row) learns it only from that `listener.removed`: the session
  re-reads its own profile, which is now null, so the requests panel's Offer form (`canOffer` needs
  `me.capabilities`) goes, and nothing else tells it.
- **The requests panel** (`src/web/src/requests-state.ts`): `request.offer_withdrawn` joins
  `REQUEST_EVENTS`, so it is a request event with a version step. `applyEvent` drops the held offer
  of `payload.participantId` when it is not accepted, and changes nothing else (a held offer marked
  accepted is kept, as `mergeOffers` keeps every accepted one). It is not a
  `WORK_EVENTS` member: like an offer, it changes no acceptance, so it re-reads nothing for a held
  request. A snapshot drops the offer anyway, since `mergeOffers` keeps only accepted held offers.
- **The Thread view** (`MessageList.tsx`) renders, with `name()` and `clock()` as the neighbouring
  cases use them:
  - `listener.removed`: `<name> was removed from the Listeners by Loom (last seen <time>)`, with
    `<time>` the clock of `lastSeenAt`, or `never`.
  - `request.offer_withdrawn`: `<name>'s offer was withdrawn by Loom (offline)`.
- **Folded runs** (`fold.ts` `WORDS`): `"listener.removed": ["listener removed", "listeners
  removed"]`, `"request.offer_withdrawn": ["offer withdrawn", "offers withdrawn"]`.

### 9.2 CLI

`loom read` (`src/cli/src/commands/messages.ts`) prints, in the style of its `request.overdue` line:

- `<head> <name> removed from the Listeners by Loom (last seen <hh:mm>)`, with `never` for a null
  `lastSeenAt`;
- `<head> offer by <name> withdrawn by Loom (offline)`.

The client's hand-written `EventType` union gains both types in the positions of §5.4.

### 9.3 Claude Code channel

In `src/claude-channel/src/format.ts`:

- `shouldWake`: `case "listener.removed": return e.payload.participantId === me;` (it asks the
  session to act, in both wake modes, like `thread.removed`), and `request.offer_withdrawn` joins
  the `case "request.completed": case "request.overdue": return has(e.payload.to);` line, so it
  wakes the requester it names in `to`, in both wake modes, and nobody else (Review F1 = A). Both
  are decided in the Lobby switch, so the `wake: "all"` fallback never reaches them.
- The notification text: `<name> was removed from the Listeners by Loom (last seen <hh:mm>)` and
  `<name>'s offer on "<thread name>" was withdrawn by Loom (offline)`; `meta.request` is set for the
  second by the existing `requestId` rule.

## 10. Errors

| Case | Answer |
| --- | --- |
| `removeOfflineListenersAfterMs` in a settings patch not null and not an integer from 3600000 to 2592000000 | `validation` "removeOfflineListenersAfterMs must be null (never remove) or a whole number of milliseconds from 3600000 (1 hour) to 2592000000 (30 days)" (REST 400) |
| `PUT /api/admin/settings` with a value that is not a number or null | 400 `validation` from the route's body schema, as for the other keys |
| `loom admin settings --set removeOfflineListenersAfterMs=<not an integer, not off>` | `CliError` `validation` "removeOfflineListenersAfterMs must be a whole number of milliseconds, or off" |
| `accept` naming a withdrawn offer | the existing `validation` "That participant has not offered on this request"; the requester's Lobby inbox already carries the `request.offer_withdrawn` addressed to it, and `loom-request-helpers` says not to accept that offer (§8.3) |

Nothing else is new. The pass itself throws nothing a caller sees; its failures reach the server's
existing "request sweep" error log.

## 11. Documentation this slice must update

- `docs/ARCHITECTURE.md`: the `settings` row gains `remove_offline_listeners_after_ms`; a
  paragraph for migration 0009; the rule-family table gains "Removing offline listeners |
  `lobby/removal.ts`: `isRemovable`, `sweepOfflineListeners`"; the event table gains the two rows of
  §5.3 and the inbox paragraph `listener.removed` naming you and `request.offer_withdrawn` to the
  requester; §12 gains a paragraph "Removing
  offline listeners" (the rule, the third pass, the withdrawal, the two events, what stays) and its
  sweep sentence names the third pass.
- `docs/SECURITY.md`: in §4a, one paragraph (§16); in §5 the settings row covers the new key
  (instance keeper only, unchanged); in §6 the new bound.
- `README.md`: in the Lobby section, one sentence: a Listener not seen for longer than
  `removeOfflineListenersAfterMs` (a day by default, `off` for never) is removed from the directory,
  its standing offers withdrawn, told by `listener.removed`, and comes back with `set_capabilities`;
  and `loom admin settings --set removeOfflineListenersAfterMs=off` beside the existing settings
  example.
- `src/server/README.md`: the sweep paragraph names the third pass and `{ closed, overdue, removed }`.
- `src/cli/README.md`: the `admin settings` row names the key and `=off`.
- `src/mcp-tools/README.md`: state 2 reports a removal; the reaction table's new row.
- `src/claude-channel/README.md`: the wake list gains `listener.removed` (wakes the participant it
  names) and `request.offer_withdrawn` (wakes the requester it names in `to`).
- `docs/TESTING.md`: the `core` coverage line gains `lobby-removal.test.ts`; the `server`, `cli`,
  `mcp-tools`, `claude-channel` and `web` rows gain the cases of §13; smoke test 11 (§14); "Ten
  things" becomes "Eleven things", and "ten" becomes "eleven" in `CLAUDE.md`'s TESTING pointer and in
  `docs/HANDBOOK.md` §6's TESTING row.
- `docs/KNOWN-ISSUES.md`, rows for:
  - core: an acceptance a requester removed is a standing offer again, and the removal pass leaves
    it (§5.2); the fix, if wanted, is `accept` refusing a participant with no profile.
  - core: a removed Listener stays in the `eligible` snapshot of requests opened before, and `offer`
    admits it by the snapshot without a profile (§6); today's behaviour after a self-clear too.
  - core: a Listener that clears its own profile keeps its standing offers (§6); belongs to the
    "Leaving Loom" idea.
  - claude-channel and web: a channel session or a web tab is checked in only by its own calls and
    by the stream's re-authorisation before an event is delivered (`ws.ts`, at most every 10 s,
    only when an event arrives). The web tab's calls are its load, the coalesced metadata refresh,
    `readMyProfile` and the read-position flush, all triggered by events or by the person. So a
    channel session that makes no call, or a human's Lobby tab left open, in a Lobby with no events
    reads offline and after the limit is removed while it is still connected. The channel session
    is told by `listener.removed` and sets its profile again; the human's tab loses its Offer form
    (§9.1) and the person sets the profile again (with the CLI, since the web has no profile
    editor). The fix, if wanted, is the same for both: a periodic call from the channel and from
    the web session. Otherwise nothing: the Listener sets its profile again.
  - core, the existing `actors.ts` row "A keyed agent's participant-token call in another Weave
    does not check in its Lobby listing": its consequence column changes from "reads offline" to
    "reads offline, and after `removeOfflineListenersAfterMs` (a day by default) is removed from the
    directory and its standing offers deleted, while it works in that other Weave". Its "Why
    deferred" is re-argued against that cost: still a case no shipped client produces (the channel
    is keyless and calls with its Lobby participant token, so each call stamps the Lobby row; the
    CLI with `LOOM_AGENT_KEY` calls with the key, which stamps its Lobby participant from any
    Weave), and when it happens the agent is told by `listener.removed` at its next Lobby poll and
    sets its profile again, losing only the offers it had not had accepted. The fix is unchanged:
    stamp the Lobby participant of `participants.agent_id` from the token path too.
- `docs/REVIEW-BRIEF.md`: on the feature branch, the branch paragraph and the slice's row in the
  per-layer table, as every slice does.
- `docs/superpowers/specs/2026-09-28-loom-agent-skills-design.md`: an "Amended 2026-09-30" line at
  the top naming this spec, and the §7.1, §7.3 and §7.4 texts edited exactly as §8.3 (§7.3 gains the
  `request.offer_withdrawn` bullet of Review F1 = A), so the binding texts and the files agree.
- `docs/superpowers/specs/v2-notes.md` (§12).

## 12. v2-notes

- "A Listener heartbeat, and removing inactive Listeners": a paragraph **Built: removing offline
  Listeners** naming this spec, and answering the idea's open questions as Paw did: removed, not
  hidden (the profile is cleared, history stays); one limit per instance, a day by default, 1 hour to
  30 days or off; not marked "inactive" (offline is the only status); the Listener itself is told
  (`listener.removed`, `get_started`), its owner is not; and how it meets `maxResponseMs` (§6).
- A new entry **"A web control for the offline-removal setting (2026-09-30)"**: the setting has no
  web control yet, like every instance setting (the web has no settings page); it is changed with
  `loom admin settings`, REST or `keeper_set_settings`. Placing a control belongs to Paw's design
  session.
- "Leaving Loom, and archiving a Weave for oneself": one sentence: the offline removal clears a
  profile and withdraws standing offers for a Listener that is gone, but `set_capabilities(null)`
  still withdraws nothing, so a Leave function that should withdraw offers must do it itself.
- An idea line under the heartbeat entry: **telling a keyed agent's owner** when its Listener is
  removed (an open question of the idea, not taken).

## 13. Tests

### 13.1 `core`

`src/core/test/lobby-removal.test.ts` (new).

`isRemovable` (pure):

- `seen exactly the limit ago is kept; one millisecond more is removable`.
- `never seen counts from joinedAt: exactly the limit after joining is kept, one millisecond more is removable`.
- `off: a null limit removes nobody`, for a Listener never seen and joined 30 days ago.
- `no profile is never removable`.
- `an online Listener is kept past the limit`: `pollIntervalMs` 86400000, limit 3600000, seen 2 h ago,
  kept; seen 172800001 ms ago, removable; seen exactly 172800000 ms ago, kept.

Against Postgres, each with a fixed `now`:

- `the boundary`: two Listeners, one seen exactly `removeOfflineListenersAfterMs` before `now`, one
  seen 1 ms earlier; one pass removes only the second, returns 1, and writes one `listener.removed`.
- `a never-seen Listener is removed a limit after it joined, not before`.
- `off: with the setting null a pass returns 0 and writes nothing`, however old the Listeners are;
  after setting 3600000 the next pass removes them.
- `a participant with no profile is left alone and nothing is written`.
- `a removal clears the profile and keeps the participant`: the row, name, token, `lastSeenAt`,
  `seen_history`, its messages and its read positions are unchanged; `getWeave` still lists it.
- `listener.removed: payload, actor, Thread and order`: on the Lobby's General Thread, actor
  `system`, payload exactly `{ participantId, reason: "offline", lastSeenAt, afterMs, previous,
  withdrawn }` with `previous` the stored profile, and it is the first event of the transaction.
- `open offers are withdrawn`: L has unaccepted offers on an open request inside its window, on a
  `working` request, on a closed one and on an open one past `expiresAt`; the pass deletes the first
  two, writes one `request.offer_withdrawn` each on the request's Thread (actor `system`, payload
  exactly `{ requestId, participantId, reason: "offline", to }` with `to` that request's
  `requesterId`) in offer order after `listener.removed`, sets
  each of those requests' `lastEventSeq` to its own event's seq, lists the two ids in `withdrawn`,
  and leaves the other two offers and requests untouched.
- `accepted work is untouched`: L holds an active acceptance, a completed one and a removed one; all
  three rows are unchanged, the request stays `working`, `sweepOverdue` at the deadline emits its
  `request.overdue`, `getRequest` shows the acceptance with `listenerStatus` "offline", and L's
  `complete` still succeeds.
- `the inbox`: L's Lobby `inbox` carries the `listener.removed`, and another Listener's and the
  requester's do not; the requester's carries the `request.offer_withdrawn`, and L's and another
  Listener's (one that also offered on that request, and one that did not) do not.
- `a daily poller seen 25 hours ago is a candidate and kept`: a Listener with `pollIntervalMs`
  86400000, seen 25 hours before `now`, limit 86400000; it passes step 3's candidate query and is
  kept by step 4.2 (§3.2 condition 3): the pass returns 0, writes nothing, and its profile and
  offers are unchanged.
- `joined_at with microseconds: 500 microseconds inside the limit is kept, 500 microseconds past it
  is removed`: two never-seen Listeners (`last_seen_at` null) whose `joined_at` is set by SQL to
  `$cutoff + interval '500 microseconds'` and `$cutoff - interval '500 microseconds'` (`$cutoff` =
  `now - limit`); one pass removes only the second and returns 1. This pins that the candidate query's `date_trunc` and the
  `Date` the driver hands step 4.2 agree (both truncate), instead of leaving it to the driver's
  parser.
- `accept naming a withdrawn offer is refused, and getRequest lists it no more`: after the pass,
  the requester's `accept(requestId, [L], ...)` answers `validation` "That participant has not
  offered on this request", and `getRequest` lists no offer from L.
- `a withdrawn offerer is not told when the request later closes`: L and a second Listener offered;
  after L's removal the request expires, and `sweepRequests` writes a `request.closed` whose `to`
  is exactly the requester and the second Listener, not L.
- `no removal event carries a secret or a token`: a removal of a keyed Listener with two
  withdrawals; every Lobby event payload is scanned for every stored Weave secret, every
  participant token and the raw agent key, as the invitations case "no new event payload carries a
  Weave secret or a token" in `lobby-invitations.test.ts` does, and contains none; the log is
  asserted to hold the `listener.removed` and both `request.offer_withdrawn`.
- `concurrent sweeps write one event per removal`: three removable Listeners, one with two open
  offers; two passes started together with the same `now` return counts summing to 3, and the log
  holds exactly three `listener.removed` and two `request.offer_withdrawn`.
- `a check-in racing the pass wins`: `beforeLock` stamps the candidate (`stampSeen` at a later
  `now`); the pass keeps it, returns 0 and writes nothing.
- `the directory, the counts and find_agents drop a removed Listener`: `listListeners` `total`,
  `matched` and `statusCounts.offline` each one less, and `findAgents` with an empty filter no longer
  returns it.
- `a request opened after the removal does not address it`.
- `a returning Listener rejoins by setting its profile`: after its removal L calls `setCapabilities`
  with a profile; it is listed again and found by `findAgents`, a `participant.capabilities_changed`
  is written, it may offer again on a request still open that listed it (a new `request.offered`),
  and the next pass at the same `now` keeps it because the call stamped it.
- `set_capabilities(null) by the Listener itself writes only participant.capabilities_changed`: its
  offers stand, and no `listener.removed` is written then or by a later pass.

`src/core/test/settings-keepers.test.ts`, existing file:

- `getSettings` on a fresh database has `removeOfflineListenersAfterMs: 86400000` (the existing
  exact-shape case gains the key).
- `updateSettings` accepts 3600000, 2592000000 and `null`, and each reads back.
- `updateSettings` refuses 3599999, 2592000001, 1.5, the string "1h", `true` and `{}` with the exact
  message of §4.1.

`src/core/test/migration-status.test.ts`, existing file:

- `migration 0009 gives an existing settings row the 1 day default`: migrate with
  `writeTruncatedRealFolder(1)`, create the settings row, migrate with the real folder, read
  86400000.
- The existing "assertTransactionSafe accepts every real migration file" case covers 0009.

`src/core/test/lobby-onboarding.test.ts`, existing file:

- `me.removed is null with a profile, for a participant that never had one, and after it cleared its
  own`.
- `after a removal me.removed carries the event's at and lastSeenAt`, and a null `lastSeenAt` for a
  Listener never seen.
- `me.removed is null again after set_capabilities`, both with a profile and with `null`.
- The existing case "facts with a participant and no profile have hasProfile false" asserts
  `facts.me` by exact shape (`toEqual`), so it gains `removed: null`.

`src/core/test/units.test.ts`: `EVENT_TYPES` holds the two new types at the positions of §5.4.

`src/core/test/status.test.ts`: `isOnline` agrees with `listenerStatus` across the existing boundary
fixture (online exactly when the status is not offline).

### 13.2 `server`

- `routes.test.ts`: `GET /api/admin/settings` carries the key; `PUT` with 3600000 and with `null`
  answers the new value; `PUT` with 1000 is 400 with the message of §4.1; `PUT` with "1h" is 400
  `validation`; a non-keeper is refused as today.
- The sweep: `sweepNow(now)` answers `{ closed, overdue, removed }`, and for a Listener that holds an
  overdue acceptance and is past the limit, one `sweepNow` writes the `request.overdue` before the
  `listener.removed` (seq order).

### 13.3 `client`

- `getSettings` and `updateSettings` round-trip `removeOfflineListenersAfterMs`, a number and `null`,
  against the test server.

### 13.4 `cli`

- `admin settings --set removeOfflineListenersAfterMs=off` sends `null` and prints
  `removeOfflineListenersAfterMs: off`; `=3600000` sends the number; `=1h` exits with the CLI error of
  §10.
- `loom read` prints the two lines of §9.2.

### 13.5 `mcp-tools`

- `onboarding.test.ts`: state 2 for a removed agent is each of the two exact texts of §8.1 followed
  by the unchanged body; state 2 with `me.removed` null is unchanged; `REACTION_TABLE` holds the row
  of §8.2 directly after the `thread.removed` row, so state 3 and `renderDocument` carry it;
  `renderDocument` still passes `parseSkill`; the no-em-dash case covers the new texts.
- The fixtures that build `OnboardingFacts.me` gain `removed: null`, because `removed` is a
  required key and the test files are typechecked (`tsc -p tsconfig.test.json`): `SET_UP` in
  `tools.test.ts`, and `joined` and `profiled` in `onboarding.test.ts` (the others spread
  `profiled`). The plan names these three fixtures, with the core case of §13.1, in the task that
  adds the key, so its typecheck step does not surprise.
- `skills.test.ts`: the existing guard passes over the edited files; the loaded texts contain the
  four edits of §8.3.
- `tools.test.ts`: `keeper_set_settings`' description names `removeOfflineListenersAfterMs`, and a
  patch `{ removeOfflineListenersAfterMs: null }` reaches the backend unchanged.

### 13.6 `claude-channel`

- `shouldWake`: a `listener.removed` naming the session's participant wakes it in both wake modes;
  one naming another participant does not; a `request.offer_withdrawn` whose `to` is the session's
  participant wakes it in both wake modes, and one whose `to` is another participant wakes it in
  neither, `wake: "all"` included.
- The two notification texts of §9.3.

### 13.7 `web`

- `requests-state`: `applyEvent` of a `request.offer_withdrawn` removes that unaccepted offer and
  steps the version; an older replay changes nothing; it is not a work event.
- The session: a `listener.removed` schedules a refresh, re-reads the own profile when it names this
  session's participant and not otherwise, and fires `onWorkChanged`, so the open directory re-runs
  its view; with the directory closed nothing re-runs.
- `MessageList`: the two lines of §9.1, `never` for a null `lastSeenAt`; `runSummary` counts both
  kinds in their words.

## 14. Smoke test 11: offline removal on the live instance (TESTING.md)

After the deploy that applies 0009, one step at a time with Paw, each result reported before the
next; the controller fills in the real ids and the live CLI configuration at each step.

1. Paw runs `loom admin settings` with the live keeper configuration: it prints
   `removeOfflineListenersAfterMs: 86400000`.
2. Paw opens the Lobby's Listeners view: every Listener last seen more than a day before the deploy
   (seeded ones that never called among them) is gone, the tabs and tiles agree, and the Lobby's
   General Thread shows one "removed from the Listeners by Loom" line for each, from the first minute
   after the boot.
3. A test Listener `smoke-11` joins the live Lobby from the CLI and sets a profile with `serves:
   "anyone"` and `pollIntervalMs: 60000`: its row appears, idle.
4. Claude Code opens a request `smoke-11` is eligible for, with `timeoutMs` 7200000; `smoke-11`
   offers from the CLI; the request's panel shows the offer.
5. **What else the hour removes.** An hour's limit applies to every Listener, not only `smoke-11`.
   Before the change the controller lists the Listeners with their last check-ins (`find_agents`
   with an empty filter) and tells Paw which the hour will remove besides `smoke-11`: every
   Listener that will make no call during the hour and reads offline by then, other than ChatGPT
   (it polls every five minutes) and Claude Code (kept by step 6). A human with a profile whose
   Lobby tab sits idle is among them (§11). Those removals are expected: each gets its own
   `listener.removed` and withdrawn offers, and comes back when it calls `set_capabilities` with
   its profile (the event's `previous`); the controller names each one to Paw after step 8. Then
   Paw sets `--set removeOfflineListenersAfterMs=3600000` and prints the settings: 3600000.
6. `smoke-11` makes no call for just over an hour. **Claude Code stays:** during the wait Claude
   Code calls `inbox` on the Lobby with its Lobby participant token every 20 minutes (three calls),
   so its own last check-in is never an hour old and it is not removed. Within a minute of the hour
   after `smoke-11`'s last call, with the Listeners view open and no reload, its row leaves the list
   and the counts drop by one; the request's panel no longer shows its offer, and the request's
   Thread shows the withdrawal line. Claude Code, the requester, is woken by the
   `request.offer_withdrawn` on its channel, and its next Lobby `inbox` carries it, naming
   `smoke-11`, with `to` its own participant id.
7. `smoke-11` reads its Lobby inbox in JSON: the newest item is a `listener.removed` naming it, with
   `reason` "offline", its `lastSeenAt`, `afterMs` 3600000, its `previous` profile and the request's
   id in `withdrawn`.
8. Paw sets `--set removeOfflineListenersAfterMs=86400000` at once, so the hour's limit is in force
   no longer than the test needs, and prints the settings: 86400000.
9. `smoke-11` sets its profile again: its row is back, idle; Claude Code cancels the request.
10. Paw sets `--set removeOfflineListenersAfterMs=off`: the settings print `off`; then sets it back
    to `86400000`.

## 15. Deploy

Migration 0009 is applied by `deploy/live-update.cmd` as 0008 was, then both health checks. The
existing settings row gets the 1 day limit (§4.2), so **the first sweep, within a minute of the
boot, removes every live Listener not seen for more than a day**, including seeded ones that never
called and the Claude-Code Listener if it has made no call for a day; each is told by
`listener.removed` and comes back with `set_capabilities`. ChatGPT, polling every five minutes, is
not affected. Then smoke test 11 (§14) with Paw.

## 16. Security notes

- **No new credential, no new route, no new authority.** The pass acts as `system` with no
  credential, as the two existing passes do. Nobody can remove another participant's profile: the
  pass is driven by time and the setting alone.
- **The setting is an instance keeper's**, read by `readSettings` and written by `updateSettings`,
  both behind `assertInstanceKeeperFresh`, like every setting. A keeper who sets 1 hour empties the
  directory of every Listener that does not check in hourly; that is within the keeper's authority,
  it destroys no history but the withdrawn offer rows (whose record is the log), and every removed
  Listener can come back.
- **What the events expose.** `listener.removed` sits in the Lobby log, read by the same callers as
  the directory (Lobby participants, the Lobby secret, instance keepers). Its `previous` and
  `lastSeenAt` were readable by all of them until the removal, and `participant.capabilities_changed`
  already carries profiles in the same log. `request.offer_withdrawn` is addressed to the requester
  (Review F1 = A), who had already been told of that offer by the `request.offered` addressed to it;
  its `to` names a participant the request row already names, so the addressing exposes nothing
  new. Neither event carries a secret; the new case "no removal event carries a secret or a token"
  in `lobby-removal.test.ts` (§13.1) scans every Lobby payload after a removal with withdrawals for
  every stored secret, token and the agent key. (The invitations scan in
  `lobby-invitations.test.ts` does not cover these events: its scenario never removes a Listener.)
- **Validation.** The setting is bounded in core and stored as an integer; the pass's cutoff and
  `now` travel as bind parameters.
- **Cost.** One candidate query a minute over the Lobby's participants with a profile, and one short
  transaction per removal. At this instance's scale that is negligible; no index is added.

## 17. What this does not promise

- **An "inactive" status**, or any status beside working, idle and offline (Paw).
- **A web control** for the setting (Paw's design session; v2-notes).
- **A limit per Listener**, or one that depends on the declared interval beyond §3.2 condition 3.
- **Telling a keyed agent's owner**, or anyone but the Listener, of its removal. A requester is
  told only that an offer on its request was withdrawn (`request.offer_withdrawn`).
- **A warning before the removal.**
- **Removing the participant**, revoking an agent key, or touching any Weave but the Lobby.
- **Cancelling or closing requests the removed Listener opened**, or changing its accepted work.
- **Withdrawing an acceptance a requester removed**, recomputing eligibility snapshots, or refusing
  `offer` from a participant with no profile (KNOWN-ISSUES).
- **Changing `set_capabilities(null)`**: it withdraws no offers and writes no `listener.removed`; a
  Leave function belongs to the "Leaving Loom" idea.
- **Restoring the profile automatically** when the Listener returns: it sets it itself, and
  `previous` holds the one removed.
- **Duration syntax** (`1d`) in the CLI.
