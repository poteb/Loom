import { assertPendingTransactionSafe, closeDb, createDb, migrationStatus, runMigrations } from "@loom/core";
import { loadConfig } from "./config.js";
import { logError } from "./log.js";

const USAGE = "Usage: node dist/migrate.js [--check]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  // Exit 2 is "you asked wrongly", and it happens before anything is read or connected to, so a
  // mistyped invocation can never be mistaken for a deployment failure.
  if (args.length > 1 || (args.length === 1 && !check)) { console.error(USAGE); process.exit(2); }

  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  try {
    // Throws on drift, in both forms: a journal the database disagrees with is a defect in the
    // repository and has no status to print, so nothing is printed and the exit is 1 (spec §5.2).
    const status = await migrationStatus(db);
    // The deployment gate: an offending file merged into main stops live-update.sh at its --check,
    // BEFORE the quiesce, with Loom still serving and nothing dumped (spec §4.5 banner 6).
    assertPendingTransactionSafe(status.pending);
    if (status.pending.length === 0) {
      console.log(`migrations: ${status.applied.length} applied, nothing to apply`);
      return;
    }
    console.log(`migrations: ${status.applied.length} applied`);
    // The output shape below `pending:` is a contract: live-update.sh extracts the set with
    // `sed -n '/^pending:$/,$p'`, so it is one bare tag per line and nothing follows them.
    console.log(check ? "pending:" : "applying:");
    for (const tag of status.pending) console.log(tag);
    if (check) return;
    await runMigrations(db);
    console.log(`migrations: applied ${status.pending.length} (${status.pending.join(", ")})`);
  } finally {
    // Every path, so the container exits rather than hanging on an open connection.
    await closeDb(db);
  }
}

main().catch((e) => { logError("migrate", e); process.exit(1); });
