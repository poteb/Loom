import { LoomClientError } from "./errors.js";

export type RequestOpts = {
  method: string; url: string; token?: string; body?: unknown; fetchImpl?: typeof fetch; accept?: "json" | "text";
};

/** Performs one HTTP request. Server errors become LoomClientError(code, message, status); transport failures become code "network". */
export async function request<T>(opts: RequestOpts): Promise<T> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await f(opts.url, { method: opts.method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (e) {
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
