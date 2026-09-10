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
