/**
 * How a Thread's linked artefact is shown: the one list of rules shared by the Thread list's tag,
 * the thread header's subtitle and the details panel, so the three can never disagree about which
 * urls become links.
 */

/** Defence in depth: the server validates thread urls, but a link is only rendered for a scheme we
 *  know is safe, so a stored `javascript:`/`data:` url could never become a clickable href here. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The bare host and path of a url, short enough to sit in a narrow column. */
export function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//i, "");
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

/**
 * The short mono tag beside a Thread's name in the list: `PR <n>` for a GitHub pull request, the
 * host for any other http(s) url, and nothing for a url that is not one (it gets no link either).
 */
export function artefactTag(url: string | null): string | null {
  if (!url || !isHttpUrl(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./i, "");
  const pull = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (host.toLowerCase() === "github.com" && pull) return `PR ${pull[1]}`;
  return host || null;
}
