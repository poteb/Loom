import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** The database `docker compose` brings up for local development. */
const COMPOSE_DATABASE_URL = "postgres://loom:loom@localhost:5432/loom";

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  if (process.env.TEST_DATABASE_URL) return;
  try {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] : "unknown error";
    console.log(`testcontainer unavailable (${why}); falling back to the compose database on localhost:5432`);
    process.env.TEST_DATABASE_URL = COMPOSE_DATABASE_URL;
  }
}

export async function teardown() {
  await container?.stop();
}
