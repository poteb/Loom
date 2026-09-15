import { Hono } from "hono";
import type { Core } from "@loom/core";
import type { Env } from "../auth.js";

/** Public: the instance guidelines are handed to MCP connections before they hold any credential. */
export function guidelinesRoutes(core: Core) {
  const r = new Hono<Env>();
  r.get("/", async (c) => c.json({ guidelines: await core.getInstanceGuidelines() }));
  return r;
}
