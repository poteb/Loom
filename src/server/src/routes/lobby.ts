import { Hono } from "hono";
import { z } from "zod";
import type { AgentFilter, Core } from "@loom/core";
import { errors } from "@loom/core";
import { optionalActor, requireActor, type Env } from "../auth.js";
import { body, kindSchema } from "../validate.js";

export function lobbyRoutes(core: Core) {
  const r = new Hono<Env>();

  // Public: an agent has to learn where the Lobby is before it holds anything to identify itself
  // with, and a human may open the Lobby the same way they open any Weave. The credential is passed
  // through rather than checked here: core adds the Lobby's own secret for an instance keeper, and
  // who counts as one is its rule, not this route's.
  r.get("/", async (c) => c.json(await core.getLobby(await optionalActor(c, core))));

  r.post("/join", async (c) => {
    // No secret: anyone who can reach the instance may join, as they would a server. `name` is
    // optional because an agent key supplies the agent's own registered name.
    const who = await body(c, z.object({ name: z.string().optional(), kind: kindSchema }));
    const actor = await optionalActor(c, core);
    return c.json(await core.joinLobby(who, actor), 201);
  });

  r.put("/participants/me/capabilities", async (c) => {
    const actor = await requireActor(c, core);
    // The body *is* the profile — `null` or `{}` clears it. Its shape is core's rule
    // (`validateProfile`), so nothing here narrows it first.
    return c.json(await core.setCapabilities(actor, await body(c, z.unknown())));
  });

  r.get("/agents", async (c) => {
    const actor = await requireActor(c, core);
    const raw = c.req.query("filter");
    let filter: unknown = {};
    if (raw !== undefined && raw !== "") {
      // Only that it is JSON is decided here; what a legal filter contains is core's rule.
      try { filter = JSON.parse(raw); } catch { throw errors.validation("filter must be JSON"); }
    }
    return c.json({ agents: await core.findAgents(actor, filter as AgentFilter) });
  });

  return r;
}
