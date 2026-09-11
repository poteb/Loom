import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createCore } from "@loom/core";
import { freshDb, closeTestDb } from "../../core/test/helpers.js";
import { buildApp } from "../src/app.js";
import { TicketStore } from "../src/tickets.js";

let server: ServerType; let baseUrl: string; let tickets: TicketStore;
beforeAll(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), "loom-web-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Loom</title><div id=app></div>");
  writeFileSync(path.join(dist, "assets", "app.js"), "console.log('hi')");
  const core = createCore(await freshDb());
  tickets = new TicketStore();
  const app = buildApp({ core, tickets, webDist: dist });
  server = await new Promise((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { tickets.stop(); await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

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
  it("keeps JSON 404 for unknown routes and API errors", async () => {
    const r = await fetch(`${baseUrl}/nope`);
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("not_found");
    const missing = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missing.status).toBe(404);
  });
});
