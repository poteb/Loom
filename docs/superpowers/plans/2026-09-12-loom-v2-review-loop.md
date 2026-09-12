# Loom v2 — Review Loop Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread invites with agent-side wake/opt-out, a URL per Thread, an `inbox` for prompted remote agents, and agent keys that give remote MCP clients a stable identity.

**Architecture:** Every rule lands in `@loom/core` first (Drizzle/Postgres, one migration), then the thin adapters follow: REST routes + remote MCP in `@loom/server`, the shared tool definitions in `@loom/mcp-tools`, typed wrappers in `@loom/client`, the `loom` CLI, the Claude Code channel plugin (per-session preferences in its versioned state file), and the Preact web UI. New event types ride the existing append-only per-Weave log.

**Tech Stack:** TypeScript 5.9 (strict, ESM, `.js` import suffixes), pnpm 10 workspace, Node 24, Drizzle ORM 0.45 + drizzle-kit 0.31 on Postgres, Hono + `@hono/mcp`, `@modelcontextprotocol/sdk` 1.30, zod 4, commander, Preact 10 + Vite 7, vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-loom-v2-review-loop-design.md`

## Global Constraints

- Every rule (permissions, validation, idempotency) lives in `src/core`; adapters stay thin and are tested for wiring only.
- Tests run against Postgres via `TEST_DATABASE_URL` (the vitest `globalSetup` in `src/core/test/global-setup.ts` provides it). Run one package at a time: `cd src/<pkg> && npx vitest run`. `@loom/claude-channel` tests need `pnpm build` in that package first (they spawn `dist/server.js`).
- Build order when a lower package's API changes: `pnpm --filter @loom/core build`, then client, mcp-tools, server, channel, cli, web. `pnpm -r typecheck` must stay clean.
- Participant/agent names: 1–32 chars of `A-Z a-z 0-9 _ . -` (`validateName` in `src/core/src/names.ts`); names are unique per Weave case-insensitively.
- Secrets/tokens/keys: 32 random bytes base64url = 43 chars (`newSecret()` in `src/core/src/ids.ts`); logs redact 43-char runs.
- Error codes are the fixed set in `src/core/src/errors.ts`; REST maps them in `src/server/src/errors.ts`; MCP returns `{code,message}` tool errors; CLI prints `{code,message}` JSON with exit 1.
- Thread `url`: nullable, ≤ 2000 chars, `http:`/`https:` only.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. The repo only allows squash merges.
- Work on branch `feat/v2-review-loop` off `main`; one PR at the end.

---

## File structure

| Package | Create | Modify |
| --- | --- | --- |
| core | `src/agents.ts`, `src/invites.ts`, `src/inbox.ts`, `drizzle/0001_*.sql` (+meta), `test/agents.test.ts`, `test/invites.test.ts`, `test/inbox.test.ts` | `src/db/schema.ts`, `src/types.ts`, `src/errors.ts` (no new codes; unchanged), `src/actors.ts`, `src/threads.ts`, `src/weaves.ts`, `src/export.ts`, `src/index.ts`, `test/threads.test.ts`, `test/weaves.test.ts`, `test/helpers.ts` |
| mcp-tools | — | `src/backend.ts`, `src/tools.ts`, `test/tools.test.ts` |
| server | `src/routes/agents.ts` | `src/auth.ts`, `src/routes/threads.ts`, `src/routes/weaves.ts`, `src/mcp/index.ts`, `src/mcp/backend.ts`, `src/app.ts`, `test/routes.test.ts`, `test/mcp.test.ts` |
| client | — | `src/types.ts`, `src/client.ts`, `test/client.test.ts` |
| cli | `src/commands/invite.ts` | `src/commands/thread.ts`, `src/commands/admin.ts`, `src/context.ts`, `src/cli.ts`, `test/cli-more.test.ts` |
| claude-channel | — | `src/state.ts`, `src/format.ts`, `src/streams.ts`, `src/channel-tools.ts`, `src/stored.ts`, `src/server.ts`, `test/state.test.ts`, `test/format.test.ts`, `test/streams.test.ts`, `test/channel.test.ts` |
| web | `test/dom-setup.ts`, `test/components.test.tsx` | `src/session.ts`, `src/components/ThreadList.tsx`, `src/components/MessageList.tsx`, `src/components/Header.tsx`, `src/app.tsx`, `src/styles.css`, `package.json`, `vitest.config.ts`, `tsconfig.test.json` |
| docs | — | `README.md`, `src/claude-channel/README.md`, `docs/superpowers/specs/v2-notes.md` |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull -q origin main && git checkout -b feat/v2-review-loop
```

---

### Task 1: Core schema, types and migration

**Files:**
- Modify: `src/core/src/db/schema.ts`, `src/core/src/types.ts`, `src/core/test/helpers.ts`
- Create: `src/core/drizzle/0001_<name>.sql` and `src/core/drizzle/meta/0001_snapshot.json` (generated)
- Test: `src/core/test/db.test.ts`

**Interfaces:**
- Produces: `threads.url` (text, nullable), table `agents { id uuid pk, name text, keyHash text unique, createdAt, revokedAt nullable }`, `participants.agentId uuid nullable → agents.id` with unique index `participants_weave_agent_idx (weave_id, agent_id)`; `PublicThread.url: string | null`; `EventType` adds `"thread.invited" | "thread.url_changed"`; `Actor` adds `{ kind: "agent"; agent: PublicAgent }`; `PublicAgent = { id: string; name: string; createdAt: string; revokedAt: string | null }`.

- [ ] **Step 1: Write the failing test** (append to `src/core/test/db.test.ts`)

```ts
import { sql } from "drizzle-orm";
// ...inside the existing describe, after the other cases:
it("v2 columns and tables exist after migration", async () => {
  const db = await freshDb();
  const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'threads' and column_name = 'url'`);
  expect(cols.length).toBe(1);
  const agents = await db.execute(sql`select column_name from information_schema.columns where table_name = 'agents' order by column_name`);
  expect(agents.map((r: Record<string, unknown>) => r.column_name)).toEqual(["created_at", "id", "key_hash", "name", "revoked_at"]);
  const pcol = await db.execute(sql`select column_name from information_schema.columns where table_name = 'participants' and column_name = 'agent_id'`);
  expect(pcol.length).toBe(1);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src/core && npx vitest run test/db.test.ts`
Expected: FAIL (`url` column count 0).

- [ ] **Step 3: Change the schema**

In `src/core/src/db/schema.ts`:

```ts
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  isGeneral: boolean("is_general").notNull().default(false),
  createdBy: text("created_by").notNull(),
  url: text("url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [index("threads_weave_idx").on(t.weaveId)]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["human", "agent"] }).notNull(),
  role: text("role", { enum: ["member", "keeper"] }).notNull().default("member"),
  token: text("token").notNull().unique(),
  agentId: uuid("agent_id").references(() => agents.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("participants_weave_name_idx").on(t.weaveId, sql`lower(${t.name})`),
  uniqueIndex("participants_weave_agent_idx").on(t.weaveId, t.agentId),
]);
```

(`agents` must be declared *before* `participants` in the file because `participants` references it.)

- [ ] **Step 4: Generate the migration**

Run: `cd src/core && pnpm db:generate`
Expected: a new `drizzle/0001_<adjective>_<noun>.sql` containing `ALTER TABLE "threads" ADD COLUMN "url" text`, `CREATE TABLE "agents" …`, `ALTER TABLE "participants" ADD COLUMN "agent_id" uuid`, the FK, and `CREATE UNIQUE INDEX "participants_weave_agent_idx"`. `drizzle/meta/_journal.json` gains entry idx 1. Open the SQL file and check those five statements are present.

- [ ] **Step 5: Truncate the new table in tests**

In `src/core/test/helpers.ts` change the truncate line to:

```ts
await db.execute(sql`truncate events, participants, threads, weaves, keepers, settings, agents restart identity cascade`);
```

- [ ] **Step 6: Update the domain types** in `src/core/src/types.ts`

```ts
export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.url_changed" | "weave.archived";

export type PublicThread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};

export type PublicAgent = { id: string; name: string; createdAt: string; revokedAt: string | null };

export type Actor =
  | { kind: "participant"; participant: PublicParticipant }
  | { kind: "keeper"; keeperId: string; name: string }
  | { kind: "secret"; weaveId: string }
  | { kind: "agent"; agent: PublicAgent };
```

And in `src/core/src/weaves.ts` extend `toPublicThread` with `url: t.url ?? null`.

- [ ] **Step 7: Build and run the core tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: all pass (existing thread tests use `toMatchObject`, so the new `url` field does not break them). If a test does `toEqual` on a full thread object, add `url: null` to its expectation.

- [ ] **Step 8: Commit**

```bash
git add src/core && git commit -m "feat(core): v2 schema — thread url, agents table, participant agent link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Agents — mint, list, revoke, and resolve as an Actor

**Files:**
- Create: `src/core/src/agents.ts`, `src/core/test/agents.test.ts`
- Modify: `src/core/src/actors.ts`, `src/core/src/index.ts`, `src/core/src/ids.ts`

**Interfaces:**
- Produces (in `agents.ts`): `hashKey(key: string): string` (sha256 hex); `addAgent(db, actor, name): Promise<{ agent: PublicAgent; key: string }>`; `listAgents(db, actor): Promise<PublicAgent[]>`; `revokeAgent(db, actor, id): Promise<void>`; `toPublicAgent(row)`.
- Produces (in `actors.ts`): `resolveCredential` returns `{ kind: "agent", agent }` for a live agent key; `participantForAgent(db, agentId, weaveId): Promise<PublicParticipant | undefined>`; `resolveInWeave(db, actor, weaveId): Promise<Actor>` — for an agent actor returns the participant actor it owns in that Weave or throws `forbidden("Join the Weave first")`; for any other actor returns it unchanged. Every Weave-scoped core operation calls this first (Task 5 wires the callers).
- Facade (`index.ts`): `addAgent`, `listAgents`, `revokeAgent`.

- [ ] **Step 1: Write the failing tests** — `src/core/test/agents.test.ts`

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { addAgent, listAgents, revokeAgent, hashKey } from "../src/agents.js";
import { resolveCredential, resolveInWeave } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { createWeave } from "../src/weaves.js";
import { EventBus } from "../src/bus.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); await seedKeepers(db, [keeperToken("k1")]); });
const keeper = () => resolveCredential(db, keeperToken("k1"));

describe("agents", () => {
  it("instance keeper mints a key shown once; only its hash is stored; the key resolves to an agent actor", async () => {
    const { agent, key } = await addAgent(db, await keeper(), "ChatGPT");
    expect(key).toHaveLength(43);
    expect(agent).toMatchObject({ name: "ChatGPT", revokedAt: null });
    const listed = await listAgents(db, await keeper());
    expect(listed).toEqual([agent]);
    expect(JSON.stringify(listed)).not.toContain(key);
    const actor = await resolveCredential(db, key);
    expect(actor).toEqual({ kind: "agent", agent });
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("non-keepers cannot mint, list or revoke", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const p = await resolveCredential(db, r.token);
    await expect(addAgent(db, p, "X")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAgents(db, p)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeAgent(db, p, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("validates the name like a participant name", async () => {
    await expect(addAgent(db, await keeper(), "bad name!")).rejects.toMatchObject({ code: "validation" });
    await expect(addAgent(db, await keeper(), "")).rejects.toMatchObject({ code: "validation" });
  });
  it("a revoked key no longer resolves; the agent stays listed with revokedAt; revoking twice or an unknown id is a validation error", async () => {
    const { agent, key } = await addAgent(db, await keeper(), "Bot");
    await revokeAgent(db, await keeper(), agent.id);
    await expect(resolveCredential(db, key)).rejects.toMatchObject({ code: "invalid_token" });
    const [listed] = await listAgents(db, await keeper());
    expect(listed!.revokedAt).not.toBeNull();
    await expect(revokeAgent(db, await keeper(), agent.id)).rejects.toMatchObject({ code: "validation" });
    await expect(revokeAgent(db, await keeper(), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "validation" });
  });
  it("resolveInWeave: an agent without a participant in the Weave is forbidden; other actors pass through", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const { key } = await addAgent(db, await keeper(), "Bot");
    const agent = await resolveCredential(db, key);
    await expect(resolveInWeave(db, agent, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    const p = await resolveCredential(db, r.token);
    expect(await resolveInWeave(db, p, r.weave.id)).toBe(p);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/core && npx vitest run test/agents.test.ts`
Expected: FAIL — `../src/agents.js` does not exist.

- [ ] **Step 3: Implement `src/core/src/agents.ts`**

```ts
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { agents } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid, newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { assertInstanceKeeperFresh } from "./actors.js";
import type { Actor, PublicAgent } from "./types.js";

/** Only the SHA-256 of an agent key is stored; the key itself is shown once when minted. */
export function hashKey(key: string): string { return createHash("sha256").update(key, "utf8").digest("hex"); }

export function toPublicAgent(a: typeof agents.$inferSelect): PublicAgent {
  return { id: a.id, name: a.name, createdAt: a.createdAt.toISOString(), revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null };
}

export async function addAgent(db: Db, actor: Actor, name: string): Promise<{ agent: PublicAgent; key: string }> {
  await assertInstanceKeeperFresh(db, actor);
  const clean = validateName(name);
  const key = newSecret();
  const [row] = await db.insert(agents).values({ id: newId(), name: clean, keyHash: hashKey(key) }).returning();
  return { agent: toPublicAgent(row!), key };
}

export async function listAgents(db: Db, actor: Actor): Promise<PublicAgent[]> {
  await assertInstanceKeeperFresh(db, actor);
  return (await db.select().from(agents).orderBy(agents.createdAt)).map(toPublicAgent);
}

/** Revocation stops the key from authenticating; the agent's participants and their history stay. */
export async function revokeAgent(db: Db, actor: Actor, id: string): Promise<void> {
  await assertInstanceKeeperFresh(db, actor);
  if (!isUuid(id)) throw errors.validation("No such agent");
  const [a] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!a) throw errors.validation("No such agent");
  if (a.revokedAt) throw errors.validation("Agent is already revoked");
  await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, id));
}
```

- [ ] **Step 4: Extend `src/core/src/actors.ts`**

Add imports `agents` (schema), `and`, `isNull` from drizzle-orm, `PublicAgent`, and the `hashKey`/`toPublicAgent` functions — to avoid an import cycle (`agents.ts` imports `assertInstanceKeeperFresh` from `actors.ts`), put `hashKey` and `toPublicAgent` in a new tiny module `src/core/src/agent-keys.ts` and import them from both files:

```ts
// src/core/src/agent-keys.ts
import { createHash } from "node:crypto";
import type { agents } from "./db/schema.js";
import type { PublicAgent } from "./types.js";
export function hashKey(key: string): string { return createHash("sha256").update(key, "utf8").digest("hex"); }
export function toPublicAgent(a: typeof agents.$inferSelect): PublicAgent {
  return { id: a.id, name: a.name, createdAt: a.createdAt.toISOString(), revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null };
}
```

(and in `agents.ts` replace the local definitions with `export { hashKey, toPublicAgent } from "./agent-keys.js";` plus the import.)

Then in `actors.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { participants, keepers, weaves, agents } from "./db/schema.js";
import { hashKey, toPublicAgent } from "./agent-keys.js";

/** Resolves a bearer credential: participant token, keeper token, agent key, or weave secret. */
export async function resolveCredential(db: Db, credential: string): Promise<Actor> {
  if (!credential) throw errors.invalidToken();
  const [p] = await db.select().from(participants).where(eq(participants.token, credential)).limit(1);
  if (p) return { kind: "participant", participant: toPublicParticipant(p) };
  const [k] = await db.select().from(keepers).where(eq(keepers.token, credential)).limit(1);
  if (k) return { kind: "keeper", keeperId: k.id, name: k.name };
  const [a] = await db.select().from(agents).where(and(eq(agents.keyHash, hashKey(credential)), isNull(agents.revokedAt))).limit(1);
  if (a) return { kind: "agent", agent: toPublicAgent(a) };
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, credential)).limit(1);
  if (w) return { kind: "secret", weaveId: w.id };
  throw errors.invalidToken();
}

/** The participant an agent owns in a Weave, if it has joined. */
export async function participantForAgent(db: Db, agentId: string, weaveId: string): Promise<PublicParticipant | undefined> {
  const [p] = await db.select().from(participants)
    .where(and(eq(participants.agentId, agentId), eq(participants.weaveId, weaveId))).limit(1);
  return p ? toPublicParticipant(p) : undefined;
}

/**
 * An agent key is an instance-level identity; inside a Weave it acts as the participant it owns
 * there. Every Weave-scoped operation resolves through here first; non-agent actors pass through.
 */
export async function resolveInWeave(db: Db, actor: Actor, weaveId: string): Promise<Actor> {
  if (actor.kind !== "agent") return actor;
  const me = await participantForAgent(db, actor.agent.id, weaveId);
  if (!me) throw errors.forbidden("Join the Weave first");
  return { kind: "participant", participant: me };
}
```

Also update `actorId`, `assertCanRead`, `assertParticipantOf`, `assertIsKeeperOf`, `assertStillKeeperOf` so an `agent` actor that somehow reaches them is rejected with `forbidden("Join the Weave first")` — add `if (actor.kind === "agent") throw errors.forbidden("Join the Weave first");` as the first line of each (in `assertCanRead` before computing `scoped`). Update `toPublicParticipant` to include nothing new (agent linkage is exposed in Task 5).

- [ ] **Step 5: Export from the facade** — `src/core/src/index.ts`

```ts
import * as agentsMod from "./agents.js";
import { resolveInWeave } from "./actors.js";
// inside createCore's returned object:
    addAgent: (actor: Actor, name: string) => agentsMod.addAgent(db, actor, name),
    listAgents: (actor: Actor) => agentsMod.listAgents(db, actor),
    revokeAgent: (actor: Actor, id: string) => agentsMod.revokeAgent(db, actor, id),
    resolveInWeave: (actor: Actor, weaveId: string) => resolveInWeave(db, actor, weaveId),
// and at the bottom:
export type { PublicAgent } from "./types.js";
```

- [ ] **Step 6: Run the tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: `agents.test.ts` passes; everything else still green.

- [ ] **Step 7: Commit**

```bash
git add src/core && git commit -m "feat(core): agent keys — mint/list/revoke, resolve as actor, resolveInWeave

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Thread URL — create with URL, set/clear URL, `thread.url_changed`

**Files:**
- Modify: `src/core/src/threads.ts`, `src/core/src/index.ts`, `src/core/src/export.ts`
- Test: `src/core/test/threads.test.ts`

**Interfaces:**
- Produces: `createThread(db, bus, actor, weaveId, name, url?: string | null): Promise<PublicThread>` (event payload `{ threadId, name, url }`); `setThreadUrl(db, bus, actor, threadId, url: string | null): Promise<PublicThread>` (event `thread.url_changed` payload `{ threadId, url }`, no event when unchanged); `validateThreadUrl(url: string | null | undefined): string | null` (exported for adapters' tests). Facade: `createThread(actor, weaveId, name, url?)`, `setThreadUrl(actor, threadId, url)`.

- [ ] **Step 1: Write the failing tests** (append inside `src/core/test/threads.test.ts`; add `setThreadUrl` to the import from `../src/threads.js`)

```ts
describe("thread url", () => {
  it("createThread stores a validated http(s) url and puts it in the thread.created payload", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "PR 12", "https://github.com/poteb/Loom/pull/12");
    expect(t.url).toBe("https://github.com/poteb/Loom/pull/12");
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last.payload).toEqual({ threadId: t.id, name: "PR 12", url: "https://github.com/poteb/Loom/pull/12" });
    const plain = await createThread(db, bus, me, r.weave.id, "No link");
    expect(plain.url).toBeNull();
    expect((await readEvents(db, r.weave.id, {})).at(-1)!.payload).toMatchObject({ url: null });
  });
  it("rejects non-http(s), unparsable and over-long urls", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    for (const bad of ["ftp://x/y", "javascript:alert(1)", "not a url", "https://" + "a".repeat(2000)]) {
      await expect(createThread(db, bus, me, r.weave.id, "T", bad)).rejects.toMatchObject({ code: "validation" });
    }
  });
  it("creator or keeper may set/clear the url; a plain member may not; unchanged value emits nothing", async () => {
    const r = await createWeave(db, bus, input);                       // creator of the Weave = keeper
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    const keeper = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, member, r.weave.id, "PR");    // member is the thread creator
    const k = await joinWeave(db, bus, r.secret, { name: "Other", kind: "human" });
    const other = await resolveCredential(db, k.token);
    await expect(setThreadUrl(db, bus, other, t.id, "https://e.com")).rejects.toMatchObject({ code: "forbidden" });
    const byCreator = await setThreadUrl(db, bus, member, t.id, "https://e.com/1");
    expect(byCreator.url).toBe("https://e.com/1");
    const byKeeper = await setThreadUrl(db, bus, keeper, t.id, "https://e.com/2");
    expect(byKeeper.url).toBe("https://e.com/2");
    const before = (await readEvents(db, r.weave.id, {})).length;
    await setThreadUrl(db, bus, keeper, t.id, "https://e.com/2");      // same value
    expect((await readEvents(db, r.weave.id, {})).length).toBe(before);
    const cleared = await setThreadUrl(db, bus, keeper, t.id, null);
    expect(cleared.url).toBeNull();
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "thread.url_changed", threadId: t.id, payload: { threadId: t.id, url: null } });
  });
  it("cannot set the url of a closed thread or in an archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "T");
    await closeThread(db, bus, me, t.id);
    await expect(setThreadUrl(db, bus, me, t.id, "https://e.com")).rejects.toMatchObject({ code: "thread_closed" });
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(setThreadUrl(db, bus, me, r.generalThread.id, "https://e.com")).rejects.toMatchObject({ code: "weave_archived" });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/core && npx vitest run test/threads.test.ts`
Expected: FAIL (`setThreadUrl` is not exported; url argument ignored).

- [ ] **Step 3: Implement in `src/core/src/threads.ts`**

```ts
const MAX_URL = 2000;

/** null/undefined → null; otherwise a parsable http(s) URL of at most 2000 chars, trimmed. */
export function validateThreadUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_URL) throw errors.validation(`Thread url must be at most ${MAX_URL} characters`);
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw errors.validation("Thread url must be a valid http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw errors.validation("Thread url must use http or https");
  return trimmed;
}

/** Creator of the thread, or a keeper of its Weave (participant keeper or instance keeper). */
function assertCreatorOrKeeper(actor: Actor, t: { createdBy: string; weaveId: string }): void {
  if (actor.kind === "participant" && actor.participant.weaveId === t.weaveId && actor.participant.id === t.createdBy) return;
  assertIsKeeperOf(actor, t.weaveId);
}

export async function createThread(db: Db, bus: EventBus, actor: Actor, weaveId: string, name: string, url?: string | null): Promise<PublicThread> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) throw errors.validation("Thread name must be 1-100 characters");
  const cleanUrl = validateThreadUrl(url);
  const threadId = newId();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: trimmed, createdBy: me.id, url: cleanUrl }).returning();
    return {
      result: toPublicThread(t!),
      events: [{ threadId, type: "thread.created" as const, actor: me.id, payload: { threadId, name: trimmed, url: cleanUrl } }],
    };
  });
}

export async function setThreadUrl(db: Db, bus: EventBus, actor: Actor, threadId: string, url: string | null): Promise<PublicThread> {
  const t = await getThread(db, threadId);
  assertCreatorOrKeeper(actor, t);
  const cleanUrl = validateThreadUrl(url);
  return withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select().from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    if (actor.kind !== "participant" || actor.participant.id !== fresh!.createdBy) await assertStillKeeperOf(tx, actor, t.weaveId);
    if ((fresh!.url ?? null) === cleanUrl) return { result: toPublicThread(fresh!), events: [] };
    const [updated] = await tx.update(threads).set({ url: cleanUrl }).where(eq(threads.id, threadId)).returning();
    return {
      result: toPublicThread(updated!),
      events: [{ threadId, type: "thread.url_changed" as const, actor: actorId(actor), payload: { threadId, url: cleanUrl } }],
    };
  });
}
```

- [ ] **Step 4: Facade and export** — `src/core/src/index.ts`:

```ts
    createThread: (actor: Actor, weaveId: string, name: string, url?: string | null) => threads.createThread(db, bus, actor, weaveId, name, url),
    setThreadUrl: (actor: Actor, threadId: string, url: string | null) => threads.setThreadUrl(db, bus, actor, threadId, url),
```

In `src/core/src/export.ts` render the new system lines in the Markdown branch:

```ts
        e.type === "thread.url_changed" ? (e.payload.url ? `Thread now links to ${String(e.payload.url)}` : "Thread no longer links to an artefact") :
```

(place it before the `weave.archived` line) and in the `## ${t.name}` heading add the link: `lines.push(t.url ? `## ${t.name}\n\n<${t.url}>` : `## ${t.name}`, "");`.

- [ ] **Step 5: Run the tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core && git commit -m "feat(core): thread url — create with url, set/clear, thread.url_changed event

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Invites — `inviteParticipant` and `thread.invited`

**Files:**
- Create: `src/core/src/invites.ts`, `src/core/test/invites.test.ts`
- Modify: `src/core/src/index.ts`, `src/core/src/export.ts`

**Interfaces:**
- Produces: `inviteParticipant(db, bus, actor, threadId, participantId): Promise<{ seq: number; created: boolean }>` — event `thread.invited`, payload `{ threadId, participantId, invitedBy }` where `invitedBy` is `actorId(actor)`. Facade: `inviteParticipant(actor, threadId, participantId)`.

- [ ] **Step 1: Write the failing tests** — `src/core/test/invites.test.ts`

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { inviteParticipant } from "../src/invites.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { setRole } from "../src/participants.js";
import { seedKeepers } from "../src/keepers.js";
import { participants } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); await seedKeepers(db, [keeperToken("k1")]); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

async function setup() {
  const r = await createWeave(db, bus, input);
  const owner = await resolveCredential(db, r.token);                       // Weave keeper
  const c = await joinWeave(db, bus, r.secret, { name: "Creator", kind: "human" });
  const creator = await resolveCredential(db, c.token);
  const m = await joinWeave(db, bus, r.secret, { name: "Member", kind: "human" });
  const member = await resolveCredential(db, m.token);
  const g = await joinWeave(db, bus, r.secret, { name: "Guest", kind: "agent" });
  const guest = await resolveCredential(db, g.token);
  const t = await createThread(db, bus, creator, r.weave.id, "PR 1", "https://e.com/pr/1");
  return { r, owner, creator, member, guest, t, memberId: m.participant.id, guestId: g.participant.id };
}

describe("inviteParticipant", () => {
  it("thread creator invites; event carries invitee and inviter; invite is idempotent", async () => {
    const { r, creator, t, guestId } = await setup();
    const first = await inviteParticipant(db, bus, creator, t.id, guestId);
    expect(first.created).toBe(true);
    const ev = (await readEvents(db, r.weave.id, {})).find((e) => e.seq === first.seq)!;
    expect(ev).toMatchObject({ type: "thread.invited", threadId: t.id, payload: { threadId: t.id, participantId: guestId } });
    expect(ev.payload.invitedBy).toBe(ev.actor);
    const again = await inviteParticipant(db, bus, creator, t.id, guestId);
    expect(again).toEqual({ seq: first.seq, created: false });
    expect((await readEvents(db, r.weave.id, {})).filter((e) => e.type === "thread.invited")).toHaveLength(1);
  });
  it("Weave keeper and instance keeper invite; plain member cannot", async () => {
    const { owner, member, t, guestId, memberId } = await setup();
    await expect(inviteParticipant(db, bus, member, t.id, guestId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await inviteParticipant(db, bus, owner, t.id, guestId)).created).toBe(true);
    const instance = await resolveCredential(db, keeperToken("k1"));
    const byInstance = await inviteParticipant(db, bus, instance, t.id, memberId);
    expect(byInstance.created).toBe(true);
    const ev = (await readEvents(db, t.weaveId, {})).find((e) => e.seq === byInstance.seq)!;
    expect(String(ev.payload.invitedBy)).toMatch(/^keeper:/);
  });
  it("a member promoted to keeper may invite", async () => {
    const { r, owner, t, guestId, memberId } = await setup();
    await setRole(db, bus, owner, r.weave.id, memberId, "keeper");
    const [row] = await db.select().from(participants).where(eq(participants.id, memberId));
    const promoted = await resolveCredential(db, row!.token);   // re-resolve: an Actor carries the role captured at resolution
    expect((await inviteParticipant(db, bus, promoted, t.id, guestId)).created).toBe(true);
  });
  it("rejects self-invite, non-participants, closed threads, archived weaves and bad ids", async () => {
    const { r, owner, creator, t, guestId } = await setup();
    const creatorId = creator.kind === "participant" ? creator.participant.id : "";
    await expect(inviteParticipant(db, bus, creator, t.id, creatorId)).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, t.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, t.id, "nope")).rejects.toMatchObject({ code: "validation" });
    await expect(inviteParticipant(db, bus, creator, "00000000-0000-4000-8000-000000000000", guestId)).rejects.toMatchObject({ code: "thread_not_found" });
    const other = await createWeave(db, bus, input);
    const stranger = await resolveCredential(db, other.token);
    await expect(inviteParticipant(db, bus, stranger, t.id, guestId)).rejects.toMatchObject({ code: "forbidden" });
    await closeThread(db, bus, owner, t.id);
    await expect(inviteParticipant(db, bus, creator, t.id, guestId)).rejects.toMatchObject({ code: "thread_closed" });
    await archiveWeave(db, bus, owner, r.weave.id);
    await expect(inviteParticipant(db, bus, owner, r.generalThread.id, guestId)).rejects.toMatchObject({ code: "weave_archived" });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/core && npx vitest run test/invites.test.ts`
Expected: FAIL — `../src/invites.js` missing.

- [ ] **Step 3: Implement `src/core/src/invites.ts`**

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertStillKeeperOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor } from "./types.js";

/**
 * Invites a participant of the Weave into a Thread: a targeted "your input is wanted here", never an
 * access change (every participant can already read every Thread). Allowed for the Thread's creator
 * or a keeper of the Weave. Idempotent: a participant already invited to the Thread gets the original
 * event's seq back and no new event.
 */
export async function inviteParticipant(db: Db, bus: EventBus, actor: Actor, threadId: string, participantId: string): Promise<{ seq: number; created: boolean }> {
  const t = await getThread(db, threadId);
  const isCreator = actor.kind === "participant" && actor.participant.weaveId === t.weaveId && actor.participant.id === t.createdBy;
  if (!isCreator) assertIsKeeperOf(actor, t.weaveId);
  if (!isUuid(participantId)) throw errors.validation("No such participant in this Weave");
  const me = actorId(actor);
  if (me === participantId) throw errors.validation("You cannot invite yourself");
  return withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (!isCreator) await assertStillKeeperOf(tx, actor, t.weaveId);
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    const [invitee] = await tx.select({ id: participants.id }).from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, t.weaveId))).limit(1);
    if (!invitee) throw errors.validation("No such participant in this Weave");
    const [existing] = await tx.select({ seq: events.seq }).from(events)
      .where(and(eq(events.threadId, threadId), eq(events.type, "thread.invited"), sql`${events.payload}->>'participantId' = ${participantId}`))
      .orderBy(asc(events.seq)).limit(1);
    if (existing) return { result: { seq: existing.seq, created: false }, events: [] };
    return {
      result: { seq: weave.lastSeq + 1, created: true },
      events: [{ threadId, type: "thread.invited" as const, actor: me, payload: { threadId, participantId, invitedBy: me } }],
    };
  });
}
```

- [ ] **Step 4: Facade and export** — `src/core/src/index.ts`: `import { inviteParticipant } from "./invites.js";` and `inviteParticipant: (actor: Actor, threadId: string, participantId: string) => inviteParticipant(db, bus, actor, threadId, participantId),`. In `src/core/src/export.ts` add before the `weave.archived` line: `e.type === "thread.invited" ? `${nameOf(e.payload.participantId)} invited by ${who(e.actor)}` :`.

- [ ] **Step 5: Run the tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core && git commit -m "feat(core): thread invites — creator or keeper, idempotent, thread.invited event

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Agents act inside Weaves — linked join/create, facade wiring, `agentId` on participants

**Files:**
- Modify: `src/core/src/weaves.ts`, `src/core/src/actors.ts`, `src/core/src/types.ts`, `src/core/src/index.ts`
- Test: `src/core/test/agents.test.ts`

**Interfaces:**
- Produces: `PublicParticipant.agentId: string | null`; `joinWeave(db, bus, secret, who, actor?: Actor)` — with an agent actor: links the participant (`agentId`), returns the existing one with `alreadyJoined: true` if the agent already owns one (no event); `JoinResult` type gains `alreadyJoined?: boolean`; `createWeave(db, bus, input, actor?)` — with an agent actor: creator participant linked (`agentId`), role `keeper`; restricted creation still requires an instance keeper. Facade: every Weave-scoped operation (`getWeave`, `readEvents`, `createThread`, `setThreadUrl`, `inviteParticipant`, `closeThread`, `postMessage`, `archiveWeave`, `setRole`, `exportWeave`) first maps an agent actor through `resolveInWeave`; `joinWeave(secret, who, actor?)`.

- [ ] **Step 1: Write the failing tests** (append to `src/core/test/agents.test.ts`; import `joinWeave`, `getWeave` from `../src/weaves.js`, `createThread` from `../src/threads.js`, `postMessage` from `../src/messages.js`, `readEvents` from `../src/events.js`, `updateSettings` from `../src/settings.js`, and `createCore` from `../src/index.js`)

```ts
describe("agents inside Weaves", () => {
  it("join links the participant to the agent; a second join returns the same identity without an event", async () => {
    const r = await createWeave(db, new EventBus(), { title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const { key } = await addAgent(db, await keeper(), "ChatGPT");
    const agent = await resolveCredential(db, key);
    const bus = new EventBus();
    const j1 = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" }, agent);
    expect(j1.participant).toMatchObject({ name: "ChatGPT", kind: "agent", agentId: (agent as { agent: { id: string } }).agent.id });
    const before = (await readEvents(db, r.weave.id, {})).length;
    const j2 = await joinWeave(db, bus, r.secret, { name: "Whatever", kind: "agent" }, agent);
    expect(j2).toMatchObject({ alreadyJoined: true, participant: { id: j1.participant.id }, token: j1.token });
    expect((await readEvents(db, r.weave.id, {})).length).toBe(before);
    const info = await getWeave(db, await resolveCredential(db, r.token), r.weave.id);
    expect(info.participants.filter((p) => p.agentId !== null)).toHaveLength(1);
  });
  it("through the facade an agent key acts as its participant: read, post, create thread — and cannot act where it has not joined", async () => {
    const core = createCore(db);
    const r = await core.createWeave({ title: "T", opener: "", creator: { name: "P", kind: "human" } });
    const other = await core.createWeave({ title: "Other", opener: "", creator: { name: "Q", kind: "human" } });
    const { key } = await core.addAgent(await keeper(), "Bot");
    const agent = await core.resolveCredential(key);
    await expect(core.readEvents(agent, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    await core.joinWeave(r.secret, { name: "Bot", kind: "agent" }, agent);
    expect((await core.readEvents(agent, r.weave.id, {})).length).toBeGreaterThan(0);
    const msg = await core.postMessage(agent, r.generalThread.id, "hello from the key");
    expect(msg.type).toBe("message");
    const t = await core.createThread(agent, r.weave.id, "By bot", "https://e.com");
    expect(t.url).toBe("https://e.com");
    await expect(core.readEvents(agent, other.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(core.readSettings(agent)).rejects.toMatchObject({ code: "forbidden" });  // never an instance keeper
  });
  it("create_weave with an agent key links the creator (Weave keeper) so the key alone can read and write; restricted creation still refuses it", async () => {
    const core = createCore(db);
    const { key } = await core.addAgent(await keeper(), "Bot");
    const agent = await core.resolveCredential(key);
    const r = await core.createWeave({ title: "Mine", opener: "start", creator: { name: "Bot", kind: "agent" } }, agent);
    expect(r.participant).toMatchObject({ role: "keeper", agentId: (agent as { agent: { id: string } }).agent.id });
    await core.postMessage(agent, r.generalThread.id, "written with the key only");
    expect((await core.getWeave(agent, r.weave.id)).weave.title).toBe("Mine");
    await core.updateSettings(await keeper(), { openWeaveCreation: false });
    await expect(core.createWeave({ title: "Nope", opener: "", creator: { name: "Bot", kind: "agent" } }, agent)).rejects.toMatchObject({ code: "forbidden" });
    const byKeeper = await core.createWeave({ title: "Ok", opener: "", creator: { name: "K", kind: "human" } }, await keeper());
    expect(byKeeper.participant.agentId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/core && npx vitest run test/agents.test.ts`
Expected: FAIL (`joinWeave` ignores the 5th argument, `agentId` is undefined, and the facade does not yet map agent actors).

- [ ] **Step 3: `PublicParticipant.agentId`** — `src/core/src/types.ts`:

```ts
export type PublicParticipant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null;
};
```

and `toPublicParticipant` in `actors.ts` adds `agentId: p.agentId ?? null`.

- [ ] **Step 4: `joinWeave` and `createWeave` in `src/core/src/weaves.ts`**

```ts
export type JoinResult = {
  weaveId: string; weave: PublicWeave; generalThreadId: string; participant: PublicParticipant; token: string; alreadyJoined?: boolean;
};

export async function joinWeave(db: Db, bus: EventBus, secret: string, who: { name: string; kind: Kind }, actor?: Actor): Promise<JoinResult> {
  const name = validateName(who.name);
  if (who.kind !== "human" && who.kind !== "agent") throw errors.validation("kind must be human or agent");
  const [found] = await db.select().from(weaves).where(eq(weaves.secret, secret));
  if (!found) throw errors.weaveNotFound();
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, found.id)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  const agentId = actor?.kind === "agent" ? actor.agent.id : null;
  if (agentId) {
    // An agent owns at most one participant per Weave: joining again is a lookup, not a new identity.
    const [mine] = await db.select().from(participants).where(and(eq(participants.agentId, agentId), eq(participants.weaveId, found.id))).limit(1);
    if (mine) return { weaveId: found.id, weave: toPublicWeave(found), generalThreadId: general.id, participant: toPublicParticipant(mine), token: mine.token, alreadyJoined: true };
  }
  const token = newSecret();
  const participantId = newId();
  try {
    const participant = await withWeaveLock(db, bus, found.id, async (tx, weave) => {
      if (weave.archivedAt) throw errors.weaveArchived();
      const [p] = await tx.insert(participants).values({ id: participantId, weaveId: weave.id, name, kind: agentId ? "agent" : who.kind, role: "member", token, agentId }).returning();
      const pub = toPublicParticipant(p!);
      return { result: pub, events: [{ threadId: general.id, type: "participant.joined" as const, actor: participantId,
        payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } }] };
    });
    return { weaveId: found.id, weave: toPublicWeave(found), generalThreadId: general.id, participant, token };
  } catch (e) {
    if (isNameTakenViolation(e)) throw errors.nameTaken(name);
    throw e;
  }
}
```

(import `and` from drizzle-orm.) In `createWeave`, after the restricted-creation check:

```ts
  const settings = await getSettings(db);
  if (!settings.openWeaveCreation) {
    if (!actor || actor.kind === "agent") throw errors.forbidden("Weave creation is restricted to keepers");
    await assertInstanceKeeperFresh(db, actor);
  }
  const agentId = actor?.kind === "agent" ? actor.agent.id : null;
```

and pass `agentId` into the participant insert: `{ id: participantId, weaveId, name, kind: agentId ? "agent" : input.creator.kind, role: "keeper", token, agentId }`.

- [ ] **Step 5: Facade wiring** — `src/core/src/index.ts`. Wrap every Weave-scoped method:

```ts
    getWeave: async (actor: Actor, weaveId: string) => weaves.getWeave(db, await resolveInWeave(db, actor, weaveId), weaveId),
    joinWeave: (secret: string, who: { name: string; kind: Kind }, actor?: Actor) => weaves.joinWeave(db, bus, secret, who, actor),
    archiveWeave: async (actor: Actor, weaveId: string) => weaves.archiveWeave(db, bus, await resolveInWeave(db, actor, weaveId), weaveId),
    readEvents: async (actor: Actor, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) => {
      const a = await resolveInWeave(db, actor, weaveId);
      assertCanRead(a, weaveId);
      if (!isUuid(weaveId)) throw errors.weaveNotFound();
      const [w] = await db.select({ id: weavesTable.id }).from(weavesTable).where(eq(weavesTable.id, weaveId)).limit(1);
      if (!w) throw errors.weaveNotFound();
      return readEvents(db, weaveId, opts);
    },
    createThread: async (actor: Actor, weaveId: string, name: string, url?: string | null) => threads.createThread(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, name, url),
    setThreadUrl: async (actor: Actor, threadId: string, url: string | null) => threads.setThreadUrl(db, bus, await forThread(actor, threadId), threadId, url),
    inviteParticipant: async (actor: Actor, threadId: string, participantId: string) => inviteParticipant(db, bus, await forThread(actor, threadId), threadId, participantId),
    closeThread: async (actor: Actor, threadId: string) => threads.closeThread(db, bus, await forThread(actor, threadId), threadId),
    postMessage: async (actor: Actor, threadId: string, text: string) => postMessage(db, bus, await forThread(actor, threadId), threadId, text),
    setRole: async (actor: Actor, weaveId: string, participantId: string, role: Role) => setRole(db, bus, await resolveInWeave(db, actor, weaveId), weaveId, participantId, role),
    exportWeave: async (actor: Actor, weaveId: string, format: "md" | "json") => exportWeave(db, await resolveInWeave(db, actor, weaveId), weaveId, format),
```

with a helper above the returned object:

```ts
  /** Thread-addressed operations: map an agent actor through the Thread's Weave. */
  const forThread = async (actor: Actor, threadId: string) =>
    actor.kind === "agent" ? resolveInWeave(db, actor, (await threads.getThread(db, threadId)).weaveId) : actor;
```

`listWeaves`, `readSettings`, `updateSettings`, keeper and agent admin functions are instance-level and unchanged: an agent actor reaches `assertInstanceKeeperFresh` and gets `forbidden`. Export the `JoinResult` type from `index.ts` (`export type { CreateWeaveInput, CreateWeaveResult, WeaveInfo, JoinResult } from "./weaves.js";`).

- [ ] **Step 6: Run the tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: PASS. If a `toEqual` on a participant object fails elsewhere, add `agentId: null` to that expectation.

- [ ] **Step 7: Commit**

```bash
git add src/core && git commit -m "feat(core): agent keys act as their participant; linked join/create; facade maps agents per Weave

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Inbox — events addressed to me

**Files:**
- Create: `src/core/src/inbox.ts`, `src/core/test/inbox.test.ts`
- Modify: `src/core/src/index.ts`

**Interfaces:**
- Produces: `inbox(db, actor, weaveId, opts: { since?: number; limit?: number }): Promise<LoomEvent[]>` — `thread.invited` with `payload.participantId === me` and `message` events whose `payload.mentions` includes me, excluding events whose `actor === me`, seq order, `limit` default 100 max 1000. Requires a participant actor of the Weave (`forbidden` for secret/keeper/agent-without-participant). Facade: `inbox(actor, weaveId, opts)` (agent mapped via `resolveInWeave`).

- [ ] **Step 1: Write the failing tests** — `src/core/test/inbox.test.ts`

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { inviteParticipant } from "../src/invites.js";
import { postMessage } from "../src/messages.js";
import { inbox } from "../src/inbox.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

describe("inbox", () => {
  it("returns only invites to me and messages mentioning me, in seq order, never my own events", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const paw = await resolveCredential(db, r.token);
    const b = await joinWeave(db, bus, r.secret, { name: "Bot", kind: "agent" });
    const bot = await resolveCredential(db, b.token);
    const o = await joinWeave(db, bus, r.secret, { name: "Other", kind: "agent" });
    const t = await createThread(db, bus, paw, r.weave.id, "PR 1", "https://e.com/1");
    const inv = await inviteParticipant(db, bus, paw, t.id, b.participant.id);
    await inviteParticipant(db, bus, paw, t.id, o.participant.id);                 // someone else's invite
    const m1 = await postMessage(db, bus, paw, t.id, "@Bot please review");
    await postMessage(db, bus, paw, t.id, "@Other you too");                       // not for me
    await postMessage(db, bus, bot, t.id, "@Paw on it");                           // my own message (mentions Paw, not me)
    const m2 = await postMessage(db, bus, paw, r.generalThread.id, "ping @Bot again");
    const mine = await inbox(db, bot, r.weave.id, {});
    expect(mine.map((e) => [e.type, e.seq])).toEqual([["thread.invited", inv.seq], ["message", m1.seq], ["message", m2.seq]]);
    const later = await inbox(db, bot, r.weave.id, { since: m1.seq });
    expect(later.map((e) => e.seq)).toEqual([m2.seq]);
    const one = await inbox(db, bot, r.weave.id, { limit: 1 });
    expect(one.map((e) => e.seq)).toEqual([inv.seq]);
  });
  it("needs a participant credential of that Weave", async () => {
    const r = await createWeave(db, bus, { title: "T", opener: "", creator: { name: "Paw", kind: "human" } });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(inbox(db, bySecret, r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, { title: "O", opener: "", creator: { name: "Q", kind: "human" } });
    await expect(inbox(db, await resolveCredential(db, other.token), r.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/core && npx vitest run test/inbox.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/core/src/inbox.ts`**

```ts
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events } from "./db/schema.js";
import { errors } from "./errors.js";
import { isUuid } from "./ids.js";
import { assertParticipantOf } from "./actors.js";
import type { Actor, EventType, LoomEvent } from "./types.js";

/**
 * What is addressed to the acting participant: invites naming it and messages mentioning it,
 * excluding its own events. Pure read with an explicit `since`: remote agents with no local state
 * pass the last seq they saw (or nothing, for the most recent items).
 */
export async function inbox(db: Db, actor: Actor, weaveId: string, opts: { since?: number; limit?: number }): Promise<LoomEvent[]> {
  if (!isUuid(weaveId)) throw errors.weaveNotFound();
  const me = assertParticipantOf(actor, weaveId);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const conds = [
    eq(events.weaveId, weaveId),
    ne(events.actor, me.id),
    or(
      and(eq(events.type, "thread.invited"), sql`${events.payload}->>'participantId' = ${me.id}`),
      and(eq(events.type, "message"), sql`${events.payload}->'mentions' ? ${me.id}`),
    ),
  ];
  if (opts.since !== undefined) conds.push(gt(events.seq, opts.since));
  const rows = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit);
  return rows.map((r) => ({
    weaveId: r.weaveId, seq: r.seq, threadId: r.threadId, type: r.type as EventType,
    actor: r.actor, at: r.at.toISOString(), payload: r.payload as Record<string, unknown>,
  }));
}
```

(`payload->'mentions' ? 'id'` is the Postgres jsonb "array contains string" operator; mentions are stored as a JSON array of participant ids.)

- [ ] **Step 4: Facade** — `src/core/src/index.ts`: `import { inbox } from "./inbox.js";` and

```ts
    inbox: async (actor: Actor, weaveId: string, opts: { since?: number; limit?: number }) => inbox(db, await resolveInWeave(db, actor, weaveId), weaveId, opts),
```

- [ ] **Step 5: Run the tests**

Run: `cd src/core && pnpm build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core && git commit -m "feat(core): inbox — invites and mentions addressed to the caller

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Shared MCP tools — new tools, `url`, optional credential with a connection default

**Files:**
- Modify: `src/mcp-tools/src/backend.ts`, `src/mcp-tools/src/tools.ts`, `src/mcp-tools/test/tools.test.ts`

**Interfaces:**
- Produces: `LoomToolBackend` gains `createThread(credential, weaveId, name, url?: string | null)`, `setThreadUrl(credential, threadId, url: string | null)`, `inviteParticipant(credential, threadId, participantId)`, `inbox(credential, weaveId, opts: { since?: number; limit?: number })`, `keeperAgentsList(credential)`, `keeperAgentsAdd(credential, name)`, `keeperAgentsRevoke(credential, id)`; `registerLoomTools(server, backend, opts: { credentialHint?: string; defaultCredential?: () => string | undefined; agentName?: string })` — when `defaultCredential()` returns a value, every `credential` argument is optional and falls back to it; `LOOM_TOOL_NAMES` gains `"set_thread_url" | "invite_participant" | "inbox" | "keeper_agents_list" | "keeper_agents_add" | "keeper_agents_revoke"`.

- [ ] **Step 1: Write the failing tests** (append to `src/mcp-tools/test/tools.test.ts`; extend `fake` with the new methods first)

Add to the `fake` object:

```ts
  setThreadUrl: async (_c, threadId, url) => ({ id: threadId, url }),
  inviteParticipant: async (_c, threadId, participantId) => ({ seq: 9, created: true, threadId, participantId }),
  inbox: async (c, weaveId, opts) => [{ type: "thread.invited", weaveId, since: opts.since, credential: c }],
  keeperAgentsList: async () => [{ id: "a1", name: "ChatGPT" }],
  keeperAgentsAdd: async (_c, name) => ({ agent: { name }, key: "a".repeat(43) }),
  keeperAgentsRevoke: async () => {},
```

and change the existing `createThread` fake to `createThread: async (_c, weaveId, name, url) => ({ weaveId, name, url: url ?? null }),`. Then new tests:

```ts
describe("v2 tools", () => {
  it("advertises the new tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["set_thread_url", "invite_participant", "inbox", "keeper_agents_list", "keeper_agents_add", "keeper_agents_revoke"]) expect(names).toContain(n);
    expect([...LOOM_TOOL_NAMES]).toEqual(expect.arrayContaining(names));
  });
  it("create_thread passes url through; set_thread_url accepts null; invite and inbox route their arguments", async () => {
    expect(JSON.parse(text(await client.callTool({ name: "create_thread", arguments: { credential: "c", weaveId: "w1", name: "PR", url: "https://e.com" } })))).toEqual({ weaveId: "w1", name: "PR", url: "https://e.com" });
    expect(JSON.parse(text(await client.callTool({ name: "set_thread_url", arguments: { credential: "c", threadId: "t1", url: null } })))).toEqual({ id: "t1", url: null });
    expect(JSON.parse(text(await client.callTool({ name: "invite_participant", arguments: { credential: "c", threadId: "t1", participantId: "p2" } })))).toMatchObject({ seq: 9, created: true });
    expect(JSON.parse(text(await client.callTool({ name: "inbox", arguments: { credential: "c", weaveId: "w1", since: 4 } })))).toEqual([{ type: "thread.invited", weaveId: "w1", since: 4, credential: "c" }]);
  });
  it("with a connection default, credential is optional and the default is used; an explicit one still wins", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerLoomTools(server, fake, { defaultCredential: () => "agent-key", agentName: "ChatGPT" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c2 = new Client({ name: "t2", version: "0" });
    await c2.connect(b);
    try {
      const r = JSON.parse(text(await c2.callTool({ name: "inbox", arguments: { weaveId: "w1" } })));
      expect(r[0].credential).toBe("agent-key");
      const r2 = JSON.parse(text(await c2.callTool({ name: "inbox", arguments: { weaveId: "w1", credential: "explicit" } })));
      expect(r2[0].credential).toBe("explicit");
      const schema = (await c2.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required ?? []).not.toContain("credential");
    } finally { await c2.close(); }
  });
  it("without a connection default, credential stays required", async () => {
    const schema = (await client.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
    expect(schema.required).toContain("credential");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/mcp-tools && npx vitest run`
Expected: FAIL — type errors on `fake` (extra methods are fine, but `registerLoomTools` options and the tools are missing → tools not advertised).

- [ ] **Step 3: Extend the backend type** — `src/mcp-tools/src/backend.ts`

```ts
  joinWeave(secret: string, who: { name: string; kind: Kind }, credential?: string): Promise<unknown>;   // credential: the connection's agent key, if any
  createThread(credential: string, weaveId: string, name: string, url?: string | null): Promise<unknown>;
  setThreadUrl(credential: string, threadId: string, url: string | null): Promise<unknown>;
  inviteParticipant(credential: string, threadId: string, participantId: string): Promise<unknown>;      // { seq, created }
  inbox(credential: string, weaveId: string, opts: { since?: number; limit?: number }): Promise<unknown[]>;
  keeperAgentsList(credential: string): Promise<unknown[]>;
  keeperAgentsAdd(credential: string, name: string): Promise<unknown>;                                    // { agent, key }
  keeperAgentsRevoke(credential: string, id: string): Promise<void>;
```

- [ ] **Step 4: Tools** — `src/mcp-tools/src/tools.ts`

```ts
export const LOOM_TOOL_NAMES = [
  "create_weave", "join_weave", "lookup_weave", "get_weave", "read_events", "inbox", "post_message", "create_thread",
  "set_thread_url", "invite_participant", "close_thread", "archive_weave", "set_role", "export_weave",
  "keeper_list_weaves", "keeper_get_settings", "keeper_set_settings", "keeper_list", "keeper_add", "keeper_remove",
  "keeper_agents_list", "keeper_agents_add", "keeper_agents_revoke",
] as const;

export type RegisterOptions = {
  credentialHint?: string;
  /** When set (a connection authenticated with an agent key), `credential` becomes optional on every tool and defaults to this. */
  defaultCredential?: () => string | undefined;
  agentName?: string;
};

export function registerLoomTools(server: McpServer, backend: LoomToolBackend, opts: RegisterOptions = {}): void {
  const defaultCred = opts.defaultCredential;
  const hint = opts.credentialHint ??
    (defaultCred
      ? `Optional: defaults to this connection's agent${opts.agentName ? ` (${opts.agentName})` : ""}. Pass a participant token, keeper token or Weave secret to act as someone else.`
      : "Your Loom credential for this Weave: the participant token returned by create_weave/join_weave (keep it for the whole session), a keeper token, or the Weave secret for read-only access.");
  // With a connection default the schema marks `credential` optional; the resolver fills it in.
  const cred = (h: string) => (defaultCred ? z.string().min(1).optional().describe(h) : z.string().min(1).describe(h));
  const resolve = (c: string | undefined): string => {
    const v = c ?? defaultCred?.();
    if (!v) throw new LoomToolError("invalid_token", "credential is required on this connection");
    return v;
  };
```

`join_weave` passes the connection default so an agent connection links its participant: `({ secret, name, kind }) => toToolResult(backend.joinWeave(secret, { name, kind }, defaultCred?.()))`. Every existing handler that received `credential` now calls `resolve(credential)` first, e.g. `({ credential, weaveId }) => toToolResult(backend.getWeave(resolve(credential), weaveId))` — wrap the body in `toToolResult(Promise.resolve().then(() => backend.getWeave(resolve(credential), weaveId)))` so a thrown `LoomToolError` from `resolve` becomes a `{code,message}` tool error rather than an exception (do this for all credential-taking tools). `join_weave` and `create_weave` keep their shapes (`create_weave`'s optional `credential` also falls back to `defaultCred?.()`). New tools:

```ts
  server.registerTool("create_thread", {
    description: "Create a new thread in the Weave (for a sub-topic or an artefact such as a pull request). Optional url: the artefact the thread is about; it is shown to everyone and sent with every event from the thread.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), name: z.string().min(1).max(100), url: z.string().url().max(2000).optional() },
  }, ({ credential, weaveId, name, url }) => toToolResult(Promise.resolve().then(() => backend.createThread(resolve(credential), weaveId, name, url ?? null))));

  server.registerTool("set_thread_url", {
    description: "Set or clear (null) the artefact URL of a thread. Thread creator or Weave keeper only.",
    inputSchema: { credential: cred(hint), threadId: z.string(), url: z.string().url().max(2000).nullable() },
  }, ({ credential, threadId, url }) => toToolResult(Promise.resolve().then(() => backend.setThreadUrl(resolve(credential), threadId, url))));

  server.registerTool("invite_participant", {
    description: "Invite a participant of the Weave into a thread: a targeted 'your input is wanted here'. Thread creator or Weave keeper only. Idempotent (re-inviting returns the original event's seq). Channel-connected agents are woken by an invite even in mentions-only mode.",
    inputSchema: { credential: cred(hint), threadId: z.string(), participantId: z.string() },
  }, ({ credential, threadId, participantId }) => toToolResult(Promise.resolve().then(() => backend.inviteParticipant(resolve(credential), threadId, participantId))));

  server.registerTool("inbox", {
    description: "What is addressed to you in this Weave: invites naming you and messages that @mention you, in seq order, excluding your own. Call this first on every turn when you have no push connection, passing since = the last seq you saw; then read_events(threadId) for context and post_message to reply.",
    inputSchema: { credential: cred(hint), weaveId: z.string(), since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, ({ credential, weaveId, since, limit }) => toToolResult(Promise.resolve().then(() => backend.inbox(resolve(credential), weaveId, { since, limit }))));

  server.registerTool("keeper_agents_list", { description: "List agent keys (instance keepers only): remote MCP identities that authenticate with ?agent=<key>.", inputSchema: { credential: cred(keeper) } },
    ({ credential }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsList(resolve(credential)))));
  server.registerTool("keeper_agents_add", { description: "Mint an agent key for a remote MCP client (instance keepers only). Returns the agent and its key — shown once.", inputSchema: { credential: cred(keeper), name: z.string().min(1).max(32) } },
    ({ credential, name }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsAdd(resolve(credential), name))));
  server.registerTool("keeper_agents_revoke", { description: "Revoke an agent key (instance keepers only). Its participants and history stay.", inputSchema: { credential: cred(keeper), id: z.string() } },
    ({ credential, id }) => toToolResult(Promise.resolve().then(() => backend.keeperAgentsRevoke(resolve(credential), id))));
```

(`z.string().url()` in zod 4 is `z.url()`; use `z.url().max(2000)` if `z.string().url()` is flagged deprecated.) Import `LoomToolError` from `./backend.js`.

- [ ] **Step 5: Run the tests**

Run: `cd src/mcp-tools && pnpm build && npx vitest run`
Expected: PASS. Then `pnpm -r typecheck`: the server's `CoreToolBackend` and the channel's backends will now fail to typecheck (missing methods) — expected; Task 8 and Task 11 fix them. Do not commit a broken typecheck for long: proceed straight to Task 8.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-tools && git commit -m "feat(mcp-tools): invite, thread url, inbox, agent-key tools; optional credential with connection default

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Server — agent auth, REST routes, MCP connection agent

**Files:**
- Create: `src/server/src/routes/agents.ts`
- Modify: `src/server/src/auth.ts`, `src/server/src/routes/threads.ts`, `src/server/src/routes/weaves.ts`, `src/server/src/app.ts`, `src/server/src/mcp/index.ts`, `src/server/src/mcp/backend.ts`
- Test: `src/server/test/routes.test.ts`, `src/server/test/mcp.test.ts`

**Interfaces:**
- Produces REST: `POST /api/weaves/:id/threads { name, url? }`; `PUT /api/threads/:id/url { url }` → thread; `POST /api/threads/:id/invites { participantId }` → `{ seq, created }` (201 created / 200 existing); `GET /api/weaves/:id/inbox?since&limit` → `{ events }`; `GET/POST /api/admin/agents`, `DELETE /api/admin/agents/:id`. MCP: `/mcp?agent=<key>` or Bearer agent key → connection default credential; `CoreToolBackend` implements the new methods.

- [ ] **Step 1: Write the failing REST tests** (append to `src/server/test/routes.test.ts`, using its existing `s`, `api`, `keeperToken` helpers)

```ts
describe("v2: threads url, invites, inbox, agents", () => {
  it("thread url and invites over REST", async () => {
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    const j = (await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "Bot", kind: "agent" })).json;
    const t = await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/threads`, { name: "PR 1", url: "https://e.com/1" }, r.token);
    expect(t.status).toBe(201); expect(t.json.url).toBe("https://e.com/1");
    const bad = await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/threads`, { name: "X", url: "ftp://no" }, r.token);
    expect(bad.status).toBe(400);
    const set = await api(s.baseUrl, "PUT", `/api/threads/${t.json.id}/url`, { url: null }, r.token);
    expect(set.status).toBe(200); expect(set.json.url).toBeNull();
    const inv = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: j.participant.id }, r.token);
    expect(inv.status).toBe(201); expect(inv.json).toMatchObject({ created: true });
    const again = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: j.participant.id }, r.token);
    expect(again.status).toBe(200); expect(again.json).toEqual({ seq: inv.json.seq, created: false });
    const denied = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: r.participant.id }, j.token);
    expect(denied.status).toBe(403);
    const inbox = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/inbox`, undefined, j.token);
    expect(inbox.status).toBe(200);
    expect(inbox.json.events.map((e: { type: string }) => e.type)).toEqual(["thread.invited"]);
    const since = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/inbox?since=${inv.json.seq}`, undefined, j.token);
    expect(since.json.events).toEqual([]);
  });
  it("agent keys: keeper mints, key authenticates as Bearer, joins linked, is revocable", async () => {
    await s.core.seedKeepers([keeperToken("k1")]);
    const add = await api(s.baseUrl, "POST", "/api/admin/agents", { name: "ChatGPT" }, keeperToken("k1"));
    expect(add.status).toBe(201); expect(add.json.key).toHaveLength(43);
    const list = await api(s.baseUrl, "GET", "/api/admin/agents", undefined, keeperToken("k1"));
    expect(list.json.agents.map((a: { name: string }) => a.name)).toEqual(["ChatGPT"]);
    expect(JSON.stringify(list.json)).not.toContain(add.json.key);
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    const j = await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "ChatGPT", kind: "agent" }, add.json.key);
    expect(j.status).toBe(201); expect(j.json.participant.agentId).toBe(add.json.agent.id);
    const ev = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/events`, undefined, add.json.key);
    expect(ev.status).toBe(200);
    const ticket = await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, add.json.key);
    expect(ticket.status).toBe(200);
    const denied = await api(s.baseUrl, "GET", "/api/admin/settings", undefined, add.json.key);
    expect(denied.status).toBe(403);
    const rev = await api(s.baseUrl, "DELETE", `/api/admin/agents/${add.json.agent.id}`, undefined, keeperToken("k1"));
    expect(rev.status).toBe(204);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/events`, undefined, add.json.key)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Write the failing MCP tests** (append to `src/server/test/mcp.test.ts`)

```ts
describe("remote MCP with an agent key", () => {
  async function agentClient(key: string, via: "query" | "bearer") {
    const c = new Client({ name: "chatgpt-like", version: "1.0" });
    const url = new URL(`${s!.baseUrl}/mcp`);
    if (via === "query") url.searchParams.set("agent", key);
    const transport = via === "bearer"
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } })
      : new StreamableHTTPClientTransport(url);
    await c.connect(transport);
    return c;
  }
  it("?agent= makes credential optional and defaults to the agent; create → read/write with the key alone; explicit credential still wins", async () => {
    const { key } = await s!.core.addAgent(await s!.core.resolveCredential(keeperToken("k1")), "ChatGPT");
    const c = await agentClient(key, "query");
    try {
      const schema = (await c.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required ?? []).not.toContain("credential");
      expect(c.getInstructions()).toMatch(/connected as agent ChatGPT/);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "Mine", opener: "start", name: "ChatGPT" } }));
      expect(created.participant.agentId).toBeDefined();
      const posted = json(await c.callTool({ name: "post_message", arguments: { threadId: created.generalThread.id, text: "key only" } }));
      expect(posted.type).toBe("message");
      const inbox = json(await c.callTool({ name: "inbox", arguments: { weaveId: created.weave.id } }));
      expect(inbox).toEqual([]);
      const other = await s!.core.createWeave({ title: "O", opener: "", creator: { name: "Q", kind: "human" } });
      const explicit = json(await c.callTool({ name: "get_weave", arguments: { weaveId: other.weave.id, credential: other.token } }));
      expect(explicit.weave.id).toBe(other.weave.id);
      const denied = await c.callTool({ name: "get_weave", arguments: { weaveId: other.weave.id } });
      expect(denied.isError).toBe(true); expect(json(denied).code).toBe("forbidden");
    } finally { await c.close(); }
  });
  it("Bearer agent key works too; a revoked key fails every tool with invalid_token", async () => {
    const keeper = await s!.core.resolveCredential(keeperToken("k1"));
    const { agent, key } = await s!.core.addAgent(keeper, "Bot");
    const c = await agentClient(key, "bearer");
    try {
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "B", opener: "", name: "Bot" } }));
      await s!.core.revokeAgent(keeper, agent.id);
      const r = await c.callTool({ name: "get_weave", arguments: { weaveId: created.weave.id } });
      expect(r.isError).toBe(true); expect(json(r).code).toBe("invalid_token");
    } finally { await c.close(); }
  });
  it("without an agent, credential stays required and there is no agent line in the instructions", async () => {
    await withClient(async (c) => {
      const schema = (await c.listTools()).tools.find((t) => t.name === "get_weave")!.inputSchema as { required?: string[] };
      expect(schema.required).toContain("credential");
      expect(c.getInstructions()).not.toMatch(/connected as agent/);
    });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd src/server && npx vitest run test/routes.test.ts test/mcp.test.ts`
Expected: FAIL (404s on new routes, credential required, no agent instructions).

- [ ] **Step 4: Auth — accept `?agent=` for `/mcp` only** — `src/server/src/auth.ts`

```ts
export const bearer: MiddlewareHandler<Env> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  let cred = m ? m[1]!.trim() : null;
  // Remote MCP connectors often accept only a URL: the agent key may ride in ?agent= on /mcp.
  if (!cred && new URL(c.req.url).pathname === "/mcp") cred = c.req.query("agent")?.trim() || null;
  c.set("credential", cred);
  await next();
};
```

- [ ] **Step 5: REST routes**

`src/server/src/routes/weaves.ts`:

```ts
  r.post("/:id/threads", async (c) => {
    const actor = await requireActor(c, core);
    const { name, url } = await body(c, z.object({ name: z.string(), url: z.string().nullable().optional() }));
    return c.json(await core.createThread(actor, c.req.param("id"), name, url ?? null), 201);
  });

  r.get("/:id/inbox", async (c) => {
    const actor = await requireActor(c, core);
    const q = z.object({ since: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).safeParse(c.req.query());
    if (!q.success) throw errors.validation("Invalid query parameters");
    return c.json({ events: await core.inbox(actor, c.req.param("id"), q.data) });
  });
```

`src/server/src/routes/threads.ts`:

```ts
  r.put("/:id/url", async (c) => {
    const actor = await requireActor(c, core);
    const { url } = await body(c, z.object({ url: z.string().nullable() }));
    return c.json(await core.setThreadUrl(actor, c.req.param("id"), url));
  });

  r.post("/:id/invites", async (c) => {
    const actor = await requireActor(c, core);
    const { participantId } = await body(c, z.object({ participantId: z.string() }));
    const result = await core.inviteParticipant(actor, c.req.param("id"), participantId);
    return c.json(result, result.created ? 201 : 200);
  });
```

New `src/server/src/routes/agents.ts`, mounted in `app.ts` as `app.route("/api/admin/agents", agentRoutes(deps.core));` **before** `adminRoutes` (Hono matches in registration order):

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

export function agentRoutes(core: Core) {
  const r = new Hono<Env>();
  r.get("/", async (c) => c.json({ agents: await core.listAgents(await requireActor(c, core)) }));
  r.post("/", async (c) => {
    const actor = await requireActor(c, core);
    const { name } = await body(c, z.object({ name: z.string() }));
    return c.json(await core.addAgent(actor, name), 201);
  });
  r.delete("/:id", async (c) => {
    await core.revokeAgent(await requireActor(c, core), c.req.param("id"));
    return c.body(null, 204);
  });
  return r;
}
```

- [ ] **Step 6: MCP backend and connection agent**

`src/server/src/mcp/backend.ts` — add:

```ts
  async createThread(c: string, weaveId: string, name: string, url?: string | null) { return this.core.createThread(await this.actor(c), weaveId, name, url ?? null); }
  async setThreadUrl(c: string, threadId: string, url: string | null) { return this.core.setThreadUrl(await this.actor(c), threadId, url); }
  async inviteParticipant(c: string, threadId: string, participantId: string) { return this.core.inviteParticipant(await this.actor(c), threadId, participantId); }
  async inbox(c: string, weaveId: string, opts: { since?: number; limit?: number }) { return this.core.inbox(await this.actor(c), weaveId, opts); }
  async keeperAgentsList(c: string) { return this.core.listAgents(await this.actor(c)); }
  async keeperAgentsAdd(c: string, name: string) { return this.core.addAgent(await this.actor(c), name); }
  async keeperAgentsRevoke(c: string, id: string) { await this.core.revokeAgent(await this.actor(c), id); }
```

and make `joinWeave` credential-aware so an agent connection links its participant:

```ts
  async joinWeave(secret: string, who: { name: string; kind: Kind }, credential?: string) {
    return this.core.joinWeave(secret, who, credential ? await this.actor(credential) : undefined);
  }
```

(The optional third `credential` parameter on `LoomToolBackend.joinWeave` and the `defaultCred?.()` pass-through in `join_weave` were added in Task 7.)

`src/server/src/mcp/index.ts` — build the server per connection with the agent resolved from the credential the middleware extracted:

```ts
export function buildMcpServer(core: Core, agent?: { credential: string; name: string }): McpServer {
  const instructions = agent
    ? `${MCP_INSTRUCTIONS}\nYou are connected as agent ${agent.name}: every tool's credential defaults to you. Start each turn with inbox(weaveId, since = last seq you saw) to find invites and mentions addressed to you; a thread's url is the artefact it is about (for example a pull request) — fetch it for details. join_weave a Weave once; joining again returns your existing identity.`
    : MCP_INSTRUCTIONS;
  const server = new McpServer({ name: "loom", version: "0.2.0" }, { instructions });
  registerLoomTools(server, new CoreToolBackend(core), agent ? { defaultCredential: () => agent.credential, agentName: agent.name } : {});
  return server;
}
```

In the `/mcp` handler, before `buildMcpServer(core)` for a fresh session:

```ts
    const credential = c.get("credential");
    let agent: { credential: string; name: string } | undefined;
    if (credential) {
      const actor = await core.resolveCredential(credential);   // throws invalid_token → 401 via onError
      if (actor.kind === "agent") agent = { credential, name: actor.agent.name };
    }
    const server = buildMcpServer(core, agent);
```

Revocation is enforced because every tool call re-resolves the credential in `CoreToolBackend.actor()`; a revoked key yields `invalid_token` from `resolveCredential`.

- [ ] **Step 7: Run everything**

Run: `cd src/server && pnpm build && npx vitest run`
Expected: PASS. Then `pnpm -r typecheck` — the channel package still fails (Task 11 fixes it); server, core, mcp-tools clean.

- [ ] **Step 8: Commit**

```bash
git add src/server src/mcp-tools && git commit -m "feat(server): thread url, invites, inbox, agent keys over REST and remote MCP (connection agent)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Client library — types and wrappers

**Files:**
- Modify: `src/client/src/types.ts`, `src/client/src/client.ts`
- Test: `src/client/test/client.test.ts`

**Interfaces:**
- Produces: `Thread.url: string | null`; `Participant.agentId: string | null`; `EventType` + `"thread.invited" | "thread.url_changed"`; `JoinResult.alreadyJoined?: boolean`; `Agent = { id; name; createdAt; revokedAt: string | null }`; `LoomClient.createThread(weaveId, name, url?: string | null)`, `setThreadUrl(threadId, url: string | null): Promise<Thread>`, `inviteParticipant(threadId, participantId): Promise<{ seq: number; created: boolean }>`, `inbox(weaveId, opts?: { since?: number; limit?: number }): Promise<LoomEvent[]>`, `admin.listAgents()`, `admin.addAgent(name): Promise<{ agent: Agent; key: string }>`, `admin.revokeAgent(id)`.

- [ ] **Step 1: Write the failing test** (append to `src/client/test/client.test.ts`, which already has `s`, `anon`, `keeperToken`-style helpers — mirror the file's existing setup)

```ts
describe("v2 client wrappers", () => {
  it("thread url, invite, inbox and agent admin round-trip", async () => {
    await s!.core.seedKeepers([keeperToken("k1")]);
    const r = await anon.createWeave({ title: "T", opener: "o", creator: { name: "Paw", kind: "human" } });
    const me = anon.withToken(r.token);
    const j = await anon.joinWeave(r.secret, { name: "Bot", kind: "agent" });
    const t = await me.createThread(r.weave.id, "PR", "https://e.com/pr");
    expect(t.url).toBe("https://e.com/pr");
    expect((await me.setThreadUrl(t.id, null)).url).toBeNull();
    const inv = await me.inviteParticipant(t.id, j.participant.id);
    expect(inv.created).toBe(true);
    expect((await me.inviteParticipant(t.id, j.participant.id))).toEqual({ seq: inv.seq, created: false });
    const box = await anon.withToken(j.token).inbox(r.weave.id);
    expect(box.map((e) => e.type)).toEqual(["thread.invited"]);
    expect(await anon.withToken(j.token).inbox(r.weave.id, { since: inv.seq })).toEqual([]);
    const k = anon.withToken(keeperToken("k1"));
    const added = await k.admin.addAgent("ChatGPT");
    expect(added.key).toHaveLength(43);
    expect((await k.admin.listAgents()).map((a) => a.name)).toEqual(["ChatGPT"]);
    const viaKey = await anon.withToken(added.key).joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    expect(viaKey.participant.agentId).toBe(added.agent.id);
    expect((await anon.withToken(added.key).joinWeave(r.secret, { name: "ChatGPT", kind: "agent" })).alreadyJoined).toBe(true);
    await k.admin.revokeAgent(added.agent.id);
    await expect(anon.withToken(added.key).getWeave(r.weave.id)).rejects.toMatchObject({ code: "invalid_token" });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/client && npx vitest run test/client.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Types** — `src/client/src/types.ts`

```ts
export type Thread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null; url: string | null;
};
export type Participant = { id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string; agentId: string | null };
export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "thread.invited" | "thread.url_changed" | "weave.archived";
export type JoinResult = { weaveId: string; weave: Weave; generalThreadId: string; participant: Participant; token: string; alreadyJoined?: boolean };
export type Agent = { id: string; name: string; createdAt: string; revokedAt: string | null };
export type InviteResult = { seq: number; created: boolean };
```

- [ ] **Step 4: Wrappers** — `src/client/src/client.ts`

```ts
  createThread(weaveId: string, name: string, url?: string | null): Promise<Thread> {
    return this.call("POST", `/api/weaves/${weaveId}/threads`, url === undefined ? { name } : { name, url });
  }
  setThreadUrl(threadId: string, url: string | null): Promise<Thread> {
    return this.call("PUT", `/api/threads/${threadId}/url`, { url });
  }
  inviteParticipant(threadId: string, participantId: string): Promise<InviteResult> {
    return this.call("POST", `/api/threads/${threadId}/invites`, { participantId });
  }
  async inbox(weaveId: string, opts: { since?: number; limit?: number } = {}): Promise<LoomEvent[]> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call<{ events: LoomEvent[] }>("GET", `/api/weaves/${weaveId}/inbox${qs ? `?${qs}` : ""}`);
    return r.events;
  }
  // inside `admin`:
    listAgents: async (): Promise<Agent[]> => (await this.call<{ agents: Agent[] }>("GET", "/api/admin/agents")).agents,
    addAgent: (name: string): Promise<{ agent: Agent; key: string }> => this.call("POST", "/api/admin/agents", { name }),
    revokeAgent: (id: string): Promise<void> => this.call("DELETE", `/api/admin/agents/${id}`),
```

Export `Agent`, `InviteResult` from `src/client/src/index.ts` alongside the other types.

- [ ] **Step 5: Run the tests**

Run: `cd src/client && pnpm build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client && git commit -m "feat(client): thread url, invites, inbox, agent admin wrappers and types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: CLI — thread url, invite, inbox, agents, `LOOM_AGENT_KEY`

**Files:**
- Create: `src/cli/src/commands/invite.ts`
- Modify: `src/cli/src/commands/thread.ts`, `src/cli/src/commands/admin.ts`, `src/cli/src/context.ts`, `src/cli/src/cli.ts`
- Test: `src/cli/test/cli-more.test.ts`

**Interfaces:**
- Produces commands: `loom thread new <name> [--url <url>]`, `loom thread url <threadId> <url|->`, `loom invite <threadId> <participantId>`, `loom inbox [--since <n>] [--limit <n>]`, `loom admin agents list|add <name>|revoke <id>`. `LOOM_AGENT_KEY`: when set, `resolveWeave()` returns `{ weaveId, entry: { token: <key>, … } }` for `--weave <id>` (or the last weave) even without a stored entry, so Weave-scoped commands use the key.

- [ ] **Step 1: Write the failing tests** (append to `src/cli/test/cli-more.test.ts`; it has `run(args, env)`, `s`, `keeperToken`)

```ts
describe("v2: thread url, invite, inbox, agents", () => {
  it("thread new --url, thread url, invite, inbox", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Paw", "--kind", "human", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const bot = (await run(["join", created.secret, "--name", "Bot", "--json"], { LOOM_CONFIG: cfg2 })).json();
    const t = await run(["thread", "new", "PR 1", "--url", "https://e.com/1", "--json"]);
    expect(t.code).toBe(0); expect(t.json().url).toBe("https://e.com/1");
    const cleared = await run(["thread", "url", t.json().id, "-", "--json"]);
    expect(cleared.code).toBe(0); expect(cleared.json().url).toBeNull();
    const inv = await run(["invite", t.json().id, bot.participant.id, "--json"]);
    expect(inv.code).toBe(0); expect(inv.json().created).toBe(true);
    const human = await run(["invite", t.json().id, bot.participant.id]);
    expect(human.out).toMatch(/already invited/i);
    const box = await run(["inbox", "--json"], { LOOM_CONFIG: cfg2 });
    expect(box.code).toBe(0); expect(box.json().events.map((e: { type: string }) => e.type)).toEqual(["thread.invited"]);
    const boxHuman = await run(["inbox"], { LOOM_CONFIG: cfg2 });
    expect(boxHuman.out).toContain("invited");
    const denied = await run(["invite", t.json().id, created.participant.id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(denied.code).toBe(1); expect(JSON.parse(denied.err).code).toBe("forbidden");
  });
  it("admin agents and LOOM_AGENT_KEY", async () => {
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };
    const add = await run(["admin", "agents", "add", "ChatGPT", "--json"], K);
    expect(add.code).toBe(0); expect(add.json().key).toHaveLength(43);
    const list = await run(["admin", "agents", "list"], K);
    expect(list.out).toContain("ChatGPT"); expect(list.out).not.toContain(add.json().key);
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Paw", "--json"])).json();
    const emptyCfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const A = { LOOM_CONFIG: emptyCfg, LOOM_AGENT_KEY: add.json().key };
    const joined = await run(["join", created.secret, "--name", "ChatGPT", "--json"], A);
    expect(joined.code).toBe(0); expect(joined.json().participant.agentId).toBe(add.json().agent.id);
    const posted = await run(["post", "--weave", created.weave.id, "hello", "--json"], { LOOM_CONFIG: path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"), LOOM_AGENT_KEY: add.json().key });
    expect(posted.code).toBe(0); expect(posted.json().payload.text).toBe("hello");
    const rev = await run(["admin", "agents", "revoke", add.json().agent.id, "--json"], K);
    expect(rev.code).toBe(0);
    const after = await run(["post", "--weave", created.weave.id, "again", "--json"], { LOOM_CONFIG: emptyCfg, LOOM_AGENT_KEY: add.json().key });
    expect(after.code).toBe(1); expect(JSON.parse(after.err).code).toBe("invalid_token");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src/cli && npx vitest run test/cli-more.test.ts`
Expected: FAIL (unknown commands → exit 2).

- [ ] **Step 3: Context — agent key** — `src/cli/src/context.ts`, replace `resolveWeave`:

```ts
    resolveWeave: () => {
      const weaveId = opts.weave ?? config.lastWeave;
      if (!weaveId) throw new CliError("no_weave", "No Weave selected: pass --weave <id> or create/join one first");
      const agentKey = io.env.LOOM_AGENT_KEY;
      const entry = config.weaves[weaveId];
      // An agent key is a stable identity across machines: it stands in for a stored participant token.
      if (agentKey) return { weaveId, entry: { ...(entry ?? { title: weaveId, participantId: "", generalThreadId: "", participantName: "" }), token: agentKey } };
      if (!entry) throw new CliError("no_weave", `No stored credentials for Weave ${weaveId}; join it first`);
      return { weaveId, entry };
    },
```

and in `commands/weave.ts` `join`: use `c.client(c.io.env.LOOM_AGENT_KEY).joinWeave(secret, …)` so a key links the participant (the returned token is still stored as today). `post`/`read` need no change: they go through `resolveWeave()`.

- [ ] **Step 4: Commands**

`src/cli/src/commands/thread.ts`:

```ts
  thread.command("new <name>")
    .description("Create a thread")
    .option("--url <url>", "Artefact the thread is about (e.g. a PR link)")
    .action(async (name: string, o: { url?: string }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const t = await c.client(entry.token).createThread(weaveId, name, o.url ?? null);
      emit(c, t, `Created thread "${t.name}" (${t.id})${t.url ? `\n  url: ${t.url}` : ""}`);
    });

  thread.command("url <threadId> <url>")
    .description("Set the thread's artefact URL, or clear it with -")
    .action(async (threadId: string, url: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const t = await c.client(entry.token).setThreadUrl(threadId, url === "-" ? null : url);
      emit(c, t, t.url ? `Thread "${t.name}" now links to ${t.url}` : `Thread "${t.name}" no longer links to an artefact`);
    });
```

New `src/cli/src/commands/invite.ts`:

```ts
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function registerInviteCommands(program: Command, ctx: () => CliContext): void {
  program.command("invite <threadId> <participantId>")
    .description("Invite a participant into a thread (thread creator or keeper)")
    .action(async (threadId: string, participantId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const r = await c.client(entry.token).inviteParticipant(threadId, participantId);
      emit(c, r, r.created ? `Invited ${participantId} to thread ${threadId} (seq ${r.seq})` : `Already invited (seq ${r.seq})`);
    });

  program.command("inbox")
    .description("Invites and mentions addressed to you in the current Weave")
    .option("--since <seq>", "Only events after this seq", (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error("--since must be a non-negative integer"); return n; })
    .option("--limit <n>", "Max events (1-1000)", (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--limit must be 1-1000"); return n; })
    .action(async (o: { since?: number; limit?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      const events = await client.inbox(weaveId, { since: o.since, limit: o.limit });
      const info = await client.getWeave(weaveId);
      const name = (id: string) => info.participants.find((p) => p.id === id)?.name ?? id;
      const thread = (id: string) => info.threads.find((t) => t.id === id)?.name ?? id;
      const lines = events.map((e) => e.type === "thread.invited"
        ? `#${e.seq} [${thread(e.threadId)}] invited by ${name(e.actor)}`
        : `#${e.seq} [${thread(e.threadId)}] ${name(e.actor)}: ${String(e.payload.text ?? "")}`);
      emit(c, { events }, lines.join("\n") || "(nothing addressed to you)");
    });
}
```

Register in `src/cli/src/cli.ts`: `import { registerInviteCommands } from "./commands/invite.js";` and `registerInviteCommands(program, ctx);`.

`src/cli/src/commands/admin.ts` — after the keepers group:

```ts
  const agents = admin.command("agents").description("Manage agent keys (remote MCP identities)");
  agents.command("list").action(async () => {
    const c = ctx();
    const list = await c.keeperClient().admin.listAgents();
    emit(c, { agents: list }, list.map((a) => `${a.id}  ${a.name}${a.revokedAt ? " [revoked]" : ""}`).join("\n") || "(no agents)");
  });
  agents.command("add <name>").action(async (name: string) => {
    const c = ctx();
    const r = await c.keeperClient().admin.addAgent(name);
    emit(c, r, `Added agent "${r.agent.name}" (${r.agent.id})\n  key: ${r.key}\n  connector URL: ${c.baseUrl}/mcp?agent=${r.key}`);
  });
  agents.command("revoke <id>").action(async (id: string) => {
    const c = ctx();
    await c.keeperClient().admin.revokeAgent(id);
    emit(c, { ok: true, id }, `Revoked agent ${id}`);
  });
```

- [ ] **Step 5: Run the tests**

Run: `cd src/cli && pnpm build && npx vitest run`
Expected: PASS (the `--since` parser error surfaces as a commander usage error, exit 2, consistent with the existing numeric-option tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli && git commit -m "feat(cli): thread url, invite, inbox, admin agents, LOOM_AGENT_KEY

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Channel plugin — per-session preferences, invite wake, formatting, tools

**Files:**
- Modify: `src/claude-channel/src/state.ts`, `src/claude-channel/src/format.ts`, `src/claude-channel/src/streams.ts`, `src/claude-channel/src/channel-tools.ts`, `src/claude-channel/src/stored.ts`, `src/claude-channel/src/backend.ts`, `src/claude-channel/src/server.ts`
- Test: `src/claude-channel/test/state.test.ts`, `src/claude-channel/test/format.test.ts`, `src/claude-channel/test/streams.test.ts`, `src/claude-channel/test/channel.test.ts`

**Interfaces:**
- Produces: `Prefs = { wake: Wake; invites: boolean }`; `SessionCursors` gains `prefs?: Record<string, Partial<Prefs>>`; `ChannelState.prefs(weaveId): Prefs` (session pref → legacy `JoinedWeave.wake` → defaults `all`/`true`); `ChannelState.setPrefs(weaveId, patch: Partial<Prefs>): Promise<Prefs>`; `shouldWake(e, { participantId, wake, invites })`; `formatEvent(e, weave, names)` where `Names.threads: Map<string, { name: string; url: string | null }>`, meta gains `thread_url` when set; `StreamManager.setPrefs(weaveId, prefs)`; `set_wake` tool: `{ weaveId, wake?, invites? }`; `list_joined` reports the session's `wake` and `invites`; stored-credential wrapper covers `setThreadUrl`, `inviteParticipant`, `inbox` and keeper agent tools.

- [ ] **Step 1: Failing tests — state prefs** (append to `src/claude-channel/test/state.test.ts`)

```ts
  it("preferences are per session, default all/invites-on, and inherit a legacy machine-wide wake", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-ch-"));
    const a = new ChannelState(dir, "sA");
    await a.upsertWeave("w1", { ...w, wake: "mentions" });           // legacy machine-wide value
    expect(a.prefs("w1")).toEqual({ wake: "mentions", invites: true });
    expect(await a.setPrefs("w1", { invites: false })).toEqual({ wake: "mentions", invites: false });
    await a.setPrefs("w1", { wake: "all" });
    expect(new ChannelState(dir, "sA").prefs("w1")).toEqual({ wake: "all", invites: false });
    expect(new ChannelState(dir, "sB").prefs("w1")).toEqual({ wake: "mentions", invites: true }); // untouched by sA
    expect(new ChannelState(dir, "sB").prefs("unknown")).toEqual({ wake: "all", invites: true });
  });
```

- [ ] **Step 2: Failing tests — wake and format** (append to `src/claude-channel/test/format.test.ts`; adapt the file's existing `ev`/`me` helpers: `me` becomes `{ participantId: "p1", wake, invites }` built per case)

```ts
describe("invites", () => {
  const invite = (to: string, by = "p9") => ev({ type: "thread.invited", actor: by, payload: { threadId: "t1", participantId: to, invitedBy: by } });
  it("an invite to me wakes in both modes unless invites are off", () => {
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: true })).toBe(true);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "mentions", invites: false })).toBe(false);
    expect(shouldWake(invite("p1"), { participantId: "p1", wake: "all", invites: false })).toBe(false);
  });
  it("someone else's invite is an ordinary system event: delivered in all, suppressed in mentions", () => {
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "all", invites: true })).toBe(true);
    expect(shouldWake(invite("p2"), { participantId: "p1", wake: "mentions", invites: true })).toBe(false);
  });
  it("formats invites and url changes, and adds thread_url to every event of a linked thread", () => {
    const names = { threads: new Map([["t1", { name: "PR 12", url: "https://e.com/12" }]]), participants: new Map([["p1", { name: "Me", kind: "agent" }], ["p9", { name: "Paw", kind: "human" }]]) };
    const mine = formatEvent(invite("p1"), { id: "w1", title: "W" }, names, "p1");
    expect(mine.content).toBe('You were invited to Thread "PR 12" by Paw\nhttps://e.com/12');
    expect(mine.meta).toMatchObject({ type: "thread.invited", thread_url: "https://e.com/12", from: "Paw" });
    const theirs = formatEvent(invite("p2"), { id: "w1", title: "W" }, names, "p1");
    expect(theirs.content).toBe('unknown was invited to Thread "PR 12" by Paw');
    const changed = formatEvent(ev({ type: "thread.url_changed", actor: "p9", payload: { threadId: "t1", url: "https://e.com/13" } }), { id: "w1", title: "W" }, names, "p1");
    expect(changed.content).toBe('Thread "PR 12" now links to https://e.com/13');
    const msg = formatEvent(ev({ actor: "p9", payload: { text: "hi" } }), { id: "w1", title: "W" }, names, "p1");
    expect(msg.meta.thread_url).toBe("https://e.com/12");
    const plain = formatEvent(ev({ actor: "p9", threadId: "g1", payload: { text: "hi" } }), { id: "w1", title: "W" }, { ...names, threads: new Map([["g1", { name: "General", url: null }]]) }, "p1");
    expect(plain.meta.thread_url).toBeUndefined();
  });
});
```

(`formatEvent` gains a 4th argument `me: string` — the session's participant id — to phrase "You were invited".)

- [ ] **Step 3: Run to see them fail**

Run: `cd src/claude-channel && npx vitest run test/state.test.ts test/format.test.ts`
Expected: FAIL (`prefs`/`setPrefs` missing; `invites` not honoured; content mismatch).

- [ ] **Step 4: State** — `src/claude-channel/src/state.ts`

```ts
export type Prefs = { wake: Wake; invites: boolean };
export type SessionCursors = { at: string; cursors: Record<string, number>; prefs?: Record<string, Partial<Prefs>> };

  /** This session's effective preferences for a Weave: its own settings, else the legacy
   * machine-wide `wake` (kept for compatibility, no longer written), else all / invites on. */
  prefs(weaveId: string): Prefs {
    const c = this.get();
    const mine = c.sessions[this.sessionId]?.prefs?.[weaveId] ?? {};
    return { wake: mine.wake ?? c.weaves[weaveId]?.wake ?? "all", invites: mine.invites ?? true };
  }

  setPrefs(weaveId: string, patch: Partial<Prefs>): Promise<Prefs> {
    return this.mutate((c) => {
      const s = this.session(c);
      s.prefs ??= {};
      const cur = s.prefs[weaveId] ?? {};
      s.prefs[weaveId] = { ...cur, ...patch };
      const p = s.prefs[weaveId];
      return { wake: p.wake ?? c.weaves[weaveId]?.wake ?? "all", invites: p.invites ?? true };
    });
  }
```

Keep `setWake(id, wake)` for compatibility but implement it as `setPrefs(id, { wake }).then(() => {})`. `removeWeave` also deletes `s.prefs?.[id]` for every session.

- [ ] **Step 5: Format and wake** — `src/claude-channel/src/format.ts`

```ts
export type Names = { threads: Map<string, { name: string; url: string | null }>; participants: Map<string, { name: string; kind: string }> };

export function formatEvent(e: LoomEvent, weave: { id: string; title: string }, names: Names, me: string): { content: string; meta: Record<string, string> } {
  const who = (id: unknown) => (typeof id === "string" && id.startsWith("keeper:")) ? { name: "Keeper", kind: "keeper" } : (names.participants.get(String(id)) ?? { name: "unknown", kind: "unknown" });
  const actor = who(e.actor);
  const thread = names.threads.get(e.threadId) ?? { name: e.threadId, url: null };
  const threadName = thread.name;
  let content: string;
  switch (e.type) {
    case "message": content = String(e.payload.text ?? ""); break;
    case "participant.joined": content = `${who(e.payload.participantId).name === "unknown" ? String(e.payload.name ?? "Someone") : who(e.payload.participantId).name} joined the Weave`; break;
    case "participant.role_changed": content = `${who(e.payload.participantId).name} is now ${String(e.payload.role)}`; break;
    case "thread.created": content = `Thread "${String(e.payload.name ?? threadName)}" created by ${actor.name}${e.payload.url ? `\n${String(e.payload.url)}` : ""}`; break;
    case "thread.closed": content = `Thread "${threadName}" closed by ${actor.name}`; break;
    case "thread.invited": {
      const invitee = String(e.payload.participantId ?? "");
      const url = thread.url ? `\n${thread.url}` : "";
      content = invitee === me ? `You were invited to Thread "${threadName}" by ${actor.name}${url}` : `${who(invitee).name} was invited to Thread "${threadName}" by ${actor.name}`;
      break;
    }
    case "thread.url_changed": content = e.payload.url ? `Thread "${threadName}" now links to ${String(e.payload.url)}` : `Thread "${threadName}" no longer links to an artefact`; break;
    case "weave.archived": content = `Weave archived by ${actor.name}`; break;
    default: content = e.type;
  }
  const meta: Record<string, string> = {
    weave: safe(weave.id), weave_title: safe(weave.title), thread: safe(e.threadId), thread_name: safe(threadName),
    seq: String(e.seq), type: e.type, from: safe(actor.name), from_kind: safe(actor.kind), ts: e.at,
  };
  if (thread.url) meta.thread_url = safe(thread.url);
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  if (mentions.length > 0) meta.mentions = mentions.map(safe).join(",");
  return { content, meta };
}

export function shouldWake(e: LoomEvent, w: { participantId: string; wake: Wake; invites: boolean }): boolean {
  if (e.actor === w.participantId) return false;
  if (e.type === "thread.invited" && e.payload.participantId === w.participantId) return w.invites;
  if (w.wake === "all") return true;
  if (e.type !== "message") return false;
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  return mentions.includes(w.participantId);
}
```

- [ ] **Step 6: Streams** — `src/claude-channel/src/streams.ts`: `Active` gets `prefs: Prefs` instead of `wake`; `start()` seeds `prefs: this.state.prefs(weaveId)`; `refresh()` builds `entry.names.threads = new Map(info.threads.map((t) => [t.id, { name: t.name, url: t.url }]))`; `onEvent` refreshes also on `"thread.url_changed"` and `"thread.invited"` is *not* a refresh trigger; wake check becomes `shouldWake(e, { participantId: entry.participantId, ...entry.prefs })` and `formatEvent(e, { id: weaveId, title: entry.title }, entry.names, entry.participantId)`; replace `setWake` with

```ts
  setPrefs(weaveId: string, prefs: Prefs): void { const a = this.active.get(weaveId); if (a) a.prefs = prefs; }
```

Update the streams test helper `weaveInfo()` threads to include `url: null` and any `sm.setWake(...)` call to `sm.setPrefs(WEAVE_ID, { wake: "mentions", invites: true })`.

- [ ] **Step 7: Tools** — `src/claude-channel/src/channel-tools.ts`

```ts
export type ChannelHooks = { onLeave(weaveId: string): void; onPrefsChanged(weaveId: string, prefs: Prefs): void };

  server.registerTool("list_joined", {
    description: "List the Weaves this machine's Loom channel is joined to (the identity is shared by every Claude Code session here), with your participant name, this session's wake mode and invites flag, and lastSeq: the last event this session's stream has processed (in 'mentions' mode that includes events it did not wake you for; use read_events to see them).",
    inputSchema: {},
  }, async () => ok(Object.entries(state.load().weaves).map(([weaveId, w]) => ({
    weaveId, title: w.title, participantName: w.participantName, participantId: w.participantId, generalThreadId: w.generalThreadId, ...state.prefs(weaveId), lastSeq: state.cursor(weaveId),
  }))));

  server.registerTool("set_wake", {
    description: "Preferences for this session only. wake: 'all' (every message and system event) or 'mentions' (only messages that @mention you). invites: whether an invite addressed to you wakes this session (default true; it wakes even in 'mentions' mode). Other Claude Code sessions keep their own settings.",
    inputSchema: { weaveId: z.string(), wake: z.enum(["all", "mentions"]).optional(), invites: z.boolean().optional() },
  }, async ({ weaveId, wake, invites }) => {
    if (!state.load().weaves[weaveId]) return fail("no_weave", "Not joined to that Weave");
    if (wake === undefined && invites === undefined) return fail("validation", "Pass wake and/or invites");
    const prefs = await state.setPrefs(weaveId, { ...(wake !== undefined ? { wake } : {}), ...(invites !== undefined ? { invites } : {}) });
    hooks.onPrefsChanged(weaveId, prefs);
    return ok({ weaveId, ...prefs });
  });
```

`server.ts` wires `onPrefsChanged: (id, prefs) => streams.setPrefs(id, prefs)`. In `stored.ts` add pass-throughs: `setThreadUrl: async (c, t, u) => inner.setThreadUrl(byThread(c, t), t, u)`, `inviteParticipant: async (c, t, p) => inner.inviteParticipant(byThread(c, t), t, p)`, `inbox: async (c, w, o) => inner.inbox(byWeave(c, w), w, o)`, `createThread: async (c, w, n, u) => inner.createThread(byWeave(c, w), w, n, u)`, `joinWeave: (s, who, cred) => inner.joinWeave(s, who, cred)`, and `keeperAgentsList/Add/Revoke` through `keeperOnly`. In `backend.ts` (`ClientToolBackend`) implement the new methods over the HTTP client: `setThreadUrl(c, t, u) { return this.as(c).setThreadUrl(t, u); }`, `inviteParticipant(c, t, p) { return this.as(c).inviteParticipant(t, p); }`, `inbox(c, w, o) { return this.as(c).inbox(w, o); }`, `createThread(c, w, n, u)` passes `u`, `keeperAgentsList/Add/Revoke` via `this.as(c).admin.*`, and `joinWeave(secret, who, credential?)` ignores `credential` (the channel stores identities itself). Add to `INSTRUCTIONS` in `server.ts`:

> "An invite (type=thread.invited addressed to you) means your input is wanted in that Thread: read it with read_events(threadId), then reply there. If your own instructions or memory say to ignore invites, do nothing; set_wake(weaveId, invites=false) stops the wake-ups themselves. When an event carries thread_url, that is the artefact under discussion (for example a pull request): fetch it when you need the details."

- [ ] **Step 8: Rebuild, run the whole channel suite, typecheck**

Run: `cd src/claude-channel && pnpm build && npx vitest run && cd ../.. && pnpm -r typecheck`
Expected: PASS; typecheck clean across the repo again.

- [ ] **Step 9: Commit**

```bash
git add src/claude-channel && git commit -m "feat(channel): per-session wake/invites prefs, invite wake, thread_url meta, new tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Channel end-to-end — invite wakes a mentions-only session; two sessions keep their own prefs

**Files:**
- Test: `src/claude-channel/test/channel.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe("channel streaming", …)`)

```ts
  it("an invite wakes a mentions-only session with thread_url; another session's prefs are its own", async () => {
    await withChannel(stateDir, async (c) => {
      const got = collectNotifications(c);
      const created = json(await c.callTool({ name: "create_weave", arguments: { title: "T", opener: "start", name: "Claude" } }));
      const gpt = await s!.core.joinWeave(created.secret, { name: "ChatGPT", kind: "agent" });
      const gptActor = await s!.core.resolveCredential(gpt.token);
      await waitFor(() => got.some((g) => g.meta.type === "participant.joined"));
      const prefs = json(await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, wake: "mentions" } }));
      expect(prefs).toEqual({ weaveId: created.weave.id, wake: "mentions", invites: true });
      const t = await s!.core.createThread(gptActor, created.weave.id, "PR 7", "https://github.com/poteb/Loom/pull/7");
      await s!.core.postMessage(gptActor, t.id, "not for you");                 // suppressed in mentions mode
      const inv = await s!.core.inviteParticipant(gptActor, t.id, created.participant.id);
      await waitFor(() => got.some((g) => g.meta.type === "thread.invited"));
      const wake = got.find((g) => g.meta.type === "thread.invited")!;
      expect(wake.meta).toMatchObject({ thread: t.id, thread_name: "PR 7", thread_url: "https://github.com/poteb/Loom/pull/7", seq: String(inv.seq), from: "ChatGPT" });
      expect(wake.content).toContain('You were invited to Thread "PR 7" by ChatGPT');
      expect(got.some((g) => g.content === "not for you")).toBe(false);
      // Session B on the same machine keeps default prefs and was never asked anything.
      const dirB = stateDir;
      await withChannel(dirB, async (b) => {
        const listed = json(await b.callTool({ name: "list_joined", arguments: {} }));
        expect(listed[0]).toMatchObject({ weaveId: created.weave.id, wake: "all", invites: true });
      }, { CLAUDE_CODE_SESSION_ID: "session-B" });
      await c.callTool({ name: "set_wake", arguments: { weaveId: created.weave.id, invites: false } });
      const t2 = await s!.core.createThread(gptActor, created.weave.id, "PR 8");
      await s!.core.inviteParticipant(gptActor, t2.id, created.participant.id);
      await s!.core.postMessage(gptActor, t2.id, "@Claude wake up");
      await waitFor(() => got.some((g) => g.content === "@Claude wake up"));
      expect(got.filter((g) => g.meta.type === "thread.invited")).toHaveLength(1);  // the second invite did not wake
    }, { CLAUDE_CODE_SESSION_ID: "session-A" });
  });
```

- [ ] **Step 2: Run to see it fail**, then (after Task 11 is in) run again to see it pass

Run: `cd src/claude-channel && pnpm build && npx vitest run test/channel.test.ts -t "invite wakes"`
Expected: PASS once Task 11 is complete (if written before Task 11: FAIL on `set_wake` shape).

- [ ] **Step 3: Commit**

```bash
git add src/claude-channel/test/channel.test.ts && git commit -m "test(channel): invite wakes a mentions-only session; per-session prefs end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Web UI — thread URL, invites, highlight, DOM tests

**Files:**
- Create: `src/web/test/dom-setup.ts`, `src/web/test/components.test.tsx`
- Modify: `src/web/package.json`, `src/web/vitest.config.ts`, `src/web/tsconfig.test.json`, `src/web/src/session.ts`, `src/web/src/components/ThreadList.tsx`, `src/web/src/components/MessageList.tsx`, `src/web/src/app.tsx`, `src/web/src/styles.css`

**Interfaces:**
- Produces: `Session.createThread(name, url?: string | null)`, `Session.setThreadUrl(id, url)`, `Session.invite(threadId, participantId)`, `Session.canEditThread(t: Thread): boolean` (creator or keeper, weave not archived, thread open), `SessionState.invitesForMe: Set<string>` (thread ids with an unopened invite to me), `Session.markSeen(threadId)` (called by `selectThread`), `SessionState.invited: Record<threadId, Set<participantId>>`.

- [ ] **Step 1: Add the DOM test toolchain**

`src/web/package.json` devDependencies: `"happy-dom": "20.4.0"`, `"@testing-library/preact": "3.2.4"`. Run `pnpm install` at the repo root. `src/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    globalSetup: ["../core/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    environmentMatchGlobs: [["test/**/*.test.tsx", "happy-dom"]],
    setupFiles: ["test/dom-setup.ts"],
  },
});
```

`src/web/test/dom-setup.ts`: `import "@testing-library/preact";` (nothing else needed). Add `"jsx": "react-jsx", "jsxImportSource": "preact"` to `tsconfig.test.json` compilerOptions if not inherited, and `test/**/*.tsx` to its `include`.

- [ ] **Step 2: Write the failing DOM tests** — `src/web/test/components.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { ThreadList } from "../src/components/ThreadList.js";
import { MessageList } from "../src/components/MessageList.js";
import type { Session, SessionState } from "../src/session.js";

const me = { id: "p1", weaveId: "w1", name: "Paw", kind: "human" as const, role: "member" as const, joinedAt: "", agentId: null };
const bot = { id: "p2", weaveId: "w1", name: "Bot", kind: "agent" as const, role: "member" as const, joinedAt: "", agentId: "a1" };
const general = { id: "g1", weaveId: "w1", name: "General", isGeneral: true, createdBy: "p1", createdAt: "", closedAt: null, url: null };
const pr = { id: "t1", weaveId: "w1", name: "PR 12", isGeneral: false, createdBy: "p1", createdAt: "", closedAt: null, url: "https://github.com/poteb/Loom/pull/12" };

function state(over: Partial<SessionState> = {}): SessionState {
  return { status: "ready", weave: { id: "w1", title: "W", createdAt: "", archivedAt: null, lastSeq: 3 }, threads: [general, pr], participants: [me, bot],
    events: [], me: { participant: me, token: "t" }, currentThreadId: "g1", connection: "open", needsName: false, invitesForMe: new Set(), invited: {}, ...over };
}
function session(over: Partial<Session> = {}): Session {
  return { getState: () => state(), subscribe: () => () => {}, load: async () => {}, join: async () => {}, selectThread: vi.fn(), post: async () => {},
    createThread: vi.fn(async () => {}), setThreadUrl: vi.fn(async () => {}), invite: vi.fn(async () => {}), closeThread: async () => {}, archive: async () => {},
    canModerate: () => false, canEditThread: (t) => t.createdBy === "p1", markSeen: () => {}, dismissNamePrompt: () => {}, dispose: () => {}, ...over };
}

describe("ThreadList", () => {
  it("shows a thread's url as a truncated link and highlights a thread with an unread invite", () => {
    render(<ThreadList state={state({ invitesForMe: new Set(["t1"]) })} session={session()} onError={() => {}} />);
    const link = screen.getByRole("link", { name: /github.com\/poteb\/Loom\/pull\/12/ });
    expect(link.getAttribute("href")).toBe(pr.url);
    expect(screen.getByText("PR 12").closest("li")!.className).toContain("invited");
    expect(screen.getByText(/invited/i)).toBeTruthy();
  });
  it("new-thread form sends the url; invite button only for creator/keeper and only for others", async () => {
    const s = session();
    render(<ThreadList state={state({ currentThreadId: "t1" })} session={s} onError={() => {}} />);
    fireEvent.click(screen.getByText("New thread"));
    fireEvent.input(screen.getByPlaceholderText("Thread name"), { target: { value: "PR 13" } });
    fireEvent.input(screen.getByPlaceholderText("Artefact URL (optional)"), { target: { value: "https://e.com/13" } });
    fireEvent.submit(screen.getByPlaceholderText("Thread name").closest("form")!);
    await Promise.resolve();
    expect(s.createThread).toHaveBeenCalledWith("PR 13", "https://e.com/13");
    const inviteButtons = screen.getAllByRole("button", { name: /^invite /i });
    expect(inviteButtons.map((b) => b.textContent)).toEqual(["invite Bot"]);   // not myself
    fireEvent.click(inviteButtons[0]!);
    expect(s.invite).toHaveBeenCalledWith("t1", "p2");
  });
  it("shows a check mark instead of the invite button for someone already invited; no invite controls for a plain member", () => {
    render(<ThreadList state={state({ currentThreadId: "t1", invited: { t1: new Set(["p2"]) } })} session={session()} onError={() => {}} />);
    expect(screen.queryByRole("button", { name: /^invite /i })).toBeNull();
    expect(screen.getByTitle("invited")).toBeTruthy();
    render(<ThreadList state={state({ currentThreadId: "t1" })} session={session({ canEditThread: () => false })} onError={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /^invite /i })).toHaveLength(0);
  });
});

describe("MessageList", () => {
  it("renders invite and url-change events as system lines", () => {
    const events = [
      { weaveId: "w1", seq: 1, threadId: "t1", type: "thread.invited" as const, actor: "p1", at: new Date().toISOString(), payload: { threadId: "t1", participantId: "p2", invitedBy: "p1" } },
      { weaveId: "w1", seq: 2, threadId: "t1", type: "thread.url_changed" as const, actor: "p1", at: new Date().toISOString(), payload: { threadId: "t1", url: "https://e.com/x" } },
    ];
    render(<MessageList state={state({ currentThreadId: "t1", events })} />);
    expect(screen.getByText(/Bot invited by Paw/)).toBeTruthy();
    expect(screen.getByText(/now links to https:\/\/e.com\/x/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `cd src/web && npx vitest run test/components.test.tsx`
Expected: FAIL (missing session members, missing UI).

- [ ] **Step 4: Session** — `src/web/src/session.ts`

Add to `SessionState`: `invitesForMe: Set<string>; invited: Record<string, Set<string>>;` (initialise both in the initial state and recompute from `events` on load and on each `onEvent`). Add to `Session`: `createThread(name: string, url?: string | null)`, `setThreadUrl(id: string, url: string | null)`, `invite(threadId: string, participantId: string)`, `canEditThread(t: Thread): boolean`, `markSeen(threadId: string)`.

```ts
  /** Derived from the log: who has been invited where, and which of those invites target me and are unopened. */
  const deriveInvites = (events: LoomEvent[], meId: string | undefined, seen: Set<string>) => {
    const invited: Record<string, Set<string>> = {};
    const forMe = new Set<string>();
    for (const e of events) {
      if (e.type !== "thread.invited") continue;
      const pid = String(e.payload.participantId ?? "");
      (invited[e.threadId] ??= new Set()).add(pid);
      if (meId && pid === meId && !seen.has(e.threadId)) forMe.add(e.threadId);
    }
    return { invited, invitesForMe: forMe };
  };
  const seenThreads = new Set<string>();
```

In `load()` after computing `me`: `set({ …, ...deriveInvites(events, me?.participant.id, seenThreads) })`. In `onEvent`: after building `events`, `set({ events, ...deriveInvites(events, state.me?.participant.id, seenThreads) })`, and add `"thread.url_changed"` to the refresh-trigger list (the thread's `url` lives in `threads`). New methods:

```ts
    selectThread: (id) => { seenThreads.add(id); set({ currentThreadId: id, ...deriveInvites(state.events, state.me?.participant.id, seenThreads) }); },
    markSeen: (id) => { seenThreads.add(id); set(deriveInvites(state.events, state.me?.participant.id, seenThreads)); },
    async createThread(name, url = null) {
      const w = writer();
      if (!weaveId) throw new LoomClientError("validation", "Weave not loaded");
      const t = await w.createThread(weaveId, name, url);
      set({ threads: state.threads.some((x) => x.id === t.id) ? state.threads : [...state.threads, t], currentThreadId: t.id });
    },
    async setThreadUrl(id, url) {
      const w = writer();
      const t = await w.setThreadUrl(id, url);
      set({ threads: state.threads.map((x) => (x.id === id ? t : x)) });
    },
    async invite(threadId, participantId) {
      const w = writer();
      await w.inviteParticipant(threadId, participantId);
      scheduleRefresh();   // the thread.invited event arrives over the stream and updates `invited`
    },
    canEditThread: (t) => !!state.me && !state.weave?.archivedAt && !t.closedAt && (state.me.participant.role === "keeper" || t.createdBy === state.me.participant.id),
```

- [ ] **Step 5: Components**

`ThreadList.tsx` — form gets a second input `placeholder="Artefact URL (optional)"` bound to `url` state; submit calls `session.createThread(n, url.trim() || null)`. Each `<li>` gets class `invited` when `state.invitesForMe.has(t.id)` plus a `<span class="badge badge-invited">invited</span>`; when `t.url` is set render `<a class="thread-url" href={t.url} target="_blank" rel="noreferrer">{shortUrl(t.url)}</a>` where `shortUrl` strips the protocol and truncates to 40 chars with `…`. Below the list, for the *current* thread when `session.canEditThread(t)`: an "Invite" section listing every participant except me, each either `<button class="link" onClick={() => void invite(t.id, p.id)}>invite {p.name}</button>` or `<span title="invited">✓ {p.name}</span>` if `state.invited[t.id]?.has(p.id)`; plus a small inline form to set/clear the URL (`session.setThreadUrl(t.id, value || null)`).

`MessageList.tsx` — `systemLine` gains:

```ts
    case "thread.invited": return `${name(e.payload.participantId)} invited by ${who(e.actor)}`;
    case "thread.url_changed": return e.payload.url ? `thread now links to ${String(e.payload.url)}` : "thread no longer links to an artefact";
```

(`who` moved above `systemLine` or passed in.) `app.tsx` — above `<MessageList>`: `{state.invitesForMe.size > 0 && <div class="banner">You were invited to {[...state.invitesForMe].map((id) => state.threads.find((t) => t.id === id)?.name ?? id).join(", ")}</div>}`. `styles.css`: `.threads li.invited > .thread-pick { font-weight: 600; } .badge-invited { background: #e9d8fd; } .thread-url { display: block; font-size: 0.8em; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }`.

- [ ] **Step 6: Run web tests, typecheck, build**

Run: `cd src/web && npx vitest run && pnpm typecheck && pnpm build`
Expected: PASS; `session.test.ts` still green (its fixtures get `url: null`/`agentId: null` from the server automatically).

- [ ] **Step 7: Commit**

```bash
git add src/web pnpm-lock.yaml && git commit -m "feat(web): thread url, invites with highlight and banner, DOM component tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Docs, full verification, PR

**Files:**
- Modify: `README.md`, `src/claude-channel/README.md`, `docs/superpowers/specs/v2-notes.md`

- [ ] **Step 1: README — new sections**

Root `README.md`, after the MCP-client bullet:

```markdown
### Agent keys (stable identity for remote MCP clients)

An instance keeper mints a key for each remote agent: `loom admin agents add ChatGPT` (or the
`keeper_agents_add` tool). Add the connector as `https://<host>/mcp?agent=<key>`. Every connection
then acts as that agent: tools need no `credential`, `join_weave` links the agent's participant in
that Weave once, and later joins return the same identity. Revoke with `loom admin agents revoke <id>`;
history stays. A key never grants instance-keeper rights.

### Threads with an artefact, invites, inbox

`create_thread` / `loom thread new --url` attach a URL (typically a pull request) to a Thread; every
event from the Thread carries it. The Thread's creator or a Weave keeper can `invite_participant`:
an invite is a targeted "your input is wanted here" (not an access change). Channel-connected
agents are woken by an invite even in mentions-only mode; remote agents call `inbox` at the start of a
turn to see invites and mentions addressed to them since the last seq they saw.
```

`src/claude-channel/README.md` — under "Use": explain `set_wake(weaveId, wake?, invites?)` is per session, that invites wake in both modes unless `invites=false`, and the `thread_url` meta.

- [ ] **Step 2: v2-notes** — in `docs/superpowers/specs/v2-notes.md` mark the north-star items 1–3 as delivered by sub-project 1 (link the spec) and strike "The agent must carry its token" and "Keeper tools are always advertised" (the latter is now moot for agent connections; leave the note for anonymous ones).

- [ ] **Step 3: Full verification**

```bash
pnpm -r build && pnpm -r typecheck
for p in core mcp-tools server client cli claude-channel web; do (cd src/$p && npx vitest run) || break; done
```

Expected: every package green.

- [ ] **Step 4: Manual smoke (human)**: `run.cmd`; `loom admin agents add ChatGPT`; add the printed connector URL to a claude.ai or ChatGPT connector (through the tunnel, `start_cloudflare_tunnel.cmd`); create a Thread with a PR URL from the web UI; invite the agent; in the agent's chat say "check Loom" and confirm `inbox` returns the invite with the URL. Start `loom-channel.cmd`, `set_wake … mentions`, invite that participant from the web UI, confirm the `<channel>` turn arrives.

- [ ] **Step 5: Commit, push, PR**

```bash
git add -A && git commit -m "docs: agent keys, invites, inbox, per-session wake prefs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/v2-review-loop
gh pr create --base main --title "feat: v2 review loop core — invites, thread URL, inbox, agent keys" --body-file docs/superpowers/plans/pr-body.md
```

(Write `docs/superpowers/plans/pr-body.md` from the spec's §1 and §9 plus a test summary, and end it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; delete the file after the PR exists — it is not part of the change.) Then run the ChatGPT PR review as for v1 and address findings before asking Paw to approve.
