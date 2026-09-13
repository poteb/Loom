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
  it("reads metadata and events from one snapshot: a Thread created mid-export appears in neither", async () => {
    // Metadata and the event pages used to be separate statements against the pool, so a Thread
    // created between them landed in the events but not in the Thread list (and, in Markdown,
    // vanished entirely because the rendering iterates the stale Thread list), with a lastSeq that
    // described older state than the events beside it.
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    const out = await exportWeave(db, me, r.weave.id, "json", {
      afterMetadata: async () => {
        const late = await createThread(db, bus, me, r.weave.id, "Late");
        await postMessage(db, bus, me, late.id, "committed mid-export");
      },
    });
    const json = JSON.parse(out);
    expect(json.threads.map((t: { name: string }) => t.name)).toEqual(["General"]);
    expect(json.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(json.weave.lastSeq).toBe(json.events.at(-1).seq);
    expect(out).not.toContain("committed mid-export");
    // The Weave really did move on; the export simply described one consistent point in time.
    expect((await exportWeave(db, me, r.weave.id, "json")).includes("committed mid-export")).toBe(true);
  });

  it("rejects bad format and foreign credential", async () => {
    const r = await createWeave(db, bus, input);
    const me = await resolveCredential(db, r.token);
    await expect(exportWeave(db, me, r.weave.id, "xml" as never)).rejects.toMatchObject({ code: "validation" });
    const other = await createWeave(db, bus, input);
    await expect(exportWeave(db, me, other.weave.id, "md")).rejects.toMatchObject({ code: "forbidden" });
  });
});
