import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { freshDb, closeTestDb } from "./helpers.js";
import { EventBus } from "../src/bus.js";
import { createWeave, joinWeave, archiveWeave } from "../src/weaves.js";
import { createThread } from "../src/threads.js";
import { postMessage } from "../src/messages.js";
import { exportWeave } from "../src/export.js";
import { resolveCredential } from "../src/actors.js";
import type { Db } from "../src/db/index.js";

afterAll(closeTestDb);
let db: Db; let bus: EventBus;
beforeEach(async () => { db = await freshDb(); bus = new EventBus(); });
const input = { title: "PR 42", opener: "Look at this", creator: { name: "Claude", kind: "agent" as const } };

describe("exportWeave", () => {
  it("json contains everything, md is grouped by thread, secret can export archived weave", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const j = await joinWeave(db, bus, r.secret, { name: "ChatGPT", kind: "agent" });
    const gpt = await resolveCredential(db, j.token);
    const t = await createThread(db, bus, me, r.weave.id, "Design");
    await postMessage(db, bus, gpt, t.id, "I disagree @Claude");
    await archiveWeave(db, bus, me, r.weave.id);

    const bySecret = await resolveCredential(db, r.secret);
    const json = JSON.parse(await exportWeave(db, bySecret, r.weave.id, "json"));
    expect(json.weave.title).toBe("PR 42");
    expect(json.threads).toHaveLength(2);
    expect(json.participants).toHaveLength(2);
    expect(json.events.at(-1).type).toBe("weave.archived");
    expect(JSON.stringify(json)).not.toContain(r.token);

    const md = await exportWeave(db, bySecret, r.weave.id, "md");
    expect(md).toContain("# PR 42");
    expect(md.indexOf("## General")).toBeLessThan(md.indexOf("## Design"));
    expect(md).toContain("**ChatGPT**");
    expect(md).toContain("I disagree @Claude");
    expect(md).toContain("_system: ChatGPT joined_");
    expect(md).toContain("_system: Weave archived_");
  });
  it("rejects bad format and foreign credential", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(exportWeave(db, me, r.weave.id, "xml" as never)).rejects.toMatchObject({ code: "validation" });
    const other = await createWeave(db, bus, input);
    await expect(exportWeave(db, me, other.weave.id, "md")).rejects.toMatchObject({ code: "forbidden" });
  });
});
