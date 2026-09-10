import type { Context, MiddlewareHandler } from "hono";
import { errors, type Actor, type Core } from "@loom/core";

export type Env = { Variables: { credential: string | null } };

export const bearer: MiddlewareHandler<Env> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  c.set("credential", m ? m[1]!.trim() : null);
  await next();
};

export async function requireActor(c: Context<Env>, core: Core): Promise<Actor> {
  const cred = c.get("credential");
  if (!cred) throw errors.invalidToken();
  return core.resolveCredential(cred);
}

export async function optionalActor(c: Context<Env>, core: Core): Promise<Actor | undefined> {
  const cred = c.get("credential");
  return cred ? core.resolveCredential(cred) : undefined;
}
