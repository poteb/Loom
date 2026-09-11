import { describe, it, expect, afterAll, beforeAll } from "vitest";
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

  it("looks up a weave id by secret; unknown secret is 404", async () => {
    const c = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const { weave, secret } = c.json;
    const l = await api(s.baseUrl, "GET", `/api/weaves/${secret}/lookup`);
    expect(l.status).toBe(200);
    expect(l.json.weaveId).toBe(weave.id);
    const bad = await api(s.baseUrl, "GET", "/api/weaves/nope/lookup");
    expect(bad.status).toBe(404);
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

  it("unknown and malformed ids are 404/400, never 500", async () => {
    const a = await api(s.baseUrl, "POST", "/api/weaves", creator);
    const unknown = "11111111-2222-3333-4444-555555555555";

    const bad = await api(s.baseUrl, "GET", "/api/weaves/not-a-uuid", undefined, KEEPER);
    expect(bad.status).toBe(404); expect(bad.json.code).toBe("weave_not_found");

    const gone = await api(s.baseUrl, "GET", `/api/weaves/${unknown}/events`, undefined, KEEPER);
    expect(gone.status).toBe(404); expect(gone.json.code).toBe("weave_not_found");

    const badEvents = await api(s.baseUrl, "GET", "/api/weaves/not-a-uuid/events", undefined, KEEPER);
    expect(badEvents.status).toBe(404); expect(badEvents.json.code).toBe("weave_not_found");

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
});
