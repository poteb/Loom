import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DEFAULT_INSTANCE_GUIDELINES } from "@loom/core";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { LoomClient, LoomClientError } from "../src/index.js";

let s: TestServer | undefined;
let anon: LoomClient;
beforeAll(async () => {
  s = await startTestServer();
  await s.core.seedKeepers([keeperToken("k1")]);
  anon = new LoomClient({ baseUrl: s.baseUrl, allowInsecure: true });
});
afterAll(async () => { await s?.close(); });

function srv(): TestServer {
  if (!s) throw new Error("test server did not start");
  return s;
}

const input = { title: "PR 7", opener: "Look at PR 7", creator: { name: "Claude", kind: "agent" as const } };

describe("LoomClient", () => {
  it("refuses insecure URLs unless allowed", () => {
    expect(() => new LoomClient({ baseUrl: srv().baseUrl })).toThrow(LoomClientError);
  });

  it("create → join → get → post → events → thread → role → close → archive → export", async () => {
    const r = await anon.createWeave(input);
    expect(r.secret).toHaveLength(43);
    const me = anon.withToken(r.token);
    const j = await anon.joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = anon.withToken(j.token);

    const info = await anon.withToken(r.secret).getWeave(r.weave.id);
    expect(info.participants.map((p) => p.name)).toEqual(["Claude", "ChatGPT"]);

    const t = await gpt.createThread(r.weave.id, "Design");
    const m = await gpt.postMessage(t.id, "hi @Claude");
    expect(m.payload.mentions).toEqual([r.participant.id]);

    const evs = await me.readEvents(r.weave.id, { since: 3 });
    expect(evs.map((e) => e.type)).toEqual(["participant.joined", "thread.created", "message"]);
    const inThread = await me.readEvents(r.weave.id, { threadId: t.id });
    expect(inThread.every((e) => e.threadId === t.id)).toBe(true);

    const p = await me.setRole(r.weave.id, j.participant.id, "keeper");
    expect(p.role).toBe("keeper");
    await gpt.closeThread(t.id);
    await me.archiveWeave(r.weave.id);

    const md = await anon.withToken(r.secret).exportWeave(r.weave.id, "md");
    expect(md).toContain("# PR 7");
    const json = JSON.parse(await anon.withToken(r.secret).exportWeave(r.weave.id, "json"));
    expect(json.events.at(-1).type).toBe("weave.archived");
  });

  it("lookupWeave resolves a secret to its weave id; rejects an unknown secret", async () => {
    const r = await anon.createWeave(input);
    await expect(anon.lookupWeave(r.secret)).resolves.toBe(r.weave.id);
    await expect(anon.lookupWeave("nope")).rejects.toMatchObject({ code: "weave_not_found", status: 404 });
  });

  it("maps server errors to LoomClientError with code and status", async () => {
    const r = await anon.createWeave(input);
    await expect(anon.getWeave(r.weave.id)).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    await expect(anon.joinWeave("nope", { name: "X", kind: "human" })).rejects.toMatchObject({ code: "weave_not_found", status: 404 });
    await expect(anon.joinWeave(r.secret, { name: "claude", kind: "human" })).rejects.toMatchObject({ code: "name_taken", status: 409 });
    await expect(anon.joinWeave(r.secret, { name: "a b", kind: "human" })).rejects.toMatchObject({ code: "validation", status: 400 });
  });

  it("reports network failures as code network", async () => {
    const dead = new LoomClient({ baseUrl: "http://127.0.0.1:1", allowInsecure: true });
    await expect(dead.createWeave(input)).rejects.toMatchObject({ code: "network" });
  });

  it("wsTicket returns a single-use ticket", async () => {
    const r = await anon.createWeave(input);
    const ticket = await anon.withToken(r.token).wsTicket();
    expect(ticket).toHaveLength(43);
    expect(srv().tickets.redeem(ticket)).toBe(r.token);
  });

  it("admin methods require a keeper token", async () => {
    const k = anon.withToken(keeperToken("k1"));
    const r = await anon.createWeave(input);
    expect((await k.admin.listWeaves()).some((w) => w.id === r.weave.id)).toBe(true);
    const st = await k.admin.updateSettings({ instanceName: "Fragt Loom" });
    expect(st.instanceName).toBe("Fragt Loom");
    expect((await k.admin.getSettings()).instanceName).toBe("Fragt Loom");
    const added = await k.admin.addKeeper("Ops");
    expect(added.token).toHaveLength(43);
    expect((await k.admin.listKeepers()).some((x) => x.id === added.keeper.id)).toBe(true);
    await k.admin.removeKeeper(added.keeper.id);
    await expect(anon.withToken(r.token).admin.listWeaves()).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("v2 client wrappers", () => {
  it("thread url, invite, inbox and agent admin round-trip", async () => {
    const r = await anon.createWeave({ title: "T", opener: "o", creator: { name: "Paw", kind: "human" } });
    const me = anon.withToken(r.token);
    const j = await anon.joinWeave(r.secret, { name: "Bot", kind: "agent" });
    const t = await me.createThread(r.weave.id, "PR", "https://e.com/pr");
    expect(t.url).toBe("https://e.com/pr");
    expect((await me.setThreadUrl(t.id, null)).url).toBeNull();
    const inv = await me.inviteParticipant(t.id, j.participant.id);
    expect(inv.created).toBe(true);
    expect((await me.inviteParticipant(t.id, j.participant.id))).toEqual({ seq: inv.seq, created: false });
    const box = await anon.withToken(j.token).inbox(r.weave.id);
    expect(box.map((e) => e.type)).toEqual(["thread.invited"]);
    expect(box[0]).toMatchObject({ threadName: "PR", threadUrl: null });
    await me.setThreadUrl(t.id, "https://e.com/pr2");
    expect((await anon.withToken(j.token).inbox(r.weave.id))[0]).toMatchObject({ threadName: "PR", threadUrl: "https://e.com/pr2" });
    expect(await anon.withToken(j.token).inbox(r.weave.id, { since: inv.seq })).toEqual([]);
    const k = anon.withToken(keeperToken("k1"));
    const added = await k.admin.addAgent("ChatGPT");
    expect(added.key).toHaveLength(43);
    expect((await k.admin.listAgents()).map((a) => a.name)).toEqual(["ChatGPT"]);
    const viaKey = await anon.withToken(added.key).joinWeave(r.secret, { name: "ChatGPT", kind: "agent" });
    expect(viaKey.participant.agentId).toBe(added.agent.id);
    expect((await anon.withToken(added.key).joinWeave(r.secret, { name: "ChatGPT", kind: "agent" })).alreadyJoined).toBe(true);
    await k.admin.revokeAgent(added.agent.id);
    await expect(anon.withToken(added.key).getWeave(r.weave.id)).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("guidelines", () => {
  it("reads the instance text, creates and sets a Weave's, and reports unchanged text as seq null", async () => {
    expect(await anon.getInstanceGuidelines()).toBe(DEFAULT_INSTANCE_GUIDELINES);
    const k = anon.withToken(keeperToken("k1"));
    expect((await k.admin.updateSettings({ guidelines: "be brief" })).guidelines).toBe("be brief");
    expect(await anon.getInstanceGuidelines()).toBe("be brief");

    const r = await anon.createWeave({ ...input, guidelines: "rules" });
    expect(r.weave.guidelines).toBe("rules");
    expect(r.guidelines).toContain("## Loom guidelines");
    expect(r.guidelines).toContain("## Guidelines for this Weave");

    const me = anon.withToken(r.token);
    expect(await me.setWeaveGuidelines(r.weave.id, "rules 2")).toMatchObject({ weave: { guidelines: "rules 2" }, seq: 4 });
    expect((await me.setWeaveGuidelines(r.weave.id, "rules 2")).seq).toBeNull();
    expect((await me.getWeave(r.weave.id)).weave.guidelines).toBe("rules 2");
  });
});

describe("Lobby wrappers", () => {
  const MODEL = { model: "gpt-5.6-sol", effort: "high" };
  let tag = 0;

  /**
   * The spec's success scenario as client calls: a requester and one listener its owner admits,
   * both standing in the Lobby, plus the Weave the listener would be pulled into. Names and owner
   * are unique per scenario, because the Lobby is one Weave shared by every test in this file.
   */
  async function lobby() {
    await srv().core.ensureLobby();
    const t = ++tag;
    const owner = `paw-${t}`;
    const target = await anon.createWeave({ title: "Loom session", opener: "hi", creator: { name: `Paw-${t}`, kind: "human" } });
    const keeper = anon.withToken(target.token);
    const thread = await keeper.createThread(target.weave.id, "PR 14");
    const claudeJoin = await anon.joinLobby({ name: `Claude-${t}`, kind: "agent" });
    const claude = anon.withToken(claudeJoin.token);
    await claude.setCapabilities({ owner });
    const botJoin = await anon.joinLobby({ name: `Pawbot-${t}`, kind: "agent" });
    const bot = anon.withToken(botJoin.token);
    await bot.setCapabilities({ models: [MODEL], owner, serves: "owner" });
    return {
      t, owner, target, keeper, thread, claude, bot,
      claudeId: claudeJoin.participant.id, botId: botJoin.participant.id,
      input: {
        title: "Review PR 14", requirements: { models: [MODEL] }, wanted: 1,
        targetWeaveId: target.weave.id, targetThreadId: thread.id, url: "https://e.com/pr/14",
        targetCredential: target.token,
      },
    };
  }

  it("reads the Lobby, joins it without a secret, sets a profile and finds the agents it matches", async () => {
    const f = await lobby();
    expect(await anon.getLobby()).toEqual({ weaveId: (await srv().core.getLobby()).weaveId, title: "Lobby" });
    const found = await f.claude.findAgents({ models: [MODEL], owner: f.owner });
    expect(found.map((a) => a.participant.id)).toEqual([f.botId]);
    expect(found[0]!.capabilities).toEqual({ models: [MODEL], owner: f.owner, serves: "owner" });
    expect((await f.bot.setCapabilities(null)).capabilities).toBeNull();
  });

  it("opens a request, lists and reads it, offers on it and accepts the offer", async () => {
    const f = await lobby();
    const req = await f.claude.openRequest(f.input);
    expect(req).toMatchObject({ requesterId: f.claudeId, owner: f.owner, status: "open", wanted: 1 });
    expect((await f.claude.listRequests("open")).map((r) => r.id)).toContain(req.id);
    expect((await f.claude.getRequest(req.id)).eligible).toEqual([f.botId]);

    const off = await f.bot.offer(req.id, { ...MODEL, note: "can start now" });
    expect(off).toMatchObject({ requestId: req.id, participantId: f.botId, note: "can start now", accepted: false });

    const accepted = await f.claude.acceptRequest(req.id, [f.botId]);
    expect(accepted.invitationIds).toHaveLength(1);
    expect(accepted.request.status).toBe("filled");
    expect(accepted.request.offers[0]!.accepted).toBe(true);
  });

  it("cancels its own request, after which an offer is refused as request_closed", async () => {
    const f = await lobby();
    const req = await f.claude.openRequest(f.input);
    expect((await f.claude.cancelRequest(req.id)).status).toBe("cancelled");
    await expect(f.bot.offer(req.id, { note: "late" })).rejects.toMatchObject({ code: "request_closed", status: 409 });
  });

  it("invites a Lobby participant into another Weave and redeems it without a secret", async () => {
    const f = await lobby();
    const inv = await f.keeper.inviteToWeave(f.target.weave.id, f.botId, f.thread.id);
    const joined = await f.bot.joinByInvite(inv.invitationId);
    expect(joined.weaveId).toBe(f.target.weave.id);
    expect(joined.participant.name).toBe(`Pawbot-${f.t}`);
    expect(joined.token).toHaveLength(43);
    await expect(f.claude.joinByInvite(inv.invitationId)).rejects.toMatchObject({ code: "forbidden", status: 403 });

    const other = await f.keeper.inviteToWeave(f.target.weave.id, f.claudeId, f.thread.id);
    expect((await f.claude.joinByInvite(other.invitationId, `Helper-${f.t}`)).participant.name).toBe(`Helper-${f.t}`);
  });
});
