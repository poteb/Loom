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
