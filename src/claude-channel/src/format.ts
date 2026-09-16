import type { LoomEvent } from "@loom/client";
import type { Prefs } from "./state.js";

export type Names = { threads: Map<string, { name: string; url: string | null }>; participants: Map<string, { name: string; kind: string }> };

/** Meta values land inside a <channel …> tag; strip characters that could break out of it. */
function safe(v: unknown): string { return String(v ?? "").replace(/[<>"\r\n]/g, " ").trim(); }

/** A deadline as the local clock shows it: `until 14:00` is for a human reading over the agent's
 *  shoulder, and the exact instant is a `get_request` away. */
function hhmm(v: unknown): string {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A non-empty string from a payload field, else "". */
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function list(v: unknown): string[] { return Array.isArray(v) ? (v as string[]) : []; }

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
    // --- Lobby. One line each, naming the tool that acts on it: these arrive addressed to this
    // session, so the body says what it is being asked to do, not merely what happened.
    // A request's title is its Thread's name (core names the Thread after the request).
    case "request.opened": {
      const head = `Request "${threadName}": wants ${Number(e.payload.wanted ?? 1)}, until ${hhmm(e.payload.expiresAt)}`;
      content = list(e.payload.eligible).includes(me)
        ? `${head} — you are eligible; offer with offer(${str(e.payload.requestId)})`
        : `${head} — from ${actor.name}`;
      break;
    }
    case "request.offered": {
      const spec = [str(e.payload.model), str(e.payload.effort)].filter((v) => v.length > 0).join("/");
      const note = str(e.payload.note);
      content = `Offer from ${who(e.payload.participantId).name}${spec ? ` (${spec})` : ""}${note ? `: "${note}"` : ""}`;
      break;
    }
    case "request.accepted": {
      const ids = list(e.payload.participantIds);
      content = ids.includes(me)
        ? `Accepted: you were invited to "${str(e.payload.targetWeaveTitle)}" — join_weave({ inviteId })`
        : `Accepted: ${ids.map((id) => who(id).name).join(", ") || "nobody"} for "${str(e.payload.targetWeaveTitle)}"`;
      break;
    }
    case "request.closed": {
      const accepted = list(e.payload.accepted).map((id) => who(id).name).join(", ");
      content = `Request "${threadName}" ${str(e.payload.reason) || "closed"}: ${accepted ? `accepted ${accepted}` : "nobody accepted"}`;
      break;
    }
    case "weave.invited": {
      const title = str(e.payload.targetWeaveTitle);
      content = e.payload.participantId === me
        ? `Invited to "${title}" — join_weave({ inviteId: "${str(e.payload.invitationId)}" })`
        : `${who(e.payload.participantId).name} was invited to "${title}"`;
      break;
    }
    case "participant.capabilities_changed":
      content = `${who(e.payload.participantId).name} ${e.payload.capabilities ? "updated" : "cleared"} their Lobby profile`;
      break;
    default: content = e.type;
  }
  const meta: Record<string, string> = {
    weave: safe(weave.id), weave_title: safe(weave.title), thread: safe(e.threadId), thread_name: safe(threadName),
    seq: String(e.seq), type: e.type, from: safe(actor.name), from_kind: safe(actor.kind), ts: e.at,
  };
  if (thread.url) meta.thread_url = safe(thread.url);
  // Every event of a request carries its id — including the request Thread's own created/closed —
  // so a session that never saw the opening event can still read it with get_request(<id>).
  if (typeof e.payload.requestId === "string") meta.request = safe(e.payload.requestId);
  if (typeof e.payload.invitationId === "string") meta.invitation = safe(e.payload.invitationId);
  const mentions = Array.isArray(e.payload.mentions) ? (e.payload.mentions as string[]) : [];
  if (mentions.length > 0) meta.mentions = mentions.map(safe).join(",");
  return { content, meta };
}

export function shouldWake(e: LoomEvent, w: Prefs & { participantId: string }): boolean {
  if (e.actor === w.participantId) return false;
  // Lobby events are addressed-only: each type is decided here, above the `wake === "all"` fallback,
  // so a session standing in the Lobby in all-events mode is never woken by work meant for someone
  // else. `requests` governs solicitation alone — an offer on my own request, its closure, or an
  // acceptance naming me wakes whatever that flag says, because this session caused it.
  {
    const me = w.participantId;
    const has = (v: unknown) => Array.isArray(v) ? (v as string[]).includes(me) : v === me;
    switch (e.type) {
      case "participant.capabilities_changed": return false;
      case "request.opened": return w.requests && has(e.payload.eligible);
      case "request.offered": return has(e.payload.to);
      case "request.closed": return has(e.payload.to);
      case "request.accepted": return has(e.payload.participantIds);
      case "weave.invited": return w.invites && e.payload.participantId === me;
      // A request Thread's companions: its addressed request.opened / request.closed is what wakes.
      case "thread.created": case "thread.closed": if (typeof e.payload.requestId === "string") return false; break;
    }
  }
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
