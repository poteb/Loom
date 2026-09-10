import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb, keeperToken } from "./helpers.js";
import { createCore, type Core } from "../src/index.js";
import type { Actor } from "../src/types.js";

afterAll(closeTestDb);
let core: Core;
beforeEach(async () => { core = createCore(await freshDb()); });

const A = keeperToken("tok-a");
const B = keeperToken("tok-b");

describe("instance-keeper authority is re-read on every use", () => {
  it("a removed keeper's stale Actor is refused everywhere", async () => {
    await core.seedKeepers([A, B]);
    const a = await core.resolveCredential(A);
    const b = await core.resolveCredential(B);
    await core.removeKeeper(b, (a as { keeperId: string }).keeperId);

    await expect(core.listWeaves(a)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.readSettings(a)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.updateSettings(a, { instanceName: "No" })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.addKeeper(a, "Ops")).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.listKeepers(a)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.removeKeeper(a, (b as { keeperId: string }).keeperId)).rejects.toMatchObject({ code: "invalid_token" });
    expect(await core.listKeepers(b)).toHaveLength(1);
  });

  it("a removed keeper cannot create a Weave once creation is restricted", async () => {
    await core.seedKeepers([A, B]);
    const a = await core.resolveCredential(A);
    const b = await core.resolveCredential(B);
    await core.updateSettings(b, { openWeaveCreation: false });
    await core.removeKeeper(b, (a as { keeperId: string }).keeperId);
    const input = { title: "T", opener: "hi", creator: { name: "Claude", kind: "agent" as const } };
    await expect(core.createWeave(input, a)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(core.createWeave(input)).rejects.toMatchObject({ code: "forbidden" });
    expect((await core.createWeave(input, b)).weave.title).toBe("T");
  });

  it("readSettings refuses a non-keeper and serves a keeper", async () => {
    await core.seedKeepers([A]);
    const a = await core.resolveCredential(A);
    const secret: Actor = { kind: "secret", weaveId: "x" };
    await expect(core.readSettings(secret)).rejects.toMatchObject({ code: "forbidden" });
    expect(await core.readSettings(a)).toMatchObject({ instanceName: "Loom" });
  });
});
