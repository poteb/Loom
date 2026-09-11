import { runCli } from "./cli.js";

export function main(): void {
  runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)} (internal)\n`); process.exitCode = 1; });
}
