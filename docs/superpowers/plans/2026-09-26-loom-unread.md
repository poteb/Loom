# Loom: unread counts and the "New" divider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each participant has a read position per Thread stored on the server; the web shows an unread count per Thread, a "New" divider where the position was when a Thread was opened, keeps the position moving while the Thread is open in a visible tab, and offers "Mark all read".

**Architecture:** Core gains one table (`read_positions`, migration 0006) and one module, `src/core/src/reads.ts` (`markRead`, `markAllRead`, `readPositions`), exported through the facade; none of them appends an event, takes a Weave lock or publishes. The server adds three thin routes and `@loom/client` three methods. The web counts: a pure `src/web/src/unread.ts` holds the unread rule, the divider rule, the throttle and the visibility seam; `session.ts` holds the read state of the identity in hand, fenced the way the own-profile read already is (`isCurrent` in `side-reads.ts`); `ThreadList`, `MessageList` and `WeaveView` render the count, the divider and the button.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` import suffixes), pnpm 10 workspace, Vitest 4 against a real Postgres (`fileParallelism: false`), drizzle-orm 0.45.2 with drizzle-kit 0.31.10, zod 4, Hono, Preact with happy-dom for the DOM tests. **No `package.json` gains a dependency anywhere in this plan.**

Plan review round 1 (PR #38): F4 and F5 fixed in this revision.

**Spec:** `docs/superpowers/specs/2026-09-26-loom-unread-design.md`, approved by Paw on 2026-09-26 after three review rounds (PR #38). Read it whole before any task; it is the binding requirement text. Where this plan decides something the spec leaves open, the decision is listed under "Decisions this plan makes" at the end, with its reason. Conventions: `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`; the dispatch loop is `docs/HANDBOOK.md` §3 step 9; the ledger is `.superpowers/sdd/2026-09-26-loom-unread/progress.md`.

**Base:** branch `feat/unread` off `origin/main` **after the docs PR carrying the spec and this plan (PR #38) merges**, in the worktree `.claude/worktrees/unread`. From `main` this plan consumes, unchanged unless a task says otherwise: `getThread` (`src/core/src/threads.ts`); `assertParticipantOf`, `resolveInWeave` (`src/core/src/actors.ts`); `createCore` and its `forThread` (`src/core/src/index.ts`); `freshDb`, `closeTestDb`, `keeperToken` (`src/core/test/helpers.ts`); `startTestServer`, `api` (`src/server/test/helpers.ts`); `requireActor` (`src/server/src/auth.ts`), `body` (`src/server/src/validate.ts`); `LoomClient.call` (`src/client/src/client.ts`); in `src/web/src/session.ts` `createSession`, `recoverFromCredentialFailure`, `doLoad`, `join`, `onEvent`, `selectThread`, `createThread`, `dispose`; `isCurrent`, `createCounter`, `Stamp`, `Now` (`src/web/src/side-reads.ts`); `isCredentialFailure` (`src/web/src/weaves-store.ts`); in `src/web/test/session.test.ts` `anon`, `s`, `waitFor`, `makeGate`, `joinedWeave`, `storedIdentity`, `fixtureN`; in `src/web/test/components.test.tsx` the `state()` and `session()` fixtures.

**Commit trailer.** Every implementer commit in this plan ends with exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Global Constraints

Every task's requirements implicitly include this section. Values are the spec's.

- **Branch** `feat/unread`, worktree `.claude/worktrees/unread`, one commit per task with the exact subject the task gives and the trailer above. No push and no PR until Task 7 is done and the whole-branch review (HANDBOOK §3 step 10) has run.
- **No em dash** (the character U+2014) anywhere this plan's implementers write: code, comments, test names, strings, Markdown, commit messages (Paw, 2026-09-23). Existing text that already carries one is left alone unless a task rewrites that sentence. A test that must name the character builds it with `String.fromCharCode(0x2014)`.
- **Paw's pronouns are unstated.** Any text that refers to Paw says "Paw".
- **Layering:** every rule about read positions (who may, the bounds, never moving back, `joinedSeq`) lives in `@loom/core` and is tested once there; the REST routes parse types and call core, the client wraps the routes. The one rule the web owns is the unread rule of spec §4.4, in one pure function (`unreadCounts`), because counting happens there.
- **Error codes:** the fixed set only (`validation`, `invalid_token`, `forbidden`, `weave_not_found`, `thread_not_found`, `weave_archived`, `thread_closed`, `name_taken`, `message_too_long`, `request_closed`, `not_found`). **No new code.** The two new `validation` messages are verbatim: `seq must be a non-negative integer` and `seq is past the Weave's newest event`.
- **Values:** `READ_FLUSH_MS = 5000`. The web's texts are verbatim: the divider says `New`, the button says `Mark all read`, the count's `aria-label` is `N unread` (N the number). The class hooks are exactly `unread-count`, `new-divider`, `mark-all-read`; the divider has `role="separator"`.
- **Migration 0006** is generated by `drizzle-kit generate` (`pnpm --filter @loom/core db:generate`), creates `read_positions` with its primary key and its two foreign keys and nothing else, with its journal entry (idx 6, `when` greater than 1790179064865) and `meta/0006_snapshot.json`. It must pass `assertTransactionSafe`; the existing "case 9" in `src/core/test/migration-status.test.ts` runs it over every real migration file. Nothing is backfilled.
- **LF:** every `*.sql` and everything under `src/core/drizzle/` is LF in the working tree (`.gitattributes`); check with `git ls-files --eol` before committing Task 1.
- **Tests:** test-first, RED output captured in the report before GREEN, one rule per test, pristine output, exact expectations never loosened to pass. Real Postgres, no database mocks. The full run is serial: `pnpm --workspace-concurrency=1 -r test`, and it needs Docker. **If the Docker daemon does not answer, stop and report so Paw can start Docker Desktop**; once it answers, bring the project's containers up yourself.
- **Build before test:** `pnpm --filter @loom/core build` before the server, client or web suites read a core change; `pnpm --filter @loom/client build` before the web suite reads a client change; `pnpm -r build` whenever a task touches more than one package.
- **Never write a `\uXXXX` escape into a file**: the editing tools decode it into literal bytes. After staging, `git diff --cached --stat` must show no `Bin` row.
- **Visual design is Paw's separate design session.** The web tasks add behaviour, data and class hooks only; **no CSS**, no `styles.css` edit. Reusing an existing class on a new element (the button's `btn btn-xs`) is allowed; writing a rule is not.
- **The known ripple (Task 3 on).** Every load or join that ends with an identity now also sends `GET /api/weaves/:id/read`, and opening a Thread can send `PUT /api/threads/:id/read`. A web test whose stub `fetch` throws on an unknown path sees that as a silent failed read, which is fine; a test that pins the exact set or count of requests of a session with an identity fails. Repair such a test only by adding a stub route that answers `{ joinedSeq: 0, threads: {} }` (or `{ threadId, seq }` for the `PUT`), never by loosening the assertion, and name each repaired test in the commit body. A red case of any other shape is a finding and stops the task.
- **Nothing reads `C:\Users\paw\.loom`.** Never run a command that prints environment variables.

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/src/db/schema.ts` (modify) | the `readPositions` table (`read_positions`) |
| `src/core/drizzle/0006_<generated>.sql`, `src/core/drizzle/meta/0006_snapshot.json`, `src/core/drizzle/meta/_journal.json` (generated) | migration 0006 |
| `src/core/src/reads.ts` (new) | `weaveForRead`, `markRead`, `markAllRead`, `readPositions`, the three result types |
| `src/core/src/index.ts` (modify) | facade: `forWeave`, `markRead`, `markAllRead`, `readPositions`; the type exports |
| `src/core/test/helpers.ts` (modify) | `read_positions` in `freshDb()`'s truncate |
| `src/core/test/reads.test.ts` (new) | spec §9.1 |
| `src/server/src/routes/threads.ts`, `src/server/src/routes/weaves.ts` (modify) | `PUT /api/threads/:id/read`; `POST` and `GET /api/weaves/:id/read` |
| `src/server/test/routes.test.ts` (modify) | spec §9.2 |
| `src/client/src/types.ts`, `src/client/src/client.ts` (modify) | `MarkReadResult`, `MarkAllReadResult`, `ReadPositions`; `markRead`, `markAllRead`, `readPositions` |
| `src/client/test/client.test.ts` (modify) | spec §9.3 |
| `src/web/src/unread.ts` (new) | `unreadCounts`, `newestSeqIn`, `mergePositions`, `firstNewSeq` (Task 3); `READ_FLUSH_MS`, `createReadThrottle`, `Visibility`, `documentVisibility` (Task 4) |
| `src/web/src/side-reads.ts` (modify) | `Owner`, `isOwnedBy` (the ownership half of `isCurrent`) |
| `src/web/src/session.ts` (modify) | the read state, its loading and fencing, identity changes, opening, the visibility rule, arrivals, the throttle, flushes, `markAllRead` |
| `src/web/src/components/ThreadList.tsx`, `MessageList.tsx`, `WeaveView.tsx` (modify) | the count, the divider, the button |
| `src/web/test/unread.test.ts` (new) | the pure functions and the throttle |
| `src/web/test/session.test.ts`, `src/web/test/side-reads.test.ts`, `src/web/test/components.test.tsx`, `src/web/test/listeners-page.test.tsx` (modify) | spec §9.4; the two `SessionState` fixtures gain `unread: {}`, the `Session` fixture `markAllRead` |
| `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `docs/superpowers/specs/v2-notes.md` (modify) | spec §7; `README.md` is checked and, having no REST listing, left alone (see the decisions at the end) |

**Why eight tasks, and how they differ from the suggested split.** Core (1), then the adapters it needs (2), then the web in four slices a reviewer can judge apart: the read state with its loading, fencing and identity rules **and the mark on opening** (3), because every §6.1 test the spec lists ("joining ... then counts and the divider follow", "no counts, no divider and no markRead before read state has loaded") observes the divider and the mark, so read state without opening could not be tested against the spec's own tests; then the time-and-visibility behaviour (4: the visibility rule, arrivals, the throttle, flushes, a failed mark); then the rendering (5: the count and the divider), which a reviewer can reject while keeping the session logic; then Mark all read and the Lobby page (6); then the documents and the totals (7).

---

### Task 0: Branch and baseline

- [ ] Confirm the docs PR has merged: `git fetch origin && git log origin/main --oneline -5` shows the squash commit of PR #38, and `git show origin/main:docs/superpowers/plans/2026-09-26-loom-unread.md | head -1` prints this plan's title. If either is missing, stop: HANDBOOK §3 step 7 says the feature branch is cut from a `main` that carries the spec and the plan.
- [ ] Confirm the code this plan was written against is still there: `node -e "console.log(require('./src/core/drizzle/meta/_journal.json').entries.at(-1).tag)"` prints `0005_yellow_marvel_boy`, and `grep -c "const countReads = createCounter();" src/web/src/session.ts` prints `1`. If either differs, stop and report: someone has added a migration or reshaped the session since the spec was written.
- [ ] Create the worktree and the branch:

```bash
cd D:/git/Loom
git worktree add .claude/worktrees/unread -b feat/unread origin/main
cd .claude/worktrees/unread
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck
```

- [ ] Run the baseline: `pnpm --workspace-concurrency=1 -r test`. The handoff of 2026-09-26 records **2093 tests in 74 files** on `main` `d0edd56`. Record **what the run actually printed**, per package (tests and files) and overall, in the ledger `.superpowers/sdd/2026-09-26-loom-unread/progress.md`. Task 7 compares against that record and must not estimate. If the figures differ from the handoff's, do not adjust this plan: record the real figures and say so in the ledger. No commit.

---

### Task 1: core: migration 0006 and `reads.ts`

Spec §3, §4, §8. **This task carries spec §9.1: every case.**

**Files:**
- Modify: `src/core/src/db/schema.ts` (append the table at the end of the file)
- Generate: `src/core/drizzle/0006_<drizzle-kit's name>.sql`, `src/core/drizzle/meta/0006_snapshot.json`, `src/core/drizzle/meta/_journal.json`
- Create: `src/core/src/reads.ts`
- Modify: `src/core/src/index.ts` (import, `forWeave`, three facade entries, one export line)
- Modify: `src/core/test/helpers.ts:22` (the truncate)
- Create: `src/core/test/reads.test.ts`

**Interfaces:**
- Consumes: `getThread(db, threadId)` (throws `thread_not_found`, malformed ids included), `assertParticipantOf(actor, weaveId): PublicParticipant`, `resolveInWeave(db, actor, weaveId)`, `isUuid`, `errors`.
- Produces:

```ts
// src/core/src/db/schema.ts
export const readPositions; // table "read_positions": participantId, threadId, seq, updatedAt

// src/core/src/reads.ts
export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };
export function weaveForRead(q: Queryable, weaveId: string): Promise<{ id: string; lastSeq: number; archivedAt: Date | null }>;
export function markRead(db: Db, actor: Actor, threadId: string, seq: number): Promise<MarkReadResult>;
export function markAllRead(db: Db, actor: Actor, weaveId: string): Promise<MarkAllReadResult>;
export function readPositions(db: Db, actor: Actor, weaveId: string): Promise<ReadPositions>;

// facade (src/core/src/index.ts), what Task 2's routes call
markRead(actor: Actor, threadId: string, seq: number): Promise<MarkReadResult>;
markAllRead(actor: Actor, weaveId: string): Promise<MarkAllReadResult>;
readPositions(actor: Actor, weaveId: string): Promise<ReadPositions>;
export { type MarkReadResult, type MarkAllReadResult, type ReadPositions } from "./reads.js";
```

- [ ] **Step 1: Write the failing tests.** Create `src/core/test/reads.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { addAgent } from "../src/agents.js";
import { markRead, markAllRead, readPositions } from "../src/reads.js";
import { createCore } from "../src/index.js";
import { weaves, readPositions as positionsTable } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k1")]); });

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/**
 * Paw creates the Weave (1 thread.created, 2 participant.joined, 3 message), Bot joins (4), Paw
 * opens "PR 1" (5) and Bot posts in it twice (6, 7).
 */
async function setup() {
  const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
  const paw = await resolveCredential(db, r.token);
  const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
  const bot = await resolveCredential(db, b.token);
  const t = await createThread(db, bus, paw, r.weave.id, "PR 1");
  await postMessage(db, bus, bot, t.id, "one");
  await postMessage(db, bus, bot, t.id, "two");
  return { r, paw, bot, t, general: r.generalThread.id };
}
const lastSeq = async (weaveId: string) =>
  (await db.select({ s: weaves.lastSeq }).from(weaves).where(eq(weaves.id, weaveId)))[0]!.s;
const idOf = (a: Awaited<ReturnType<typeof resolveCredential>>) => (a.kind === "participant" ? a.participant.id : "");

describe("read positions (spec 2026-09-26 §4)", () => {
  it("markRead stores a position and readPositions returns it", async () => {
    const { r, paw, t } = await setup();
    expect(await markRead(db, paw, t.id, 6)).toEqual({ threadId: t.id, seq: 6 });
    expect(await readPositions(db, paw, r.weave.id)).toEqual({ joinedSeq: 2, threads: { [t.id]: 6 } });
  });

  it("markRead never moves a position back", async () => {
    const { r, paw, bot, t } = await setup();
    for (const text of ["three", "four", "five"]) await postMessage(db, bus, bot, t.id, text);   // 8, 9, 10
    expect(await markRead(db, paw, t.id, 10)).toEqual({ threadId: t.id, seq: 10 });
    expect(await markRead(db, paw, t.id, 5)).toEqual({ threadId: t.id, seq: 10 });
    expect((await readPositions(db, paw, r.weave.id)).threads).toEqual({ [t.id]: 10 });
  });

  it("markRead refuses a seq past the Weave's newest event", async () => {
    const { r, paw, t } = await setup();
    const newest = await lastSeq(r.weave.id);
    await expect(markRead(db, paw, t.id, newest + 1))
      .rejects.toMatchObject({ code: "validation", message: "seq is past the Weave's newest event" });
    expect(await markRead(db, paw, t.id, newest)).toEqual({ threadId: t.id, seq: newest });
  });

  it("markRead refuses a negative or fractional seq", async () => {
    const { paw, t } = await setup();
    for (const bad of [-1, 1.5]) {
      await expect(markRead(db, paw, t.id, bad))
        .rejects.toMatchObject({ code: "validation", message: "seq must be a non-negative integer" });
    }
  });

  it("markRead on an unknown Thread is thread_not_found", async () => {
    const { paw } = await setup();
    await expect(markRead(db, paw, UNKNOWN, 1)).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(markRead(db, paw, "not-a-uuid", 1)).rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("a participant of another Weave, the instance keeper and a raw agent key are forbidden", async () => {
    const { r, t } = await setup();
    const o = await createWeave(db, bus, { title: "Other", opener: "", creator: { name: "Eve", kind: "human" } });
    const other = await resolveCredential(db, o.token);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    const { key } = await addAgent(db, keeper, "Reader");
    const agent = await resolveCredential(db, key);
    // The agent has a participant in this Weave, so what is refused is the key itself, unmapped.
    await joinWeave(db, bus, r.secret, { kind: "agent" }, agent);
    for (const who of [other, keeper, agent]) {
      await expect(markRead(db, who, t.id, 1)).rejects.toMatchObject({ code: "forbidden" });
      await expect(markAllRead(db, who, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(readPositions(db, who, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("markRead and markAllRead are weave_archived in an archived Weave; readPositions still answers", async () => {
    const { r, paw, t } = await setup();
    await markRead(db, paw, t.id, 6);
    await archiveWeave(db, bus, paw, r.weave.id);
    await expect(markRead(db, paw, t.id, 7)).rejects.toMatchObject({ code: "weave_archived" });
    await expect(markAllRead(db, paw, r.weave.id)).rejects.toMatchObject({ code: "weave_archived" });
    expect(await readPositions(db, paw, r.weave.id)).toEqual({ joinedSeq: 2, threads: { [t.id]: 6 } });
  });

  it("markRead accepts a closed Thread", async () => {
    const { paw, t } = await setup();
    await closeThread(db, bus, paw, t.id);
    expect(await markRead(db, paw, t.id, 7)).toEqual({ threadId: t.id, seq: 7 });
  });

  it("markAllRead sets every Thread of the Weave, open and closed, to last_seq and never lowers one", async () => {
    const { r, paw, t, general } = await setup();
    const closed = await createThread(db, bus, paw, r.weave.id, "Old");                 // 8
    await closeThread(db, bus, paw, closed.id);                                          // 9
    const newest = await lastSeq(r.weave.id);
    // A position ahead of the sample stands for a mark that landed after markAllRead read last_seq.
    await db.insert(positionsTable).values({ participantId: idOf(paw), threadId: t.id, seq: newest + 5 });
    expect(await markAllRead(db, paw, r.weave.id)).toEqual({ seq: newest, threads: 3 });
    expect((await readPositions(db, paw, r.weave.id)).threads)
      .toEqual({ [general]: newest, [t.id]: newest + 5, [closed.id]: newest });
  });

  it("readPositions gives joinedSeq as the seq of the actor's own participant.joined, and only the actor's own positions", async () => {
    const { r, paw, bot, t } = await setup();
    await markRead(db, paw, t.id, 6);
    expect(await readPositions(db, bot, r.weave.id)).toEqual({ joinedSeq: 4, threads: {} });
    expect((await readPositions(db, paw, r.weave.id)).joinedSeq).toBe(2);
  });

  it("markRead writes no event", async () => {
    const { r, paw, t } = await setup();
    const seqBefore = await lastSeq(r.weave.id);
    const countBefore = (await readEvents(db, r.weave.id, {})).length;
    await markRead(db, paw, t.id, 6);
    await markAllRead(db, paw, r.weave.id);
    expect(await lastSeq(r.weave.id)).toBe(seqBefore);
    expect((await readEvents(db, r.weave.id, {})).length).toBe(countBefore);
  });

  it("positions are per participant", async () => {
    const { r, paw, bot, t } = await setup();
    await markRead(db, paw, t.id, 5);
    await markRead(db, bot, t.id, 7);
    expect((await readPositions(db, paw, r.weave.id)).threads).toEqual({ [t.id]: 5 });
    expect((await readPositions(db, bot, r.weave.id)).threads).toEqual({ [t.id]: 7 });
  });

  it("the facade maps an agent key through the Weave, and answers weave_not_found before that", async () => {
    const { r, t } = await setup();
    const core = createCore(db);
    const keeper = await resolveCredential(db, keeperToken("k1"));
    const { key } = await addAgent(db, keeper, "Reader");
    const agent = await resolveCredential(db, key);
    await joinWeave(db, bus, r.secret, { kind: "agent" }, agent);
    expect(await core.markRead(agent, t.id, 5)).toEqual({ threadId: t.id, seq: 5 });
    expect((await core.readPositions(agent, r.weave.id)).threads).toEqual({ [t.id]: 5 });
    await expect(core.readPositions(agent, UNKNOWN)).rejects.toMatchObject({ code: "weave_not_found" });
    await expect(core.markAllRead(agent, "not-a-uuid")).rejects.toMatchObject({ code: "weave_not_found" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src/core && npx vitest run test/reads.test.ts`
Expected: FAIL, the whole file: `Failed to resolve import "../src/reads.js"` (and `readPositions` is not exported by the schema).

- [ ] **Step 3: The table.** Append to `src/core/src/db/schema.ts` (`primaryKey`, `uuid`, `integer`, `timestamp` are already imported):

```ts
/**
 * A participant's read position in one Thread (spec 2026-09-26 §3): the highest seq of the Weave's
 * log it has read there. Written by `reads.ts` only, never lowered, and never an event.
 */
export const readPositions = pgTable("read_positions", {
  participantId: uuid("participant_id").notNull().references(() => participants.id),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  seq: integer("seq").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.participantId, t.threadId] })]);
```

In `src/core/test/helpers.ts`, the truncate line becomes:

```ts
  await db.execute(sql`truncate events, read_positions, requests, request_offers, weave_invitations, participants, threads, weaves, keepers, settings, agents restart identity cascade`);
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @loom/core db:generate`
Expected: drizzle-kit prints one new migration, `drizzle/0006_<name>.sql`. Then prove its content, the journal entry and the line endings, from the worktree root:

```bash
node --input-type=module <<'CHECK'
import fs from "node:fs";
const dir = "src/core/drizzle";
const file = fs.readdirSync(dir).find((n) => n.startsWith("0006_") && n.endsWith(".sql"));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const got = fs.readFileSync(`${dir}/${file}`, "utf8").split("--> statement-breakpoint").map(norm).filter(Boolean);
const want = [
  'CREATE TABLE "read_positions" ( "participant_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "seq" integer NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "read_positions_participant_id_thread_id_pk" PRIMARY KEY("participant_id","thread_id") );',
  'ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;',
];
const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8")).entries.at(-1);
console.log(JSON.stringify(got) === JSON.stringify(want) ? `0006 statements ok: ${file}` : `0006 MISMATCH:\n${got.join("\n")}`);
console.log(journal.idx === 6 && journal.when > 1790179064865 && `${journal.tag}.sql` === file ? "journal ok" : `journal MISMATCH: ${JSON.stringify(journal)}`);
console.log(fs.existsSync(`${dir}/meta/0006_snapshot.json`) ? "snapshot ok" : "snapshot MISSING");
CHECK
git add src/core/drizzle && git ls-files --eol src/core/drizzle/0006_*.sql src/core/drizzle/meta/0006_snapshot.json src/core/drizzle/meta/_journal.json
```

Expected: `0006 statements ok: 0006_<name>.sql`, `journal ok`, `snapshot ok`, and three `git ls-files --eol` rows each starting `i/lf    w/lf`. A `MISMATCH` on the statements means the schema edit is not exactly Step 3 (or drizzle-kit orders the two foreign keys the other way: if the only difference is their order, compare as sorted and say so in the report). To regenerate: delete the `.sql` and `meta/0006_snapshot.json`, restore the journal with `git restore --source=HEAD --staged --worktree -- src/core/drizzle/meta/_journal.json`, fix the schema and generate again. A `w/crlf` row means the working copy was written with CRLF: `rm` that file and `git checkout -- <file>` to renormalise it.

- [ ] **Step 5: The module.** Create `src/core/src/reads.ts`:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Queryable } from "./db/index.js";
import { events, readPositions as positions, threads, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { assertParticipantOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor } from "./types.js";

/*
 * Read positions (spec 2026-09-26 §4): the highest seq of the Weave's log a participant has read in
 * a Thread. A read is not news: nothing here appends an event, takes a Weave lock or publishes on the
 * bus, and the row is independent of the log. Every call is the actor's own; no participant id is
 * ever taken, so nobody reads or writes another participant's positions.
 */

export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
/** The actor's positions in one Weave, by Thread id, and the seq of its own `participant.joined`. */
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };

/** The Weave a read-position call names: `weave_not_found` for a malformed or unknown id, before any authority check. */
export async function weaveForRead(q: Queryable, weaveId: string): Promise<{ id: string; lastSeq: number; archivedAt: Date | null }> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const [w] = await q.select({ id: weaves.id, lastSeq: weaves.lastSeq, archivedAt: weaves.archivedAt })
    .from(weaves).where(eq(weaves.id, weaveId)).limit(1);
  if (!w) throw errors.weaveNotFound();
  return w;
}

/** The one write rule (§4.1 step 6): insert, or raise the stored seq when the new one is greater. Never lower it. */
function upsertPositions(db: Db, rows: { participantId: string; threadId: string; seq: number }[]) {
  return db.insert(positions).values(rows).onConflictDoUpdate({
    target: [positions.participantId, positions.threadId],
    set: { seq: sql`excluded.seq`, updatedAt: sql`now()` },
    setWhere: sql`${positions.seq} < excluded.seq`,
  });
}

/** §4.1. A closed Thread may be marked read. Answers the stored seq, which may be greater than `seq`. */
export async function markRead(db: Db, actor: Actor, threadId: string, seq: number): Promise<MarkReadResult> {
  const t = await getThread(db, threadId);
  const me = assertParticipantOf(actor, t.weaveId);
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) throw errors.validation("seq must be a non-negative integer");
  const w = await weaveForRead(db, t.weaveId);
  if (w.archivedAt) throw errors.weaveArchived();
  if (seq > w.lastSeq) throw errors.validation("seq is past the Weave's newest event");
  const [raised] = await upsertPositions(db, [{ participantId: me.id, threadId, seq }]).returning({ seq: positions.seq });
  if (raised) return { threadId, seq: raised.seq };
  // The stored position was already at least `seq`, so the update was skipped: answer what stands.
  const [kept] = await db.select({ seq: positions.seq }).from(positions)
    .where(and(eq(positions.participantId, me.id), eq(positions.threadId, threadId))).limit(1);
  return { threadId, seq: kept!.seq };
}

/** §4.2. `last_seq` is read once, and every Thread of the Weave, open and closed, is raised to it in one statement. */
export async function markAllRead(db: Db, actor: Actor, weaveId: string): Promise<MarkAllReadResult> {
  const w = await weaveForRead(db, weaveId);
  const me = assertParticipantOf(actor, weaveId);
  if (w.archivedAt) throw errors.weaveArchived();
  const ts = await db.select({ id: threads.id }).from(threads).where(eq(threads.weaveId, weaveId));
  if (ts.length > 0) await upsertPositions(db, ts.map((t) => ({ participantId: me.id, threadId: t.id, seq: w.lastSeq })));
  return { seq: w.lastSeq, threads: ts.length };
}

/** §4.3. Allowed on an archived Weave. A participant belongs to one Weave, so its rows are that Weave's. */
export async function readPositions(db: Db, actor: Actor, weaveId: string): Promise<ReadPositions> {
  await weaveForRead(db, weaveId);
  const me = assertParticipantOf(actor, weaveId);
  const rows = await db.select({ threadId: positions.threadId, seq: positions.seq }).from(positions)
    .where(eq(positions.participantId, me.id));
  const [joined] = await db.select({ seq: events.seq }).from(events)
    .where(and(eq(events.weaveId, weaveId), eq(events.type, "participant.joined"),
      sql`${events.payload}->>'participantId' = ${me.id}`))
    .orderBy(asc(events.seq)).limit(1);
  return { joinedSeq: joined?.seq ?? 0, threads: Object.fromEntries(rows.map((r) => [r.threadId, r.seq])) };
}
```

- [ ] **Step 6: The facade.** In `src/core/src/index.ts`: add `import * as reads from "./reads.js";` after the `removals.js` import. Directly after the `forThread` definition add:

```ts
  /** Weave-addressed read-position calls: `weave_not_found` first, then an agent key is mapped through the Weave, as `forThread` puts `thread_not_found` first. */
  const forWeave = async (actor: Actor, weaveId: string) =>
    actor.kind === "agent" ? resolveInWeave(db, actor, (await reads.weaveForRead(db, weaveId)).id) : actor;
```

After the `removeParticipant:` entry add:

```ts
    // Read positions (spec 2026-09-26 §4): an agent key acts as the participant it owns there.
    markRead: async (actor: Actor, threadId: string, seq: number) => reads.markRead(db, await forThread(actor, threadId), threadId, seq),
    markAllRead: async (actor: Actor, weaveId: string) => reads.markAllRead(db, await forWeave(actor, weaveId), weaveId),
    readPositions: async (actor: Actor, weaveId: string) => reads.readPositions(db, await forWeave(actor, weaveId), weaveId),
```

After the `export { type RemovalResult } from "./removals.js";` line add:

```ts
export { type MarkReadResult, type MarkAllReadResult, type ReadPositions } from "./reads.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src/core && npx vitest run test/reads.test.ts test/migration-status.test.ts`
Expected: PASS, both files; `migration-status.test.ts` "case 9: assertTransactionSafe accepts every real migration file" now covers seven files.

- [ ] **Step 8: Build and typecheck the workspace, then run core**

Run: `pnpm -r build && pnpm -r typecheck && cd src/core && npx vitest run`
Expected: all green, pristine.

- [ ] **Step 9: Commit**

```bash
git add src/core/src/db/schema.ts src/core/drizzle src/core/src/reads.ts src/core/src/index.ts src/core/test/helpers.ts src/core/test/reads.test.ts
git diff --cached --stat
git commit -m "feat(core): read positions: migration 0006, markRead, markAllRead, readPositions" -m "Migration 0006 creates read_positions. A position is the actor's own, never lowered, capped at last_seq, refused in an archived Weave for writes, and writes no event." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the stat shows no `Bin` row.

---

### Task 2: server routes and client methods

Spec §5. **This task carries spec §9.2 and §9.3.**

**Files:**
- Modify: `src/server/src/routes/threads.ts` (a route after `/:id/url`), `src/server/src/routes/weaves.ts` (two routes after `/:id/inbox`)
- Modify: `src/client/src/types.ts` (after `InviteResult`), `src/client/src/client.ts` (after `setWeaveGuidelines`, before the Lobby section; the type import)
- Test: `src/server/test/routes.test.ts` (append a describe), `src/client/test/client.test.ts` (append a describe)

**Interfaces:**
- Consumes: `core.markRead`, `core.markAllRead`, `core.readPositions` (Task 1).
- Produces:

```ts
// @loom/client types
export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };
// LoomClient
markRead(threadId: string, seq: number): Promise<MarkReadResult>;      // PUT /api/threads/:id/read  { seq }
markAllRead(weaveId: string): Promise<MarkAllReadResult>;              // POST /api/weaves/:id/read  (no body)
readPositions(weaveId: string): Promise<ReadPositions>;                // GET /api/weaves/:id/read
```

- [ ] **Step 1: Write the failing server tests.** Append to `src/server/test/routes.test.ts`:

```ts
describe("read positions over REST (spec 2026-09-26 §5)", () => {
  // Paw's Weave: 1 thread.created, 2 participant.joined, 3 message.
  const weave = async () => (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  it("PUT /api/threads/:id/read, POST /api/weaves/:id/read and GET /api/weaves/:id/read round trip with a participant token", async () => {
    const r = await weave();
    const put = await api(s.baseUrl, "PUT", `/api/threads/${r.generalThread.id}/read`, { seq: 1 }, r.token);
    expect([put.status, put.json]).toEqual([200, { threadId: r.generalThread.id, seq: 1 }]);
    const got = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/read`, undefined, r.token);
    expect([got.status, got.json]).toEqual([200, { joinedSeq: 2, threads: { [r.generalThread.id]: 1 } }]);
    const all = await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/read`, undefined, r.token);
    expect([all.status, all.json]).toEqual([200, { seq: 3, threads: 1 }]);
    // `{}` is accepted as the body of the POST, which reads none.
    expect((await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/read`, {}, r.token)).status).toBe(200);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/read`, undefined, r.token)).json.threads)
      .toEqual({ [r.generalThread.id]: 3 });
  });

  it("answers 400 on a bad body, 401 with no credential, and 404 on an unknown Thread and Weave", async () => {
    const r = await weave();
    const t = r.generalThread.id;
    for (const bad of [{ seq: "1" }, {}, { seq: -1 }]) {
      const res = await api(s.baseUrl, "PUT", `/api/threads/${t}/read`, bad, r.token);
      expect([res.status, res.json.code]).toEqual([400, "validation"]);
    }
    for (const [method, path, payload] of [["PUT", `/api/threads/${t}/read`, { seq: 1 }], ["POST", `/api/weaves/${r.weave.id}/read`, undefined], ["GET", `/api/weaves/${r.weave.id}/read`, undefined]] as const) {
      const res = await api(s.baseUrl, method, path, payload);
      expect([res.status, res.json.code]).toEqual([401, "invalid_token"]);
    }
    const noThread = await api(s.baseUrl, "PUT", `/api/threads/${UNKNOWN}/read`, { seq: 1 }, r.token);
    expect([noThread.status, noThread.json.code]).toEqual([404, "thread_not_found"]);
    const noWeavePost = await api(s.baseUrl, "POST", `/api/weaves/${UNKNOWN}/read`, undefined, r.token);
    expect([noWeavePost.status, noWeavePost.json.code]).toEqual([404, "weave_not_found"]);
    const noWeaveGet = await api(s.baseUrl, "GET", `/api/weaves/${UNKNOWN}/read`, undefined, r.token);
    expect([noWeaveGet.status, noWeaveGet.json.code]).toEqual([404, "weave_not_found"]);
  });
});
```

- [ ] **Step 2: Write the failing client test.** Append to `src/client/test/client.test.ts`:

```ts
describe("read positions (spec 2026-09-26 §5)", () => {
  it("markRead, markAllRead and readPositions round trip against the test server", async () => {
    const r = await anon.createWeave(input);            // 1 thread.created, 2 participant.joined, 3 message
    const me = anon.withToken(r.token);
    expect(await me.markRead(r.generalThread.id, 2)).toEqual({ threadId: r.generalThread.id, seq: 2 });
    expect(await me.readPositions(r.weave.id)).toEqual({ joinedSeq: 2, threads: { [r.generalThread.id]: 2 } });
    expect(await me.markAllRead(r.weave.id)).toEqual({ seq: 3, threads: 1 });
    expect((await me.readPositions(r.weave.id)).threads).toEqual({ [r.generalThread.id]: 3 });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @loom/core build && cd src/server && npx vitest run test/routes.test.ts`
Expected: FAIL on the two new cases only (`expected [ 404, ... ] to deeply equal [ 200, ... ]`: no such route yet).
Run: `cd src/client && npx vitest run test/client.test.ts`
Expected: FAIL on the new case only (`me.markRead is not a function`).

- [ ] **Step 4: The routes.** In `src/server/src/routes/threads.ts`, after the `r.put("/:id/url", ...)` block:

```ts
  r.put("/:id/read", async (c) => {
    const actor = await requireActor(c, core);
    // A type only: core owns the integer, the lower bound and the cap at the Weave's newest event.
    const { seq } = await body(c, z.object({ seq: z.number() }));
    return c.json(await core.markRead(actor, c.req.param("id"), seq));
  });
```

In `src/server/src/routes/weaves.ts`, after the `r.get("/:id/inbox", ...)` block:

```ts
  // Read positions: the caller's own. The POST reads no body, so `{}` and nothing are the same call.
  r.post("/:id/read", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.markAllRead(actor, c.req.param("id")));
  });

  r.get("/:id/read", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.readPositions(actor, c.req.param("id")));
  });
```

- [ ] **Step 5: The client.** In `src/client/src/types.ts`, directly after `export type InviteResult = ...`:

```ts
/** Read positions (spec 2026-09-26 §4), mirrored from core by hand like the rest of this file. */
export type MarkReadResult = { threadId: string; seq: number };
export type MarkAllReadResult = { seq: number; threads: number };
export type ReadPositions = { joinedSeq: number; threads: Record<string, number> };
```

In `src/client/src/client.ts`, add `MarkAllReadResult, MarkReadResult,` and `ReadPositions,` to the `./types.js` import (alphabetical, as it is), and directly after `setWeaveGuidelines(...) { ... }`:

```ts
  // --- Read positions. The caller's own, in one Weave; no participant id is ever sent.

  /** Marks a Thread read up to `seq`. A position never moves back, so the answer is the stored seq,
   *  which may be greater than the one sent. */
  markRead(threadId: string, seq: number): Promise<MarkReadResult> {
    return this.call("PUT", `/api/threads/${threadId}/read`, { seq });
  }
  /** Marks every Thread of the Weave read up to the newest event the server saw when it answered. */
  markAllRead(weaveId: string): Promise<MarkAllReadResult> {
    return this.call("POST", `/api/weaves/${weaveId}/read`);
  }
  /** This client's positions in the Weave by Thread id, and the seq of its own join there. */
  readPositions(weaveId: string): Promise<ReadPositions> {
    return this.call("GET", `/api/weaves/${weaveId}/read`);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -r build && cd src/server && npx vitest run test/routes.test.ts && cd ../client && npx vitest run`
Expected: PASS, pristine.

- [ ] **Step 7: Typecheck, then commit**

Run: `pnpm -r typecheck`

```bash
git add src/server/src/routes/threads.ts src/server/src/routes/weaves.ts src/server/test/routes.test.ts src/client/src/types.ts src/client/src/client.ts src/client/test/client.test.ts
git diff --cached --stat
git commit -m "feat(server,client): the three read-position routes and client methods" -m "PUT /api/threads/:id/read, POST and GET /api/weaves/:id/read, and LoomClient.markRead, markAllRead and readPositions. Types only in the routes; every rule is core's." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: web: read state per identity, unread counts, and the mark on opening

Spec §6.1 whole, §6.2 "On opening" (without the visibility rule, which is Task 4's), §4.4. **This task carries spec §9.4: `unreadCounts` (pure); `opening a Thread marks it read up to its newest event and records newAfter`; `a browser with no identity loads no positions and shows no counts`; `joining on a visible secret-only page loads read positions, then counts and the divider follow`; `replacing the identity while a readPositions call is pending drops the stale reply`; `no counts, no divider and no markRead before read state has loaded`.**

**Files:**
- Create: `src/web/src/unread.ts`, `src/web/test/unread.test.ts`
- Modify: `src/web/src/side-reads.ts` (`Owner`, `isOwnedBy`; `isCurrent` uses it), `src/web/test/side-reads.test.ts` (one case)
- Modify: `src/web/src/session.ts` (the edits of Step 5)
- Modify: `src/web/test/components.test.tsx:31-35` (`state()` gains `unread: {}`), `src/web/test/listeners-page.test.tsx` (`lobbyState` in "the Lobby sidebar's listeners line" gains `unread: {}`)
- Test: `src/web/test/session.test.ts` (append helpers and a describe at the end of the file)

**Interfaces:**
- Consumes: `LoomClient.readPositions`, `LoomClient.markRead` (Task 2).
- Produces:

```ts
// src/web/src/unread.ts
export function unreadCounts(events: readonly LoomEvent[], meId: string, positions: Readonly<Record<string, number>>, joinedSeq: number): Record<string, number>;
export function newestSeqIn(events: readonly LoomEvent[], threadId: string): number;
export function mergePositions(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number>;
export function firstNewSeq(events: readonly LoomEvent[], threadId: string, after: number, meId: string): number | null;

// src/web/src/side-reads.ts
export type Owner = { id: string; token: string; generation: number };
export function isOwnedBy(owner: Owner, now: Omit<Now, "applied">): boolean;

// src/web/src/session.ts: SessionState gains
unread: Record<string, number>;
newAfter?: { threadId: string; seq: number; firstNew: number | null };
// session internals later tasks edit: readState, readReads, nowForRead, ownsRead, localPosition, unreadOf,
// dropReadState, forgetReadState, sendMark, markNow, markOpenRead, openRead, loadReadState

// src/web/test/session.test.ts helpers later tasks use
type Call = { method: string; path: string; token?: string; body?: unknown };
function recordingClient(opts?: { park?: Park; failOnce?: (method: string, path: string) => boolean }): { client: LoomClient; calls: Call[] };
async function readFixture(): Promise<{ r; j; claude; pr: Thread; general: string }>;
async function serverPositions(token: string, weaveId: string): Promise<ReadPositions>;
```

- [ ] **Step 1: Write the failing pure tests.** Create `src/web/test/unread.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { LoomEvent } from "@loom/client";
import { firstNewSeq, mergePositions, newestSeqIn, unreadCounts } from "../src/unread.js";

const ev = (seq: number, threadId: string, type: LoomEvent["type"], actor: string): LoomEvent =>
  ({ weaveId: "w1", seq, threadId, type, actor, at: "2026-09-26T10:00:00.000Z", payload: type === "message" ? { text: `m${seq}` } : {} });

// Thread A has a stored position of 4; Thread B has none, so it reads from joinedSeq 2.
const events = [
  ev(1, "B", "message", "bob"),            // at or before joinedSeq: read
  ev(3, "A", "message", "bob"),            // at or before A's position: read
  ev(5, "A", "message", "bob"),            // unread
  ev(6, "A", "message", "me"),             // my own: never counts
  ev(7, "A", "thread.invited", "bob"),     // a system event: never counts
  ev(8, "B", "message", "bob"),            // unread
  ev(9, "B", "participant.joined", "bob"), // a system event
  ev(10, "B", "message", "keeper:k1"),     // a keeper is someone else too: unread
  ev(11, "C", "thread.created", "bob"),    // no message at all
];

describe("unreadCounts (spec 2026-09-26 §4.4)", () => {
  it("counts only others' message events after the position; uses joinedSeq when a Thread has no position; own messages and system events never count", () => {
    expect(unreadCounts(events, "me", { A: 4 }, 2)).toEqual({ A: 1, B: 2 });
    expect(unreadCounts(events, "me", { A: 11, B: 11, C: 11 }, 2)).toEqual({});
  });
});

describe("the other pure read helpers", () => {
  it("firstNewSeq is the first message by someone else after the position, or null", () => {
    expect(firstNewSeq(events, "A", 4, "me")).toBe(5);
    expect(firstNewSeq(events, "A", 5, "me")).toBeNull();
    expect(firstNewSeq(events, "B", 2, "me")).toBe(8);
  });
  it("newestSeqIn is a Thread's highest loaded seq, or 0", () => {
    expect([newestSeqIn(events, "A"), newestSeqIn(events, "Z")]).toEqual([7, 0]);
  });
  it("mergePositions keeps the greater position, Thread by Thread", () => {
    expect(mergePositions({ A: 4, B: 9 }, { A: 6, B: 3, C: 1 })).toEqual({ A: 6, B: 9, C: 1 });
  });
});
```

Append to `src/web/test/side-reads.test.ts` (add `isOwnedBy` to its `../src/side-reads.js` import):

```ts
describe("isOwnedBy (spec 2026-09-26 §6.1)", () => {
  it("asks the generation, the participant and the token, and nothing about order", () => {
    const owner = { id: "p1", token: "t1", generation: 3 };
    expect(isOwnedBy(owner, { generation: 3, meId: "p1", meToken: "t1" })).toBe(true);
    expect([
      isOwnedBy(owner, { generation: 4, meId: "p1", meToken: "t1" }),
      isOwnedBy(owner, { generation: 3, meId: "p2", meToken: "t1" }),
      isOwnedBy(owner, { generation: 3, meId: "p1", meToken: "t2" }),
      isOwnedBy(owner, { generation: 3, meId: undefined, meToken: undefined }),
    ]).toEqual([false, false, false, false]);
  });
});
```

- [ ] **Step 2: Write the failing session tests.** Append to the end of `src/web/test/session.test.ts` (add `type ReadPositions` to the `@loom/client` import):

```ts
// --- Read positions (spec 2026-09-26 §6) -------------------------------------------------------

type Call = { method: string; path: string; token?: string; body?: unknown };
type Park = {
  match: (method: string, path: string) => boolean; gate: ReturnType<typeof makeGate>;
  /** Hold the answer rather than the request: the server acts first, the session hears later. */
  answerFirst?: boolean;
  /** Told once the parked call's answer has been read, just before the session is handed it. */
  onDone?: () => void;
};

/**
 * A client that records every call (method, path, the bearer it carried, the JSON body), can park
 * the first call `park.match` picks, and can fail the first call `failOnce` picks as a network error.
 */
function recordingClient(opts: { park?: Park; failOnce?: (method: string, path: string) => boolean } = {}) {
  const calls: Call[] = [];
  let parked = false;
  let failed = false;
  const client = new LoomClient({
    baseUrl: s.baseUrl, allowInsecure: true,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ method, path, token: auth?.replace(/^Bearer /, ""),
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
      if (opts.failOnce && !failed && opts.failOnce(method, path)) {
        failed = true;
        throw new Error("simulated network failure");
      }
      const p = opts.park;
      if (!p || parked || !p.match(method, path)) return fetch(url, init);
      parked = true;
      if (!p.answerFirst) { p.gate.markEntered(); await p.gate.released; }
      const res = await fetch(url, init);
      const text = await res.text();
      if (p.answerFirst) { p.gate.markEntered(); await p.gate.released; }
      p.onDone?.();
      return new Response(res.status === 204 ? null : text, { status: res.status, headers: res.headers });
    },
  });
  return { client, calls };
}

const isRead = (method: string) => (c: Call) => c.method === method && /\/read$/.test(c.path);
/** The bodies of every `PUT /api/threads/<id>/read` so far, in order. */
const putsTo = (calls: Call[], threadId: string) =>
  calls.filter((c) => c.method === "PUT" && c.path === `/api/threads/${threadId}/read`).map((c) => c.body);
/** Lets a handler that is already queued run: long enough for a parsed answer to reach the session. */
const turn = () => new Promise((r) => setTimeout(r, 50));

/**
 * Claude creates the Weave (1 to 3), Paw joins (4), Claude opens "PR 1" (5) and posts in it (6) and
 * in General (7). Paw lands on General with one unread message in "PR 1".
 */
async function readFixture() {
  const { r, j } = await joinedWeave("Paw");
  const claude = await s.core.resolveCredential(r.token);
  const pr = await s.core.createThread(claude, r.weave.id, "PR 1");
  await s.core.postMessage(claude, pr.id, "one");
  await s.core.postMessage(claude, r.generalThread.id, "two");
  return { r, j, claude, pr, general: r.generalThread.id };
}
async function serverPositions(token: string, weaveId: string): Promise<ReadPositions> {
  return s.core.readPositions(await s.core.resolveCredential(token), weaveId);
}

describe("read state (spec 2026-09-26 §6.1)", () => {
  it("a browser with no identity loads no positions and shows no counts", async () => {
    const f = await readFixture();
    const rec = recordingClient();
    const session = createSession({ client: rec.client, target: { kind: "secret", secret: f.r.secret }, storage: memoryStorage() });
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      await s.core.postMessage(f.claude, f.pr.id, "three");
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "three"));
      session.selectThread(f.pr.id);
      expect([session.getState().unread, session.getState().newAfter]).toEqual([{}, undefined]);
      expect(rec.calls.filter((c) => /\/read$/.test(c.path))).toEqual([]);
    } finally { session.dispose(); }
  });

  it("no counts, no divider and no markRead before read state has loaded", async () => {
    const f = await readFixture();
    const gate = makeGate();
    const rec = recordingClient({ park: { match: (m, p) => m === "GET" && /\/read$/.test(p), gate } });
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.j) });
    try {
      await session.load();
      await gate.entered;
      // Opening Threads while the read state is in flight captures nothing and marks nothing.
      session.selectThread(f.pr.id);
      session.selectThread(f.general);
      expect([session.getState().unread, session.getState().newAfter]).toEqual([{}, undefined]);
      expect(rec.calls.filter(isRead("PUT"))).toEqual([]);
      gate.release();
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      // Then the Thread open at that moment is opened for real: the divider, then the mark.
      expect(session.getState().newAfter).toEqual({ threadId: f.general, seq: 4, firstNew: 7 });
      await waitFor(() => putsTo(rec.calls, f.general).length === 1);
      expect(putsTo(rec.calls, f.general)).toEqual([{ seq: 7 }]);
    } finally { session.dispose(); }
  });

  it("opening a Thread marks it read up to its newest event and records newAfter", async () => {
    const f = await readFixture();
    const rec = recordingClient();
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.j) });
    try {
      await session.load();
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      session.selectThread(f.pr.id);
      expect(session.getState().newAfter).toEqual({ threadId: f.pr.id, seq: 4, firstNew: 6 });
      expect(session.getState().unread[f.pr.id]).toBeUndefined();
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }]);
      await vi.waitFor(async () => expect((await serverPositions(f.j.token, f.r.weave.id)).threads[f.pr.id]).toBe(6));
    } finally { session.dispose(); }
  });

  it("joining on a visible secret-only page loads read positions, then counts and the divider follow", async () => {
    const f = await readFixture();
    const rec = recordingClient();
    const session = createSession({ client: rec.client, target: { kind: "secret", secret: f.r.secret }, storage: memoryStorage() });
    try {
      await session.load();
      await waitFor(() => session.getState().connection === "open");
      await session.join("Dana");                                           // participant.joined at 8
      const dana = session.getState().me!;
      await waitFor(() => rec.calls.some((c) => isRead("GET")(c) && c.token === dana.token));
      await s.core.postMessage(f.claude, f.pr.id, "after the join");        // 9
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      session.selectThread(f.pr.id);
      expect(session.getState().newAfter).toEqual({ threadId: f.pr.id, seq: 8, firstNew: 9 });
      expect(session.getState().unread[f.pr.id]).toBeUndefined();
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 9 }]);
    } finally { session.dispose(); }
  });

  it("replacing the identity while a readPositions call is pending drops the stale reply", async () => {
    const f = await readFixture();
    await s.core.markRead(await s.core.resolveCredential(f.j.token), f.pr.id, 6);   // Paw has read PR 1
    const gate = makeGate();
    let staleDone = false;
    const rec = recordingClient({ park: { match: (m, p) => m === "GET" && /\/read$/.test(p), gate, onDone: () => { staleDone = true; } } });
    const storage = storedIdentity(f.r.weave.id, f.j, { secret: f.r.secret });
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id }, storage });
    try {
      await session.load();
      await gate.entered;                                    // Paw's read state is in flight
      await session.join("Dana");                            // another participant: joined at 8
      const dana = session.getState().me!;
      await s.core.postMessage(f.claude, f.pr.id, "for Dana");   // 9
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      gate.release();
      await waitFor(() => staleDone);
      await turn();
      // Paw's answer changed nothing: Dana's counts, Dana's divider, and every mark in Dana's name.
      expect(session.getState().unread).toEqual({ [f.pr.id]: 1 });
      expect(session.getState().newAfter).toEqual({ threadId: f.general, seq: 8, firstNew: null });
      expect(rec.calls.filter(isRead("PUT")).every((c) => c.token === dana.token)).toBe(true);
    } finally { session.dispose(); }
  });
});
```

In `src/web/test/components.test.tsx`, the `state()` fixture's last line becomes:

```ts
    instanceGuidelines: "", requests: {}, requestsLoaded: true, closedRequestsPage: CLOSED_REQUESTS_PAGE, unread: {}, ...over };
```

In `src/web/test/listeners-page.test.tsx`, in `lobbyState` of "the Lobby sidebar's listeners line (spec §5.1)", the line `invitesForMe: new Set(), invited: {}, requests: {}, requestsLoaded: true, closedRequestsPage: 25,` becomes:

```ts
    invitesForMe: new Set(), invited: {}, requests: {}, requestsLoaded: true, closedRequestsPage: 25, unread: {},
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -r build && cd src/web && npx vitest run test/unread.test.ts test/side-reads.test.ts test/session.test.ts`
Expected: FAIL. `unread.test.ts` cannot resolve `../src/unread.js`; `side-reads.test.ts` fails the new case (`isOwnedBy is not a function`); the five new session cases fail (`expected undefined to deeply equal { threadId: ... }` and timeouts on `unread[...] === 1`); every existing case still passes.

- [ ] **Step 4: The pure module and the ownership check.** Create `src/web/src/unread.ts`:

```ts
import type { LoomEvent } from "@loom/client";

/**
 * Unread, as spec 2026-09-26 §4.4 states it and nowhere else: for Thread T, with
 * `position = positions[T] ?? joinedSeq`, the `message` events of T by anyone but `meId` with a seq
 * past the position. Own posts and system events never count; a Thread at zero is left out.
 */
export function unreadCounts(events: readonly LoomEvent[], meId: string,
  positions: Readonly<Record<string, number>>, joinedSeq: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "message" || e.actor === meId) continue;
    if (e.seq <= (positions[e.threadId] ?? joinedSeq)) continue;
    out[e.threadId] = (out[e.threadId] ?? 0) + 1;
  }
  return out;
}

/** The highest seq among one Thread's loaded events, or 0 when it has none. */
export function newestSeqIn(events: readonly LoomEvent[], threadId: string): number {
  let top = 0;
  for (const e of events) if (e.threadId === threadId && e.seq > top) top = e.seq;
  return top;
}

/** Merges two position maps Thread by Thread, keeping the greater: a position never moves back. */
export function mergePositions(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out = { ...a };
  for (const [id, seq] of Object.entries(b)) if (seq > (out[id] ?? -1)) out[id] = seq;
  return out;
}

/**
 * Where the "New" divider goes (§6.4): the seq of the first `message` in the Thread by someone other
 * than `meId` with a seq past `after`, or null when there is none.
 */
export function firstNewSeq(events: readonly LoomEvent[], threadId: string, after: number, meId: string): number | null {
  for (const e of events) {
    if (e.threadId === threadId && e.type === "message" && e.actor !== meId && e.seq > after) return e.seq;
  }
  return null;
}
```

In `src/web/src/side-reads.ts`, directly after the `Now` type add:

```ts
/** What a call captured when it was **issued**: whose it is. A `Stamp` is this plus a request number. */
export type Owner = { id: string; token: string; generation: number };

/**
 * The ownership half of `isCurrent`, for a call that carries no request number: a write, whose
 * answer is not ordered against other answers (spec 2026-09-26 §6.1).
 */
export function isOwnedBy(owner: Owner, now: Omit<Now, "applied">): boolean {
  return owner.generation === now.generation && owner.id === now.meId && owner.token === now.meToken;
}
```

and the body of `isCurrent` (keeping its comment) becomes:

```ts
  return isOwnedBy(stamp, now) && stamp.n > now.applied;
```

- [ ] **Step 5: The session.** Edits to `src/web/src/session.ts`, in file order.

(a) The side-reads import line becomes, and a new import follows it:

```ts
import { cachedProfile, createCounter, isCurrent, isOwnedBy, type Now, type Owner, type OwnProfile, type Stamp } from "./side-reads.js";
import { firstNewSeq, mergePositions, newestSeqIn, unreadCounts } from "./unread.js";
```

(b) In `SessionState`, after `listenerCountError?: boolean;`:

```ts
  /** Unread `message` counts by Thread for this browser's identity (spec 2026-09-26 §6.1). Empty
   *  until that identity's read state has loaded, and always empty without an identity. */
  unread: Record<string, number>;
  /**
   * The open Thread's divider (§6.4): where its read position stood when it was opened (`seq`), and
   * the first message by someone else after it (`firstNew`, null for none), both fixed at that
   * moment. Absent until read state has loaded; captured again only when a Thread is opened.
   */
  newAfter?: { threadId: string; seq: number; firstNew: number | null };
```

(c) The initial state's second line becomes:

```ts
    invitesForMe: new Set(), invited: {}, instanceGuidelines: "", requests: {}, requestsLoaded: false, closedRequestsPage: closedPage, unread: {} };
```

(d) In `recoverFromCredentialFailure`, the invalidation itself resets the read state to none (§6.1). After the first `onWrite(wrote);` (the sibling branch, just before the comment "The cache goes with the identity it belonged to") insert `forgetReadState();`, and after the second `onWrite(wrote);` (just before `retriedWithSecret = true;`) insert `forgetReadState();`.

(e) Directly after `const countReads = createCounter();`:

```ts
  /**
   * The read state of the identity in hand (spec 2026-09-26 §6.1): the positions its `readPositions`
   * answered, raised by every mark this tab has made since, and its `joinedSeq`. `undefined` until
   * that answer lands, and again whenever an identity is established, changes or is invalidated, so
   * no position is ever shown, counted or sent under a participant it did not belong to.
   */
  let readState: { id: string; token: string; positions: Record<string, number>; joinedSeq: number } | undefined;
  const readReads = createCounter();
```

(f) Directly after `const readLobbySides = (myGeneration: number) => { ... };`:

```ts
  // --- Read positions (spec 2026-09-26 §6). The counts are this browser's, from the events it holds;
  // the server stores positions and nothing else.

  /** What the session is at the moment a read-position answer, or rejection, asks to be acted on. */
  const nowForRead = (): Now =>
    ({ generation, meId: state.me?.participant.id, meToken: state.me?.token, applied: readReads.applied() });
  /** Whether a call issued under `owner` still belongs to this session (§6.1 fencing). */
  const ownsRead = (owner: Owner) => !disposed && isOwnedBy(owner, nowForRead());
  /** A Thread's local position: the loaded one, raised by this tab's marks, else `joinedSeq`. Callers hold `readState`. */
  const localPosition = (threadId: string) => readState!.positions[threadId] ?? readState!.joinedSeq;
  /** `state.unread` for these events: empty until the identity in hand has its read state. */
  const unreadOf = (events: LoomEvent[]): Record<string, number> =>
    readState && readState.id === state.me?.participant.id
      ? unreadCounts(events, readState.id, readState.positions, readState.joinedSeq) : {};
  /** Drops the read state of an identity that is being replaced; the caller clears what it showed. */
  const dropReadState = () => { readState = undefined; };
  /** Drops it together with what it showed. */
  const forgetReadState = () => { dropReadState(); set({ unread: {}, newAfter: undefined }); };

  /**
   * Sends one position under the identity current at this moment, stamped with it (§6.1). The answer
   * raises the local position to what the server holds. Either outcome is dropped before any side
   * effect once the session is another identity or generation. A refused credential takes the
   * invalid-identity flow; any other failure is silent and the local position stands (§6.2).
   */
  const sendMark = (threadId: string, seq: number) => {
    const me = state.me;
    if (!me || !readState || readState.id !== me.participant.id) return;
    const owner: Owner = { id: me.participant.id, token: me.token, generation };
    void client.withToken(me.token).markRead(threadId, seq).then(
      (r) => {
        if (!ownsRead(owner) || !readState) return;
        readState = { ...readState, positions: mergePositions(readState.positions, { [r.threadId]: r.seq }) };
        set({ unread: unreadOf(state.events) });
      },
      (e: unknown) => {
        if (!ownsRead(owner)) return;
        // Silent: the local position stands.
        if (!isCredentialFailure(e)) return;
        const recovered = recoverFromCredentialFailure(e, "identity");
        if (recovered?.reload) void doLoad();
      },
    );
  };
  /** The mark of an opening: sent at once. */
  const markNow = (threadId: string, seq: number) => { sendMark(threadId, seq); };
  /** Marks the open Thread read up to its newest loaded event, when that is past its local position. */
  const markOpenRead = () => {
    const id = state.currentThreadId;
    if (!readState || !id) return;
    const top = newestSeqIn(state.events, id);
    if (top <= localPosition(id)) return;
    readState = { ...readState, positions: { ...readState.positions, [id]: top } };
    set({ unread: unreadOf(state.events) });
    markNow(id, top);
  };
  /** Opening Thread `id` (§6.2): the divider where its read position stood, then the mark. Both wait for read state. */
  const openRead = (id: string) => {
    if (!readState) return;
    const after = localPosition(id);
    set({ newAfter: { threadId: id, seq: after, firstNew: firstNewSeq(state.events, id, after, readState.id) } });
    markOpenRead();
  };

  /**
   * Fetches the read state of the identity in hand (§6.1), with its own token, stamped with that
   * identity, the generation and a request number. The answer merges into what this tab has marked
   * since and recomputes the counts; then the open Thread is opened for real if its divider is not
   * down yet, and otherwise only marked, so a refresh never moves a divider. A failure leaves the
   * state as it was and says nothing (the next visibility or identity change asks again); a refused
   * credential takes the invalid-identity flow. Both outcomes are fenced before any side effect.
   */
  const loadReadState = () => {
    const me = state.me;
    if (!me || !weaveId) return;
    const stamp: Stamp = { id: me.participant.id, token: me.token, generation, n: readReads.next() };
    void client.withToken(me.token).readPositions(weaveId).then(
      (r) => {
        if (disposed || !isCurrent(stamp, nowForRead())) return;
        readReads.markApplied(stamp.n);
        readState = { id: stamp.id, token: stamp.token, joinedSeq: r.joinedSeq,
          positions: readState ? mergePositions(readState.positions, r.threads) : { ...r.threads } };
        set({ unread: unreadOf(state.events) });
        const open = state.currentThreadId;
        if (open && state.newAfter?.threadId !== open) openRead(open); else markOpenRead();
      },
      (e: unknown) => {
        if (disposed || !isCurrent(stamp, nowForRead())) return;
        readReads.markApplied(stamp.n);
        if (!isCredentialFailure(e)) return;
        const recovered = recoverFromCredentialFailure(e, "identity");
        if (recovered?.reload) void doLoad();
      },
    );
  };
```

(g) In `onEvent`, the line `set({ events, ...deriveInvites(events, state.me?.participant.id, seenUpTo) });` becomes:

```ts
    set({ events, unread: unreadOf(events), ...deriveInvites(events, state.me?.participant.id, seenUpTo) });
```

(h) In `doLoad`, after its `ownProfile = undefined;` (the one directly before `const myGeneration = generation;`) insert `dropReadState();`; the loading patch becomes

```ts
    set({ status: "loading", error: undefined, refreshError: undefined, readOnlyReason: undefined, unread: {}, newAfter: undefined });
```

and the two lines `      if (onLobby()) readLobbySides(myGeneration);` / `      let sawOpen = false;` become:

```ts
      if (onLobby()) readLobbySides(myGeneration);
      // A load that ends with an identity fetches that identity's read state (§6.1). The Thread this
      // load landed on is opened for real when the answer arrives.
      if (me) loadReadState();
      let sawOpen = false;
```

(i) In `join()`, after its `ownProfile = undefined;` (the one directly before the comment "The join is already committed server-side") insert `dropReadState();`. The `set({ me: ... })` patch gains `unread: {}, newAfter: undefined,` on the `readOnlyReason: undefined,` line, and `loadReadState();` goes directly before its `scheduleRefresh();`:

```ts
      set({ me: { token: j.token, participant: withMyProfile(j.participant, j.token) }, needsName: false, participants,
        readOnlyReason: undefined,     // a join is the way out of the §2.6 read-only fallback
        unread: {}, newAfter: undefined,
        ...deriveInvites(state.events, j.participant.id, seenUpTo) });
      // `join()` installs the identity in place, without `load()` and without a new generation, so it
      // starts the read-state fetch itself (§6.1). The stamp's identity is what fences the old one's.
      loadReadState();
      scheduleRefresh();
```

(j) `selectThread` becomes:

```ts
    selectThread: (id) => {
      // Picking the Thread that is already open is not opening it: the divider stays where it is.
      const opening = id !== state.currentThreadId;
      markThreadSeen(id);
      set({ currentThreadId: id, ...deriveInvites(state.events, state.me?.participant.id, seenUpTo) });
      if (opening) openRead(id);
    },
```

(k) In `createThread`, after `set({ threads: ..., currentThreadId: t.id });` add `openRead(t.id);`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run`
Expected: PASS, the whole web suite, pristine. A red existing case is handled only as the Global Constraints' "known ripple" says.

- [ ] **Step 7: Typecheck, then commit**

Run: `pnpm -r typecheck`

```bash
git add src/web/src/unread.ts src/web/src/side-reads.ts src/web/src/session.ts src/web/test/unread.test.ts src/web/test/side-reads.test.ts src/web/test/session.test.ts src/web/test/components.test.tsx src/web/test/listeners-page.test.tsx
git diff --cached --stat
git commit -m "feat(web): read state per identity, unread counts and the mark on opening" -m "The session loads the read positions of the identity in hand on a load, a join and an identity change, fences every answer by identity, token, generation and request number, counts unread with unreadCounts, and on opening a Thread records newAfter and marks it read." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: web: read while visible (arrivals, the throttle, flushes, the hidden tab)

Spec §6.2 whole, and the visibility clauses of §6.1. **This task carries spec §9.4: `while visible, arrivals advance the position with at most one markRead per READ_FLUSH_MS (fake timers), and leaving the Thread flushes the pending position`; `while hidden, arrivals count as unread; on visible, positions are reloaded and the Thread is marked read`; `a failed markRead shows nothing and the next flush sends the latest position`; `a readPositions reply that arrives while the tab is hidden marks nothing; the hidden arrival stays unread until the tab is visible again`.**

**Files:**
- Modify: `src/web/src/unread.ts` (append), `src/web/src/session.ts`
- Test: `src/web/test/unread.test.ts` (append), `src/web/test/session.test.ts` (append a helper and a describe after Task 3's)

**Interfaces:**
- Consumes: Task 3's session internals (`sendMark`, `markNow`, `markOpenRead`, `dropReadState`, `loadReadState`, `localPosition`, `readState`) and test helpers (`recordingClient`, `readFixture`, `putsTo`, `isRead`, `turn`, `serverPositions`).
- Produces:

```ts
// src/web/src/unread.ts
export const READ_FLUSH_MS = 5000;
export type ReadThrottle = { advance(threadId: string, seq: number): void; flush(): void; retry(threadId: string, seq: number): void; reset(): void };
export function createReadThrottle(send: (threadId: string, seq: number) => void, intervalMs?: number, now?: () => number): ReadThrottle;
export type Visibility = { visible(): boolean; onChange(fn: () => void): () => void };
export function documentVisibility(): Visibility;

// createSession options gain
visibility?: Visibility;   // default documentVisibility()
readFlushMs?: number;      // default READ_FLUSH_MS

// src/web/test/session.test.ts
function fakeVisibility(visible?: boolean): Visibility & { set(next: boolean): void };
```

- [ ] **Step 1: Write the failing throttle tests.** Append to `src/web/test/unread.test.ts` (the import lines become `import { describe, it, expect, afterEach, vi } from "vitest";` and add `createReadThrottle, READ_FLUSH_MS` to the `../src/unread.js` import):

```ts
describe("createReadThrottle (spec 2026-09-26 §6.2)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("while visible, arrivals advance the position with at most one markRead per READ_FLUSH_MS, and leaving the Thread flushes the pending position", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.advance("T", 5);                          // nothing sent lately: at once
    expect(sent).toEqual([["T", 5]]);
    t.advance("T", 6);
    t.advance("T", 7);
    vi.advanceTimersByTime(READ_FLUSH_MS - 1);
    expect(sent).toEqual([["T", 5]]);
    vi.advanceTimersByTime(1);                  // the interval ends: the latest position, once
    expect(sent).toEqual([["T", 5], ["T", 7]]);
    t.advance("T", 8);                          // held again
    expect(sent).toHaveLength(2);
    t.flush();                                  // the Thread is left
    expect(sent).toEqual([["T", 5], ["T", 7], ["T", 8]]);
    vi.advanceTimersByTime(READ_FLUSH_MS * 3);
    expect(sent).toHaveLength(3);
  });

  it("holds a failed position for the next send without arming anything, and reset drops what it holds", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.retry("T", 5);
    vi.advanceTimersByTime(READ_FLUSH_MS * 2);
    expect(sent).toEqual([]);
    t.flush();
    expect(sent).toEqual([["T", 5]]);
    vi.advanceTimersByTime(READ_FLUSH_MS);      // a full interval since that send
    t.advance("T", 6);                          // at once
    t.advance("T", 7);                          // held
    t.reset();
    vi.advanceTimersByTime(READ_FLUSH_MS * 2);
    t.flush();
    expect(sent).toEqual([["T", 5], ["T", 6]]);
  });

  it("switching Threads just before the interval ends restarts the interval from the opening mark", () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const t = createReadThrottle((id, seq) => { sent.push([id, seq]); });
    t.advance("A", 5); t.flush();               // t=0: opening A, its mark at once
    vi.advanceTimersByTime(100);
    t.advance("A", 6);                          // t=100: an arrival in A, held
    vi.advanceTimersByTime(READ_FLUSH_MS - 200);
    t.flush();                                  // t=4900: leaving A flushes it
    t.advance("B", 7); t.flush();               // t=4900: opening B, its mark at once
    expect(sent).toEqual([["A", 5], ["A", 6], ["B", 7]]);
    t.advance("B", 8);                          // t=4900: an arrival in B, held
    vi.advanceTimersByTime(100);                // t=5000: A's old deadline passes, and nothing goes
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(READ_FLUSH_MS - 101);
    expect(sent).toHaveLength(3);               // t=9899
    vi.advanceTimersByTime(1);                  // t=9900: a full interval after B's opening mark
    expect(sent).toEqual([["A", 5], ["A", 6], ["B", 7], ["B", 8]]);
  });
});
```

- [ ] **Step 2: Write the failing session tests.** Append after Task 3's describe in `src/web/test/session.test.ts` (add `type Visibility` from `../src/unread.js` to the imports):

```ts
/** A tab whose visibility the test sets; `set` tells the session, as `visibilitychange` would. */
function fakeVisibility(visible = true): Visibility & { set(next: boolean): void } {
  const fns = new Set<() => void>();
  let v = visible;
  return {
    visible: () => v,
    onChange: (fn) => { fns.add(fn); return () => { fns.delete(fn); }; },
    set(next) { v = next; for (const fn of [...fns]) fn(); },
  };
}

describe("reading while the Thread is open (spec 2026-09-26 §6.2)", () => {
  const byId = (f: Awaited<ReturnType<typeof readFixture>>, client: LoomClient, over: { visibility?: Visibility; readFlushMs?: number } = {}) =>
    createSession({ client, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.j), ...over });
  const settled = async (session: Session, f: Awaited<ReturnType<typeof readFixture>>) => {
    await session.load();
    await waitFor(() => session.getState().unread[f.pr.id] === 1 && session.getState().connection === "open");
  };

  it("while visible, arrivals advance the position with at most one markRead per READ_FLUSH_MS, and leaving the Thread flushes the pending position", async () => {
    const f = await readFixture();
    const rec = recordingClient();
    // An interval no test outlives, so every send below is the throttle's decision, not the clock's.
    const session = byId(f, rec.client, { readFlushMs: 60_000 });
    try {
      await settled(session, f);
      session.selectThread(f.pr.id);                                   // the opening's mark: 6
      const divider = session.getState().newAfter;
      await s.core.postMessage(f.claude, f.pr.id, "a");                // 8
      await s.core.postMessage(f.claude, f.pr.id, "b");                // 9
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "b"));
      expect(session.getState().unread[f.pr.id]).toBeUndefined();     // read as it arrived
      expect(session.getState().newAfter).toEqual(divider);            // the divider did not move
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }]);        // held inside the interval
      session.selectThread(f.general);                                 // leaving flushes the latest
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }, { seq: 9 }]);
      await vi.waitFor(async () => expect((await serverPositions(f.j.token, f.r.weave.id)).threads[f.pr.id]).toBe(9));
    } finally { session.dispose(); }
  });

  it("while hidden, arrivals count as unread; on visible, positions are reloaded and the Thread is marked read", async () => {
    const f = await readFixture();
    const vis = fakeVisibility();
    const rec = recordingClient();
    const session = byId(f, rec.client, { visibility: vis });
    try {
      await settled(session, f);
      session.selectThread(f.pr.id);
      const divider = session.getState().newAfter;
      vis.set(false);
      await s.core.postMessage(f.claude, f.pr.id, "while away");       // 8
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }]);
      const reloads = rec.calls.filter(isRead("GET")).length;
      vis.set(true);
      expect(rec.calls.filter(isRead("GET")).length).toBe(reloads + 1);
      await waitFor(() => session.getState().unread[f.pr.id] === undefined);
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }, { seq: 8 }]);
      expect(session.getState().newAfter).toEqual(divider);            // newAfter is not moved
    } finally { session.dispose(); }
  });

  it("a failed markRead shows nothing and the next flush sends the latest position", async () => {
    const f = await readFixture();
    let failedYet = false;
    const rec = recordingClient({ failOnce: (m, p) => {
      const hit = m === "PUT" && p === `/api/threads/${f.pr.id}/read`;
      if (hit) failedYet = true;
      return hit;
    } });
    const session = byId(f, rec.client, { readFlushMs: 60_000 });
    try {
      await settled(session, f);
      session.selectThread(f.pr.id);                                   // the mark of 6 fails
      await waitFor(() => failedYet);
      await turn();
      const st = session.getState();
      expect([st.status, st.error, st.refreshError, st.unread[f.pr.id]]).toEqual(["ready", undefined, undefined, undefined]);
      session.selectThread(f.general);                                 // the next flush carries it again
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }, { seq: 6 }]);
      await vi.waitFor(async () => expect((await serverPositions(f.j.token, f.r.weave.id)).threads[f.pr.id]).toBe(6));
    } finally { session.dispose(); }
  });

  it("a readPositions reply that arrives while the tab is hidden marks nothing; the hidden arrival stays unread until the tab is visible again", async () => {
    const f = await readFixture();
    const vis = fakeVisibility();
    const gate = makeGate();
    let gets = 0;
    let parkedDone = false;
    // The load's read passes; the first refresh a visibility change asks for is answered, then held.
    const rec = recordingClient({ park: { match: (m, p) => m === "GET" && /\/read$/.test(p) && ++gets === 2,
      gate, answerFirst: true, onDone: () => { parkedDone = true; } } });
    const session = byId(f, rec.client, { visibility: vis });
    try {
      await settled(session, f);
      session.selectThread(f.pr.id);
      vis.set(false);
      await s.core.postMessage(f.claude, f.pr.id, "away");             // 8
      await waitFor(() => session.getState().unread[f.pr.id] === 1);
      vis.set(true);                                                   // a refresh leaves
      await gate.entered;
      vis.set(false);                                                  // hidden again before it lands
      gate.release();
      await waitFor(() => parkedDone);
      await turn();
      expect(session.getState().unread[f.pr.id]).toBe(1);
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }]);
      vis.set(true);
      await waitFor(() => session.getState().unread[f.pr.id] === undefined);
      expect(putsTo(rec.calls, f.pr.id)).toEqual([{ seq: 6 }, { seq: 8 }]);
    } finally { session.dispose(); }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd src/web && npx vitest run test/unread.test.ts test/session.test.ts`
Expected: FAIL. `unread.test.ts`: `createReadThrottle` is not exported. The four new session cases fail: `readFlushMs`/`visibility` are not options yet (TypeScript is not checked by vitest, so they run and fail on behaviour), `expected 1 to be undefined` for an arrival in the open Thread, and a `PUT` sent while hidden. Task 3's cases still pass.

- [ ] **Step 4: The throttle and the visibility seam.** Append to `src/web/src/unread.ts`:

```ts
/** At most one automatic `markRead` per this many milliseconds while a Thread stays open (§6.2). */
export const READ_FLUSH_MS = 5000;

/** What the session hands positions to: it decides when each one reaches the server. */
export type ReadThrottle = {
  /** A position reached: sent now when the latest send is a full interval old, else held until it is. */
  advance(threadId: string, seq: number): void;
  /** Sends everything held, now: the Thread was left or opened, or the tab hid. It counts as the latest send. */
  flush(): void;
  /** Holds a position whose send failed, for the next send; arms nothing. */
  retry(threadId: string, seq: number): void;
  /** Drops everything held, unsent, and the interval: an identity change, or the session ending. */
  reset(): void;
};

/**
 * The §6.2 throttle: the latest position per Thread, and an automatic send only when the latest
 * **actual** send (automatic, or a flush) is at least `intervalMs` old, so a flush restarts the
 * interval. Flushes themselves are never delayed. A held position is only ever raised. `now` is
 * the clock; the fake timers of the tests fake `Date` as well.
 */
export function createReadThrottle(send: (threadId: string, seq: number) => void, intervalMs: number = READ_FLUSH_MS,
  now: () => number = () => Date.now()): ReadThrottle {
  let held = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  const hold = (threadId: string, seq: number) => { if (seq > (held.get(threadId) ?? -1)) held.set(threadId, seq); };
  const sendHeld = () => {
    if (held.size === 0) return;
    const out = [...held];
    held = new Map();
    lastSent = now();
    for (const [threadId, seq] of out) send(threadId, seq);
  };
  /** One timer at most, due a full interval after the latest send; it re-checks, because a flush may have moved that. */
  const schedule = () => {
    if (timer !== undefined || held.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (held.size === 0) return;
      if (now() - lastSent < intervalMs) { schedule(); return; }
      sendHeld();
    }, Math.max(0, lastSent + intervalMs - now()));
  };
  return {
    advance(threadId, seq) {
      hold(threadId, seq);
      if (now() - lastSent >= intervalMs) sendHeld(); else schedule();
    },
    flush() { sendHeld(); },
    retry(threadId, seq) { hold(threadId, seq); },
    reset() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      held = new Map();
      lastSent = Number.NEGATIVE_INFINITY;
    },
  };
}

/** Whether the tab is visible, and a way to hear when that changes: the session's seam for §6.2. */
export type Visibility = { visible(): boolean; onChange(fn: () => void): () => void };

/** The document's own visibility; without a document (the node test environment) always visible. */
export function documentVisibility(): Visibility {
  if (typeof document === "undefined") return { visible: () => true, onChange: () => () => {} };
  return {
    visible: () => document.visibilityState === "visible",
    onChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}
```

- [ ] **Step 5: The session.** Edits to `src/web/src/session.ts` on top of Task 3's:

(a) The unread import becomes:

```ts
import { createReadThrottle, documentVisibility, firstNewSeq, mergePositions, newestSeqIn, READ_FLUSH_MS, unreadCounts, type Visibility } from "./unread.js";
```

(b) The options' last line `  closedRequestsPage?: number }): Session {` becomes:

```ts
  closedRequestsPage?: number;
  /** Whether the tab is visible, and told when that changes (spec 2026-09-26 §6.2). The document's
   *  own by default; the session tests, which run without a document, hand in their own. */
  visibility?: Visibility;
  /** Override for `READ_FLUSH_MS`: the knob a session test uses to keep the throttle's clock out of its way. */
  readFlushMs?: number }): Session {
```

and after `const closedPage = opts.closedRequestsPage ?? CLOSED_REQUESTS_PAGE;` add:

```ts
  const visibility = opts.visibility ?? documentVisibility();
```

(c) `dropReadState` becomes:

```ts
  /** Drops the read state of an identity that is being replaced, and every position held for it, unsent. */
  const dropReadState = () => { readState = undefined; throttle.reset(); };
```

(d) In `sendMark`'s rejection handler, the two lines `// Silent: the local position stands.` / `if (!isCredentialFailure(e)) return;` become:

```ts
        // Silent: the local position stands, and the next send carries this position again.
        if (!isCredentialFailure(e)) { throttle.retry(threadId, seq); return; }
```

(e) `markNow` becomes, and the throttle and the visibility subscription follow it:

```ts
  /** The mark of an opening: sent at once, and the interval restarts from it. */
  const markNow = (threadId: string, seq: number) => { throttle.advance(threadId, seq); throttle.flush(); };
  const throttle = createReadThrottle((threadId, seq) => sendMark(threadId, seq), opts.readFlushMs ?? READ_FLUSH_MS);
  /**
   * The visibility rule's two edges (§6.2): hiding flushes what was read while visible; showing
   * reloads the positions, and their answer marks the open Thread (if the tab is still visible then).
   */
  const offVisibility = visibility.onChange(() => {
    if (disposed) return;
    if (!visibility.visible()) { throttle.flush(); return; }
    loadReadState();
  });
```

(f) In `markOpenRead`, after `if (!readState || !id) return;` add:

```ts
    // Every automatic mark waits for a visible tab (§6.2); the next visibility change does it then.
    if (!visibility.visible()) return;
```

(g) In `onEvent`, directly before the `set({ events, unread: ... })` line:

```ts
    // While the open Thread is on a visible tab, what arrives in it is read as it arrives (§6.2): the
    // local position moves now, so no count appears, and the server hears through the throttle.
    if (readState && e.threadId === state.currentThreadId && visibility.visible() && e.seq > localPosition(e.threadId)) {
      readState = { ...readState, positions: { ...readState.positions, [e.threadId]: e.seq } };
      throttle.advance(e.threadId, e.seq);
    }
```

(h) In `selectThread`, before `markThreadSeen(id);` add `if (opening) throttle.flush();   // leaving a Thread flushes it (§6.2)`. In `createThread`, before `markThreadSeen(t.id);` add `throttle.flush();`.

(i) `dispose` begins with:

```ts
    dispose: () => {
      // Leaving the Weave flushes what was read while it was open (§6.2), under the identity in hand;
      // the answers are dropped, because the session they would land in is gone.
      throttle.flush();
      throttle.reset();
      offVisibility();
```

(the rest of `dispose` is unchanged).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run`
Expected: PASS, the whole web suite, pristine; Task 3's cases unchanged.

- [ ] **Step 7: Typecheck, then commit**

Run: `pnpm -r typecheck`

```bash
git add src/web/src/unread.ts src/web/src/session.ts src/web/test/unread.test.ts src/web/test/session.test.ts
git diff --cached --stat
git commit -m "feat(web): read while visible: arrivals, the throttle, flushes and the hidden tab" -m "Arrivals in the open Thread advance the position while the tab is visible, sent at most once per READ_FLUSH_MS and flushed on leaving, on hiding and on dispose. A hidden tab marks nothing; becoming visible reloads positions and marks. A failed mark is silent and carried by the next send." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: web: the count in the Thread list and the "New" divider

Spec §6.3, §6.4. **This task carries spec §9.4: `ThreadList shows an unread count with its aria-label, none at zero and none for the open Thread`; `the New divider sits before the first message by others after newAfter, and not at all without one`; `the divider does not move when messages arrive while the Thread is open`.**

**Files:**
- Modify: `src/web/src/components/ThreadList.tsx`, `src/web/src/components/MessageList.tsx`
- Test: `src/web/test/components.test.tsx` (a case in `describe("ThreadList")`, a nested describe in `describe("MessageList")`)

**Interfaces:**
- Consumes: `SessionState.unread`, `SessionState.newAfter` (Task 3).
- Produces: the DOM hooks `.unread-count` (text N, `aria-label` "N unread"), `.new-divider` (`role="separator"`, text "New").

- [ ] **Step 1: Write the failing tests.** In `src/web/test/components.test.tsx`, inside `describe("ThreadList", ...)`:

```tsx
  it("ThreadList shows an unread count with its aria-label, none at zero and none for the open Thread", () => {
    const design = { ...pr, id: "t3", name: "Design", url: null };
    render(<ThreadList state={state({ threads: [general, pr, design], currentThreadId: "g1", unread: { t1: 2, t3: 0, g1: 5 } })}
      session={session()} onError={() => {}} />);
    const count = (name: RegExp) => screen.getByRole("button", { name }).querySelector(".unread-count");
    expect([count(/^PR 12/)?.textContent, count(/^PR 12/)?.getAttribute("aria-label")]).toEqual(["2", "2 unread"]);
    expect([count(/^Design/), count(/^General/)]).toEqual([null, null]);
  });
```

Inside `describe("MessageList", ...)`:

```tsx
  describe("the New divider (spec 2026-09-26 §6.4)", () => {
    const at = "2026-09-26T10:00:00.000Z";
    const msg = (seq: number, actor: string) => ({ weaveId: "w1", seq, threadId: "t1", type: "message" as const, actor, at, payload: { text: `m${seq}` } });
    const joined = { weaveId: "w1", seq: 5, threadId: "t1", type: "participant.joined" as const, actor: "p2", at, payload: { participantId: "p2" } };
    /** The stream as a list: a message by its text, the divider as New, a system row as sys. */
    const order = (c: Element) => [...c.querySelectorAll(".messages > *")].filter((el) => el.className !== "")
      .map((el) => el.classList.contains("new-divider") ? "New" : el.matches("article.msg") ? el.querySelector(".msg-body")!.textContent!.trim() : "sys");

    it("the New divider sits before the first message by others after newAfter, and not at all without one", () => {
      const events = [msg(3, "p2"), msg(4, "p1"), joined, msg(6, "p2"), msg(7, "p2")];
      const first = render(<MessageList state={state({ currentThreadId: "t1", events, newAfter: { threadId: "t1", seq: 3, firstNew: 6 } })} fold={false} />);
      expect(order(first.container)).toEqual(["m3", "m4", "sys", "New", "m6", "m7"]);
      const sep = first.container.querySelector(".new-divider")!;
      expect([sep.getAttribute("role"), sep.textContent]).toEqual(["separator", "New"]);
      first.unmount();
      const none = render(<MessageList state={state({ currentThreadId: "t1", events, newAfter: { threadId: "t1", seq: 7, firstNew: null } })} fold={false} />);
      expect(none.container.querySelector(".new-divider")).toBeNull();
      none.unmount();
      // A divider captured for another Thread is not this one's.
      const elsewhere = render(<MessageList state={state({ currentThreadId: "t1", events, newAfter: { threadId: "g1", seq: 3, firstNew: 6 } })} fold={false} />);
      expect(elsewhere.container.querySelector(".new-divider")).toBeNull();
    });

    it("the divider does not move when messages arrive while the Thread is open", () => {
      const newAfter = { threadId: "t1", seq: 3, firstNew: 6 };
      const view = render(<MessageList state={state({ currentThreadId: "t1", events: [msg(3, "p2"), msg(6, "p2")], newAfter })} fold={false} />);
      view.rerender(<MessageList state={state({ currentThreadId: "t1", events: [msg(3, "p2"), msg(6, "p2"), msg(8, "p2"), msg(9, "p2")], newAfter })} fold={false} />);
      expect(order(view.container)).toEqual(["m3", "New", "m6", "m8", "m9"]);
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src/web && npx vitest run test/components.test.tsx`
Expected: FAIL on the three new cases (`expected [ undefined, undefined ] to deeply equal [ '2', '2 unread' ]`; the stream has no `New`); every existing case passes.

- [ ] **Step 3: The count.** In `src/web/src/components/ThreadList.tsx`, after `const invited = state.invitesForMe.has(t.id);` add:

```tsx
          // None for the open Thread, which is being read (spec 2026-09-26 §6.3).
          const unread = t.id === state.currentThreadId ? 0 : (state.unread[t.id] ?? 0);
```

and after `{invited && <span class="badge-invited">invited</span>}` add:

```tsx
                {unread > 0 && <span class="unread-count" aria-label={`${unread} unread`}>{unread}</span>}
```

- [ ] **Step 4: The divider.** In `src/web/src/components/MessageList.tsx`, add `import { Fragment } from "preact";` beside the hooks import. In `MessageList`, after `const events = ...` add:

```tsx
  // Fixed when the Thread was opened (spec 2026-09-26 §6.4), so nothing that arrives moves it.
  const na = state.newAfter;
  const dividerAt = na && na.threadId === state.currentThreadId ? na.firstNew : null;
```

and the message branch of the map becomes:

```tsx
        item.kind === "message" ? (
          <Fragment key={item.key}>
            {item.event.seq === dividerAt && <div class="new-divider" role="separator">New</div>}
            <Message e={item.event} state={state} />
          </Fragment>
        )
```

(the `system` and run branches are unchanged).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run`
Expected: PASS, pristine.

- [ ] **Step 6: Typecheck, then commit**

Run: `pnpm -r typecheck`

```bash
git add src/web/src/components/ThreadList.tsx src/web/src/components/MessageList.tsx src/web/test/components.test.tsx
git diff --cached --stat
git commit -m "feat(web): the unread count in the Thread list and the New divider" -m "ThreadList shows .unread-count with aria-label N unread, none at zero and none for the open Thread; MessageList renders .new-divider (role separator, New) before the message newAfter fixed at opening. Behaviour and class hooks only, no CSS." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: web: Mark all read, and read positions on the Lobby page

Spec §6.5, §6.6. **This task carries spec §9.4: `Mark all read calls markAllRead and clears every count up to the answered seq`; `it is absent without an identity and in an archived Weave`; `a Mark all read reply delayed past an arrival and a Thread switch never lowers a position`.** It also adds `a Mark all read that succeeds while read state is loading survives the initial readPositions reply` (review round 1, F4: the same "never lowers" rule, for a cutoff that lands before the read state does) and one Lobby case for §6.6, which the spec lists no test for.

**Files:**
- Modify: `src/web/src/session.ts` (`Session.markAllRead`, its implementation, the held cutoff `markAllCut` with its merge in `loadReadState` and its reset in `dropReadState`), `src/web/src/components/WeaveView.tsx` (the button)
- Test: `src/web/test/session.test.ts` (append a describe after Task 4's), `src/web/test/components.test.tsx` (the `session()` fixture gains `markAllRead`; a describe after `describe("WeaveView ...")`)

**Interfaces:**
- Consumes: `LoomClient.markAllRead` (Task 2); `readState`, `ownsRead`, `nowForRead`, `isOwnedBy`, `unreadOf`, `mergePositions`, `loadReadState`, `dropReadState`, `recoverFromCredentialFailure`, `writer` (Tasks 3 and 4).
- Produces: `Session.markAllRead(): Promise<void>`; the DOM hook `button.mark-all-read` with text "Mark all read".

- [ ] **Step 1: Write the failing tests.** In `src/web/test/components.test.tsx`, the `session()` fixture gains `markAllRead: vi.fn(async () => {}),` directly before `...over`. After the `describe("WeaveView (spec §2.6, §2.7, §3.3)", ...)` block:

```tsx
describe("Mark all read (spec 2026-09-26 §6.5)", () => {
  const button = () => screen.queryByRole("button", { name: "Mark all read" });

  it("Mark all read calls markAllRead", () => {
    const markAllRead = vi.fn(async () => {});
    render(<WeaveView session={session({ markAllRead })} state={state()} />);
    fireEvent.click(button()!);
    expect(markAllRead).toHaveBeenCalledTimes(1);
    expect(button()!.classList.contains("mark-all-read")).toBe(true);
  });

  it("it is absent without an identity and in an archived Weave", () => {
    const stranger = render(<WeaveView session={session()} state={state({ me: undefined })} />);
    expect(button()).toBeNull();
    stranger.unmount();
    render(<WeaveView session={session()} state={state({ weave: { ...state().weave!, archivedAt: "2026-09-26T10:00:00.000Z" } })} />);
    expect(button()).toBeNull();
  });

  it("shows a failure through the Weave view's error bar", async () => {
    render(<WeaveView session={session({ markAllRead: vi.fn(async () => { throw new Error("Could not reach Loom"); }) })} state={state()} />);
    fireEvent.click(button()!);
    expect((await screen.findByText("Could not reach Loom")).className).toContain("error-bar");
  });
});
```

Append after Task 4's describe in `src/web/test/session.test.ts`:

```ts
describe("Mark all read, and the Lobby page (spec 2026-09-26 §6.5, §6.6)", () => {
  it("Mark all read calls markAllRead and clears every count up to the answered seq", async () => {
    const f = await readFixture();
    const pr2 = await s.core.createThread(f.claude, f.r.weave.id, "PR 2");   // 8
    await s.core.postMessage(f.claude, pr2.id, "x");                         // 9
    const rec = recordingClient();
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.j) });
    try {
      await session.load();
      await waitFor(() => session.getState().unread[f.pr.id] === 1 && session.getState().unread[pr2.id] === 1);
      await session.markAllRead();
      expect(session.getState().unread).toEqual({});
      expect(rec.calls.filter(isRead("POST"))).toHaveLength(1);
      expect((await serverPositions(f.j.token, f.r.weave.id)).threads).toEqual({ [f.general]: 9, [f.pr.id]: 9, [pr2.id]: 9 });
    } finally { session.dispose(); }
  });

  it("a Mark all read reply delayed past an arrival and a Thread switch never lowers a position", async () => {
    const f = await readFixture();
    const gate = makeGate();
    // The server samples last_seq (7) and answers; the session hears the answer only on release.
    const rec = recordingClient({ park: { match: (m, p) => m === "POST" && /\/read$/.test(p), gate, answerFirst: true } });
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id },
      storage: storedIdentity(f.r.weave.id, f.j), readFlushMs: 60_000 });
    try {
      await session.load();
      await waitFor(() => session.getState().unread[f.pr.id] === 1 && session.getState().connection === "open");
      session.selectThread(f.pr.id);
      const pending = session.markAllRead();
      await gate.entered;
      await s.core.postMessage(f.claude, f.pr.id, "late");                    // 8, past the cutoff
      await waitFor(() => session.getState().events.some((e) => e.payload.text === "late"));
      session.selectThread(f.general);                                       // leaving PR 1 flushes 8
      gate.release();
      await pending;
      // Merged as max(current, 7): PR 1 stays at 8, so the late message is not counted again.
      expect(session.getState().unread[f.pr.id]).toBeUndefined();
      await vi.waitFor(async () => expect((await serverPositions(f.j.token, f.r.weave.id)).threads[f.pr.id]).toBe(8));
    } finally { session.dispose(); }
  });

  it("a Mark all read that succeeds while read state is loading survives the initial readPositions reply", async () => {
    const f = await readFixture();
    const gate = makeGate();
    let snapshotDone = false;
    // The server answers the load's read with the old positions (none, so PR 1 is unread); the
    // session hears that answer only after Mark all read has succeeded.
    const rec = recordingClient({ park: { match: (m, p) => m === "GET" && /\/read$/.test(p), gate, answerFirst: true,
      onDone: () => { snapshotDone = true; } } });
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: f.r.weave.id }, storage: storedIdentity(f.r.weave.id, f.j) });
    try {
      await session.load();
      await gate.entered;
      await session.markAllRead();                                            // cutoff 7, every Thread
      gate.release();
      await waitFor(() => snapshotDone);
      await waitFor(() => session.getState().newAfter !== undefined);
      // PR 1 was never opened: the stale snapshot did not bring its count back.
      expect(session.getState().unread).toEqual({});
      expect(session.getState().newAfter).toEqual({ threadId: f.general, seq: 7, firstNew: null });
    } finally { session.dispose(); }
  });

  it("on the Lobby's own page the Lobby identity gets its divider and its marks", async () => {
    const lobby = await anon.getLobby();
    const n = ++fixtureN;
    const me = await anon.joinLobby({ name: `Reader-${n}`, kind: "human" });
    const other = await anon.joinLobby({ name: `Poster-${n}`, kind: "human" });
    const said = await anon.withToken(other.token).postMessage(me.generalThreadId, "hello Lobby");
    const { joinedSeq } = await serverPositions(me.token, lobby.weaveId);
    const rec = recordingClient();
    const session = createSession({ client: rec.client, target: { kind: "id", weaveId: lobby.weaveId }, storage: storedIdentity(lobby.weaveId, me) });
    try {
      await session.load();
      await waitFor(() => session.getState().newAfter !== undefined);
      expect(session.getState().newAfter).toEqual({ threadId: me.generalThreadId, seq: joinedSeq, firstNew: said.seq });
      await waitFor(() => putsTo(rec.calls, me.generalThreadId).length === 1);
      expect(rec.calls.filter(isRead("PUT")).every((c) => c.token === me.token)).toBe(true);
    } finally { session.dispose(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src/web && npx vitest run test/components.test.tsx test/session.test.ts`
Expected: FAIL. The three component cases find no "Mark all read" button (the fixture's `markAllRead` is an unknown key only to the type checker, which vitest does not run); the three Mark-all session cases fail with `session.markAllRead is not a function`. The Lobby case **passes already**: §6.6 needs no code of its own, because the Lobby page is `WeaveSession` with an id target like any other Weave. Say so in the report; it is a guard, not a RED.

- [ ] **Step 3: The session.** In `src/web/src/session.ts`:

(a) Directly after `const readReads = createCounter();`:

```ts
  /**
   * A Mark all read that answered while the identity's read state had not loaded yet (spec
   * 2026-09-26 §6.5, review round 1 F4): the cutoff per Thread, owned by the identity and the
   * generation it was issued under. `loadReadState` max-merges it into the answer it applies, so a
   * snapshot the server took before the cutoff cannot bring a count back; an identity change drops it.
   */
  let markAllCut: (Owner & { positions: Record<string, number> }) | undefined;
```

(b) `dropReadState` becomes:

```ts
  /** Drops the read state of an identity that is being replaced, every position held for it (unsent) and its held cutoff. */
  const dropReadState = () => { readState = undefined; throttle.reset(); markAllCut = undefined; };
```

(c) In `loadReadState`'s answer handler, directly after the `readState = { id: stamp.id, ... };` assignment and before `set({ unread: unreadOf(state.events) });`:

```ts
        if (markAllCut && isOwnedBy(markAllCut, nowForRead())) {
          readState = { ...readState, positions: mergePositions(readState.positions, markAllCut.positions) };
        }
        markAllCut = undefined;
```

(d) The `Session` type's line `  dismissNamePrompt(): void; dispose(): void;` becomes:

```ts
  dismissNamePrompt(): void; dispose(): void;
  /** Marks every Thread of the Weave read up to the newest event the server saw (spec 2026-09-26 §6.5). */
  markAllRead(): Promise<void>;
```

(e) In the returned object, after `setGuidelines`:

```ts
    async markAllRead() {
      const w = writer();
      if (!weaveId || !state.me) throw new LoomClientError("validation", "Weave not loaded");
      const owner: Owner = { id: state.me.participant.id, token: state.me.token, generation };
      let answer: { seq: number; threads: number };
      try { answer = await w.markAllRead(weaveId); }
      catch (e) {
        // A rejection for an identity or generation this session has left is dropped, unshown (§6.1).
        if (!ownsRead(owner)) return;
        if (isCredentialFailure(e)) {
          const recovered = recoverFromCredentialFailure(e, "identity");
          if (recovered?.reload) void doLoad();
        }
        throw e;                        // the Weave view's error path shows it
      }
      if (!ownsRead(owner)) return;
      // max(current, answered): a position this tab advanced past the cutoff while the call was in
      // flight is never lowered, and what is held beyond it is flushed as usual.
      const cut: Record<string, number> = {};
      for (const t of state.threads) cut[t.id] = answer.seq;
      // No read state yet: keep the cutoff for the answer that is on its way, rather than lose it.
      if (!readState) { markAllCut = { ...owner, positions: cut }; return; }
      readState = { ...readState, positions: mergePositions(readState.positions, cut) };
      set({ unread: unreadOf(state.events) });
    },
```

- [ ] **Step 4: The button.** In `src/web/src/components/WeaveView.tsx`, directly after the `<ThreadList ... />` element in the sidebar:

```tsx
          {/* Behaviour and a class hook only (spec 2026-09-26 §6.5); the look and the place are the
              design session's. A failure takes the view's one error path. */}
          {state.me && !archived && (
            <button type="button" class="btn btn-xs mark-all-read"
              onClick={() => { setError(undefined); session.markAllRead().catch(reportError); }}>Mark all read</button>
          )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src/web && npx vitest run`
Expected: PASS, pristine.

- [ ] **Step 6: Typecheck, then commit**

Run: `pnpm -r typecheck`

```bash
git add src/web/src/session.ts src/web/src/components/WeaveView.tsx src/web/test/session.test.ts src/web/test/components.test.tsx
git diff --cached --stat
git commit -m "feat(web): Mark all read, and read positions on the Lobby page" -m "session.markAllRead merges every Thread as max(current, answered seq), fenced like every read call; WeaveView shows .mark-all-read with an identity on a Weave that is not archived. The Lobby page carries the same behaviour with its Lobby identity (a guard test)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: docs, the manual check, and the totals

Spec §7, §9.6, §12. **This task carries spec §9.6 (written into TESTING.md here; run by Paw after the deploy).** §9.5 is checked here too: `git diff --stat origin/main -- src/mcp-tools src/cli src/claude-channel` must print nothing.

**Files:** `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/KNOWN-ISSUES.md`, `docs/superpowers/specs/v2-notes.md`; `README.md` checked only.

**Interfaces:** consumes the names of Tasks 1 to 6; produces no code.

- [ ] **Step 1: ARCHITECTURE.md.** In the §3 rule table, after the "Work deadlines" row:

```markdown
| Read positions | `reads.ts`: `markRead`, `markAllRead`, `readPositions`. A read is not an event: no Weave lock, no bus, nothing in the log. The unread count is the web's (`src/web/src/unread.ts`, `unreadCounts`) |
```

In the §4 table, after the `weave_invitations` row:

```markdown
| `read_positions` | `(participant_id, thread_id)` primary key, `seq` (the highest seq of the Weave's log that participant has read in that Thread, never lowered, never past `last_seq`) and `updated_at`. Written by `reads.ts` only; no event records it. |
```

After the paragraph that begins "Migration 0005 added those eight columns":

```markdown
Migration 0006 creates `read_positions` and nothing else; nothing is backfilled, so a Thread with no
row reads from the participant's own `participant.joined`.
```

In §7, after the sentence that ends "reads `Authorization: Bearer …`.":

```markdown
Read positions are three routes beside the others: `PUT /api/threads/:id/read` (body `{ seq }`), and
`POST` and `GET /api/weaves/:id/read`. Reads are not events, so none of them reaches the stream.
```

- [ ] **Step 2: SECURITY.md.** In the authorization table, after the "Remove a participant from a Thread" row:

```markdown
| Read positions (mark a Thread read, mark all read, read my positions) | The participant only, in its own Weave: not an instance keeper, not a Weave secret, not a raw agent key (an agent key acts as the participant it owns there). No route takes a participant id, so nobody reads or writes another's positions. Writes no event, so nothing is exported or delivered. Refused on an archived Weave for the two writes; `readPositions` still answers. `seq` is capped at the Weave's `last_seq` | [`reads.ts`](../src/core/src/reads.ts) |
```

- [ ] **Step 3: KNOWN-ISSUES.md.** Append to the `## web` table:

```markdown
| [session.ts](../src/web/src/session.ts) | A Thread read in one tab reaches another open tab of the same identity only when that tab next becomes visible and reloads its positions: there is no push of a read | spec 2026-09-26 §11: a read is not an event, so nothing publishes it | publish reads on a per-participant channel if two tabs ever need to agree live |
```

- [ ] **Step 4: v2-notes.md.** In "Web redesign from the design session", the bullet `- Unread counts per Thread and the "New" divider in the stream (needs a per-reader read marker).` becomes:

```markdown
- Unread counts per Thread and the "New" divider in the stream: **built** by the unread slice
  ([spec](2026-09-26-loom-unread-design.md), [plan](../plans/2026-09-26-loom-unread.md)).
```

Directly after that section, before `## Deferred from v1`:

```markdown
### Carry a web identity to another device (Paw, 2026-09-26)

A web identity lives in the browser that joined, so a read position stored on the server follows a
participant across reloads and tabs, and across devices only once an identity can move to another
browser. Paw's answer Q4 of the unread brainstorm: not part of the unread slice, its own idea. Open
questions: how the identity is handed over (a one-time link, a code typed on the other device) and
how a lost device is cut off.

### Unread counted on the server (follow-up of the unread slice, 2026-09-26)

The web counts unread from the whole event history it already loads (spec 2026-09-26 §2, §11). If
the web stops loading whole histories, counting moves to the server: a count per Thread for the
caller, from `read_positions` and the log. The stored positions need no change.
```

- [ ] **Step 5: TESTING.md.** "Seven things the automated suites cannot cover" becomes "Eight things ..."; after smoke test 7 add:

```markdown
**8. Unread counts and the New divider on the live instance.** After the deploy that applies
migration 0006, one step at a time with Paw, each result reported before the next step. Paw opens
the live Weave "Loom development" in the browser, joined there, with the General Thread open. Claude
Code posts two messages to a Thread Paw is not viewing, with the live CLI prefix from the handoff
and `post --thread <threadId> <text>`. Check: that Thread's row shows a count of 2 (`.unread-count`, "2 unread"). Paw
opens it: a "New" line sits above the first of the two, and the count is gone. Paw reloads the page:
no count comes back. Claude Code posts once more to another Thread; Paw presses "Mark all read": the
count is gone.

*Last run:* not yet run.
```

In "What each package's tests cover", add to the core row `reads.test.ts` (read positions: bounds, never back, per participant, `joinedSeq`, no event, the facade's agent mapping), to the server row the three read routes, to the client row the three read wrappers, and to the web row `unread.test.ts` (the unread rule, the divider rule, the throttle on fake timers) and the read-state, visibility and Mark-all-read cases in `session.test.ts` and `components.test.tsx`. The file counts in that table change only for core (+1) and web (+1).

- [ ] **Step 6: README.md.** Run `grep -n "/api/threads\|/api/weaves/:id" README.md`. At plan time it prints nothing: the README lists no REST surface, so the routes go into ARCHITECTURE §7 (Step 1) and the README is left alone. If it prints lines, add the three routes beside them and name the place in the report.

- [ ] **Step 7: The full run and the totals**

Run: `pnpm -r build && pnpm -r typecheck && pnpm --workspace-concurrency=1 -r test`
Expected: every suite green, pristine. Then `git diff --stat origin/main -- src/mcp-tools src/cli src/claude-channel` prints nothing (spec §9.5).

Rewrite TESTING.md "Current totals" from **what this run printed** (per package, tests and files, and overall), against Task 0's ledger record, naming the new files (`src/core/test/reads.test.ts`, `src/web/test/unread.test.ts`) and where the other new cases went. Never estimate.

- [ ] **Step 8: Commit**

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md docs/TESTING.md docs/KNOWN-ISSUES.md docs/superpowers/specs/v2-notes.md
git diff --cached --stat
git commit -m "docs: read positions and unread counts; the manual check" -m "ARCHITECTURE, SECURITY, KNOWN-ISSUES and v2-notes as spec 7 lists; TESTING gains smoke test 8 and the measured totals. README lists no REST surface and is unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**After the merge (controller, not an implementer task):** `deploy/live-update.cmd` applies migration 0006 as it applied 0005 (spec §12); then smoke test 8 with Paw, one step at a time.

---

## Decisions this plan makes (for the controller to confirm with Paw)

1. **The divider is fixed at opening.** `newAfter` carries `firstNew`, the first message by others after the position, computed when the Thread is opened (or when read state first arrives for the Thread open then). A Thread opened with nothing new shows no divider, and a message that arrives later while it stays open does not get one. Reason: spec §6.4 "recomputed only when a Thread is opened" and "None when there is no such event"; a divider computed on every render would appear above the first arrival.
2. **Picking the Thread that is already open is not opening it.** No new divider, no mark. Reason: the Thread list's click on the current row would otherwise move the divider, which §6.4 says stays while the Thread stays open.
3. **"Open" is the session's selected Thread,** also while the Lobby page shows the listeners directory instead of it. Arrivals there are read while the tab is visible. Reason: the session does not know the view, and §6.2 defines "open" by selection; the alternative needs the view to tell the session.
4. **The interval runs from the latest actual send** (review round 1, F5). The next automatic send comes at least `READ_FLUSH_MS` after the latest send of any kind: an automatic one, an opening's mark, or a flush. Flushes on leave, hide and dispose are never delayed, and each restarts the interval. So opening Thread B just before Thread A's interval ends does not let B's first arrival go out right after B's opening mark.
5. **A failed mark is held for the next send and arms nothing.** If the Thread stays open and later sends fail too, the held position is retried at most once per interval, never faster.
6. **On becoming visible, the mark waits for the reloaded positions** (§6.2 "reload positions, then mark"). If the reload fails, the Thread is marked on the next visibility change.
7. **A `markRead` answer raises the local position** to the stored seq (which another tab may have moved further). Reason: it costs nothing and the server's answer is the stored position by definition (§4.1 step 7).
8. **Mark all read merges over the Threads the session holds** (`state.threads`). An answer that lands before the identity's read state has loaded is held as a cutoff owned by that identity and generation, and max-merged into the read state when it arrives (review round 1, F4); an identity change drops it. A Thread created after the last refresh is corrected by the next `readPositions`. A stale rejection (another identity or generation) is dropped unshown; a current credential failure takes the invalid-identity flow and is still shown on the error bar.
9. **Leaving the Weave is `dispose()`,** which flushes what is held under the identity in hand and drops the answers.
10. **Facade order:** an agent key on a well-formed but unknown Weave id is `weave_not_found` (the new `forWeave` checks the Weave before mapping the key), where `getWeave` and `readEvents` answer `forbidden` "Join the Weave first". Reason: spec §4.2 and §4.3 put `weave_not_found` first; `forThread` already does the same for Threads.
11. **README.md is unchanged:** it lists no REST surface (spec §7 says "wherever the REST surface is listed"); the routes go into ARCHITECTURE §7.
12. **Two seams on `createSession`:** `visibility` (default the document's; always visible without a document) and `readFlushMs` (default 5000). The spec's "(fake timers)" test is the throttle's unit test in `unread.test.ts`; the session's own test of the same behaviour runs on the real server with a 60 s interval, because the session tests' real network and `waitFor` do not run under fake timers.
13. **The Mark all read button** sits in the sidebar directly under the Thread list and reuses the existing `btn btn-xs` classes so it is not unstyled; the place and the look stay the design session's.
14. **The web task split** differs from the suggested one: opening moved into Task 3 (the §6.1 tests observe it), rendering is its own task (5), Mark all read and the Lobby page are Task 6, docs Task 7.

## Spec test traceability

| Spec test | Task |
| --- | --- |
| §9.1 `markRead stores a position and readPositions returns it` | 1 |
| §9.1 `markRead never moves a position back` | 1 |
| §9.1 `markRead refuses a seq past the Weave's newest event` | 1 |
| §9.1 `markRead refuses a negative or fractional seq` | 1 |
| §9.1 `markRead on an unknown Thread is thread_not_found` | 1 |
| §9.1 `a participant of another Weave, the instance keeper and a raw agent key are forbidden` | 1 |
| §9.1 `markRead and markAllRead are weave_archived in an archived Weave; readPositions still answers` | 1 |
| §9.1 `markRead accepts a closed Thread` | 1 |
| §9.1 `markAllRead sets every Thread of the Weave, open and closed, to last_seq and never lowers one` | 1 |
| §9.1 `readPositions gives joinedSeq ...`, and only the actor's own positions | 1 |
| §9.1 `markRead writes no event` | 1 |
| §9.1 `positions are per participant` | 1 |
| §9.1 the migration test covers 0006 (existing "case 9", run in Task 1 Step 7) | 1 |
| §9.2 the three routes: round trips, 400, 401, 404 | 2 |
| §9.3 `markRead`, `markAllRead`, `readPositions` round trip | 2 |
| §9.4 `unreadCounts` (pure) | 3 |
| §9.4 `ThreadList shows an unread count with its aria-label, none at zero and none for the open Thread` | 5 |
| §9.4 `opening a Thread marks it read up to its newest event and records newAfter` | 3 |
| §9.4 `the New divider sits before the first message by others after newAfter, and not at all without one` | 5 |
| §9.4 `the divider does not move when messages arrive while the Thread is open` | 5 |
| §9.4 `while visible, arrivals advance the position with at most one markRead per READ_FLUSH_MS (fake timers), and leaving the Thread flushes the pending position` | 4 |
| §9.4 `while hidden, arrivals count as unread; on visible, positions are reloaded and the Thread is marked read` | 4 |
| §9.4 `Mark all read calls markAllRead and clears every count up to the answered seq`; `it is absent without an identity and in an archived Weave` | 6 |
| §9.4 `a browser with no identity loads no positions and shows no counts` | 3 |
| §9.4 `a failed markRead shows nothing and the next flush sends the latest position` | 4 |
| §9.4 `joining on a visible secret-only page loads read positions, then counts and the divider follow` | 3 |
| §9.4 `replacing the identity while a readPositions call is pending drops the stale reply` | 3 |
| §9.4 `no counts, no divider and no markRead before read state has loaded` | 3 |
| §9.4 `a Mark all read reply delayed past an arrival and a Thread switch never lowers a position` | 6 |
| beyond the list (review round 1, F4) `a Mark all read that succeeds while read state is loading survives the initial readPositions reply` | 6 |
| beyond the list (review round 1, F5) `switching Threads just before the interval ends restarts the interval from the opening mark` | 4 |
| §9.4 `a readPositions reply that arrives while the tab is hidden marks nothing; the hidden arrival stays unread until the tab is visible again` | 4 |
| §9.5 no `mcp-tools`, `cli` or `claude-channel` test changes (checked by `git diff --stat`) | 7 |
| §9.6 the manual check, written into TESTING.md as smoke test 8 (run by Paw after the deploy) | 7 |

Cases this plan adds beyond the spec's list, each in the task named: the facade's agent mapping and `weave_not_found` order (1); `isOwnedBy` (3); `firstNewSeq`, `newestSeqIn`, `mergePositions` (3); the throttle's retry and reset, and `switching Threads just before the interval ends restarts the interval from the opening mark` (4, review round 1 F5); `a Mark all read that succeeds while read state is loading survives the initial readPositions reply` (6, review round 1 F4); the Mark-all failure on the error bar (6); the Lobby page (6).
