import type { Session, SessionState } from "../session.js";

export function Header({ state, session, onError, openMainInPlace }: {
  state: SessionState; session: Session; onError: (e: unknown) => void;
  /**
   * Set only when this page's credentials live in memory alone (spec §3.1). The way back to `/` is
   * then a **button** that switches the route here: an anchor can be middle-clicked or opened in a
   * new tab, and either is the full page load that would take the credentials with it.
   */
  openMainInPlace?: () => void;
}) {
  const archived = !!state.weave?.archivedAt;
  const archive = async () => {
    if (!confirm("Archive this Weave? It becomes read-only.")) return;
    try { await session.archive(); } catch (e) { onError(e); }
  };
  return (
    <header class="header">
      <div>
        {/* The wordmark is this page's way home. Before it existed, the only way back to `/` from a
            Weave was to type the address — and for a browser that persists nothing, that page load
            dropped the identity this tab was the only holder of. */}
        {openMainInPlace
          ? <button type="button" class="home-link" title="Go to the main page"
                    onClick={() => openMainInPlace()}>Loom</button>
          : <a class="home-link" href="/" title="Go to the main page">Loom</a>}
        <h1>{state.weave?.title ?? "Loom"}</h1>
        {archived && <span class="badge badge-archived">archived</span>}
      </div>
      <div class="header-right">
        <span class={`conn conn-${state.connection}`} title={`connection: ${state.connection}`}>{state.connection}</span>
        {state.me ? <span>you are <strong>{state.me.participant.name}</strong> ({state.me.participant.role})</span> : <span>reading as guest</span>}
        {session.canModerate() && (
          <button class="danger" onClick={() => void archive()}>Archive Weave</button>
        )}
      </div>
    </header>
  );
}
