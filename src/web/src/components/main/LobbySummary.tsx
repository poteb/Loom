import { useEffect, useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import type { KeyValueStorage } from "../../storage.js";
import { hasIdentity, readWeaveEntry } from "../../weaves-store.js";

/** The server's own page maximum, as the session asks for it. `listRequests` has no count and no
 *  cursor, so one bounded page *is* the count (spec §4.4, and the KNOWN-ISSUES row behind it). */
const PAGE = 1000;

/** `listeners` is optional because its own read is allowed to fail on its own: absent means the
 *  line is not rendered at all, never that the Lobby holds none (spec §5.1). */
type Counts = { participants: number; listeners?: number; open: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the Lobby is, and — only for a browser that already holds a Lobby token — how busy it is
 * (spec §4.4).
 *
 * The line this component exists to hold: **no new public read**. `GET /api/lobby` gives the title
 * anonymously and that is all an unjoined visitor sees; the three counts come from `getWeave`,
 * `listRequests` and `listListeners` — all three behind `assertCanRead`, and all three asked for
 * with the **stored participant token** or not at all. The third is caught on its own so its
 * failure costs only its own line, which changes what is shown and not who may see it. A stored
 * *secret* is deliberately not used here either — the Lobby's secret belongs to an instance keeper,
 * and this section is not the place to spend one.
 *
 * The pointer itself is the page's cell, not this one's: `lobby` is the answer, `error` is what went
 * wrong reading it, and `noLobby` is the instance saying it has none — which is an answer rather than
 * a failure, and is worded and coloured as one.
 */
export function LobbySummary({ client, storage, lobby, error, noLobby }: {
  client: LoomClient; storage: KeyValueStorage;
  lobby?: { weaveId: string; title: string };
  /** A failed *read* of the pointer, in the server's own words. */
  error?: string;
  /** The instance's own answer — it has no Lobby yet. Not an error, and not coloured as one. */
  noLobby?: boolean;
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
    // The same three reads the Lobby page itself makes, and all of them bounded.
    Promise.all([
      reader.getWeave(weaveId),
      reader.listRequests("open", { limit: PAGE }),
      // A "listener" is a participant carrying a capability profile. `getWeave` no longer carries
      // profiles for the Lobby (spec §3.1), so the count comes from the directory query itself —
      // one `count(*)`, no rows, no facet pass.
      //
      // **Its own failure costs only its own line.** Inside the `Promise.all` it would reject the
      // whole tuple, and the two counts this section has always shown would disappear behind one
      // error line — the opposite of the rule next door (a cell with a credential and no answer yet
      // is loading, not empty) and of the state the same failure leaves the Lobby's own sidebar in.
      // Nothing is hidden by catching it: all three reads use the same stored token, so a dead one
      // is still reported by `getWeave` rejecting, exactly as it is today.
      reader.listListeners({ limit: 0, facets: false }).then((p) => p.total, () => undefined),
    ]).then(
      ([info, open, listeners]) => {
        if (!live) return;
        setCounts({ participants: info.participants.length, listeners, open: open.length });
      },
      (e: unknown) => { if (live) setCountsError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
  }, [client, weaveId, token]);

  return (
    <section class="lobby-summary">
      <h2>The Lobby</h2>
      {noLobby
        ? <p class="muted">This instance has no Lobby yet.</p>
        : error !== undefined
          ? <p class="error">{error}</p>
          : lobby === undefined
            ? <p class="muted">Loading…</p>
            : (
              <>
                <p class="lobby-summary-title">{lobby.title}</p>
                {token === undefined
                  ? <p class="muted">Every agent on this instance is here; join to see who and what is being asked for.</p>
                  // A cell with a credential and no answer yet is loading, not empty (spec §6).
                  : counts !== undefined
                    ? (
                      <ul class="lobby-counts">
                        <li>{plural(counts.participants, "participant")}</li>
                        {/* Only when it is a number: a count that failed says nothing rather than
                            claiming a zero nobody counted (spec §5.1). */}
                        {counts.listeners !== undefined && <li>{plural(counts.listeners, "listener")}</li>}
                        <li>{plural(counts.open, "open request")}</li>
                      </ul>
                    )
                    : countsError === undefined && <p class="muted">Loading…</p>}
                {countsError !== undefined && <p class="error">{countsError}</p>}
              </>
            )}
    </section>
  );
}
