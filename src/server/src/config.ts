import { KEEPER_TOKEN_RE } from "@loom/core";

export type Config = { port: number; databaseUrl: string; keeperTokens: string[] };

const TOKEN_HELP =
  "LOOM_KEEPER_TOKENS entries must be 43-character base64url strings (32 random bytes); " +
  "generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"";

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  const keeperTokens = (env.LOOM_KEEPER_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!keeperTokens.every((t) => KEEPER_TOKEN_RE.test(t))) throw new Error(TOKEN_HELP);
  // Two keepers sharing a token cannot be told apart, and revoking one would revoke both.
  if (new Set(keeperTokens).size !== keeperTokens.length) throw new Error("LOOM_KEEPER_TOKENS contains duplicate tokens");
  return { port, databaseUrl, keeperTokens };
}
