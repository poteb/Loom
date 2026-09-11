import type { LoomEvent } from "@loom/client";
import type { Wake } from "./state.js";

export type Names = { threads: Map<string, string>; participants: Map<string, { name: string; kind: string }> };

/** Meta values land inside a <channel …> tag; strip characters that could break out of it. */
function safe(v: unknown): string { return String(v ?? "").replace(/[<>"\r\n]/g, " ").trim(); }

export function formatEvent(e: LoomEvent, weave: { id: string; title: string }, names: Names): { content: string; meta: Record<string, string> } {
  const who = (id: unknown) => (typeof id === "string" && id.startsWith("keeper:")) ? { name: "Keeper", kind: "keeper" } : (names.participants.get(String(id)) ?? { name: "unknown", kind: "unknown" });
  const actor = who(e.actor);
  const threadName = names.threads.get(e.threadId) ?? e.threadId;
  let content: string;
  switch (e.type) {
    case "message": content = String(e.payload.text ?? ""); break;
    case "participant.joined": content = `${who(e.payload.participantId).name === "unknown" ? String(e.payload.name ?? "Someone") : who(e.payload.participantId).name} joined the Weave`; break;
    case "participant.role_changed": content = `${who(e.payload.participantId).name} is now ${String(e.payload.role)}`; break;
    case "thread.created": content = `Thread "${String(e.payload.name ?? threadName)}" created by ${actor.name}`; break;
    case "thread.closed": content = `Thread "${threadName}" closed by ${actor.name}`; break;
    case "weave.archived": content = `Weave archived by ${actor.name}`; break;
    default: content = e.type;
  }
  const meta: Record<string, string> = {
    weave: safe(weave.id), weave_title: safe(weave.title), thread: safe(e.threadId), thread_name: safe(threadName),
    seq: String(e.seq), type: e.type, from: safe(actor.name), from_kind: safe(actor.kind), ts: e.at,
  };
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  if (mentions.length > 0) meta.mentions = mentions.map(safe).join(",");
  return { content, meta };
}

export function shouldWake(e: LoomEvent, w: { participantId: string; wake: Wake }): boolean {
  if (e.actor === w.participantId) return false;
  if (w.wake === "all") return true;
  if (e.type !== "message") return false;
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  return mentions.includes(w.participantId);
}
