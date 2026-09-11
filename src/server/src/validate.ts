import type { Context } from "hono";
import { z } from "zod";
import { errors } from "@loom/core";

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => { throw errors.validation("Body is not valid JSON"); });
  const r = schema.safeParse(raw);
  if (!r.success) throw errors.validation(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export const kindSchema = z.enum(["human", "agent"]);
export const roleSchema = z.enum(["member", "keeper"]);
