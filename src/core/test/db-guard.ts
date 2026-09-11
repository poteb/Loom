/**
 * Database name reserved for real, non-test data. `freshDb()` truncates every table it touches,
 * so tests must never be pointed at this database.
 */
const PROTECTED_DB_NAME = "loom";

/** The database name `docker compose` gives the application database, dedicated to real data. */

function dbName(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return undefined;
  }
}

/**
 * Rewrites `composeUrl` to point at a dedicated test database (`loom_test`) on the same server,
 * keeping the host, port and credentials. Used when Testcontainers is unavailable and tests must
 * fall back to the Postgres server `docker compose` runs, without touching its application data.
 */
export function fallbackTestUrl(composeUrl: string): string {
  const u = new URL(composeUrl);
  u.pathname = "/loom_test";
  return u.toString();
}

/** True when `url`'s database name is reserved for real (non-test) data. */
export function isProtectedDatabase(url: string): boolean {
  return dbName(url) === PROTECTED_DB_NAME;
}
