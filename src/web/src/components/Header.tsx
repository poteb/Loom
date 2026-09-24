import type { Session, SessionState } from "../session.js";
import { initials } from "./initials.js";

/** What the connection pill says for each stream state. The class carries the state itself. */
const CONNECTION_TEXT: Record<SessionState["connection"], string> = {
  open: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

/**
 * The top bar: the wordmark home, the Weave title, the connection pill, who this page is, and the
 * keepers' Archive Weave. The artboards' search box and Weave switcher are left out: neither has
 * anything behind it yet.
 */
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
  const me = state.me?.participant;
  return (
    <header class="header">
      <div class="header-left">
        {/* The wordmark is this page's way home. Before it existed, the only way back to `/` from a
            Weave was to type the address, and for a browser that persists nothing, that page load
            dropped the identity this tab was the only holder of. */}
        {openMainInPlace
          ? <button type="button" class="home-link" title="Go to the main page"
                    onClick={() => openMainInPlace()}>Loom</button>
          : <a class="home-link" href="/" title="Go to the main page">Loom</a>}
        <span class="muted header-slash" aria-hidden="true">/</span>
        <h1>{state.weave?.title ?? "Loom"}</h1>
        {archived && <span class="pill pill-closed">archived</span>}
      </div>
      <div class="header-right">
        {/* A status region, so a dropped stream is announced and not only coloured. */}
        <span class={`conn conn-${state.connection}`} role="status" title={`connection: ${state.connection}`}>
          <span class="conn-dot" aria-hidden="true" />{CONNECTION_TEXT[state.connection]}
        </span>
        {me ? (
          <span class="who">
            <span class="avatar" aria-hidden="true">{initials(me.name)}</span>
            <strong>{me.name}</strong>
            <span class="muted who-role">{me.role}</span>
          </span>
        ) : <span class="muted">reading as guest</span>}
        {session.canModerate() && (
          <button type="button" class="btn btn-ghost danger" onClick={() => void archive()}>Archive Weave</button>
        )}
      </div>
    </header>
  );
}
