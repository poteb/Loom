import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  if (process.env.TEST_DATABASE_URL) return;
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
}

export async function teardown() {
  await container?.stop();
}
