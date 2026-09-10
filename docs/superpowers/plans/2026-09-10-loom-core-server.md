# Loom Core + Server Implementation Plan (plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Loom domain core on Postgres and the HTTP/WebSocket server around it, deployable with Docker Compose behind Caddy, runnable locally with one script.

**Architecture:** pnpm monorepo under `src/`. `@loom/core` holds all rules and talks to Postgres via Drizzle; it exposes a `createCore(db)` service object. `@loom/server` is a thin Hono app mapping REST + WebSocket onto core, with a ticket-based WS handshake and an in-process event bus for live delivery. Plans 2 (client/CLI/web) and 3 (MCP/channel plugin) build on the API this plan delivers.

**Tech Stack:** Node 24, pnpm 12 (via corepack), TypeScript 5.9, Hono 4 + `@hono/node-server`, `ws`, Drizzle ORM 0.45 + `postgres` (postgres.js), Zod 4, Vitest 4, Testcontainers, Docker Compose, Caddy 2.

Spec: `docs/superpowers/specs/2026-09-10-loom-v1-design.md`. Plan 2 and plan 3 are written after this plan is executed.

## Global Constraints

- All source code lives under `src/`. Packages: `src/core`, `src/server` (this plan); `src/client`, `src/web`, `src/cli`, `src/claude-channel` (later plans).
- TypeScript everywhere. ESM only (`"type": "module"`). Strict mode.
- Every rule lives in `core`. `server` contains no business logic beyond HTTP mapping.
- Event table is append-only: no UPDATE or DELETE on `events`, ever.
- `seq` is monotonic and gap-free per Weave, assigned under the Weave row lock, commit-ordered.
- Live publication happens only after the insert transaction commits.
- Participant names: 1–32 chars, `[A-Za-z0-9_.-]`, unique per Weave case-insensitively.
- Weave secret: 32 random bytes base64url. Participant and keeper tokens: 32 random bytes base64url.
- Error shape everywhere: `{ code, message }`. Codes: `validation` 400, `invalid_token` 401, `forbidden` 403, `weave_not_found` / `thread_not_found` 404, `weave_archived` / `thread_closed` / `name_taken` 409, `message_too_long` 413.
- Settings defaults: `instanceName` = `Loom`, `maxMessageLength` = 20000, `openWeaveCreation` = true.
- Secrets and tokens are never logged.
- Server listens on plain HTTP on the Docker network only; Caddy terminates TLS. Local run is `https://localhost` via Caddy internal CA.
- Env: `LOOM_DOMAIN`, `DATABASE_URL`, `LOOM_KEEPER_TOKENS` (comma-separated), `PORT` (default 3000).
- Pinned versions: typescript 5.9.3, vitest 4.1.11, hono 4.13.7, @hono/node-server 2.1.1, ws 8.21.3, @types/ws 8.18.1, drizzle-orm 0.45.2, drizzle-kit 0.31.10, postgres 3.4.9, zod 4.6.1, @testcontainers/postgresql 12.1.0, tsx 4.23.13, @types/node 22.20.2, pnpm 12.3.4.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
loom/
  package.json                 workspace root, scripts: build, test, dev
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  .env.example
  docker-compose.yml           caddy, loom, postgres
  Caddyfile                    TLS termination, reverse proxy to loom:3000
  build.ps1  build.sh          corepack enable + pnpm install + pnpm build
  run.ps1    run.sh            docker compose up postgres+caddy, server in dev mode
  src/core/
    package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts
    drizzle/                   generated SQL migrations (committed)
    src/index.ts               createCore(db): Core
    src/db/schema.ts           Drizzle tables
    src/db/index.ts            createDb(url), runMigrations(db)
    src/errors.ts              LoomError + codes
    src/ids.ts                 newId(), newSecret()
    src/names.ts               validateName()
    src/mentions.ts            parseMentions(text, participants)
    src/bus.ts                 EventBus (subscribe/publish per Weave)
    src/actors.ts              Actor type, resolveCredential()
    src/events.ts              appendEvent (seq allocation), readEvents
    src/weaves.ts              createWeave, getWeave, joinWeave, archiveWeave, listWeaves
    src/threads.ts             createThread, closeThread
    src/messages.ts            postMessage
    src/participants.ts        setRole
    src/settings.ts            getSettings, updateSettings
    src/keepers.ts             seedKeepers, listKeepers, addKeeper, removeKeeper
    src/export.ts              exportWeave(format)
    test/global-setup.ts       starts Postgres testcontainer, sets TEST_DATABASE_URL
    test/helpers.ts            freshCore(): migrated, truncated core for each test
    test/*.test.ts             one file per module
  src/server/
    package.json  tsconfig.json  vitest.config.ts  Dockerfile
    src/app.ts                 buildApp(core, tickets): Hono app
    src/auth.ts                bearer extraction middleware
    src/errors.ts              LoomError → HTTP status
    src/tickets.ts             TicketStore (single-use, 60 s)
    src/routes/weaves.ts       /api/weaves/*
    src/routes/threads.ts      /api/threads/*
    src/routes/admin.ts        /api/admin/*
    src/routes/auth.ts         /api/auth/ws-ticket
    src/ws.ts                  attachWebSocket(server, core, tickets)
    src/main.ts                entrypoint: env, db, migrate, seed keepers, listen
    test/helpers.ts            startTestServer(): real HTTP listener on random port
    test/*.test.ts
```

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `src/core/package.json`, `src/core/tsconfig.json`, `src/core/vitest.config.ts`, `src/core/src/index.ts`
- Create: `src/server/package.json`, `src/server/tsconfig.json`, `src/server/vitest.config.ts`, `src/server/src/main.ts`
- Create: `build.ps1`, `build.sh`

**Interfaces:**
- Produces: workspace packages `@loom/core` and `@loom/server`; root scripts `pnpm build`, `pnpm test`.

- [ ] **Step 1: Enable pnpm and create root files**

```bash
corepack enable pnpm
corepack use pnpm@12.3.4
```

`package.json`:

```json
{
  "name": "loom",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.3.4",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r build && pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --filter @loom/server dev"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.11",
    "tsx": "4.23.13",
    "@types/node": "22.20.2"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "src/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true
  }
}
```

`.gitignore`:

```
node_modules/
dist/
.env
*.log
caddy-data/
```

`.env.example`:

```
# Public hostname Caddy serves. Use "localhost" for local runs.
LOOM_DOMAIN=localhost
# Postgres connection string used by the server.
DATABASE_URL=postgres://loom:loom@localhost:5432/loom
# Comma-separated keeper tokens seeded on first boot. Generate with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
LOOM_KEEPER_TOKENS=change-me
PORT=3000
```

- [ ] **Step 2: Create `src/core` package skeleton**

`src/core/package.json`:

```json
{
  "name": "@loom/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "drizzle-orm": "0.45.2",
    "postgres": "3.4.9",
    "zod": "4.6.1"
  },
  "devDependencies": {
    "drizzle-kit": "0.31.10",
    "@testcontainers/postgresql": "12.1.0"
  }
}
```

`src/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`src/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
```

`src/core/src/index.ts` (placeholder that compiles; replaced in Task 3):

```ts
export const LOOM_CORE_VERSION = "0.1.0";
```

- [ ] **Step 3: Create `src/server` package skeleton**

`src/server/package.json`:

```json
{
  "name": "@loom/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@loom/core": "workspace:*",
    "hono": "4.13.7",
    "@hono/node-server": "2.1.1",
    "ws": "8.21.3",
    "zod": "4.6.1"
  },
  "devDependencies": {
    "@types/ws": "8.18.1",
    "@testcontainers/postgresql": "12.1.0"
  }
}
```

`src/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`src/server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../core/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
```

`src/server/src/main.ts` (placeholder; replaced in Task 14):

```ts
console.log("loom server placeholder");
```

- [ ] **Step 4: Build scripts**

`build.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
corepack enable pnpm
pnpm install --frozen-lockfile=false
pnpm build
```

`build.ps1`:

```powershell
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
corepack enable pnpm
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm build
exit $LASTEXITCODE
```

- [ ] **Step 5: Install and build**

Run:

```bash
corepack enable pnpm && pnpm install && pnpm build
```

Expected: both packages compile, `src/core/dist/index.js` and `src/server/dist/main.js` exist.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace with core and server packages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Database schema, migrations, and test harness

**Files:**
- Create: `src/core/src/db/schema.ts`, `src/core/src/db/index.ts`, `src/core/drizzle.config.ts`
- Create: `src/core/test/global-setup.ts`, `src/core/test/helpers.ts`, `src/core/test/db.test.ts`
- Generate: `src/core/drizzle/0000_*.sql` + `src/core/drizzle/meta/*`

**Interfaces:**
- Produces: `createDb(url): Db`, `runMigrations(db): Promise<void>`, `type Db`, table objects `weaves`, `threads`, `participants`, `keepers`, `settings`, `events`. Test helper `freshDb(): Promise<Db>` (migrated + truncated).

- [ ] **Step 1: Write the schema**

`src/core/src/db/schema.ts`:

```ts
import {
  pgTable, text, timestamp, integer, jsonb, uuid, boolean, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const weaves = pgTable("weaves", {
  id: uuid("id").primaryKey(),
  secret: text("secret").notNull().unique(),
  title: text("title").notNull(),
  lastSeq: integer("last_seq").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  isGeneral: boolean("is_general").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [index("threads_weave_idx").on(t.weaveId)]);

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["human", "agent"] }).notNull(),
  role: text("role", { enum: ["member", "keeper"] }).notNull().default("member"),
  token: text("token").notNull().unique(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("participants_weave_name_idx").on(t.weaveId, sql`lower(${t.name})`),
]);

export const keepers = pgTable("keepers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  instanceName: text("instance_name").notNull().default("Loom"),
  maxMessageLength: integer("max_message_length").notNull().default(20000),
  openWeaveCreation: boolean("open_weave_creation").notNull().default(true),
});

export const events = pgTable("events", {
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  seq: integer("seq").notNull(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
}, (t) => [
  uniqueIndex("events_weave_seq_idx").on(t.weaveId, t.seq),
  index("events_thread_idx").on(t.threadId),
]);
```

- [ ] **Step 2: Write db factory and migrator**

`src/core/src/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema, casing: "snake_case" });
}

export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../drizzle",
  );
  await migrate(db, { migrationsFolder });
}

export async function closeDb(db: Db): Promise<void> {
  await (db.$client as ReturnType<typeof postgres>).end();
}

export { schema };
```

`src/core/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 3: Generate the initial migration**

Run from `src/core`:

```bash
pnpm db:generate
```

Expected: `src/core/drizzle/0000_<name>.sql` and `src/core/drizzle/meta/_journal.json` created. Open the SQL and confirm it contains `CREATE TABLE "events"` and `CREATE UNIQUE INDEX "events_weave_seq_idx"`.

- [ ] **Step 4: Write the test harness**

`src/core/test/global-setup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  if (process.env.TEST_DATABASE_URL) return;
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
}

export async function teardown() {
  await container?.stop();
}
```

`src/core/test/helpers.ts`:

```ts
import { sql } from "drizzle-orm";
import { createDb, runMigrations, closeDb, type Db } from "../src/db/index.js";

let db: Db | undefined;
let migrated = false;

export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set (global setup missing?)");
  db ??= createDb(url);
  if (!migrated) { await runMigrations(db); migrated = true; }
  await db.execute(sql`truncate events, participants, threads, weaves, keepers, settings restart identity cascade`);
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (db) { await closeDb(db); db = undefined; migrated = false; }
}
```

- [ ] **Step 5: Write a migration smoke test**

`src/core/test/db.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { freshDb, closeTestDb } from "./helpers.js";

afterAll(closeTestDb);

describe("migrations", () => {
  it("creates all tables", async () => {
    const db = await freshDb();
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["weaves", "threads", "participants", "keepers", "settings", "events"]) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 6: Run the test**

Run from `src/core`: `pnpm test`
Expected: PASS (Docker must be running; first run pulls `postgres:17-alpine`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): database schema, migrations, and test harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pure units — errors, ids, names, mentions

**Files:**
- Create: `src/core/src/errors.ts`, `src/core/src/ids.ts`, `src/core/src/names.ts`, `src/core/src/mentions.ts`
- Test: `src/core/test/units.test.ts`

**Interfaces:**
- Produces:
  - `class LoomError extends Error { code: ErrorCode }`, `type ErrorCode`, `errors.validation(msg)` etc. factory helpers
  - `newId(): string` (uuid v7 via `crypto.randomUUID()` is v4; we use v4, ordering comes from `seq`), `newSecret(): string` (43-char base64url)
  - `validateName(name: string): string` (returns trimmed name or throws `validation`)
  - `parseMentions(text: string, participants: { id: string; name: string }[]): string[]`

- [ ] **Step 1: Write failing tests**

`src/core/test/units.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LoomError, errors } from "../src/errors.js";
import { newId, newSecret } from "../src/ids.js";
import { validateName } from "../src/names.js";
import { parseMentions } from "../src/mentions.js";

describe("errors", () => {
  it("carries a code", () => {
    const e = errors.weaveArchived();
    expect(e).toBeInstanceOf(LoomError);
    expect(e.code).toBe("weave_archived");
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe("ids", () => {
  it("secret is 43 chars base64url", () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(s);
  });
  it("id is a uuid", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("validateName", () => {
  it("accepts allowed names", () => {
    expect(validateName("Claude_Code-1.0")).toBe("Claude_Code-1.0");
  });
  it("trims", () => {
    expect(validateName("  Paw ")).toBe("Paw");
  });
  it.each(["", "a b", "x".repeat(33), "ø", "@paw"])("rejects %j", (n) => {
    expect(() => validateName(n)).toThrow(LoomError);
    try { validateName(n); } catch (e) { expect((e as LoomError).code).toBe("validation"); }
  });
});

describe("parseMentions", () => {
  const ps = [{ id: "p1", name: "Claude" }, { id: "p2", name: "ChatGPT" }, { id: "p3", name: "Paw.B" }];
  it("resolves case-insensitively", () => {
    expect(parseMentions("hey @claude and @CHATGPT", ps)).toEqual(["p1", "p2"]);
  });
  it("requires a word boundary after the name", () => {
    expect(parseMentions("@Claudette", ps)).toEqual([]);
    expect(parseMentions("@Claude, yes", ps)).toEqual(["p1"]);
    expect(parseMentions("(@Claude)", ps)).toEqual(["p1"]);
  });
  it("handles dots in names", () => {
    expect(parseMentions("ping @paw.b.", ps)).toEqual(["p3"]);
  });
  it("dedupes and ignores unknown", () => {
    expect(parseMentions("@Claude @Claude @nobody", ps)).toEqual(["p1"]);
  });
  it("ignores emails", () => {
    expect(parseMentions("mail me@Claude", ps)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/units.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/core/src/errors.ts`:

```ts
export type ErrorCode =
  | "validation" | "invalid_token" | "forbidden"
  | "weave_not_found" | "thread_not_found"
  | "weave_archived" | "thread_closed" | "name_taken"
  | "message_too_long";

export class LoomError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "LoomError";
  }
  toJSON() { return { code: this.code, message: this.message }; }
}

export const errors = {
  validation: (msg: string) => new LoomError("validation", msg),
  invalidToken: () => new LoomError("invalid_token", "Unknown or missing credential"),
  forbidden: (msg = "Not allowed") => new LoomError("forbidden", msg),
  weaveNotFound: () => new LoomError("weave_not_found", "Weave not found"),
  threadNotFound: () => new LoomError("thread_not_found", "Thread not found"),
  weaveArchived: () => new LoomError("weave_archived", "Weave is archived"),
  threadClosed: () => new LoomError("thread_closed", "Thread is closed"),
  nameTaken: (name: string) => new LoomError("name_taken", `Name "${name}" is already taken in this Weave`),
  messageTooLong: (max: number) => new LoomError("message_too_long", `Message exceeds ${max} characters`),
};
```

`src/core/src/ids.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string { return randomUUID(); }

/** 32 random bytes, base64url without padding (43 chars). Used for weave secrets and tokens. */
export function newSecret(): string { return randomBytes(32).toString("base64url"); }
```

`src/core/src/names.ts`:

```ts
import { errors } from "./errors.js";

export const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw errors.validation("Name must be 1-32 characters of A-Z, a-z, 0-9, _ . -");
  }
  return trimmed;
}
```

`src/core/src/mentions.ts`:

```ts
/** Returns participant ids mentioned as @name (case-insensitive, word-bounded), deduped, in order of first appearance. */
export function parseMentions(text: string, participants: { id: string; name: string }[]): string[] {
  const byName = new Map(participants.map((p) => [p.name.toLowerCase(), p.id]));
  const out: string[] = [];
  // '@' must not be preceded by a name char (avoids emails); name is longest run of name chars.
  const re = /(?<![A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g;
  for (const m of text.matchAll(re)) {
    // Trailing dots are punctuation, not part of the name, unless the full run matches a name.
    let candidate = m[1]!;
    let id = byName.get(candidate.toLowerCase());
    while (!id && candidate.endsWith(".")) {
      candidate = candidate.slice(0, -1);
      id = byName.get(candidate.toLowerCase());
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/units.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): errors, ids, name validation, mention parsing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Event bus, actors, and append-only event log

**Files:**
- Create: `src/core/src/types.ts`, `src/core/src/bus.ts`, `src/core/src/actors.ts`, `src/core/src/events.ts`
- Test: `src/core/test/events.test.ts`

**Interfaces:**
- Produces (used by every later core task):

```ts
// types.ts
export type EventType = "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "weave.archived";
export type LoomEvent = { weaveId: string; seq: number; threadId: string; type: EventType;
  actor: string; at: string; payload: Record<string, unknown> };
export type Role = "member" | "keeper";
export type Kind = "human" | "agent";
export type PublicParticipant = { id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string };
export type PublicThread = { id: string; weaveId: string; name: string; isGeneral: boolean; createdBy: string; createdAt: string; closedAt: string | null };
export type PublicWeave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number };
export type Actor =
  | { kind: "participant"; participant: PublicParticipant }
  | { kind: "keeper"; keeperId: string; name: string }
  | { kind: "secret"; weaveId: string };
// bus.ts
export class EventBus { subscribe(weaveId, fn: (e: LoomEvent) => void): () => void; publish(e: LoomEvent): void }
// actors.ts
export async function resolveCredential(db, credential: string): Promise<Actor>   // throws invalid_token
export function actorId(actor: Actor): string                                     // participant id | "keeper:<id>"; throws forbidden for secret
export function assertCanRead(actor: Actor, weaveId: string): void
export function assertIsKeeperOf(actor: Actor, weaveId: string): void            // weave-role keeper or instance keeper
export function assertInstanceKeeper(actor: Actor): void
// events.ts
export type NewEvent = { threadId: string; type: EventType; actor: string; payload: Record<string, unknown> };
export async function withWeaveLock<T>(db, bus, weaveId, fn: (tx, weave: WeaveRow) => Promise<{ result: T; events: NewEvent[] }>): Promise<T>
export async function appendInTx(tx, weave: { id: string; lastSeq: number }, news: NewEvent[]): Promise<LoomEvent[]>
export async function readEvents(db, weaveId, opts: { since?: number; threadId?: string; limit?: number }): Promise<LoomEvent[]>
```

- [ ] **Step 1: Write failing tests**

`src/core/test/events.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { weaves, threads } from "../src/db/schema.js";
import { EventBus } from "../src/bus.js";
import { withWeaveLock, readEvents, appendInTx } from "../src/events.js";
import { newId, newSecret } from "../src/ids.js";
import type { Db } from "../src/db/index.js";
import type { LoomEvent } from "../src/types.js";

afterAll(closeTestDb);

let db: Db;
let weaveId: string;
let threadId: string;

beforeEach(async () => {
  db = await freshDb();
  weaveId = newId(); threadId = newId();
  await db.insert(weaves).values({ id: weaveId, secret: newSecret(), title: "t" });
  await db.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: "x" });
});

describe("EventBus", () => {
  it("delivers only to subscribers of that weave and supports unsubscribe", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe("w1", (e) => got.push(`a${e.seq}`));
    bus.subscribe("w2", (e) => got.push(`b${e.seq}`));
    const ev = (weaveId: string, seq: number): LoomEvent =>
      ({ weaveId, seq, threadId: "t", type: "message", actor: "p", at: new Date().toISOString(), payload: {} });
    bus.publish(ev("w1", 1));
    off();
    bus.publish(ev("w1", 2));
    bus.publish(ev("w2", 1));
    expect(got).toEqual(["a1", "b1"]);
  });
});

describe("withWeaveLock + appendInTx", () => {
  it("assigns gap-free seq and publishes after commit", async () => {
    const bus = new EventBus();
    const published: number[] = [];
    bus.subscribe(weaveId, (e) => published.push(e.seq));
    const r = await withWeaveLock(db, bus, weaveId, async () => ({
      result: "ok",
      events: [
        { threadId, type: "message", actor: "p", payload: { text: "a" } },
        { threadId, type: "message", actor: "p", payload: { text: "b" } },
      ],
    }));
    expect(r).toBe("ok");
    expect(published).toEqual([1, 2]);
    const rows = await readEvents(db, weaveId, {});
    expect(rows.map((e) => e.seq)).toEqual([1, 2]);
    const [w] = await db.select().from(weaves);
    expect(w!.lastSeq).toBe(2);
  });

  it("serializes concurrent writers: 20 parallel appends yield seq 1..20 with no gaps", async () => {
    const bus = new EventBus();
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      withWeaveLock(db, bus, weaveId, async () => ({
        result: null,
        events: [{ threadId, type: "message", actor: "p", payload: { i } }],
      }))));
    const rows = await readEvents(db, weaveId, {});
    expect(rows.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("does not publish when the transaction fails", async () => {
    const bus = new EventBus();
    let n = 0; bus.subscribe(weaveId, () => n++);
    await expect(withWeaveLock(db, bus, weaveId, async (tx, weave) => {
      await appendInTx(tx, weave, [{ threadId, type: "message", actor: "p", payload: {} }]);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(n).toBe(0);
    expect(await readEvents(db, weaveId, {})).toEqual([]);
  });

  it("throws weave_not_found for unknown weave", async () => {
    await expect(withWeaveLock(db, new EventBus(), newId(), async () => ({ result: 1, events: [] })))
      .rejects.toMatchObject({ code: "weave_not_found" });
  });
});

describe("readEvents", () => {
  it("filters by since, thread, and limit", async () => {
    const bus = new EventBus();
    const other = newId();
    await db.insert(threads).values({ id: other, weaveId, name: "Other", createdBy: "x" });
    await withWeaveLock(db, bus, weaveId, async () => ({
      result: null,
      events: [
        { threadId, type: "message", actor: "p", payload: { n: 1 } },
        { threadId: other, type: "message", actor: "p", payload: { n: 2 } },
        { threadId, type: "message", actor: "p", payload: { n: 3 } },
      ],
    }));
    expect((await readEvents(db, weaveId, { since: 1 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await readEvents(db, weaveId, { threadId: other })).map((e) => e.seq)).toEqual([2]);
    expect((await readEvents(db, weaveId, { limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/events.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement types and bus**

`src/core/src/types.ts`:

```ts
export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "weave.archived";

export type LoomEvent = {
  weaveId: string; seq: number; threadId: string; type: EventType;
  actor: string; at: string; payload: Record<string, unknown>;
};

export type Role = "member" | "keeper";
export type Kind = "human" | "agent";

export type PublicParticipant = {
  id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string;
};
export type PublicThread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null;
};
export type PublicWeave = {
  id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number;
};

export type Actor =
  | { kind: "participant"; participant: PublicParticipant }
  | { kind: "keeper"; keeperId: string; name: string }
  | { kind: "secret"; weaveId: string };

export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean };
```

`src/core/src/bus.ts`:

```ts
import type { LoomEvent } from "./types.js";

type Listener = (e: LoomEvent) => void;

/** In-process pub/sub keyed by weave id. Single-instance v1; swap for pg NOTIFY when scaling out. */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(weaveId: string, fn: Listener): () => void {
    let set = this.listeners.get(weaveId);
    if (!set) { set = new Set(); this.listeners.set(weaveId, set); }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(weaveId);
    };
  }

  publish(e: LoomEvent): void {
    const set = this.listeners.get(e.weaveId);
    if (!set) return;
    for (const fn of set) {
      try { fn(e); } catch { /* a bad subscriber must not break publishing */ }
    }
  }
}
```

- [ ] **Step 4: Implement actors**

`src/core/src/actors.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants, keepers, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import type { Actor, PublicParticipant } from "./types.js";

export function toPublicParticipant(p: typeof participants.$inferSelect): PublicParticipant {
  return { id: p.id, weaveId: p.weaveId, name: p.name, kind: p.kind, role: p.role, joinedAt: p.joinedAt.toISOString() };
}

/** Resolves a bearer credential: participant token, keeper token, or weave secret. */
export async function resolveCredential(db: Db, credential: string): Promise<Actor> {
  if (!credential) throw errors.invalidToken();
  const [p] = await db.select().from(participants).where(eq(participants.token, credential)).limit(1);
  if (p) return { kind: "participant", participant: toPublicParticipant(p) };
  const [k] = await db.select().from(keepers).where(eq(keepers.token, credential)).limit(1);
  if (k) return { kind: "keeper", keeperId: k.id, name: k.name };
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, credential)).limit(1);
  if (w) return { kind: "secret", weaveId: w.id };
  throw errors.invalidToken();
}

/** Attribution string stored in events. */
export function actorId(actor: Actor): string {
  if (actor.kind === "participant") return actor.participant.id;
  if (actor.kind === "keeper") return `keeper:${actor.keeperId}`;
  throw errors.forbidden("A Weave secret only grants read access; join to write");
}

export function assertCanRead(actor: Actor, weaveId: string): void {
  if (actor.kind === "keeper") return;
  const scoped = actor.kind === "participant" ? actor.participant.weaveId : actor.weaveId;
  if (scoped !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
}

export function assertParticipantOf(actor: Actor, weaveId: string): PublicParticipant {
  if (actor.kind !== "participant") throw errors.forbidden("Join the Weave to do this");
  if (actor.participant.weaveId !== weaveId) throw errors.forbidden("Credential does not belong to this Weave");
  return actor.participant;
}

export function assertIsKeeperOf(actor: Actor, weaveId: string): void {
  if (actor.kind === "keeper") return;
  if (actor.kind === "participant" && actor.participant.weaveId === weaveId && actor.participant.role === "keeper") return;
  throw errors.forbidden("Only a keeper of this Weave can do this");
}

export function assertInstanceKeeper(actor: Actor): void {
  if (actor.kind !== "keeper") throw errors.forbidden("Instance keeper required");
}
```

- [ ] **Step 5: Implement events**

`src/core/src/events.ts`:

```ts
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, weaves } from "./db/schema.js";
import { errors } from "./errors.js";
import type { EventBus } from "./bus.js";
import type { EventType, LoomEvent } from "./types.js";

export type NewEvent = { threadId: string; type: EventType; actor: string; payload: Record<string, unknown> };
export type WeaveRow = typeof weaves.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function toEvent(r: typeof events.$inferSelect): LoomEvent {
  return {
    weaveId: r.weaveId, seq: r.seq, threadId: r.threadId, type: r.type as EventType,
    actor: r.actor, at: r.at.toISOString(), payload: r.payload as Record<string, unknown>,
  };
}

/**
 * Appends events for a weave whose row is already locked in `tx`.
 * Assigns seq = weave.lastSeq+1.. and advances weaves.last_seq. Mutates weave.lastSeq.
 */
export async function appendInTx(tx: Tx, weave: { id: string; lastSeq: number }, news: NewEvent[]): Promise<LoomEvent[]> {
  if (news.length === 0) return [];
  const rows = news.map((n, i) => ({
    weaveId: weave.id, seq: weave.lastSeq + i + 1, threadId: n.threadId,
    type: n.type, actor: n.actor, payload: n.payload,
  }));
  const inserted = await tx.insert(events).values(rows).returning();
  weave.lastSeq += news.length;
  await tx.update(weaves).set({ lastSeq: weave.lastSeq }).where(eq(weaves.id, weave.id));
  return inserted.sort((a, b) => a.seq - b.seq).map(toEvent);
}

/**
 * Runs `fn` in a transaction holding a row lock on the weave (SELECT ... FOR UPDATE),
 * appends the returned events, commits, then publishes them in seq order.
 */
export async function withWeaveLock<T>(
  db: Db, bus: EventBus, weaveId: string,
  fn: (tx: Tx, weave: WeaveRow) => Promise<{ result: T; events: NewEvent[] }>,
): Promise<T> {
  const { result, committed } = await db.transaction(async (tx) => {
    const [weave] = await tx.select().from(weaves).where(eq(weaves.id, weaveId)).for("update");
    if (!weave) throw errors.weaveNotFound();
    const out = await fn(tx, weave);
    const committed = await appendInTx(tx, weave, out.events);
    return { result: out.result, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function readEvents(
  db: Db, weaveId: string, opts: { since?: number; threadId?: string; limit?: number },
): Promise<LoomEvent[]> {
  const conds = [eq(events.weaveId, weaveId)];
  if (opts.since !== undefined) conds.push(gt(events.seq, opts.since));
  if (opts.threadId) conds.push(eq(events.threadId, opts.threadId));
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await db.select().from(events).where(and(...conds)).orderBy(asc(events.seq)).limit(limit);
  return rows.map(toEvent);
}
```

Note on the "fails → not published" test: calling `appendInTx` inside `fn` is allowed (the lock is held); the transaction rolls back, so nothing is published.

- [ ] **Step 6: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/events.test.ts`
Expected: PASS, including the 20-writer concurrency test.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): event bus, actor resolution, locked append-only event log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Settings and keepers

**Files:**
- Create: `src/core/src/settings.ts`, `src/core/src/keepers.ts`
- Test: `src/core/test/settings-keepers.test.ts`

**Interfaces:**
- Produces:

```ts
// settings.ts
export async function getSettings(db): Promise<Settings>                       // creates the default row if missing
export async function updateSettings(db, actor: Actor, patch: Partial<Settings>): Promise<Settings>  // instance keeper only, validated
// keepers.ts
export type PublicKeeper = { id: string; name: string; createdAt: string };
export async function seedKeepers(db, tokens: string[]): Promise<void>        // idempotent; names "seed-1", "seed-2", ...
export async function listKeepers(db, actor): Promise<PublicKeeper[]>
export async function addKeeper(db, actor, name: string): Promise<{ keeper: PublicKeeper; token: string }>
export async function removeKeeper(db, actor, id: string): Promise<void>      // cannot remove yourself
```

- [ ] **Step 1: Write failing tests**

`src/core/test/settings-keepers.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { seedKeepers, listKeepers, addKeeper, removeKeeper } from "../src/keepers.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function keeperActor(): Promise<Actor> {
  await seedKeepers(db, ["tok-a"]);
  return resolveCredential(db, "tok-a");
}

describe("settings", () => {
  it("returns defaults on first read", async () => {
    expect(await getSettings(db)).toEqual({ instanceName: "Loom", maxMessageLength: 20000, openWeaveCreation: true });
  });
  it("keeper can update, others cannot", async () => {
    const k = await keeperActor();
    const s = await updateSettings(db, k, { instanceName: "Fragt Loom", openWeaveCreation: false });
    expect(s.instanceName).toBe("Fragt Loom");
    expect(s.openWeaveCreation).toBe(false);
    expect((await getSettings(db)).maxMessageLength).toBe(20000);
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(updateSettings(db, secret, { instanceName: "no" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("validates values", async () => {
    const k = await keeperActor();
    await expect(updateSettings(db, k, { maxMessageLength: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(updateSettings(db, k, { instanceName: "" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("keepers", () => {
  it("seed is idempotent and tokens resolve", async () => {
    await seedKeepers(db, ["tok-a", "tok-b"]);
    await seedKeepers(db, ["tok-a", "tok-b"]);
    const k = await resolveCredential(db, "tok-b");
    expect(k.kind).toBe("keeper");
    expect(await listKeepers(db, k)).toHaveLength(2);
  });
  it("add returns a token that works; remove revokes it; cannot remove self", async () => {
    const k = await keeperActor();
    const { keeper, token } = await addKeeper(db, k, "Ops");
    expect(keeper.name).toBe("Ops");
    const k2 = await resolveCredential(db, token);
    expect(k2.kind).toBe("keeper");
    await expect(removeKeeper(db, k2, (k2 as { keeperId: string }).keeperId)).rejects.toMatchObject({ code: "validation" });
    await removeKeeper(db, k, keeper.id);
    await expect(resolveCredential(db, token)).rejects.toMatchObject({ code: "invalid_token" });
  });
  it("non-keepers are refused", async () => {
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(listKeepers(db, secret)).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/settings-keepers.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement settings**

`src/core/src/settings.ts`:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/index.js";
import { settings } from "./db/schema.js";
import { errors } from "./errors.js";
import { assertInstanceKeeper } from "./actors.js";
import type { Actor, Settings } from "./types.js";

const patchSchema = z.object({
  instanceName: z.string().trim().min(1).max(64).optional(),
  maxMessageLength: z.number().int().min(1).max(1_000_000).optional(),
  openWeaveCreation: z.boolean().optional(),
}).strict();

function toSettings(r: typeof settings.$inferSelect): Settings {
  return { instanceName: r.instanceName, maxMessageLength: r.maxMessageLength, openWeaveCreation: r.openWeaveCreation };
}

export async function getSettings(db: Db): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (row) return toSettings(row);
  const [created] = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return toSettings(created);
  const [again] = await db.select().from(settings).where(eq(settings.id, 1));
  return toSettings(again!);
}

export async function updateSettings(db: Db, actor: Actor, patch: Partial<Settings>): Promise<Settings> {
  assertInstanceKeeper(actor);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) throw errors.validation(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  await getSettings(db);
  const [row] = await db.update(settings).set(parsed.data).where(eq(settings.id, 1)).returning();
  return toSettings(row!);
}
```

- [ ] **Step 4: Implement keepers**

`src/core/src/keepers.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { keepers } from "./db/schema.js";
import { errors } from "./errors.js";
import { newId, newSecret } from "./ids.js";
import { assertInstanceKeeper } from "./actors.js";
import type { Actor } from "./types.js";

export type PublicKeeper = { id: string; name: string; createdAt: string };

function toPublic(k: typeof keepers.$inferSelect): PublicKeeper {
  return { id: k.id, name: k.name, createdAt: k.createdAt.toISOString() };
}

/** Inserts each token once. Safe to call on every boot. */
export async function seedKeepers(db: Db, tokens: string[]): Promise<void> {
  const clean = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return;
  await db.insert(keepers)
    .values(clean.map((token, i) => ({ id: newId(), name: `seed-${i + 1}`, token })))
    .onConflictDoNothing({ target: keepers.token });
}

export async function listKeepers(db: Db, actor: Actor): Promise<PublicKeeper[]> {
  assertInstanceKeeper(actor);
  return (await db.select().from(keepers).orderBy(keepers.createdAt)).map(toPublic);
}

export async function addKeeper(db: Db, actor: Actor, name: string): Promise<{ keeper: PublicKeeper; token: string }> {
  assertInstanceKeeper(actor);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) throw errors.validation("Keeper name must be 1-64 characters");
  const token = newSecret();
  const [row] = await db.insert(keepers).values({ id: newId(), name: trimmed, token }).returning();
  return { keeper: toPublic(row!), token };
}

export async function removeKeeper(db: Db, actor: Actor, id: string): Promise<void> {
  assertInstanceKeeper(actor);
  if (actor.kind === "keeper" && actor.keeperId === id) throw errors.validation("A keeper cannot remove itself");
  const deleted = await db.delete(keepers).where(eq(keepers.id, id)).returning({ id: keepers.id });
  if (deleted.length === 0) throw errors.validation("No such keeper");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/settings-keepers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): settings and instance keepers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Weaves — create, get, join, archive, list

**Files:**
- Create: `src/core/src/weaves.ts`
- Test: `src/core/test/weaves.test.ts`

**Interfaces:**
- Consumes: `withWeaveLock`, `appendInTx`, `readEvents` (Task 4); `getSettings` (Task 5); `validateName`, `newId`, `newSecret`, `errors` (Task 3); actor helpers (Task 4).
- Produces:

```ts
export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind } };
export type CreateWeaveResult = { weave: PublicWeave; secret: string; participant: PublicParticipant; token: string; generalThread: PublicThread };
export type WeaveInfo = { weave: PublicWeave; threads: PublicThread[]; participants: PublicParticipant[] };
export async function createWeave(db, bus, input: CreateWeaveInput, actor?: Actor): Promise<CreateWeaveResult>
export async function getWeave(db, actor, weaveId): Promise<WeaveInfo>
export async function joinWeave(db, bus, secret: string, who: { name: string; kind: Kind }): Promise<{ weaveId: string; participant: PublicParticipant; token: string }>
export async function archiveWeave(db, bus, actor, weaveId): Promise<void>
export async function listWeaves(db, actor): Promise<PublicWeave[]>   // instance keeper only, includes archived
export function toPublicWeave(row): PublicWeave; export function toPublicThread(row): PublicThread
```

- [ ] **Step 1: Write failing tests**

`src/core/test/weaves.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, getWeave, joinWeave, archiveWeave, listWeaves } from "../src/weaves.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { updateSettings } from "../src/settings.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });

const input = { title: "PR #42", opener: "Review https://github.com/x/y/pull/42", creator: { name: "Claude", kind: "agent" as const } };

describe("createWeave", () => {
  it("creates weave, General, creator as keeper, and three events", async () => {
    const r = await createWeave(db, bus, input);
    expect(r.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.participant.role).toBe("keeper");
    expect(r.generalThread.isGeneral).toBe(true);
    expect(r.generalThread.name).toBe("General");
    const evs = await readEvents(db, r.weave.id, {});
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "participant.joined", "message"]);
    expect(evs[2]!.payload).toEqual({ text: input.opener, mentions: [] });
    expect(evs[2]!.actor).toBe(r.participant.id);
    const me = await resolveCredential(db, r.token);
    expect(me.kind).toBe("participant");
  });
  it("respects openWeaveCreation=false", async () => {
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await updateSettings(db, k, { openWeaveCreation: false });
    await expect(createWeave(db, bus, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWeave(db, bus, input, k)).resolves.toBeTruthy();
  });
  it("validates title and name", async () => {
    await expect(createWeave(db, bus, { ...input, title: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(createWeave(db, bus, { ...input, creator: { name: "a b", kind: "human" } })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("joinWeave", () => {
  it("adds a member and emits participant.joined", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    expect(j.weaveId).toBe(r.weave.id);
    expect(j.participant.role).toBe("member");
    const evs = await readEvents(db, r.weave.id, { since: 3 });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("participant.joined");
    expect(evs[0]!.payload).toMatchObject({ participantId: j.participant.id, name: "ChatGPT", kind: "agent", role: "member" });
  });
  it("rejects duplicate names case-insensitively", async () => {
    const r = await createWeave(db, bus, input);
    await expect(joinWeave(db, bus, r.secret, { name: "claude", kind: "human" })).rejects.toMatchObject({ code: "name_taken" });
  });
  it("rejects bad secret and archived weave", async () => {
    await expect(joinWeave(db, bus, "nope", { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_not_found" });
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(joinWeave(db, bus, r.secret, { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_archived" });
  });
});

describe("getWeave", () => {
  it("works with participant token, secret, and keeper; hides tokens", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const bySecret = await resolveCredential(db, r.secret);
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    for (const a of [me, bySecret, k]) {
      const info = await getWeave(db, a, r.weave.id);
      expect(info.weave.title).toBe("PR #42");
      expect(info.threads).toHaveLength(1);
      expect(info.participants).toHaveLength(1);
      expect(JSON.stringify(info)).not.toContain(r.token);
    }
  });
  it("refuses a credential from another weave", async () => {
    const a = await createWeave(db, bus, input);
    const b = await createWeave(db, bus, input);
    const meA = await resolveCredential(db, a.token);
    await expect(getWeave(db, meA, b.weave.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("archiveWeave / listWeaves", () => {
  it("keeper role archives; member cannot; archive is idempotent-rejecting", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "Member", kind: "human" });
    const member = await resolveCredential(db, j.token);
    await expect(archiveWeave(db, bus, member, r.weave.id)).rejects.toMatchObject({ code: "forbidden" });
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    const info = await getWeave(db, me, r.weave.id);
    expect(info.weave.archivedAt).not.toBeNull();
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last.type).toBe("weave.archived");
    await expect(archiveWeave(db, bus, me, r.weave.id)).rejects.toMatchObject({ code: "weave_archived" });
  });
  it("instance keeper archives without joining and lists all weaves", async () => {
    const r = await createWeave(db, bus, input);
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await archiveWeave(db, bus, k, r.weave.id);
    const all = await listWeaves(db, k);
    expect(all).toHaveLength(1);
    expect(all[0]!.archivedAt).not.toBeNull();
    const me = await resolveCredential(db, r.token);
    await expect(listWeaves(db, me)).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/weaves.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/src/weaves.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { weaves, threads, participants } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { newId, newSecret } from "./ids.js";
import { validateName } from "./names.js";
import { parseMentions } from "./mentions.js";
import { getSettings } from "./settings.js";
import { appendInTx, withWeaveLock } from "./events.js";
import { actorId, assertCanRead, assertInstanceKeeper, assertIsKeeperOf, toPublicParticipant } from "./actors.js";
import type { Actor, Kind, PublicParticipant, PublicThread, PublicWeave } from "./types.js";

export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind } };
export type CreateWeaveResult = {
  weave: PublicWeave; secret: string; participant: PublicParticipant; token: string; generalThread: PublicThread;
};
export type WeaveInfo = { weave: PublicWeave; threads: PublicThread[]; participants: PublicParticipant[] };

export function toPublicWeave(w: typeof weaves.$inferSelect): PublicWeave {
  return { id: w.id, title: w.title, createdAt: w.createdAt.toISOString(),
    archivedAt: w.archivedAt ? w.archivedAt.toISOString() : null, lastSeq: w.lastSeq };
}
export function toPublicThread(t: typeof threads.$inferSelect): PublicThread {
  return { id: t.id, weaveId: t.weaveId, name: t.name, isGeneral: t.isGeneral, createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(), closedAt: t.closedAt ? t.closedAt.toISOString() : null };
}

function isPgUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export async function createWeave(db: Db, bus: EventBus, input: CreateWeaveInput, actor?: Actor): Promise<CreateWeaveResult> {
  const settings = await getSettings(db);
  if (!settings.openWeaveCreation) {
    if (!actor) throw errors.forbidden("Weave creation is restricted to keepers");
    assertInstanceKeeper(actor);
  }
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) throw errors.validation("Title must be 1-200 characters");
  const name = validateName(input.creator.name);
  if (input.creator.kind !== "human" && input.creator.kind !== "agent") throw errors.validation("kind must be human or agent");
  const opener = input.opener ?? "";
  if (opener.length > settings.maxMessageLength) throw errors.messageTooLong(settings.maxMessageLength);

  const secret = newSecret();
  const token = newSecret();
  const weaveId = newId(); const threadId = newId(); const participantId = newId();

  const { result, committed } = await db.transaction(async (tx) => {
    const [w] = await tx.insert(weaves).values({ id: weaveId, secret, title }).returning();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: "General", isGeneral: true, createdBy: participantId }).returning();
    const [p] = await tx.insert(participants).values({ id: participantId, weaveId, name, kind: input.creator.kind, role: "keeper", token }).returning();
    const pub = toPublicParticipant(p!);
    const committed = await appendInTx(tx, w!, [
      { threadId, type: "thread.created", actor: participantId, payload: { threadId, name: "General" } },
      { threadId, type: "participant.joined", actor: participantId, payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } },
      { threadId, type: "message", actor: participantId, payload: { text: opener, mentions: parseMentions(opener, [pub]) } },
    ]);
    return { result: { weave: toPublicWeave(w!), secret, participant: pub, token, generalThread: toPublicThread(t!) }, committed };
  });
  for (const e of committed) bus.publish(e);
  return result;
}

export async function getWeave(db: Db, actor: Actor, weaveId: string): Promise<WeaveInfo> {
  assertCanRead(actor, weaveId);
  const [w] = await db.select().from(weaves).where(eq(weaves.id, weaveId));
  if (!w) throw errors.weaveNotFound();
  const ts = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt));
  const ps = await db.select().from(participants).where(eq(participants.weaveId, weaveId)).orderBy(asc(participants.joinedAt));
  return { weave: toPublicWeave(w), threads: ts.map(toPublicThread), participants: ps.map(toPublicParticipant) };
}

export async function joinWeave(db: Db, bus: EventBus, secret: string, who: { name: string; kind: Kind }) {
  const name = validateName(who.name);
  if (who.kind !== "human" && who.kind !== "agent") throw errors.validation("kind must be human or agent");
  const [found] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, secret));
  if (!found) throw errors.weaveNotFound();
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, found.id)).orderBy(asc(threads.createdAt)).limit(1);
  const token = newSecret();
  const participantId = newId();
  try {
    const participant = await withWeaveLock(db, bus, found.id, async (tx, weave) => {
      if (weave.archivedAt) throw errors.weaveArchived();
      const [p] = await tx.insert(participants).values({ id: participantId, weaveId: weave.id, name, kind: who.kind, role: "member", token }).returning();
      const pub = toPublicParticipant(p!);
      return { result: pub, events: [{ threadId: general!.id, type: "participant.joined" as const, actor: participantId,
        payload: { participantId, name: pub.name, kind: pub.kind, role: pub.role } }] };
    });
    return { weaveId: found.id, participant, token };
  } catch (e) {
    if (isPgUniqueViolation(e)) throw errors.nameTaken(name);
    throw e;
  }
}

export async function archiveWeave(db: Db, bus: EventBus, actor: Actor, weaveId: string): Promise<void> {
  assertIsKeeperOf(actor, weaveId);
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  await withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    await tx.update(weaves).set({ archivedAt: new Date() }).where(eq(weaves.id, weaveId));
    return { result: undefined, events: [{ threadId: general.id, type: "weave.archived" as const, actor: actorId(actor), payload: {} }] };
  });
}

export async function listWeaves(db: Db, actor: Actor): Promise<PublicWeave[]> {
  assertInstanceKeeper(actor);
  return (await db.select().from(weaves).orderBy(asc(weaves.createdAt))).map(toPublicWeave);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/weaves.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): weaves create/get/join/archive/list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Threads — create and close

**Files:**
- Create: `src/core/src/threads.ts`
- Test: `src/core/test/threads.test.ts`

**Interfaces:**
- Produces:

```ts
export async function createThread(db, bus, actor, weaveId, name: string): Promise<PublicThread>   // any participant; not on archived
export async function closeThread(db, bus, actor, threadId): Promise<void>                        // keeper of weave; not General; not already closed
export async function getThread(db, threadId): Promise<typeof threads.$inferSelect>              // throws thread_not_found
```

- [ ] **Step 1: Write failing tests**

`src/core/test/threads.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave, getWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("createThread", () => {
  it("any participant can create; event emitted in the new thread", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, member, r.weave.id, "Tests");
    expect(t.name).toBe("Tests");
    expect(t.isGeneral).toBe(false);
    expect(t.createdBy).toBe(j.participant.id);
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "thread.created", threadId: t.id, payload: { threadId: t.id, name: "Tests" } });
    expect((await getWeave(db, member, r.weave.id)).threads).toHaveLength(2);
  });
  it("secret-only and cross-weave credentials cannot create; validates name", async () => {
    const r = await createWeave(db, bus, input);
    const bySecret = await resolveCredential(db, r.secret);
    await expect(createThread(db, bus, bySecret, r.weave.id, "X")).rejects.toMatchObject({ code: "forbidden" });
    const me = await resolveCredential(db, r.token);
    await expect(createThread(db, bus, me, r.weave.id, "  ")).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(db, bus, me, r.weave.id, "x".repeat(101))).rejects.toMatchObject({ code: "validation" });
  });
  it("refused on archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(createThread(db, bus, me, r.weave.id, "X")).rejects.toMatchObject({ code: "weave_archived" });
  });
});

describe("closeThread", () => {
  it("weave keeper closes; member cannot; General cannot be closed; double close rejected", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, me, r.weave.id, "Tests");
    await expect(closeThread(db, bus, member, t.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(closeThread(db, bus, me, r.generalThread.id)).rejects.toMatchObject({ code: "validation" });
    await closeThread(db, bus, me, t.id);
    const info = await getWeave(db, me, r.weave.id);
    expect(info.threads.find((x) => x.id === t.id)!.closedAt).not.toBeNull();
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "thread.closed", threadId: t.id });
    await expect(closeThread(db, bus, me, t.id)).rejects.toMatchObject({ code: "thread_closed" });
  });
  it("instance keeper can close any thread; unknown thread is 404", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "Tests");
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await closeThread(db, bus, k, t.id);
    await expect(closeThread(db, bus, k, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "thread_not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/threads.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/src/threads.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { newId } from "./ids.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, assertParticipantOf } from "./actors.js";
import { toPublicThread } from "./weaves.js";
import type { Actor, PublicThread } from "./types.js";

export async function getThread(db: Db, threadId: string) {
  const [t] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!t) throw errors.threadNotFound();
  return t;
}

export async function createThread(db: Db, bus: EventBus, actor: Actor, weaveId: string, name: string): Promise<PublicThread> {
  const me = assertParticipantOf(actor, weaveId);
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) throw errors.validation("Thread name must be 1-100 characters");
  const threadId = newId();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [t] = await tx.insert(threads).values({ id: threadId, weaveId, name: trimmed, createdBy: me.id }).returning();
    return {
      result: toPublicThread(t!),
      events: [{ threadId, type: "thread.created" as const, actor: me.id, payload: { threadId, name: trimmed } }],
    };
  });
}

export async function closeThread(db: Db, bus: EventBus, actor: Actor, threadId: string): Promise<void> {
  const t = await getThread(db, threadId);
  assertIsKeeperOf(actor, t.weaveId);
  if (t.isGeneral) throw errors.validation("The General thread cannot be closed; archive the Weave instead");
  await withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select().from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    await tx.update(threads).set({ closedAt: new Date() }).where(eq(threads.id, threadId));
    return { result: undefined, events: [{ threadId, type: "thread.closed" as const, actor: actorId(actor), payload: { threadId } }] };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/threads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): threads create/close

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Messages

**Files:**
- Create: `src/core/src/messages.ts`
- Test: `src/core/test/messages.test.ts`

**Interfaces:**
- Produces: `postMessage(db, bus, actor, threadId, text): Promise<LoomEvent>`

- [ ] **Step 1: Write failing tests**

`src/core/test/messages.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread, closeThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import { updateSettings } from "../src/settings.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("postMessage", () => {
  it("posts with resolved mentions and publishes", async () => {
    const r = await createWeave(db, bus, input);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const me = await resolveCredential(db, r.token);
    const seen: number[] = [];
    bus.subscribe(r.weave.id, (e) => seen.push(e.seq));
    const ev = await postMessage(db, bus, me, r.generalThread.id, "hey @chatgpt look");
    expect(ev.type).toBe("message");
    expect(ev.actor).toBe(r.participant.id);
    expect(ev.payload).toEqual({ text: "hey @chatgpt look", mentions: [j.participant.id] });
    expect(seen).toEqual([ev.seq]);
  });
  it("rejects empty, too long, secret-only, wrong weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(postMessage(db, bus, me, r.generalThread.id, "   ")).rejects.toMatchObject({ code: "validation" });
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await updateSettings(db, k, { maxMessageLength: 5 });
    await expect(postMessage(db, bus, me, r.generalThread.id, "123456")).rejects.toMatchObject({ code: "message_too_long" });
    const bySecret = await resolveCredential(db, r.secret);
    await expect(postMessage(db, bus, bySecret, r.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    const other = await createWeave(db, bus, input);
    await expect(postMessage(db, bus, me, other.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("instance keepers cannot post (they are not participants)", async () => {
    const r = await createWeave(db, bus, input);
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await expect(postMessage(db, bus, k, r.generalThread.id, "x")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects closed thread and archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const t = await createThread(db, bus, me, r.weave.id, "X");
    await closeThread(db, bus, me, t.id);
    await expect(postMessage(db, bus, me, t.id, "x")).rejects.toMatchObject({ code: "thread_closed" });
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(postMessage(db, bus, me, r.generalThread.id, "x")).rejects.toMatchObject({ code: "weave_archived" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/messages.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/src/messages.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { getSettings } from "./settings.js";
import { parseMentions } from "./mentions.js";
import { withWeaveLock, readEvents } from "./events.js";
import { assertParticipantOf } from "./actors.js";
import { getThread } from "./threads.js";
import type { Actor, LoomEvent } from "./types.js";

export async function postMessage(db: Db, bus: EventBus, actor: Actor, threadId: string, text: string): Promise<LoomEvent> {
  const t = await getThread(db, threadId);
  const me = assertParticipantOf(actor, t.weaveId);
  if (text.trim().length === 0) throw errors.validation("Message text is empty");
  const settings = await getSettings(db);
  if (text.length > settings.maxMessageLength) throw errors.messageTooLong(settings.maxMessageLength);

  // The lock callback returns the seq the message will get (weave.lastSeq + 1 at lock time).
  const seq = await withWeaveLock(db, bus, t.weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [fresh] = await tx.select({ closedAt: threads.closedAt }).from(threads).where(eq(threads.id, threadId));
    if (fresh!.closedAt) throw errors.threadClosed();
    const ps = await tx.select({ id: participants.id, name: participants.name })
      .from(participants).where(eq(participants.weaveId, t.weaveId));
    const mentions = parseMentions(text, ps);
    return {
      result: weave.lastSeq + 1,
      events: [{ threadId, type: "message" as const, actor: me.id, payload: { text, mentions } }],
    };
  });
  // Re-read the committed row so `at` carries the database timestamp.
  const [row] = await readEvents(db, t.weaveId, { since: seq - 1, limit: 1 });
  return row!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): post messages with mentions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Participant roles

**Files:**
- Create: `src/core/src/participants.ts`
- Test: `src/core/test/participants.test.ts`

**Interfaces:**
- Produces: `setRole(db, bus, actor, weaveId, participantId, role: Role): Promise<PublicParticipant>`

- [ ] **Step 1: Write failing tests**

`src/core/test/participants.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { setRole } from "../src/participants.js";
import { readEvents } from "../src/events.js";
import { resolveCredential } from "../src/actors.js";
import { seedKeepers } from "../src/keepers.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };

describe("setRole", () => {
  it("weave keeper promotes and demotes; event emitted; new keeper can archive", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const p = await setRole(db, bus, me, r.weave.id, j.participant.id, "keeper");
    expect(p.role).toBe("keeper");
    const last = (await readEvents(db, r.weave.id, {})).at(-1)!;
    expect(last).toMatchObject({ type: "participant.role_changed", payload: { participantId: j.participant.id, role: "keeper" } });
    const member = await resolveCredential(db, j.token);
    expect((member as { participant: { role: string } }).participant.role).toBe("keeper");
    await setRole(db, bus, member, r.weave.id, r.participant.id, "member");
    await archiveWeave(db, bus, member, r.weave.id);
  });
  it("members cannot; instance keeper can; validation on role/participant; archived rejected", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "M", kind: "human" });
    const member = await resolveCredential(db, j.token);
    await expect(setRole(db, bus, member, r.weave.id, r.participant.id, "member")).rejects.toMatchObject({ code: "forbidden" });
    await seedKeepers(db, ["k"]);
    const k = await resolveCredential(db, "k");
    await setRole(db, bus, k, r.weave.id, j.participant.id, "keeper");
    await expect(setRole(db, bus, k, r.weave.id, j.participant.id, "boss" as never)).rejects.toMatchObject({ code: "validation" });
    await expect(setRole(db, bus, k, r.weave.id, "00000000-0000-0000-0000-000000000000", "member")).rejects.toMatchObject({ code: "validation" });
    await archiveWeave(db, bus, me, r.weave.id);
    await expect(setRole(db, bus, k, r.weave.id, j.participant.id, "member")).rejects.toMatchObject({ code: "weave_archived" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/participants.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/src/participants.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { participants, threads } from "./db/schema.js";
import type { EventBus } from "./bus.js";
import { errors } from "./errors.js";
import { withWeaveLock } from "./events.js";
import { actorId, assertIsKeeperOf, toPublicParticipant } from "./actors.js";
import type { Actor, PublicParticipant, Role } from "./types.js";

export async function setRole(db: Db, bus: EventBus, actor: Actor, weaveId: string, participantId: string, role: Role): Promise<PublicParticipant> {
  assertIsKeeperOf(actor, weaveId);
  if (role !== "member" && role !== "keeper") throw errors.validation("role must be member or keeper");
  const [general] = await db.select().from(threads).where(eq(threads.weaveId, weaveId)).orderBy(asc(threads.createdAt)).limit(1);
  if (!general) throw errors.weaveNotFound();
  return withWeaveLock(db, bus, weaveId, async (tx, weave) => {
    if (weave.archivedAt) throw errors.weaveArchived();
    const [p] = await tx.update(participants).set({ role })
      .where(and(eq(participants.id, participantId), eq(participants.weaveId, weaveId))).returning();
    if (!p) throw errors.validation("No such participant in this Weave");
    return {
      result: toPublicParticipant(p),
      events: [{ threadId: general.id, type: "participant.role_changed" as const, actor: actorId(actor), payload: { participantId, role } }],
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/participants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): participant role changes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Export

**Files:**
- Create: `src/core/src/export.ts`
- Test: `src/core/test/export.test.ts`

**Interfaces:**
- Produces: `exportWeave(db, actor, weaveId, format: "md" | "json"): Promise<string>`

JSON format: `{ weave, threads, participants, events }` (the `WeaveInfo` plus all events). Markdown format:

```
# <title>

- Created: <iso>
- Archived: <iso | no>
- Participants: Name (kind, role), ...

## <thread name>

**Name** · <iso>
<text>

_system: Name joined_ · <iso>
```

- [ ] **Step 1: Write failing tests**

`src/core/test/export.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { exportWeave } from "../src/export.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "PR 42", opener: "Look at this", creator: { name: "Claude", kind: "agent" as const } };

describe("exportWeave", () => {
  it("json contains everything, md is grouped by thread, secret can export archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, me, r.weave.id, "Design");
    await postMessage(db, bus, gpt, t.id, "I disagree @Claude");
    await archiveWeave(db, bus, me, r.weave.id);

    const bySecret = await resolveCredential(db, r.secret);
    const json = JSON.parse(await exportWeave(db, bySecret, r.weave.id, "json"));
    expect(json.weave.title).toBe("PR 42");
    expect(json.threads).toHaveLength(2);
    expect(json.participants).toHaveLength(2);
    expect(json.events.at(-1).type).toBe("weave.archived");
    expect(JSON.stringify(json)).not.toContain(r.token);

    const md = await exportWeave(db, bySecret, r.weave.id, "md");
    expect(md).toContain("# PR 42");
    expect(md.indexOf("## General")).toBeLessThan(md.indexOf("## Design"));
    expect(md).toContain("**ChatGPT**");
    expect(md).toContain("I disagree @Claude");
    expect(md).toContain("_system: ChatGPT joined_");
    expect(md).toContain("_system: Weave archived_");
  });
  it("rejects bad format and foreign credential", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(exportWeave(db, me, r.weave.id, "xml" as never)).rejects.toMatchObject({ code: "validation" });
    const other = await createWeave(db, bus, input);
    await expect(exportWeave(db, me, other.weave.id, "md")).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/core`: `pnpm vitest run test/export.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/src/export.ts`:

```ts
import type { Db } from "./db/index.js";
import { errors } from "./errors.js";
import { getWeave } from "./weaves.js";
import { readEvents } from "./events.js";
import type { Actor, LoomEvent, PublicParticipant } from "./types.js";

export async function exportWeave(db: Db, actor: Actor, weaveId: string, format: "md" | "json"): Promise<string> {
  if (format !== "md" && format !== "json") throw errors.validation("format must be md or json");
  const info = await getWeave(db, actor, weaveId);
  const all: LoomEvent[] = [];
  let since = 0;
  for (;;) {
    const page = await readEvents(db, weaveId, { since, limit: 1000 });
    all.push(...page);
    if (page.length < 1000) break;
    since = page.at(-1)!.seq;
  }
  if (format === "json") return JSON.stringify({ ...info, events: all }, null, 2);

  const byId = new Map(info.participants.map((p) => [p.id, p]));
  const who = (actorId: string) => actorId.startsWith("keeper:") ? "Keeper" : (byId.get(actorId)?.name ?? actorId);
  const nameOf = (pid: unknown) => (typeof pid === "string" ? byId.get(pid)?.name ?? pid : "?");
  const lines: string[] = [];
  lines.push(`# ${info.weave.title}`, "");
  lines.push(`- Created: ${info.weave.createdAt}`);
  lines.push(`- Archived: ${info.weave.archivedAt ?? "no"}`);
  lines.push(`- Participants: ${info.participants.map((p: PublicParticipant) => `${p.name} (${p.kind}, ${p.role})`).join(", ")}`, "");
  for (const t of info.threads) {
    lines.push(`## ${t.name}`, "");
    for (const e of all.filter((x) => x.threadId === t.id)) {
      if (e.type === "message") {
        lines.push(`**${who(e.actor)}** · ${e.at}`, String(e.payload.text ?? ""), "");
        continue;
      }
      const sys =
        e.type === "participant.joined" ? `${nameOf(e.payload.participantId)} joined` :
        e.type === "participant.role_changed" ? `${nameOf(e.payload.participantId)} is now ${String(e.payload.role)}` :
        e.type === "thread.created" ? `Thread "${String(e.payload.name)}" created by ${who(e.actor)}` :
        e.type === "thread.closed" ? `Thread closed by ${who(e.actor)}` :
        e.type === "weave.archived" ? "Weave archived" : e.type;
      lines.push(`_system: ${sys}_ · ${e.at}`, "");
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/core`: `pnpm vitest run test/export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): weave export as markdown and json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Core facade

**Files:**
- Modify: `src/core/src/index.ts` (replace placeholder)
- Test: `src/core/test/core.test.ts`

**Interfaces:**
- Produces the single object the server uses:

```ts
export type Core = ReturnType<typeof createCore>;
export function createCore(db: Db): {
  db: Db; bus: EventBus;
  resolveCredential(credential: string): Promise<Actor>;
  createWeave(input: CreateWeaveInput, actor?: Actor): Promise<CreateWeaveResult>;
  getWeave(actor: Actor, weaveId: string): Promise<WeaveInfo>;
  joinWeave(secret: string, who: { name: string; kind: Kind }): Promise<{ weaveId: string; participant: PublicParticipant; token: string }>;
  archiveWeave(actor: Actor, weaveId: string): Promise<void>;
  listWeaves(actor: Actor): Promise<PublicWeave[]>;
  readEvents(actor: Actor, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }): Promise<LoomEvent[]>;
  createThread(actor: Actor, weaveId: string, name: string): Promise<PublicThread>;
  closeThread(actor: Actor, threadId: string): Promise<void>;
  getThreadWeaveId(threadId: string): Promise<string>;
  postMessage(actor: Actor, threadId: string, text: string): Promise<LoomEvent>;
  setRole(actor: Actor, weaveId: string, participantId: string, role: Role): Promise<PublicParticipant>;
  exportWeave(actor: Actor, weaveId: string, format: "md" | "json"): Promise<string>;
  getSettings(): Promise<Settings>;
  updateSettings(actor: Actor, patch: Partial<Settings>): Promise<Settings>;
  seedKeepers(tokens: string[]): Promise<void>;
  listKeepers(actor: Actor): Promise<PublicKeeper[]>;
  addKeeper(actor: Actor, name: string): Promise<{ keeper: PublicKeeper; token: string }>;
  removeKeeper(actor: Actor, id: string): Promise<void>;
}
```

Also re-exports: `LoomError`, `errors`, `createDb`, `runMigrations`, `closeDb`, all types, `EventBus`.

- [ ] **Step 1: Write failing test**

`src/core/test/core.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { createCore, LoomError, type Core } from "../src/index.js";

afterAll(closeTestDb);
let core: Core;
beforeEach(async () => { core = createCore(await freshDb()); });

describe("createCore", () => {
  it("wires the full create → join → post → read → archive flow", async () => {
    const r = await core.createWeave({ title: "T", opener: "start", creator: { name: "Claude", kind: "agent" } });
    const j = await core.joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = await core.resolveCredential(j.token);
    const seen: number[] = [];
    core.bus.subscribe(r.weave.id, (e) => seen.push(e.seq));
    await core.postMessage(gpt, r.generalThread.id, "hello @Claude");
    const evs = await core.readEvents(gpt, r.weave.id, { since: 0 });
    expect(evs.map((e) => e.type)).toEqual(["thread.created", "participant.joined", "message", "participant.joined", "message"]);
    expect(seen).toEqual([5]);
    expect(await core.getThreadWeaveId(r.generalThread.id)).toBe(r.weave.id);
    const me = await core.resolveCredential(r.token);
    await core.archiveWeave(me, r.weave.id);
    await expect(core.postMessage(gpt, r.generalThread.id, "late")).rejects.toBeInstanceOf(LoomError);
  });
  it("readEvents enforces read access", async () => {
    const a = await core.createWeave({ title: "A", opener: "a", creator: { name: "X", kind: "human" } });
    const b = await core.createWeave({ title: "B", opener: "b", creator: { name: "Y", kind: "human" } });
    const meA = await core.resolveCredential(a.token);
    await expect(core.readEvents(meA, b.weave.id, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/core`: `pnpm vitest run test/core.test.ts`
Expected: FAIL, `createCore` is not exported.

- [ ] **Step 3: Implement**

`src/core/src/index.ts`:

```ts
import type { Db } from "./db/index.js";
import { EventBus } from "./bus.js";
import { resolveCredential, assertCanRead } from "./actors.js";
import { readEvents } from "./events.js";
import * as weaves from "./weaves.js";
import * as threads from "./threads.js";
import { postMessage } from "./messages.js";
import { setRole } from "./participants.js";
import { exportWeave } from "./export.js";
import { getSettings, updateSettings } from "./settings.js";
import * as keepers from "./keepers.js";
import type { Actor, Kind, Role, Settings } from "./types.js";

export type Core = ReturnType<typeof createCore>;

export function createCore(db: Db) {
  const bus = new EventBus();
  return {
    db, bus,
    resolveCredential: (credential: string) => resolveCredential(db, credential),
    createWeave: (input: weaves.CreateWeaveInput, actor?: Actor) => weaves.createWeave(db, bus, input, actor),
    getWeave: (actor: Actor, weaveId: string) => weaves.getWeave(db, actor, weaveId),
    joinWeave: (secret: string, who: { name: string; kind: Kind }) => weaves.joinWeave(db, bus, secret, who),
    archiveWeave: (actor: Actor, weaveId: string) => weaves.archiveWeave(db, bus, actor, weaveId),
    listWeaves: (actor: Actor) => weaves.listWeaves(db, actor),
    readEvents: async (actor: Actor, weaveId: string, opts: { since?: number; threadId?: string; limit?: number }) => {
      assertCanRead(actor, weaveId);
      return readEvents(db, weaveId, opts);
    },
    createThread: (actor: Actor, weaveId: string, name: string) => threads.createThread(db, bus, actor, weaveId, name),
    closeThread: (actor: Actor, threadId: string) => threads.closeThread(db, bus, actor, threadId),
    getThreadWeaveId: async (threadId: string) => (await threads.getThread(db, threadId)).weaveId,
    postMessage: (actor: Actor, threadId: string, text: string) => postMessage(db, bus, actor, threadId, text),
    setRole: (actor: Actor, weaveId: string, participantId: string, role: Role) => setRole(db, bus, actor, weaveId, participantId, role),
    exportWeave: (actor: Actor, weaveId: string, format: "md" | "json") => exportWeave(db, actor, weaveId, format),
    getSettings: () => getSettings(db),
    updateSettings: (actor: Actor, patch: Partial<Settings>) => updateSettings(db, actor, patch),
    seedKeepers: (tokens: string[]) => keepers.seedKeepers(db, tokens),
    listKeepers: (actor: Actor) => keepers.listKeepers(db, actor),
    addKeeper: (actor: Actor, name: string) => keepers.addKeeper(db, actor, name),
    removeKeeper: (actor: Actor, id: string) => keepers.removeKeeper(db, actor, id),
  };
}

export { LoomError, errors, type ErrorCode } from "./errors.js";
export { createDb, runMigrations, closeDb, type Db } from "./db/index.js";
export { EventBus } from "./bus.js";
export type { CreateWeaveInput, CreateWeaveResult, WeaveInfo } from "./weaves.js";
export type { PublicKeeper } from "./keepers.js";
export type * from "./types.js";
```

- [ ] **Step 4: Run all core tests**

Run from `src/core`: `pnpm test`
Expected: all files PASS. Then `pnpm typecheck` from repo root: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): createCore facade and public exports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Server foundation — app, error mapping, auth, tickets, test harness

**Files:**
- Create: `src/server/src/errors.ts`, `src/server/src/auth.ts`, `src/server/src/tickets.ts`, `src/server/src/app.ts`
- Create: `src/server/test/helpers.ts`, `src/server/test/foundation.test.ts`
- Modify: `src/core/src/index.ts` (export `assertCanRead`)

**Interfaces:**
- Produces:

```ts
// errors.ts
export function statusFor(code: ErrorCode): number
// auth.ts
export type Env = { Variables: { credential: string | null } };
export const bearer: MiddlewareHandler<Env>                       // sets c.var.credential from Authorization header
export async function requireActor(c, core): Promise<Actor>       // throws invalid_token when missing
export async function optionalActor(c, core): Promise<Actor | undefined>
// tickets.ts
export class TicketStore { constructor(ttlMs = 60_000); issue(credential: string): string; redeem(ticket: string): string | undefined; size(): number; stop(): void }
// app.ts
export type AppDeps = { core: Core; tickets: TicketStore };
export function buildApp(deps: AppDeps): Hono<Env>                // mounts /health and (Task 13) the /api routes
// test/helpers.ts
export async function startTestServer(): Promise<{ baseUrl: string; wsUrl: string; core: Core; tickets: TicketStore; close(): Promise<void> }>
```

- [ ] **Step 1: Export `assertCanRead` from core**

`assertCanRead` is already imported in `src/core/src/index.ts`. Add this line to the exports at the bottom of that file:

```ts
export { assertCanRead } from "./actors.js";
```

Run from `src/core`: `pnpm build` — must succeed so `@loom/server` can consume the new export. Server tests import `@loom/core` from its `dist`, so rebuild core after any core change before running server tests (root `pnpm test` does this automatically).

- [ ] **Step 2: Write failing tests**

`src/server/test/helpers.ts`:

```ts
import { serve, type ServerType } from "@hono/node-server";
import { createCore, type Core } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";
import { attachWebSocket } from "../src/ws.js";

export async function startTestServer(opts: { beforeReplay?: () => Promise<void> } = {}) {
  const core = createCore(await freshDb());
  const tickets = new TicketStore();
  const app = buildApp({ core, tickets });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  attachWebSocket(server, { core, tickets, beforeReplay: opts.beforeReplay });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    core, tickets,
    close: async () => {
      tickets.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await closeTestDb();
    },
  };
}

export async function api(baseUrl: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json: json as any, text };
}
```

Until Task 14 exists, create a stub `src/server/src/ws.ts` so the helper compiles:

```ts
import type { ServerType } from "@hono/node-server";
import type { Core } from "@loom/core";
import type { TicketStore } from "./tickets.js";

export function attachWebSocket(_server: ServerType, _deps: { core: Core; tickets: TicketStore; beforeReplay?: () => Promise<void> }): void {}
```

`src/server/test/foundation.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startTestServer, api } from "./helpers.js";
import { TicketStore } from "../src/tickets.js";
import { statusFor } from "../src/errors.js";

let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s.close(); });

describe("foundation", () => {
  it("GET /health", async () => {
    const r = await api(s.baseUrl, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });
  it("unknown route returns the error shape", async () => {
    const r = await api(s.baseUrl, "GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ code: "not_found" });
  });
  it("statusFor maps every code", () => {
    expect(statusFor("validation")).toBe(400);
    expect(statusFor("invalid_token")).toBe(401);
    expect(statusFor("forbidden")).toBe(403);
    expect(statusFor("weave_not_found")).toBe(404);
    expect(statusFor("thread_not_found")).toBe(404);
    expect(statusFor("weave_archived")).toBe(409);
    expect(statusFor("thread_closed")).toBe(409);
    expect(statusFor("name_taken")).toBe(409);
    expect(statusFor("message_too_long")).toBe(413);
  });
});

describe("TicketStore", () => {
  it("issues single-use tickets that expire", async () => {
    const store = new TicketStore(50);
    const t = store.issue("cred-1");
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.redeem(t)).toBe("cred-1");
    expect(store.redeem(t)).toBeUndefined();
    const t2 = store.issue("cred-2");
    await new Promise((r) => setTimeout(r, 80));
    expect(store.redeem(t2)).toBeUndefined();
    expect(store.size()).toBe(0);
    store.stop();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run from `src/server`: `pnpm vitest run test/foundation.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement errors, auth, tickets, app**

`src/server/src/errors.ts`:

```ts
import type { ErrorCode } from "@loom/core";

const map: Record<ErrorCode, number> = {
  validation: 400, invalid_token: 401, forbidden: 403,
  weave_not_found: 404, thread_not_found: 404,
  weave_archived: 409, thread_closed: 409, name_taken: 409,
  message_too_long: 413,
};

export function statusFor(code: ErrorCode): number { return map[code] ?? 500; }
```

`src/server/src/auth.ts`:

```ts
import type { Context, MiddlewareHandler } from "hono";
import { errors, type Actor, type Core } from "@loom/core";

export type Env = { Variables: { credential: string | null } };

export const bearer: MiddlewareHandler<Env> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  c.set("credential", m ? m[1]!.trim() : null);
  await next();
};

export async function requireActor(c: Context<Env>, core: Core): Promise<Actor> {
  const cred = c.get("credential");
  if (!cred) throw errors.invalidToken();
  return core.resolveCredential(cred);
}

export async function optionalActor(c: Context<Env>, core: Core): Promise<Actor | undefined> {
  const cred = c.get("credential");
  return cred ? core.resolveCredential(cred) : undefined;
}
```

`src/server/src/tickets.ts`:

```ts
import { randomBytes } from "node:crypto";

/** Single-use, short-lived tickets that carry a bearer credential into the WebSocket handshake. */
export class TicketStore {
  private tickets = new Map<string, { credential: string; expires: number }>();
  private timer: NodeJS.Timeout;

  constructor(private ttlMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), Math.max(1000, ttlMs));
    this.timer.unref();
  }

  issue(credential: string): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { credential, expires: Date.now() + this.ttlMs });
    return ticket;
  }

  redeem(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket);
    if (!entry) return undefined;
    this.tickets.delete(ticket);
    return entry.expires >= Date.now() ? entry.credential : undefined;
  }

  size(): number { this.sweep(); return this.tickets.size; }
  stop(): void { clearInterval(this.timer); }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
  }
}
```

`src/server/src/app.ts`:

```ts
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LoomError, type Core } from "@loom/core";
import { bearer, type Env } from "./auth.js";
import { statusFor } from "./errors.js";
import type { TicketStore } from "./tickets.js";

export type AppDeps = { core: Core; tickets: TicketStore };

export function buildApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", bearer);
  app.get("/health", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json({ code: "not_found", message: "No such route" }, 404));
  app.onError((err, c) => {
    if (err instanceof LoomError) return c.json({ code: err.code, message: err.message }, statusFor(err.code) as ContentfulStatusCode);
    if (err instanceof SyntaxError) return c.json({ code: "validation", message: "Body is not valid JSON" }, 400);
    console.error("unhandled", err);
    return c.json({ code: "internal", message: "Internal error" }, 500);
  });

  void deps; // routes mounted in Task 13
  return app;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `src/server`: `pnpm vitest run test/foundation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): hono app, error mapping, bearer auth, ticket store, test harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: REST routes

**Files:**
- Create: `src/server/src/routes/weaves.ts`, `src/server/src/routes/threads.ts`, `src/server/src/routes/admin.ts`, `src/server/src/routes/auth.ts`, `src/server/src/validate.ts`
- Modify: `src/server/src/app.ts` (mount routes)
- Test: `src/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `Core` (Task 11), `requireActor`/`optionalActor`, `TicketStore`.
- Produces the HTTP API from the spec:

| Method | Path | Body | Auth | Response |
|---|---|---|---|---|
| POST | `/api/weaves` | `{ title, opener, creator: { name, kind } }` | optional (keeper when creation closed) | 201 `CreateWeaveResult` |
| POST | `/api/weaves/:secret/join` | `{ name, kind }` | none | 201 `{ weaveId, participant, token }` |
| GET | `/api/weaves/:id` | | any for weave | 200 `WeaveInfo` |
| GET | `/api/weaves/:id/events?since=&thread=&limit=` | | any for weave | 200 `{ events }` |
| POST | `/api/weaves/:id/threads` | `{ name }` | participant | 201 `PublicThread` |
| POST | `/api/weaves/:id/archive` | | keeper of weave | 204 |
| PUT | `/api/weaves/:id/participants/:pid/role` | `{ role }` | keeper of weave | 200 `PublicParticipant` |
| GET | `/api/weaves/:id/export?format=md\|json` | | any for weave | 200 text/markdown or application/json |
| POST | `/api/threads/:id/messages` | `{ text }` | participant | 201 `LoomEvent` |
| POST | `/api/threads/:id/close` | | keeper of weave | 204 |
| POST | `/api/auth/ws-ticket` | | any | 200 `{ ticket, expiresInMs }` |
| GET | `/api/admin/weaves` | | instance keeper | 200 `{ weaves }` |
| GET/PUT | `/api/admin/settings` | `Partial<Settings>` | instance keeper | 200 `Settings` |
| GET | `/api/admin/keepers` | | instance keeper | 200 `{ keepers }` |
| POST | `/api/admin/keepers` | `{ name }` | instance keeper | 201 `{ keeper, token }` |
| DELETE | `/api/admin/keepers/:id` | | instance keeper | 204 |

- [ ] **Step 1: Write failing tests**

`src/server/test/routes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startTestServer, api } from "./helpers.js";

let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers(["keeper-token"]); });
afterAll(async () => { await s.close(); });

const creator = { title: "PR 42", opener: "Review https://example/pr/42", creator: { name: "Claude", kind: "agent" } };

describe("weaves", () => {
  it("create → join → get → events → thread → post → role → archive → export", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect(c.status).toBe(201);
    const { weave, secret, token, generalThread } = c.json;
    expect(secret).toHaveLength(43);

    const j = await api(s.baseUrl, "POST", `/api/weaves/${secret}/join`, { name: "ChatGPT", kind: "agent" });
    expect(j.status).toBe(201);
    const gpt = j.json.token as string;

    const g = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}`, undefined, secret);
    expect(g.status).toBe(200);
    expect(g.json.participants).toHaveLength(2);
    expect(g.text).not.toContain(token);

    const t = await api(s.baseUrl, "POST", `/api/weaves/${weave.id}/threads`, { name: "Design" }, gpt);
    expect(t.status).toBe(201);

    const m = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/messages`, { text: "hi @Claude" }, gpt);
    expect(m.status).toBe(201);
    expect(m.json.payload.mentions).toEqual([c.json.participant.id]);

    const e = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/events?since=3`, undefined, secret);
    expect(e.status).toBe(200);
    expect(e.json.events.map((x: { type: string }) => x.type)).toEqual(["participant.joined", "thread.created", "message"]);
    const e2 = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/events?thread=${generalThread.id}`, undefined, secret);
    expect(e2.json.events.every((x: { threadId: string }) => x.threadId === generalThread.id)).toBe(true);

    const role = await api(s.baseUrl, "PUT", `/api/weaves/${weave.id}/participants/${j.json.participant.id}/role`, { role: "keeper" }, token);
    expect(role.status).toBe(200);
    expect(role.json.role).toBe("keeper");

    const cl = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/close`, undefined, gpt);
    expect(cl.status).toBe(204);

    const a = await api(s.baseUrl, "POST", `/api/weaves/${weave.id}/archive`, undefined, token);
    expect(a.status).toBe(204);

    const late = await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "late" }, gpt);
    expect(late.status).toBe(409);
    expect(late.json.code).toBe("weave_archived");

    const md = await fetch(`${s.baseUrl}/api/weaves/${weave.id}/export?format=md`, { headers: { authorization: `Bearer ${secret}` } });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("# PR 42");
    const js = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/export?format=json`, undefined, secret);
    expect(js.json.events.at(-1).type).toBe("weave.archived");
  });

  it("maps errors: 401 no auth, 403 wrong weave, 404 bad secret, 409 name taken, 400 validation", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const b = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${a.json.weave.id}`)).status).toBe(401);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${a.json.weave.id}`, undefined, "garbage")).status).toBe(401);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${b.json.weave.id}`, undefined, a.json.token)).status).toBe(403);
    expect((await api(s.baseUrl, "POST", `/api/weaves/nope/join`, { name: "X", kind: "human" })).status).toBe(404);
    const dup = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { name: "claude", kind: "human" });
    expect(dup.status).toBe(409); expect(dup.json.code).toBe("name_taken");
    const bad = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { name: "a b", kind: "human" });
    expect(bad.status).toBe(400); expect(bad.json.code).toBe("validation");
    const shape = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { nope: 1 });
    expect(shape.status).toBe(400);
    const notJson = await fetch(`${s.baseUrl}/api/weaves`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
  });
});

describe("auth + admin", () => {
  it("issues ws tickets for any credential", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    for (const cred of [a.json.token, a.json.secret, "keeper-token"]) {
      const t = await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred);
      expect(t.status).toBe(200);
      expect(t.json.ticket).toHaveLength(43);
      expect(s.tickets.redeem(t.json.ticket)).toBe(cred);
    }
    expect((await api(s.baseUrl, "POST", "/api/auth/ws-ticket")).status).toBe(401);
  });

  it("admin endpoints require instance keeper", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect((await api(s.baseUrl, "GET", "/api/admin/weaves", undefined, a.json.token)).status).toBe(403);
    const list = await api(s.baseUrl, "GET", "/api/admin/weaves", undefined, "keeper-token");
    expect(list.status).toBe(200);
    expect(list.json.weaves.length).toBeGreaterThan(0);

    const st = await api(s.baseUrl, "PUT", "/api/admin/settings", { openWeaveCreation: false }, "keeper-token");
    expect(st.status).toBe(200); expect(st.json.openWeaveCreation).toBe(false);
    expect((await api(s.baseUrl, "POST", "/api/weaves", creator)).status).toBe(403);
    expect((await api(s.baseUrl, "POST", "/api/weaves", creator, "keeper-token")).status).toBe(201);
    await api(s.baseUrl, "PUT", "/api/admin/settings", { openWeaveCreation: true }, "keeper-token");
    expect((await api(s.baseUrl, "GET", "/api/admin/settings", undefined, "keeper-token")).json.openWeaveCreation).toBe(true);

    const add = await api(s.baseUrl, "POST", "/api/admin/keepers", { name: "Ops" }, "keeper-token");
    expect(add.status).toBe(201);
    expect((await api(s.baseUrl, "GET", "/api/admin/keepers", undefined, add.json.token)).status).toBe(200);
    expect((await api(s.baseUrl, "DELETE", `/api/admin/keepers/${add.json.keeper.id}`, undefined, "keeper-token")).status).toBe(204);
    expect((await api(s.baseUrl, "GET", "/api/admin/keepers", undefined, add.json.token)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/server`: `pnpm vitest run test/routes.test.ts`
Expected: FAIL (404 on every route).

- [ ] **Step 3: Implement validation helper and routes**

`src/server/src/validate.ts`:

```ts
import type { Context } from "hono";
import { z } from "zod";
import { errors } from "@loom/core";

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => { throw errors.validation("Body is not valid JSON"); });
  const r = schema.safeParse(raw);
  if (!r.success) throw errors.validation(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export const kindSchema = z.enum(["human", "agent"]);
export const roleSchema = z.enum(["member", "keeper"]);
```

`src/server/src/routes/weaves.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Core } from "@loom/core";
import { errors } from "@loom/core";
import { optionalActor, requireActor, type Env } from "../auth.js";
import { body, kindSchema, roleSchema } from "../validate.js";

export function weaveRoutes(core: Core) {
  const r = new Hono<Env>();

  r.post("/", async (c) => {
    const input = await body(c, z.object({
      title: z.string(), opener: z.string().default(""),
      creator: z.object({ name: z.string(), kind: kindSchema }),
    }));
    const actor = await optionalActor(c, core);
    return c.json(await core.createWeave(input, actor), 201);
  });

  r.post("/:secret/join", async (c) => {
    const who = await body(c, z.object({ name: z.string(), kind: kindSchema }));
    return c.json(await core.joinWeave(c.req.param("secret"), who), 201);
  });

  r.get("/:id", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.getWeave(actor, c.req.param("id")));
  });

  r.get("/:id/events", async (c) => {
    const actor = await requireActor(c, core);
    const q = z.object({
      since: z.coerce.number().int().min(0).optional(),
      thread: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    }).safeParse(c.req.query());
    if (!q.success) throw errors.validation("Invalid query parameters");
    const events = await core.readEvents(actor, c.req.param("id"), { since: q.data.since, threadId: q.data.thread, limit: q.data.limit });
    return c.json({ events });
  });

  r.post("/:id/threads", async (c) => {
    const actor = await requireActor(c, core);
    const { name } = await body(c, z.object({ name: z.string() }));
    return c.json(await core.createThread(actor, c.req.param("id"), name), 201);
  });

  r.post("/:id/archive", async (c) => {
    const actor = await requireActor(c, core);
    await core.archiveWeave(actor, c.req.param("id"));
    return c.body(null, 204);
  });

  r.put("/:id/participants/:pid/role", async (c) => {
    const actor = await requireActor(c, core);
    const { role } = await body(c, z.object({ role: roleSchema }));
    return c.json(await core.setRole(actor, c.req.param("id"), c.req.param("pid"), role));
  });

  r.get("/:id/export", async (c) => {
    const actor = await requireActor(c, core);
    const format = c.req.query("format") ?? "md";
    if (format !== "md" && format !== "json") throw errors.validation("format must be md or json");
    const out = await core.exportWeave(actor, c.req.param("id"), format);
    return format === "md"
      ? c.text(out, 200, { "content-type": "text/markdown; charset=utf-8" })
      : c.body(out, 200, { "content-type": "application/json; charset=utf-8" });
  });

  return r;
}
```

`src/server/src/routes/threads.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

export function threadRoutes(core: Core) {
  const r = new Hono<Env>();

  r.post("/:id/messages", async (c) => {
    const actor = await requireActor(c, core);
    const { text } = await body(c, z.object({ text: z.string() }));
    return c.json(await core.postMessage(actor, c.req.param("id"), text), 201);
  });

  r.post("/:id/close", async (c) => {
    const actor = await requireActor(c, core);
    await core.closeThread(actor, c.req.param("id"));
    return c.body(null, 204);
  });

  return r;
}
```

`src/server/src/routes/admin.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { errors, type Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

export function adminRoutes(core: Core) {
  const r = new Hono<Env>();

  r.get("/weaves", async (c) => c.json({ weaves: await core.listWeaves(await requireActor(c, core)) }));

  r.get("/settings", async (c) => {
    const actor = await requireActor(c, core);
    if (actor.kind !== "keeper") throw errors.forbidden("Instance keeper required");
    return c.json(await core.getSettings());
  });

  r.put("/settings", async (c) => {
    const actor = await requireActor(c, core);
    const patch = await body(c, z.object({
      instanceName: z.string().optional(), maxMessageLength: z.number().optional(), openWeaveCreation: z.boolean().optional(),
    }));
    return c.json(await core.updateSettings(actor, patch));
  });

  r.get("/keepers", async (c) => c.json({ keepers: await core.listKeepers(await requireActor(c, core)) }));

  r.post("/keepers", async (c) => {
    const actor = await requireActor(c, core);
    const { name } = await body(c, z.object({ name: z.string() }));
    return c.json(await core.addKeeper(actor, name), 201);
  });

  r.delete("/keepers/:id", async (c) => {
    await core.removeKeeper(await requireActor(c, core), c.req.param("id"));
    return c.body(null, 204);
  });

  return r;
}
```

`src/server/src/routes/auth.ts`:

```ts
import { Hono } from "hono";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import type { TicketStore } from "../tickets.js";

export const TICKET_TTL_MS = 60_000;

export function authRoutes(core: Core, tickets: TicketStore) {
  const r = new Hono<Env>();
  r.post("/ws-ticket", async (c) => {
    await requireActor(c, core);               // validates the credential
    const ticket = tickets.issue(c.get("credential")!);
    return c.json({ ticket, expiresInMs: TICKET_TTL_MS });
  });
  return r;
}
```

- [ ] **Step 4: Mount routes in app**

Replace the `void deps;` line in `src/server/src/app.ts` with:

```ts
  app.route("/api/weaves", weaveRoutes(deps.core));
  app.route("/api/threads", threadRoutes(deps.core));
  app.route("/api/admin", adminRoutes(deps.core));
  app.route("/api/auth", authRoutes(deps.core, deps.tickets));
```

and add the imports at the top:

```ts
import { weaveRoutes } from "./routes/weaves.js";
import { threadRoutes } from "./routes/threads.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `src/server`: `pnpm vitest run test/routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): REST routes for weaves, threads, admin, and ws tickets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: WebSocket stream with gap-free replay/live handoff

**Files:**
- Modify: `src/server/src/ws.ts` (replace stub)
- Test: `src/server/test/ws.test.ts`

**Interfaces:**
- Produces: `attachWebSocket(server, { core, tickets, beforeReplay? })`. Protocol:
  - Client connects to `ws://host/api/weaves/:id/stream?since=<seq>&ticket=<ticket>`.
  - Handshake rejected with HTTP `401` (bad/expired ticket), `403` (credential not for this weave), `404` (bad path/weave) before upgrade.
  - After upgrade, every text frame is one `LoomEvent` as JSON. Server sends `{ "type": "ping" }` every 30 s; clients ignore it.
  - Handoff order: subscribe → replay from DB (`seq > since`, paged by 500) → flush buffer dropping `seq <= lastSent` → live.
  - `beforeReplay` is a test hook awaited between subscribe and replay; production passes nothing.

- [ ] **Step 1: Write failing tests**

`src/server/test/ws.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { startTestServer, api } from "./helpers.js";
import type { LoomEvent } from "@loom/core";

let gate: { resolve: () => void; promise: Promise<void> } | undefined;
let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  s = await startTestServer({ beforeReplay: async () => { if (gate) await gate.promise; } });
});
afterAll(async () => { await s.close(); });

const creator = { title: "T", opener: "start", creator: { name: "Claude", kind: "agent" } };

async function ticket(cred: string) {
  return (await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred)).json.ticket as string;
}

function collect(url: string, until: (evs: LoomEvent[]) => boolean, timeoutMs = 5000): Promise<{ events: LoomEvent[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: LoomEvent[] = [];
    const timer = setTimeout(() => reject(new Error(`timeout; got seqs ${events.map((e) => e.seq)}`)), timeoutMs);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") return;
      events.push(msg);
      if (until(events)) { clearTimeout(timer); resolve({ events, ws }); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); });
  });
}

describe("stream", () => {
  it("replays from since, then streams live", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const t = await ticket(secret);
    const pending = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=1&ticket=${t}`, (evs) => evs.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "live one" }, token);
    const { events, ws } = await pending;
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(events[2]!.payload).toMatchObject({ text: "live one" });
    ws.close();
  });

  it("delivers an event committed during replay exactly once, in order", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    for (let i = 0; i < 5; i++) await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `m${i}` }, token);
    // seqs now 1..8
    let release!: () => void;
    gate = { resolve: () => release(), promise: new Promise<void>((r) => { release = r; }) };
    const t = await ticket(secret);
    const pending = collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${t}`, (evs) => evs.length === 10);
    await new Promise((r) => setTimeout(r, 100)); // handler is now subscribed and parked before replay
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "during" }, token); // seq 9
    gate.resolve(); gate = undefined;
    await new Promise((r) => setTimeout(r, 100));
    await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "after" }, token); // seq 10
    const { events, ws } = await pending;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    ws.close();
  });

  it("reconnect with since resumes without loss under concurrent writers", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token, generalThread, secret } = c.json;
    const first = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=0&ticket=${await ticket(secret)}`, (evs) => evs.length === 3);
    first.ws.close();
    await Promise.all(Array.from({ length: 15 }, (_, i) =>
      api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: `p${i}` }, token)));
    const last = first.events.at(-1)!.seq;
    const second = await collect(`${s.wsUrl}/api/weaves/${weave.id}/stream?since=${last}&ticket=${await ticket(secret)}`, (evs) => evs.length === 15);
    expect(second.events.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => last + 1 + i));
    second.ws.close();
  });

  it("rejects bad ticket, reused ticket, foreign credential, unknown weave", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const b = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const status = (url: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("error", () => {});
    });
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=nope`)).toBe(401);
    const t = await ticket(a.json.token);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(101);
    expect(await status(`${s.wsUrl}/api/weaves/${a.json.weave.id}/stream?ticket=${t}`)).toBe(401);
    expect(await status(`${s.wsUrl}/api/weaves/${b.json.weave.id}/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    expect(await status(`${s.wsUrl}/api/weaves/00000000-0000-0000-0000-000000000000/stream?ticket=${await ticket(a.json.token)}`)).toBe(403);
    expect(await status(`${s.wsUrl}/api/other?ticket=${await ticket(a.json.token)}`)).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/server`: `pnpm vitest run test/ws.test.ts`
Expected: FAIL (stub never upgrades; sockets error).

- [ ] **Step 3: Implement**

`src/server/src/ws.ts`:

```ts
import type { ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { assertCanRead, LoomError, type Actor, type Core, type LoomEvent } from "@loom/core";
import { statusFor } from "./errors.js";
import type { TicketStore } from "./tickets.js";

export type WsDeps = { core: Core; tickets: TicketStore; beforeReplay?: () => Promise<void> };

const PATH_RE = /^\/api\/weaves\/([^/]+)\/stream$/;
const PAGE = 500;
const PING_MS = 30_000;

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocket(server: ServerType, deps: WsDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = PATH_RE.exec(url.pathname);
      if (!m) return reject(socket, 404, "Not Found");
      const weaveId = m[1]!;
      const since = Number(url.searchParams.get("since") ?? "0");
      if (!Number.isInteger(since) || since < 0) return reject(socket, 400, "Bad Request");
      const credential = deps.tickets.redeem(url.searchParams.get("ticket") ?? "");
      if (!credential) return reject(socket, 401, "Unauthorized");
      const actor = await deps.core.resolveCredential(credential);
      assertCanRead(actor, weaveId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        void stream(ws, weaveId, since, actor, deps);
      });
    } catch (e) {
      if (e instanceof LoomError) return reject(socket, statusFor(e.code), e.code);
      console.error("ws upgrade failed", e);
      return reject(socket, 500, "Internal Server Error");
    }
  });
}

async function stream(ws: WebSocket, weaveId: string, since: number, actor: Actor, deps: WsDeps) {
  const send = (e: LoomEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  let lastSent = since;
  let live = false;
  const buffer: LoomEvent[] = [];

  // 1. Subscribe first so nothing committed from now on can be missed.
  const unsubscribe = deps.core.bus.subscribe(weaveId, (e) => {
    if (live) { if (e.seq > lastSent) { lastSent = e.seq; send(e); } }
    else buffer.push(e);
  });
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, PING_MS);
  ws.on("close", () => { unsubscribe(); clearInterval(ping); });

  try {
    if (deps.beforeReplay) await deps.beforeReplay();
    // 2. Replay from the database.
    for (;;) {
      const page = await deps.core.readEvents(actor, weaveId, { since: lastSent, limit: PAGE });
      for (const e of page) { lastSent = e.seq; send(e); }
      if (page.length < PAGE) break;
    }
    // 3. Flush what arrived during replay, dropping anything already sent.
    buffer.sort((a, b) => a.seq - b.seq);
    for (const e of buffer) if (e.seq > lastSent) { lastSent = e.seq; send(e); }
    buffer.length = 0;
    // 4. Live.
    live = true;
  } catch (e) {
    console.error("ws stream failed", e);
    ws.close(1011, "stream failed");
  }
}
```

Note: `assertCanRead` throws `forbidden` for a weave id that does not belong to the credential, which also covers unknown weave ids for participant/secret credentials (the test expects 403 there). Instance keepers pass `assertCanRead` for any id; an unknown id then simply streams nothing.

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/server`: `pnpm vitest run test/ws.test.ts`
Expected: PASS. Then run the whole server suite: `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): websocket event stream with ticket auth and gap-free handoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Entrypoint, Docker, Caddy, local run scripts

**Files:**
- Modify: `src/server/src/main.ts` (replace placeholder)
- Create: `src/server/src/config.ts`, `src/server/Dockerfile`, `.dockerignore`
- Create: `docker-compose.yml`, `Caddyfile`, `run.sh`, `run.ps1`
- Modify: `README.md` (add "Running locally" section)

**Interfaces:**
- Consumes: `buildApp`, `attachWebSocket`, `TicketStore`, `createDb`, `runMigrations`, `createCore`.
- Produces: `loadConfig(env): Config` with `{ port, databaseUrl, keeperTokens }`; a running server on `PORT`; `https://localhost` locally via Caddy.

- [ ] **Step 1: Write failing config test**

`src/server/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", LOOM_KEEPER_TOKENS: " a , b ,, " });
    expect(c).toEqual({ port: 3000, databaseUrl: "postgres://x", keeperTokens: ["a", "b"] });
  });
  it("requires DATABASE_URL and a numeric PORT", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "x", PORT: "abc" })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/server`: `pnpm vitest run test/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement config and main**

`src/server/src/config.ts`:

```ts
export type Config = { port: number; databaseUrl: string; keeperTokens: string[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  const keeperTokens = (env.LOOM_KEEPER_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return { port, databaseUrl, keeperTokens };
}
```

`src/server/src/main.ts`:

```ts
import { serve } from "@hono/node-server";
import { createCore, createDb, runMigrations } from "@loom/core";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { TicketStore } from "./tickets.js";
import { attachWebSocket } from "./ws.js";

async function main() {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  await runMigrations(db);
  const core = createCore(db);
  await core.seedKeepers(config.keeperTokens);
  const tickets = new TicketStore();
  const app = buildApp({ core, tickets });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(`loom server listening on http://0.0.0.0:${info.port} (keepers seeded: ${config.keeperTokens.length})`);
  });
  attachWebSocket(server, { core, tickets });

  const shutdown = () => { console.log("shutting down"); tickets.stop(); server.close(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Never log `config.keeperTokens` or any request `Authorization` header.

- [ ] **Step 4: Run config test**

Run from `src/server`: `pnpm vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Docker image**

`.dockerignore` (repo root):

```
node_modules
**/node_modules
**/dist
.git
caddy-data
```

`src/server/Dockerfile` (build context is the repo root):

```dockerfile
FROM node:24-alpine AS build
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY src/core/package.json src/core/
COPY src/server/package.json src/server/
RUN pnpm install --frozen-lockfile
COPY src/core src/core
COPY src/server src/server
RUN pnpm --filter @loom/core build && pnpm --filter @loom/server build
RUN pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/core/package.json ./src/core/package.json
COPY --from=build /app/src/core/dist ./src/core/dist
COPY --from=build /app/src/core/drizzle ./src/core/drizzle
COPY --from=build /app/src/core/node_modules ./src/core/node_modules
COPY --from=build /app/src/server/package.json ./src/server/package.json
COPY --from=build /app/src/server/dist ./src/server/dist
COPY --from=build /app/src/server/node_modules ./src/server/node_modules
ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/src/server
CMD ["node", "dist/main.js"]
```

pnpm's `node_modules` symlinks are relative, so copying the same directory layout keeps them valid. `runMigrations` resolves `drizzle/` relative to `src/core/dist/db/`, which is why `src/core/drizzle` is copied.

- [ ] **Step 6: Compose and Caddy**

`Caddyfile`:

```
{$LOOM_DOMAIN:localhost} {
	reverse_proxy loom:3000
}
```

Caddy issues Let's Encrypt certificates for public hostnames and uses its internal CA for `localhost`, so one file covers both cases.

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: loom
      POSTGRES_PASSWORD: loom
      POSTGRES_DB: loom
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U loom"]
      interval: 5s
      timeout: 3s
      retries: 20

  loom:
    build:
      context: .
      dockerfile: src/server/Dockerfile
    environment:
      DATABASE_URL: postgres://loom:loom@postgres:5432/loom
      LOOM_KEEPER_TOKENS: ${LOOM_KEEPER_TOKENS:-}
      PORT: "3000"
    depends_on:
      postgres:
        condition: service_healthy
    profiles: ["prod"]

  caddy:
    image: caddy:2-alpine
    environment:
      LOOM_DOMAIN: ${LOOM_DOMAIN:-localhost}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    profiles: ["prod"]

  caddy-dev:
    image: caddy:2-alpine
    command: caddy reverse-proxy --from localhost --to host.docker.internal:3000
    ports:
      - "443:443"
      - "80:80"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - caddy_data:/data
    profiles: ["dev"]

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

Production: `docker compose --profile prod up -d --build`. Local dev: profile `dev` runs Postgres + a Caddy that proxies `https://localhost` to the server running on the host with `tsx watch`.

- [ ] **Step 7: Local run scripts**

`run.sh`:

```bash
#!/usr/bin/env bash
# Starts Postgres + Caddy (https://localhost) in Docker and the server on the host in watch mode.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then cp .env.example .env; echo "created .env from .env.example"; fi
set -a; . ./.env; set +a
export DATABASE_URL="${DATABASE_URL:-postgres://loom:loom@localhost:5432/loom}"
docker compose --profile dev up -d postgres caddy-dev
echo "waiting for postgres..."
until docker compose exec -T postgres pg_isready -U loom >/dev/null 2>&1; do sleep 1; done
echo "Loom: https://localhost  (API on http://localhost:3000)"
pnpm --filter @loom/server dev
```

`run.ps1`:

```powershell
# Starts Postgres + Caddy (https://localhost) in Docker and the server on the host in watch mode.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "created .env from .env.example" }
Get-Content .env | Where-Object { $_ -match '^\s*[^#][^=]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
}
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = "postgres://loom:loom@localhost:5432/loom" }
docker compose --profile dev up -d postgres caddy-dev
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "waiting for postgres..."
do { Start-Sleep -Seconds 1; docker compose exec -T postgres pg_isready -U loom *> $null } until ($LASTEXITCODE -eq 0)
Write-Host "Loom: https://localhost  (API on http://localhost:3000)"
pnpm --filter @loom/server dev
```

- [ ] **Step 8: Smoke test the stack**

Run `./build.ps1` then `./run.ps1` (or the `.sh` variants). In another shell:

```bash
curl -sk https://localhost/health
```

Expected: `{"ok":true}`. The first `https://localhost` visit in a browser warns about Caddy's local CA; run `docker compose exec caddy-dev caddy trust` once to install it, or accept the warning.

Then:

```bash
curl -s -X POST http://localhost:3000/api/weaves -H 'content-type: application/json' \
  -d '{"title":"smoke","opener":"hello","creator":{"name":"Paw","kind":"human"}}'
```

Expected: 201 JSON with `secret` and `token`. Stop with Ctrl+C; `docker compose --profile dev down` stops the containers.

- [ ] **Step 9: README section**

Append to `README.md`:

```markdown
## Running locally

Prerequisites: Node 24, Docker Desktop.

    ./build.ps1     # or ./build.sh — installs and builds everything
    ./run.ps1       # or ./run.sh   — Postgres + Caddy in Docker, server on the host at https://localhost

Tests (need Docker for the Postgres testcontainer):

    pnpm test

Production: copy `.env.example` to `.env`, set `LOOM_DOMAIN` and `LOOM_KEEPER_TOKENS`, then
`docker compose --profile prod up -d --build`.
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(server): entrypoint, docker image, compose with caddy tls, local run scripts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review

**Spec coverage.** Domain model → Tasks 2–10. Rules (secret read-only credential, archive, close, roles, mentions, name uniqueness, seq under row lock) → Tasks 4–9. REST table incl. ticket endpoint → Task 13. WS ticket auth and gap-free handoff → Task 14. Keeper seeding, settings → Tasks 5, 15. TLS via Caddy, local `https://localhost`, Docker image, compose, `.env`, build/run scripts → Task 15. Error shape and codes → Tasks 3, 12. Testing requirements (real Postgres, concurrency, reconnect, mid-replay) → Tasks 4, 14. Not in this plan by design: remote MCP `/mcp`, `client`, `web`, `cli`, `claude-channel`, export tool naming for MCP — plans 2 and 3.

**Known gaps to carry into plan 2/3.** Static web UI serving from `server` is added when `web` exists. `LOOM_ALLOW_INSECURE` is a client-side rule and lands with `client`.

**Type consistency.** `Actor`, `LoomEvent`, `PublicParticipant`, `PublicThread`, `PublicWeave`, `Settings` defined once in `types.ts` and used unchanged. `withWeaveLock(db, bus, weaveId, fn)` signature is identical in Tasks 4, 6, 7, 8, 9. `Core` method names in Task 11 match the calls in Tasks 13–15.

