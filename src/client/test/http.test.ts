import { describe, it, expect } from "vitest";
import { request } from "../src/http.js";

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

  it("returns the raw body when accept is text", async () => {
    const res = new Response("plain text body", { status: 200 });
    await expect(
      request({ method: "GET", url: "http://x", fetchImpl: fakeFetch(res), accept: "text" }),
    ).resolves.toBe("plain text body");
  });
});
