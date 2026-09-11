import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? { ok: true }, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
}

export async function toToolResult(promise: Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await promise);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (typeof err?.code === "string" && typeof err?.message === "string") return fail(err.code, err.message);
    return fail("internal", e instanceof Error ? e.message : String(e));
  }
}
