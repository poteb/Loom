import { useEffect, useRef } from "preact/hooks";
import type { LoomEvent } from "@loom/client";
import type { SessionState } from "../session.js";
import { renderMarkdown } from "../markdown.js";

function systemLine(e: LoomEvent, state: SessionState): string {
  const name = (id: unknown) => state.participants.find((p) => p.id === id)?.name ?? "someone";
  switch (e.type) {
    case "participant.joined": return `${name(e.payload.participantId)} joined`;
    case "participant.role_changed": return `${name(e.payload.participantId)} is now ${String(e.payload.role)}`;
    case "thread.created": return `thread "${String(e.payload.name)}" created`;
    case "thread.closed": return "thread closed";
    case "weave.archived": return "weave archived";
    default: return e.type;
  }
}

export function MessageList({ state }: { state: SessionState }) {
  const bottom = useRef<HTMLDivElement>(null);
  const events = state.events.filter((e) => e.threadId === state.currentThreadId);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [events.length, state.currentThreadId]);
  const who = (actor: string) => actor.startsWith("keeper:") ? "Keeper" : (state.participants.find((p) => p.id === actor)?.name ?? "unknown");
  return (
    <main class="messages">
      {events.map((e) => e.type === "message" ? (
        <article key={e.seq} class="msg">
          <div class="msg-head"><strong>{who(e.actor)}</strong> <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
          <div class="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.text ?? ""), state.participants, (e.payload.mentions as string[] | undefined) ?? []) }} />
        </article>
      ) : (
        <div key={e.seq} class="system">{systemLine(e, state)} · <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time></div>
      ))}
      <div ref={bottom} />
    </main>
  );
}
