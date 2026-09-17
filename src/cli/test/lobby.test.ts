import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestServer, keeperToken, type TestServer } from "../../server/test/helpers.js";
import { runCli, type CliIo } from "../src/cli.js";
import { ConfigStore } from "../src/config.js";

let s: TestServer;
let lobbyWeaveId: string;
beforeAll(async () => {
  s = await startTestServer();
  await s.core.seedKeepers([keeperToken("k1")]);
  lobbyWeaveId = (await s.core.ensureLobby()).weaveId;
});
afterAll(async () => { await s.close(); });

/** One Lobby is shared by the whole file, and names and owners are unique within it. */
let n = 0;
const uniq = (prefix: string) => `${prefix}-${++n}`;
const newCfg = () => path.join(mkdtempSync(path.join(tmpdir(), "loom-cli-")), "config.json");

const MODEL = { model: "gpt-5.6-sol", effort: "high" };
const REQUIRE = { models: [MODEL] };

async function run(args: string[], opts: { cfg: string; env?: Record<string, string>; stdin?: string }) {
  let out = ""; let err = "";
  const io: CliIo = {
    stdout: { write: (x: string) => { out += x; } },
    stderr: { write: (x: string) => { err += x; } },
    env: { LOOM_URL: s.baseUrl, LOOM_ALLOW_INSECURE: "1", LOOM_CONFIG: opts.cfg, ...opts.env },
    ...(opts.stdin === undefined ? {} : { stdin: { read: async () => opts.stdin as string } }),
  };
  const code = await runCli(args, io);
  return { code, out, err, json: () => JSON.parse(out) };
}

/** The local-clock rendering a deadline is expected to print as. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type Scenario = {
  owner: string; req: string; bot: string; botName: string;
  weaveId: string; threadId: string; requesterId: string; botId: string; lobbyGeneralThreadId: string;
};

/**
 * The spec's cast: a requester that keeps a target Weave and stands in the Lobby under its own
 * owner, and one listener whose profile serves exactly that owner. A fresh owner per scenario keeps
 * eligibility from widening as other tests leave listeners standing.
 */
async function scenario(): Promise<Scenario> {
  const owner = uniq("paw");
  const req = newCfg();
  const created = (await run(["create", "--title", "Loom session", "--opener", "hi", "--name", uniq("Paw"), "--kind", "human", "--json"], { cfg: req })).json();
  const thread = (await run(["thread", "new", "PR 14", "--json"], { cfg: req })).json();
  const mine = (await run(["lobby", "join", "--name", uniq("Paw"), "--kind", "human", "--json"], { cfg: req })).json();
  await run(["lobby", "me", "--set", JSON.stringify({ owner }), "--json"], { cfg: req });

  const bot = newCfg();
  const botName = uniq("Bot");
  const joined = (await run(["lobby", "join", "--name", botName, "--kind", "agent", "--json"], { cfg: bot })).json();
  await run(["lobby", "me", "--set", JSON.stringify({ models: [MODEL], runtime: "node", owner, serves: "owner" }), "--json"], { cfg: bot });

  return {
    owner, req, bot, botName, weaveId: created.weave.id, threadId: thread.id,
    requesterId: mine.participant.id, botId: joined.participant.id, lobbyGeneralThreadId: mine.generalThreadId,
  };
}

/** Opens the scenario's request, from the requester's config. */
async function open(sc: Scenario, extra: string[] = []) {
  const r = await run(["request", "open", "--title", uniq("Review PR 14"), "--require", JSON.stringify(REQUIRE),
    "--weave", sc.weaveId, "--thread", sc.threadId, "--json", ...extra], { cfg: sc.req });
  expect(r.code).toBe(0);
  return r.json();
}

describe("loom lobby", () => {
  it("lobby join stores the token under the Lobby's weave id, and the Lobby commands use it", async () => {
    const cfg = newCfg();
    const j = await run(["lobby", "join", "--name", uniq("Solo"), "--json"], { cfg });
    expect(j.code).toBe(0);
    expect(j.json().weaveId).toBe(lobbyWeaveId);
    expect(new ConfigStore(cfg).load().weaves[lobbyWeaveId]?.token).toBe(j.json().token);
    const me = await run(["lobby", "me", "--set", JSON.stringify({ owner: uniq("own") }), "--json"], { cfg });
    expect(me.code).toBe(0);
    expect(me.json().id).toBe(j.json().participant.id);
  });

  it("lobby join leaves the current Weave where it was", async () => {
    // The Lobby is reached by name, never by default: a `--weave`-less command after joining it
    // still means the Weave being worked in — and core refuses a request that targets the Lobby.
    const cfg = newCfg();
    const created = (await run(["create", "--title", "Working here", "--name", uniq("Paw"), "--json"], { cfg })).json();
    await run(["lobby", "join", "--name", uniq("Paw"), "--json"], { cfg });
    expect(new ConfigStore(cfg).load().lastWeave).toBe(created.weave.id);
    expect((await run(["info", "--json"], { cfg })).json().weave.id).toBe(created.weave.id);
    const thread = (await run(["thread", "new", "PR 15", "--json"], { cfg })).json();
    const opened = await run(["request", "open", "--title", uniq("Review PR 15"), "--require", JSON.stringify(REQUIRE),
      "--thread", thread.id, "--json"], { cfg });
    expect(opened.code).toBe(0);
    expect(opened.json().targetWeaveId).toBe(created.weave.id);
  });

  it("lobby prints the Lobby, its participants and a profile summary each", async () => {
    const sc = await scenario();
    const human = await run(["lobby"], { cfg: sc.bot });
    expect(human.code).toBe(0);
    expect(human.out).toContain(lobbyWeaveId);
    expect(human.out).toContain(`${sc.botName}`);
    expect(human.out).toContain("models: gpt-5.6-sol/high");
    expect(human.out).toContain(`owner: ${sc.owner}`);
    expect(human.out).toContain("serves: owner");
  });

  it("lobby prints the Lobby's web URL to an instance keeper, and to nobody else", async () => {
    const cfg = newCfg();
    await run(["lobby", "join", "--name", uniq("Keeperly"), "--json"], { cfg });
    const plain = await run(["lobby"], { cfg });
    expect(plain.out).not.toContain("web:");
    const asKeeper = await run(["lobby"], { cfg, env: { LOOM_KEEPER_TOKEN: keeperToken("k1") } });
    expect(asKeeper.code).toBe(0);
    const secret = (await run(["lobby", "--json"], { cfg, env: { LOOM_KEEPER_TOKEN: keeperToken("k1") } })).json().lobby.secret;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asKeeper.out).toContain(`web: ${s.baseUrl}/w/${secret}`);
  });

  it("lobby marks a participant with no profile", async () => {
    const cfg = newCfg();
    const name = uniq("Bare");
    await run(["lobby", "join", "--name", name, "--json"], { cfg });
    const human = await run(["lobby"], { cfg });
    expect(human.out.split("\n").find((l) => l.includes(name))).toContain("(no profile)");
  });

  it("lobby --json returns the raw Lobby and participants", async () => {
    const cfg = newCfg();
    await run(["lobby", "join", "--name", uniq("Jsonny"), "--json"], { cfg });
    const j = await run(["lobby", "--json"], { cfg });
    expect(j.code).toBe(0);
    expect(j.json().lobby.weaveId).toBe(lobbyWeaveId);
    expect(Array.isArray(j.json().participants)).toBe(true);
  });

  it("lobby me --set stores the profile and --clear removes it", async () => {
    const cfg = newCfg();
    const name = uniq("Prof");
    await run(["lobby", "join", "--name", name, "--json"], { cfg });
    const set = await run(["lobby", "me", "--set", JSON.stringify({ models: [MODEL], owner: uniq("own"), serves: "anyone" }), "--json"], { cfg });
    expect(set.code).toBe(0);
    expect(set.json().capabilities.models).toEqual([MODEL]);
    const cleared = await run(["lobby", "me", "--clear"], { cfg });
    expect(cleared.code).toBe(0);
    const after = await run(["lobby", "--json"], { cfg });
    expect(after.json().participants.find((p: { name: string }) => p.name === name).capabilities).toBeNull();
  });

  it("lobby me --set - reads the profile from stdin", async () => {
    const cfg = newCfg();
    await run(["lobby", "join", "--name", uniq("Piped"), "--json"], { cfg });
    const set = await run(["lobby", "me", "--set", "-", "--json"], { cfg, stdin: JSON.stringify({ runtime: "node", owner: uniq("own") }) });
    expect(set.code).toBe(0);
    expect(set.json().capabilities.runtime).toBe("node");
  });

  it("lobby me with neither --set nor --clear is a usage error", async () => {
    const cfg = newCfg();
    await run(["lobby", "join", "--name", uniq("Neither"), "--json"], { cfg });
    const bad = await run(["lobby", "me"], { cfg });
    expect(bad.code).toBe(2);
  });

  it("lobby find lists the agents a filter admits", async () => {
    const sc = await scenario();
    const found = await run(["lobby", "find", JSON.stringify({ models: [{ model: MODEL.model }], owner: sc.owner }), "--json"], { cfg: sc.req });
    expect(found.code).toBe(0);
    expect(found.json().map((a: { participant: { id: string } }) => a.participant.id)).toEqual([sc.botId]);
    const human = await run(["lobby", "find", JSON.stringify({ owner: sc.owner })], { cfg: sc.req });
    expect(human.out).toContain(sc.botName);
  });

  it("a command needing the Lobby says so before any call when no Lobby token is stored", async () => {
    const bare = await run(["lobby", "find", "{}"], { cfg: newCfg() });
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("lobby join");
  });
});

describe("loom request", () => {
  it("request open records the requirements, the deadline and the eligible listeners", async () => {
    const sc = await scenario();
    const r = await open(sc, ["--wanted", "1", "--timeout", "90m", "--url", "https://example.com/pr/14"]);
    expect(r.eligible).toEqual([sc.botId]);
    expect(r.requirements).toEqual(REQUIRE);
    expect(r.wanted).toBe(1);
    expect(r.url).toBe("https://example.com/pr/14");
    // The deadline is core's `now + timeoutMs`; `createdAt` is the database's own clock, so the
    // two are the same instant only to within the round trip.
    const window = new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime();
    expect(Math.abs(window - 90 * 60_000)).toBeLessThan(5_000);
    expect(r.targetWeaveId).toBe(sc.weaveId);
    expect(r.targetThreadId).toBe(sc.threadId);
  });

  it("request open prints the request in one human line", async () => {
    const sc = await scenario();
    const r = await run(["request", "open", "--title", "Review PR 14", "--require", JSON.stringify(REQUIRE),
      "--weave", sc.weaveId, "--thread", sc.threadId], { cfg: sc.req });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Opened request /);
    expect(r.out).toContain("eligible: 1");
  });

  it("request open --require - reads the requirements from stdin", async () => {
    const sc = await scenario();
    const r = await run(["request", "open", "--title", "From stdin", "--require", "-",
      "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req, stdin: JSON.stringify(REQUIRE) });
    expect(r.code).toBe(0);
    expect(r.json().requirements).toEqual(REQUIRE);
  });

  it("request open takes an unparsable --require as a usage error", async () => {
    const sc = await scenario();
    const bad = await run(["request", "open", "--title", "T", "--require", "{nope",
      "--weave", sc.weaveId, "--thread", sc.threadId], { cfg: sc.req });
    expect(bad.code).toBe(2);
  });

  it("request open takes an unparsable --timeout as a usage error", async () => {
    const sc = await scenario();
    const bad = await run(["request", "open", "--title", "T", "--require", JSON.stringify(REQUIRE),
      "--timeout", "soon", "--weave", sc.weaveId, "--thread", sc.threadId], { cfg: sc.req });
    expect(bad.code).toBe(2);
  });

  it("request open defaults the target credential to the stored token for --weave", async () => {
    const sc = await scenario();
    // A Lobby identity with no stored credential for the target Weave: the default has nothing to
    // read, and the CLI says so rather than opening a request without target authority.
    const stray = newCfg();
    await run(["lobby", "join", "--name", uniq("Stray"), "--json"], { cfg: stray });
    const missing = await run(["request", "open", "--title", "T", "--require", JSON.stringify(REQUIRE),
      "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: stray });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).code).toBe("no_weave");

    // Handed that same token explicitly, the very same command goes through.
    const keeper = new ConfigStore(sc.req).load().weaves[sc.weaveId]!.token;
    const given = await run(["request", "open", "--title", "T", "--require", JSON.stringify(REQUIRE),
      "--weave", sc.weaveId, "--thread", sc.threadId, "--target-token", keeper, "--json"], { cfg: stray });
    expect(given.code).toBe(0);
    expect(given.json().targetWeaveId).toBe(sc.weaveId);
  });

  it("request list shows the request and --status passes the filter through", async () => {
    const sc = await scenario();
    const r = await open(sc);
    const list = await run(["request", "list", "--status", "open", "--json"], { cfg: sc.bot });
    expect(list.code).toBe(0);
    expect(list.json().map((x: { id: string }) => x.id)).toContain(r.id);
    const cancelled = await run(["request", "list", "--status", "cancelled", "--json"], { cfg: sc.bot });
    expect(cancelled.json().map((x: { id: string }) => x.id)).not.toContain(r.id);
    const human = await run(["request", "list", "--status", "open"], { cfg: sc.bot });
    expect(human.out).toContain(r.id);
    expect(human.out).toContain("open");
  });

  it("request list --limit pages the board, and an impossible page is a usage error", async () => {
    const sc = await scenario();
    await open(sc);
    const newest = await open(sc);
    const all = await run(["request", "list", "--json"], { cfg: sc.bot });
    expect(all.json().length).toBeGreaterThan(1);
    // Newest first, so one page of one is the request this test opened last.
    const one = await run(["request", "list", "--limit", "1", "--json"], { cfg: sc.bot });
    expect(one.code).toBe(0);
    expect(one.json().map((x: { id: string }) => x.id)).toEqual([newest.id]);
    expect((await run(["request", "list", "--limit", "0"], { cfg: sc.bot })).code).toBe(2);
  });

  it("request offer, then request show, prints the offer with its accepted flag and the status", async () => {
    const sc = await scenario();
    const r = await open(sc);
    const offered = await run(["request", "offer", r.id, "--model", MODEL.model, "--effort", MODEL.effort, "--note", "on it", "--json"], { cfg: sc.bot });
    expect(offered.code).toBe(0);
    expect(offered.json().participantId).toBe(sc.botId);

    const show = await run(["request", "show", r.id], { cfg: sc.req });
    expect(show.code).toBe(0);
    expect(show.out).toContain(r.id);
    expect(show.out).toContain("open");
    expect(show.out).toContain("gpt-5.6-sol/high");
    expect(show.out).toContain("on it");
    expect(show.out).not.toContain("[accepted]");

    const accepted = await run(["request", "accept", r.id, sc.botId, "--json"], { cfg: sc.req });
    expect(accepted.code).toBe(0);
    expect(accepted.json().invitationIds).toHaveLength(1);
    const after = await run(["request", "show", r.id], { cfg: sc.req });
    expect(after.out).toContain("filled");
    expect(after.out).toContain("[accepted]");
  });

  it("request cancel closes the request, and cancelling again surfaces request_closed as exit 1", async () => {
    const sc = await scenario();
    const r = await open(sc);
    const first = await run(["request", "cancel", r.id], { cfg: sc.req });
    expect(first.code).toBe(0);
    expect(first.out).toContain(r.id);
    const again = await run(["request", "cancel", r.id], { cfg: sc.req });
    expect(again.code).toBe(1);
    expect(again.err).toContain("(request_closed)");
  });

  it("an accepted offer's invitation is redeemed by join --invite, which stores the target token", async () => {
    const sc = await scenario();
    const r = await open(sc);
    await run(["request", "offer", r.id, "--json"], { cfg: sc.bot });
    const accepted = (await run(["request", "accept", r.id, sc.botId, "--json"], { cfg: sc.req })).json();
    const joined = await run(["join", "--invite", accepted.invitationIds[0], "--json"], { cfg: sc.bot });
    expect(joined.code).toBe(0);
    expect(joined.json().weaveId).toBe(sc.weaveId);
    expect(new ConfigStore(sc.bot).load().weaves[sc.weaveId]?.token).toBe(joined.json().token);
  });

  it("join --invite --name lands under the name given", async () => {
    const sc = await scenario();
    const invited = (await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req })).json();
    const joined = await run(["join", "--invite", invited.invitationId, "--name", "Helper", "--json"], { cfg: sc.bot });
    expect(joined.code).toBe(0);
    expect(joined.json().participant.name).toBe("Helper");
  });

  it("join with neither a secret nor --invite is a usage error", async () => {
    const bad = await run(["join", "--name", "X"], { cfg: newCfg() });
    expect(bad.code).toBe(2);
  });

  it("invite-weave hands a Lobby participant a way into the current Weave", async () => {
    const sc = await scenario();
    const r = await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId], { cfg: sc.req });
    expect(r.code).toBe(0);
    expect(r.out).toContain(sc.botId);
    const j = await run(["invite-weave", sc.botId, "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req });
    expect(typeof j.json().invitationId).toBe("string");
  });
});

describe("loom read renders the Lobby events", () => {
  it("renders request opened, offered, accepted, closed and the invitation as system lines", async () => {
    const sc = await scenario();
    // Opened by hand rather than through `open()`: the title is what the opened line must name, and
    // a request carries it only as the name of its own Thread.
    const title = uniq("Review PR 14");
    const r = (await run(["request", "open", "--title", title, "--require", JSON.stringify(REQUIRE),
      "--wanted", "1", "--weave", sc.weaveId, "--thread", sc.threadId, "--json"], { cfg: sc.req })).json();
    await run(["request", "offer", r.id, "--model", MODEL.model, "--effort", MODEL.effort, "--note", "on it", "--json"], { cfg: sc.bot });
    await run(["request", "accept", r.id, sc.botId, "--json"], { cfg: sc.req });

    const read = await run(["read", "--weave", lobbyWeaveId, "--thread", r.threadId], { cfg: sc.req });
    expect(read.code).toBe(0);
    expect(read.out).toContain(`* request opened: ${title} (wants 1, expires ${hhmm(r.expiresAt)}) — eligible: 1`);
    expect(read.out).toContain(`* request offered by ${sc.botName} (gpt-5.6-sol/high): "on it"`);
    expect(read.out).toContain(`* request accepted: ${sc.botName} → "Loom session"`);
    expect(read.out).toContain(`* invited ${sc.botName} to "Loom session"`);
    expect(read.out).toContain(`* request closed (filled): accepted ${sc.botName}`);
  });

  it("renders a profile change as a system line", async () => {
    const cfg = newCfg();
    const name = uniq("Renderer");
    const joined = (await run(["lobby", "join", "--name", name, "--json"], { cfg })).json();
    // The two writes are checked, not assumed: a refused profile would otherwise show up only as a
    // line missing from the read, which reads like a rendering bug and is not one.
    expect((await run(["lobby", "me", "--set", JSON.stringify({ runtime: "node", owner: uniq("own") }), "--json"], { cfg })).code).toBe(0);
    const set = await run(["read", "--weave", lobbyWeaveId, "--thread", joined.generalThreadId], { cfg });
    expect(set.out).toContain(`* profile set by ${name}`);
    expect((await run(["lobby", "me", "--clear", "--json"], { cfg })).code).toBe(0);
    const cleared = await run(["read", "--weave", lobbyWeaveId, "--thread", joined.generalThreadId], { cfg });
    expect(cleared.out).toContain(`* profile cleared by ${name}`);
  });
});
