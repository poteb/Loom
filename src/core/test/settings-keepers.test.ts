import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { seedKeepers, listKeepers, addKeeper, removeKeeper } from "../src/keepers.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function keeperActor(): Promise<Actor> {
  await seedKeepers(db, ["tok-a"]);
  return resolveCredential(db, "tok-a");
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
    await seedKeepers(db, ["tok-a", "tok-b"]);
    await seedKeepers(db, ["tok-a", "tok-b"]);
    const k = await resolveCredential(db, "tok-b");
    expect(k.kind).toBe("keeper");
    expect(await listKeepers(db, k)).toHaveLength(2);
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
  it("non-keepers are refused", async () => {
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(listKeepers(db, secret)).rejects.toMatchObject({ code: "forbidden" });
  });
});
