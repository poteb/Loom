import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Core } from "@loom/core";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";
import { startTestServer, api, keeperToken, type TestServer } from "./helpers.js";

const KEEPER = keeperToken("lobby-keeper");
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await s.core.seedKeepers([KEEPER]);
  await s.core.ensureLobby();
});
afterAll(async () => { await s.close(); });

/** Participant names and owners are shared across a Lobby, so every fixture takes a fresh one. */
let n = 0;
const uniq = (prefix: string) => `${prefix}-${++n}`;

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
const REQUIREMENTS = { models: [MODEL] };

/**
 * Raw SQL for the one thing the HTTP surface cannot do: move a deadline into the past, so the
 * computed status can be read before any sweeper has persisted a closure.
 */
async function sqlUnsafe<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await s.core.db.$client.unsafe(query, params as never)) as unknown as T[];
}

async function expireInDb(requestId: string): Promise<void> {
  await sqlUnsafe("update requests set expires_at = now() - interval '1 minute' where id = $1", [requestId]);
}

/** The Lobby's own secret: read authority for anyone who can open `/w/<secret>`. */
async function lobbySecret(): Promise<string> {
  const r = await api(s.baseUrl, "GET", "/api/lobby", undefined, KEEPER);
  expect(r.status).toBe(200);
  return r.json.secret as string;
}

/** Polls until `check` holds, so a test never sleeps for longer than the interval it is watching. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}

/** A listener standing in the Lobby, with the profile it registered. */
async function joinLobby(name: string, profile?: unknown) {
  const j = await api(s.baseUrl, "POST", "/api/lobby/join", { name, kind: "agent" });
  expect(j.status).toBe(201);
  if (profile !== undefined) {
    const p = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", profile, j.json.token);
    expect(p.status).toBe(200);
  }
  return { id: j.json.participant.id as string, token: j.json.token as string };
}

/** An agent key, and the Lobby participant it owns. */
async function agentKey(name: string) {
  const added = await api(s.baseUrl, "POST", "/api/admin/agents", { name }, KEEPER);
  expect(added.status).toBe(201);
  return { key: added.json.key as string, id: added.json.agent.id as string, name: added.json.agent.name as string };
}

/**
 * A Weave the helpers would be pulled into: its creator is a keeper (the target credential), plus
 * an ordinary member whose token proves a member is refused.
 */
async function targetWeave() {
  const c = await api(s.baseUrl, "POST", "/api/weaves", {
    title: "Loom session 2026-09-16", opener: "hi", creator: { name: uniq("Paw"), kind: "human" },
  });
  expect(c.status).toBe(201);
  const t = await api(s.baseUrl, "POST", `/api/weaves/${c.json.weave.id}/threads`, { name: "PR 14" }, c.json.token);
  const m = await api(s.baseUrl, "POST", `/api/weaves/${c.json.secret}/join`, { name: uniq("Member"), kind: "human" });
  return {
    weaveId: c.json.weave.id as string, secret: c.json.secret as string,
    keeper: c.json.token as string, threadId: t.json.id as string, member: m.json.token as string,
  };
}

/**
 * The spec's success scenario as HTTP: a requester, one listener its owner admits, one that serves
 * somebody else, and the target Weave. The owner is unique per scenario, so eligibility here can
 * never be widened by a listener another test left standing in the Lobby.
 */
async function scenario() {
  const owner = uniq("paw");
  const target = await targetWeave();
  const claude = await joinLobby(uniq("Claude"), { owner });
  const pawbot = await joinLobby(uniq("Pawbot"), { models: [MODEL], owner, serves: "owner" });
  const bobbot = await joinLobby(uniq("Bobbot"), { models: [MODEL], owner: "bob", serves: "owner" });
  return { owner, target, claude, pawbot, bobbot };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

const openBody = (f: Scenario, over: Record<string, unknown> = {}) => ({
  title: "Review PR 14", requirements: REQUIREMENTS, wanted: 1,
  targetWeaveId: f.target.weaveId, targetThreadId: f.target.threadId,
  url: "https://example.com/pr/14", targetCredential: f.target.keeper, ...over,
});

/** Opens a request the ordinary way: the requester's Lobby token plus a target keeper token. */
async function openRequest(f: Scenario, over: Record<string, unknown> = {}) {
  const r = await api(s.baseUrl, "POST", "/api/requests", openBody(f, over), f.claude.token);
  expect(r.status).toBe(201);
  return r.json;
}

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("GET /api/lobby", () => {
  it("answers without a credential, and without the secret", async () => {
    const r = await api(s.baseUrl, "GET", "/api/lobby");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ weaveId: (await s.core.getLobby()).weaveId, title: "Lobby" });
  });

  it("includes the Lobby's own secret for an instance keeper", async () => {
    const r = await api(s.baseUrl, "GET", "/api/lobby", undefined, KEEPER);
    expect(r.status).toBe(200);
    const rows = await sqlUnsafe<{ secret: string }>("select secret from weaves where id = $1", [r.json.weaveId]);
    expect(r.json.secret).toBe(rows[0]!.secret);
  });

  it("withholds the secret from a Lobby participant's own token", async () => {
    const me = await joinLobby(uniq("Nosy"));
    const r = await api(s.baseUrl, "GET", "/api/lobby", undefined, me.token);
    expect(r.status).toBe(200);
    expect(r.json.secret).toBeUndefined();
  });
});

describe("POST /api/lobby/join", () => {
  it("joins without a secret and without a credential", async () => {
    const r = await api(s.baseUrl, "POST", "/api/lobby/join", { name: uniq("Anon"), kind: "agent" });
    expect(r.status).toBe(201);
    expect(r.json.weaveId).toBe((await s.core.getLobby()).weaveId);
    expect(r.json.token).toHaveLength(43);
    expect(r.json.participant.capabilities).toBeNull();
  });

  it("joins under the agent's own name when the credential is an agent key", async () => {
    const a = await agentKey(uniq("ChatGPT"));
    const r = await api(s.baseUrl, "POST", "/api/lobby/join", { kind: "agent" }, a.key);
    expect(r.status).toBe(201);
    expect(r.json.participant.agentId).toBe(a.id);
    expect(r.json.participant.name).toBe(a.name);
  });

  it("refuses a revoked agent key rather than joining anonymously", async () => {
    const a = await agentKey(uniq("ChatGPT"));
    expect((await api(s.baseUrl, "DELETE", `/api/admin/agents/${a.id}`, undefined, KEEPER)).status).toBe(204);
    const r = await api(s.baseUrl, "POST", "/api/lobby/join", { name: uniq("Ghost"), kind: "agent" }, a.key);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("invalid_token");
  });
});

describe("PUT /api/lobby/participants/me/capabilities", () => {
  it("sets the caller's own profile with a participant token", async () => {
    const me = await joinLobby(uniq("Claude"));
    const r = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities",
      { models: [MODEL], tools: ["github"], owner: "paw" }, me.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: me.id, capabilities: { models: [MODEL], tools: ["github"], owner: "paw" } });
  });

  it("sets the profile of the participant an agent key owns", async () => {
    const a = await agentKey(uniq("ChatGPT"));
    const j = await api(s.baseUrl, "POST", "/api/lobby/join", { kind: "agent" }, a.key);
    const r = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", { owner: "bob" }, a.key);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(j.json.participant.id);
    expect(r.json.capabilities).toEqual({ owner: "bob" });
  });

  it("clears the profile when the body is null", async () => {
    const me = await joinLobby(uniq("Claude"), { owner: "paw" });
    const r = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", null, me.token);
    expect(r.status).toBe(200);
    expect(r.json.capabilities).toBeNull();
  });

  it("refuses a profile core rejects, and a caller with no credential", async () => {
    const me = await joinLobby(uniq("Claude"));
    const bad = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", { models: [MODEL] }, me.token);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");
    expect((await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", { owner: "paw" })).status).toBe(401);
  });

  it("refuses a credential that resolves but is not a Lobby identity", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", { owner: "paw" }, f.target.keeper);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("forbidden");
  });
});

describe("GET /api/lobby/agents", () => {
  it("lists the agents a filter matches, for a Lobby participant", async () => {
    const f = await scenario();
    const filter = encodeURIComponent(JSON.stringify({ ...REQUIREMENTS, owner: f.owner }));
    const r = await api(s.baseUrl, "GET", `/api/lobby/agents?filter=${filter}`, undefined, f.claude.token);
    expect(r.status).toBe(200);
    expect(r.json.agents.map((a: { participant: { id: string } }) => a.participant.id)).toEqual([f.pawbot.id]);
    expect(r.json.agents[0].capabilities).toEqual({ models: [MODEL], owner: f.owner, serves: "owner" });
  });

  it("answers the Lobby secret, and refuses a credential from another Weave", async () => {
    const f = await scenario();
    expect((await api(s.baseUrl, "GET", "/api/lobby/agents", undefined, await lobbySecret())).status).toBe(200);
    expect((await api(s.baseUrl, "GET", "/api/lobby/agents", undefined, f.target.keeper)).status).toBe(403);
    expect((await api(s.baseUrl, "GET", "/api/lobby/agents")).status).toBe(401);
  });

  it("rejects a filter that is not JSON", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "GET", "/api/lobby/agents?filter=not-json", undefined, f.claude.token);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("validation");
  });
});

describe("POST /api/requests", () => {
  it("opens a request with a Lobby token and the target keeper's token in the body", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    expect(req).toMatchObject({
      requesterId: f.claude.id, owner: f.owner, wanted: 1, status: "open",
      targetWeaveId: f.target.weaveId, targetThreadId: f.target.threadId,
      targetWeaveTitle: "Loom session 2026-09-16", url: "https://example.com/pr/14",
    });
    // The snapshot the open just recorded: only the listener this owner's requests admit.
    expect(req.eligible).toEqual([f.pawbot.id]);
  });

  it("refuses a Lobby token with no target credential", async () => {
    const f = await scenario();
    const { targetCredential: _drop, ...noTarget } = openBody(f);
    const r = await api(s.baseUrl, "POST", "/api/requests", noTarget, f.claude.token);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("invalid_token");
  });

  it("refuses a target credential that is only a member there", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "POST", "/api/requests", openBody(f, { targetCredential: f.target.member }), f.claude.token);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("forbidden");
  });

  it("accepts an instance keeper token as the target credential", async () => {
    const f = await scenario();
    expect((await openRequest(f, { targetCredential: KEEPER })).status).toBe("open");
  });

  it("needs no target credential when the bearer is an agent key", async () => {
    const f = await scenario();
    const a = await agentKey(uniq("ChatGPT"));
    await api(s.baseUrl, "POST", "/api/lobby/join", { kind: "agent" }, a.key);
    await api(s.baseUrl, "PUT", "/api/lobby/participants/me/capabilities", { owner: f.owner }, a.key);
    const inTarget = await api(s.baseUrl, "POST", `/api/weaves/${f.target.secret}/join`, { kind: "agent" }, a.key);
    await api(s.baseUrl, "PUT", `/api/weaves/${f.target.weaveId}/participants/${inTarget.json.participant.id}/role`,
      { role: "keeper" }, f.target.keeper);
    const { targetCredential: _drop, ...noTarget } = openBody(f);
    const r = await api(s.baseUrl, "POST", "/api/requests", noTarget, a.key);
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("open");
  });

  it("refuses a request with no credential at all", async () => {
    const f = await scenario();
    expect((await api(s.baseUrl, "POST", "/api/requests", openBody(f))).status).toBe(401);
  });
});

describe("GET /api/requests", () => {
  it("computes the status, so a crossed but unswept request is not open", async () => {
    const f = await scenario();
    const req = await openRequest(f, { timeoutMs: 60_000 });
    const open = await api(s.baseUrl, "GET", "/api/requests?status=open", undefined, f.claude.token);
    expect(open.status).toBe(200);
    expect(idsOf(open.json.requests)).toContain(req.id);

    await expireInDb(req.id);
    expect(idsOf((await api(s.baseUrl, "GET", "/api/requests?status=open", undefined, f.claude.token)).json.requests))
      .not.toContain(req.id);
    expect(idsOf((await api(s.baseUrl, "GET", "/api/requests?status=expired", undefined, f.claude.token)).json.requests))
      .toContain(req.id);
  });

  it("hands an unknown status to core, which refuses it", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "GET", "/api/requests?status=nope", undefined, f.claude.token);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("validation");
  });

  it("passes ?limit= through as a page, and hands an impossible one to core", async () => {
    const f = await scenario();
    await openRequest(f, { title: "Review PR 15" });
    const newest = await openRequest(f, { title: "Review PR 16" });
    const all = await api(s.baseUrl, "GET", "/api/requests", undefined, f.claude.token);
    expect(all.json.requests.length).toBeGreaterThan(1);
    const one = await api(s.baseUrl, "GET", "/api/requests?limit=1", undefined, f.claude.token);
    expect(one.status).toBe(200);
    // Newest first, so the one page of one is the request opened last — this test's own.
    expect(idsOf(one.json.requests)).toEqual([newest.id]);
    const bad = await api(s.baseUrl, "GET", "/api/requests?limit=0", undefined, f.claude.token);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");
  });

  it("answers the Lobby secret and refuses a stranger", async () => {
    const f = await scenario();
    expect((await api(s.baseUrl, "GET", "/api/requests", undefined, await lobbySecret())).status).toBe(200);
    expect((await api(s.baseUrl, "GET", "/api/requests", undefined, f.target.keeper)).status).toBe(403);
    expect((await api(s.baseUrl, "GET", "/api/requests")).status).toBe(401);
  });
});

describe("GET /api/requests/:id", () => {
  it("returns the request with its offers and the eligibility snapshot", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "can start now" }, f.pawbot.token);
    const r = await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, f.claude.token);
    expect(r.status).toBe(200);
    // Only the listener whose profile matches and whose `serves` admits this owner was asked.
    expect(r.json.eligible).toEqual([f.pawbot.id]);
    expect(r.json.offers).toHaveLength(1);
    expect(r.json.offers[0]).toMatchObject({ participantId: f.pawbot.id, note: "can start now", accepted: false });
  });

  it("answers the Lobby secret and refuses a stranger", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    expect((await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, await lobbySecret())).status).toBe(200);
    expect((await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, f.target.keeper)).status).toBe(403);
    expect((await api(s.baseUrl, "GET", `/api/requests/${req.id}`)).status).toBe(401);
  });
});

describe("POST /api/requests/:id/offers", () => {
  it("records an eligible listener's offer", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { ...MODEL, note: "ready" }, f.pawbot.token);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ requestId: req.id, participantId: f.pawbot.id, model: MODEL.model, effort: MODEL.effort, note: "ready" });
  });

  it("refuses a listener the request was not addressed to", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "me too" }, f.bobbot.token);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("forbidden");
  });

  it("answers 409 request_closed once the request is closed", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    await api(s.baseUrl, "POST", `/api/requests/${req.id}/cancel`, undefined, f.claude.token);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "late" }, f.pawbot.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("request_closed");
  });
});

describe("POST /api/requests/:id/accept", () => {
  it("accepts an offer, issues the invitation, and fills the request", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "ready" }, f.pawbot.token);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/accept`, { participantIds: [f.pawbot.id] }, f.claude.token);
    expect(r.status).toBe(200);
    expect(r.json.invitationIds).toHaveLength(1);
    expect(r.json.request.status).toBe("filled");
    expect(r.json.request.offers[0].accepted).toBe(true);
  });

  it("refuses an accept from someone who is neither the requester nor a Lobby keeper", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    await api(s.baseUrl, "POST", `/api/requests/${req.id}/offers`, { note: "ready" }, f.pawbot.token);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/accept`, { participantIds: [f.pawbot.id] }, f.pawbot.token);
    expect(r.status).toBe(403);
  });
});

describe("POST /api/requests/:id/cancel", () => {
  it("cancels the requester's own request, and answers 409 the second time", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/cancel`, undefined, f.claude.token);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("cancelled");
    const again = await api(s.baseUrl, "POST", `/api/requests/${req.id}/cancel`, undefined, f.claude.token);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("request_closed");
  });

  it("lets a Lobby keeper cancel on the requester's behalf", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    // An instance keeper is a keeper of every Weave, the Lobby included.
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/cancel`, undefined, KEEPER);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("cancelled");
  });

  it("refuses a Lobby participant who is neither the requester nor a keeper", async () => {
    const f = await scenario();
    const req = await openRequest(f);
    const r = await api(s.baseUrl, "POST", `/api/requests/${req.id}/cancel`, undefined, f.bobbot.token);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("forbidden");
  });
});

describe("POST /api/weaves/:id/invitations", () => {
  it("lets a keeper of the target invite a Lobby participant", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "POST", `/api/weaves/${f.target.weaveId}/invitations`,
      { participantId: f.pawbot.id, threadId: f.target.threadId }, f.target.keeper);
    expect(r.status).toBe(201);
    expect(r.json.invitationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("refuses a member of the target", async () => {
    const f = await scenario();
    const r = await api(s.baseUrl, "POST", `/api/weaves/${f.target.weaveId}/invitations`,
      { participantId: f.pawbot.id, threadId: f.target.threadId }, f.target.member);
    expect(r.status).toBe(403);
  });
});

describe("POST /api/weaves/join", () => {
  it("redeems an invitation with the invitee's own credential, without a secret", async () => {
    const f = await scenario();
    const inv = await api(s.baseUrl, "POST", `/api/weaves/${f.target.weaveId}/invitations`,
      { participantId: f.pawbot.id, threadId: f.target.threadId }, f.target.keeper);
    const r = await api(s.baseUrl, "POST", "/api/weaves/join", { inviteId: inv.json.invitationId }, f.pawbot.token);
    expect(r.status).toBe(201);
    expect(r.json.weaveId).toBe(f.target.weaveId);
    expect(r.json.token).toHaveLength(43);
  });

  it("refuses a credential that is not the invitee's, and one that is missing", async () => {
    const f = await scenario();
    const inv = await api(s.baseUrl, "POST", `/api/weaves/${f.target.weaveId}/invitations`,
      { participantId: f.pawbot.id, threadId: f.target.threadId }, f.target.keeper);
    const r = await api(s.baseUrl, "POST", "/api/weaves/join", { inviteId: inv.json.invitationId }, f.bobbot.token);
    expect(r.status).toBe(403);
    expect((await api(s.baseUrl, "POST", "/api/weaves/join", { inviteId: inv.json.invitationId })).status).toBe(401);
  });
});

describe("the request sweep", () => {
  it("closes a crossed request on the interval, and stops when the app is torn down", async () => {
    const f = await scenario();
    const req = await openRequest(f, { timeoutMs: 60_000 });
    let sweeps = 0;
    // The clock the sweeper reads is the test's, exactly as core's own sweep test drives it; the
    // interval, the wiring and the closure it writes are the real ones.
    const core = {
      ...s.core,
      sweepRequests: (now?: Date) => { sweeps++; return s.core.sweepRequests(now ?? new Date(Date.now() + 120_000)); },
    } as Core;
    const tickets = new TicketStore();
    const { stop } = buildApp({ core, tickets, requestSweepMs: 25 });
    try {
      await until(async () =>
        (await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, f.claude.token)).json.closedAt !== null);
    } finally { stop(); tickets.stop(); }
    const after = sweeps;
    await new Promise((r) => setTimeout(r, 120));
    expect(sweeps).toBe(after);
  });

  it("exposes sweepNow so a caller can sweep without waiting for the interval", async () => {
    const f = await scenario();
    const req = await openRequest(f, { timeoutMs: 60_000 });
    const tickets = new TicketStore();
    const { sweepNow, stop } = buildApp({ core: s.core, tickets });
    try {
      expect(await sweepNow(new Date(Date.now() + 120_000))).toBeGreaterThanOrEqual(1);
    } finally { stop(); tickets.stop(); }
    const r = await api(s.baseUrl, "GET", `/api/requests/${req.id}`, undefined, f.claude.token);
    expect(r.json.status).toBe("expired");
    expect(r.json.closedAt).not.toBeNull();
  });
});
