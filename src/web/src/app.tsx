import { useState } from "preact/hooks";
import { LoomClientError } from "@loom/client";
import { useSession } from "./useSession.js";
import { Header } from "./components/Header.js";
import { ThreadList } from "./components/ThreadList.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";
import { NamePrompt } from "./components/NamePrompt.js";
import { InviteBanner } from "./components/InviteBanner.js";

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
  const [draft, setDraft] = useState<string | undefined>();      // text handed back to the composer
  const [error, setError] = useState<string | undefined>();
  const [joinError, setJoinError] = useState<string | undefined>();

  if (state.status === "loading") return <div class="center">Loading…</div>;
  if (state.status === "error") return <div class="center error"><h1>Loom</h1><p>{state.error}</p></div>;

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Every mutation funnels through here so none of them can swallow a failure or leave an unhandled
  // rejection behind: "no_identity" is not an error to display — the session has already raised
  // needsName, which opens the name prompt exactly as a blocked send does.
  const reportError = (e: unknown) => {
    if (e instanceof LoomClientError && e.code === "no_identity") return;
    setError(message(e));
  };

  const send = async (text: string) => {
    setError(undefined);
    try { await session.post(text); setDraft(undefined); }
    catch (e) {
      if (e instanceof LoomClientError && e.code === "no_identity") { setPending(text); return; }
      setError(message(e));
      throw e;
    }
  };
  const join = async (name: string) => {
    setJoinError(undefined);
    try { await session.join(name); }
    catch (e) { setJoinError(message(e)); return; }   // joinError is for join failures only
    const text = pending;
    if (text) {
      try { await session.post(text); }
      catch (e) {
        // Joined, but the message did not land: close the prompt (the name is settled) and hand the
        // text back to the composer rather than dropping what the user wrote.
        setPending(null);
        setDraft(text);
        setError(message(e));
        return;
      }
    }
    setPending(null);
    setDraft(undefined);
  };
  const dismissPrompt = () => { setPending(null); session.dismissNamePrompt(); };
  const archived = !!state.weave?.archivedAt;

  return (
    <div class="layout">
      <Header state={state} session={session} onError={reportError} />
      <div class="body">
        <ThreadList state={state} session={session} onError={reportError} />
        <div class="main">
          {archived && <div class="banner">This Weave is archived and read-only.</div>}
          {state.refreshError && <div class="warn-bar">Having trouble syncing: {state.refreshError}</div>}
          <InviteBanner state={state} session={session} />
          <MessageList state={state} />
          {error && <div class="error-bar">{error}</div>}
          {!archived && <Composer state={state} onSend={send} draft={draft} />}
        </div>
      </div>
      {(pending !== null || (state.needsName && !state.me)) && (
        <NamePrompt onSubmit={join} onCancel={dismissPrompt} error={joinError} />
      )}
    </div>
  );
}
