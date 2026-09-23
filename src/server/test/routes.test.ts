import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { DEFAULT_INSTANCE_GUIDELINES } from "@loom/core";
import { startTestServer, api, keeperToken } from "./helpers.js";

const KEEPER = keeperToken("keeper-token");
let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { s = await startTestServer(); await s.core.seedKeepers([KEEPER]); });
afterAll(async () => { await s.close(); });

const creator = { title: "PR 42", opener: "Review https://example/pr/42", creator: { name: "Claude", kind: "agent" } };

describe("weaves", () => {
  it("create → join → get → events → thread → post → role → archive → export", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect(c.status).toBe(201);
    const { weave, secret, token, generalThread } = c.json;
    expect(secret).toHaveLength(43);

    const j = await api(s.baseUrl, "POST", `/api/weaves/${secret}/join`, { name: "ChatGPT", kind: "agent" });
    expect(j.status).toBe(201);
    const gpt = j.json.token as string;

    const g = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}`, undefined, secret);
    expect(g.status).toBe(200);
    expect(g.json.participants).toHaveLength(2);
    expect(g.text).not.toContain(token);

    const t = await api(s.baseUrl, "POST", `/api/weaves/${weave.id}/threads`, { name: "Design" }, gpt);
    expect(t.status).toBe(201);

    const m = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/messages`, { text: "hi @Claude" }, gpt);
    expect(m.status).toBe(201);
    expect(m.json.payload.mentions).toEqual([c.json.participant.id]);

    const e = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/events?since=3`, undefined, secret);
    expect(e.status).toBe(200);
    expect(e.json.events.map((x: { type: string }) => x.type)).toEqual(["participant.joined", "thread.created", "message"]);
    const e2 = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/events?thread=${generalThread.id}`, undefined, secret);
    expect(e2.json.events.every((x: { threadId: string }) => x.threadId === generalThread.id)).toBe(true);

    const role = await api(s.baseUrl, "PUT", `/api/weaves/${weave.id}/participants/${j.json.participant.id}/role`, { role: "keeper" }, token);
    expect(role.status).toBe(200);
    expect(role.json.role).toBe("keeper");

    const cl = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/close`, undefined, gpt);
    expect(cl.status).toBe(204);

    const a = await api(s.baseUrl, "POST", `/api/weaves/${weave.id}/archive`, undefined, token);
    expect(a.status).toBe(204);

    const late = await api(s.baseUrl, "POST", `/api/threads/${generalThread.id}/messages`, { text: "late" }, gpt);
    expect(late.status).toBe(409);
    expect(late.json.code).toBe("weave_archived");

    const md = await fetch(`${s.baseUrl}/api/weaves/${weave.id}/export?format=md`, { headers: { authorization: `Bearer ${secret}` } });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("# PR 42");
    const js = await api(s.baseUrl, "GET", `/api/weaves/${weave.id}/export?format=json`, undefined, secret);
    expect(js.json.events.at(-1).type).toBe("weave.archived");
  });

  // The route schema still defaults `opener` to `""` (adapters accept a missing first message);
  // what changed is that core no longer turns that into an event, so nothing downstream of this
  // route ever sees a message with an empty body.
  it("an empty opener creates a Weave whose log has no empty message", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", { title: "No opener", creator: { name: "Paw", kind: "human" } });
    expect(c.status).toBe(201);
    expect(c.json.weave.lastSeq).toBe(2);
    const e = await api(s.baseUrl, "GET", `/api/weaves/${c.json.weave.id}/events`, undefined, c.json.token);
    expect(e.json.events.map((x: { type: string }) => x.type)).toEqual(["thread.created", "participant.joined"]);
  });

  it("looks up a weave id by secret; unknown secret is 404", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, secret } = c.json;
    const l = await api(s.baseUrl, "GET", `/api/weaves/${secret}/lookup`);
    expect(l.status).toBe(200);
    expect(l.json.weaveId).toBe(weave.id);
    const bad = await api(s.baseUrl, "GET", "/api/weaves/nope/lookup");
    expect(bad.status).toBe(404);
    expect(bad.json.code).toBe("weave_not_found");
  });

  it("maps errors: 401 no auth, 403 wrong weave, 404 bad secret, 409 name taken, 400 validation", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const b = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${a.json.weave.id}`)).status).toBe(401);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${a.json.weave.id}`, undefined, "garbage")).status).toBe(401);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${b.json.weave.id}`, undefined, a.json.token)).status).toBe(403);
    expect((await api(s.baseUrl, "POST", `/api/weaves/nope/join`, { name: "X", kind: "human" })).status).toBe(404);
    const dup = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { name: "claude", kind: "human" });
    expect(dup.status).toBe(409); expect(dup.json.code).toBe("name_taken");
    const bad = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { name: "a b", kind: "human" });
    expect(bad.status).toBe(400); expect(bad.json.code).toBe("validation");
    const shape = await api(s.baseUrl, "POST", `/api/weaves/${a.json.secret}/join`, { nope: 1 });
    expect(shape.status).toBe(400);
    const notJson = await fetch(`${s.baseUrl}/api/weaves`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("an out-of-range page is 400 validation on both paged reads", async () => {
    // The bounds now live in core, so REST answers exactly what MCP answers: the route schema
    // parses the query string and core decides whether the numbers are acceptable.
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, token } = a.json;
    for (const path of [`/api/weaves/${weave.id}/events`, `/api/weaves/${weave.id}/inbox`]) {
      for (const q of ["limit=0", "limit=1001", "since=-1", "limit=1.5"]) {
        const r = await api(s.baseUrl, "GET", `${path}?${q}`, undefined, token);
        expect([path, q, r.status]).toEqual([path, q, 400]);
        expect(r.json.code).toBe("validation");
      }
      const ok = await api(s.baseUrl, "GET", `${path}?limit=1000&since=0`, undefined, token);
      expect(ok.status).toBe(200);
    }
  });

  it("unknown and malformed ids are 404/400, never 500", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const unknown = "11111111-2222-3333-4444-555555555555";

    const bad = await api(s.baseUrl, "GET", "/api/weaves/not-a-uuid", undefined, KEEPER);
    expect(bad.status).toBe(404); expect(bad.json.code).toBe("weave_not_found");

    const gone = await api(s.baseUrl, "GET", `/api/weaves/${unknown}/events`, undefined, KEEPER);
    expect(gone.status).toBe(404); expect(gone.json.code).toBe("weave_not_found");

    const badEvents = await api(s.baseUrl, "GET", "/api/weaves/not-a-uuid/events", undefined, KEEPER);
    expect(badEvents.status).toBe(404); expect(badEvents.json.code).toBe("weave_not_found");

    // The `thread` filter carries a type only: core's guard owns the uuid rule, so REST answers
    // exactly what MCP answers for a malformed thread id rather than 400 from the route schema.
    const badFilter = await api(s.baseUrl, "GET", `/api/weaves/${a.json.weave.id}/events?thread=not-a-uuid`, undefined, a.json.token);
    expect(badFilter.status).toBe(404); expect(badFilter.json.code).toBe("thread_not_found");

    const msg = await api(s.baseUrl, "POST", "/api/threads/not-a-uuid/messages", { text: "hi" }, a.json.token);
    expect(msg.status).toBe(404); expect(msg.json.code).toBe("thread_not_found");

    const role = await api(s.baseUrl, "PUT", `/api/weaves/${a.json.weave.id}/participants/not-a-uuid/role`, { role: "keeper" }, a.json.token);
    expect(role.status).toBe(400); expect(role.json.code).toBe("validation");

    const keeper = await api(s.baseUrl, "DELETE", "/api/admin/keepers/not-a-uuid", undefined, KEEPER);
    expect(keeper.status).toBe(400); expect(keeper.json.code).toBe("validation");
  });
});

describe("auth + admin", () => {
  it("issues ws tickets for any credential", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    for (const cred of [a.json.token, a.json.secret, KEEPER]) {
      const t = await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, cred);
      expect(t.status).toBe(200);
      expect(t.json.ticket).toHaveLength(43);
      expect(s.tickets.redeem(t.json.ticket)).toBe(cred);
    }
    expect((await api(s.baseUrl, "POST", "/api/auth/ws-ticket")).status).toBe(401);
  });

  it("admin endpoints require instance keeper", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    expect((await api(s.baseUrl, "GET", "/api/admin/weaves", undefined, a.json.token)).status).toBe(403);
    const list = await api(s.baseUrl, "GET", "/api/admin/weaves", undefined, KEEPER);
    expect(list.status).toBe(200);
    expect(list.json.weaves.length).toBeGreaterThan(0);

    const st = await api(s.baseUrl, "PUT", "/api/admin/settings", { openWeaveCreation: false }, KEEPER);
    expect(st.status).toBe(200); expect(st.json.openWeaveCreation).toBe(false);
    expect((await api(s.baseUrl, "POST", "/api/weaves", creator)).status).toBe(403);
    expect((await api(s.baseUrl, "POST", "/api/weaves", creator, KEEPER)).status).toBe(201);
    await api(s.baseUrl, "PUT", "/api/admin/settings", { openWeaveCreation: true }, KEEPER);
    expect((await api(s.baseUrl, "GET", "/api/admin/settings", undefined, KEEPER)).json.openWeaveCreation).toBe(true);

    const add = await api(s.baseUrl, "POST", "/api/admin/keepers", { name: "Ops" }, KEEPER);
    expect(add.status).toBe(201);
    expect((await api(s.baseUrl, "GET", "/api/admin/keepers", undefined, add.json.token)).status).toBe(200);
    expect((await api(s.baseUrl, "DELETE", `/api/admin/keepers/${add.json.keeper.id}`, undefined, KEEPER)).status).toBe(204);
    expect((await api(s.baseUrl, "GET", "/api/admin/keepers", undefined, add.json.token)).status).toBe(401);
  });

  it("rejects an unknown settings key instead of silently dropping it", async () => {
    // A misspelled property used to be stripped by the route schema, so core's strict schema never
    // saw it and the keeper got a 200 reporting settings it had not changed.
    const before = await api(s.baseUrl, "GET", "/api/admin/settings", undefined, KEEPER);
    const bad = await api(s.baseUrl, "PUT", "/api/admin/settings", { openWeaveCreaton: false }, KEEPER);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");
    expect(bad.json.message).toContain("openWeaveCreaton");
    const after = await api(s.baseUrl, "GET", "/api/admin/settings", undefined, KEEPER);
    expect(after.json).toEqual(before.json);
  });
});

describe("v2: threads url, invites, inbox, agents", () => {
  it("thread url and invites over REST", async () => {
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    const j = (await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "Bot", kind: "agent" })).json;
    const t = await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/threads`, { name: "PR 1", url: "https://e.com/1" }, r.token);
    expect(t.status).toBe(201); expect(t.json.url).toBe("https://e.com/1");
    const bad = await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/threads`, { name: "X", url: "ftp://no" }, r.token);
    expect(bad.status).toBe(400);
    const set = await api(s.baseUrl, "PUT", `/api/threads/${t.json.id}/url`, { url: null }, r.token);
    expect(set.status).toBe(200); expect(set.json.url).toBeNull();
    const inv = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: j.participant.id }, r.token);
    expect(inv.status).toBe(201); expect(inv.json).toMatchObject({ created: true });
    const again = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: j.participant.id }, r.token);
    expect(again.status).toBe(200); expect(again.json).toEqual({ seq: inv.json.seq, created: false });
    const denied = await api(s.baseUrl, "POST", `/api/threads/${t.json.id}/invites`, { participantId: r.participant.id }, j.token);
    expect(denied.status).toBe(403);
    const inbox = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/inbox`, undefined, j.token);
    expect(inbox.status).toBe(200);
    expect(inbox.json.events.map((e: { type: string }) => e.type)).toEqual(["thread.invited"]);
    const since = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/inbox?since=${inv.json.seq}`, undefined, j.token);
    expect(since.json.events).toEqual([]);
  });
  it("agent keys: keeper mints, key authenticates as Bearer, joins linked, is revocable", async () => {
    const add = await api(s.baseUrl, "POST", "/api/admin/agents", { name: "ChatGPT" }, KEEPER);
    expect(add.status).toBe(201); expect(add.json.key).toHaveLength(43);
    const list = await api(s.baseUrl, "GET", "/api/admin/agents", undefined, KEEPER);
    expect(list.json.agents.map((a: { name: string }) => a.name)).toEqual(["ChatGPT"]);
    expect(JSON.stringify(list.json)).not.toContain(add.json.key);
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    const j = await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "ChatGPT", kind: "agent" }, add.json.key);
    expect(j.status).toBe(201); expect(j.json.participant.agentId).toBe(add.json.agent.id);
    const ev = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/events`, undefined, add.json.key);
    expect(ev.status).toBe(200);
    const ticket = await api(s.baseUrl, "POST", "/api/auth/ws-ticket", undefined, add.json.key);
    expect(ticket.status).toBe(200);
    const denied = await api(s.baseUrl, "GET", "/api/admin/settings", undefined, add.json.key);
    expect(denied.status).toBe(403);
    const rev = await api(s.baseUrl, "DELETE", `/api/admin/agents/${add.json.agent.id}`, undefined, KEEPER);
    expect(rev.status).toBe(204);
    expect((await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/events`, undefined, add.json.key)).status).toBe(401);
  });
  it("join with a Bearer that does not resolve is 401, never an anonymous join", async () => {
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    // A revoked or junk credential must stop the join: silently dropping it would let a revoked
    // agent key keep joining Weaves as an anonymous participant.
    const junk = await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "Stale", kind: "human" }, "z".repeat(43));
    expect(junk.status).toBe(401);
    expect(junk.json.code).toBe("invalid_token");
  });
  it("?agent= is honoured on /mcp only, never on the REST API", async () => {
    const add = await api(s.baseUrl, "POST", "/api/admin/agents", { name: "Query" }, KEEPER);
    const r = (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;
    expect((await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}/events?agent=${add.json.key}`)).status).toBe(401);
  });
});

describe("v2: guidelines", () => {
  it("GET /api/guidelines is public, ships the default, and reflects a settings patch", async () => {
    const shipped = await api(s.baseUrl, "GET", "/api/guidelines");
    expect(shipped.status).toBe(200);
    expect(shipped.json).toEqual({ guidelines: DEFAULT_INSTANCE_GUIDELINES });

    const patched = await api(s.baseUrl, "PUT", "/api/admin/settings", { guidelines: "x" }, KEEPER);
    expect(patched.status).toBe(200);
    expect(patched.json.guidelines).toBe("x");
    expect((await api(s.baseUrl, "GET", "/api/guidelines")).json).toEqual({ guidelines: "x" });
  });

  it("the settings patch rejects over-long guidelines and a misspelled key", async () => {
    const long = await api(s.baseUrl, "PUT", "/api/admin/settings", { guidelines: "x".repeat(4001) }, KEEPER);
    expect(long.status).toBe(400);
    expect(long.json.code).toBe("validation");
    const typo = await api(s.baseUrl, "PUT", "/api/admin/settings", { guidelinez: "x" }, KEEPER);
    expect(typo.status).toBe(400);
    expect(typo.json.code).toBe("validation");
    expect((await api(s.baseUrl, "GET", "/api/guidelines")).json.guidelines).toBe("x");
  });

  it("POST /api/weaves accepts guidelines and answers with the combined text", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", { ...creator, guidelines: "rules" });
    expect(c.status).toBe(201);
    expect(c.json.weave.guidelines).toBe("rules");
    expect(c.json.guidelines).toContain("## Guidelines for this Weave");
    expect(c.json.guidelines).toContain("## Loom guidelines");
  });

  it("PUT /api/weaves/:id/guidelines: keeper 200 with seq, unchanged text seq null, member/secret 403, anon 401, unknown 404", async () => {
    const c = (await api(s.baseUrl, "POST", "/api/weaves", creator)).json;
    const set = await api(s.baseUrl, "PUT", `/api/weaves/${c.weave.id}/guidelines`, { guidelines: "r2" }, KEEPER);
    expect(set.status).toBe(200);
    expect(set.json.weave.guidelines).toBe("r2");
    expect(set.json.seq).toBe(4);

    const again = await api(s.baseUrl, "PUT", `/api/weaves/${c.weave.id}/guidelines`, { guidelines: "r2" }, KEEPER);
    expect(again.status).toBe(200);
    expect(again.json.seq).toBeNull();

    const j = (await api(s.baseUrl, "POST", `/api/weaves/${c.secret}/join`, { name: "Member", kind: "human" })).json;
    const member = await api(s.baseUrl, "PUT", `/api/weaves/${c.weave.id}/guidelines`, { guidelines: "nope" }, j.token);
    expect(member.status).toBe(403);
    expect(member.json.code).toBe("forbidden");

    const bySecret = await api(s.baseUrl, "PUT", `/api/weaves/${c.weave.id}/guidelines`, { guidelines: "nope" }, c.secret);
    expect(bySecret.status).toBe(403);

    const anon = await api(s.baseUrl, "PUT", `/api/weaves/${c.weave.id}/guidelines`, { guidelines: "nope" });
    expect(anon.status).toBe(401);

    const unknown = await api(s.baseUrl, "PUT", "/api/weaves/11111111-2222-3333-4444-555555555555/guidelines", { guidelines: "nope" }, KEEPER);
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe("weave_not_found");
  });

  it("GET /api/weaves/:id and join carry weave.guidelines and the combined text", async () => {
    const c = (await api(s.baseUrl, "POST", "/api/weaves", { ...creator, guidelines: "house rules" })).json;
    const g = await api(s.baseUrl, "GET", `/api/weaves/${c.weave.id}`, undefined, c.token);
    expect(g.status).toBe(200);
    expect(g.json.weave.guidelines).toBe("house rules");
    expect(g.json.guidelines).toContain("house rules");

    const j = await api(s.baseUrl, "POST", `/api/weaves/${c.secret}/join`, { name: "Bot", kind: "agent" });
    expect(j.status).toBe(201);
    expect(j.json.weave.guidelines).toBe("house rules");
    expect(j.json.guidelines).toContain("## Guidelines for this Weave");
  });
});

describe("listener onboarding over REST", () => {
  const weave = async () => (await api(s.baseUrl, "POST", "/api/weaves", { title: "T", opener: "o", creator: { name: "Paw", kind: "human" } })).json;

  it("POST /api/threads/:id/removals answers 201 then 200, and 403 for a member", async () => {
    const r = await weave();
    const bob = (await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "Bob", kind: "human" })).json;
    const carl = (await api(s.baseUrl, "POST", `/api/weaves/${r.secret}/join`, { name: "Carl", kind: "agent" })).json;
    const t = (await api(s.baseUrl, "POST", `/api/weaves/${r.weave.id}/threads`, { name: "PR 9" }, r.token)).json;
    expect((await api(s.baseUrl, "POST", `/api/threads/${t.id}/removals`, { participantId: carl.participant.id }, bob.token)).status).toBe(403);
    const first = await api(s.baseUrl, "POST", `/api/threads/${t.id}/removals`, { participantId: carl.participant.id }, r.token);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ created: true, acceptanceRemoved: false, targetRemoved: false });
    const again = await api(s.baseUrl, "POST", `/api/threads/${t.id}/removals`, { participantId: carl.participant.id }, r.token);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ seq: first.json.seq, created: false, acceptanceRemoved: false, targetRemoved: false });
  });

  it("POST /api/admin/agents with owner returns it; PUT /api/admin/agents/:id/owner answers the agent, 403 without a keeper, 404 for an unknown id", async () => {
    const add = await api(s.baseUrl, "POST", "/api/admin/agents", { name: "Owned", owner: "paw" }, KEEPER);
    expect(add.status).toBe(201);
    expect(add.json.agent.owner).toBe("paw");
    const set = await api(s.baseUrl, "PUT", `/api/admin/agents/${add.json.agent.id}/owner`, { owner: "bob" }, KEEPER);
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ ...add.json.agent, owner: "bob" });
    const r = await weave();
    expect((await api(s.baseUrl, "PUT", `/api/admin/agents/${add.json.agent.id}/owner`, { owner: "eve" }, r.token)).status).toBe(403);
    const unknown = await api(s.baseUrl, "PUT", "/api/admin/agents/00000000-0000-4000-8000-000000000000/owner", { owner: "paw" }, KEEPER);
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ code: "not_found", message: "No such agent" });
  });

  it("an authenticated REST call stamps lastSeenAt", async () => {
    const r = await weave();
    // The call's own credential resolution is what stamps; the read inside the same call sees it.
    const info = await api(s.baseUrl, "GET", `/api/weaves/${r.weave.id}`, undefined, r.token);
    expect(info.json.participants.find((p: { id: string }) => p.id === r.participant.id).lastSeenAt).toEqual(expect.any(String));
  });
});
