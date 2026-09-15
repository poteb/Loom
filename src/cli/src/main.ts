import { runCli } from "./cli.js";

/**
 * A `{ read() }` provider over one stream, read at most once. A stream can only be drained once —
 * a second call would attach a fresh listener set to a stream that has already ended and resolve
 * `""`, silently clearing whatever the first read set. Memoizing the promise makes every later
 * `-` argument in the same process see the same text (and the same failure).
 *
 * Still lazy: nothing is attached, and the stream is not resumed, until the first `-` asks for it,
 * so a command that never reads stdin does not wait for a terminal that will never send an EOF.
 */
export function stdinReader(stream: NodeJS.ReadableStream): { read(): Promise<string> } {
  let pending: Promise<string> | undefined;
  return {
    read: () => (pending ??= new Promise<string>((resolve, reject) => {
      let s = "";
      stream.setEncoding("utf8");
      stream.on("data", (d) => { s += d; });
      stream.on("end", () => resolve(s));
      stream.on("error", reject);
    })),
  };
}

export function main(): void {
  runCli(process.argv.slice(2), {
    stdout: process.stdout, stderr: process.stderr, env: process.env,
    stdin: stdinReader(process.stdin),
  })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)} (internal)\n`); process.exitCode = 1; });
}
