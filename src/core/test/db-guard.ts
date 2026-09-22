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

/**
 * True unless `url`'s database name ends in `_test`. `freshDb()` truncates every table, so the
 * guard allow-lists the one naming convention every test database in this repository follows,
 * instead of denying the handful of real names someone happened to think of: once a live instance
 * exists on a box that also runs `spool`, "the one name we thought of" is not a guard. An
 * unparseable URL is protected, because failing closed is the only defensible direction in front of
 * a truncate. The escape hatch is unchanged: LOOM_TEST_DATABASE_URL_USER_SET still bypasses this
 * entirely when the developer or CI supplied TEST_DATABASE_URL themselves.
 */
export function isProtectedDatabase(url: string): boolean {
  return !/_test$/.test(dbName(url) ?? "");
}
