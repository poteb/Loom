import { useEffect, useState } from "preact/hooks";
import type { Offer, Participant, Requirements } from "@loom/client";
import type { Session, SessionState, TargetWeave } from "../session.js";
import { acceptedIds, displayStatus, type VersionedRequest } from "../requests-state.js";
import { modelSpecs } from "./ProfileCard.js";

const DEFAULT_TIMEOUT_MINUTES = 60;

/** How long an open request has left, from the clock alone — no version, no server round trip. */
export function countdown(expiresAt: string, nowMs: number): string {
  const left = Date.parse(expiresAt) - nowMs;
  if (left <= 0) return "expired";
  const seconds = Math.floor(left / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return `${seconds}s left`;
}

/** The one-line summary of what a request asks for. */
function needs(r: Requirements): string {
  const models = (r.models ?? []).map((m) => [m.model, m.effort].filter(Boolean).join("/")).join(" or ");
  const parts = [models, (r.tools ?? []).join(", "), r.runtime ?? "", r.spawnsSubagents ? "subagents" : ""];
  return parts.filter((p) => p.length > 0).join(" · ");
}

const spec = (o: Offer): string => [o.model, o.effort].filter(Boolean).join("/");

/**
 * The Lobby's requests, in the sidebar under the guidelines. Read-first: the controls appear only
 * for whoever may use them — Accept and Cancel for the requester, Offer for an eligible listener
 * whose profile this browser holds — and everyone else sees the same rows without them.
 *
 * `now` is the clock the countdown and derived expiry are read from. Left out, the panel ticks once
 * a second on its own; passed in, it is fixed and no timer is started.
 */
export function RequestsPanel({ state, session, onError, now }: {
  state: SessionState; session: Session; onError: (e: unknown) => void; now?: number;
}) {
  // The panel belongs to the Lobby's page alone; every other Weave has no requests to show — and
  // renders nothing, so the countdown must not tick there either.
  const onLobby = !!state.lobby && state.lobby.weaveId === state.weave?.id;
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined || !onLobby) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [now, onLobby]);
  const [opening, setOpening] = useState(false);
  const nowMs = now ?? tick;

  if (!onLobby) return null;

  const rows = Object.values(state.requests)
    .map((r) => ({ r, status: displayStatus(r, nowMs) }))
    .sort((a, b) => a.r.createdAt.localeCompare(b.r.createdAt));
  const open = rows.filter((x) => x.status === "open");
  const closed = rows.filter((x) => x.status !== "open");
  const title = (r: VersionedRequest) => state.threads.find((t) => t.id === r.threadId)?.name ?? "a request";

  return (
    <section class="requests">
      <div class="requests-head">
        <span>Requests</span>
        {state.me && <button type="button" onClick={() => setOpening((v) => !v)}>{opening ? "Never mind" : "Open a request"}</button>}
      </div>
      {opening && <OpenRequestForm session={session} onError={onError} onDone={() => setOpening(false)} />}
      {/* A read that failed is not an empty board: say which of the two this is. */}
      {state.requestsError !== undefined
        ? <p class="muted">Could not load requests — retrying…</p>
        : open.length === 0 && state.requestsLoaded && <p class="muted">No open requests.</p>}
      <ul class="request-list">
        {open.map(({ r }) => (
          <RequestRow key={r.id} request={r} title={title(r)} state={state} session={session} onError={onError} nowMs={nowMs} />
        ))}
      </ul>
      {closed.length > 0 && (
        <details class="closed-requests">
          <summary>Closed ({closed.length})</summary>
          {closed.length >= state.closedRequestsPage && (
            <p class="muted">Showing the newest {state.closedRequestsPage} of each closed status.</p>
          )}
          <ul>
            {closed.map(({ r, status }) => (
              <li key={r.id}>
                <span>{title(r)}</span> <span class="badge">{status}</span>
                <span class="req-count">{acceptedIds(r).length} of {r.wanted} accepted</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function RequestRow({ request, title, state, session, onError, nowMs }: {
  request: VersionedRequest; title: string; state: SessionState; session: Session; onError: (e: unknown) => void; nowMs: number;
}) {
  const me: Participant | undefined = state.me?.participant;
  const accepted = acceptedIds(request);
  const full = accepted.length >= request.wanted;
  const isRequester = !!me && me.id === request.requesterId;
  // Eligibility was decided when the request opened and is carried on the row; the profile is what
  // this browser's own participant declared, and without one there is nothing to offer with.
  const canOffer = !!me && !isRequester && (request.eligible ?? []).includes(me.id) && !!me.capabilities
    && !request.offers.some((o) => o.participantId === me.id);
  const name = (id: string) => state.participants.find((p) => p.id === id)?.name ?? "someone";

  const accept = async (participantId: string) => {
    try { await session.accept(request.id, [participantId]); } catch (e) { onError(e); }
  };
  const cancel = async () => {
    try { await session.cancel(request.id); } catch (e) { onError(e); }
  };

  return (
    <li class="request">
      <div class="request-head">
        <strong>{title}</strong>
        <span class="badge">{countdown(request.expiresAt, nowMs)}</span>
      </div>
      <div class="req-needs">{needs(request.requirements)}</div>
      <div class="req-count">{accepted.length} of {request.wanted} accepted</div>
      {request.offers.length > 0 && (
        <ul class="offers">
          {request.offers.map((o) => (
            <li key={o.participantId}>
              <span>{name(o.participantId)}{spec(o) ? ` (${spec(o)})` : ""}{o.note ? `: "${o.note}"` : ""}</span>
              {o.accepted && <span class="badge">accepted</span>}
              {isRequester && !o.accepted && (
                <button type="button" class="link" aria-label={`accept ${name(o.participantId)}`} disabled={full}
                  onClick={() => void accept(o.participantId)}>Accept</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canOffer && <OfferForm request={request} me={me!} session={session} onError={onError} />}
      {isRequester && <button type="button" class="link" onClick={() => void cancel()}>Cancel</button>}
    </li>
  );
}

/** An eligible listener answers with one of the models its own profile declares, and a note. */
function OfferForm({ request, me, session, onError }: {
  request: VersionedRequest; me: Participant; session: Session; onError: (e: unknown) => void;
}) {
  const [choice, setChoice] = useState(0);
  const [note, setNote] = useState("");
  const models = me.capabilities?.models ?? [];
  const labels = modelSpecs(me.capabilities!);
  const submit = async (e: Event) => {
    e.preventDefault();
    const m = models[choice];
    try {
      await session.offer(request.id, { model: m?.model, effort: m?.effort, note: note.trim() });
      setNote("");
    } catch (err) { onError(err); }
  };
  return (
    <form class="offer-form" onSubmit={submit}>
      <select aria-label="Model" value={String(choice)} onChange={(e) => setChoice(Number((e.target as HTMLSelectElement).value))}>
        {labels.map((label, i) => <option key={label} value={String(i)}>{label}</option>)}
      </select>
      <input value={note} placeholder="Note (optional)" maxLength={500}
        onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      <button type="submit">Offer</button>
    </form>
  );
}

type ModelRow = { model: string; effort: string };

/**
 * Opening a request from the browser. The target pickers offer the Weaves this browser holds a
 * token for, and the token of the one picked travels as `targetCredential` — the authority in the
 * Weave the helpers will be invited into, which the Lobby credential alone cannot prove.
 */
function OpenRequestForm({ session, onError, onDone }: { session: Session; onError: (e: unknown) => void; onDone: () => void }) {
  const [targets, setTargets] = useState<TargetWeave[] | undefined>();
  const [weaveId, setWeaveId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<ModelRow[]>([{ model: "", effort: "" }]);
  const [tools, setTools] = useState("");
  const [wanted, setWanted] = useState(1);
  const [minutes, setMinutes] = useState(DEFAULT_TIMEOUT_MINUTES);

  // Fetched when the form opens rather than with the panel: a browser with many stored Weaves
  // should pay for the listing only when it is about to pick one.
  useEffect(() => {
    let live = true;
    session.targets().then((found) => {
      if (!live) return;
      setTargets(found);
      setWeaveId(found[0]?.weaveId ?? "");
      setThreadId(found[0]?.threads[0]?.id ?? "");
    }).catch((e) => { if (live) onError(e); });
    return () => { live = false; };
  }, [session]);

  const picked = targets?.find((t) => t.weaveId === weaveId);
  const pickWeave = (id: string) => {
    setWeaveId(id);
    setThreadId(targets?.find((t) => t.weaveId === id)?.threads[0]?.id ?? "");
  };
  const setRow = (i: number, patch: Partial<ModelRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!picked || !threadId) return;
    const models = rows.filter((r) => r.model.trim()).map((r) => (r.effort.trim() ? { model: r.model.trim(), effort: r.effort.trim() } : { model: r.model.trim() }));
    const wants = tools.split(",").map((t) => t.trim()).filter(Boolean);
    const requirements: Requirements = { ...(models.length > 0 ? { models } : {}), ...(wants.length > 0 ? { tools: wants } : {}) };
    try {
      await session.openRequest({ title: title.trim(), requirements, wanted, timeoutMs: minutes * 60_000,
        targetWeaveId: picked.weaveId, targetThreadId: threadId, targetCredential: picked.token });
      onDone();
    } catch (err) { onError(err); }
  };

  return (
    <form class="open-request" onSubmit={submit}>
      <input value={title} placeholder="What do you need?" maxLength={100} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      {rows.map((r, i) => (
        <div class="model-row" key={i}>
          <input value={r.model} placeholder="Model" onInput={(e) => setRow(i, { model: (e.target as HTMLInputElement).value })} />
          <input value={r.effort} placeholder="Effort" onInput={(e) => setRow(i, { effort: (e.target as HTMLInputElement).value })} />
        </div>
      ))}
      <button type="button" class="link" onClick={() => setRows((rs) => [...rs, { model: "", effort: "" }])}>Add model</button>
      <input value={tools} placeholder="Tools, comma separated" onInput={(e) => setTools((e.target as HTMLInputElement).value)} />
      <label>wanted <input type="number" min={1} max={20} value={String(wanted)} onInput={(e) => setWanted(Number((e.target as HTMLInputElement).value))} /></label>
      <label>minutes <input type="number" min={1} value={String(minutes)} onInput={(e) => setMinutes(Number((e.target as HTMLInputElement).value))} /></label>
      {targets === undefined ? <p class="muted">Looking for Weaves you can invite into…</p>
        : targets.length === 0 ? <p class="muted">No Weave in this browser to invite into.</p> : (
        <>
          <select aria-label="Target Weave" value={weaveId} onChange={(e) => pickWeave((e.target as HTMLSelectElement).value)}>
            {targets.map((t) => <option key={t.weaveId} value={t.weaveId}>{t.title}</option>)}
          </select>
          <select aria-label="Target Thread" value={threadId} onChange={(e) => setThreadId((e.target as HTMLSelectElement).value)}>
            {(picked?.threads ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </>
      )}
      <button type="submit" disabled={!title.trim() || !picked || !threadId}>Open</button>
    </form>
  );
}
