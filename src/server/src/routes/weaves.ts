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
    // `name` is optional: an agent key on this call supplies the agent's registered name.
    const who = await body(c, z.object({ name: z.string().optional(), kind: kindSchema }));
    // An agent key on the join call links the new participant to that agent (and makes a repeat
    // join return the identity it already owns here). A credential that is present but does not
    // resolve is an error: a revoked key must not fall back to joining anonymously.
    const actor = await optionalActor(c, core);
    return c.json(await core.joinWeave(c.req.param("secret"), who, actor), 201);
  });

  r.get("/:secret/lookup", async (c) => c.json({ weaveId: await core.lookupWeaveIdBySecret(c.req.param("secret")) }));

  r.get("/:id", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.getWeave(actor, c.req.param("id")));
  });

  r.get("/:id/events", async (c) => {
    const actor = await requireActor(c, core);
    // Types only: the schema turns query strings into numbers, core decides whether the numbers
    // are an acceptable page (so MCP, which has no schema-level bounds, answers identically).
    const q = z.object({
      since: z.coerce.number().optional(),
      thread: z.string().uuid().optional(),
      limit: z.coerce.number().optional(),
    }).safeParse(c.req.query());
    if (!q.success) throw errors.validation("Invalid query parameters");
    const events = await core.readEvents(actor, c.req.param("id"), { since: q.data.since, threadId: q.data.thread, limit: q.data.limit });
    return c.json({ events });
  });

  r.get("/:id/inbox", async (c) => {
    const actor = await requireActor(c, core);
    const q = z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }).safeParse(c.req.query());
    if (!q.success) throw errors.validation("Invalid query parameters");
    return c.json({ events: await core.inbox(actor, c.req.param("id"), q.data) });
  });

  r.post("/:id/threads", async (c) => {
    const actor = await requireActor(c, core);
    const { name, url } = await body(c, z.object({ name: z.string(), url: z.string().nullable().optional() }));
    return c.json(await core.createThread(actor, c.req.param("id"), name, url ?? null), 201);
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
