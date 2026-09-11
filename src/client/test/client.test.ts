import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
