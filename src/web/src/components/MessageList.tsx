import { useEffect, useRef, useState } from "preact/hooks";
import type { LoomEvent } from "@loom/client";
import type { SessionState } from "../session.js";
import { renderMarkdown } from "../markdown.js";
import { foldStream, runSummary, timeRange } from "./fold.js";
import { initials } from "./initials.js";

/** Display name for an event's actor: a keeper acts as "Keeper", everyone else as their participant name. */
function who(actor: string, state: SessionState): string {
  return actor.startsWith("keeper:") ? "Keeper" : (state.participants.find((p) => p.id === actor)?.name ?? "unknown");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
/** An instant as the browser's clock shows it, or "?" when it is not one. */
function clock(v: unknown): string {
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString();
}

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
    // The next three in the CLI's words (`loom read`), with times in the browser's own clock.
    case "request.completed": return `${name(e.payload.participantId)} finished "${threadName()}"`;
    case "request.overdue": {
      const seen = typeof e.payload.lastSeenAt === "string" ? clock(e.payload.lastSeenAt) : "never";
      return `${name(e.payload.participantId)} missed the deadline of "${threadName()}" (due ${clock(e.payload.dueAt)}, last seen ${seen})`;
    }
    case "thread.removed": {
      const by = str(e.payload.removedBy).startsWith("keeper:") ? "Keeper" : name(e.payload.removedBy);
      return `${name(e.payload.participantId)} was removed from this Thread by ${by}`;
    }
    case "weave.invited": return `${name(e.payload.participantId)} invited to "${str(e.payload.targetWeaveTitle)}"`;
    case "participant.capabilities_changed":
      return `${name(e.payload.participantId)} ${e.payload.capabilities ? "updated" : "cleared"} their Lobby profile`;
    default: return e.type;
  }
}


const time = (iso: string) => new Date(iso).toLocaleTimeString();

/** The chevron of a folded run, from the artboard; turned down while the run is expanded. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg class={`sys-chevron${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** One message: the avatar, a head line (name, an agent pill, a keeper's role, the time) and the body. */
function Message({ e, state }: { e: LoomEvent; state: SessionState }) {
  const keeper = e.actor.startsWith("keeper:");
  const p = keeper ? undefined : state.participants.find((x) => x.id === e.actor);
  const agent = p?.kind === "agent";
  const letters = keeper ? "K" : p ? initials(p.name) : "?";
  return (
    <article class="msg">
      <span class={`msg-avatar${agent ? " agent" : ""}`} aria-hidden="true">{letters}</span>
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-name">{who(e.actor, state)}</span>
          {agent && <span class="pill pill-working msg-pill">agent</span>}
          {p?.role === "keeper" && <span class="muted msg-role">keeper</span>}
          <time class="muted mono" dateTime={e.at}>{time(e.at)}</time>
        </div>
        <div class="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.text ?? ""), state.participants, (e.payload.mentions as string[] | undefined) ?? []) }} />
      </div>
    </article>
  );
}

/** One system event on its own row, and under it the guidelines a guidelines change installed. */
function SystemEvent({ e, state }: { e: LoomEvent; state: SessionState }) {
  return (
    <div class="sys">
      <div class="sysrow">
        <span class="sys-line"><span class="sys-text">{systemLine(e, state)}</span> · <time class="mono" dateTime={e.at}>{time(e.at)}</time></span>
      </div>
      {/* The guidelines the change installed, shown in the thread so the room can read them
          without opening the panel. Rendered from the event, never from the panel's state. */}
      {e.type === "weave.guidelines_changed" && e.payload.guidelines ? (
        <div class="system-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(e.payload.guidelines), state.participants, []) }} />
      ) : null}
    </div>
  );
}

/** A folded run: one row saying what happened and when, with the button that expands it in place. */
function Run({ events, open, onToggle, state }: { events: LoomEvent[]; open: boolean; onToggle: () => void; state: SessionState }) {
  const [lead, ...rest] = runSummary(events);
  return (
    <>
      <div class="sysrow sysrow-run">
        <Chevron open={open} />
        <span class="sys-line">
          <span class="sys-text"><strong>{lead}</strong>{rest.map((r) => ` · ${r}`).join("")}</span>
          {" · "}<time class="mono" dateTime={events[0]!.at}>{timeRange(events)}</time>
        </span>
        <button type="button" class="link sys-toggle" aria-expanded={open ? "true" : "false"} onClick={onToggle}>
          {open ? "Hide" : `Show ${events.length} events`}
        </button>
      </div>
      {open && events.map((e) => <SystemEvent key={e.seq} e={e} state={state} />)}
    </>
  );
}

/** What the stream says while it is not live: the header's pill says it too, this says it in place. */
function ConnectionRow({ connection }: { connection: "reconnecting" | "closed" }) {
  const reconnecting = connection === "reconnecting";
  return (
    <div class="sysrow sysrow-conn">
      <span class={`conn-row-dot ${reconnecting ? "warn" : "danger"}`} aria-hidden="true" />
      <span>{reconnecting ? "Connection lost. Reconnecting…" : "Disconnected."}</span>
    </div>
  );
}

export function MessageList({ state, fold }: {
  state: SessionState;
  /** Whether runs of system events are folded: the thread header's checkbox, held by `WeaveView`. */
  fold: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  // Which runs the human expanded, by the run's key (its first event's seq), so a run that grows
  // while it is open stays open. UI state only.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const events = state.events.filter((e) => e.threadId === state.currentThreadId);
  const lost = state.connection === "reconnecting" || state.connection === "closed" ? state.connection : null;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [events.length, state.currentThreadId, lost]);
  const toggle = (key: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div class="messages">
      {foldStream(events, fold).map((item) =>
        item.kind === "message" ? <Message key={item.key} e={item.event} state={state} />
        : item.kind === "system" ? <SystemEvent key={item.key} e={item.event} state={state} />
        : <Run key={item.key} events={item.events} open={expanded.has(item.key)} onToggle={() => toggle(item.key)} state={state} />)}
      {lost && <ConnectionRow connection={lost} />}
      <div ref={bottom} />
    </div>
  );
}
