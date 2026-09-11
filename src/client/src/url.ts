import { LoomClientError } from "./errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validates and normalizes a Loom base URL. Only https is accepted, except http on loopback when explicitly allowed. */
export function resolveBaseUrl(baseUrl: string, allowInsecure = false): string {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new LoomClientError("insecure_url", `Invalid Loom URL: ${baseUrl}`); }
  if (u.protocol === "http:") {
    if (!allowInsecure || !LOOPBACK.has(u.hostname)) {
      throw new LoomClientError("insecure_url", "Loom requires https (http is only allowed on localhost with LOOM_ALLOW_INSECURE=1)");
    }
  } else if (u.protocol !== "https:") {
    throw new LoomClientError("insecure_url", `Unsupported URL scheme: ${u.protocol}`);
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
