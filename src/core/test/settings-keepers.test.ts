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
  it("ignores tokens that are not 43-char base64url", async () => {
    await seedKeepers(db, ["short"]);
    expect(await db.select().from(keepers)).toHaveLength(0);
    await expect(resolveCredential(db, "short")).rejects.toMatchObject({ code: "invalid_token" });
  });
  it("non-keepers are refused", async () => {
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(listKeepers(db, secret)).rejects.toMatchObject({ code: "forbidden" });
  });
});
