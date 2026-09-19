/**
 * "Go to the main page", on the cards that replace a Weave (the no-credential screen, the error
 * card, the instance-has-no-Lobby card).
 *
 * The same rule as the header's wordmark, in one place so the two cannot drift: an ordinary
 * `<a href="/">` when leaving this JS context is safe, and a **button** that switches the route in
 * place when it is not (spec §3.1). The caller decides by passing `openMainInPlace` or not — it has
 * the storage, the notice and the key to ask `leavingIsSafe` with; this component only renders the
 * answer. Same words either way, so the accessible name does not depend on which browser this is.
 */
export function HomeLink({ openMainInPlace }: { openMainInPlace?: () => void }) {
  return openMainInPlace
    ? <button type="button" class="home-back" onClick={() => openMainInPlace()}>Go to the main page</button>
    : <a href="/">Go to the main page</a>;
}
