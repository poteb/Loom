import { Hono } from "hono";
import { z } from "zod";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

/** Keeper-only management of agent keys. The plaintext key is returned once, on mint; listing
 * returns the public agent rows only (no key, no hash). */
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
