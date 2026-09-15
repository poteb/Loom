import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { request } from "../src/http.js";

/** Starts a local http server and returns its base URL plus a stop function. */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function fakeFetch(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

describe("request", () => {
  it("maps a non-JSON 200 body to a bad_response error", async () => {
    const res = new Response("not json", { status: 200 });
    await expect(request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res) })).rejects.toMatchObject({
      code: "bad_response",
      status: 200,
    });
  });

  it("maps a non-JSON error body to bad_response with the body text as message", async () => {
    const res = new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
    await expect(request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res) })).rejects.toMatchObject({
      code: "bad_response",
      status: 502,
      message: expect.stringContaining("Bad Gateway"),
    });
  });

  it("maps a fetchImpl rejecting with a string to code network", async () => {
    const fetchImpl = (async () => {
      throw "connection refused";
    }) as unknown as typeof fetch;
    await expect(request({ method: "GET", url: "http://x", fetchImpl })).rejects.toMatchObject({ code: "network" });
  });

  it("maps a res.text() rejection to code network", async () => {
    const res = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("socket hang up")),
    } as unknown as Response;
    await expect(request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res) })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("resolves undefined for a 204 response", async () => {
    const res = new Response(null, { status: 204 });
    await expect(request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res) })).resolves.toBeUndefined();
  });

  it("refuses to follow a redirect, and the redirect target never sees the request", async () => {
    // The URL policy runs once, on the URL the caller gave. A server that answers 307 with an http
    // location would otherwise get the Weave secret in the path and the body delivered in plaintext
    // by fetch's own redirect following, with no second policy check.
    const hits: string[] = [];
    const target = await listen((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    const redirector = await listen((_req, res) => { res.writeHead(307, { location: `${target.url}/api/weaves/secret/join` }); res.end(); });
    try {
      await expect(request({
        method: "POST", url: `${redirector.url}/api/weaves/secret/join`, body: { name: "Paw" },
      })).rejects.toMatchObject({ code: "network", message: expect.stringContaining("redirect") });
      expect(hits).toEqual([]);
    } finally {
      await redirector.close();
      await target.close();
    }
  });

  it("an aborted signal cancels a response whose body never ends, as code network", async () => {
    // The signal has to reach the body read, not only the connection: this server answers with
    // headers and then holds the response open forever. Without it the request would hang until
    // the socket died, which is exactly the startup stall the channel plugin has to bound.
    const stalled = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    });
    // Records that fetch itself resolved, so this case pins the *body-read* catch: if the abort
    // were caught at the fetch instead, the two branches would be indistinguishable by message.
    let headersArrived = false;
    const watched = (async (...args: Parameters<typeof fetch>) => {
      const res = await globalThis.fetch(...args);
      headersArrived = true;
      return res;
    }) as typeof fetch;
    try {
      const startedAt = Date.now();
      await expect(request({
        method: "GET", url: `${stalled.url}/api/guidelines`, fetchImpl: watched, signal: AbortSignal.timeout(100),
      })).rejects.toMatchObject({ code: "network", message: expect.stringContaining("timed out or was aborted") });
      expect(headersArrived).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      stalled.server.closeAllConnections();
      await stalled.close();
    }
  });

  it("an abort raised by the fetch itself is the same network error, not a generic transport failure", async () => {
    // The other half of the mapping: before any response exists the signal surfaces out of fetch.
    // Distinguishing it from a dead connection is what lets a caller say "we gave up" rather than
    // "the server is down" — so the message, not just the code, is asserted.
    for (const name of ["AbortError", "TimeoutError"]) {
      const fetchImpl = (async () => {
        const e = new Error("This operation was aborted");
        e.name = name;
        throw e;
      }) as unknown as typeof fetch;
      await expect(request({ method: "GET", url: "http://x", fetchImpl })).rejects.toMatchObject({
        code: "network",
        message: "Request to Loom timed out or was aborted",
      });
    }
  });

  it("returns the raw body when accept is text", async () => {
    const res = new Response("plain text body", { status: 200 });
    await expect(
      request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res), accept: "text" }),
    ).resolves.toBe("plain text body");
  });
});
