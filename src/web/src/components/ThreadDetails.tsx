import type { Participant, Thread } from "@loom/client";
import type { Session, SessionState } from "../session.js";
import { isHttpUrl, shortUrl } from "./artefact.js";
import { InviteControl, LinkForm } from "./ThreadTools.js";

/** How many people the panel lists before it folds the rest away. */
const PEOPLE_SHOWN = 8;

/** Who created a Thread, as the stream names actors: a keeper is "Keeper". */
function creatorName(thread: Thread, state: SessionState): string {
  if (thread.createdBy.startsWith("keeper:")) return "Keeper";
  return state.participants.find((p) => p.id === thread.createdBy)?.name ?? "unknown";
}

/** When a Thread was created: the time alone today, the date and time on any other day. */
function createdAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/**
 * The right-hand panel for the Thread on screen: its facts, the controls whoever may edit it has
 * (the artefact link, and for a keeper, closing it), and the Weave's people with an invite control
 * each: the Weave's, because a Thread has no membership of its own. It holds no state of its own
 * beyond the link form's draft; whether it is on screen at all is the page's.
 */
export function ThreadDetails({ thread, state, session, onError }: {
  thread: Thread; state: SessionState; session: Session; onError: (e: unknown) => void;
}) {
  const events = state.events.filter((e) => e.threadId === thread.id);
  const messages = events.filter((e) => e.type === "message").length;
  const when = createdAt(thread.createdAt);
  const canEdit = session.canEditThread(thread);
  const canClose = session.canModerate() && !thread.isGeneral && !thread.closedAt;
  const invited = state.invited[thread.id];
  const meId = state.me?.participant.id;
  // Me first, then everyone else in the order the Weave lists them; past the first few, the rest
  // wait behind a fold so a busy Lobby does not bury the panel.
  const people = [...state.participants.filter((p) => p.id === meId), ...state.participants.filter((p) => p.id !== meId)];
  const shown = people.slice(0, PEOPLE_SHOWN);
  const folded = people.slice(PEOPLE_SHOWN);
  const row = (p: Participant) => {
    const mine = p.id === meId;
    return (
      <li key={p.id}>
        <span class={`person-dot${mine ? " me" : ""}`} aria-hidden="true" />
        <span class={`person-name${p.kind === "agent" ? " mono" : ""}`}>{p.name}</span>
        {mine ? <span class="muted person-role">you · {p.role}</span>
          : p.role === "keeper" ? <span class="muted person-role">keeper</span>
          : p.kind === "agent" ? <span class="pill pill-working">agent</span>
          : null}
        {canEdit && !mine && (
          <InviteControl thread={thread} participant={p} invited={!!invited?.has(p.id)} session={session} onError={onError} />
        )}
      </li>
    );
  };
  const close = async () => {
    try { await session.closeThread(thread.id); } catch (e) { onError(e); }
  };
  return (
    <aside class="details" aria-label="Thread details">
      <section class="details-sec">
        <span class="sec">Thread</span>
        <dl class="facts">
          <dt class="muted">Status</dt>
          <dd>{thread.closedAt ? <span class="pill pill-closed">closed</span> : <span class="pill pill-open">open</span>}</dd>
          <dt class="muted">Created</dt>
          <dd>{when && <><time dateTime={thread.createdAt}>{when}</time> · </>}{creatorName(thread, state)}</dd>
          <dt class="muted">Linked artefact</dt>
          <dd>{!thread.url ? <span class="muted">none</span>
            : isHttpUrl(thread.url)
              ? <a href={thread.url} target="_blank" rel="noreferrer">{shortUrl(thread.url)}</a>
              : <span class="details-url">{thread.url}</span>}</dd>
          <dt class="muted">Messages</dt>
          <dd>{messages} · {events.length - messages} system events</dd>
        </dl>
        {canEdit && <LinkForm key={thread.id} thread={thread} session={session} onError={onError} />}
        {canClose && (
          <div class="details-actions">
            <button type="button" class="btn btn-sm" onClick={() => void close()}>Close thread</button>
          </div>
        )}
      </section>
      <section class="details-sec">
        <span class="sec">In this Weave · {state.participants.length}</span>
        <ul class="people">{shown.map(row)}</ul>
        {folded.length > 0 && (
          <details class="people-more">
            <summary>{folded.length} more</summary>
            <ul class="people">{folded.map(row)}</ul>
          </details>
        )}
      </section>
    </aside>
  );
}
