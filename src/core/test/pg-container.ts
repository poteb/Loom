import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** A Postgres of this suite's own, with no migrations applied. Stopped by the caller. */
export async function startPgContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer("postgres:17-alpine").withDatabase("loom_test").start();
}
