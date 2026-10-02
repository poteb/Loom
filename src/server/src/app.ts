import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LoomError, type Core } from "@loom/core";
import { defaultSkills, renderDocument, renderSkillsIndex, type Skill } from "@loom/mcp-tools";
import { serveStatic } from "@hono/node-server/serve-static";
import { bearer, type Env } from "./auth.js";
import { statusFor } from "./errors.js";
import { logError } from "./log.js";
import { publicOrigin } from "./origin.js";
import type { TicketStore } from "./tickets.js";
import { guidelinesRoutes } from "./routes/guidelines.js";
import { weaveRoutes } from "./routes/weaves.js";
import { threadRoutes } from "./routes/threads.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agents.js";
import { authRoutes } from "./routes/auth.js";
import { lobbyRoutes } from "./routes/lobby.js";
import { requestRoutes } from "./routes/requests.js";
import { mountMcp, type MountMcpOptions } from "./mcp/index.js";

export type AppDeps = {
  core: Core;
  tickets: TicketStore;
  webDist?: string;
  mcpConnect?: MountMcpOptions["connect"];
  mcpSessionTtlMs?: MountMcpOptions["sessionTtlMs"];
  mcpLog?: MountMcpOptions["log"];
  /** How often crossed requests are swept. A test seam; a minute in production. */
  requestSweepMs?: number;
  /**
   * The skills `/skills` and every MCP session serve (spec 2026-09-28 §4.1): one array, so the routes
   * and `get_skill` cannot disagree. `main.ts` loads it before building the app; `defaultSkills()`
   * when omitted.
   */
  skills?: readonly Skill[];
};

/** What one pass of the sweep did: requests closed as expired, overdue notices emitted, and offline Listeners removed. */
export type SweepResult = { closed: number; overdue: number; removed: number };

/**
 * The app and the one background job that comes with it. `sweepNow` is the same pass the interval
 * makes, for a caller that will not wait for it; `stop` ends the interval at teardown, beside the
 * ticket store's own `stop`.
 */
export type LoomApp = {
  app: Hono<Env>;
  sweepNow: (now?: Date) => Promise<SweepResult>;
  stop: () => void;
};

/** The spec's sweep period: a request never reads `open` for more than a minute past its deadline. */
export const DEFAULT_REQUEST_SWEEP_MS = 60_000;

export function buildApp(deps: AppDeps): LoomApp {
  const app = new Hono<Env>();

  app.use("*", bearer);
  app.get("/health", (c) => c.json({ ok: true }));
  // The walkthrough as a document (spec §7): public, reads no database, reflects nothing from the
  // request but its origin. Registered here, not in the webDist block, so an API-only server serves it.
  const markdown = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "max-age=300" };
  app.get("/join-loom.md", (c) => c.body(renderDocument(publicOrigin(c)), 200, markdown));
  // Loom's skills (spec 2026-09-28 §4.1), beside /join-loom.md and for the same reasons: public, no
  // database read, served by an API-only server too. A skill is found by exact name among those
  // loaded at boot, so the request never becomes a file path; any other path under /skills/ is the
  // skills' own 404. Registered in this order because Hono matches in registration order.
  const skills = deps.skills ?? defaultSkills();
  const skillsIndex = (c: Context<Env>) => c.body(renderSkillsIndex(skills, publicOrigin(c)), 200, markdown);
  app.get("/skills", skillsIndex);
  app.get("/skills/", skillsIndex);
  app.get("/skills/*", (c) => {
    const skill = skills.find((s) => `/skills/${s.name}.md` === c.req.path);
    return skill ? c.body(skill.text, 200, markdown) : c.json({ code: "not_found", message: "No such skill" }, 404);
  });

  app.notFound((c) => c.json({ code: "not_found", message: "No such route" }, 404));
  app.onError((err, c) => {
    if (err instanceof LoomError) return c.json({ code: err.code, message: err.message }, statusFor(err.code) as ContentfulStatusCode);
    if (err instanceof SyntaxError) return c.json({ code: "validation", message: "Body is not valid JSON" }, 400);
    logError("unhandled", err);
    return c.json({ code: "internal", message: "Internal error" }, 500);
  });

  // Grouped with the Weave routes because it is the other half of the guidelines surface, not
  // because anything would shadow it: /api/guidelines and /api/weaves are distinct prefixes, so
  // the order between these two lines is free. The public instance text is its own resource,
  // read without a credential, rather than a Weave read.
  app.route("/api/guidelines", guidelinesRoutes(deps.core));
  app.route("/api/weaves", weaveRoutes(deps.core));
  app.route("/api/threads", threadRoutes(deps.core));
  app.route("/api/lobby", lobbyRoutes(deps.core));
  app.route("/api/requests", requestRoutes(deps.core));
  // Before /api/admin: Hono matches in registration order, and adminRoutes has no /agents of its own.
  app.route("/api/admin/agents", agentRoutes(deps.core));
  app.route("/api/admin", adminRoutes(deps.core));
  app.route("/api/auth", authRoutes(deps.core, deps.tickets));

  mountMcp(app, deps.core, { connect: deps.mcpConnect, sessionTtlMs: deps.mcpSessionTtlMs, log: deps.mcpLog, skills });

  if (deps.webDist) {
    const indexHtml = readFileSync(path.join(deps.webDist, "index.html"), "utf8");
    app.get(
      "/assets/*",
      serveStatic({
        root: deps.webDist,
        onFound: (_path, c) => c.header("cache-control", "public, max-age=31536000, immutable"),
      }),
    );
    // Every path the web UI routes; deliberately enumerated rather than a catch-all, so an unknown
    // path stays the API's JSON 404 (a client library must not be handed an HTML page).
    for (const p of ["/", "/lobby", "/lobby/", "/lobby/listeners", "/lobby/listeners/",
      "/weave/:id", "/weave/:id/", "/w/:secret", "/w/:secret/"]) {
      app.get(p, (c) => c.html(indexHtml));
    }
  }

  // Status is computed on read, so nothing depends on this having run: it is what turns a crossed
  // deadline into the `request.closed` that stops everyone waiting on it, a missed work deadline
  // into the `request.overdue` its requester acts on, and a Listener gone past the instance's limit
  // into a `listener.removed` (spec 2026-09-30 §5.5). One clock read serves the three passes, the
  // same process clock `accept` writes due times from (spec §6.4). The removal runs third, so a
  // request this pass closes is closed before its offerers are looked at, and an overdue acceptance
  // of a removed Listener gets its `request.overdue` first.
  const sweepNow = async (now: Date = new Date()): Promise<SweepResult> => {
    const closed = await deps.core.sweepRequests(now);
    const overdue = await deps.core.sweepOverdue(now);
    const removed = await deps.core.sweepOfflineListeners(now);
    return { closed, overdue, removed };
  };
  const sweep = setInterval(() => {
    void sweepNow().catch((e) => {
      // Before the first boot created it there is no Lobby to sweep, and nothing to say about it.
      if (e instanceof LoomError && e.code === "weave_not_found") return;
      logError("request sweep", e);
    });
  }, deps.requestSweepMs ?? DEFAULT_REQUEST_SWEEP_MS);
  // Never the reason the process stays alive: the sweep is a background pass, not work of its own.
  sweep.unref();

  return { app, sweepNow, stop: () => clearInterval(sweep) };
}
