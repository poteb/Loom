import { useEffect, useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import type { KeyValueStorage } from "../../storage.js";
import { hasIdentity, readWeaveEntry } from "../../weaves-store.js";

/** The server's own page maximum, as the session asks for it. `listRequests` has no count and no
 *  cursor, so one bounded page *is* the count (spec §4.4, and the KNOWN-ISSUES row behind it). */
const PAGE = 1000;

type Counts = { participants: number; listeners: number; open: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the Lobby is, and — only for a browser that already holds a Lobby token — how busy it is
 * (spec §4.4).
 *
 * The line this component exists to hold: **no new public read**. `GET /api/lobby` gives the title
 * anonymously and that is all an unjoined visitor sees; the counts come from `getWeave` and
 * `listRequests`, both behind `assertCanRead`, and are asked for with the **stored participant
 * token** or not at all. A stored *secret* is deliberately not used here either — the Lobby's secret
 * belongs to an instance keeper, and this section is not the place to spend one.
 *
 * The pointer itself is the page's cell, not this one's: `lobby` is the answer and `error` is what
 * went wrong reading it, including the instance's own "there is no Lobby yet".
 */
export function LobbySummary({ client, storage, lobby, error }: {
  client: LoomClient; storage: KeyValueStorage;
  lobby?: { weaveId: string; title: string };
  error?: string;
}) {
  const [counts, setCounts] = useState<Counts | undefined>();
  const [countsError, setCountsError] = useState<string | undefined>();
  // Read on every render rather than captured once: a migration or a join that lands while this page
  // stays on screen changes the answer, and the page re-renders on the change signal (spec §4.2).
  const entry = lobby ? readWeaveEntry(storage, lobby.weaveId) : undefined;
  const token = hasIdentity(entry) ? entry.token : undefined;
  const weaveId = lobby?.weaveId;
  useEffect(() => {
    if (!weaveId || !token) return;                  // no identity: the title, and not one request
    let live = true;
    const reader = client.withToken(token);
    // The same two reads the Lobby page itself makes, and both of them bounded.
    Promise.all([reader.getWeave(weaveId), reader.listRequests("open", { limit: PAGE })]).then(
      ([info, open]) => {
        if (!live) return;
        setCounts({
          participants: info.participants.length,
          // A "listener" is a participant carrying a capability profile — an agent something can
          // actually be asked of, as against a human here to watch.
          listeners: info.participants.filter((p) => p.capabilities !== null).length,
          open: open.length,
        });
      },
      (e: unknown) => { if (live) setCountsError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
  }, [client, weaveId, token]);

  return (
    <section class="lobby-summary">
      <h2>The Lobby</h2>
      {error !== undefined
        ? <p class="error">{error}</p>
        : lobby === undefined
          ? <p class="muted">Loading…</p>
          : (
            <>
              <p class="lobby-summary-title">{lobby.title}</p>
              {token === undefined
                ? <p class="muted">Every agent on this instance is here; join to see who and what is being asked for.</p>
                : counts !== undefined && (
                  <ul class="lobby-counts">
                    <li>{plural(counts.participants, "participant")}</li>
                    <li>{plural(counts.listeners, "listener")}</li>
                    <li>{plural(counts.open, "open request")}</li>
                  </ul>
                )}
              {countsError !== undefined && <p class="error">{countsError}</p>}
            </>
          )}
    </section>
  );
}
