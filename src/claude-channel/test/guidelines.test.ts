import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LoomClient } from "@loom/client";
import { INSTANCE_HEADING as CORE_INSTANCE_HEADING } from "@loom/core";
import { INSTANCE_HEADING, buildInstructions, fetchInstanceGuidelines } from "../src/guidelines.js";

const open: Server[] = [];
afterEach(async () => {
  // closeAllConnections() first: a stalled request holds its socket open, so close() alone never
  // calls back and the suite would hang on teardown.
  for (const s of open.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

/** Starts a throwaway HTTP server on a loopback port and returns its base URL. */
async function serving(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  open.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const clientFor = (baseUrl: string) => new LoomClient({ baseUrl, allowInsecure: true });

describe("fetchInstanceGuidelines", () => {
  it("returns the text the instance answers with", async () => {
    const log = vi.fn();
    const url = await serving((req, res) => {
      expect(req.url).toBe("/api/guidelines");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ guidelines: "x" }));
    });
    expect(await fetchInstanceGuidelines(clientFor(url), 2000, log)).toBe("x");
    expect(log).not.toHaveBeenCalled();
  });

  it("gives up at the deadline when the server accepts the request and never answers", async () => {
    const log = vi.fn();
    const url = await serving(() => { /* accepted, never answered */ });
    const t0 = Date.now();
    expect(await fetchInstanceGuidelines(clientFor(url), 2000, log)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("guidelines");
  });

  it("gives up at the deadline when the headers arrive but the body never ends", async () => {
    const log = vi.fn();
    const url = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"guidelines":"half');           // headers sent, body never finished
    });
    const t0 = Date.now();
    expect(await fetchInstanceGuidelines(clientFor(url), 500, log)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when the connection is refused", async () => {
    const log = vi.fn();
    const t0 = Date.now();
    expect(await fetchInstanceGuidelines(clientFor("http://127.0.0.1:1"), 2000, log)).toBe("");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("guidelines");
  });

  it("logs once and returns \"\" for a non-2xx answer", async () => {
    const log = vi.fn();
    const url = await serving((_req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end('{"code":"internal","message":"boom"}'); });
    expect(await fetchInstanceGuidelines(clientFor(url), 2000, log)).toBe("");
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("buildInstructions", () => {
  it("appends the instance text under the heading", () => {
    expect(buildInstructions("mechanics", "be terse")).toBe(`mechanics\n\n${INSTANCE_HEADING}\nbe terse`);
  });

  it("sends the mechanics text alone when there is no instance text", () => {
    expect(buildInstructions("mechanics", "")).toBe("mechanics");
  });

  it("uses the same heading core composes the combined text with", () => {
    // The channel keeps its own copy so its runtime does not pull @loom/core (and the database
    // driver behind it) into a plugin whose startup latency is the point of this module.
    expect(INSTANCE_HEADING).toBe(CORE_INSTANCE_HEADING);
  });
});
