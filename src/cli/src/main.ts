import { runCli } from "./cli.js";

export function main(): void {
  runCli(process.argv.slice(2), {
    stdout: process.stdout, stderr: process.stderr, env: process.env,
    // Read lazily and only when a `-` argument asks for it: a command that never reads stdin must
    // not resume the stream and must not wait for a terminal that will never send an EOF.
    stdin: {
      read: () => new Promise<string>((resolve, reject) => {
        let s = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (d) => { s += d; });
        process.stdin.on("end", () => resolve(s));
        process.stdin.on("error", reject);
      }),
    },
  })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)} (internal)\n`); process.exitCode = 1; });
}
