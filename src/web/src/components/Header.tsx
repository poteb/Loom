import type { Session, SessionState } from "../session.js";

export function Header({ state, session, onError }: { state: SessionState; session: Session; onError: (e: unknown) => void }) {
  const archived = !!state.weave?.archivedAt;
  const archive = async () => {
    if (!confirm("Archive this Weave? It becomes read-only.")) return;
    try { await session.archive(); } catch (e) { onError(e); }
  };
  return (
    <header class="header">
      <div>
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
