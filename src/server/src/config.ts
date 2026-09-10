export type Config = { port: number; databaseUrl: string; keeperTokens: string[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  const keeperTokens = (env.LOOM_KEEPER_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return { port, databaseUrl, keeperTokens };
}
