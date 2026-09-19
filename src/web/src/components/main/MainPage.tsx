import { useEffect, useRef, useState } from "preact/hooks";
import { LoomClientError, type Lobby } from "@loom/client";
import type { RouteDeps } from "../../app.js";
import type { WeavesSignal } from "../../weaves-signal.js";
import { hasIdentity, migrateLegacy, readWeaveEntry, weaveKey } from "../../weaves-store.js";
import { PersistenceBar } from "../PersistenceBar.js";
import { InstanceGuidelines } from "./InstanceGuidelines.js";
import { LobbySummary } from "./LobbySummary.js";
import { JoinLobbyForm } from "./JoinLobbyForm.js";
import { MyWeaves } from "./MyWeaves.js";
import { CreateWeaveForm } from "./CreateWeaveForm.js";

/**
 * The Lobby pointer: one of the page's four independent cells (spec §6). `none` is the instance's
 * own answer — it has no Lobby yet — and is deliberately not an `error`: nothing went wrong, §4.1 is
 * simply hidden, and the summary says so in its own voice.
 */
type LobbyCell =
  | { kind: "loading" } | { kind: "lobby"; lobby: Lobby }
  | { kind: "none" } | { kind: "error"; message: string };

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
        setCell(e instanceof LoomClientError && e.code === "weave_not_found"
          ? { kind: "none" }
          : { kind: "error", message: e instanceof Error ? e.message : String(e) });
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
  // The one full-page-load helper this page owns. Most navigation here is an ordinary `<a href>`;
  // this one exists because a form has to decide *after* a write whether leaving this JS context is
  // safe at all (spec §3.1).
  const navigate = (path: string) => { location.href = path; };
  // …and the same question for the Lobby link: an identity that exists only as a pending override
  // is one full page load from gone, so that link becomes a button that opens the Lobby here. Read
  // on every render, so a later write that does persist restores the ordinary link.
  const lobbyInMemoryOnly = !!lobby && joined && storage.isPending(weaveKey(lobby.weaveId));
  const openLobby = lobby && (lobbyInMemoryOnly
    ? <button type="button" class="lobby-open-inplace" onClick={() => openInPlace(lobby.weaveId)}>Open the Lobby</button>
    : <a href="/lobby">Open the Lobby</a>);

  return (
    <div class="main-page">
      <PersistenceBar notice={notice} />
      <h1>Loom</h1>
      <InstanceGuidelines client={client} />
      <LobbySummary client={client} storage={storage} lobby={lobby}
        error={cell.kind === "error" ? cell.message : undefined} noLobby={cell.kind === "none"} />
      {lobby && (joined ? (
        joinedAs !== undefined
          ? <p class="lobby-open">You are in the Lobby as <strong>{joinedAs}</strong>. {openLobby}</p>
          : <p class="lobby-open">You are already in the Lobby. {openLobby}</p>
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
      <MyWeaves client={client} storage={storage} weaves={weaves} onWrite={notice.note}
                openInPlace={openInPlace} lobbyWeaveId={lobby?.weaveId} />
      <CreateWeaveForm client={client} storage={storage} notice={notice} weaves={weaves}
                       defaultName={joinedAs} openInPlace={openInPlace} navigate={navigate} />
    </div>
  );
}
