import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { closeDb, createDb, migrationStatus, migrationsFolder, runMigrations, type Db } from "@loom/core";
import { startPgContainer } from "./pg-container.js";

/**
 * Spec §11.2 cases 13 to 19 (the migrate entry as a process) and §11.3 cases 22 to 24 (the boot
 * switch as a process). Every case here spawns a BUILT entry as a child process, because the exit
 * code, the stream each line goes to and the fact that the process ends at all are the contract
 * `deploy/live-update.sh` depends on, and none of the three can be observed by calling a function.
 * The suite therefore needs `pnpm --filter @loom/server build` to have run first.
 *
 * Cases 22 to 24 are here rather than in `config.test.ts` because they are about a BOOT: `main()`
 * is not exported, and the rules are "the process refuses to start" and "the process starts and
 * serves", so they need the same spawned-entry machinery and the same dedicated container.
 *
 * **Case 19, named once and enforced everywhere:** every child is asserted to END on its own. A
 * child that has to be killed fails its case with a message saying so — `runMigrate` and
 * `runServer` both do it — because a migrate container that never exits would hang
 * `docker compose run --rm migrate`, and therefore hang the update with the deployment lock still
 * held. That is what proves `closeDb` runs on every path.
 *
 * The container is this suite's own (`./pg-container.ts`): these cases need databases with NO
 * migrations applied, and the shared global-setup one is migrated once per run by `freshDb()`.
 * Every case that needs a database gets one by `create database` off the container's admin
 * connection, named `*_test` so it would satisfy the truncate guard's allow-list if it ever met it.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATE_ENTRY = path.join(SERVER_ROOT, "dist", "migrate.js");
const MAIN_ENTRY = path.join(SERVER_ROOT, "dist", "main.js");
/** Generous: a child doing its job is done in a second or two, so this only ever catches a hang. */
const CHILD_TIMEOUT_MS = 25_000;

/** The real journal's tags, in the journal's order. Never hard-coded: the count moves. */
const JOURNAL_TAGS: readonly string[] = (
  JSON.parse(fs.readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as
    { entries: ReadonlyArray<{ tag: string }> }
).entries.map((e) => e.tag);

/**
 * The underlying postgres-js client, as a tagged template plus `unsafe`. `drizzle-orm` is not a
 * dependency of this package and adding one for four catalogue reads would be a manifest change
 * this slice does not need, so the fixtures speak to the driver core already opened. Interpolations
 * in the tagged form are bound parameters, exactly as they are through drizzle.
 */
type RawClient = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)
  & { unsafe: (query: string) => Promise<unknown[]> };
const pg = (db: Db): RawClient => db.$client as unknown as RawClient;

let container: StartedPostgreSqlContainer;
/** The container's own database, used only to `create database`. */
let admin: Db;
const openDbs: Db[] = [];
const tempFolders: string[] = [];
let dbSeq = 0;

beforeAll(async () => {
  if (!fs.existsSync(MIGRATE_ENTRY)) {
    throw new Error(`${MIGRATE_ENTRY} is missing: build the package before this suite (pnpm --filter @loom/server build)`);
  }
  container = await startPgContainer();
  admin = createDb(container.getConnectionUri());
  openDbs.push(admin);
}, 180_000);

afterAll(async () => {
  for (const db of openDbs) await closeDb(db);
  await container?.stop();
  for (const dir of tempFolders) fs.rmSync(dir, { recursive: true, force: true });
});

/** A database of this container's own with nothing applied to it, and the URL that reaches it. */
async function freshDatabase(label: string): Promise<{ db: Db; url: string }> {
  const name = `${label}${++dbSeq}_test`;
  await pg(admin).unsafe(`create database "${name}"`);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  openDbs.push(db);
  return { db, url: url.toString() };
}

/**
 * The child's environment: the parent's, with every variable these entries read stripped, then the
 * case's own applied. `undefined` means "not set", which is exactly what case 17 needs on a machine
 * where the developer has a `DATABASE_URL` of their own exported.
 */
function childEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["DATABASE_URL", "PORT", "LOOM_HOST", "LOOM_KEEPER_TOKENS", "LOOM_WEB_DIST", "LOOM_MIGRATE_ON_BOOT"]) {
    delete base[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  return base;
}

/**
 * Runs the built entry and captures both streams and the exit code. Rejects only if it never ends
 * (case 19).
 */
async function runMigrate(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [MIGRATE_ENTRY, ...args], {
    cwd: SERVER_ROOT, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { stdout += d; });
  child.stderr.on("data", (d: string) => { stderr += d; });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);
  if (killed) {
    throw new Error(
      `migrate.js ${args.join(" ")} had to be killed after ${CHILD_TIMEOUT_MS}ms: it never exited. ` +
      "A migrate container that does not end hangs `docker compose run --rm migrate` and therefore " +
      "hangs the update with the deployment lock held (spec 11.2 case 19).");
  }
  return { code, stdout, stderr };
}

/** Captured stdout as lines: CR dropped, the trailing newline dropped, interior blanks KEPT. */
function lines(stdout: string): string[] {
  const text = stdout.replace(/\r/g, "").replace(/\n$/, "");
  return text === "" ? [] : text.split("\n");
}

/**
 * A database migrated to the journal's first `count` entries, genuinely: the prefix is APPLIED, not
 * simulated. The first `count` `.sql` files and a journal truncated to the same `count` entries are
 * copied into a temporary folder and applied with core's own `runMigrations`, so the schema, the
 * rows, drizzle's `created_at` and drizzle's `hash` are all exactly what an earlier deployment left
 * behind — and the REAL folder is then exactly `entries.length - count` migrations ahead, which is
 * what the entry under test has to apply. The files are COPIED rather than rewritten because the
 * hash drizzle records is a digest of the file's bytes and the `created_at` it records is the
 * journal entry's `when`: copy both and the rows left behind are an exact prefix of the REAL
 * journal, which is the only thing that makes the last migration pending rather than the whole
 * database drifted.
 *
 * Returns the tags that are pending against the real folder.
 */
async function migrateToPrefix(db: Db, count: number): Promise<string[]> {
  const real = migrationsFolder();
  const journal = JSON.parse(fs.readFileSync(path.join(real, "meta", "_journal.json"), "utf8")) as {
    version: string; dialect: string;
    entries: ReadonlyArray<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const kept = journal.entries.slice(0, count);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prefix-"));
  tempFolders.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) fs.copyFileSync(path.join(real, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  await runMigrations(db, dir);
  return journal.entries.slice(count).map((e) => e.tag);
}

async function regclass(db: Db, name: string): Promise<string | null> {
  const rows = await pg(db)`select to_regclass(${name}) as present`;
  return (rows as Array<{ present: string | null }>)[0]?.present ?? null;
}

async function migrationRowCount(db: Db): Promise<number> {
  const rows = await pg(db)`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return (rows as Array<{ n: number }>)[0]!.n;
}

/** Deletes one `__drizzle_migrations` row by its position in `created_at` order. */
async function deleteMigrationRow(db: Db, offset: number): Promise<void> {
  await pg(db)`
    delete from drizzle.__drizzle_migrations
    where created_at = (select created_at from drizzle.__drizzle_migrations order by created_at asc offset ${offset} limit 1)`;
}

/**
 * Git for Windows' bash rather than `C:/Windows/System32/bash.exe`, which is the WSL launcher and
 * so a different machine with a different filesystem. On a Linux runner plain `bash` is right.
 */
function bashCommand(): string {
  if (process.platform !== "win32") return "bash";
  for (const candidate of ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "bash";
}

/**
 * Spec §4.5's `pending_tags`, transcribed verbatim and run the way the deployment script runs it:
 * a captured stdout in a file, the function over it, under `bash -o pipefail -e`.
 */
const PENDING_TAGS_SH = `pending_tags() { sed -n '/^pending:$/,$p' "$1" | sed '1d;s/^[[:space:]]*//;/^$/d' | LC_ALL=C sort; }
pending_tags "$1"
`;

let captureSeq = 0;

async function pendingTags(captured: string): Promise<{ code: number | null; stdout: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-capture-"));
  tempFolders.push(dir);
  const file = path.join(dir, `migrate-${++captureSeq}.out`);
  fs.writeFileSync(file, captured);
  // Forward slashes: Git for Windows' sed reads a `D:/…` path, and nothing here has to translate.
  const child = spawn(bashCommand(), ["-o", "pipefail", "-e", "-c", PENDING_TAGS_SH, "pending_tags", file.replace(/\\/g, "/")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { stdout += d; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c));
  });
  return { code, stdout };
}

describe("the migrate entry as a process", () => {
  it("prints the applied count and applies nothing when the database is up to date", async () => {
    const { db, url } = await freshDatabase("uptodate");
    await runMigrations(db);
    const run = await runMigrate([], { DATABASE_URL: url });
    expect(run.stderr).toBe("");
    expect(lines(run.stdout)).toEqual([`migrations: ${JOURNAL_TAGS.length} applied, nothing to apply`]);
    expect(run.code).toBe(0);
  }, 60_000);

  it("lists what it is applying, applies it, and says what it applied", async () => {
    const { db, url } = await freshDatabase("applying");
    const pending = await migrateToPrefix(db, JOURNAL_TAGS.length - 1);
    const run = await runMigrate([], { DATABASE_URL: url });
    expect(run.stderr).toBe("");
    // The four contract lines, in order and with the tags immediately below `applying:`. Not whole-
    // stdout equality, and the reason is worth knowing: postgres-js's default notice handler is
    // `console.log`, so on a database that already carries drizzle's bookkeeping schema the
    // driver prints two `NOTICE … already exists, skipping` objects while `migrate()` runs — on
    // every boot of the server too, today, long before this entry existed. They land between the
    // tags and the summary and touch no parse contract: what `live-update.sh` parses is the
    // `--check` form, which never calls `migrate()` and whose stdout the next case pins exactly.
    const out = lines(run.stdout);
    const marker = out.indexOf("applying:");
    expect(out.slice(0, marker)).toEqual([`migrations: ${JOURNAL_TAGS.length - pending.length} applied`]);
    expect(out.slice(marker + 1, marker + 1 + pending.length)).toEqual(pending);
    expect(out[out.length - 1]).toBe(`migrations: applied ${pending.length} (${pending.join(", ")})`);
    expect(run.code).toBe(0);
    const after = await migrationStatus(db);
    expect(after.pending).toEqual([]);
    expect(after.applied).toEqual(JOURNAL_TAGS);
    // The pending migration really ran, rather than the entry merely printing that it had.
    expect(await regclass(db, "public.participants_capabilities_idx")).not.toBeNull();
  }, 60_000);

  it("--check lists the pending set in the shape live-update.sh parses, applies nothing, and exits 0", async () => {
    const { db, url } = await freshDatabase("check");
    const pending = await migrateToPrefix(db, JOURNAL_TAGS.length - 1);
    const rowsBefore = await migrationRowCount(db);
    const indexBefore = await regclass(db, "public.participants_capabilities_idx");

    const withPending = await runMigrate(["--check"], { DATABASE_URL: url });
    expect(withPending.stderr).toBe("");
    expect(withPending.code).toBe(0);
    const out = lines(withPending.stdout);
    // The shape, not just the words: exactly one `pending:` line, bare tags after it, nothing else.
    expect(out.filter((l) => l === "pending:")).toHaveLength(1);
    const marker = out.indexOf("pending:");
    expect(out.slice(marker + 1)).toEqual(pending);
    expect(out.slice(0, marker)).toEqual([`migrations: ${JOURNAL_TAGS.length - pending.length} applied`]);
    // It applied nothing: the table and the schema are exactly as it found them.
    expect(await migrationRowCount(db)).toBe(rowsBefore);
    expect(await regclass(db, "public.participants_capabilities_idx")).toBe(indexBefore);

    const { db: upToDate, url: upToDateUrl } = await freshDatabase("checkclean");
    await runMigrations(upToDate);
    const nothingPending = await runMigrate(["--check"], { DATABASE_URL: upToDateUrl });
    expect(nothingPending.stderr).toBe("");
    expect(nothingPending.code).toBe(0);
    expect(lines(nothingPending.stdout)).toEqual([`migrations: ${JOURNAL_TAGS.length} applied, nothing to apply`]);

    // And the extraction itself, in both directions: an empty pending set must print nothing and
    // still exit 0, because an extraction that fails there stops the update with nothing wrong.
    const extracted = await pendingTags(withPending.stdout);
    expect(extracted.code).toBe(0);
    expect(lines(extracted.stdout)).toEqual([...pending].sort());
    const extractedEmpty = await pendingTags(nothingPending.stdout);
    expect(extractedEmpty.code).toBe(0);
    expect(extractedEmpty.stdout).toBe("");
  }, 90_000);

  it.each([["--wat"], ["--check", "--check"]])(
    "exits 2 on an argument it does not know, before anything is read or connected to: %j", async (...args) => {
      // The DATABASE_URL below reaches nothing, so exit 2 rather than 1 is itself the assertion that
      // no connection was attempted: a mistyped invocation is distinguishable from a failure.
      const run = await runMigrate(args, { DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/none" });
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: node dist/migrate.js [--check]");
    }, 30_000);

  it("fails with loadConfig's own message and exits 1 when DATABASE_URL is absent", async () => {
    const run = await runMigrate([], { DATABASE_URL: undefined });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("DATABASE_URL is required");
  }, 30_000);

  it.each([{ label: "the applying form", args: [] as string[] }, { label: "--check", args: ["--check"] }])(
    "exits 1 and prints no status against a drifted journal ($label)", async ({ args }) => {
      const { db, url } = await freshDatabase("drifted");
      await runMigrations(db);
      // A row from the MIDDLE, so what the database holds is not a prefix of the journal at all.
      await deleteMigrationRow(db, 2);
      const run = await runMigrate(args, { DATABASE_URL: url });
      expect(run.code).toBe(1);
      // A drifted database has no honest status to print, and live-update.sh parses this stdout.
      expect(lines(run.stdout).filter((l) => /^migrations: \d+ applied/.test(l))).toEqual([]);
      expect(lines(run.stdout).filter((l) => l === "pending:")).toEqual([]);
      expect(run.stderr).toContain("not a prefix of the journal");
    }, 60_000);
});

/** A port nothing is listening on: `config.ts` refuses `PORT=0`, so it has to be chosen here. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type ServerRun = {
  outcome: "exited" | "listening";
  code: number | null;
  port: number;
  stdout: string;
  stderr: string;
  kill: () => void;
};

/**
 * Spawns the built server and settles on either its exit or its own "listening" line — whichever
 * comes first. Rejects if neither happens (case 19). Every case kills it in a `finally`, so a case
 * that fails leaves no server behind.
 */
async function runServer(env: Record<string, string | undefined>): Promise<ServerRun> {
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN_ENTRY], {
    cwd: SERVER_ROOT,
    env: childEnv({ ...env, PORT: String(port), LOOM_HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  return await new Promise<ServerRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `main.js neither exited nor reported listening within ${CHILD_TIMEOUT_MS}ms (case 19). ` +
        `stdout: ${stdout} stderr: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (stdout.includes(`loom server listening on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve({ outcome: "listening", code: null, port, stdout, stderr, kill });
      }
    });
    child.stderr.on("data", (d: string) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ outcome: "exited", code, port, stdout, stderr, kill });
    });
  });
}

describe("LOOM_MIGRATE_ON_BOOT as a boot", () => {
  it("false with migrations pending refuses to start, and applies nothing", async () => {
    const { db, url } = await freshDatabase("bootrefuse");
    await runMigrations(db);
    // The row-deletion trick is the right fixture here precisely because the refusal applies
    // nothing, so the schema change the deleted row left behind is never touched.
    await deleteMigrationRow(db, JOURNAL_TAGS.length - 1);
    const before = await migrationStatus(db);
    expect(before.pending).toEqual([JOURNAL_TAGS[JOURNAL_TAGS.length - 1]]);
    const run = await runServer({ DATABASE_URL: url, LOOM_MIGRATE_ON_BOOT: "false" });
    try {
      expect(run.outcome).toBe("exited");
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("LOOM_MIGRATE_ON_BOOT=false and 1 migration is pending");
      expect(run.stderr).toContain(before.pending[0]!);
      expect(run.stderr).toContain("node dist/migrate.js");
      const after = await migrationStatus(db);
      expect(after.pending).toEqual(before.pending);
    } finally {
      run.kill();
    }
  }, 60_000);

  it("false with nothing pending starts normally and serves", async () => {
    const { db, url } = await freshDatabase("bootclean");
    await runMigrations(db);
    const run = await runServer({ DATABASE_URL: url, LOOM_MIGRATE_ON_BOOT: "false" });
    try {
      expect(run.outcome).toBe("listening");
      const res = await fetch(`http://127.0.0.1:${run.port}/api/guidelines`);
      expect(res.status).toBe(200);
    } finally {
      run.kill();
    }
  }, 60_000);

  it("true migrates an unmigrated database at boot and serves, exactly as before", async () => {
    const { db, url } = await freshDatabase("bootmigrate");
    const run = await runServer({ DATABASE_URL: url, LOOM_MIGRATE_ON_BOOT: "true" });
    try {
      expect(run.outcome).toBe("listening");
      const res = await fetch(`http://127.0.0.1:${run.port}/api/guidelines`);
      expect(res.status).toBe(200);
      expect((await migrationStatus(db)).pending).toEqual([]);
    } finally {
      run.kill();
    }
  }, 60_000);
});
