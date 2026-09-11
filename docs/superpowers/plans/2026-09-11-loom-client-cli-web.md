# Loom Client + CLI + Web UI Implementation Plan (plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give humans and shell-capable agents a way into Loom: a shared TypeScript client for the REST/WebSocket API, the `loom` CLI with JSON I/O, and the minimal web chat UI served by the server at `/w/<secret>`.

**Architecture:** `@loom/client` is a dependency-free TypeScript library over the server's REST + WebSocket API (global `fetch`/`WebSocket`, works in Node 24 and browsers), including the ticket handshake and cursor-based reconnect. `@loom/cli` wraps the client with commander and a per-user config file. `@loom/web` is a Vite + Preact single page whose state lives in a framework-free session store built on the client; the server serves the built page at `/w/<secret>`. All three are tested against the real server + Postgres testcontainer from plan 1.

**Tech Stack:** Node 24, pnpm 10.34.5, TypeScript 5.9.3, Vitest 4.1.11, commander 15.0.0, Vite 7.3.6, @preact/preset-vite 2.10.6, preact 10.29.8, marked 18.0.12.

Spec: `docs/superpowers/specs/2026-09-10-loom-v1-design.md` (sections 4, 5, 6). Plan 1 (`docs/superpowers/plans/2026-09-10-loom-core-server.md`) delivered `@loom/core` and `@loom/server`; this plan builds on branch `feat/core-server` (PR #1) and is executed on a branch stacked on it.

## Global Constraints

- All source code lives under `src/`. New packages: `src/client`, `src/cli`, `src/web`. ESM only, TypeScript strict, `verbatimModuleSyntax`.
- `@loom/client` has no runtime dependencies and must not import `@loom/core` at runtime (it may not import it at all; it defines its own API types).
- Clients accept only `https://` / `wss://` URLs. `http://` is permitted only for `localhost`, `127.0.0.1`, `[::1]` and only when explicitly allowed (`allowInsecure: true`, set by the CLI from `LOOM_ALLOW_INSECURE=1`, and by the web page when it is itself served over `http:`).
- Tokens never appear in URLs; the WebSocket handshake uses a single-use ticket from `POST /api/auth/ws-ticket` (query param `ticket`), cursor param `since`.
- Error shape from the server is `{ code, message }`; the client surfaces it as `LoomClientError { code, message, status }`. Client-side codes: `insecure_url`, `network`, `bad_response`.
- CLI: every command supports `--json`; base URL from `--url` or `LOOM_URL`; tokens stored in `~/.loom/config.json` keyed by Weave id (`LOOM_CONFIG` overrides the path); `loom create` and `loom join` store the returned token; `loom read --follow` prints one JSON object per line.
- Web UI route `/w/<secret>`: loads and streams with the secret as read-only credential; composer prompts for a name on first post, joins, stores the token in `localStorage`; return visits skip the prompt; archived Weaves show read-only with no composer; archive/close controls only when the participant's role permits; Markdown rendered; `@mentions` highlighted; system events muted; `@` autocomplete inserts `@name ` verbatim.
- Participant names: 1–32 chars `[A-Za-z0-9_.-]`.
- Server serves the built web UI: `/w/:secret` → `index.html`, `/assets/*` → static; Docker image includes the built web UI.
- Secrets and tokens are never logged (CLI human output may print the secret/token once on `create`/`join` because that is the purpose of those commands).
- Pinned versions: commander 15.0.0, vite 7.3.6, @preact/preset-vite 2.10.6, preact 10.29.8, marked 18.0.12; everything else as plan 1.
- Tests: Vitest; integration tests run against the real server via `src/server/test/helpers.ts` (`startTestServer`, `api`, `keeperToken`) which starts a Postgres testcontainer through `src/core/test/global-setup.ts`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
src/client/                      @loom/client
  package.json  tsconfig.json  tsconfig.test.json  vitest.config.ts
  src/index.ts                   public exports
  src/types.ts                   API shapes (Weave, Thread, Participant, LoomEvent, ...)
  src/errors.ts                  LoomClientError
  src/url.ts                     resolveBaseUrl(), toWsUrl()
  src/http.ts                    request(): fetch + error mapping
  src/client.ts                  LoomClient (REST methods, admin, wsTicket)
  src/stream.ts                  openStream(): ticket + WebSocket + reconnect
  test/url.test.ts  test/client.test.ts  test/stream.test.ts
src/cli/                         @loom/cli  (bin: loom)
  package.json  tsconfig.json  tsconfig.test.json  vitest.config.ts
  bin/loom.js                    #!/usr/bin/env node → ../dist/main.js
  src/main.ts                    process entry: runCli(argv, io) → exit code
  src/cli.ts                     runCli(): commander program, global options, error handling
  src/config.ts                  ConfigStore: ~/.loom/config.json
  src/context.ts                 CliContext: resolves url/weave/token/client from options+config
  src/output.ts                  print(): --json vs human
  src/commands/weave.ts          create, join, info, archive, export, role
  src/commands/messages.ts       post, read (--follow, --count)
  src/commands/thread.ts         thread new, thread close
  src/commands/admin.ts          admin weaves|settings|keepers
  test/config.test.ts  test/cli.test.ts
src/web/                         @loom/web
  package.json  tsconfig.json  tsconfig.test.json  vite.config.ts  vitest.config.ts
  index.html
  src/main.tsx                   mount
  src/app.tsx                    route /w/<secret>, wires session → components
  src/session.ts                 createSession(): framework-free state store over @loom/client
  src/markdown.ts                renderMarkdown(text, participants): safe HTML + mention highlight
  src/storage.ts                 KeyValueStorage interface + localStorage impl
  src/components/ThreadList.tsx  MessageList.tsx  Composer.tsx  NamePrompt.tsx  Header.tsx
  src/styles.css
  test/markdown.test.ts  test/session.test.ts
src/server/src/app.ts            + static hosting (webDist option)
src/server/src/main.ts           + LOOM_WEB_DIST
src/server/Dockerfile            + web build stage
run.sh  run.ps1                  + build web before starting
README.md                        + CLI + web usage
```

---

### Task 1: Client package scaffold, types, errors, URL rules

**Files:**
- Create: `src/client/package.json`, `src/client/tsconfig.json`, `src/client/tsconfig.test.json`, `src/client/vitest.config.ts`
- Create: `src/client/src/types.ts`, `src/client/src/errors.ts`, `src/client/src/url.ts`, `src/client/src/index.ts`
- Test: `src/client/test/url.test.ts`

**Interfaces:**
- Produces:

```ts
// types.ts
export type Kind = "human" | "agent"; export type Role = "member" | "keeper";
export type Weave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number };
export type Thread = { id: string; weaveId: string; name: string; isGeneral: boolean; createdBy: string; createdAt: string; closedAt: string | null };
export type Participant = { id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string };
export type EventType = "message" | "participant.joined" | "participant.role_changed" | "thread.created" | "thread.closed" | "weave.archived";
export type LoomEvent = { weaveId: string; seq: number; threadId: string; type: EventType; actor: string; at: string; payload: Record<string, unknown> };
export type WeaveInfo = { weave: Weave; threads: Thread[]; participants: Participant[] };
export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind } };
export type CreateWeaveResult = { weave: Weave; secret: string; participant: Participant; token: string; generalThread: Thread };
export type JoinResult = { weaveId: string; participant: Participant; token: string };
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean };
export type Keeper = { id: string; name: string; createdAt: string };
// errors.ts
export class LoomClientError extends Error { code: string; status?: number }
// url.ts
export function resolveBaseUrl(baseUrl: string, allowInsecure?: boolean): string   // normalized origin+path without trailing slash; throws insecure_url
export function toWsUrl(baseUrl: string): string                                    // https→wss, http→ws
```

- [ ] **Step 1: Package files**

`src/client/package.json`:

```json
{
  "name": "@loom/client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@loom/core": "workspace:*",
    "@loom/server": "workspace:*"
  }
}
```

(`@loom/core` / `@loom/server` are dev-only so the integration tests can import the server test helper; nothing under `src/` may import them.)

`src/client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true, "lib": ["ES2022", "DOM"] },
  "include": ["src"]
}
```

`src/client/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "composite": false, "rootDir": "..", "lib": ["ES2022", "DOM"] },
  "include": ["src", "test", "../server/test/helpers.ts", "../core/test/helpers.ts"]
}
```

`src/client/vitest.config.ts`:

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

Then from the repo root run `pnpm install` (links the new workspace package).

- [ ] **Step 2: Write the failing URL test**

`src/client/test/url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveBaseUrl, toWsUrl } from "../src/url.js";
import { LoomClientError } from "../src/errors.js";

describe("resolveBaseUrl", () => {
  it("accepts https and strips trailing slash", () => {
    expect(resolveBaseUrl("https://loom.example.com/")).toBe("https://loom.example.com");
    expect(resolveBaseUrl("https://loom.example.com/base/")).toBe("https://loom.example.com/base");
  });
  it("rejects http by default, even on localhost", () => {
    for (const u of ["http://loom.example.com", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      expect(() => resolveBaseUrl(u)).toThrow(LoomClientError);
      try { resolveBaseUrl(u); } catch (e) { expect((e as LoomClientError).code).toBe("insecure_url"); }
    }
  });
  it("allows http only on loopback when allowInsecure is set", () => {
    expect(resolveBaseUrl("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(resolveBaseUrl("http://127.0.0.1:3000/", true)).toBe("http://127.0.0.1:3000");
    expect(resolveBaseUrl("http://[::1]:3000", true)).toBe("http://[::1]:3000");
    expect(() => resolveBaseUrl("http://loom.example.com", true)).toThrow(LoomClientError);
  });
  it("rejects garbage and other schemes", () => {
    expect(() => resolveBaseUrl("not a url")).toThrow(LoomClientError);
    expect(() => resolveBaseUrl("ftp://x")).toThrow(LoomClientError);
  });
});

describe("toWsUrl", () => {
  it("maps schemes", () => {
    expect(toWsUrl("https://loom.example.com")).toBe("wss://loom.example.com");
    expect(toWsUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run from `src/client`: `pnpm vitest run test/url.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement types, errors, url, index**

`src/client/src/types.ts`:

```ts
export type Kind = "human" | "agent";
export type Role = "member" | "keeper";

export type Weave = { id: string; title: string; createdAt: string; archivedAt: string | null; lastSeq: number };
export type Thread = {
  id: string; weaveId: string; name: string; isGeneral: boolean;
  createdBy: string; createdAt: string; closedAt: string | null;
};
export type Participant = { id: string; weaveId: string; name: string; kind: Kind; role: Role; joinedAt: string };

export type EventType =
  | "message" | "participant.joined" | "participant.role_changed"
  | "thread.created" | "thread.closed" | "weave.archived";
export type LoomEvent = {
  weaveId: string; seq: number; threadId: string; type: EventType;
  actor: string; at: string; payload: Record<string, unknown>;
};

export type WeaveInfo = { weave: Weave; threads: Thread[]; participants: Participant[] };
export type CreateWeaveInput = { title: string; opener: string; creator: { name: string; kind: Kind } };
export type CreateWeaveResult = { weave: Weave; secret: string; participant: Participant; token: string; generalThread: Thread };
export type JoinResult = { weaveId: string; participant: Participant; token: string };
export type Settings = { instanceName: string; maxMessageLength: number; openWeaveCreation: boolean };
export type Keeper = { id: string; name: string; createdAt: string };
```

`src/client/src/errors.ts`:

```ts
export class LoomClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = "LoomClientError";
  }
}
```

`src/client/src/url.ts`:

```ts
import { LoomClientError } from "./errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validates and normalizes a Loom base URL. Only https is accepted, except http on loopback when explicitly allowed. */
export function resolveBaseUrl(baseUrl: string, allowInsecure = false): string {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new LoomClientError("insecure_url", `Invalid Loom URL: ${baseUrl}`); }
  if (u.protocol === "http:") {
    if (!allowInsecure || !LOOPBACK.has(u.hostname)) {
      throw new LoomClientError("insecure_url", "Loom requires https (http is only allowed on localhost with LOOM_ALLOW_INSECURE=1)");
    }
  } else if (u.protocol !== "https:") {
    throw new LoomClientError("insecure_url", `Unsupported URL scheme: ${u.protocol}`);
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
```

`src/client/src/index.ts` (grows in Tasks 2–3):

```ts
export * from "./types.js";
export { LoomClientError } from "./errors.js";
export { resolveBaseUrl, toWsUrl } from "./url.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run from `src/client`: `pnpm vitest run test/url.test.ts` → PASS. Then `pnpm build` in `src/client` and `pnpm typecheck` at the repo root → clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): package scaffold, API types, URL safety rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Client REST methods

**Files:**
- Create: `src/client/src/http.ts`, `src/client/src/client.ts`
- Modify: `src/client/src/index.ts`
- Test: `src/client/test/client.test.ts`

**Interfaces:**
- Produces:

```ts
export type LoomClientOptions = { baseUrl: string; token?: string; allowInsecure?: boolean; fetch?: typeof fetch };
export class LoomClient {
  readonly baseUrl: string; readonly token?: string;
  constructor(opts: LoomClientOptions);
  withToken(token: string | undefined): LoomClient;
  createWeave(input: CreateWeaveInput): Promise<CreateWeaveResult>;
  joinWeave(secret: string, who: { name: string; kind: Kind }): Promise<JoinResult>;
  getWeave(weaveId: string): Promise<WeaveInfo>;
  readEvents(weaveId: string, opts?: { since?: number; threadId?: string; limit?: number }): Promise<LoomEvent[]>;
  postMessage(threadId: string, text: string): Promise<LoomEvent>;
  createThread(weaveId: string, name: string): Promise<Thread>;
  closeThread(threadId: string): Promise<void>;
  archiveWeave(weaveId: string): Promise<void>;
  setRole(weaveId: string, participantId: string, role: Role): Promise<Participant>;
  exportWeave(weaveId: string, format: "md" | "json"): Promise<string>;
  wsTicket(): Promise<string>;
  admin: {
    listWeaves(): Promise<Weave[]>; getSettings(): Promise<Settings>; updateSettings(patch: Partial<Settings>): Promise<Settings>;
    listKeepers(): Promise<Keeper[]>; addKeeper(name: string): Promise<{ keeper: Keeper; token: string }>; removeKeeper(id: string): Promise<void>;
  };
}
```

- [ ] **Step 1: Write the failing test**

`src/client/test/client.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { LoomClient, LoomClientError } from "../src/index.js";

let s: TestServer;
let anon: LoomClient;
beforeAll(async () => {
  s = await startTestServer();
  await s.core.seedKeepers([keeperToken("k1")]);
  anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true });
});
afterAll(async () => { await s.close(); });

const input = { title: "PR 7", opener: "Look at PR 7", creator: { name: "Claude", kind: "agent" as const } };

describe("LoomClient", () => {
  it("refuses insecure URLs unless allowed", () => {
    expect(() => new LoomClient({ baseUrl: s.baseUrl })).toThrow(LoomClientError);
  });

  it("create → join → get → post → events → thread → role → close → archive → export", async () => {
    const r = await anon.createWeave(input);
    expect(r.secret).toHaveLength(43);
    const me = anon.withToken(r.token);
    const j = await anon.joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = anon.withToken(j.token);

    const info = await anon.withToken(r.secret).getWeave(r.weave.id);
    expect(info.participants.map((p) => p.name)).toEqual(["Claude", "ChatGPT"]);

    const t = await gpt.createThread(r.weave.id, "Design");
    const m = await gpt.postMessage(t.id, "hi @Claude");
    expect(m.payload.mentions).toEqual([r.participant.id]);

    const evs = await me.readEvents(r.weave.id, { since: 3 });
    expect(evs.map((e) => e.type)).toEqual(["participant.joined", "thread.created", "message"]);
    const inThread = await me.readEvents(r.weave.id, { threadId: t.id });
    expect(inThread.every((e) => e.threadId === t.id)).toBe(true);

    const p = await me.setRole(r.weave.id, j.participant.id, "keeper");
    expect(p.role).toBe("keeper");
    await gpt.closeThread(t.id);
    await me.archiveWeave(r.weave.id);

    const md = await anon.withToken(r.secret).exportWeave(r.weave.id, "md");
    expect(md).toContain("# PR 7");
    const json = JSON.parse(await anon.withToken(r.secret).exportWeave(r.weave.id, "json"));
    expect(json.events.at(-1).type).toBe("weave.archived");
  });

  it("maps server errors to LoomClientError with code and status", async () => {
    const r = await anon.createWeave(input);
    await expect(anon.getWeave(r.weave.id)).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    await expect(anon.joinWeave("nope", { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_not_found", status: 404 });
    await expect(anon.joinWeave(r.secret, { name: "claude", kind: "human" })).rejects.toMatchObject({ code: "name_taken", status: 409 });
    await expect(anon.joinWeave(r.secret, { name: "a b", kind: "human" })).rejects.toMatchObject({ code: "validation", status: 400 });
  });

  it("reports network failures as code network", async () => {
    const dead = new LoomClient({ baseUrl: "http://127.0.0.1:1", allowInsecure: true });
    await expect(dead.createWeave(input)).rejects.toMatchObject({ code: "network" });
  });

  it("wsTicket returns a single-use ticket", async () => {
    const r = await anon.createWeave(input);
    const ticket = await anon.withToken(r.token).wsTicket();
    expect(ticket).toHaveLength(43);
    expect(s.tickets.redeem(ticket)).toBe(r.token);
  });

  it("admin methods require a keeper token", async () => {
    const k = anon.withToken(keeperToken("k1"));
    const r = await anon.createWeave(input);
    expect((await k.admin.listWeaves()).some((w) => w.id === r.weave.id)).toBe(true);
    const st = await k.admin.updateSettings({ instanceName: "Fragt Loom" });
    expect(st.instanceName).toBe("Fragt Loom");
    expect((await k.admin.getSettings()).instanceName).toBe("Fragt Loom");
    const added = await k.admin.addKeeper("Ops");
    expect(added.token).toHaveLength(43);
    expect((await k.admin.listKeepers()).some((x) => x.id === added.keeper.id)).toBe(true);
    await k.admin.removeKeeper(added.keeper.id);
    await expect(anon.withToken(r.token).admin.listWeaves()).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/client`: `pnpm vitest run test/client.test.ts`
Expected: FAIL, `LoomClient` not exported.

- [ ] **Step 3: Implement http and client**

`src/client/src/http.ts`:

```ts
import { LoomClientError } from "./errors.js";

export type RequestOpts = {
  method: string; url: string; token?: string; body?: unknown; fetchImpl?: typeof fetch; accept?: "json" | "text";
};

/** Performs one HTTP request. Server errors become LoomClientError(code, message, status); transport failures become code "network". */
export async function request<T>(opts: RequestOpts): Promise<T> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await f(opts.url, { method: opts.method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
    throw new LoomClientError("network", `Could not reach Loom: ${(e as Error).message}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let code = "bad_response"; let message = text || res.statusText;
    try {
      const j = JSON.parse(text) as { code?: string; message?: string };
      if (typeof j.code === "string") code = j.code;
      if (typeof j.message === "string") message = j.message;
    } catch { /* non-JSON error body */ }
    throw new LoomClientError(code, message, res.status);
  }
  if (opts.accept === "text") return text as T;
  try { return JSON.parse(text) as T; } catch { throw new LoomClientError("bad_response", "Loom returned a non-JSON response", res.status); }
}
```

`src/client/src/client.ts`:

```ts
import { request } from "./http.js";
import { resolveBaseUrl } from "./url.js";
import type {
  CreateWeaveInput, CreateWeaveResult, JoinResult, Keeper, Kind, LoomEvent, Participant, Role, Settings, Thread, Weave, WeaveInfo,
} from "./types.js";

export type LoomClientOptions = { baseUrl: string; token?: string; allowInsecure?: boolean; fetch?: typeof fetch };

export class LoomClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: LoomClientOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl, opts.allowInsecure ?? false);
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
  }

  /** Same server, different credential (participant token, keeper token, or weave secret). */
  withToken(token: string | undefined): LoomClient {
    const c = new LoomClient({ baseUrl: this.baseUrl, token, allowInsecure: true, fetch: this.fetchImpl });
    return c;
  }

  private call<T>(method: string, path: string, body?: unknown, accept: "json" | "text" = "json"): Promise<T> {
    return request<T>({ method, url: `${this.baseUrl}${path}`, token: this.token, body, fetchImpl: this.fetchImpl, accept });
  }

  createWeave(input: CreateWeaveInput): Promise<CreateWeaveResult> {
    return this.call("POST", "/api/weaves", input);
  }
  joinWeave(secret: string, who: { name: string; kind: Kind }): Promise<JoinResult> {
    return this.call("POST", `/api/weaves/${encodeURIComponent(secret)}/join`, who);
  }
  getWeave(weaveId: string): Promise<WeaveInfo> {
    return this.call("GET", `/api/weaves/${weaveId}`);
  }
  async readEvents(weaveId: string, opts: { since?: number; threadId?: string; limit?: number } = {}): Promise<LoomEvent[]> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.threadId) q.set("thread", opts.threadId);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const r = await this.call<{ events: LoomEvent[] }>("GET", `/api/weaves/${weaveId}/events${qs ? `?${qs}` : ""}`);
    return r.events;
  }
  postMessage(threadId: string, text: string): Promise<LoomEvent> {
    return this.call("POST", `/api/threads/${threadId}/messages`, { text });
  }
  createThread(weaveId: string, name: string): Promise<Thread> {
    return this.call("POST", `/api/weaves/${weaveId}/threads`, { name });
  }
  closeThread(threadId: string): Promise<void> {
    return this.call("POST", `/api/threads/${threadId}/close`);
  }
  archiveWeave(weaveId: string): Promise<void> {
    return this.call("POST", `/api/weaves/${weaveId}/archive`);
  }
  setRole(weaveId: string, participantId: string, role: Role): Promise<Participant> {
    return this.call("PUT", `/api/weaves/${weaveId}/participants/${participantId}/role`, { role });
  }
  exportWeave(weaveId: string, format: "md" | "json"): Promise<string> {
    return this.call("GET", `/api/weaves/${weaveId}/export?format=${format}`, undefined, "text");
  }
  async wsTicket(): Promise<string> {
    const r = await this.call<{ ticket: string }>("POST", "/api/auth/ws-ticket");
    return r.ticket;
  }

  readonly admin = {
    listWeaves: async (): Promise<Weave[]> => (await this.call<{ weaves: Weave[] }>("GET", "/api/admin/weaves")).weaves,
    getSettings: (): Promise<Settings> => this.call("GET", "/api/admin/settings"),
    updateSettings: (patch: Partial<Settings>): Promise<Settings> => this.call("PUT", "/api/admin/settings", patch),
    listKeepers: async (): Promise<Keeper[]> => (await this.call<{ keepers: Keeper[] }>("GET", "/api/admin/keepers")).keepers,
    addKeeper: (name: string): Promise<{ keeper: Keeper; token: string }> => this.call("POST", "/api/admin/keepers", { name }),
    removeKeeper: (id: string): Promise<void> => this.call("DELETE", `/api/admin/keepers/${id}`),
  };
}
```

Note: `withToken` passes `allowInsecure: true` because `this.baseUrl` was already validated by the original constructor; the rule is enforced once at the entry point.

Add to `src/client/src/index.ts`:

```ts
export { LoomClient, type LoomClientOptions } from "./client.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run from `src/client`: `pnpm vitest run test/client.test.ts` → PASS. `pnpm build` in `src/client`; `pnpm typecheck` at root → clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(client): REST client with error mapping and admin methods

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Client event stream with cursor reconnect

**Files:**
- Create: `src/client/src/stream.ts`
- Modify: `src/client/src/client.ts` (add `stream()`), `src/client/src/index.ts`
- Test: `src/client/test/stream.test.ts`

**Interfaces:**
- Produces:

```ts
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";
export type StreamOptions = {
  since?: number;                                   // default 0
  onEvent: (e: LoomEvent) => void;
  onStatus?: (status: StreamStatus, detail?: { error?: LoomClientError; attempt?: number }) => void;
  reconnect?: boolean;                              // default true
  backoffMs?: { initial: number; max: number };     // default { initial: 500, max: 10_000 }
  WebSocketImpl?: typeof WebSocket;                 // default globalThis.WebSocket
};
export type StreamHandle = { close(): void; readonly lastSeq: number };
export function openStream(client: LoomClient, weaveId: string, opts: StreamOptions): StreamHandle;
// on LoomClient:
stream(weaveId: string, opts: StreamOptions): StreamHandle
```

Behavior: fetch a ticket (`client.wsTicket()`), connect to `${toWsUrl(baseUrl)}/api/weaves/${weaveId}/stream?since=${lastSeq}&ticket=${ticket}`, parse each text frame as a `LoomEvent`, ignore events with `seq <= lastSeq`, update `lastSeq`, call `onEvent`. If the socket closes and the handle was not closed by the caller and `reconnect` is on: emit `reconnecting`, wait (exponential backoff with jitter, reset after a successful open), fetch a new ticket, reconnect with the current `lastSeq`. If fetching the ticket fails with a 401/403 (credential no longer valid), emit `closed` with the error and stop. `close()` stops reconnecting and closes the socket.

- [ ] **Step 1: Write the failing test**

`src/client/test/stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { LoomClient, type LoomEvent, type StreamStatus } from "../src/index.js";

let s: TestServer;
let anon: LoomClient;
beforeAll(async () => { s = await startTestServer(); anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true }); });
afterAll(async () => { await s.close(); });

const input = { title: "T", opener: "start", creator: { name: "Claude", kind: "agent" as const } };

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

describe("stream", () => {
  it("replays from since, then delivers live events", async () => {
    const r = await anon.createWeave(input);
    const me = anon.withToken(r.token);
    const got: LoomEvent[] = []; const statuses: StreamStatus[] = [];
    const h = me.stream(r.weave.id, { since: 1, onEvent: (e) => got.push(e), onStatus: (st) => statuses.push(st) });
    await waitFor(() => got.length === 2);
    await me.postMessage(r.generalThread.id, "live");
    await waitFor(() => got.length === 3);
    expect(got.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(h.lastSeq).toBe(4);
    expect(statuses.slice(0, 2)).toEqual(["connecting", "open"]);
    h.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses.at(-1)).toBe("closed");
  });

  it("reconnects with the cursor after the server drops the socket, without loss or duplicates", async () => {
    const r = await anon.createWeave(input);
    const bySecret = anon.withToken(r.secret);
    const me = anon.withToken(r.token);
    const got: LoomEvent[] = []; const statuses: StreamStatus[] = [];
    const h = bySecret.stream(r.weave.id, {
      since: 0, onEvent: (e) => got.push(e), onStatus: (st) => statuses.push(st),
      backoffMs: { initial: 20, max: 50 },
    });
    await waitFor(() => got.length === 3);
    // Drop every server-side socket for this weave, then post while the client is reconnecting.
    s.dropSockets();
    await waitFor(() => statuses.includes("reconnecting"));
    await me.postMessage(r.generalThread.id, "after drop");
    await waitFor(() => got.length === 4, 8000);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(statuses.filter((x) => x === "open").length).toBeGreaterThanOrEqual(2);
    h.close();
  });

  it("stops with closed + error when the credential is rejected", async () => {
    const r = await anon.createWeave(input);
    const bad = anon.withToken("not-a-valid-token");
    const statuses: [StreamStatus, unknown][] = [];
    bad.stream(r.weave.id, { onEvent: () => {}, onStatus: (st, d) => statuses.push([st, d?.error]) });
    await waitFor(() => statuses.some(([st]) => st === "closed"));
    const closed = statuses.find(([st]) => st === "closed")!;
    expect(closed[1]).toMatchObject({ code: "invalid_token" });
  });

  it("does not reconnect when reconnect is false", async () => {
    const r = await anon.createWeave(input);
    const statuses: StreamStatus[] = [];
    const h = anon.withToken(r.secret).stream(r.weave.id, { onEvent: () => {}, onStatus: (st) => statuses.push(st), reconnect: false });
    await waitFor(() => statuses.includes("open"));
    s.dropSockets();
    await waitFor(() => statuses.includes("closed"));
    expect(statuses).not.toContain("reconnecting");
    h.close();
  });
});
```

This needs one addition to the server test helper: `dropSockets()` terminates every live WebSocket. Add to `src/server/src/ws.ts` a return value from `attachWebSocket`: `{ dropAll(): void }` that calls `ws.terminate()` on each client of the `WebSocketServer` (`for (const c of wss.clients) c.terminate();`). In `src/server/test/helpers.ts` keep the handle and expose it on `TestServer` as `dropSockets: () => void`. Existing callers of `attachWebSocket` (`main.ts`) ignore the return value.

- [ ] **Step 2: Run test to verify it fails**

Run from `src/client`: `pnpm vitest run test/stream.test.ts`
Expected: FAIL, `stream` is not a function / `dropSockets` undefined.

- [ ] **Step 3: Implement the server helper change**

In `src/server/src/ws.ts`, change the signature to `export function attachWebSocket(server: ServerType, deps: WsDeps): { dropAll: () => void }` and end the function with:

```ts
  return { dropAll: () => { for (const c of wss.clients) c.terminate(); } };
```

In `src/server/test/helpers.ts`, capture it: `const sockets = attachWebSocket(server, {...});` and add `dropSockets: () => sockets.dropAll(),` to the returned object and `dropSockets: () => void;` to `TestServer`. Rebuild core is not needed; server tests import their own source. Run `pnpm vitest run test/ws.test.ts` in `src/server` to confirm nothing broke.

- [ ] **Step 4: Implement the stream**

`src/client/src/stream.ts`:

```ts
import type { LoomClient } from "./client.js";
import { LoomClientError } from "./errors.js";
import { toWsUrl } from "./url.js";
import type { LoomEvent } from "./types.js";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";
export type StreamOptions = {
  since?: number;
  onEvent: (e: LoomEvent) => void;
  onStatus?: (status: StreamStatus, detail?: { error?: LoomClientError; attempt?: number }) => void;
  reconnect?: boolean;
  backoffMs?: { initial: number; max: number };
  WebSocketImpl?: typeof WebSocket;
};
export type StreamHandle = { close(): void; readonly lastSeq: number };

const FATAL = new Set(["invalid_token", "forbidden", "weave_not_found", "insecure_url"]);

export function openStream(client: LoomClient, weaveId: string, opts: StreamOptions): StreamHandle {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  if (!WS) throw new LoomClientError("bad_response", "No WebSocket implementation available");
  const backoff = opts.backoffMs ?? { initial: 500, max: 10_000 };
  const reconnect = opts.reconnect ?? true;
  let lastSeq = opts.since ?? 0;
  let closedByUser = false;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = (st: StreamStatus, detail?: { error?: LoomClientError; attempt?: number }) => opts.onStatus?.(st, detail);

  const scheduleReconnect = () => {
    if (closedByUser) return;
    if (!reconnect) { status("closed"); return; }
    attempt += 1;
    const delay = Math.min(backoff.max, backoff.initial * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
    status("reconnecting", { attempt });
    timer = setTimeout(() => { void connect(); }, delay);
  };

  const connect = async () => {
    if (closedByUser) return;
    status("connecting", { attempt });
    let ticket: string;
    try {
      ticket = await client.wsTicket();
    } catch (e) {
      const err = e instanceof LoomClientError ? e : new LoomClientError("network", String(e));
      if (FATAL.has(err.code) || closedByUser) { status("closed", { error: err }); return; }
      scheduleReconnect();
      return;
    }
    if (closedByUser) return;
    const url = `${toWsUrl(client.baseUrl)}/api/weaves/${weaveId}/stream?since=${lastSeq}&ticket=${encodeURIComponent(ticket)}`;
    const ws = new WS(url);
    socket = ws;
    let opened = false;
    ws.onopen = () => { opened = true; attempt = 0; status("open"); };
    ws.onmessage = (m) => {
      let e: LoomEvent;
      try { e = JSON.parse(typeof m.data === "string" ? m.data : String(m.data)) as LoomEvent; } catch { return; }
      if (typeof e.seq !== "number" || e.seq <= lastSeq) return;
      lastSeq = e.seq;
      opts.onEvent(e);
    };
    ws.onerror = () => { /* the close event follows; handled there */ };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined;
      if (closedByUser) { status("closed"); return; }
      // A handshake rejection (never opened) is most likely a credential problem; re-fetching the
      // ticket on reconnect surfaces it as a fatal error from wsTicket() if the credential is dead.
      void opened;
      scheduleReconnect();
    };
  };

  void connect();

  return {
    close() {
      closedByUser = true;
      if (timer) clearTimeout(timer);
      if (socket) { const ws = socket; socket = undefined; ws.close(); status("closed"); }
      else status("closed");
    },
    get lastSeq() { return lastSeq; },
  };
}
```

Add to `src/client/src/client.ts` (import `openStream` and the types at the top):

```ts
  stream(weaveId: string, opts: StreamOptions): StreamHandle {
    return openStream(this, weaveId, opts);
  }
```

Add to `src/client/src/index.ts`:

```ts
export { openStream, type StreamOptions, type StreamHandle, type StreamStatus } from "./stream.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `src/client`: `pnpm vitest run test/stream.test.ts` three times → PASS each time. Then `pnpm test` in `src/client`, `pnpm test` in `src/server`, `pnpm build` in `src/client`, `pnpm typecheck` at root.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): websocket event stream with ticket handshake and cursor reconnect

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: CLI scaffold, config store, and core commands

**Files:**
- Create: `src/cli/package.json`, `src/cli/tsconfig.json`, `src/cli/tsconfig.test.json`, `src/cli/vitest.config.ts`, `src/cli/bin/loom.js`
- Create: `src/cli/src/main.ts`, `src/cli/src/cli.ts`, `src/cli/src/config.ts`, `src/cli/src/context.ts`, `src/cli/src/output.ts`, `src/cli/src/commands/weave.ts`, `src/cli/src/commands/messages.ts`
- Test: `src/cli/test/config.test.ts`, `src/cli/test/cli.test.ts`

**Interfaces:**
- Produces:

```ts
// config.ts
export type WeaveEntry = { title: string; secret?: string; token: string; participantId: string; generalThreadId: string; participantName: string };
export type CliConfig = { url?: string; lastWeave?: string; weaves: Record<string, WeaveEntry> };
export class ConfigStore { constructor(path: string); load(): CliConfig; save(c: CliConfig): void; static defaultPath(env: NodeJS.ProcessEnv): string }
// cli.ts
export type CliIo = { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv };
export async function runCli(argv: string[], io: CliIo): Promise<number>   // exit code
// context.ts
export type GlobalOpts = { url?: string; weave?: string; json?: boolean };
export type CliContext = { io: CliIo; store: ConfigStore; config: CliConfig; opts: GlobalOpts; baseUrl: string; client(token?: string): LoomClient;
  resolveWeave(): { weaveId: string; entry: WeaveEntry }; keeperClient(): LoomClient };
export function buildContext(opts: GlobalOpts, io: CliIo): CliContext
// output.ts
export function emit(ctx: CliContext, json: unknown, human: string): void
```

Commands in this task: `create`, `join`, `info`, `post`, `read` (without `--follow`; Task 5 adds it).

CLI conventions:
- Global options: `--url <url>` (else `LOOM_URL`), `--weave <id>` (else `config.lastWeave`), `--json`.
- `LOOM_ALLOW_INSECURE=1` → `allowInsecure`. `LOOM_KEEPER_TOKEN` → keeper credential for admin commands.
- Errors: print `{ code, message }` as JSON on stderr when `--json`, else `error: <message> (<code>)`; exit code 1. Usage errors (commander) exit 2.
- `create --title T [--opener TEXT] --name N [--kind agent|human]`: stores the weave entry + `lastWeave`; human output prints weave id, secret, web URL (`<baseUrl>/w/<secret>`), General thread id; JSON prints the full `CreateWeaveResult`.
- `join <secret> --name N [--kind agent|human]`: fetches weave info after joining to learn the title and General thread id; stores entry + `lastWeave`.
- `info`: prints `WeaveInfo`.
- `post <text...> [--thread <id>]` (default thread: General of the resolved weave): prints the event.
- `read [--since N] [--thread <id>] [--limit N]`: prints events; human format `#<seq> [<thread name>] <Name>: <text>` for messages and `#<seq> [<thread name>] * <type>` for system events.

- [ ] **Step 1: Package files**

`src/cli/package.json`:

```json
{
  "name": "@loom/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "loom": "./bin/loom.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@loom/client": "workspace:*",
    "commander": "15.0.0"
  },
  "devDependencies": {
    "@loom/core": "workspace:*",
    "@loom/server": "workspace:*"
  }
}
```

`src/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"],
  "references": [{ "path": "../client" }]
}
```

`src/cli/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "composite": false, "rootDir": ".." },
  "include": ["src", "test", "../server/test/helpers.ts", "../core/test/helpers.ts"]
}
```

`src/cli/vitest.config.ts`: identical to `src/client/vitest.config.ts`.

`src/cli/bin/loom.js`:

```js
#!/usr/bin/env node
import { main } from "../dist/main.js";
main();
```

Run `pnpm install` from the root.

- [ ] **Step 2: Write the failing tests**

`src/cli/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config.js";

describe("ConfigStore", () => {
  it("returns an empty config when the file is missing, and round-trips", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-cli-"));
    const p = path.join(dir, "nested", "config.json");
    const store = new ConfigStore(p);
    expect(store.load()).toEqual({ weaves: {} });
    store.save({ url: "https://x", lastWeave: "w1", weaves: { w1: { title: "T", token: "t", participantId: "p", generalThreadId: "g", participantName: "Me" } } });
    expect(existsSync(p)).toBe(true);
    expect(store.load().lastWeave).toBe("w1");
    expect(JSON.parse(readFileSync(p, "utf8")).weaves.w1.token).toBe("t");
  });
  it("defaultPath honours LOOM_CONFIG, else ~/.loom/config.json", () => {
    expect(ConfigStore.defaultPath({ LOOM_CONFIG: "/tmp/c.json" })).toBe("/tmp/c.json");
    expect(ConfigStore.defaultPath({ HOME: "/home/u" })).toBe(path.join("/home/u", ".loom", "config.json"));
    expect(ConfigStore.defaultPath({ USERPROFILE: "C:\\Users\\u" })).toBe(path.join("C:\\Users\\u", ".loom", "config.json"));
  });
});
```

`src/cli/test/cli.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";

let s: TestServer;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s.close(); });

let cfg: string;
beforeEach(() => { cfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"); });

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  let out = ""; let err = "";
  const io: CliIo = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: cfg, ...extraEnv },
  };
  const code = await runCli(args, io);
  return { code, out, err, json: () => JSON.parse(out) };
}

describe("loom create / join / info / post / read", () => {
  it("create stores the token and prints the secret; join stores a second identity", async () => {
    const c = await run(["create", "--title", "PR 9", "--opener", "Review PR 9", "--name", "Claude", "--kind", "agent", "--json"]);
    expect(c.code).toBe(0);
    const created = c.json();
    expect(created.secret).toHaveLength(43);
    const h = await run(["create", "--title", "PR 9", "--name", "Claude"]);
    expect(h.out).toMatch(/secret:/i);
    expect(h.out).toContain(`/w/`);

    // a second config file = a second user joining with the secret
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const j = await run(["join", created.secret, "--name", "ChatGPT", "--json"], { LOOM_CONFIG: cfg2 });
    expect(j.code).toBe(0);
    expect(j.json().participant.name).toBe("ChatGPT");

    const info = await run(["info", "--weave", created.weave.id, "--json"]);
    expect(info.code).toBe(0);
    expect(info.json().participants.map((p: { name: string }) => p.name)).toEqual(["Claude", "ChatGPT"]);
  });

  it("post and read use the last weave by default; read supports --since and --thread", async () => {
    const c = await run(["create", "--title", "T", "--opener", "hello", "--name", "Me", "--json"]);
    const created = c.json();
    const p = await run(["post", "second", "message", "--json"]);
    expect(p.code).toBe(0);
    expect(p.json().payload.text).toBe("second message");
    const r = await run(["read", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().events.map((e: { type: string }) => e.type)).toEqual(["thread.created", "participant.joined", "message", "message"]);
    const since = await run(["read", "--since", "3", "--json"]);
    expect(since.json().events.map((e: { seq: number }) => e.seq)).toEqual([4]);
    const human = await run(["read"]);
    expect(human.out).toContain("#4 [General] Me: second message");
    expect(human.out).toContain("#2 [General] * participant.joined");
    const inThread = await run(["read", "--thread", created.generalThread.id, "--json"]);
    expect(inThread.json().events).toHaveLength(4);
  });

  it("reports errors with code and exit 1; usage errors exit 2", async () => {
    const noWeave = await run(["read", "--json"]);
    expect(noWeave.code).toBe(1);
    expect(JSON.parse(noWeave.err).code).toBe("no_weave");
    const bad = await run(["join", "nope", "--name", "X"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("weave_not_found");
    const usage = await run(["create"]);
    expect(usage.code).toBe(2);
    const insecure = await run(["info"], { LOOM_ALLOW_INSECURE: "" });
    expect(insecure.code).toBe(1);
    expect(insecure.err).toContain("insecure_url");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run from `src/cli`: `pnpm vitest run` → FAIL, modules not found.

- [ ] **Step 4: Implement config, output, context**

`src/cli/src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WeaveEntry = {
  title: string; secret?: string; token: string; participantId: string; generalThreadId: string; participantName: string;
};
export type CliConfig = { url?: string; lastWeave?: string; weaves: Record<string, WeaveEntry> };

export class ConfigStore {
  constructor(readonly path: string) {}

  static defaultPath(env: NodeJS.ProcessEnv): string {
    if (env.LOOM_CONFIG) return env.LOOM_CONFIG;
    const home = env.HOME ?? env.USERPROFILE ?? ".";
    return path.join(home, ".loom", "config.json");
  }

  load(): CliConfig {
    if (!existsSync(this.path)) return { weaves: {} };
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CliConfig>;
    return { url: raw.url, lastWeave: raw.lastWeave, weaves: raw.weaves ?? {} };
  }

  save(c: CliConfig): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  }
}
```

`src/cli/src/output.ts`:

```ts
import type { CliContext } from "./context.js";

/** Prints JSON (one document) when --json, otherwise the human text. Always newline-terminated. */
export function emit(ctx: CliContext, json: unknown, human: string): void {
  ctx.io.stdout.write(ctx.opts.json ? JSON.stringify(json) + "\n" : human.replace(/\n?$/, "\n"));
}
```

`src/cli/src/context.ts`:

```ts
import { LoomClient, LoomClientError } from "@loom/client";
import { ConfigStore, type CliConfig, type WeaveEntry } from "./config.js";

export type CliIo = { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv };
export type GlobalOpts = { url?: string; weave?: string; json?: boolean };

export class CliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CliError"; }
}

export type CliContext = {
  io: CliIo; store: ConfigStore; config: CliConfig; opts: GlobalOpts; baseUrl: string;
  client(token?: string): LoomClient;
  resolveWeave(): { weaveId: string; entry: WeaveEntry };
  keeperClient(): LoomClient;
  remember(weaveId: string, entry: WeaveEntry): void;
};

export function buildContext(opts: GlobalOpts, io: CliIo): CliContext {
  const store = new ConfigStore(ConfigStore.defaultPath(io.env));
  const config = store.load();
  const baseUrl = opts.url ?? io.env.LOOM_URL ?? config.url;
  if (!baseUrl) throw new CliError("no_url", "No Loom URL: pass --url or set LOOM_URL");
  const allowInsecure = io.env.LOOM_ALLOW_INSECURE === "1";
  // Validate once, eagerly, so a bad URL fails before any network call.
  const root = new LoomClient({ baseUrl, allowInsecure });
  const ctx: CliContext = {
    io, store, config, opts, baseUrl: root.baseUrl,
    client: (token) => root.withToken(token),
    resolveWeave: () => {
      const weaveId = opts.weave ?? config.lastWeave;
      if (!weaveId) throw new CliError("no_weave", "No Weave selected: pass --weave <id> or create/join one first");
      const entry = config.weaves[weaveId];
      if (!entry) throw new CliError("no_weave", `No stored credentials for Weave ${weaveId}; join it first`);
      return { weaveId, entry };
    },
    keeperClient: () => {
      const t = io.env.LOOM_KEEPER_TOKEN;
      if (!t) throw new CliError("no_keeper_token", "Admin commands need LOOM_KEEPER_TOKEN");
      return root.withToken(t);
    },
    remember: (weaveId, entry) => {
      config.weaves[weaveId] = entry;
      config.lastWeave = weaveId;
      store.save(config);
    },
  };
  return ctx;
}

export function isClientError(e: unknown): e is LoomClientError { return e instanceof LoomClientError; }
```

- [ ] **Step 5: Implement commands and the program**

`src/cli/src/commands/weave.ts`:

```ts
import type { Command } from "commander";
import type { Kind } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

function kindOf(v: string | undefined): Kind {
  if (v === undefined) return "agent";
  if (v === "agent" || v === "human") return v;
  throw new Error("--kind must be agent or human");
}

export function registerWeaveCommands(program: Command, ctx: () => CliContext): void {
  program.command("create")
    .description("Create a Weave (you become its keeper) and store your token")
    .requiredOption("--title <title>", "Weave title")
    .option("--opener <text>", "Opening message", "")
    .requiredOption("--name <name>", "Your participant name")
    .option("--kind <kind>", "agent | human", "agent")
    .action(async (o: { title: string; opener: string; name: string; kind: string }) => {
      const c = ctx();
      const r = await c.client().createWeave({ title: o.title, opener: o.opener, creator: { name: o.name, kind: kindOf(o.kind) } });
      c.remember(r.weave.id, {
        title: r.weave.title, secret: r.secret, token: r.token, participantId: r.participant.id,
        generalThreadId: r.generalThread.id, participantName: r.participant.name,
      });
      emit(c, r, [
        `Created Weave "${r.weave.title}"`,
        `  weave:   ${r.weave.id}`,
        `  secret:  ${r.secret}`,
        `  url:     ${c.baseUrl}/w/${r.secret}`,
        `  general: ${r.generalThread.id}`,
        `Token stored in ${c.store.path}`,
      ].join("\n"));
    });

  program.command("join <secret>")
    .description("Join a Weave with its secret and store your token")
    .requiredOption("--name <name>", "Your participant name")
    .option("--kind <kind>", "agent | human", "agent")
    .action(async (secret: string, o: { name: string; kind: string }) => {
      const c = ctx();
      const j = await c.client().joinWeave(secret, { name: o.name, kind: kindOf(o.kind) });
      const info = await c.client(j.token).getWeave(j.weaveId);
      const general = info.threads.find((t) => t.isGeneral)!;
      c.remember(j.weaveId, {
        title: info.weave.title, secret, token: j.token, participantId: j.participant.id,
        generalThreadId: general.id, participantName: j.participant.name,
      });
      emit(c, j, `Joined "${info.weave.title}" as ${j.participant.name} (weave ${j.weaveId}). Token stored in ${c.store.path}`);
    });

  program.command("info")
    .description("Show the Weave, its threads and participants")
    .action(async () => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const info = await c.client(entry.token).getWeave(weaveId);
      const lines = [
        `${info.weave.title} (${info.weave.id})${info.weave.archivedAt ? " [archived]" : ""}`,
        "Threads:",
        ...info.threads.map((t) => `  ${t.id}  ${t.name}${t.closedAt ? " [closed]" : ""}`),
        "Participants:",
        ...info.participants.map((p) => `  ${p.id}  ${p.name} (${p.kind}, ${p.role})`),
      ];
      emit(c, info, lines.join("\n"));
    });
}
```

`src/cli/src/commands/messages.ts` (the `--follow` branch is added in Task 5):

```ts
import type { Command } from "commander";
import type { LoomEvent, Thread, Participant } from "@loom/client";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function formatEvent(e: LoomEvent, threads: Thread[], participants: Participant[]): string {
  const thread = threads.find((t) => t.id === e.threadId)?.name ?? e.threadId;
  const who = e.actor.startsWith("keeper:") ? "Keeper" : (participants.find((p) => p.id === e.actor)?.name ?? e.actor);
  if (e.type === "message") return `#${e.seq} [${thread}] ${who}: ${String(e.payload.text ?? "")}`;
  return `#${e.seq} [${thread}] * ${e.type}`;
}

export function registerMessageCommands(program: Command, ctx: () => CliContext): void {
  program.command("post <text...>")
    .description("Post a message (default: the General thread of the current Weave)")
    .option("--thread <id>", "Thread id")
    .action(async (words: string[], o: { thread?: string }) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      const ev = await c.client(entry.token).postMessage(o.thread ?? entry.generalThreadId, words.join(" "));
      emit(c, ev, `#${ev.seq} posted`);
    });

  program.command("read")
    .description("Read events of the current Weave")
    .option("--since <seq>", "Only events after this seq", (v) => Number(v))
    .option("--thread <id>", "Only this thread")
    .option("--limit <n>", "Max events", (v) => Number(v))
    .action(async (o: { since?: number; thread?: string; limit?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      const [info, events] = await Promise.all([
        client.getWeave(weaveId),
        client.readEvents(weaveId, { since: o.since, threadId: o.thread, limit: o.limit }),
      ]);
      emit(c, { events }, events.map((e) => formatEvent(e, info.threads, info.participants)).join("\n"));
    });
}
```

`src/cli/src/cli.ts`:

```ts
import { Command, CommanderError } from "commander";
import { buildContext, CliError, isClientError, type CliContext, type CliIo, type GlobalOpts } from "./context.js";
import { registerWeaveCommands } from "./commands/weave.js";
import { registerMessageCommands } from "./commands/messages.js";

export type { CliIo } from "./context.js";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = new Command("loom");
  program
    .description("Loom command line: create and join Weaves, read and post messages")
    .option("--url <url>", "Loom base URL (default: $LOOM_URL)")
    .option("--weave <id>", "Weave id (default: the last one created/joined)")
    .option("--json", "Print JSON")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) });

  let ctxCache: CliContext | undefined;
  const ctx = () => (ctxCache ??= buildContext(program.opts<GlobalOpts>(), io));

  registerWeaveCommands(program, ctx);
  registerMessageCommands(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      return 2;
    }
    const json = program.opts<GlobalOpts>().json === true;
    const { code, message } = isClientError(e) || e instanceof CliError
      ? { code: e.code, message: e.message }
      : { code: "internal", message: e instanceof Error ? e.message : String(e) };
    io.stderr.write(json ? JSON.stringify({ code, message }) + "\n" : `error: ${message} (${code})\n`);
    return 1;
  }
}
```

`src/cli/src/main.ts`:

```ts
import { runCli } from "./cli.js";

export function main(): void {
  runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)} (internal)\n`); process.exitCode = 1; });
}
```

Notes: `program.opts()` includes global options wherever they appear in `argv` because commander hoists options declared on the root command; the tests pass `--json` after the subcommand, which commander accepts by default (`enablePositionalOptions` is off). If commander 15 rejects unknown-position options in your run, call `program.allowUnknownOption(false)` and register the three global options on each subcommand via a small helper instead; report the deviation.

- [ ] **Step 6: Run tests to verify they pass**

Run from `src/cli`: `pnpm vitest run` → PASS. Then `pnpm build` in `src/client` and `src/cli`, and a manual bin check from the repo root:

```bash
LOOM_ALLOW_INSECURE=1 LOOM_URL=http://127.0.0.1:1 node src/cli/bin/loom.js info
```

Expected: `error: ... (no_weave)` or `(network)` — proves the bin entry loads. `pnpm typecheck` at root → clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(cli): loom command with config store, create/join/info/post/read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: CLI — threads, archive, role, export, follow, admin

**Files:**
- Create: `src/cli/src/commands/thread.ts`, `src/cli/src/commands/admin.ts`
- Modify: `src/cli/src/commands/weave.ts` (archive, role, export), `src/cli/src/commands/messages.ts` (`read --follow --count`), `src/cli/src/cli.ts` (register)
- Test: `src/cli/test/cli-more.test.ts`

**Interfaces:**
- Consumes: `CliContext`, `emit`, `formatEvent` (Task 4); `LoomClient.stream` (Task 3).
- Produces commands: `thread new <name>`, `thread close <threadId>`, `archive`, `role <participantId> <member|keeper>`, `export [--format md|json]`, `read --follow [--count N]`, `admin weaves`, `admin settings [--set key=value ...]`, `admin keepers list|add <name>|remove <id>`.

Behavior notes:
- `read --follow`: after printing the initial batch (respecting `--since`/`--thread`), streams new events. In `--json` mode each event is one JSON line (`{"events":[...]}` is NOT used in follow mode; each line is a bare event). Human mode uses `formatEvent`; thread/participant names are refreshed by re-fetching `getWeave` when a `thread.created` or `participant.joined` event arrives. `--count N` exits with code 0 after N streamed events (the initial batch does not count). Without `--count`, runs until SIGINT (the process entry handles that; tests always pass `--count`). `--thread` filters streamed events too.
- `export` prints the raw export to stdout (no `--json` wrapping; `--format json` already is JSON).
- `admin settings --set openWeaveCreation=false --set maxMessageLength=500`: booleans and integers are parsed; unknown keys → `validation` error before calling the server.

- [ ] **Step 1: Write the failing tests**

`src/cli/test/cli-more.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";

let s: TestServer;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([keeperToken("k1")]); });
afterAll(async () => { await s.close(); });

let cfg: string;
beforeEach(() => { cfg = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json"); });

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  let out = ""; let err = "";
  const io: CliIo = {
    stdout: { write: (x: string) => { out += x; } },
    stderr: { write: (x: string) => { err += x; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: cfg, ...extraEnv },
  };
  const code = await runCli(args, io);
  return { code, out, err, json: () => JSON.parse(out), lines: () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

describe("threads, roles, archive, export", () => {
  it("thread new/close, role, archive, export", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const cfg2 = path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");
    const joined = (await run(["join", created.secret, "--name", "Other", "--json"], { LOOM_CONFIG: cfg2 })).json();

    const t = await run(["thread", "new", "Design", "--json"]);
    expect(t.code).toBe(0);
    expect(t.json().name).toBe("Design");

    const denied = await run(["thread", "close", t.json().id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.err).code).toBe("forbidden");

    const role = await run(["role", joined.participant.id, "keeper", "--json"]);
    expect(role.code).toBe(0);
    expect(role.json().role).toBe("keeper");
    const closed = await run(["thread", "close", t.json().id, "--json"], { LOOM_CONFIG: cfg2 });
    expect(closed.code).toBe(0);

    const ar = await run(["archive"]);
    expect(ar.code).toBe(0);
    expect(ar.out).toMatch(/archived/i);

    const md = await run(["export"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("# T");
    const js = await run(["export", "--format", "json"]);
    expect(JSON.parse(js.out).events.at(-1).type).toBe("weave.archived");
  });
});

describe("read --follow", () => {
  it("prints the initial batch then streamed events as JSON lines and exits after --count", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const me = s.core;
    const actor = await me.resolveCredential(created.token);
    const follow = run(["read", "--follow", "--since", "3", "--count", "2", "--json"]);
    await new Promise((r) => setTimeout(r, 300));
    await me.postMessage(actor, created.generalThread.id, "one");
    await me.postMessage(actor, created.generalThread.id, "two");
    const res = await follow;
    expect(res.code).toBe(0);
    const lines = res.lines();
    expect(lines.map((e: { seq: number }) => e.seq)).toEqual([4, 5]);
    expect(lines[0].payload.text).toBe("one");
  });

  it("human follow output resolves names for events in new threads", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const actor = await s.core.resolveCredential(created.token);
    const follow = run(["read", "--follow", "--since", "3", "--count", "2"]);
    await new Promise((r) => setTimeout(r, 300));
    const t = await s.core.createThread(actor, created.weave.id, "Design");
    await s.core.postMessage(actor, t.id, "in design");
    const res = await follow;
    expect(res.code).toBe(0);
    expect(res.out).toContain("#4 [Design] * thread.created");
    expect(res.out).toContain("#5 [Design] Me: in design");
  });
});

describe("admin", () => {
  it("requires LOOM_KEEPER_TOKEN and manages weaves, settings, keepers", async () => {
    const created = (await run(["create", "--title", "T", "--opener", "o", "--name", "Me", "--json"])).json();
    const none = await run(["admin", "weaves", "--json"]);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.err).code).toBe("no_keeper_token");
    const K = { LOOM_KEEPER_TOKEN: keeperToken("k1") };

    const w = await run(["admin", "weaves", "--json"], K);
    expect(w.code).toBe(0);
    expect(w.json().weaves.some((x: { id: string }) => x.id === created.weave.id)).toBe(true);

    const st = await run(["admin", "settings", "--set", "instanceName=Fragt", "--set", "maxMessageLength=500", "--json"], K);
    expect(st.code).toBe(0);
    expect(st.json()).toMatchObject({ instanceName: "Fragt", maxMessageLength: 500 });
    const bad = await run(["admin", "settings", "--set", "nope=1", "--json"], K);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).code).toBe("validation");
    const show = await run(["admin", "settings"], K);
    expect(show.out).toContain("instanceName: Fragt");
    await run(["admin", "settings", "--set", "maxMessageLength=20000"], K);

    const add = await run(["admin", "keepers", "add", "Ops", "--json"], K);
    expect(add.code).toBe(0);
    expect(add.json().token).toHaveLength(43);
    const list = await run(["admin", "keepers", "list", "--json"], K);
    expect(list.json().keepers.some((k: { id: string }) => k.id === add.json().keeper.id)).toBe(true);
    const rm = await run(["admin", "keepers", "remove", add.json().keeper.id], K);
    expect(rm.code).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/cli`: `pnpm vitest run test/cli-more.test.ts` → FAIL (unknown commands, exit 2).

- [ ] **Step 3: Implement thread and admin commands**

`src/cli/src/commands/thread.ts`:

```ts
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { emit } from "../output.js";

export function registerThreadCommands(program: Command, ctx: () => CliContext): void {
  const thread = program.command("thread").description("Manage threads of the current Weave");

  thread.command("new <name>")
    .description("Create a thread")
    .action(async (name: string) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const t = await c.client(entry.token).createThread(weaveId, name);
      emit(c, t, `Created thread "${t.name}" (${t.id})`);
    });

  thread.command("close <threadId>")
    .description("Close a thread (keepers only)")
    .action(async (threadId: string) => {
      const c = ctx();
      const { entry } = c.resolveWeave();
      await c.client(entry.token).closeThread(threadId);
      emit(c, { ok: true, threadId }, `Closed thread ${threadId}`);
    });
}
```

`src/cli/src/commands/admin.ts`:

```ts
import type { Command } from "commander";
import type { Settings } from "@loom/client";
import { CliError, type CliContext } from "../context.js";
import { emit } from "../output.js";

const SETTING_PARSERS: Record<keyof Settings, (v: string) => unknown> = {
  instanceName: (v) => v,
  maxMessageLength: (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new CliError("validation", "maxMessageLength must be an integer"); return n; },
  openWeaveCreation: (v) => { if (v !== "true" && v !== "false") throw new CliError("validation", "openWeaveCreation must be true or false"); return v === "true"; },
};

export function parseSettingsPatch(pairs: string[]): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new CliError("validation", `--set expects key=value, got "${pair}"`);
    const key = pair.slice(0, i); const value = pair.slice(i + 1);
    const parse = (SETTING_PARSERS as Record<string, (v: string) => unknown>)[key];
    if (!parse) throw new CliError("validation", `Unknown setting "${key}" (known: ${Object.keys(SETTING_PARSERS).join(", ")})`);
    patch[key] = parse(value);
  }
  return patch as Partial<Settings>;
}

export function registerAdminCommands(program: Command, ctx: () => CliContext): void {
  const admin = program.command("admin").description("Instance keeper commands (need LOOM_KEEPER_TOKEN)");

  admin.command("weaves").description("List all Weaves").action(async () => {
    const c = ctx();
    const weaves = await c.keeperClient().admin.listWeaves();
    emit(c, { weaves }, weaves.map((w) => `${w.id}  ${w.title}${w.archivedAt ? " [archived]" : ""}`).join("\n") || "(no weaves)");
  });

  admin.command("settings")
    .description("Show or update settings")
    .option("--set <pair...>", "key=value (instanceName, maxMessageLength, openWeaveCreation)")
    .action(async (o: { set?: string[] }) => {
      const c = ctx();
      const k = c.keeperClient();
      const settings = o.set && o.set.length > 0 ? await k.admin.updateSettings(parseSettingsPatch(o.set)) : await k.admin.getSettings();
      emit(c, settings, Object.entries(settings).map(([key, v]) => `${key}: ${String(v)}`).join("\n"));
    });

  const keepers = admin.command("keepers").description("Manage instance keepers");
  keepers.command("list").action(async () => {
    const c = ctx();
    const list = await c.keeperClient().admin.listKeepers();
    emit(c, { keepers: list }, list.map((k) => `${k.id}  ${k.name}`).join("\n") || "(no keepers)");
  });
  keepers.command("add <name>").action(async (name: string) => {
    const c = ctx();
    const r = await c.keeperClient().admin.addKeeper(name);
    emit(c, r, `Added keeper "${r.keeper.name}" (${r.keeper.id})\n  token: ${r.token}`);
  });
  keepers.command("remove <id>").action(async (id: string) => {
    const c = ctx();
    await c.keeperClient().admin.removeKeeper(id);
    emit(c, { ok: true, id }, `Removed keeper ${id}`);
  });
}
```

- [ ] **Step 4: Add archive, role, export to weave.ts and follow to messages.ts**

Append inside `registerWeaveCommands` in `src/cli/src/commands/weave.ts`:

```ts
  program.command("archive")
    .description("Archive the current Weave (keepers only)")
    .action(async () => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      await c.client(entry.token).archiveWeave(weaveId);
      emit(c, { ok: true, weaveId }, `Archived Weave ${weaveId}`);
    });

  program.command("role <participantId> <role>")
    .description("Set a participant's role: member | keeper (keepers only)")
    .action(async (participantId: string, role: string) => {
      const c = ctx();
      if (role !== "member" && role !== "keeper") throw new Error("role must be member or keeper");
      const { weaveId, entry } = c.resolveWeave();
      const p = await c.client(entry.token).setRole(weaveId, participantId, role);
      emit(c, p, `${p.name} is now ${p.role}`);
    });

  program.command("export")
    .description("Export the Weave transcript")
    .option("--format <fmt>", "md | json", "md")
    .action(async (o: { format: string }) => {
      const c = ctx();
      if (o.format !== "md" && o.format !== "json") throw new Error("--format must be md or json");
      const { weaveId, entry } = c.resolveWeave();
      const out = await c.client(entry.token).exportWeave(weaveId, o.format);
      c.io.stdout.write(out.endsWith("\n") ? out : out + "\n");
    });
```

Replace the `read` command in `src/cli/src/commands/messages.ts` with:

```ts
  program.command("read")
    .description("Read events of the current Weave; --follow streams new ones")
    .option("--since <seq>", "Only events after this seq", (v) => Number(v))
    .option("--thread <id>", "Only this thread")
    .option("--limit <n>", "Max events in the initial batch", (v) => Number(v))
    .option("--follow", "Keep streaming new events")
    .option("--count <n>", "With --follow: exit after n streamed events", (v) => Number(v))
    .action(async (o: { since?: number; thread?: string; limit?: number; follow?: boolean; count?: number }) => {
      const c = ctx();
      const { weaveId, entry } = c.resolveWeave();
      const client = c.client(entry.token);
      let info = await client.getWeave(weaveId);
      const events = await client.readEvents(weaveId, { since: o.since, threadId: o.thread, limit: o.limit });
      if (!o.follow) {
        emit(c, { events }, events.map((e) => formatEvent(e, info.threads, info.participants)).join("\n"));
        return;
      }
      const json = c.opts.json === true;
      for (const e of events) c.io.stdout.write(json ? JSON.stringify(e) + "\n" : formatEvent(e, info.threads, info.participants) + "\n");
      const lastSeq = events.at(-1)?.seq ?? o.since ?? 0;
      let remaining = o.count ?? Infinity;
      await new Promise<void>((resolve, reject) => {
        const handle = client.stream(weaveId, {
          since: lastSeq,
          onEvent: (e) => {
            void (async () => {
              if (o.thread && e.threadId !== o.thread) return;
              if (e.type === "thread.created" || e.type === "participant.joined") info = await client.getWeave(weaveId);
              c.io.stdout.write(json ? JSON.stringify(e) + "\n" : formatEvent(e, info.threads, info.participants) + "\n");
              if (--remaining <= 0) { handle.close(); resolve(); }
            })().catch(reject);
          },
          onStatus: (st, d) => { if (st === "closed" && d?.error) reject(d.error); },
        });
        const stop = () => { handle.close(); resolve(); };
        process.once("SIGINT", stop);
      });
    });
```

Register in `src/cli/src/cli.ts` after the existing two:

```ts
  registerThreadCommands(program, ctx);
  registerAdminCommands(program, ctx);
```

with the matching imports.

A note on the follow implementation: the `onEvent` handler is async because it may refresh names; events are processed in arrival order because each handler awaits only its own `getWeave` and stream delivery is sequential per socket. Do not let a slow refresh reorder output: if you observe reordering in the human-mode test, serialize the handler through a promise chain (`chain = chain.then(...)`).

- [ ] **Step 5: Run tests to verify they pass**

Run from `src/cli`: `pnpm vitest run` → PASS (both files). `pnpm build`; `pnpm typecheck` at root.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): threads, archive, role, export, follow mode, admin commands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Web package scaffold, markdown rendering, session store

**Files:**
- Create: `src/web/package.json`, `src/web/tsconfig.json`, `src/web/tsconfig.test.json`, `src/web/vite.config.ts`, `src/web/vitest.config.ts`, `src/web/index.html`
- Create: `src/web/src/storage.ts`, `src/web/src/markdown.ts`, `src/web/src/session.ts`, `src/web/src/main.tsx` (placeholder until Task 7)
- Test: `src/web/test/markdown.test.ts`, `src/web/test/session.test.ts`

**Interfaces:**
- Produces:

```ts
// storage.ts
export type KeyValueStorage = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
export const memoryStorage: () => KeyValueStorage;
export const browserStorage: () => KeyValueStorage;      // localStorage with try/catch; falls back to memory
// markdown.ts
export function renderMarkdown(text: string, participants: { id: string; name: string }[], mentionIds: string[]): string   // safe HTML
// session.ts
export type Connection = "connecting" | "open" | "reconnecting" | "closed";
export type SessionState = {
  status: "loading" | "ready" | "error"; error?: string;
  weave?: Weave; threads: Thread[]; participants: Participant[];
  events: LoomEvent[];                       // all events, ascending seq
  me?: { participant: Participant; token: string };
  currentThreadId?: string;
  connection: Connection;
  needsName: boolean;                        // true when a write was attempted without an identity
};
export type Session = {
  getState(): SessionState; subscribe(fn: () => void): () => void;
  load(): Promise<void>; join(name: string): Promise<void>; selectThread(id: string): void;
  post(text: string): Promise<void>; createThread(name: string): Promise<void>; closeThread(id: string): Promise<void>; archive(): Promise<void>;
  canModerate(): boolean; dispose(): void;
};
export function createSession(opts: { client: LoomClient; secret: string; storage: KeyValueStorage }): Session;
```

Session rules:
- `load()`: `client.withToken(secret).getWeave(weaveId)` — but the page only knows the secret, not the id. So `load()` first calls `GET /api/weaves/by-secret` … which does not exist. Instead: the server will expose the weave id to the page via the join-less read path: add `GET /api/weaves/{secret}/lookup` → `{ weaveId }` (valid secret only; 404 otherwise). This task adds that route to the server (thin: `core.lookupWeaveIdBySecret(secret)` in core) with a route test. After lookup, `getWeave(weaveId)` with the secret credential, then `readEvents(weaveId, { since: 0 })` paged by 1000 until fewer are returned, then `stream(weaveId, { since: lastSeq })`. Stored identity: key `loom:${secret}` → JSON `{ token, participantId }`; if present and the participant still exists in `participants`, set `me`.
- `join(name)`: `client.joinWeave(secret, { name, kind: "human" })`, store identity, set `me`, `needsName = false`.
- Writes (`post`, `createThread`, `closeThread`, `archive`): if no `me`, set `needsName = true` and throw `LoomClientError("no_identity", ...)`; otherwise use `client.withToken(me.token)`.
- Events from the stream are appended (deduped by seq) and also update derived state: `thread.created` → add thread (fetch `getWeave` to get the full thread row), `thread.closed` → mark closed, `participant.joined`/`role_changed` → refresh participants via `getWeave`, `weave.archived` → set `weave.archivedAt`.
- `currentThreadId` defaults to the General thread after load.
- `canModerate()`: `me.participant.role === "keeper"` and weave not archived.
- `dispose()`: closes the stream.

- [ ] **Step 1: Package files**

`src/web/package.json`:

```json
{
  "name": "@loom/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@loom/client": "workspace:*",
    "marked": "18.0.12",
    "preact": "10.29.8"
  },
  "devDependencies": {
    "@loom/core": "workspace:*",
    "@loom/server": "workspace:*",
    "@preact/preset-vite": "2.10.6",
    "vite": "7.3.6"
  }
}
```

`src/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src", "noEmit": true, "declaration": false, "composite": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "jsxImportSource": "preact",
    "module": "ESNext", "moduleResolution": "Bundler", "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`src/web/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "..", "module": "NodeNext", "moduleResolution": "NodeNext", "types": ["node"] },
  "include": ["src/storage.ts", "src/markdown.ts", "src/session.ts", "test", "../server/test/helpers.ts", "../core/test/helpers.ts"]
}
```

(Tests only cover the framework-free modules; `.tsx` files are type-checked by `tsconfig.json`.)

`src/web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } } },
});
```

`src/web/vitest.config.ts`: identical to `src/client/vitest.config.ts` (node environment; no jsdom).

`src/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Loom</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/web/src/main.tsx` (placeholder; Task 7 replaces it):

```tsx
document.getElementById("app")!.textContent = "Loom";
```

Run `pnpm install` from the root.

- [ ] **Step 2: Add the secret lookup route to core and server**

Core (`src/core/src/weaves.ts`): add

```ts
export async function lookupWeaveIdBySecret(db: Db, secret: string): Promise<string> {
  const [w] = await db.select({ id: weaves.id }).from(weaves).where(eq(weaves.secret, secret));
  if (!w) throw errors.weaveNotFound();
  return w.id;
}
```

and to the facade in `src/core/src/index.ts`: `lookupWeaveIdBySecret: (secret: string) => weaves.lookupWeaveIdBySecret(db, secret),`. Core test (`src/core/test/weaves.test.ts`, new `it`): created weave's secret resolves to its id; `"nope"` → `weave_not_found`.

Server (`src/server/src/routes/weaves.ts`), before the `/:id` routes:

```ts
  r.get("/:secret/lookup", async (c) => c.json({ weaveId: await core.lookupWeaveIdBySecret(c.req.param("secret")) }));
```

Route test (`src/server/test/routes.test.ts`, new `it`): `GET /api/weaves/<secret>/lookup` → 200 `{ weaveId }`; `GET /api/weaves/nope/lookup` → 404. Client (`src/client/src/client.ts`): `lookupWeave(secret): Promise<string>` calling that route; client test: resolves id, rejects `weave_not_found`. Rebuild core and client (`pnpm build` in each).

- [ ] **Step 3: Write the failing tests**

`src/web/test/markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

const ps = [{ id: "p1", name: "Claude" }, { id: "p2", name: "Paw" }];

describe("renderMarkdown", () => {
  it("renders markdown and escapes html", () => {
    const html = renderMarkdown("**bold** <script>alert(1)</script>", ps, []);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("highlights resolved mentions only", () => {
    const html = renderMarkdown("hi @claude and @nobody", ps, ["p1"]);
    expect(html).toContain('<span class="mention">@claude</span>');
    expect(html).toContain("@nobody");
    expect(html).not.toContain('class="mention">@nobody');
  });
  it("does not touch mentions inside code", () => {
    const html = renderMarkdown("`@Claude`", ps, ["p1"]);
    expect(html).toContain("<code>@Claude</code>");
    expect(html).not.toContain('class="mention"');
  });
  it("strips dangerous links", () => {
    const html = renderMarkdown("[x](javascript:alert(1))", ps, []);
    expect(html).not.toContain("javascript:");
  });
});
```

`src/web/test/session.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, type TestServer } from "../../server/test/helpers.js";
import { LoomClient } from "@loom/client";
import { createSession, type Session } from "../src/session.js";
import { memoryStorage } from "../src/storage.js";

let s: TestServer;
let anon: LoomClient;
beforeAll(async () => { s = await startTestServer(); anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true }); });
afterAll(async () => { await s.close(); });

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(new Error("timeout")); else setTimeout(tick, 20); };
    tick();
  });
}

async function makeSession(secret: string, storage = memoryStorage()): Promise<Session> {
  const session = createSession({ client: anon, secret, storage });
  await session.load();
  return session;
}

describe("session", () => {
  it("loads by secret (read-only), streams live events, and requires a name to post", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const session = await makeSession(r.secret);
    const st = session.getState();
    expect(st.status).toBe("ready");
    expect(st.weave?.title).toBe("T");
    expect(st.currentThreadId).toBe(r.generalThread.id);
    expect(st.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(st.me).toBeUndefined();

    await expect(session.post("x")).rejects.toMatchObject({ code: "no_identity" });
    expect(session.getState().needsName).toBe(true);

    await waitFor(() => session.getState().connection === "open");
    await anon.withToken(r.token).postMessage(r.generalThread.id, "from claude");
    await waitFor(() => session.getState().events.length === 4);
    expect(session.getState().events[3]!.payload.text).toBe("from claude");
    session.dispose();
  });

  it("join stores the identity; a second session with the same storage skips joining; writes work", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    const a = await makeSession(r.secret, storage);
    let changes = 0; a.subscribe(() => changes++);
    await a.join("Paw");
    expect(a.getState().me?.participant.name).toBe("Paw");
    expect(a.getState().needsName).toBe(false);
    expect(changes).toBeGreaterThan(0);
    await a.post("hi @Claude");
    await waitFor(() => a.getState().events.some((e) => e.payload.text === "hi @Claude"));
    await a.createThread("Design");
    await waitFor(() => a.getState().threads.some((t) => t.name === "Design"));
    expect(a.canModerate()).toBe(false);
    a.dispose();

    const b = await makeSession(r.secret, storage);
    expect(b.getState().me?.participant.name).toBe("Paw");
    b.dispose();
  });

  it("keeper can close threads and archive; archived weave is read-only", async () => {
    const r = await anon.createWeave({ title: "T", opener: "hello", creator: { name: "Claude", kind: "agent" } });
    const storage = memoryStorage();
    storage.set(`loom:${r.secret}`, JSON.stringify({ token: r.token, participantId: r.participant.id }));
    const k = await makeSession(r.secret, storage);
    expect(k.getState().me?.participant.role).toBe("keeper");
    expect(k.canModerate()).toBe(true);
    await k.createThread("Tmp");
    await waitFor(() => k.getState().threads.length === 2);
    const tmp = k.getState().threads.find((t) => t.name === "Tmp")!;
    await k.closeThread(tmp.id);
    await waitFor(() => k.getState().threads.find((t) => t.id === tmp.id)?.closedAt != null);
    await k.archive();
    await waitFor(() => k.getState().weave?.archivedAt != null);
    expect(k.canModerate()).toBe(false);
    await expect(k.post("late")).rejects.toMatchObject({ code: "weave_archived" });
    k.dispose();
  });

  it("reports an error state for an unknown secret", async () => {
    const session = createSession({ client: anon, secret: "nope", storage: memoryStorage() });
    await session.load();
    expect(session.getState().status).toBe("error");
    expect(session.getState().error).toMatch(/not found/i);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run from `src/web`: `pnpm vitest run` → FAIL, modules not found.

- [ ] **Step 5: Implement storage, markdown, session**

`src/web/src/storage.ts`:

```ts
export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}

/** localStorage when available; every call is guarded because some contexts throw on access. */
export function browserStorage(): KeyValueStorage {
  const fallback = memoryStorage();
  const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
  return {
    get: (k) => { try { return ls()?.getItem(k) ?? fallback.get(k); } catch { return fallback.get(k); } },
    set: (k, v) => { try { ls()?.setItem(k, v); } catch { /* quota or blocked */ } fallback.set(k, v); },
    remove: (k) => { try { ls()?.removeItem(k); } catch { /* ignore */ } fallback.remove(k); },
  };
}
```

`src/web/src/markdown.ts`:

```ts
import { marked, type Tokens } from "marked";

const NAME_CHARS = "A-Za-z0-9_.-";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : null;
}

/**
 * Renders message Markdown to HTML with all raw HTML escaped, unsafe link schemes dropped,
 * and resolved @mentions wrapped in <span class="mention">. Mentions inside code are left alone.
 */
export function renderMarkdown(text: string, participants: { id: string; name: string }[], mentionIds: string[]): string {
  const mentioned = new Set(mentionIds);
  const byName = new Map(participants.map((p) => [p.name.toLowerCase(), p.id]));
  const mentionRe = new RegExp(`(?<![${NAME_CHARS}])@([${NAME_CHARS}]+)`, "g");

  const highlight = (escaped: string) => escaped.replace(mentionRe, (m, raw: string) => {
    let name = raw;
    let id = byName.get(name.toLowerCase());
    while (!id && name.endsWith(".")) { name = name.slice(0, -1); id = byName.get(name.toLowerCase()); }
    if (!id || !mentioned.has(id)) return m;
    const rest = raw.slice(name.length);
    return `<span class="mention">@${name}</span>${rest}`;
  });

  const renderer = new marked.Renderer();
  renderer.html = ({ text: t }: Tokens.HTML | Tokens.Tag) => escapeHtml(t);
  renderer.text = (token: Tokens.Text | Tokens.Escape) => highlight(escapeHtml(token.text));
  renderer.codespan = ({ text: t }: Tokens.Codespan) => `<code>${escapeHtml(t)}</code>`;
  renderer.code = ({ text: t, lang }: Tokens.Code) =>
    `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(t)}</code></pre>\n`;
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const safe = safeHref(href);
    const inner = this.parser.parseInline(tokens);
    if (!safe) return inner;
    return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""} rel="noopener noreferrer" target="_blank">${inner}</a>`;
  };
  renderer.image = ({ text: alt }: Tokens.Image) => escapeHtml(alt);

  return marked.parse(text, { renderer, gfm: true, breaks: true, async: false }) as string;
}
```

If marked 18's renderer signatures differ from the above (they are the token-object style introduced in marked 13), adapt to the installed typings and report the change; the behavior in the tests is what matters.

`src/web/src/session.ts`:

```ts
import { LoomClient, LoomClientError, type LoomEvent, type Participant, type StreamHandle, type Thread, type Weave } from "@loom/client";
import type { KeyValueStorage } from "./storage.js";

export type Connection = "connecting" | "open" | "reconnecting" | "closed";
export type SessionState = {
  status: "loading" | "ready" | "error"; error?: string;
  weave?: Weave; threads: Thread[]; participants: Participant[];
  events: LoomEvent[];
  me?: { participant: Participant; token: string };
  currentThreadId?: string;
  connection: Connection;
  needsName: boolean;
};
export type Session = {
  getState(): SessionState; subscribe(fn: () => void): () => void;
  load(): Promise<void>; join(name: string): Promise<void>; selectThread(id: string): void;
  post(text: string): Promise<void>; createThread(name: string): Promise<void>; closeThread(id: string): Promise<void>; archive(): Promise<void>;
  canModerate(): boolean; dispose(): void;
};

const PAGE = 1000;

export function createSession(opts: { client: LoomClient; secret: string; storage: KeyValueStorage }): Session {
  const { client, secret, storage } = opts;
  const key = `loom:${secret}`;
  let state: SessionState = { status: "loading", threads: [], participants: [], events: [], connection: "closed", needsName: false };
  const listeners = new Set<() => void>();
  let weaveId: string | undefined;
  let stream: StreamHandle | undefined;
  const reader = client.withToken(secret);

  const set = (patch: Partial<SessionState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  const writer = (): LoomClient => {
    if (!state.me) { set({ needsName: true }); throw new LoomClientError("no_identity", "Choose a name to take part"); }
    return client.withToken(state.me.token);
  };
  const refreshInfo = async () => {
    if (!weaveId) return;
    const info = await reader.getWeave(weaveId);
    set({ weave: info.weave, threads: info.threads, participants: info.participants,
      me: state.me && info.participants.some((p) => p.id === state.me!.participant.id)
        ? { token: state.me.token, participant: info.participants.find((p) => p.id === state.me!.participant.id)! }
        : state.me });
  };
  const onEvent = (e: LoomEvent) => {
    if (state.events.some((x) => x.seq === e.seq)) return;
    const events = [...state.events, e].sort((a, b) => a.seq - b.seq);
    set({ events });
    if (e.type === "thread.created" || e.type === "thread.closed" || e.type === "participant.joined" || e.type === "participant.role_changed") {
      void refreshInfo().catch(() => { /* transient; next event retries */ });
    } else if (e.type === "weave.archived" && state.weave) {
      set({ weave: { ...state.weave, archivedAt: e.at } });
    }
  };

  return {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },

    async load() {
      try {
        weaveId = await reader.lookupWeave(secret);
        const info = await reader.getWeave(weaveId);
        const events: LoomEvent[] = [];
        let since = 0;
        for (;;) {
          const page = await reader.readEvents(weaveId, { since, limit: PAGE });
          events.push(...page);
          if (page.length < PAGE) break;
          since = page.at(-1)!.seq;
        }
        let me: SessionState["me"];
        const stored = storage.get(key);
        if (stored) {
          try {
            const { token, participantId } = JSON.parse(stored) as { token: string; participantId: string };
            const p = info.participants.find((x) => x.id === participantId);
            if (p && token) me = { token, participant: p };
          } catch { storage.remove(key); }
        }
        set({ status: "ready", weave: info.weave, threads: info.threads, participants: info.participants, events, me,
          currentThreadId: info.threads.find((t) => t.isGeneral)?.id ?? info.threads[0]?.id });
        stream = reader.stream(weaveId, {
          since: events.at(-1)?.seq ?? 0,
          onEvent,
          onStatus: (st) => set({ connection: st }),
        });
      } catch (e) {
        const msg = e instanceof LoomClientError && e.code === "weave_not_found" ? "Weave not found: the link may be wrong" : (e as Error).message;
        set({ status: "error", error: msg });
      }
    },

    async join(name) {
      const j = await client.joinWeave(secret, { name, kind: "human" });
      storage.set(key, JSON.stringify({ token: j.token, participantId: j.participant.id }));
      set({ me: { token: j.token, participant: j.participant }, needsName: false });
      await refreshInfo();
    },

    selectThread: (id) => set({ currentThreadId: id }),

    async post(text) {
      const w = writer();
      const threadId = state.currentThreadId;
      if (!threadId) throw new LoomClientError("validation", "No thread selected");
      onEvent(await w.postMessage(threadId, text));
    },
    async createThread(name) {
      if (!weaveId) return;
      const t = await writer().createThread(weaveId, name);
      set({ threads: state.threads.some((x) => x.id === t.id) ? state.threads : [...state.threads, t], currentThreadId: t.id });
    },
    async closeThread(id) {
      await writer().closeThread(id);
      await refreshInfo();
    },
    async archive() {
      if (!weaveId) return;
      await writer().archiveWeave(weaveId);
      await refreshInfo();
    },
    canModerate: () => state.me?.participant.role === "keeper" && !state.weave?.archivedAt,
    dispose: () => { stream?.close(); stream = undefined; listeners.clear(); },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run from `src/web`: `pnpm vitest run` → PASS. Also `pnpm test` in `src/core`, `src/server`, `src/client` (the lookup route touched them). `pnpm typecheck` at root → clean. `pnpm build` in `src/web` → produces `dist/index.html` and `dist/assets/*` (placeholder page).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): package scaffold, safe markdown rendering, session store; weave lookup by secret

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Web UI components

**Files:**
- Create: `src/web/src/app.tsx`, `src/web/src/useSession.ts`, `src/web/src/components/Header.tsx`, `src/web/src/components/ThreadList.tsx`, `src/web/src/components/MessageList.tsx`, `src/web/src/components/Composer.tsx`, `src/web/src/components/NamePrompt.tsx`, `src/web/src/styles.css`
- Modify: `src/web/src/main.tsx`
- Test: `src/web/test/composer-logic.test.ts` (autocomplete logic extracted to a pure function)

**Interfaces:**
- Consumes: `createSession`, `Session`, `SessionState` (Task 6); `renderMarkdown` (Task 6); `LoomClient` (Task 2); `browserStorage` (Task 6).
- Produces: a page at `/w/<secret>` and `export function completeMention(text: string, caret: number, names: string[]): { query: string; start: number } | null` plus `export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number }` in `src/web/src/components/mention-logic.ts`.

UI requirements (from the spec): left column thread list with "New thread"; main column messages of the current thread, Markdown rendered, mentions highlighted, system events as muted lines, closed-thread badge; bottom composer with `@` autocomplete inserting `@name `; first post without identity opens the name prompt (client-side name validation `^[A-Za-z0-9_.-]{1,32}$`), joins, then sends; archive Weave / close thread buttons only when `canModerate()`; archived Weave shows a banner and no composer; header shows title, connection state, and "you are <name>".

- [ ] **Step 1: Write the failing autocomplete-logic test**

`src/web/test/composer-logic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { completeMention, applyMention } from "../src/components/mention-logic.js";

const names = ["Claude", "ChatGPT", "Paw"];

describe("completeMention", () => {
  it("finds an @ query at the caret", () => {
    expect(completeMention("hi @cl", 6, names)).toEqual({ query: "cl", start: 3 });
    expect(completeMention("hi @", 4, names)).toEqual({ query: "", start: 3 });
  });
  it("returns null when not in a mention or the @ is part of an email", () => {
    expect(completeMention("hi there", 8, names)).toBeNull();
    expect(completeMention("me@claude", 9, names)).toBeNull();
    expect(completeMention("hi @cl x", 8, names)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the query with @name and a trailing space, and moves the caret", () => {
    expect(applyMention("hi @cl there", 3, 6, "Claude")).toEqual({ text: "hi @Claude  there", caret: 11 });
    expect(applyMention("@", 0, 1, "Paw")).toEqual({ text: "@Paw ", caret: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/web`: `pnpm vitest run test/composer-logic.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement the mention logic**

`src/web/src/components/mention-logic.ts`:

```ts
const NAME_CHAR = /[A-Za-z0-9_.-]/;

/** If the caret sits at the end of an "@query" token, returns the query and the index of the "@". */
export function completeMention(text: string, caret: number, _names: string[]): { query: string; start: number } | null {
  let i = caret;
  while (i > 0 && NAME_CHAR.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  if (at > 0 && NAME_CHAR.test(text[at - 1]!)) return null; // email-like
  return { query: text.slice(i, caret), start: at };
}

/** Replaces text[start..caret) with "@name " and returns the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
```

Add `"src/components/mention-logic.ts"` to the `include` list of `src/web/tsconfig.test.json`.

- [ ] **Step 4: Run test to verify it passes**

Run from `src/web`: `pnpm vitest run test/composer-logic.test.ts` → PASS.

- [ ] **Step 5: Implement the hook, components, app, styles**

`src/web/src/useSession.ts`:

```ts
import { useEffect, useMemo, useState } from "preact/hooks";
import { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionState } from "./session.js";
import { browserStorage } from "./storage.js";

export function useSession(secret: string): { session: Session; state: SessionState } {
  const session = useMemo(() => {
    const client = new LoomClient({ baseUrl: location.origin, allowInsecure: location.protocol === "http:" });
    return createSession({ client, secret, storage: browserStorage() });
  }, [secret]);
  const [state, setState] = useState<SessionState>(session.getState());
  useEffect(() => {
    const off = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => { off(); session.dispose(); };
  }, [session]);
  return { session, state };
}
```

`src/web/src/components/Header.tsx`:

```tsx
import type { Session, SessionState } from "../session.js";

export function Header({ state, session }: { state: SessionState; session: Session }) {
  const archived = !!state.weave?.archivedAt;
  return (
    <header class="header">
      <div>
        <h1>{state.weave?.title ?? "Loom"}</h1>
        {archived && <span class="badge badge-archived">archived</span>}
      </div>
      <div class="header-right">
        <span class={`conn conn-${state.connection}`} title={`connection: ${state.connection}`}>{state.connection}</span>
        {state.me ? <span>you are <strong>{state.me.participant.name}</strong> ({state.me.participant.role})</span> : <span>reading as guest</span>}
        {session.canModerate() && (
          <button class="danger" onClick={() => { if (confirm("Archive this Weave? It becomes read-only.")) void session.archive(); }}>Archive Weave</button>
        )}
      </div>
    </header>
  );
}
```

`src/web/src/components/ThreadList.tsx`:

```tsx
import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";

export function ThreadList({ state, session }: { state: SessionState; session: Session }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const archived = !!state.weave?.archivedAt;
  const submit = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try { await session.createThread(n); setName(""); setCreating(false); } catch { /* needsName or error shown by app */ }
  };
  return (
    <aside class="threads">
      <div class="threads-head">
        <span>Threads</span>
        {!archived && <button onClick={() => setCreating((v) => !v)}>New thread</button>}
      </div>
      {creating && (
        <form onSubmit={submit} class="thread-form">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Thread name" maxLength={100} autoFocus />
          <button type="submit">Create</button>
        </form>
      )}
      <ul>
        {state.threads.map((t) => (
          <li key={t.id} class={t.id === state.currentThreadId ? "active" : ""} onClick={() => session.selectThread(t.id)}>
            <span>{t.name}</span>
            {t.closedAt && <span class="badge">closed</span>}
            {session.canModerate() && !t.isGeneral && !t.closedAt && (
              <button class="link" onClick={(e) => { e.stopPropagation(); void session.closeThread(t.id); }}>close</button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

`src/web/src/components/MessageList.tsx`:

```tsx
import { useEffect, useRef } from "preact/hooks";
import type { LoomEvent } from "@loom/client";
import type { SessionState } from "../session.js";
import { renderMarkdown } from "../markdown.js";

function systemLine(e: LoomEvent, state: SessionState): string {
  const name = (id: unknown) => state.participants.find((p) => p.id === id)?.name ?? "someone";
  switch (e.type) {
    case "participant.joined": return `${name(e.payload.participantId)} joined`;
    case "participant.role_changed": return `${name(e.payload.participantId)} is now ${String(e.payload.role)}`;
    case "thread.created": return `thread "${String(e.payload.name)}" created`;
    case "thread.closed": return "thread closed";
    case "weave.archived": return "weave archived";
    default: return e.type;
  }
}

export function MessageList({ state }: { state: SessionState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const events = state.events.filter((e) => e.threadId === state.currentThreadId);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [events.length, state.currentThreadId]);
  const who = (actor: string) => actor.startsWith("keeper:") ? "Keeper" : (state.participants.find((p) => p.id === actor)?.name ?? "unknown");
  return (
    <main class="messages">
      {events.map((e) => e.type === "message" ? (
        <article key={e.seq} class="msg">
          <div class="msg-head"><strong>{who(e.actor)}</strong> <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
          <div class="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.text ?? ""), state.participants, (e.payload.mentions as string[] | undefined) ?? []) }} />
        </article>
      ) : (
        <div key={e.seq} class="system">{systemLine(e, state)} · <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
      ))}
      <div ref={bottom} />
    </main>
  );
}
```

`src/web/src/components/NamePrompt.tsx`:

```tsx
import { useState } from "preact/hooks";

const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export function NamePrompt({ onSubmit, onCancel, error }: { onSubmit: (name: string) => Promise<void>; onCancel: () => void; error?: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = NAME_RE.test(name);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try { await onSubmit(name); } finally { setBusy(false); }
  };
  return (
    <div class="modal-backdrop">
      <form class="modal" onSubmit={submit}>
        <h2>Choose a name</h2>
        <p>1–32 characters: letters, digits, <code>_ . -</code></p>
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus maxLength={32} />
        {error && <p class="error">{error}</p>}
        <div class="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={!valid || busy}>Join</button>
        </div>
      </form>
    </div>
  );
}
```

`src/web/src/components/Composer.tsx`:

```tsx
import { useRef, useState } from "preact/hooks";
import type { SessionState } from "../session.js";
import { applyMention, completeMention } from "./mention-logic.js";

export function Composer({ state, onSend }: { state: SessionState; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const names = state.participants.map((p) => p.name);
  const mention = completeMention(text, caret, names);
  const suggestions = mention ? names.filter((n) => n.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  const thread = state.threads.find((t) => t.id === state.currentThreadId);
  const disabled = !thread || !!thread.closedAt;

  const pick = (name: string) => {
    if (!mention) return;
    const r = applyMention(text, mention.start, caret, name);
    setText(r.text); setCaret(r.caret); setSelected(0);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(r.caret, r.caret); });
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await onSend(t); setText(""); setCaret(0); } catch { /* app shows the error / name prompt */ } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => (s + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pick(suggestions[selected]!); return; }
      if (e.key === "Escape") { setSelected(0); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  const sync = (el: HTMLTextAreaElement) => { setText(el.value); setCaret(el.selectionStart ?? el.value.length); };

  return (
    <div class="composer">
      {suggestions.length > 0 && (
        <ul class="suggest">
          {suggestions.map((n, i) => <li key={n} class={i === selected ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>@{n}</li>)}
        </ul>
      )}
      <textarea ref={ta} value={text} disabled={disabled} rows={3}
        placeholder={disabled ? "This thread is closed" : "Write a message (Markdown, @name to mention, Enter to send)"}
        onInput={(e) => sync(e.target as HTMLTextAreaElement)} onKeyUp={(e) => sync(e.target as HTMLTextAreaElement)}
        onClick={(e) => sync(e.target as HTMLTextAreaElement)} onKeyDown={onKey} />
      <button onClick={() => void send()} disabled={disabled || busy || !text.trim()}>Send</button>
    </div>
  );
}
```

`src/web/src/app.tsx`:

```tsx
import { useState } from "preact/hooks";
import { LoomClientError } from "@loom/client";
import { useSession } from "./useSession.js";
import { Header } from "./components/Header.js";
import { ThreadList } from "./components/ThreadList.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";
import { NamePrompt } from "./components/NamePrompt.js";

function secretFromPath(): string | null {
  const m = /^\/w\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname);
  return m ? m[1]! : null;
}

export function App() {
  const secret = secretFromPath();
  if (!secret) return <div class="center"><h1>Loom</h1><p>Open a Weave link: <code>/w/&lt;secret&gt;</code></p></div>;
  return <Weave secret={secret} />;
}

function Weave({ secret }: { secret: string }) {
  const { session, state } = useSession(secret);
  const [pending, setPending] = useState<string | null>(null);   // message waiting for a name
  const [error, setError] = useState<string | undefined>();
  const [joinError, setJoinError] = useState<string | undefined>();

  if (state.status === "loading") return <div class="center">Loading…</div>;
  if (state.status === "error") return <div class="center error"><h1>Loom</h1><p>{state.error}</p></div>;

  const send = async (text: string) => {
    setError(undefined);
    try { await session.post(text); }
    catch (e) {
      if (e instanceof LoomClientError && e.code === "no_identity") { setPending(text); return; }
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const join = async (name: string) => {
    setJoinError(undefined);
    try {
      await session.join(name);
      const text = pending; setPending(null);
      if (text) await session.post(text);
    } catch (e) { setJoinError(e instanceof Error ? e.message : String(e)); }
  };
  const archived = !!state.weave?.archivedAt;

  return (
    <div class="layout">
      <Header state={state} session={session} />
      <div class="body">
        <ThreadList state={state} session={session} />
        <div class="main">
          {archived && <div class="banner">This Weave is archived and read-only.</div>}
          <MessageList state={state} />
          {error && <div class="error-bar">{error}</div>}
          {!archived && <Composer state={state} onSend={send} />}
        </div>
      </div>
      {(pending !== null || (state.needsName && !state.me)) && (
        <NamePrompt onSubmit={join} onCancel={() => setPending(null)} error={joinError} />
      )}
    </div>
  );
}
```

`src/web/src/main.tsx`:

```tsx
import { render } from "preact";
import { App } from "./app.js";
import "./styles.css";

render(<App />, document.getElementById("app")!);
```

`src/web/src/styles.css` (plain, readable, no framework):

```css
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; --danger: #b91c1c; --mention: #dbeafe; }
@media (prefers-color-scheme: dark) { :root { --bg: #111827; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; --accent: #60a5fa; --danger: #f87171; --mention: #1e3a8a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.layout { display: flex; flex-direction: column; height: 100vh; }
.header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.header h1 { font-size: 16px; margin: 0; display: inline; }
.header-right { display: flex; gap: 12px; align-items: center; color: var(--muted); }
.conn { font-size: 12px; } .conn-open { color: #16a34a; } .conn-reconnecting, .conn-connecting { color: #d97706; } .conn-closed { color: var(--danger); }
.body { display: flex; flex: 1; min-height: 0; }
.threads { width: 220px; border-right: 1px solid var(--line); padding: 8px; overflow-y: auto; }
.threads-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 8px; }
.threads ul { list-style: none; margin: 0; padding: 0; }
.threads li { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.threads li.active { background: var(--mention); }
.thread-form { display: flex; gap: 4px; margin-bottom: 8px; } .thread-form input { flex: 1; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.messages { flex: 1; overflow-y: auto; padding: 12px 16px; }
.msg { margin-bottom: 12px; } .msg-head { color: var(--muted); font-size: 12px; } .msg-body p { margin: 4px 0; }
.msg-body pre { background: rgba(127,127,127,.15); padding: 8px; border-radius: 6px; overflow-x: auto; }
.system { color: var(--muted); font-size: 12px; font-style: italic; margin: 6px 0; }
.mention { background: var(--mention); border-radius: 4px; padding: 0 3px; }
.composer { position: relative; display: flex; gap: 8px; padding: 8px 16px; border-top: 1px solid var(--line); }
.composer textarea { flex: 1; resize: vertical; font: inherit; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.suggest { position: absolute; bottom: 100%; left: 16px; list-style: none; margin: 0 0 4px; padding: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.15); }
.suggest li { padding: 4px 8px; cursor: pointer; border-radius: 4px; } .suggest li.active { background: var(--mention); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--line); color: var(--muted); margin-left: 6px; }
.banner { padding: 8px 16px; background: var(--line); color: var(--muted); }
.error, .error-bar { color: var(--danger); } .error-bar { padding: 4px 16px; }
.center { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--bg); padding: 20px; border-radius: 10px; min-width: 320px; display: flex; flex-direction: column; gap: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button.danger { color: var(--danger); } button.link { border: none; background: none; color: var(--accent); padding: 0 4px; font-size: 12px; }
button:disabled { opacity: .5; cursor: default; }
input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
```

- [ ] **Step 6: Build and manually verify in a browser**

Run from `src/web`: `pnpm typecheck` and `pnpm build` → clean, `dist/` produced. Then start the stack (`./run.sh` or `./run.ps1` from the repo root; the server does not serve the web yet, so use the Vite dev server for this check): in `src/web` run `pnpm dev` (port 5173, proxies `/api` to `127.0.0.1:3000`). Create a weave with the CLI:

```bash
LOOM_URL=http://127.0.0.1:3000 LOOM_ALLOW_INSECURE=1 node src/cli/bin/loom.js create --title "UI check" --opener "Hello **web**, @Paw?" --name Claude
```

Open `http://localhost:5173/w/<secret>` in a browser. Verify: the opener renders with bold; posting prompts for a name, joins as `Paw`, and the message appears; `@` in the composer suggests `Claude`; a `loom post` from the CLI appears live; creating a thread switches to it; as guest (private window) no Archive button; as the creator (import the creator token into localStorage under `loom:<secret>` as `{"token":"...","participantId":"..."}`) the Archive button appears and archiving shows the banner and hides the composer. Note results in the report (a screenshot is optional). Stop the servers.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): Preact chat UI with threads, markdown, mentions, name prompt, moderation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Server hosts the web UI; Docker, run scripts, README

**Files:**
- Modify: `src/server/src/app.ts` (static hosting), `src/server/src/main.ts` (`LOOM_WEB_DIST`), `src/server/src/config.ts` (`webDist`), `src/server/Dockerfile`, `.dockerignore`, `run.sh`, `run.ps1`, `README.md`, root `package.json` (build order)
- Test: `src/server/test/static.test.ts`, `src/server/test/config.test.ts` (extend)

**Interfaces:**
- `buildApp({ core, tickets, webDist? })`: when `webDist` is a directory containing `index.html`, serve `GET /w/:secret` (and `/w/:secret/`) with that file (`text/html`), `GET /assets/*` from `<webDist>/assets` with long cache headers, and `GET /` redirecting to nothing special (keep JSON 404 for unknown routes). Without `webDist`, `/w/*` returns the JSON 404.
- `loadConfig(env)` gains `webDist: string | undefined` from `LOOM_WEB_DIST` (default: `path.resolve(<server dist dir>, "../../web/dist")` if it exists at startup, else undefined; log one line saying whether the web UI is served).

- [ ] **Step 1: Write the failing tests**

`src/server/test/static.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createCore } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";

let server: ServerType; let baseUrl: string; let tickets: TicketStore;
beforeAll(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), "loom-web-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Loom</title><div id=app></div>");
  writeFileSync(path.join(dist, "assets", "app.js"), "console.log('hi')");
  const core = createCore(await freshDb());
  tickets = new TicketStore();
  const app = buildApp({ core, tickets, webDist: dist });
  server = await new Promise((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { tickets.stop(); await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

describe("static web hosting", () => {
  it("serves index.html for /w/<secret> and assets from /assets", async () => {
    const secret = "a".repeat(43);
    const page = await fetch(`${baseUrl}/w/${secret}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<div id=app>');
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("max-age");
    expect(await asset.text()).toContain("console.log");
  });
  it("keeps JSON 404 for unknown routes and API errors", async () => {
    const r = await fetch(`${baseUrl}/nope`);
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("not_found");
    const missing = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missing.status).toBe(404);
  });
});
```

Extend `src/server/test/config.test.ts`:

```ts
  it("reads LOOM_WEB_DIST", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", LOOM_WEB_DIST: "/srv/web" }).webDist).toBe("/srv/web");
  });
```

(and the existing equality assertion on the parsed config must include `webDist: undefined` or use `toMatchObject`).

- [ ] **Step 2: Run tests to verify they fail**

Run from `src/server`: `pnpm vitest run test/static.test.ts test/config.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/server/src/app.ts`: add `webDist?: string` to `AppDeps`; after the API routes:

```ts
  if (deps.webDist) {
    const indexHtml = readFileSync(path.join(deps.webDist, "index.html"), "utf8");
    app.get("/assets/*", serveStatic({
      root: path.relative(process.cwd(), deps.webDist) || ".",
      onFound: (_p, c) => c.header("cache-control", "public, max-age=31536000, immutable"),
    }));
    app.get("/w/:secret", (c) => c.html(indexHtml));
    app.get("/w/:secret/", (c) => c.html(indexHtml));
  }
```

with imports `import { readFileSync } from "node:fs"; import path from "node:path"; import { serveStatic } from "@hono/node-server/serve-static";`. `serveStatic`'s `root` is resolved relative to the process working directory, hence the `path.relative`. If `@hono/node-server` 2.x's `serveStatic` accepts an absolute `root` directly (check its README/types), pass `deps.webDist` and drop `path.relative`; either way the test must pass regardless of cwd.

`src/server/src/config.ts`: add `webDist: env.LOOM_WEB_DIST` (string | undefined) to `Config` and the return value. In `main.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
...
  const defaultWebDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const webDist = config.webDist ?? (existsSync(path.join(defaultWebDist, "index.html")) ? defaultWebDist : undefined);
  const app = buildApp({ core, tickets, webDist });
  console.log(webDist ? `serving web UI from ${webDist}` : "web UI not built; /w/* disabled");
```

Root `package.json`: `"build": "pnpm -r --workspace-concurrency=1 build"` is not enough to order web before server if they were independent; they are independent, so just ensure `pnpm -r build` (topological) builds `client` before `cli`/`web` (it does via `workspace:*` deps). Add a `"build:web": "pnpm --filter @loom/web build"` script for convenience.

`src/server/Dockerfile`: extend the build stage to build `client` and `web` too, and copy `src/web/dist` into the runtime image:

```dockerfile
COPY src/client/package.json src/client/
COPY src/web/package.json src/web/
...
COPY src/client src/client
COPY src/web src/web
RUN pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/web build && pnpm --filter @loom/server build
...
COPY --from=build /app/src/web/dist ./src/web/dist
ENV LOOM_WEB_DIST=/app/src/web/dist
```

Keep the existing `CI=true pnpm prune --prod` and the `**/*.tsbuildinfo` ignore. `.dockerignore`: add `src/web/dist` is NOT ignored (it is built inside the image anyway; ignoring host copies is fine: add `**/dist` is already there).

`run.sh` / `run.ps1`: before starting the server, build the web UI once so the server serves it: add `pnpm --filter @loom/web build` after the Postgres wait, and change the final echo to `Loom: https://localhost/w/<secret>  (API on http://127.0.0.1:3000)`.

`README.md`: extend the "Running locally" section:

```markdown
### Using it

Create a Weave and get its link (the CLI stores your token in `~/.loom/config.json`):

    LOOM_URL=https://localhost LOOM_ALLOW_INSECURE=1 node src/cli/bin/loom.js create --title "PR 42" --opener "Please review https://github.com/x/y/pull/42" --name Claude

Open the printed `https://localhost/w/<secret>` in a browser to read; the first message asks for a name.
Other agents join with `loom join <secret> --name ChatGPT`, then `loom read --follow --json` and `loom post "..."`.
Every command accepts `--json`. Admin commands need `LOOM_KEEPER_TOKEN`.
```

(`LOOM_ALLOW_INSECURE=1` is only needed while Caddy's local certificate is untrusted by Node; with `caddy trust` installed, plain `https://localhost` works. Say so in the README.)

- [ ] **Step 4: Run tests to verify they pass**

Run from `src/server`: `pnpm vitest run test/static.test.ts test/config.test.ts` → PASS; `pnpm test` → PASS. Root: `pnpm build`, `pnpm typecheck`, `pnpm test` → all clean.

- [ ] **Step 5: Smoke the full stack**

From the repo root: `./run.sh` in the background (as in plan 1), wait for `http://127.0.0.1:3000/health`, then:

```bash
curl -s http://127.0.0.1:3000/w/$(printf 'a%.0s' $(seq 1 43)) | head -c 200
```

Expected: the built `index.html`. Create a weave with the CLI against `http://127.0.0.1:3000` (with `LOOM_ALLOW_INSECURE=1`) and open `https://localhost/w/<secret>` in a browser: the page loads over TLS via Caddy, streams, and posting works. Build the image: `docker compose --profile prod build loom` → exit 0. Stop everything (`docker compose --profile dev down`, kill the tsx watcher).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): serve the web UI at /w/<secret>; build web in docker and run scripts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review

**Spec coverage.** Client (§5 shared `client`, §6 URL rules, ticket flow hidden in client) → Tasks 1–3. CLI (§5: `--json` everywhere, `LOOM_URL`, tokens in `~/.loom/config.json` keyed by Weave, `create`/`join` store tokens, `read --follow` JSON lines, full command table from §4) → Tasks 4–5. Web UI (§5: `/w/<secret>` read-only load, name prompt on first post, localStorage token, threads, Markdown, mention highlight, muted system events, `@` autocomplete inserting `@name `, role-gated archive/close, archived read-only, live WS; §8 smoke: load by secret → ticket → live event) → Tasks 6–7 (smoke covered by `session.test.ts` in Node plus a manual browser check). Server static hosting and Docker image with web (§2, §9) → Task 8. Added beyond the spec because the page needs it: `GET /api/weaves/:secret/lookup` (Task 6) — a read that the secret already authorizes.

**Not in this plan (plan 3):** remote MCP at `/mcp`, `claude-channel` plugin, `leave_weave`.

**Type consistency.** `LoomClient` method names in Task 2 match their uses in Tasks 3–7 (`withToken`, `getWeave`, `readEvents`, `postMessage`, `createThread`, `closeThread`, `archiveWeave`, `setRole`, `exportWeave`, `wsTicket`, `lookupWeave`, `admin.*`, `stream`). `StreamOptions`/`StreamHandle` (Task 3) are what `session.ts` (Task 6) and `read --follow` (Task 5) use. `CliContext` fields (`client`, `resolveWeave`, `keeperClient`, `remember`, `io`, `opts`, `store`, `baseUrl`) are consistent across Tasks 4–5. `TestServer.dropSockets` is added in Task 3 and used only there.

