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
