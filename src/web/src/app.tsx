import { useState } from "preact/hooks";
import { LoomClientError } from "@loom/client";
import { useSession } from "./useSession.js";
import { Header } from "./components/Header.js";
import { ThreadList } from "./components/ThreadList.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";
import { NamePrompt } from "./components/NamePrompt.js";

function secretFromPath(): string | null {
  const m = /^\/w\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname);
  return m ? m[1]! : null;
}

export function App() {
  const secret = secretFromPath();
  if (!secret) return <div class="center"><h1>Loom</h1><p>Open a Weave link: <code>/w/&lt;secret&gt;</code></p></div>;
  return <Weave secret={secret} />;
}

function Weave({ secret }: { secret: string }) {
  const { session, state } = useSession(secret);
  const [pending, setPending] = useState<string | null>(null);   // message waiting for a name
  const [error, setError] = useState<string | undefined>();
  const [joinError, setJoinError] = useState<string | undefined>();

  if (state.status === "loading") return <div class="center">Loading…</div>;
  if (state.status === "error") return <div class="center error"><h1>Loom</h1><p>{state.error}</p></div>;

  const send = async (text: string) => {
    setError(undefined);
    try { await session.post(text); }
    catch (e) {
      if (e instanceof LoomClientError && e.code === "no_identity") { setPending(text); return; }
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const join = async (name: string) => {
    setJoinError(undefined);
    try {
      await session.join(name);
      const text = pending; setPending(null);
      if (text) await session.post(text);
    } catch (e) { setJoinError(e instanceof Error ? e.message : String(e)); }
  };
  const archived = !!state.weave?.archivedAt;

  return (
    <div class="layout">
      <Header state={state} session={session} />
      <div class="body">
        <ThreadList state={state} session={session} />
        <div class="main">
          {archived && <div class="banner">This Weave is archived and read-only.</div>}
          <MessageList state={state} />
          {error && <div class="error-bar">{error}</div>}
          {!archived && <Composer state={state} onSend={send} />}
        </div>
      </div>
      {(pending !== null || (state.needsName && !state.me)) && (
        <NamePrompt onSubmit={join} onCancel={() => setPending(null)} error={joinError} />
      )}
    </div>
  );
}
