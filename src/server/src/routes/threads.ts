import { Hono } from "hono";
import { z } from "zod";
import type { Core } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

export function threadRoutes(core: Core) {
  const r = new Hono<Env>();

  r.post("/:id/messages", async (c) => {
    const actor = await requireActor(c, core);
    const { text } = await body(c, z.object({ text: z.string() }));
    return c.json(await core.postMessage(actor, c.req.param("id"), text), 201);
  });

  r.put("/:id/url", async (c) => {
    const actor = await requireActor(c, core);
    const { url } = await body(c, z.object({ url: z.string().nullable() }));
    return c.json(await core.setThreadUrl(actor, c.req.param("id"), url));
  });

  r.post("/:id/invites", async (c) => {
    const actor = await requireActor(c, core);
    const { participantId } = await body(c, z.object({ participantId: z.string() }));
    const result = await core.inviteParticipant(actor, c.req.param("id"), participantId);
    return c.json(result, result.created ? 201 : 200);
  });

  r.post("/:id/removals", async (c) => {
    const actor = await requireActor(c, core);
    const { participantId } = await body(c, z.object({ participantId: z.string() }));
    const result = await core.removeParticipant(actor, c.req.param("id"), participantId);
    return c.json(result, result.created ? 201 : 200);
  });

  r.post("/:id/close", async (c) => {
    const actor = await requireActor(c, core);
    await core.closeThread(actor, c.req.param("id"));
    return c.body(null, 204);
  });

  return r;
}
