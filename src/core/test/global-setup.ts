import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { fallbackTestUrl } from "./db-guard.js";

/** The database `docker compose` brings up for local development — real, non-test data. */
const COMPOSE_DATABASE_URL = "postgres://loom:loom@localhost:5433/loom";
/** Always-present admin database on the same Postgres server, used only to create `loom_test`. */
const ADMIN_DATABASE_URL = "postgres://loom:loom@localhost:5433/postgres";
/** Postgres error code for "database already exists". */
const DUPLICATE_DATABASE = "42P04";

let container: StartedPostgreSqlContainer | undefined;

/**
 * Marker so `freshDb()` can tell a programmatically-derived `TEST_DATABASE_URL` (safe to guard)
 * from one the developer or CI set explicitly (trusted as-is, even if it looks protected).
 */
const USER_SET_FLAG = "LOOM_TEST_DATABASE_URL_USER_SET";

export async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env[USER_SET_FLAG] = "1";
    return;
  }
  try {
    // Named, because the guard now allow-lists `<name>_test` and @testcontainers/postgresql's
    // default database is `test`, which does not match — every test in the repository would refuse
    // to run. A second escape hatch for this path was considered and rejected: it would weaken the
    // guard for the case it is most often run under (spec §6). The fallback path already produces
    // `loom_test`, so after this both paths agree.
    container = await new PostgreSqlContainer("postgres:17-alpine").withDatabase("loom_test").start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] : "unknown error";
    const fallbackUrl = fallbackTestUrl(COMPOSE_DATABASE_URL);
    console.log(`testcontainer unavailable (${why}); falling back to a dedicated database on the compose server: loom_test`);
    await ensureFallbackDatabase();
    process.env.TEST_DATABASE_URL = fallbackUrl;
  }
}

/** Creates the `loom_test` database on the compose Postgres server if it does not already exist. */
async function ensureFallbackDatabase(): Promise<void> {
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    await admin.unsafe("CREATE DATABASE loom_test");
  } catch (e) {
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code !== DUPLICATE_DATABASE) throw e;
  } finally {
    await admin.end();
  }
}

export async function teardown() {
  await container?.stop();
}
