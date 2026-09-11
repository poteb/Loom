import type { Session, SessionState } from "../session.js";

export function Header({ state, session }: { state: SessionState; session: Session }) {
  const archived = !!state.weave?.archivedAt;
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
          <button class="danger" onClick={() => { if (confirm("Archive this Weave? It becomes read-only.")) void session.archive(); }}>Archive Weave</button>
        )}
      </div>
    </header>
  );
}
