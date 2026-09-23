/** What `publicOrigin` reads: the request URL and its headers, as a Hono context carries them. */
export type OriginSource = { req: { url: string; header: (name: string) => string | undefined } };

const HOST_RE = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * The origin a client should use to reach this Loom, for the link the agent connect instructions
 * and `/join-loom.md` print (spec §5.3). The scheme is the first value of `X-Forwarded-Proto` when
 * it is exactly http or https, else the request URL's; the host is `Host` when it looks like a
 * host, else the request URL's. Spool's Caddy sets both. A forged header changes only a link in
 * text returned to the same client that forged it, so trusting it grants nothing.
 */
export function publicOrigin(c: OriginSource): string {
  const url = new URL(c.req.url);
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim();
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  const host = c.req.header("host") ?? "";
  return `${scheme}://${HOST_RE.test(host) ? host : url.host}`;
}
