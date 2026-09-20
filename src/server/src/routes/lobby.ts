import { Hono } from "hono";
import { z } from "zod";
import type { AgentFilter, Core, ListenersQuery } from "@loom/core";
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

  // The read half of the write below it. Hono matches `/participants/me` and
  // `/participants/me/capabilities` as distinct literal paths, so neither shadows the other and the
  // order between them is free. Who may ask is core's rule: a Weave secret and an instance keeper
  // own no participant row and are refused, where `/listeners` admits both.
  r.get("/participants/me", async (c) => c.json(await core.getMyLobbyParticipant(await requireActor(c, core))));

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

  r.get("/listeners", async (c) => {
    const actor = await requireActor(c, core);
    const raw = c.req.query("filter");
    const limit = c.req.query("limit");
    let filter: unknown = {};
    if (raw !== undefined && raw !== "") {
      // Only that it is JSON is decided here; what a legal filter contains is core's rule.
      try { filter = JSON.parse(raw); } catch { throw errors.validation("filter must be JSON"); }
      // …and that it is an *object*, because the line below spreads it. `{ ...5 }` and `{ ...null }`
      // spread nothing — a nonsense filter would become "no filter" and answer with the whole Lobby
      // — and `{ ...[1,2] }` would spread `{"0":1,"1":2}`. Nothing is narrowed here; the values
      // inside are still core's to accept or reject.
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
        throw errors.validation("filter must be a JSON object");
      }
    }
    return c.json(await core.listListeners(actor, {
      ...(filter as object),
      // An absent parameter is `undefined`, which is the only thing core reads as absent: a `null`
      // or an `""` in its place would be a supplied value and earn a 400. `?q=` is a blank search,
      // which core normalises to absent — the whole Lobby, not nothing.
      q: c.req.query("q"), sort: c.req.query("sort"), dir: c.req.query("dir"),
      // `Number("soon")` is `NaN`, which core rejects with the message a CLI caller would get. The
      // adapter deliberately does not pre-validate it (`paging.ts:20-22`). A *blank* one is not a
      // number at all: `Number("")` and `Number(" ")` are both 0, which would answer "no rows,
      // counts only" for a page size nobody supplied. Blank is absent here, as it is for `filter`
      // and for `q` — an empty parameter is a parameter the caller did not fill in.
      limit: limit === undefined || limit.trim() === "" ? undefined : Number(limit),
      cursor: c.req.query("cursor"),
      // The one boolean in the query string. `?facets=false` is the only way to turn them off;
      // everything else, including absence, leaves core's default alone.
      facets: c.req.query("facets") === "false" ? false : undefined,
    } as ListenersQuery));
  });

  return r;
}
