import { KEEPER_TOKEN_RE, type SeedKeepersResult } from "@loom/core";

export type Config = {
  port: number;
  host: string;
  databaseUrl: string;
  keeperTokens: string[];
  webDist: string | undefined;
};

const TOKEN_HELP =
  "LOOM_KEEPER_TOKENS entries must be 43-character base64url strings (32 random bytes); " +
  "generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"";

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  // Loopback by default so a host-run dev server is only reachable through Caddy, not directly on
  // the LAN. The Docker image overrides this to 0.0.0.0, which is safe there: the port is only on
  // the Docker network, since compose does not publish it.
  const host = env.LOOM_HOST === undefined ? "127.0.0.1" : env.LOOM_HOST;
  const keeperTokens = (env.LOOM_KEEPER_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!keeperTokens.every((t) => KEEPER_TOKEN_RE.test(t))) throw new Error(TOKEN_HELP);
  // Two keepers sharing a token cannot be told apart, and revoking one would revoke both.
  if (new Set(keeperTokens).size !== keeperTokens.length) throw new Error("LOOM_KEEPER_TOKENS contains duplicate tokens");
  const webDist = env.LOOM_WEB_DIST;
  return { port, host, databaseUrl, keeperTokens, webDist };
}

/** The boot report for one seed run: one line always, plus a warning when something needs saying. */
export type SeedingDescription = { line: string; warning?: string };

/**
 * Turns the seed counts into the line the operator reads at boot.
 *
 * The old line printed `config.keeperTokens.length` whatever happened, so a token added to `.env`
 * on a database that already had keepers was reported as "keepers seeded: 1" while nothing was
 * seeded and every admin command then failed with a bare `invalid_token` (dogfood, 2026-09-15).
 * Only counts go in here — never a token value; see `redact` in log.ts.
 */
export function describeSeeding(result: SeedKeepersResult, configuredCount: number): SeedingDescription {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const ignoredNote = result.ignored > 0
    ? ` (${plural(result.ignored, "configured entry", "configured entries")} ignored as malformed or duplicate)`
    : "";
  if (result.seeded > 0) return { line: `keepers: seeded ${result.seeded} from LOOM_KEEPER_TOKENS${ignoredNote}` };
  if (result.existing > 0) {
    if (configuredCount === 0) return { line: `keepers: ${result.existing} already present, LOOM_KEEPER_TOKENS not set` };
    return {
      line: `keepers: ${result.existing} already present, LOOM_KEEPER_TOKENS ignored (seeding only runs on an empty table; use 'loom admin keepers add' from an existing keeper, or clear the table)`,
      warning: `warning: ${plural(configuredCount, "keeper token", "keeper tokens")} configured in LOOM_KEEPER_TOKENS but not seeded — only the ${plural(result.existing, "keeper", "keepers")} already in the database can administer this instance`,
    };
  }
  if (configuredCount > 0) {
    return { line: `keepers: none seeded — every configured LOOM_KEEPER_TOKENS entry was ignored as malformed or duplicate; admin API unavailable` };
  }
  return { line: "keepers: none configured, none present — admin API unavailable until LOOM_KEEPER_TOKENS is set on an empty table" };
}
