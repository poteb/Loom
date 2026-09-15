import type { LoomEvent } from "@loom/client";
import type { Wake } from "./state.js";

export type Names = { threads: Map<string, { name: string; url: string | null }>; participants: Map<string, { name: string; kind: string }> };

/** Meta values land inside a <channel …> tag; strip characters that could break out of it. */
function safe(v: unknown): string { return String(v ?? "").replace(/[<>"\r\n]/g, " ").trim(); }

/** `me` is the session's own participant id, so an invite addressed to it reads as "You were invited". */
export function formatEvent(e: LoomEvent, weave: { id: string; title: string }, names: Names, me: string): { content: string; meta: Record<string, string> } {
  const who = (id: unknown) => (typeof id === "string" && id.startsWith("keeper:")) ? { name: "Keeper", kind: "keeper" } : (names.participants.get(String(id)) ?? { name: "unknown", kind: "unknown" });
  const actor = who(e.actor);
  const thread = names.threads.get(e.threadId) ?? { name: e.threadId, url: null };
  const threadName = thread.name;
  let content: string;
  switch (e.type) {
    case "message": content = String(e.payload.text ?? ""); break;
    case "participant.joined": content = `${who(e.payload.participantId).name === "unknown" ? String(e.payload.name ?? "Someone") : who(e.payload.participantId).name} joined the Weave`; break;
    case "participant.role_changed": content = `${who(e.payload.participantId).name} is now ${String(e.payload.role)}`; break;
    case "thread.created": content = `Thread "${String(e.payload.name ?? threadName)}" created by ${actor.name}${e.payload.url ? `\n${String(e.payload.url)}` : ""}`; break;
    case "thread.closed": content = `Thread "${threadName}" closed by ${actor.name}`; break;
    case "thread.invited": {
      const invitee = String(e.payload.participantId ?? "");
      const url = thread.url ? `\n${thread.url}` : "";
      content = invitee === me ? `You were invited to Thread "${threadName}" by ${actor.name}${url}` : `${who(invitee).name} was invited to Thread "${threadName}" by ${actor.name}`;
      break;
    }
    case "thread.url_changed": content = e.payload.url ? `Thread "${threadName}" now links to ${String(e.payload.url)}` : `Thread "${threadName}" no longer links to an artefact`; break;
    case "weave.archived": content = `Weave archived by ${actor.name}`; break;
    case "weave.guidelines_changed": {
      const text = String(e.payload.guidelines ?? "");
      content = text ? text : `Guidelines cleared by ${actor.name}`;
      break;
    }
    default: content = e.type;
  }
  const meta: Record<string, string> = {
    weave: safe(weave.id), weave_title: safe(weave.title), thread: safe(e.threadId), thread_name: safe(threadName),
    seq: String(e.seq), type: e.type, from: safe(actor.name), from_kind: safe(actor.kind), ts: e.at,
  };
  if (thread.url) meta.thread_url = safe(thread.url);
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  if (mentions.length > 0) meta.mentions = mentions.map(safe).join(",");
  return { content, meta };
}

export function shouldWake(e: LoomEvent, w: { participantId: string; wake: Wake; invites: boolean }): boolean {
  if (e.actor === w.participantId) return false;
  // A rules change concerns every participant, so it wakes regardless of the wake mode — like an
  // invite addressed to this session, except that there is nothing to opt out of.
  if (e.type === "weave.guidelines_changed") return true;
  if (e.type === "thread.invited" && e.payload.participantId === w.participantId) return w.invites;
  if (w.wake === "all") return true;
  if (e.type !== "message") return false;
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  return mentions.includes(w.participantId);
}

/** Folds the current guidelines into the first woken notification for a Weave in this session: one
 *  turn carrying rules and event together, so the agent never wakes with rules and nothing to act on
 *  (two awaited sends would prove transport order, not one agent turn). No guidelines, no change. */
export function withPreamble(n: { content: string; meta: Record<string, string> }, guidelines: string): { content: string; meta: Record<string, string> } {
  if (!guidelines) return n;
  return { content: `${guidelines}\n\n---\n\n${n.content}`, meta: { ...n.meta, preamble: "guidelines" } };
}
