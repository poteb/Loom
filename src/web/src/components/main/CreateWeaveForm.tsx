import { useState } from "preact/hooks";
import { LoomClientError, type LoomClient } from "@loom/client";
import type { KeyValueStorage } from "../../storage.js";
import type { PersistenceNotice } from "../../persistence.js";
import type { WeavesSignal } from "../../weaves-signal.js";
import { setIdentity } from "../../weaves-store.js";
import { isValidName } from "../../name.js";

/** Core's own title rule (`src/core/src/weaves.ts`), so the button says no before the server does. */
const TITLE_MAX = 200;

/**
 * What a `403` means here, and the whole reason this form is offered unconditionally: whether
 * creation is open is **not readable by the browser** (`GET /api/admin/settings` is keeper-only and
 * this spec declines to make it public), so a locked-down instance costs one round trip and says so
 * here rather than hiding the form behind a public settings read forever (spec §4.5).
 */
const CLOSED = "This instance only lets keepers create Weaves.";

/**
 * What a failed creation says. `validation` keeps the server's own words, as on the join form.
 * `forbidden` is deliberately absent: `submit` takes that answer out of the error line altogether
 * and closes the form instead, so a branch for it here would be dead.
 */
function messageFor(e: unknown): string {
  if (e instanceof LoomClientError) {
    if (e.code === "network") return "Could not reach the server.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The Weave that has just been made, and whether the entry carrying its secret actually persisted. */
type Created = { weaveId: string; title: string; secret: string; durable: boolean };

/**
 * Create a Weave, and the one moment its secret is on screen (spec §4.5).
 *
 * Two things make this form unlike the join form beside it. It **does not navigate on success** —
 * the save-this-link panel replaces the form and the main page stays up, My Weaves included — which
 * is why it takes the page's one `WeavesSignal` and bumps it: the list beside the panel has to learn
 * about the new Weave without a reload. And the panel **branches on the verdict of the one write**
 * that stored the whole entry: identity, secret, title and `lastOpenedAt` together. Splitting that
 * write would let the identity persist while the secret beside it did not — near a quota limit the
 * small write fits and the large one does not — and the panel would then relax on a verdict that was
 * never about the part that cannot be recovered.
 */
export function CreateWeaveForm({ client, storage, notice, weaves, defaultName, openInPlace, navigate }: {
  client: LoomClient; storage: KeyValueStorage; notice: PersistenceNotice; weaves: WeavesSignal;
  /** Prefills the name field when this browser already has a Lobby identity. */
  defaultName?: string;
  /** Renders the new Weave here, without touching the URL: the non-durable branch of §3.1. */
  openInPlace: (weaveId: string) => void;
  /** An ordinary full page load to `/weave/<id>`, safe only once the entry is known durable. */
  navigate: (path: string) => void;
}) {
  const [title, setTitle] = useState("");
  // `undefined` means "nothing typed yet", so a `defaultName` that only arrives once the Lobby
  // pointer has loaded still reaches an untouched field — and never overwrites a typed one.
  const [typedName, setTypedName] = useState<string | undefined>();
  const [opener, setOpener] = useState("");
  const [guidelines, setGuidelines] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [closed, setClosed] = useState(false);
  const [created, setCreated] = useState<Created | undefined>();
  /** The link has been copied or explicitly acknowledged — what unlocks a hardened dismissal. */
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"done" | "manual" | undefined>();

  const name = typedName ?? defaultName ?? "";
  const trimmed = title.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= TITLE_MAX && isValidName(name);

  const submit = async (e: Event) => {
    e.preventDefault();
    // `closed` as well as `valid`/`busy`: the Create button is gone once the instance has refused,
    // but a submit can still be raised — Enter in a field does it — and spending a round trip to be
    // told the same standing answer is exactly what the closed state exists to avoid.
    if (!valid || busy || closed) return;
    setBusy(true);
    setError(undefined);
    let done: Created | undefined;
    try {
      const r = await client.createWeave({
        title, opener, creator: { name, kind: "human" },
        // Left out entirely when nothing was typed, so a Weave is not born with an empty rule layer.
        guidelines: guidelines.trim() === "" ? undefined : guidelines,
      });
      // The complete entry in a single `set`, and its verdict is what the panel below branches on.
      // Into a variable first: nested in an optional call the write itself would not happen. A fresh
      // Weave id cannot already carry an `identity: "invalid"` marker, so `setIdentity`'s clearing of
      // it is a no-op here — it is used for the single-write guarantee, not for the marker.
      const result = setIdentity(storage, r.weave.id,
        { token: r.token, participantId: r.participant.id, name: r.participant.name },
        { secret: r.secret, title: r.weave.title, lastOpenedAt: new Date().toISOString() });
      notice.note(result);
      done = { weaveId: r.weave.id, title: r.weave.title, secret: r.secret, durable: result === "durable" };
    } catch (err) {
      // The typed values are never discarded on a failure (spec §6): only the message changes. A
      // `403` is the instance's standing answer rather than this attempt's, so it is kept apart and
      // takes the submit control away instead of inviting a retry that costs a round trip to fail.
      if (err instanceof LoomClientError && err.code === "forbidden") setClosed(true);
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
    // Outside the `try` on purpose. By here the Weave exists and its secret is stored, so an
    // exception raised while the list re-derives — a subscriber's code, not this form's — must not
    // be rendered as a failed creation and invite a second Weave. The panel goes up *first*, for the
    // same reason: it is the only place the secret is shown, and a throwing subscriber must not be
    // what keeps it off the screen.
    if (done) { setCreated(done); weaves.bump(); }
  };

  if (created) {
    const link = `${location.origin}/w/${created.secret}`;
    // A secret that reached only this tab's memory is one closed tab from an unrecoverable Weave, so
    // the panel hardens rather than softens (spec §4.5): it says why, it cannot be dismissed until
    // the link is copied or acknowledged, and it opens the Weave here instead of navigating to it —
    // a full page load would destroy the JS context that is holding the only copy of the credential.
    const hardened = !created.durable;
    const copy = () => {
      // Copy must always answer: an insecure origin has no `navigator.clipboard` at all, and a
      // clipboard that exists can refuse — by rejecting or by throwing outright. Only a copy that
      // actually happened counts as having saved the link.
      let written: Promise<void> | undefined;
      try { written = navigator.clipboard?.writeText(link); } catch { setCopied("manual"); return; }
      if (written === undefined) { setCopied("manual"); return; }
      written.then(() => { setCopied("done"); setSaved(true); }, () => setCopied("manual"));
    };
    const dismiss = () => {
      setCreated(undefined); setSaved(false); setCopied(undefined);
      setTitle(""); setOpener(""); setGuidelines("");   // the name is this browser's and stays
    };
    return (
      <section class={`create-weave create-saved${hardened ? " create-saved-hardened" : ""}`}>
        <h2>Save this link</h2>
        <p class="create-saved-title">{created.title}</p>
        <div class="create-saved-link">
          {/* The one place a freshly created secret reaches the DOM — that is this panel's whole
              purpose (§5). It is never an `href`, and never the address bar. */}
          <input class="create-link" readOnly value={link} aria-label="Link to this Weave" />
          <button type="button" class="create-copy" onClick={copy}>Copy</button>
          {copied === "done" && <span class="create-copied">Copied</span>}
          {copied === "manual" && (
            <span class="create-copied">Could not copy it for you — select the link and copy it by hand.</span>
          )}
        </div>
        <p class="create-warning">
          Anyone with this link can read the whole Weave and join it. It cannot be rotated or
          revoked — archiving the Weave is the only way to contain it.
        </p>
        {hardened && (
          <p class="create-warning create-warning-hard">
            This browser is not saving anything for this site, so this link is the only copy of it
            anywhere. Close this tab without saving it and this Weave is gone for good: Loom has no
            recovery, no rotation and no deletion.
          </p>
        )}
        <div class="create-saved-actions">
          {/* `/weave/<id>`, never `/w/<secret>`: the secret does not enter this browser's history. */}
          <button type="button" class="create-open"
            onClick={() => (created.durable ? navigate(`/weave/${created.weaveId}`) : openInPlace(created.weaveId))}>
            Open the Weave
          </button>
          {hardened && !saved && (
            <button type="button" class="create-ack" onClick={() => setSaved(true)}>I have saved this link</button>
          )}
          <button type="button" class="create-dismiss" disabled={hardened && !saved} onClick={dismiss}>Done</button>
        </div>
      </section>
    );
  }

  return (
    <section class="create-weave">
      <h2>Create a Weave</h2>
      {closed && <p class="create-closed error">{CLOSED}</p>}
      {/* Disabled, not cleared and not removed, once the instance has said no: what was typed stays
          readable (spec §6), and nothing on screen invites input this form can no longer act on. */}
      <form onSubmit={submit}>
        <label>Title <input value={title} disabled={closed} onInput={(e) => { setTitle((e.target as HTMLInputElement).value); setError(undefined); }} /></label>
        <label>Your name <input value={name} disabled={closed} onInput={(e) => { setTypedName((e.target as HTMLInputElement).value); setError(undefined); }} /></label>
        <label class="create-opener">First message
          <textarea value={opener} disabled={closed} onInput={(e) => setOpener((e.target as HTMLTextAreaElement).value)} />
        </label>
        {/* A disclosure rather than a field: a Weave's own rules are the rare case, and the form
            has to stay readable for the common one (spec §4.5). */}
        <button type="button" class="create-more" aria-expanded={more} disabled={closed} onClick={() => setMore(!more)}>More options</button>
        {more && (
          <label class="create-guidelines">Weave guidelines
            <textarea value={guidelines} disabled={closed} onInput={(e) => setGuidelines((e.target as HTMLTextAreaElement).value)} />
          </label>
        )}
        {/* Gone once the instance has said creation is restricted: the answer is about this
            instance, not this attempt, so a retry would spend a request to be told the same thing.
            Everything typed stays on screen. */}
        {!closed && <button type="submit" disabled={!valid || busy}>Create</button>}
        <p class="hint">A title of 1–200 characters; your name 1–32: letters, digits, <code>_ . -</code></p>
        {error && <p class="error">{error}</p>}
      </form>
    </section>
  );
}
