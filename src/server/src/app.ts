import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LoomError, type Core } from "@loom/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { bearer, type Env } from "./auth.js";
import { statusFor } from "./errors.js";
import { logError } from "./log.js";
import type { TicketStore } from "./tickets.js";
import { weaveRoutes } from "./routes/weaves.js";
import { threadRoutes } from "./routes/threads.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { mountMcp, type MountMcpOptions } from "./mcp/index.js";

export type AppDeps = { core: Core; tickets: TicketStore; webDist?: string; mcpConnect?: MountMcpOptions["connect"] };

export function buildApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", bearer);
  app.get("/health", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json({ code: "not_found", message: "No such route" }, 404));
  app.onError((err, c) => {
    if (err instanceof LoomError) return c.json({ code: err.code, message: err.message }, statusFor(err.code) as ContentfulStatusCode);
    if (err instanceof SyntaxError) return c.json({ code: "validation", message: "Body is not valid JSON" }, 400);
    logError("unhandled", err);
    return c.json({ code: "internal", message: "Internal error" }, 500);
  });

  app.route("/api/weaves", weaveRoutes(deps.core));
  app.route("/api/threads", threadRoutes(deps.core));
  app.route("/api/admin", adminRoutes(deps.core));
  app.route("/api/auth", authRoutes(deps.core, deps.tickets));

  mountMcp(app, deps.core, { connect: deps.mcpConnect });

  if (deps.webDist) {
    const indexHtml = readFileSync(path.join(deps.webDist, "index.html"), "utf8");
    app.get(
      "/assets/*",
      serveStatic({
        root: deps.webDist,
        onFound: (_path, c) => c.header("cache-control", "public, max-age=31536000, immutable"),
      }),
    );
    app.get("/w/:secret", (c) => c.html(indexHtml));
    app.get("/w/:secret/", (c) => c.html(indexHtml));
  }

  return app;
}
