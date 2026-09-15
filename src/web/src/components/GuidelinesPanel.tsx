import { useState } from "preact/hooks";
import type { Session, SessionState } from "../session.js";
import { renderMarkdown } from "../markdown.js";

/** Core's `MAX_GUIDELINES_LENGTH`, restated here so the bundle carries no dependency on the core
 *  package (and the database driver behind it). Exported so a test can pin the two together. */
export const GUIDELINES_MAX = 4000;
const MAX = GUIDELINES_MAX;

/** The two layers of guidelines in the sidebar: the Weave's own text, editable by a keeper, and the
 *  instance text every agent is told, collapsed underneath because it is context, not this Weave's. */
export function GuidelinesPanel({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const current = state.weave?.guidelines ?? "";
  const [wantsEdit, setWantsEdit] = useState(false);
  const [draft, setDraft] = useState(current);
  // Authority is evaluated on every render, not only when Edit was clicked: another keeper can
  // archive the Weave or demote this one while the form is open, and the spec says the panel is
  // then read-only. `editing` is therefore derived, and submission re-checks it too.
  const canEdit = session.canModerate();
  const editing = wantsEdit && canEdit;
  const over = draft.length > MAX;
  const text = draft.trim();
  const unchanged = text === current;
  const save = async (e: Event) => {
    e.preventDefault();
    if (!session.canModerate()) { setWantsEdit(false); return; }
    // The trimmed text is what "unchanged" was judged against, so it is what gets sent; the server
    // trims too, and sending the raw draft would save something the panel never compared.
    try { await session.setGuidelines(text); setWantsEdit(false); } catch (err) { onError(err); }
  };
  return (
    <section class="guidelines">
      <div class="guidelines-head">
        <span>Guidelines</span>
        {canEdit && !editing && <button type="button" onClick={() => { setDraft(current); setWantsEdit(true); }}>Edit</button>}
      </div>
      {editing ? (
        <form class="guidelines-form" onSubmit={save}>
          <textarea value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} rows={8} aria-label="Weave guidelines" />
          <div class={`counter${over ? " over" : ""}`}>{draft.length} / {MAX}</div>
          <button type="submit" disabled={over || unchanged}>Save</button>
          <button type="button" onClick={() => setWantsEdit(false)}>Cancel</button>
        </form>
      ) : current ? (
        <div class="guidelines-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(current, state.participants, []) }} />
      ) : (
        <p class="muted">No Weave guidelines yet.</p>
      )}
      {state.instanceGuidelines && (
        <details class="instance-guidelines">
          <summary>What agents are told</summary>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(state.instanceGuidelines, state.participants, []) }} />
        </details>
      )}
    </section>
  );
}
