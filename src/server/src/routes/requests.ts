import { Hono } from "hono";
import { z } from "zod";
import type { Core, RequestStatus } from "@loom/core";
import { errors } from "@loom/core";
import { requireActor, type Env } from "../auth.js";
import { body } from "../validate.js";

export function requestRoutes(core: Core) {
  const r = new Hono<Env>();

  r.post("/", async (c) => {
    const actor = await requireActor(c, core);
    const b = await body(c, z.object({
      title: z.string(), requirements: z.unknown(), wanted: z.number().optional(), timeoutMs: z.number().optional(),
      targetWeaveId: z.string(), targetThreadId: z.string(), url: z.string().nullable().optional(),
      // Two credentials, because a request spans two Weaves: the bearer is the caller's Lobby
      // identity, this one its authority in the Weave the helpers will be invited into. An agent
      // key is one actor everywhere, so it may stand for both and leave this out.
      targetCredential: z.string().optional(),
    }));
    const targetActor = b.targetCredential ? await core.resolveCredential(b.targetCredential) : undefined;
    const input = {
      title: b.title, requirements: b.requirements, wanted: b.wanted, timeoutMs: b.timeoutMs,
      targetWeaveId: b.targetWeaveId, targetThreadId: b.targetThreadId, url: b.url ?? null,
    };
    return c.json(await core.openRequest(actor, targetActor, input), 201);
  });

  r.get("/", async (c) => {
    const actor = await requireActor(c, core);
    // Types only: the status is passed through as the string it is (which words name one is core's
    // rule, and the status it filters on is the computed one, so a crossed but unswept request is
    // never `open`), and whether the number is an acceptable page is core's rule too.
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().optional() }).safeParse(c.req.query());
    if (!q.success) throw errors.validation("Invalid query parameters");
    const status = q.data.status as RequestStatus | undefined;
    return c.json({ requests: await core.listRequests(actor, { status, limit: q.data.limit }) });
  });

  r.get("/:id", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.getRequest(actor, c.req.param("id")));
  });

  r.post("/:id/offers", async (c) => {
    const actor = await requireActor(c, core);
    const input = await body(c, z.object({
      model: z.string().optional(), effort: z.string().optional(), note: z.string().optional(),
    }));
    return c.json(await core.offer(actor, c.req.param("id"), input), 201);
  });

  r.post("/:id/accept", async (c) => {
    const actor = await requireActor(c, core);
    // Types only: a missing deadlineMs is passed through, so core answers "deadlineMs is required".
    const { participantIds, deadlineMs } = await body(c, z.object({ participantIds: z.array(z.string()), deadlineMs: z.number().optional() }));
    return c.json(await core.acceptRequest(actor, c.req.param("id"), participantIds, deadlineMs));
  });

  r.post("/:id/complete", async (c) => {
    const actor = await requireActor(c, core);
    const { note } = await body(c, z.object({ note: z.string().optional() }));
    return c.json(await core.completeRequest(actor, c.req.param("id"), note));
  });

  r.post("/:id/cancel", async (c) => {
    const actor = await requireActor(c, core);
    return c.json(await core.cancelRequest(actor, c.req.param("id")));
  });

  return r;
}
