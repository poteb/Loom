import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { participants } from "../src/db/schema.js";
import { createWeave } from "../src/weaves.js";
import { resolveCredential } from "../src/actors.js";
import { ensureLobby, joinLobby } from "../src/lobby/lobby.js";
import { setCapabilities } from "../src/lobby/profile.js";
import { listListeners } from "../src/lobby/listeners.js";
import { encodeCursor } from "../src/lobby/listeners-input.js";
import type {
  FacetValue, ListenersPage, ListenersQuery, ListenersSort, ServesKind,
} from "../src/lobby/listeners-input.js";
import { matches, type Profile } from "../src/lobby/matching.js";
import { createCore } from "../src/index.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);

let db: Db; let bus: EventBus; let reader: Actor;

beforeEach(async () => {
  db = await freshDb();
  bus = new EventBus();
  const lobby = await ensureLobby(db);
  reader = await resolveCredential(db, lobby.secret);
  // Every test's Lobby holds one participant that never set a profile: it is not a listener, and no
  // count, page or facet may ever include it.
  await joinLobby(db, bus, { name: "lurker", kind: "human" });
});

/** One Lobby participant per key, with that profile. */
async function seed(profiles: Record<string, Profile>): Promise<Record<string, { id: string; token: string }>> {
  const joined: Record<string, { id: string; token: string }> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const j = await joinLobby(db, bus, { name, kind: "agent" });
    await setCapabilities(db, bus, await resolveCredential(db, j.token), profile);
    joined[name] = { id: j.participant.id, token: j.token };
  }
  return joined;
}

const names = (p: ListenersPage) => p.listeners.map((l) => l.participant.name);
const listed = async (query: ListenersQuery = {}) => names(await listListeners(db, reader, query));
const pairs = (f: { values: FacetValue[] }) => f.values.map((v) => [v.value, v.count]);

/**
 * `joined_at` written as text, never through a JS `Date`: the column is microsecond `timestamptz`
 * and a `Date` holds milliseconds, which is the whole point of the precision tests below.
 */
const setJoinedAt = (id: string, ts: string) =>
  db.execute(sql`update ${participants} set joined_at = ${ts}::timestamptz where ${participants.id} = ${id}`);

/** Four listeners, no two alike in name, owner, model, tool, runtime or serving policy. */
const cast: Record<string, Profile> = {
  alice: { owner: "zoe", models: [{ model: "opus-5", effort: "high" }], tools: ["shell", "github"], runtime: "node", serves: "anyone" },
  bob: { owner: "ann", models: [{ model: "opus-5", effort: "low" }], tools: ["shell"], runtime: "python", serves: "owner" },
  carol: { owner: "mike", models: [{ model: "sonnet-5", effort: "high" }], tools: ["github"], runtime: "node", serves: ["zoe"] },
  // No `serves` key at all, which `admits` reads as "owner" (matching.ts:54).
  dave: { owner: "dee", models: [{ model: "haiku-5", effort: "low" }], tools: ["docs"], runtime: "deno" },
};

describe("listListeners filters", () => {
  it("matches a model at any effort", async () => {
    await seed(cast);
    expect(await listed({ models: [{ model: "opus-5" }] })).toEqual(["alice", "bob"]);
  });

  it("matches only the exact pair when an effort is named", async () => {
    await seed(cast);
    expect(await listed({ models: [{ model: "opus-5", effort: "high" }] })).toEqual(["alice"]);
  });

  it("takes models as alternatives", async () => {
    await seed(cast);
    expect(await listed({ models: [{ model: "sonnet-5" }, { model: "haiku-5" }] })).toEqual(["carol", "dave"]);
  });

  it("requires every named tool", async () => {
    await seed(cast);
    expect(await listed({ tools: ["shell", "github"] })).toEqual(["alice"]);
  });

  it("matches a runtime by equality", async () => {
    await seed(cast);
    expect(await listed({ runtime: "node" })).toEqual(["alice", "carol"]);
  });

  it("matches serves: anyone", async () => {
    await seed(cast);
    expect(await listed({ serves: "anyone" })).toEqual(["alice"]);
  });

  it("matches serves: list on a named list", async () => {
    await seed(cast);
    expect(await listed({ serves: "list" })).toEqual(["carol"]);
  });

  it("matches serves: owner", async () => {
    await seed(cast);
    expect(await listed({ serves: "owner" })).toEqual(["bob", "dave"]);
  });

  it("reads a profile with no serves key as serves: owner", async () => {
    await seed({ nova: { owner: "nell" } });
    expect(await listed({ serves: "owner" })).toEqual(["nova"]);
  });

  it("ANDs tools with runtime", async () => {
    await seed(cast);
    expect(await listed({ tools: ["shell"], runtime: "node" })).toEqual(["alice"]);
  });

  it("ANDs the search with a filter", async () => {
    await seed(cast);
    expect(await listed({ q: "an", models: [{ model: "opus-5" }] })).toEqual(["bob"]);
  });
});

describe("listListeners search", () => {
  it("matches a participant name case-insensitively", async () => {
    await seed(cast);
    expect(await listed({ q: "ALI" })).toEqual(["alice"]);
  });

  it("matches an owner case-insensitively", async () => {
    await seed(cast);
    expect(await listed({ q: "MIK" })).toEqual(["carol"]);
  });

  it("returns nobody when neither name nor owner matches", async () => {
    await seed(cast);
    expect(await listed({ q: "zzz" })).toEqual([]);
  });

  it("reads an underscore in the search as a literal", async () => {
    await seed({ "a_b": { owner: "one" }, "axb": { owner: "two" } });
    expect(await listed({ q: "a_b" })).toEqual(["a_b"]);
  });

  it("reads a percent sign in the search as a literal", async () => {
    await seed({ pct: { owner: "10%off" }, pctx: { owner: "10xoff" } });
    expect(await listed({ q: "10%off" })).toEqual(["pct"]);
  });
});

describe("an empty filter is no filter", () => {
  it("treats an empty tools list as absent", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { tools: [] });
    expect(names(page)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(page.matched).toBe(page.total);
  });

  it("treats an empty models list as absent", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { models: [] });
    expect(names(page)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(page.matched).toBe(page.total);
  });

  it("treats a whitespace-only search as absent", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { q: "   " });
    expect(names(page)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(page.matched).toBe(page.total);
  });
});

describe("listListeners ordering", () => {
  it("orders by each sort key in each direction", async () => {
    const who = await seed(cast);
    // Set explicitly: the development database's clock has stepped backwards (KNOWN-ISSUES), so the
    // order four rows were inserted in is not an order to assert on.
    await setJoinedAt(who.carol!.id, "2026-01-01T10:00:00Z");
    await setJoinedAt(who.alice!.id, "2026-01-01T11:00:00Z");
    await setJoinedAt(who.dave!.id, "2026-01-01T12:00:00Z");
    await setJoinedAt(who.bob!.id, "2026-01-01T13:00:00Z");
    const table: [ListenersSort, "asc" | "desc", string[]][] = [
      ["name", "asc", ["alice", "bob", "carol", "dave"]],
      ["name", "desc", ["dave", "carol", "bob", "alice"]],
      // owners: ann (bob), dee (dave), mike (carol), zoe (alice)
      ["owner", "asc", ["bob", "dave", "carol", "alice"]],
      ["owner", "desc", ["alice", "carol", "dave", "bob"]],
      ["joined", "asc", ["carol", "alice", "dave", "bob"]],
      ["joined", "desc", ["bob", "dave", "alice", "carol"]],
    ];
    for (const [sort, dir, expected] of table) {
      expect(await listed({ sort, dir })).toEqual(expected);
    }
  });

  it("orders names case-insensitively", async () => {
    await seed({ Zed: { owner: "one" }, alice: { owner: "two" } });
    expect(await listed({ sort: "name" })).toEqual(["alice", "Zed"]);
  });

  it("orders owners case-insensitively", async () => {
    await seed({ one: { owner: "Zed" }, two: { owner: "alice" } });
    expect(await listed({ sort: "owner" })).toEqual(["two", "one"]);
  });
});

describe("listListeners paging", () => {
  it("hands the next page back through the cursor, with no overlap", async () => {
    await seed(cast);
    const first = await listListeners(db, reader, { limit: 2 });
    expect(names(first)).toEqual(["alice", "bob"]);
    const second = await listListeners(db, reader, { limit: 2, cursor: first.nextCursor! });
    expect(names(second)).toEqual(["carol", "dave"]);
  });

  it("omits nextCursor on the last page", async () => {
    await seed(cast);
    const first = await listListeners(db, reader, { limit: 2 });
    const second = await listListeners(db, reader, { limit: 2, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeUndefined();
  });

  it("omits nextCursor when limit is 0", async () => {
    await seed(cast);
    expect((await listListeners(db, reader, { limit: 0 })).nextCursor).toBeUndefined();
  });

  it("keeps page 2 stable when a listener joins into page 1", async () => {
    await seed(cast);
    const first = await listListeners(db, reader, { limit: 2 });
    expect(names(first)).toEqual(["alice", "bob"]);
    await seed({ aaron: { owner: "new" } });
    expect(names(await listListeners(db, reader, { limit: 2, cursor: first.nextCursor! })))
      .toEqual(["carol", "dave"]);
  });

  it("shows a listener that joins after the cursor", async () => {
    await seed(cast);
    const first = await listListeners(db, reader, { limit: 3 });
    expect(names(first)).toEqual(["alice", "bob", "carol"]);
    await seed({ eve: { owner: "new" } });
    expect(names(await listListeners(db, reader, { limit: 3, cursor: first.nextCursor! })))
      .toEqual(["dave", "eve"]);
  });

  it("still pages from a cursor whose listener has cleared its profile", async () => {
    const who = await seed(cast);
    const first = await listListeners(db, reader, { limit: 2 });
    expect(names(first)).toEqual(["alice", "bob"]);
    await setCapabilities(db, bus, await resolveCredential(db, who.bob!.token), null);
    expect(names(await listListeners(db, reader, { limit: 2, cursor: first.nextCursor! })))
      .toEqual(["carol", "dave"]);
  });

  it("returns the default page of 50", async () => {
    const many: Record<string, Profile> = {};
    for (let i = 1; i <= 51; i++) many[`p${String(i).padStart(2, "0")}`] = { owner: "ann" };
    await seed(many);
    expect((await listListeners(db, reader)).listeners).toHaveLength(50);
  });
});

describe("the cursor's own rules", () => {
  it("rejects a malformed cursor", async () => {
    await seed(cast);
    await expect(listListeners(db, reader, { cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("rejects a cursor whose sort disagrees with the query", async () => {
    const who = await seed(cast);
    const cursor = encodeCursor({ s: "name", d: "asc", k: "alice", i: who.alice!.id });
    await expect(listListeners(db, reader, { sort: "owner", cursor }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("rejects a joined cursor whose key is not a timestamp", async () => {
    const who = await seed(cast);
    const cursor = encodeCursor({ s: "joined", d: "asc", k: "not-a-date", i: who.alice!.id });
    await expect(listListeners(db, reader, { sort: "joined", cursor }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("accepts the joined cursor it just emitted, unchanged", async () => {
    await seed(cast);
    const first = await listListeners(db, reader, { sort: "joined", limit: 2 });
    const second = await listListeners(db, reader, { sort: "joined", limit: 2, cursor: first.nextCursor! });
    expect(second.listeners).toHaveLength(2);
  });
});

describe("the joined cursor keeps the microseconds", () => {
  const stamps = [
    "2026-03-04T12:00:00.123400Z", "2026-03-04T12:00:00.123450Z",
    "2026-03-04T12:00:00.123456Z", "2026-03-04T12:00:00.123999Z",
  ];
  const four: Record<string, Profile> = {
    m1: { owner: "ann" }, m2: { owner: "ann" }, m3: { owner: "ann" }, m4: { owner: "ann" },
  };

  /** Every page of `limit: 1`, walked to the end. */
  async function walk(dir: "asc" | "desc"): Promise<string[]> {
    const seen: string[] = []; let cursor: string | undefined;
    for (;;) {
      const page = await listListeners(db, reader,
        { sort: "joined", dir, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...names(page));
      if (page.nextCursor === undefined) return seen;
      cursor = page.nextCursor;
    }
  }

  async function stamped(): Promise<void> {
    const who = await seed(four);
    for (const [i, name] of ["m1", "m2", "m3", "m4"].entries()) await setJoinedAt(who[name]!.id, stamps[i]!);
  }

  it("visits four listeners inside one millisecond exactly once, ascending", async () => {
    await stamped();
    expect(await walk("asc")).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("visits four listeners inside one millisecond exactly once, descending", async () => {
    await stamped();
    expect(await walk("desc")).toEqual(["m4", "m3", "m2", "m1"]);
  });
});

describe("the sort keys are never null", () => {
  it("cannot store a profile without an owner, so every listener has one", async () => {
    const j = await joinLobby(db, bus, { name: "nameless", kind: "agent" });
    const actor = await resolveCredential(db, j.token);
    await expect(setCapabilities(db, bus, actor, { runtime: "node" }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("drops a cleared profile out of the counts, the page and the facets", async () => {
    await seed(cast);
    const who = await seed({ ghost: { owner: "gus", tools: ["ghostly"] } });
    await setCapabilities(db, bus, await resolveCredential(db, who.ghost!.token), null);
    const page = await listListeners(db, reader);
    expect(names(page)).toEqual(["alice", "bob", "carol", "dave"]);
    expect(page.total).toBe(4);
    expect(pairs(page.facets!.tools).map(([value]) => value)).not.toContain("ghostly");
  });
});

describe("limit and the counts", () => {
  it("returns no rows but real counts and facets at limit 0", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { limit: 0 });
    expect(page.listeners).toEqual([]);
    expect(page.total).toBe(4);
    expect(page.facets!.serves.values).toHaveLength(3);
  });

  it("rejects a limit above the maximum page", async () => {
    await seed(cast);
    await expect(listListeners(db, reader, { limit: 1001 }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("counts every listener in total and only the matches in matched", async () => {
    await seed({ ...cast, erin: { owner: "eve", runtime: "node" } });
    const page = await listListeners(db, reader, { runtime: "node", limit: 2 });
    expect([page.total, page.matched, page.listeners.length]).toEqual([5, 3, 2]);
  });

  it("omits the facets when the caller asks for none, and changes neither count", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { runtime: "node", facets: false });
    expect(page.facets).toBeUndefined();
    expect([page.total, page.matched]).toEqual([4, 2]);
  });
});

describe("each facet leaves out its own filter", () => {
  it("counts every model although models is filtered", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { models: [{ model: "opus-5" }] });
    expect(page.facets!.models.values.map((m) => [m.model, m.count]))
      .toEqual([["opus-5", 2], ["haiku-5", 1], ["sonnet-5", 1]]);
  });

  it("applies the models filter to the tools facet", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { models: [{ model: "opus-5" }] });
    expect(pairs(page.facets!.tools)).toEqual([["shell", 2], ["github", 1]]);
  });

  it("applies the models filter to the runtimes facet", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { models: [{ model: "opus-5" }] });
    expect(pairs(page.facets!.runtimes)).toEqual([["node", 1], ["python", 1]]);
  });

  it("applies the models filter to the serves facet", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { models: [{ model: "opus-5" }] });
    expect(pairs(page.facets!.serves)).toEqual([["anyone", 1], ["owner", 1], ["list", 0]]);
  });
});

describe("a facet counts a listener once", () => {
  it("counts a tool a profile lists twice once", async () => {
    await seed({ dup: { owner: "ann", tools: ["shell", "shell"] } });
    const page = await listListeners(db, reader);
    expect(pairs(page.facets!.tools)).toEqual([["shell", 1]]);
  });

  it("counts a model offered at two efforts once", async () => {
    await seed({ dual: { owner: "ann", models: [{ model: "m", effort: "high" }, { model: "m", effort: "low" }] } });
    const page = await listListeners(db, reader);
    expect(page.facets!.models.values.map((m) => [m.model, m.count])).toEqual([["m", 1]]);
  });
});

describe("the facets are bounded", () => {
  it("reports the twenty most common tools and says there are more", async () => {
    const many: Record<string, Profile> = {};
    for (let i = 1; i <= 25; i++) {
      const t = `t${String(i).padStart(2, "0")}`;
      many[t] = { owner: "ann", tools: [t] };
    }
    await seed(many);
    const page = await listListeners(db, reader, { limit: 0 });
    expect([page.facets!.tools.values.length, page.facets!.tools.more]).toEqual([20, true]);
  });

  it("reports the ten most common efforts of a model and says there are more", async () => {
    const many: Record<string, Profile> = {};
    for (let i = 1; i <= 30; i++) {
      const e = `e${String(i).padStart(2, "0")}`;
      many[`p${String(i).padStart(2, "0")}`] = { owner: "ann", models: [{ model: "m", effort: e }] };
    }
    await seed(many);
    const page = await listListeners(db, reader, { limit: 0 });
    const model = page.facets!.models.values[0]!;
    expect([model.model, model.count, model.efforts.length, model.moreEfforts]).toEqual(["m", 30, 10, true]);
  });

  it("ranks models by listener count, not by how many efforts they carry", async () => {
    // 21 models with 24, 23 … 4 listeners each, spread over 24 listeners so that no profile carries
    // more than the 20 model entries a profile may hold.
    const model = (j: number) => `m${String(j + 1).padStart(2, "0")}`;
    const carried: string[][] = Array.from({ length: 24 }, () => []);
    let at = 0;
    for (let j = 0; j < 21; j++) {
      for (let n = 0; n < 24 - j; n++) carried[(at + n) % 24]!.push(model(j));
      at = (at + (24 - j)) % 24;
    }
    const many: Record<string, Profile> = {};
    carried.forEach((models, i) => {
      many[`p${String(i + 1).padStart(2, "0")}`] =
        { owner: "ann", models: models.map((m) => ({ model: m, effort: "high" })) };
    });
    // One model with fifty distinct efforts and only three listeners: an effort row is not a rank.
    const efforts = Array.from({ length: 50 }, (_, i) => `e${String(i + 1).padStart(2, "0")}`);
    [efforts.slice(0, 20), efforts.slice(20, 40), efforts.slice(40)].forEach((slice, i) => {
      many[`wide${i + 1}`] = { owner: "ann", models: slice.map((e) => ({ model: "wide", effort: e })) };
    });
    await seed(many);
    const page = await listListeners(db, reader, { limit: 0 });
    expect(page.facets!.models.values.map((m) => m.model))
      .toEqual(Array.from({ length: 20 }, (_, j) => model(j)));
  });
});

describe("a selected value is always in its facet", () => {
  it("keeps a selected tool that ranks outside the top twenty", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
    await seed({
      a: { owner: "ann", tools: twenty }, b: { owner: "ann", tools: twenty },
      c: { owner: "ann", tools: ["rare"] },
    });
    const page = await listListeners(db, reader, { tools: ["rare"], limit: 0 });
    expect(pairs(page.facets!.tools)).toContainEqual(["rare", 1]);
  });

  it("keeps a selected runtime another filter has eliminated, at zero", async () => {
    await seed(cast);
    const page = await listListeners(db, reader, { tools: ["shell"], runtime: "deno", limit: 0 });
    expect(pairs(page.facets!.runtimes)).toContainEqual(["deno", 0]);
  });

  it("keeps a selected model that ranks outside the top twenty", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ model: `m${String(i + 1).padStart(2, "0")}`, effort: "high" }));
    await seed({
      a: { owner: "ann", models: twenty }, b: { owner: "ann", models: twenty },
      c: { owner: "ann", models: [{ model: "rare", effort: "high" }] },
    });
    const page = await listListeners(db, reader, { models: [{ model: "rare" }], limit: 0 });
    expect(page.facets!.models.values.map((m) => [m.model, m.count])).toContainEqual(["rare", 1]);
  });

  it("keeps a selected effort that ranks outside a model's top ten", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ model: "m", effort: `e${String(i + 1).padStart(2, "0")}` }));
    await seed({
      a: { owner: "ann", models: ten }, b: { owner: "ann", models: ten },
      c: { owner: "ann", models: [{ model: "m", effort: "rare" }] },
    });
    const page = await listListeners(db, reader, { models: [{ model: "m", effort: "rare" }], limit: 0 });
    expect(page.facets!.models.values[0]!.efforts).toContainEqual({ value: "rare", count: 1 });
  });

  it("always reports all three serving policies, zeros included", async () => {
    await seed({ only: { owner: "ann", serves: "anyone" } });
    const page = await listListeners(db, reader, { limit: 0 });
    expect(pairs(page.facets!.serves)).toEqual([["anyone", 1], ["owner", 0], ["list", 0]]);
  });
});

describe("authorisation", () => {
  it("serves a participant of the Lobby", async () => {
    await seed(cast);
    const j = await joinLobby(db, bus, { name: "member", kind: "human" });
    const actor = await resolveCredential(db, j.token);
    expect((await listListeners(db, actor, { limit: 0 })).total).toBe(4);
  });

  it("serves the Lobby's own secret", async () => {
    await seed(cast);
    expect((await listListeners(db, reader, { limit: 0 })).total).toBe(4);
  });

  it("serves an instance keeper", async () => {
    await seed(cast);
    const core = createCore(db);
    await core.seedKeepers([keeperToken("k")]);
    const keeper = await core.resolveCredential(keeperToken("k"));
    expect((await listListeners(db, keeper, { limit: 0 })).total).toBe(4);
  });

  it("refuses a credential of another Weave", async () => {
    await seed(cast);
    const other = await createWeave(db, bus, { title: "Elsewhere", opener: "hi", creator: { name: "Paw", kind: "human" } });
    const outsider = await resolveCredential(db, other.token);
    await expect(listListeners(db, outsider, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is never reached without a credential", async () => {
    await seed(cast);
    await expect(resolveCredential(db, "")).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("serves an agent key that has joined, through the facade", async () => {
    const core = createCore(db);
    await core.seedKeepers([keeperToken("k")]);
    const keeper = await core.resolveCredential(keeperToken("k"));
    const { key } = await core.addAgent(keeper, "ChatGPT");
    const agent = await core.resolveCredential(key);
    await core.joinLobby({ kind: "agent" }, agent);
    await core.setCapabilities(agent, { owner: "bob", tools: ["github"] });
    expect((await core.listListeners(agent, { limit: 0 })).total).toBe(1);
  });
});

describe("the SQL agrees with matches and admits", () => {
  /** The serving kind `admits` reads out of a profile: `profile.serves ?? "owner"` (matching.ts:54). */
  const servesKindOf = (p: Profile): ServesKind => {
    const s = p.serves ?? "owner";
    return Array.isArray(s) ? "list" : s;
  };
  /** An actually-empty array is absent, exactly as `validateListenersQuery` normalises it. */
  const absentIfEmpty = <T>(v: T | undefined): T | undefined =>
    (Array.isArray(v) && v.length === 0 ? undefined : v);

  const zoo: Record<string, Profile> = {
    p01: { owner: "ann" },
    p02: { owner: "ann", tools: [] },
    p03: { owner: "ben", tools: ["shell"] },
    p04: { owner: "ben", tools: ["shell", "github"] },
    p05: { owner: "cat", tools: ["github", "shell", "shell"] },
    p06: { owner: "cat", models: [{ model: "opus-5", effort: "high" }] },
    p07: { owner: "dee", models: [{ model: "opus-5", effort: "low" }] },
    p08: { owner: "dee", models: [{ model: "opus-5", effort: "high" }, { model: "opus-5", effort: "low" }] },
    p09: { owner: "eve", models: [{ model: "opus-5", effort: "high" }, { model: "opus-5", effort: "high" }] },
    p10: { owner: "eve", models: [{ model: "sonnet-5", effort: "low" }] },
    p11: { owner: "fay", runtime: "node" },
    p12: { owner: "fay", runtime: "python" },
    p13: { owner: "gil", serves: "anyone" },
    p14: { owner: "gil", serves: "owner" },
    p15: { owner: "hal", serves: ["ann"] },
    p16: { owner: "hal", serves: ["ann", "ben"] },
    p17: { owner: "ivy", models: [{ model: "opus-5", effort: "high" }], tools: ["shell"], runtime: "node", serves: "anyone" },
    p18: { owner: "ivy", models: [{ model: "sonnet-5", effort: "low" }], tools: ["github"], runtime: "python", serves: "owner" },
    p19: { owner: "jan", models: [{ model: "opus-5", effort: "mid" }], tools: ["shell", "github"], runtime: "node" },
    p20: { owner: "jan", spawnsSubagents: true, tools: ["shell"] },
  };

  const filters: ListenersQuery[] = [
    {},
    { models: [{ model: "opus-5" }] },
    { models: [{ model: "opus-5", effort: "high" }] },
    { models: [{ model: "opus-5" }, { model: "sonnet-5", effort: "low" }] },
    { tools: ["shell"] },
    { tools: ["shell", "github"] },
    { runtime: "node" },
    { serves: "anyone" },
    { serves: "owner" },
    { serves: "list" },
    { tools: ["shell"], runtime: "node" },
    { models: [{ model: "opus-5" }], serves: "owner" },
    { tools: [] },
    { models: [] },
    { q: "   " },
    { runtime: "nothing-runs-this" },
  ];

  it("returns the same listeners the pure matchers do, for every filter", async () => {
    await seed(zoo);
    for (const f of filters) {
      const want = Object.entries(zoo).filter(([, p]) =>
        matches(p, { models: absentIfEmpty(f.models), tools: absentIfEmpty(f.tools), runtime: f.runtime })
        && (f.serves === undefined || servesKindOf(p) === f.serves),
      ).map(([name]) => name).sort();
      const got = (await listed({ ...f, limit: 1000 })).sort();
      expect({ filter: f, got }).toEqual({ filter: f, got: want });
    }
  });
});
