import { LoomClientError } from "./errors.js";

export type RequestOpts = {
  method: string; url: string; token?: string; body?: unknown; fetchImpl?: typeof fetch; accept?: "json" | "text";
};

/**
 * Whether a fetch rejection is the one `redirect: "error"` produces. Node surfaces it as a generic
 * `TypeError: fetch failed` whose `cause` carries "unexpected redirect", so both are inspected
 * rather than pinning one runtime's wording.
 */
function isRedirectRejection(e: unknown): boolean {
  const cause = e instanceof Error ? e.cause : undefined;
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(detail) || (e instanceof Error && /redirect/i.test(e.message));
}

/** Performs one HTTP request. Server errors become LoomClientError(code, message, status); transport failures become code "network". */
export async function request<T>(opts: RequestOpts): Promise<T> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    // `redirect: "error"` instead of fetch's default "follow": the https-only URL policy runs once,
    // on the URL the caller gave. A 307 to an http location would otherwise be followed silently,
    // putting the Weave secret in the path and the request body on the wire in plaintext, with no
    // second policy check. A redirect is a misconfigured or hostile endpoint either way, so reject.
    res = await f(opts.url, { method: opts.method, headers, redirect: "error", body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
    if (isRedirectRejection(e)) throw new LoomClientError("network", "Server redirected the request; redirects are not followed");
    throw new LoomClientError("network", `Could not reach Loom: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 204) return undefined as T;
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new LoomClientError("network", `Could not reach Loom: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    let code = "bad_response"; let message = text || res.statusText;
    try {
      const j = JSON.parse(text) as { code?: string; message?: string };
      if (typeof j.code === "string") code = j.code;
      if (typeof j.message === "string") message = j.message;
    } catch { /* non-JSON error body */ }
    throw new LoomClientError(code, message, res.status);
  }
  if (opts.accept === "text") return text as T;
  try { return JSON.parse(text) as T; } catch { throw new LoomClientError("bad_response", "Loom returned a non-JSON response", res.status); }
}
