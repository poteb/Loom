import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createCore } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";
import { renderDocument } from "@loom/mcp-tools";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";

let server: ServerType; let baseUrl: string; let tickets: TicketStore;
let apiOnlyServer: ServerType; let apiOnlyUrl: string;
/** Both apps' sweep intervals, stopped with everything else at teardown. */
let stopSweeps: Array<() => void> = [];
let dist: string;
/** Any id shape the web UI would put in a link; the server never parses it. */
const WEAVE_ID = "11111111-2222-4333-8444-555555555555";

function listen(fetchHandler: (req: Request) => Response | Promise<Response>): Promise<ServerType> {
  return new Promise((resolve) => { const s = serve({ fetch: fetchHandler, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
}
function urlOf(s: ServerType): string {
  const addr = s.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), "loom-web-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Loom</title><div id=app></div>");
  writeFileSync(path.join(dist, "assets", "app.js"), "console.log('hi')");
  const core = createCore(await freshDb());
  tickets = new TicketStore();
  const withWeb = buildApp({ core, tickets, webDist: dist });
  stopSweeps.push(withWeb.stop);
  server = await listen(withWeb.app.fetch);
  baseUrl = urlOf(server);
  // A second app built from the same core but without webDist: the deployment shape where the API
  // runs on its own and the web UI is served elsewhere (or not at all).
  const apiOnly = buildApp({ core, tickets });
  stopSweeps.push(apiOnly.stop);
  apiOnlyServer = await listen(apiOnly.app.fetch);
  apiOnlyUrl = urlOf(apiOnlyServer);
});
afterAll(async () => {
  tickets.stop();
  for (const stop of stopSweeps) stop();
  stopSweeps = [];
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => apiOnlyServer.close(() => r()));
  await closeTestDb();
  rmSync(dist, { recursive: true, force: true });
});

describe("static web hosting", () => {
  it("serves index.html for /w/<secret> and assets from /assets", async () => {
    const secret = "a".repeat(43);
    const page = await fetch(`${baseUrl}/w/${secret}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<div id=app>');
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("max-age");
    expect(await asset.text()).toContain("console.log");
  });
  it("serves index.html for /w/<secret>/ with a trailing slash", async () => {
    const secret = "b".repeat(43);
    const page = await fetch(`${baseUrl}/w/${secret}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<div id=app>');
  });
  it("serves index.html for the main page, /lobby and /weave/<id>", async () => {
    for (const p of ["/", "/lobby", "/lobby/", `/weave/${WEAVE_ID}`, `/weave/${WEAVE_ID}/`]) {
      const page = await fetch(`${baseUrl}${p}`);
      expect(page.status, p).toBe(200);
      expect(page.headers.get("content-type"), p).toContain("text/html");
      expect(await page.text(), p).toContain('<div id=app>');
    }
  });
  it("serves index.html for /lobby/listeners and its trailing slash", async () => {
    for (const p of ["/lobby/listeners", "/lobby/listeners/"]) {
      const page = await fetch(`${baseUrl}${p}`);
      expect(page.status, p).toBe(200);
      expect(page.headers.get("content-type"), p).toContain("text/html");
      expect(await page.text(), p).toContain('<div id=app>');
    }
  });
  it("keeps JSON 404 for unknown routes and API errors", async () => {
    // Enumerated routes, not an SPA catch-all: a near miss of a web path — and any API path — stays
    // the API's JSON 404 rather than becoming an HTML page.
    for (const p of ["/nope", "/api/nope", "/weave", `/weave/${WEAVE_ID}/extra`, "/lobbyx",
      "/lobby/listenersx", "/lobby/listeners/extra"]) {
      const r = await fetch(`${baseUrl}${p}`);
      expect(r.status, p).toBe(404);
      expect((await r.json()).code, p).toBe("not_found");
    }
    const missing = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missing.status).toBe(404);
  });
  it("an app built without webDist serves no UI: every web path is a JSON 404", async () => {
    const secret = "c".repeat(43);
    const paths = ["/", "/lobby", "/lobby/", "/lobby/listeners", "/lobby/listeners/",
      `/weave/${WEAVE_ID}`, `/weave/${WEAVE_ID}/`, `/w/${secret}`, `/w/${secret}/`];
    for (const p of [...paths, "/assets/app.js"]) {
      const r = await fetch(`${apiOnlyUrl}${p}`);
      expect(r.status, p).toBe(404);
      expect((await r.json()).code, p).toBe("not_found");
    }
    const health = await fetch(`${apiOnlyUrl}/health`);
    expect(health.status).toBe(200);
  });
});

describe("GET /join-loom.md", () => {
  it("GET /join-loom.md is 200 with text/markdown; charset=utf-8 and max-age=300", async () => {
    const r = await fetch(`${baseUrl}/join-loom.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("max-age=300");
  });

  it("it is served without a web bundle", async () => {
    const r = await fetch(`${apiOnlyUrl}/join-loom.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(renderDocument(apiOnlyUrl));
  });

  it("it needs no credential, and a ?agent= on the URL is not reflected", async () => {
    const key = "k".repeat(43);
    const bearer = "b".repeat(43);
    const r = await fetch(`${baseUrl}/join-loom.md?agent=${key}`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain(bearer);
  });

  it("its body equals renderDocument(origin) for the request's origin", async () => {
    expect(await (await fetch(`${baseUrl}/join-loom.md`)).text()).toBe(renderDocument(baseUrl));
  });
});
