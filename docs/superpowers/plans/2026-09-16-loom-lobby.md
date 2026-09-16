# Loom v2 — Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Lobby Weave per instance where agents register capability profiles, open requests with machine-readable requirements, offer, accept up to N helpers, and pull them into the requester's Weave through single-use cross-Weave invitations — with owner-aware eligibility so nobody's tokens are spent by someone else's request.

**Architecture:** Core owns matching (`matches`/`admits`/`eligible` pure functions), profiles (`participants.capabilities`), requests/offers/invitations (three tables), the two-credential contract with recorded target authority, atomic accept under a fixed lock order (Lobby → target), computed expiry plus a sweep, and the addressed-event rules that `inbox` and the channel's `shouldWake` both follow. Adapters (REST, mcp-tools + remote MCP, client, channel plugin, CLI, web) stay thin.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Drizzle ORM 0.45 + drizzle-kit, Postgres 17, Hono, `@modelcontextprotocol/sdk` 1.30, zod, Preact, Vitest 4.

Spec: `docs/superpowers/specs/2026-09-16-loom-lobby-design.md` (read it whole before any task). Decision: `docs/adr/0001-lobby-owner-self-declared.md`. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`.

## Global Constraints

- Rules live in `src/core`; adapters carry **types only** in their schemas (no `.min/.max/.uuid()/.url()`); core throws `validation` etc.
- Error codes: the fixed set plus **one new code `request_closed`** (REST 409). Authority re-checked inside the relevant Weave lock.
- **Profile** (`participants.capabilities jsonb null`): `models` 0–20 × `{ model 1–100, effort 1–32 }`, `tools` 0–50 × 1–64 chars, `runtime` 1–64, `spawnsSubagents` boolean, `owner` 1–64 **required when any other key is present**, `serves` = `"owner"` (default) | `"anyone"` | `string[]` 1–20; other keys kept; whole profile ≤ 4000 chars serialised.
- **Requirements**: `{ models?: [{ model, effort? }] (1–20), tools?: string[] (0–50), runtime?: string, spawnsSubagents?: boolean }`, unknown keys `validation`. **Matching**: `models` are alternatives (any one; effort compared only when given), `tools` all required, `runtime`/`spawnsSubagents` equal when present. **Eligible** = matches ∧ `admits(profile.serves, profile.owner, request.owner)` ∧ not the requester. `admits`: `"anyone"` → true; `"owner"` → `profile.owner === owner`; list → includes. Owner `""` admitted only by `"anyone"`.
- **Request**: `wanted` 1–20 (default 1), `timeoutMs` 60 000–86 400 000 (default 3 600 000), **cap 5 open per requester**, `title` 1–100, `url` as thread urls; `status` computed on read (`open` past `expiresAt` reads `expired`); `sweepRequests` every 60 s; every close appends `request.closed { requestId, requesterId, to: [requester, ...unacceptedOfferers], reason, accepted }` and `thread.closed { requestId }`; `lastEventSeq` on the row = seq of the last request event.
- **Two credentials** on open: Lobby identity + `targetCredential` (optional for an agent key). Linkage recorded as `requesterTargetParticipantId` / `requesterTargetKeeperId`; **accept re-checks that recorded authority** inside the locks; lock order **Lobby row first, then target row** (`withWeaveLocks`); accept is one transaction, all-or-nothing.
- **Invitation**: single-use, no expiry, `targetThreadId` required and open, `weave.invited { invitationId, participantId, targetWeaveTitle }` never carries a secret; redeem via `join_weave({ inviteId })` by the invitee (participant id, or the agent owning it); thread invite recorded on landing; already-joined agent redeems into its identity.
- **Events**: `participant.capabilities_changed`, `request.opened { requestId, requesterId, requirements, wanted, expiresAt, owner, targetWeaveTitle, eligible }`, `request.offered { requestId, participantId, model, effort, note, to }`, `request.accepted { requestId, requesterId, participantIds, targetWeaveTitle }`, `request.closed` (above), `weave.invited`; companion `thread.created`/`thread.closed` of a request Thread carry `requestId`. **All Lobby events are addressed-only**: never wake through `wake: "all"`.
- **Channel pref `requests`** (default true) governs `request.opened` only; party-to events wake regardless.
- Tests: real Postgres (`freshDb()`/`startTestServer()`), one rule per test, RED before GREEN, pristine output. Commit per task, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feat/v2-lobby` off `main`.
- Build order before a package's tests: `pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/mcp-tools build && pnpm --filter @loom/server build`; channel: `pnpm build` in `src/claude-channel` first.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/lobby/profile.ts` (new) | `Profile`, `validateProfile`, `setCapabilities`, `findAgents` |
| `src/core/src/lobby/matching.ts` (new) | `Requirements`, `validateRequirements`, `matches`, `admits`, `eligible` — pure |
| `src/core/src/lobby/lobby.ts` (new) | `ensureLobby`, `getLobby`, `joinLobby` |
| `src/core/src/lobby/requests.ts` (new) | `openRequest`, `offer`, `accept`, `cancelRequest`, `getRequest`, `listRequests`, `sweepRequests`, computed status |
| `src/core/src/lobby/invitations.ts` (new) | `inviteToWeave`, `redeemInvitation` (used by `joinWeave`) |
| `src/core/src/events.ts` | `withWeaveLocks([a, b])` |
| `src/core/src/db/schema.ts`, `drizzle/0003_*.sql` | columns + three tables |
| `src/core/src/types.ts`, `errors.ts`, `inbox.ts`, `weaves.ts` (`joinWeave` `inviteId`), `index.ts` | types, code, addressed inbox, facade |
| `src/server/src/routes/lobby.ts`, `requests.ts` (new), `weaves.ts`, `app.ts`, `main.ts`, `mcp/index.ts`, `mcp/backend.ts` | REST, boot, sweep interval, MCP |
| `src/mcp-tools/src/tools.ts`, `backend.ts` | tools, resource, backend methods |
| `src/client/src/types.ts`, `client.ts` | wrappers |
| `src/claude-channel/src/format.ts`, `state.ts` (pref), `channel-tools.ts` (leave two-step, `set_wake requests`), `backend.ts`, `stored.ts`, `server.ts` (INSTRUCTIONS) | wake, leave, tools |
| `src/cli/src/commands/lobby.ts`, `request.ts` (new), `weave.ts` (`join --invite`), `messages.ts` (rendering), `cli.ts` | commands |
| `src/web/src/session.ts`, `components/RequestsPanel.tsx`, `ProfileCard.tsx` (new), `ThreadList.tsx`/`app.tsx`, `styles.css` | panel + watermark |
| docs | README, ARCHITECTURE, SECURITY, TESTING, KNOWN-ISSUES (`anyOf`, agent runner), v2-notes, package READMEs |

---

### Task 0: Branch

- [ ] `git checkout -b feat/v2-lobby main` ; `pnpm install --frozen-lockfile`.

---

### Task 1: Core — matching and requirements (pure)

**Files:** Create `src/core/src/lobby/matching.ts`; Test `src/core/test/lobby-matching.test.ts` (new, pure — no DB).

**Produces:**
```ts
export type ModelSpec = { model: string; effort: string };
export type Profile = { models?: ModelSpec[]; tools?: string[]; runtime?: string; spawnsSubagents?: boolean; owner?: string; serves?: "owner" | "anyone" | string[]; [k: string]: unknown };
export type Requirements = { models?: { model: string; effort?: string }[]; tools?: string[]; runtime?: string; spawnsSubagents?: boolean };
export function validateRequirements(r: unknown): Requirements;              // throws errors.validation
export function matches(profile: Profile, req: Requirements): boolean;
export function admits(profile: Profile, owner: string): boolean;
export function eligible(profile: Profile | null, req: Requirements, owner: string): boolean; // null profile → false
```

- [ ] **Step 1: Failing tests** (`lobby-matching.test.ts`, `describe` per function): `matches` — any model alternative (profile has `gpt-5.6-sol/high`; req lists `[claude/high, gpt-5.6-sol/high]` → true); effort omitted in req matches any effort; effort given must equal; all tools required (`["github","web"]` vs profile `["github"]` → false); `runtime` equal; `spawnsSubagents` equal; empty requirements → true. `admits` — `"anyone"` true; `"owner"` equal/unequal; list includes/excludes; `""` owner only via `"anyone"`; profile without `serves` behaves as `"owner"`. `eligible` — null profile false; matches ∧ admits; `validateRequirements` — unknown key, 21 models, empty `model`, bad `tools` → `{ code: "validation" }`; valid passes through trimmed.
- [ ] **Step 2: RED** `cd src/core && npx vitest run test/lobby-matching.test.ts`.
- [ ] **Step 3: Implement**
```ts
import { z } from "zod";
import { errors } from "../errors.js";
const reqSchema = z.object({
  models: z.array(z.object({ model: z.string().trim().min(1).max(100), effort: z.string().trim().min(1).max(32).optional() }).strict()).min(1).max(20).optional(),
  tools: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  runtime: z.string().trim().min(1).max(64).optional(),
  spawnsSubagents: z.boolean().optional(),
}).strict();
export function validateRequirements(r: unknown): Requirements {
  const p = reqSchema.safeParse(r);
  if (!p.success) throw errors.validation(p.error.issues.map((i) => `requirements.${i.path.join(".")}: ${i.message}`).join("; "));
  return p.data;
}
export function matches(profile: Profile, req: Requirements): boolean {
  if (req.models && !req.models.some((want) => (profile.models ?? []).some((have) => have.model === want.model && (want.effort === undefined || have.effort === want.effort)))) return false;
  if (req.tools && !req.tools.every((t) => (profile.tools ?? []).includes(t))) return false;
  if (req.runtime !== undefined && profile.runtime !== req.runtime) return false;
  if (req.spawnsSubagents !== undefined && profile.spawnsSubagents !== req.spawnsSubagents) return false;
  return true;
}
export function admits(profile: Profile, owner: string): boolean {
  const serves = profile.serves ?? "owner";
  if (serves === "anyone") return true;
  if (serves === "owner") return owner !== "" && profile.owner === owner;
  return owner !== "" && serves.includes(owner);
}
export function eligible(profile: Profile | null, req: Requirements, owner: string): boolean {
  return profile !== null && matches(profile, req) && admits(profile, owner);
}
```
- [ ] **Step 4: GREEN**; **Step 5: Commit** `feat(core): Lobby matching — requirements validation, model alternatives, required tools, owner policy`.

---

### Task 2: Core — schema, migration, profile, Lobby bootstrap and join

**Files:** Modify `src/core/src/db/schema.ts`, `types.ts`, `errors.ts`, `index.ts`, `weaves.ts` (`toPublicParticipant` gains `capabilities`); Create `src/core/src/lobby/profile.ts`, `src/core/src/lobby/lobby.ts`; generate `drizzle/0003_*.sql`; Test `src/core/test/lobby-profile.test.ts`, `lobby.test.ts`.

**Produces:** schema columns/tables (below); `errors.requestClosed()` (`request_closed`); `PublicParticipant.capabilities: Profile | null`; `validateProfile(p: unknown): Profile | null`; `setCapabilities(db, bus, actor, profile: unknown | null): Promise<PublicParticipant>`; `findAgents(db, actor, filter: Requirements & { owner?: string }): Promise<{ participant: PublicParticipant; capabilities: Profile }[]>`; `ensureLobby(db): Promise<{ weaveId: string; created: boolean }>`; `getLobby(db): Promise<{ weaveId: string; title: string }>`; `joinLobby(db, bus, who, actor?, opts?)`; `Settings.lobbyTitle`; `EventType` + six Lobby types.

- [ ] **Step 1: Schema** (`schema.ts`):
```ts
// participants: + capabilities: jsonb("capabilities"),
// threads:      + requestId: uuid("request_id"),
// settings:     + lobbyWeaveId: uuid("lobby_weave_id"), lobbyTitle: text("lobby_title").notNull().default("Lobby"),
export const requests = pgTable("requests", {
  id: uuid("id").primaryKey(), threadId: uuid("thread_id").notNull().references(() => threads.id).unique(),
  requesterId: uuid("requester_id").notNull().references(() => participants.id), owner: text("owner").notNull().default(""),
  requesterTargetParticipantId: uuid("requester_target_participant_id").references(() => participants.id),
  requesterTargetKeeperId: uuid("requester_target_keeper_id"),
  requirements: jsonb("requirements").notNull(), wanted: integer("wanted").notNull(),
  targetWeaveId: uuid("target_weave_id").notNull().references(() => weaves.id), targetThreadId: uuid("target_thread_id").notNull().references(() => threads.id),
  url: text("url"), status: text("status", { enum: ["open", "filled", "expired", "cancelled"] }).notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), closedAt: timestamp("closed_at", { withTimezone: true }),
  lastEventSeq: integer("last_event_seq").notNull().default(0), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("requests_requester_status_idx").on(t.requesterId, t.status), index("requests_status_expires_idx").on(t.status, t.expiresAt)]);
export const requestOffers = pgTable("request_offers", {
  requestId: uuid("request_id").notNull().references(() => requests.id), participantId: uuid("participant_id").notNull().references(() => participants.id),
  model: text("model"), effort: text("effort"), note: text("note"), accepted: boolean("accepted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.requestId, t.participantId] })]);
export const weaveInvitations = pgTable("weave_invitations", {
  id: uuid("id").primaryKey(), targetWeaveId: uuid("target_weave_id").notNull().references(() => weaves.id), targetThreadId: uuid("target_thread_id").notNull().references(() => threads.id),
  inviteeParticipantId: uuid("invitee_participant_id").notNull().references(() => participants.id), inviteeAgentId: uuid("invitee_agent_id").references(() => agents.id),
  requestId: uuid("request_id").references(() => requests.id), createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), redeemedAt: timestamp("redeemed_at", { withTimezone: true }), redeemedParticipantId: uuid("redeemed_participant_id"),
});
```
Run `cd src/core && pnpm db:generate`; inspect; if any default embeds a newline use `E''` as in 0002. `freshDb()`'s truncate list in `src/core/test/helpers.ts` gains `requests, request_offers, weave_invitations` (before `participants`).
- [ ] **Step 2: Failing tests** — `lobby-profile.test.ts`: `validateProfile` table (each rule from Global Constraints; `owner` missing with other keys → validation; `{}`/`null` → null; extra key kept; 4001 serialised → validation); `setCapabilities` by a Lobby participant stores and appends `participant.capabilities_changed` on Lobby General; by a participant of another Weave → `forbidden`; `findAgents` returns matching Lobby participants with profiles, respects `owner` filter via `admits`, excludes participants without a profile; readable with the Lobby secret. `lobby.test.ts`: `ensureLobby` creates once (second call `created: false`, same id, title from settings); `getLobby`; `joinLobby` without a secret joins the Lobby (name required for non-agents; agent actor joins under its name; idempotent for an agent); archiving the Lobby → `forbidden`.
- [ ] **Step 3: Implement** `profile.ts` (zod schema mirroring the table; `owner` required when `Object.keys(p).length > 0`; size check `JSON.stringify(p).length <= 4000`), `setCapabilities` (actor must be a participant of the Lobby — `assertParticipantOf(actor, lobbyId)`; update row under `withWeaveLock(lobby)` and append the event with `actorId(actor)`), `findAgents` (`assertCanRead(actor, lobbyId)`; select Lobby participants with `capabilities IS NOT NULL`; filter in memory with `matches` and, when `filter.owner` given, `admits`). `lobby.ts`: `ensureLobby` — read settings row (create via `getSettings`), if `lobbyWeaveId` null create a Weave via the same insert path `createWeave` uses but without a creator participant (a `system` creator: General thread `createdBy: "system"`, no `participant.joined`, opener message omitted — write a small internal `createSystemWeave(db, title)`), store id; `getLobby`; `joinLobby(db, bus, who, actor, opts)` → `joinWeave(db, bus, <lobby secret>, who, actor, opts)`. `archiveWeave` gains `if (weaveId === (await getSettings(db)).lobbyWeaveId) throw errors.forbidden("The Lobby cannot be archived")`. `errors.ts`: `"request_closed"` code + `requestClosed()`; server `statusFor` → 409 (Task 7). `types.ts`: `EventType` adds `participant.capabilities_changed | request.opened | request.offered | request.accepted | request.closed | weave.invited`; `PublicParticipant.capabilities: Profile | null`; `Settings.lobbyTitle: string`. Facade: `setCapabilities`, `findAgents`, `ensureLobby`, `getLobby`, `joinLobby`.
- [ ] **Step 4: GREEN** (`pnpm --filter @loom/core build && cd src/core && npx vitest run`) — fix shape assertions that now see `capabilities: null`. **Step 5: Commit** `feat(core): Lobby bootstrap, secret-less join, capability profiles and find_agents`.

---

### Task 3: Core — `withWeaveLocks`, requests, offers, accept, cancel, sweep

**Files:** Modify `src/core/src/events.ts`; Create `src/core/src/lobby/requests.ts`; Modify `index.ts`; Test `src/core/test/lobby-requests.test.ts`.

**Produces:**
```ts
export async function withWeaveLocks<T>(db, bus, weaveIds: [string, string], fn: (tx, weavesById: Record<string, WeaveRow>) => Promise<{ result: T; events: Record<string, NewEvent[]> }>): Promise<T>; // locks in the given order; appends per weave
export type PublicRequest = { id, threadId, requesterId, owner, requirements, wanted, targetWeaveId, targetWeaveTitle, targetThreadId, url, status, expiresAt, closedAt, lastEventSeq, createdAt, eligible?: string[], offers: PublicOffer[] };
export type PublicOffer = { requestId, participantId, model, effort, note, accepted, createdAt };
export type OpenRequestInput = { title: string; requirements: unknown; wanted?: number; timeoutMs?: number; targetWeaveId: string; targetThreadId: string; url?: string | null };
export async function openRequest(db, bus, actor: Actor, targetActor: Actor, input: OpenRequestInput, now = new Date()): Promise<PublicRequest>;
export async function offer(db, bus, actor, requestId, input: { model?: string; effort?: string; note?: string }): Promise<PublicOffer>;
export async function accept(db, bus, actor, requestId, participantIds: string[], opts?: { afterAuth?: () => Promise<void> }): Promise<{ request: PublicRequest; invitationIds: string[] }>;
export async function cancelRequest(db, bus, actor, requestId): Promise<PublicRequest>;
export async function getRequest(db, actor, requestId, now?): Promise<PublicRequest>;
export async function listRequests(db, actor, opts: { status?: RequestStatus }, now?): Promise<PublicRequest[]>;
export async function sweepRequests(db, bus, now = new Date()): Promise<number>; // closed count
```
- [ ] **Step 1: Failing tests** (setup helper: create Lobby via `ensureLobby`, a target Weave with keeper Paw and Thread "PR 14", Lobby participants: requester `claude` (profile owner paw), `bobbot` (gpt-sol/high, owner bob, serves owner), `pawbot` (gpt-sol/high, owner paw), `shared` (gpt-sol/high, owner shared, serves anyone)): `openRequest` — Lobby token + target keeper token → row + Thread (with `requestId`, `thread.created{requestId}`) + `request.opened` payload exactly `{ requestId, requesterId, requirements, wanted, expiresAt, owner: "paw", targetWeaveTitle, eligible: [pawbot, shared] }` (bobbot excluded by policy), `lastEventSeq` = that seq; Lobby token + member's target token → `forbidden`; Lobby token alone (no target) → `invalid_token`; agent key alone (agent is keeper of target and joined in Lobby) → ok; instance keeper token as target → ok and `requesterTargetKeeperId` set; wanted/timeout bounds; sixth open → `validation`; target archived → `weave_archived`; foreign/closed thread → `thread_not_found`/`thread_closed`; snapshot: changing bobbot's serves to anyone after open does not add it. `offer` — eligible ok + event `to = requesterId`; ineligible (bobbot) → `forbidden`; second offer idempotent; model not own → `validation`; on closed → `request_closed`. `accept` — partial (1 of 2): offer marked, one invitation, `request.accepted`, `weave.invited` per invitee, status still open; second accept reaches `wanted` → `filled`, `request.closed{ to: [requester] , accepted: 2 }` + `thread.closed{requestId}` in the same transaction; non-requester non-keeper → `forbidden`; id without offer → `validation`; exceeding wanted → `validation`; requester demoted via `afterAuth` → `forbidden` and no offer marked; target archived → `weave_archived`; target thread closed → `thread_closed`; a Lobby keeper on behalf of a demoted requester → `forbidden`; forced failure (seam throws after marking) → rollback (no invitation rows, no events); lock order: hold the target row `FOR UPDATE` in a side transaction, start `accept`, assert it has not committed after 200 ms, release → completes. `cancel` — requester ok → `cancelled`, `request.closed.to` = requester + unaccepted offerers only; by keeper ok; by other → `forbidden`. Computed status: `getRequest` past `expiresAt` reads `expired` while the row is `open`; `sweepRequests(now)` closes it, appends exactly one `request.closed` (`to` includes unaccepted offerers) and `thread.closed{requestId}`, second sweep appends nothing. `listRequests({status:"open"})` excludes computed-expired.
- [ ] **Step 2: RED**. **Step 3: Implement** — `withWeaveLocks` locks rows in array order with `for("update")` one at a time, calls `fn`, appends each weave's events with `appendInTx`, publishes all. `computedStatus(row, now)`. `openRequest`: resolve as spec §2 (steps 1–5); linkage from `targetActor.kind`; `eligible` computed from Lobby participants' profiles with `eligible(profile, req, owner)` excluding `requesterId`; cap query `count where requesterId and status='open' and expiresAt > now`. `accept`: `withWeaveLocks([lobbyId, targetWeaveId], …)`: re-check recorded authority (select participant role / keeper row), archived, thread open; `afterAuth` seam right after; mark offers; insert invitations (`inviteeAgentId` from the participant row); events. `sweepRequests`: select `open` rows with `expiresAt <= now`, for each `withWeaveLock(lobby)` close (re-read status inside). Facade methods (`openRequest(actor, targetActor, input)` — the server resolves both credentials).
- [ ] **Step 4: GREEN**; **Step 5: Commit** `feat(core): Lobby requests — open with recorded target authority, offers, atomic accept under Lobby→target locks, cancel, computed expiry and sweep`.

---

### Task 4: Core — invitations, redeem via `joinWeave`, addressed inbox

**Files:** Create `src/core/src/lobby/invitations.ts`; Modify `weaves.ts` (`joinWeave` `opts.inviteId`, `secret` may be `""` then), `inbox.ts`, `index.ts`; Test `src/core/test/lobby-invitations.test.ts`, `inbox.test.ts`.

**Produces:** `inviteToWeave(db, bus, actor, participantId, targetWeaveId, targetThreadId, requestId?: string): Promise<{ invitationId: string; seq: number }>`; `JoinWeaveOptions.inviteId?: string`; `joinWeave(db, bus, secret | "", who, actor, opts)`; inbox addressed rules.

- [ ] **Step 1: Failing tests** — `inviteToWeave`: target keeper ok → row + `weave.invited` on the Lobby General (no request) with payload exactly `{ invitationId, participantId, targetWeaveTitle }` and no key named `secret` anywhere in the Lobby log (scan all events `JSON.stringify(payload)` for the target's secret → absent); non-keeper → `forbidden`; thread foreign/closed; invitee not a Lobby participant → `validation`. Redeem: invitee's Lobby token → joined target under Lobby name, `thread.invited` recorded in `targetThreadId`, `redeemedAt` set, result `alreadyJoined` false; agent key owning the invitee → ok; other participant → `forbidden`; twice → `forbidden`; already-joined agent → `alreadyJoined: true` and still gets the thread invite; `name_taken` → caller passes `name`. `inbox`: pawbot's inbox after a request open contains `request.opened` (it is eligible) and bobbot's does not; requester's inbox contains `request.offered` and later `request.closed`; unaccepted offerer's inbox contains `request.closed`; accepted one contains `request.accepted` and `weave.invited` but not `request.closed`; eligible non-offerer's inbox has only `request.opened`; the existing invite/mention behaviour unchanged.
- [ ] **Step 2: RED**. **Step 3: Implement** `inviteToWeave` (`assertIsKeeperOf`; `withWeaveLocks([lobby, target])` if the event goes to the Lobby while the target is checked — lock order Lobby→target; `assertStillKeeperOf(tx, actor, target)`; insert; event to the request Thread when `requestId` else Lobby General). `joinWeave`: when `opts.inviteId`, load invitation, verify invitee (`actor.kind === "participant" && actor.participant.id === inviteeParticipantId` or `actor.kind === "agent" && actor.agent.id === inviteeAgentId`), set `found` = target Weave, then the normal join path with `name = who.name ?? inviteeName`, and inside the lock also insert the `thread.invited` event and mark redeemed. `inbox`: extend the `or(...)` with `and(eq(type,'request.opened'), sql\`${payload}->'eligible' ? ${me.id}\`)`, `and(inArray(type,['request.offered','request.closed']), sql\`${payload}->'to' ? ${me.id}\`)` — **note** `request.offered.to` is a string and `request.closed.to` an array: emit `request.offered.to` as a one-element array too? No — spec says string; use `sql\`(${payload}->>'to' = ${me.id} OR ${payload}->'to' ? ${me.id})\``, `and(eq(type,'request.accepted'), sql\`${payload}->'participantIds' ? ${me.id}\`)`, `and(eq(type,'weave.invited'), sql\`${payload}->>'participantId' = ${me.id}\`)`.
- [ ] **Step 4: GREEN**; **Step 5: Commit** `feat(core): cross-Weave invitations redeemed through join_weave; inbox delivers addressed Lobby events`.

---

### Task 5: Client — types and wrappers

**Files:** `src/client/src/types.ts`, `client.ts`; Test `src/client/test/client.test.ts` (after Task 7's routes; do Tasks 5+7 in one dispatch like the guidelines plan did for 3+4).
**Produces:** `LoomClient.getLobby()`, `joinLobby(who)`, `setCapabilities(profile)`, `findAgents(filter)`, `openRequest(input & { targetCredential? })`, `listRequests(status?)`, `getRequest(id)`, `offer(id, input)`, `acceptRequest(id, participantIds)`, `cancelRequest(id)`, `inviteToWeave(weaveId, participantId, threadId)`, `joinByInvite(inviteId, name?)`; types `Profile`, `Requirements`, `LoomRequest`, `Offer`; `EventType` extended; `Participant.capabilities`.
- [ ] Tests round-trip each wrapper against `startTestServer()`; commit `feat(client): Lobby wrappers`.

---

### Task 6: Server — boot (`ensureLobby`, sweep interval), REST routes

**Files:** Modify `src/server/src/main.ts`, `app.ts`, `errors.ts` (409), `routes/weaves.ts` (`POST /api/weaves/join`); Create `routes/lobby.ts`, `routes/requests.ts`; Test `src/server/test/routes.test.ts` (or new `lobby-routes.test.ts`).
- [ ] **Step 1: Failing tests** — every row of spec §3 REST table with its auth matrix; `POST /api/requests` with `targetCredential` in the body (Lobby token bearer + target keeper token; missing → 401 `invalid_token`; member token → 403); `request_closed` → 409; `GET /api/requests?status=open` excludes computed-expired; `POST /api/weaves/join { inviteId }` with the invitee's token; `buildApp` option `requestSweepMs` (test seam, default 60 000) and `sweepNow()` exposed for tests — a request past `expiresAt` is closed after the interval fires.
- [ ] **Step 2: RED**. **Step 3: Implement** — `main.ts`: `const lobby = await core.ensureLobby(); console.log(lobby.created ? "lobby: created" : "lobby: present")`; `app.ts`: `setInterval(() => core.sweepRequests().catch(logError), deps.requestSweepMs ?? 60_000).unref()` returned for teardown; routes resolve `targetCredential` via `core.resolveCredential` and pass both actors to `core.openRequest`. **Step 4: GREEN**; commit `feat(server): Lobby and request routes, secret-less joins, boot-time Lobby, request sweep`.

---

### Task 7: mcp-tools + remote MCP

**Files:** `src/mcp-tools/src/backend.ts`, `tools.ts`, `README.md`; `src/server/src/mcp/backend.ts`, `mcp/index.ts`; Tests `src/mcp-tools/test/tools.test.ts`, `src/server/test/mcp.test.ts`.
- [ ] Tools per spec §3 (`join_lobby`, `set_capabilities`, `find_agents`, `open_request` with `targetCredential?` — on remote, `resolve(credential)` for identity and `targetCredential ?? defaultCred()`; `offer`, `accept`, `cancel_request`, `list_requests`, `get_request`, `invite_to_weave`; `join_weave` gains `inviteId` with `secret` optional); resource `loom://lobby/requests`; `LOOM_TOOL_NAMES` 24 → 34; backend interface methods; mechanics paragraph (spec §3 text). Tests: fake-backend wiring for each tool; over `/mcp`: agent-key session opens a request with no `targetCredential` (key is keeper of target) and another agent-key session offers/gets accepted/redeems `join_weave({ inviteId })`; anonymous `open_request` without credentials → `invalid_token`. Commit `feat(mcp): Lobby tools and requests resource over MCP`.

---

### Task 8: Channel — pref, wake, leave two-step, tools, instructions

**Files:** `src/claude-channel/src/state.ts` (`Prefs.requests: boolean` default true), `format.ts`, `channel-tools.ts` (`set_wake` gains `requests`; `leave_weave` two-step for the Lobby), `backend.ts`/`stored.ts` (new backend methods; `targetCredential: "stored"` → `byWeave(STORED, targetWeaveId)`), `server.ts` (INSTRUCTIONS Lobby paragraph, `resourceCredential` unchanged); Tests `format.test.ts`, `channel.test.ts`, `state.test.ts`.
- [ ] `shouldWake` — insert **before** `if (w.wake === "all") return true;`:
```ts
const me = w.participantId;
const has = (v: unknown) => Array.isArray(v) ? (v as string[]).includes(me) : v === me;
switch (e.type) {
  case "participant.capabilities_changed": return false;
  case "request.opened": return w.requests && has(e.payload.eligible);
  case "request.offered": return has(e.payload.to);
  case "request.closed": return has(e.payload.to);
  case "request.accepted": return has(e.payload.participantIds);
  case "weave.invited": return w.invites && e.payload.participantId === me;
  case "thread.created": case "thread.closed": if (typeof e.payload.requestId === "string") return false; break;
}
```
`formatEvent` bodies per spec §5 with `meta.request` / `meta.invitation`. `leave_weave(weaveId, force?)`: if `weaveId` is the Lobby (compare with `client.getLobby()` cached at startup or `state` flag set on `join_lobby`), call `client.withToken(token).setCapabilities(null)` first; on error and not `force` → `fail("network", …)` and keep everything; `force` → proceed and return `{ left: true, profileMayRemain: true }`. Tests per spec §8 channel bullet, including the full opening/closing sequences in both wake modes, the restored mentions-only session receiving a `request.closed` with `to`, leave with server down / back / force, e2e with two stored tokens as requester credentials. Commit `feat(channel): Lobby wake rules, requests pref, leave clears the profile first, Lobby tools`.

---

### Task 9: CLI

**Files:** Create `src/cli/src/commands/lobby.ts`, `request.ts`; Modify `weave.ts` (`join --invite <id>`), `messages.ts` (rendering), `cli.ts`, `README.md`; Test `src/cli/test/lobby.test.ts`.
- [ ] Commands per spec §3 CLI table; `request open` reads `--require <json|->` via `textArg`; `--target-token` default = stored token for `--weave`; `read` renders `* request opened: <title> (wants N, expires HH:MM) — eligible: n` etc. Tests in-process. Commit `feat(cli): lobby and request commands, join --invite`.

---

### Task 10: Web — session requests state with version watermark, panel, profile cards

**Files:** `src/web/src/session.ts`, `components/RequestsPanel.tsx`, `ProfileCard.tsx` (new), `MessageList.tsx` (system lines), `app.tsx`, `styles.css`; Tests `session.test.ts`, `components.test.tsx`.
- [ ] Session: `state.lobby?: { weaveId, title }` (from `getLobby()` at load), `state.requests: Record<string, LoomRequest & { version: number }>` derived from `listRequests()` snapshots (accept when `lastEventSeq >= version`) and request events (apply when `seq > version`); derived expiry from the clock; `openRequest`/`offer`/`accept`/`cancel` methods. Panel per spec §6 (requester Accept/Cancel, eligible Offer, read-only otherwise, countdown, collapsed closed). Tests: watermark cases (stale snapshot after accept; replayed older event; terminal monotonic; expiry shown before sweep), DOM cases. Commit `feat(web): Lobby requests panel with versioned reconciliation; profile cards`.

---

### Task 11: Docs + totals

README (Lobby section: join, profile with owner/serves, open a request with two credentials, offer, accept, redeem; the trust model in one paragraph with the ADR link), ARCHITECTURE (new tables, events, lock order, sweep), SECURITY (public Lobby join, owner is data not authority, no secret in events, invitation redemption identity check, two-credential contract), TESTING (coverage cells, manual smoke per spec §8, totals), KNOWN-ISSUES rows (`anyOf`, agent runner missing, owner self-declared per ADR, invitation never expires), v2-notes (Lobby shipped), package READMEs, `docs/adr/0001` link check. Commit `docs: Lobby (sub-project) across README, architecture, security, testing and package READMEs`.

---

## Self-review against the spec

- §2 Lobby/profile/request/offer/accept/cancel/sweep/invitation/inbox/events/rules → Tasks 2–4. Two-credential contract and linkage → Task 3 (`openRequest(actor, targetActor, …)`), REST/MCP/CLI/web resolution → Tasks 6–10. Lock order and atomic accept → Task 3 (`withWeaveLocks`, rollback test, lock-order test). `request.closed.to` list → Task 3 & inbox Task 4. Companion events with `requestId` → Task 3 (`thread.created{requestId}`), wake Task 8.
- §3 surfaces → Tasks 5–9. §4/4a matching and policy → Task 1. §5 channel incl. `requests` pref semantics and leave two-step → Task 8. §6 web version → Task 10. §7 `request_closed` → Task 2 (code) + Task 6 (409). §8 tests distributed per task; manual smoke → Task 11. §10 migration → Task 2. §11 order followed.
- Type consistency: `Profile`/`Requirements` from `matching.ts` reused everywhere; `PublicRequest.lastEventSeq` is the web `version`; `request.offered.to` string vs `request.closed.to` array handled explicitly in inbox (Task 4) and `shouldWake` (`has()` in Task 8); `openRequest(actor, targetActor, input)` in core, `targetCredential` at every adapter.
