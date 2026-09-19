import { useEffect, useState } from "preact/hooks";
import type { PersistenceNotice } from "../persistence.js";

/**
 * The one-time "storage is not persisting" notice (spec §6).
 *
 * It renders nothing until some write on this page reports `"memory"`, and exactly one bar
 * afterwards however many further writes fail — the latch lives in the notice, not here, so a join,
 * a creation, a migration and a My Weaves refresh all land on the same bar.
 *
 * The wording says what is happening in the user's terms and what to do about it. Never "quota
 * exceeded" or "localStorage unavailable": the cause is usually private browsing, blocked site data
 * or a full store, the page cannot tell which, and the advice is the same either way.
 *
 * Dismiss is offered only while the bar is on screen, which is only while the notice is degraded.
 * `dismiss()` before anything has degraded would latch "already dismissed" and swallow the one
 * notice this page gets, so the control does not exist until there is something to dismiss.
 */
export function PersistenceBar({ notice }: { notice: PersistenceNotice }) {
  // The notice is a plain page-scoped object, not a signal Preact knows about, so a subscription is
  // what turns `note("memory")` — raised from a form, a queue or a migration — into a render.
  const [, setVersion] = useState(0);
  useEffect(() => notice.subscribe(() => setVersion((n) => n + 1)), [notice]);
  if (!notice.degraded() || notice.dismissed()) return null;
  return (
    <div class="persistence-bar">
      <p>
        This browser is not saving anything for this site, so Weaves you join or create here will be
        gone when you close the tab. Copy any Weave link you want to keep, or allow this site to
        store data.
      </p>
      <button type="button" onClick={() => notice.dismiss()}>Dismiss</button>
    </div>
  );
}
