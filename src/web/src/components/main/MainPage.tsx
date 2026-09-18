import { useEffect, useRef, useState } from "preact/hooks";
import { LoomClientError, type Lobby, type LoomClient } from "@loom/client";
import type { RouteDeps } from "../../app.js";
import type { KeyValueStorage, WriteResult } from "../../storage.js";
import type { PersistenceNotice } from "../../persistence.js";
import type { WeavesSignal } from "../../weaves-signal.js";
import { hasIdentity, migrateLegacy, readWeaveEntry } from "../../weaves-store.js";
import { PersistenceBar } from "../PersistenceBar.js";
import { InstanceGuidelines } from "./InstanceGuidelines.js";
import { LobbySummary } from "./LobbySummary.js";
import { JoinLobbyForm } from "./JoinLobbyForm.js";

/** The Lobby pointer: one of the page's four independent cells (spec §6). */
type LobbyCell = { kind: "loading" } | { kind: "lobby"; lobby: Lobby } | { kind: "error"; message: string };

/** The instance's own answer — it has no Lobby — rather than a failed read. §4.1 is then hidden. */
const NO_LOBBY = "This instance has no Lobby yet.";

/**
 * The main page (spec §4): what this instance is, how to get into the Lobby, what this browser
 * already holds, and how to make a new Weave.
 *
 * Four independent async cells — the guidelines, the Lobby pointer, the Lobby counts and My Weaves —
 * each `loading → value | error`. A failure in one is a line inside that section and never blanks
 * another: the join form is usable while the rest is still loading.
 *
 * It is also the page that owns the two page-scoped companions of the one storage instance. Every
 * write made from here reports its verdict to `notice.note` — `notice.note` is the only `onWrite`
 * anywhere — so the join, the creation, the migration below and every write My Weaves makes all
 * raise the *one* bar this component renders. And every writer that can change what My Weaves shows
 * bumps `weaves`, which this page listens to as well: the Lobby entry it reads to choose between the
 * join form and "Open the Lobby" is one of the entries a migration can resolve after the first
 * paint.
 */
export function MainPage({ client, storage, notice, weaves, openInPlace }: RouteDeps & { weaves: WeavesSignal }) {
  const [cell, setCell] = useState<LobbyCell>({ kind: "loading" });
  const [, setVersion] = useState(0);
  useEffect(() => weaves.subscribe(() => setVersion((n) => n + 1)), [weaves]);

  useEffect(() => {
    let live = true;
    client.getLobby().then(
      (lobby) => { if (live) setCell({ kind: "lobby", lobby }); },
      (e: unknown) => {
        if (!live) return;
        const message = e instanceof LoomClientError && e.code === "weave_not_found"
          ? NO_LOBBY : e instanceof Error ? e.message : String(e);
        setCell({ kind: "error", message });
      },
    );
    return () => { live = false; };
  }, [client]);

  // Once per page load, not once per render: a bump re-renders My Weaves and can re-render this
  // component, and a second pass would re-walk keys the first is still writing. `onChanged` is what
  // turns a legacy row on screen into a resolved one without the human doing anything (spec §4.2).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void migrateLegacy(storage, notice, (s) => client.lookupWeave(s), () => weaves.bump());
  }, []);

  const lobby = cell.kind === "lobby" ? cell.lobby : undefined;
  const entry = lobby ? readWeaveEntry(storage, lobby.weaveId) : undefined;
  const joined = hasIdentity(entry);
  // The name this browser joined under, cached in the entry by the join itself. `undefined` for an
  // entry written before that was kept, which the greeting below is written to survive.
  const joinedAs = hasIdentity(entry) ? entry.name : undefined;
  // "Joined once, and it stopped working" is not "never joined": §4.1 shows the form for both and
  // says which of the two this is.
  const wasInvalid = entry?.identity === "invalid";
  // The one full-page-load helper this page owns. Every other navigation here is an ordinary
  // `<a href>`; this one exists because a form has to decide *after* a write whether leaving this JS
  // context is safe at all (spec §3.1).
  const navigate = (path: string) => { location.href = path; };

  return (
    <div class="main-page">
      <PersistenceBar notice={notice} />
      <h1>Loom</h1>
      <InstanceGuidelines client={client} />
      <LobbySummary client={client} storage={storage} lobby={lobby}
        error={cell.kind === "error" ? cell.message : undefined} />
      {lobby && (joined ? (
        joinedAs !== undefined
          ? <p class="lobby-open">You are in the Lobby as <strong>{joinedAs}</strong>. <a href="/lobby">Open the Lobby</a></p>
          : <p class="lobby-open">You are already in the Lobby. <a href="/lobby">Open the Lobby</a></p>
      ) : (
        <>
          {wasInvalid && <p class="muted">The identity this browser had in the Lobby stopped working — join again.</p>}
          {/* Both callbacks leave this page, which is why the form takes no `WeavesSignal`: a
              durable join can safely destroy this JS context, a non-durable one may not, because the
              credential it just wrote lives only in this page's storage instance (spec §3.1). */}
          <JoinLobbyForm client={client} storage={storage} notice={notice}
            lobby={{ weaveId: lobby.weaveId, title: lobby.title }}
            onJoined={() => navigate("/lobby")} onJoinedInPlace={openInPlace} />
        </>
      ))}
      <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={notice.note} lobbyWeaveId={lobby?.weaveId} />
      <CreateWeaveForm client={client} storage={storage} notice={notice} weaves={weaves}
                       defaultName={joinedAs} openInPlace={openInPlace} navigate={navigate} />
    </div>
  );
}

/**
 * Task 9 (§4.2) and Task 10 (§4.5) replace these two with the real components. They are headings
 * here so this page is complete on its own — and, more to the point, so the props those tasks
 * consume are already declared and handed down from the one place that owns them: the same `weaves`
 * object both of them write through, and `notice.note` as the only `onWrite` there is.
 */
function MyWeaves(_props: {
  client: LoomClient; storage: KeyValueStorage; weaves: WeavesSignal;
  onWrite: (r: WriteResult) => void; lobbyWeaveId?: string;
}) {
  return <section class="my-weaves"><h2>My Weaves</h2></section>;
}

function CreateWeaveForm(_props: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
  defaultName?: string; openInPlace: (weaveId: string) => void; navigate: (path: string) => void;
}) {
  return <section class="create-weave"><h2>Create a Weave</h2></section>;
}
