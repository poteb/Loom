import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { seedKeepers, listKeepers, addKeeper, removeKeeper } from "../src/keepers.js";
import { resolveCredential } from "../src/actors.js";
import { keepers } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function keeperActor(): Promise<Actor> {
  await seedKeepers(db, [keeperToken("tok-a")]);
  return resolveCredential(db, keeperToken("tok-a"));
}

describe("settings", () => {
  it("returns defaults on first read", async () => {
    expect(await getSettings(db)).toEqual({ instanceName: "Loom", maxMessageLength: 20000, openWeaveCreation: true });
  });
  it("keeper can update, others cannot", async () => {
    const k = await keeperActor();
    const s = await updateSettings(db, k, { instanceName: "Fragt Loom", openWeaveCreation: false });
    expect(s.instanceName).toBe("Fragt Loom");
    expect(s.openWeaveCreation).toBe(false);
    expect((await getSettings(db)).maxMessageLength).toBe(20000);
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(updateSettings(db, secret, { instanceName: "no" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("validates values", async () => {
    const k = await keeperActor();
    await expect(updateSettings(db, k, { maxMessageLength: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(updateSettings(db, k, { instanceName: "" })).rejects.toMatchObject({ code: "validation" });
  });
  it("empty patch is a no-op that returns current settings", async () => {
    const k = await keeperActor();
    await updateSettings(db, k, { instanceName: "Before" });
    const s = await updateSettings(db, k, {});
    expect(s.instanceName).toBe("Before");
    const s2 = await updateSettings(db, k, { instanceName: undefined });
    expect(s2.instanceName).toBe("Before");
  });
});

describe("keepers", () => {
  it("seed is idempotent and tokens resolve", async () => {
    await seedKeepers(db, [keeperToken("tok-a"), keeperToken("tok-b")]);
    await seedKeepers(db, [keeperToken("tok-a"), keeperToken("tok-b")]);
    const k = await resolveCredential(db, keeperToken("tok-b"));
    expect(k.kind).toBe("keeper");
    expect(await listKeepers(db, k)).toHaveLength(2);
  });
  it("seeds one keeper when the same token is listed twice", async () => {
    const t = keeperToken("tok-dup");
    await seedKeepers(db, [t, t]);
    const k = await resolveCredential(db, t);
    expect(await listKeepers(db, k)).toHaveLength(1);
  });
  it("numbers seed keepers by the deduplicated list", async () => {
    const a = keeperToken("tok-a"), b = keeperToken("tok-b");
    await seedKeepers(db, [a, a, b]);
    const k = await resolveCredential(db, a);
    expect((await listKeepers(db, k)).map((x) => x.name)).toEqual(["seed-1", "seed-2"]);
  });
  it("add returns a token that works; remove revokes it; cannot remove self", async () => {
    const k = await keeperActor();
    const { keeper, token } = await addKeeper(db, k, "Ops");
    expect(keeper.name).toBe("Ops");
    const k2 = await resolveCredential(db, token);
    expect(k2.kind).toBe("keeper");
    await expect(removeKeeper(db, k2, (k2 as { keeperId: string }).keeperId)).rejects.toMatchObject({ code: "validation" });
    await removeKeeper(db, k, keeper.id);
    await expect(resolveCredential(db, token)).rejects.toMatchObject({ code: "invalid_token" });
  });
  it("seeds only into an empty store, so a removed seed keeper stays removed", async () => {
    const a = keeperToken("tok-a"), b = keeperToken("tok-b");
    await seedKeepers(db, [a, b]);
    const k = await resolveCredential(db, a);
    const [gone] = (await listKeepers(db, k)).filter((x) => x.name === "seed-2");
    await removeKeeper(db, k, gone!.id);
    await seedKeepers(db, [a, b]);                       // a restart re-runs the seed
    await expect(resolveCredential(db, b)).rejects.toMatchObject({ code: "invalid_token" });
    expect(await listKeepers(db, k)).toHaveLength(1);
  });
  it("two keepers removing each other cannot empty the store", async () => {
    // Both removals pass their own freshness check, then delete different rows — nothing conflicts,
    // so both used to succeed and the table ended up empty. That is not just a lockout: seedKeepers
    // treats an empty table as eligible for bootstrap, so the next restart resurrects the env
    // tokens these keepers had replaced. The seam parks the first removal past its own check, which
    // is exactly the interleaving two concurrent requests produce. In this interleaving ka has also
    // been revoked by the time it takes the lock, so the in-lock actor re-check rejects it as a
    // revoked credential before the last-keeper count is even reached; either way the store keeps
    // exactly one keeper.
    const a = keeperToken("tok-a"), b = keeperToken("tok-b");
    await seedKeepers(db, [a, b]);
    const ka = await resolveCredential(db, a) as Actor & { keeperId: string };
    const kb = await resolveCredential(db, b) as Actor & { keeperId: string };

    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    const first = removeKeeper(db, ka, kb.keeperId, { afterAuth: () => parked });
    await removeKeeper(db, kb, ka.keeperId);      // the other keeper wins and removes ka
    release();

    await expect(first).rejects.toMatchObject({ code: "invalid_token" });
    const left = await db.select().from(keepers);
    expect(left).toHaveLength(1);
    expect((await resolveCredential(db, left[0]!.token)).kind).toBe("keeper");
  });

  it("a keeper removed while its own removal was in flight cannot commit it", async () => {
    // The last-keeper guard only covers the two-keeper case. With three keepers the counts stay
    // healthy, so A's removal of C used to commit even though B had already revoked A: authority
    // was only ever checked before the transaction. CONTRIBUTING requires the re-check to happen
    // inside the lock, so the actor's own row is verified against the same FOR UPDATE select.
    const a = keeperToken("tok-a"), b = keeperToken("tok-b"), c = keeperToken("tok-c");
    await seedKeepers(db, [a, b, c]);
    const ka = await resolveCredential(db, a) as Actor & { keeperId: string };
    const kb = await resolveCredential(db, b) as Actor & { keeperId: string };
    const kc = await resolveCredential(db, c) as Actor & { keeperId: string };

    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    const first = removeKeeper(db, ka, kc.keeperId, { afterAuth: () => parked });
    await removeKeeper(db, kb, ka.keeperId);      // B revokes A while A's own removal is parked
    release();

    await expect(first).rejects.toMatchObject({ code: "invalid_token" });
    expect((await resolveCredential(db, c)).kind).toBe("keeper");
    expect((await listKeepers(db, kb)).map((k) => k.id).sort()).toEqual([kb.keeperId, kc.keeperId].sort());
  });

  it("ignores tokens that are not 43-char base64url", async () => {
    await seedKeepers(db, ["short"]);
    expect(await db.select().from(keepers)).toHaveLength(0);
    await expect(resolveCredential(db, "short")).rejects.toMatchObject({ code: "invalid_token" });
  });

  // The boot log used to report the configured token count, which says nothing about what the
  // seed actually did: on 2026-09-15 a fresh token in .env was announced as "seeded: 1" while the
  // existing keeper made the seed a no-op. The counts below are what the server logs instead.
  describe("seedKeepers reports what it did", () => {
    it("counts the rows it inserted into an empty table", async () => {
      const r = await seedKeepers(db, [keeperToken("tok-a"), keeperToken("tok-b")]);
      expect(r).toEqual({ seeded: 2, existing: 0, ignored: 0 });
    });
    it("reports the keepers that made it skip, and seeds nothing", async () => {
      await seedKeepers(db, [keeperToken("tok-a")]);
      const r = await seedKeepers(db, [keeperToken("tok-new")]);
      expect(r).toEqual({ seeded: 0, existing: 1, ignored: 0 });
      await expect(resolveCredential(db, keeperToken("tok-new"))).rejects.toMatchObject({ code: "invalid_token" });
    });
    it("counts malformed and duplicate entries as ignored", async () => {
      const a = keeperToken("tok-a");
      const r = await seedKeepers(db, [a, a, "short"]);
      expect(r).toEqual({ seeded: 1, existing: 0, ignored: 2 });
    });
    it("reports an empty instance with nothing configured", async () => {
      expect(await seedKeepers(db, [])).toEqual({ seeded: 0, existing: 0, ignored: 0 });
    });
  });
  it("non-keepers are refused", async () => {
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(listKeepers(db, secret)).rejects.toMatchObject({ code: "forbidden" });
  });
});
