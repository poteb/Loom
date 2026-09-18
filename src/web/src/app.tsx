import { useState } from "preact/hooks";
import { LoomClientError, type LoomClient } from "@loom/client";
import { useSession } from "./useSession.js";
import type { KeyValueStorage } from "./storage.js";
import type { PersistenceNotice } from "./persistence.js";
import type { WeavesSignal } from "./weaves-signal.js";
import { Header } from "./components/Header.js";
import { ThreadList } from "./components/ThreadList.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";
import { NamePrompt } from "./components/NamePrompt.js";
import { InviteBanner } from "./components/InviteBanner.js";
import { GuidelinesPanel } from "./components/GuidelinesPanel.js";
import { RequestsPanel } from "./components/RequestsPanel.js";
import { ProfileCards } from "./components/ProfileCard.js";

function secretFromPath(): string | null {
  const m = /^\/w\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname);
  return m ? m[1]! : null;
}

/**
 * Everything the page is given once, at the root (`main.tsx`), and hands down: the client, the one
 * storage instance (§2.4a) and the two page-scoped companions of that instance — the persistence
 * notice (§6) and the "stored Weaves changed" signal (§4.2).
 */
export type AppDeps = {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
};

export function App(deps: AppDeps) {
  // `notice` and `weaves` are accepted here and passed to nothing yet: they are page-scoped, so they
  // must be created once at the root and owned here rather than by whichever view happens to be
  // mounted. The main page and My Weaves consume them.
  const { client, storage } = deps;
  const secret = secretFromPath();
  if (!secret) return <div class="center"><h1>Loom</h1><p>Open a Weave link: <code>/w/&lt;secret&gt;</code></p></div>;
  return <Weave secret={secret} client={client} storage={storage} />;
}

function Weave({ secret, client, storage }: { secret: string; client: LoomClient; storage: KeyValueStorage }) {
  const { session, state } = useSession({ kind: "secret", secret }, { client, storage });
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
        <aside class="sidebar">
          <ThreadList state={state} session={session} onError={reportError} />
          <GuidelinesPanel state={state} session={session} onError={reportError} />
          {/* Both render nothing away from the Lobby, so every other Weave's sidebar is unchanged. */}
          <RequestsPanel state={state} session={session} onError={reportError} />
          <ProfileCards state={state} />
        </aside>
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
