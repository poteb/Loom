import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { startTestServer, api } from "./helpers.js";
import { TicketStore } from "../src/tickets.js";
import { statusFor } from "../src/errors.js";

let s: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => { s = await startTestServer(); });
afterAll(async () => { await s.close(); });

describe("foundation", () => {
  it("GET /health", async () => {
    const r = await api(s.baseUrl, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });
  it("unknown route returns the error shape", async () => {
    const r = await api(s.baseUrl, "GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ code: "not_found" });
  });
  it("statusFor maps every code", () => {
    expect(statusFor("validation")).toBe(400);
    expect(statusFor("invalid_token")).toBe(401);
    expect(statusFor("forbidden")).toBe(403);
    expect(statusFor("weave_not_found")).toBe(404);
    expect(statusFor("thread_not_found")).toBe(404);
    expect(statusFor("weave_archived")).toBe(409);
    expect(statusFor("thread_closed")).toBe(409);
    expect(statusFor("name_taken")).toBe(409);
    expect(statusFor("message_too_long")).toBe(413);
  });
});

describe("TicketStore", () => {
  it("issues single-use tickets that expire", async () => {
    const store = new TicketStore(50);
    const t = store.issue("cred-1");
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.redeem(t)).toBe("cred-1");
    expect(store.redeem(t)).toBeUndefined();
    const t2 = store.issue("cred-2");
    await new Promise((r) => setTimeout(r, 80));
    expect(store.redeem(t2)).toBeUndefined();
    expect(store.size()).toBe(0);
    store.stop();
  });
});
