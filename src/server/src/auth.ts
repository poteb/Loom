import type { Context, MiddlewareHandler } from "hono";
import { errors, LoomError, type Actor, type Core } from "@loom/core";

export type Env = { Variables: { credential: string | null } };

export const bearer: MiddlewareHandler<Env> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  let cred = m ? m[1]!.trim() : null;
  // Remote MCP connectors often accept only a URL: the agent key may ride in ?agent= on /mcp.
  if (!cred && new URL(c.req.url).pathname === "/mcp") cred = c.req.query("agent")?.trim() || null;
  c.set("credential", cred);
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

/** Like `optionalActor`, but a credential that no longer resolves is treated as no credential at
 * all. For routes that only *link* the caller to an actor (join): clients attach their stored token
 * to every request, and a stale or revoked one must not stop them joining a Weave by its secret. */
export async function linkableActor(c: Context<Env>, core: Core): Promise<Actor | undefined> {
  try {
    return await optionalActor(c, core);
  } catch (e) {
    if (e instanceof LoomError && e.code === "invalid_token") return undefined;
    throw e;
  }
}
