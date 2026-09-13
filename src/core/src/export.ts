import type { Db } from "./db/index.js";
import { errors } from "./errors.js";
import { getWeave } from "./weaves.js";
import { readEvents } from "./events.js";
import type { Actor, LoomEvent, PublicParticipant } from "./types.js";

export type ExportOptions = {
  /** Test seam: runs after the metadata read, before the event pages, to commit a concurrent write. */
  afterMetadata?: () => Promise<void>;
};

export async function exportWeave(db: Db, actor: Actor, weaveId: string, format: "md" | "json", opts: ExportOptions = {}): Promise<string> {
  if (format !== "md" && format !== "json") throw errors.validation("format must be md or json");
  // One snapshot for the whole export. The metadata read and the event pages are many statements,
  // and under READ COMMITTED each sees a different moment: a Thread created in between lands in the
  // events but not in the Thread list, `lastSeq` describes older state than the events beside it,
  // and the Markdown — which iterates the Thread list — drops those events entirely. REPEATABLE
  // READ gives every statement the snapshot taken by the first; read-only says so to the server.
  const { info, all } = await db.transaction(async (tx) => {
    const info = await getWeave(tx, actor, weaveId);
    if (opts.afterMetadata) await opts.afterMetadata();
    const all: LoomEvent[] = [];
    let since = 0;
    for (;;) {
      const page = await readEvents(tx, weaveId, { since, limit: 1000 });
      all.push(...page);
      if (page.length < 1000) break;
      since = page.at(-1)!.seq;
    }
    return { info, all };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  if (format === "json") return JSON.stringify({ ...info, events: all }, null, 2);

  const byId = new Map(info.participants.map((p) => [p.id, p]));
  const who = (actorId: string) => actorId.startsWith("keeper:") ? "Keeper" : (byId.get(actorId)?.name ?? actorId);
  const nameOf = (pid: unknown) => (typeof pid === "string" ? byId.get(pid)?.name ?? pid : "?");
  const lines: string[] = [];
  lines.push(`# ${info.weave.title}`, "");
  lines.push(`- Created: ${info.weave.createdAt}`);
  lines.push(`- Archived: ${info.weave.archivedAt ?? "no"}`);
  lines.push(`- Participants: ${info.participants.map((p: PublicParticipant) => `${p.name} (${p.kind}, ${p.role})`).join(", ")}`, "");
  for (const t of info.threads) {
    lines.push(t.url ? `## ${t.name}\n\n<${t.url}>` : `## ${t.name}`, "");
    for (const e of all.filter((x) => x.threadId === t.id)) {
      if (e.type === "message") {
        lines.push(`**${who(e.actor)}** · ${e.at}`, String(e.payload.text ?? ""), "");
        continue;
      }
      const sys =
        e.type === "participant.joined" ? `${nameOf(e.payload.participantId)} joined` :
        e.type === "participant.role_changed" ? `${nameOf(e.payload.participantId)} is now ${String(e.payload.role)}` :
        e.type === "thread.created" ? `Thread "${String(e.payload.name)}" created by ${who(e.actor)}` :
        e.type === "thread.closed" ? `Thread closed by ${who(e.actor)}` :
        e.type === "thread.url_changed" ? (e.payload.url ? `Thread now links to ${String(e.payload.url)}` : "Thread no longer links to an artefact") :
        e.type === "thread.invited" ? `${nameOf(e.payload.participantId)} invited by ${who(e.actor)}` :
        e.type === "weave.archived" ? "Weave archived" : e.type;
      lines.push(`_system: ${sys}_ · ${e.at}`, "");
    }
  }
  return lines.join("\n");
}
