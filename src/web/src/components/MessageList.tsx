import { useEffect, useRef } from "preact/hooks";
import type { LoomEvent } from "@loom/client";
import type { SessionState } from "../session.js";
import { renderMarkdown } from "../markdown.js";

/** Display name for an event's actor: a keeper acts as "Keeper", everyone else as their participant name. */
function who(actor: string, state: SessionState): string {
  return actor.startsWith("keeper:") ? "Keeper" : (state.participants.find((p) => p.id === actor)?.name ?? "unknown");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

function systemLine(e: LoomEvent, state: SessionState): string {
  const name = (id: unknown) => state.participants.find((p) => p.id === id)?.name ?? "someone";
  // A request's title is its Thread's name: core names the Thread after the request.
  const threadName = () => state.threads.find((t) => t.id === e.threadId)?.name ?? "";
  const spec = () => [str(e.payload.model), str(e.payload.effort)].filter((v) => v.length > 0).join("/");
  switch (e.type) {
    case "participant.joined": return `${name(e.payload.participantId)} joined`;
    case "participant.role_changed": return `${name(e.payload.participantId)} is now ${String(e.payload.role)}`;
    case "thread.created": return `thread "${String(e.payload.name)}" created`;
    case "thread.closed": return "thread closed";
    case "thread.invited": return `${name(e.payload.participantId)} invited by ${who(e.actor, state)}`;
    case "thread.url_changed": return e.payload.url ? `thread now links to ${String(e.payload.url)}` : "thread no longer links to an artefact";
    case "weave.archived": return "weave archived";
    case "weave.guidelines_changed": return e.payload.guidelines ? `${who(e.actor, state)} changed the Weave guidelines` : `${who(e.actor, state)} cleared the Weave guidelines`;
    // --- Lobby. One line each, in the request's own Thread; the panel carries the state, these
    // carry the history. Deadlines are left to the panel's countdown — the line has its own time.
    case "request.opened": return `request "${threadName()}" opened by ${who(e.actor, state)}: wants ${Number(e.payload.wanted ?? 1)}`;
    case "request.offered": {
      const note = str(e.payload.note);
      return `${name(e.payload.participantId)} offered${spec() ? ` (${spec()})` : ""}${note ? `: "${note}"` : ""}`;
    }
    case "request.accepted": {
      const ids = list(e.payload.participantIds);
      return `${ids.map(name).join(", ") || "nobody"} accepted for "${str(e.payload.targetWeaveTitle)}"`;
    }
    case "request.closed": {
      const accepted = list(e.payload.accepted).map(name).join(", ");
      return `request ${str(e.payload.reason) || "closed"}: ${accepted ? `accepted ${accepted}` : "nobody accepted"}`;
    }
    case "weave.invited": return `${name(e.payload.participantId)} invited to "${str(e.payload.targetWeaveTitle)}"`;
    case "participant.capabilities_changed":
      return `${name(e.payload.participantId)} ${e.payload.capabilities ? "updated" : "cleared"} their Lobby profile`;
    default: return e.type;
  }
}

export function MessageList({ state }: { state: SessionState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const events = state.events.filter((e) => e.threadId === state.currentThreadId);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [events.length, state.currentThreadId]);
  return (
    <main class="messages">
      {events.map((e) => e.type === "message" ? (
        <article key={e.seq} class="msg">
          <div class="msg-head"><strong>{who(e.actor, state)}</strong> <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
          <div class="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.text ?? ""), state.participants, (e.payload.mentions as string[] | undefined) ?? []) }} />
        </article>
      ) : (
        <div key={e.seq} class="system">
          <div>{systemLine(e, state)} · <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
          {/* The guidelines the change installed, shown in the thread so the room can read them
              without opening the panel. Rendered from the event, never from the panel's state. */}
          {e.type === "weave.guidelines_changed" && e.payload.guidelines ? (
            <div class="system-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.guidelines), state.participants, []) }} />
          ) : null}
        </div>
      ))}
      <div ref={bottom} />
    </main>
  );
}
