/**
 * Running a provider CLI: prompt in on stdin, text out on stdout.
 *
 * The whole vendor abstraction lives here. Both consumers — summaries and
 * `gm ask` — spawn the same way and differ only in argv and timeout, so the
 * spawn, the timeout, the kill and the stderr capture are written once.
 *
 * Errors are plain `Error`s with a readable message; callers wrap them in their
 * own typed error so the `fix` line can say something specific to what failed.
 */

import { spawn } from "node:child_process";

import { childEnv } from "./config.js";

export interface RunProviderOptions {
  timeoutMs: number;
  /**
   * Environment for the child.
   *
   * Defaults to `childEnv()` — ours plus GIGAMANAGE_CHILD=1 — because every
   * provider we spawn is an agent that may shell back into `gm`, and a nested
   * `gm` must not start a background summarize pass of its own.
   */
  env?: NodeJS.ProcessEnv;
}

export async function runProviderCommand(
  argv: readonly string[],
  prompt: string,
  options: RunProviderOptions,
): Promise<string> {
  const [binary, ...args] = argv;
  if (!binary) throw new Error("provider command is empty");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? childEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => finish(() => reject(new Error(error.message))));
    child.on("close", (code) =>
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `exited with code ${code}`));
      }),
    );

    // EPIPE: a provider that exits before reading its prompt would otherwise
    // take the whole process down with an unhandled error event, turning a
    // provider bug into a gigamanage crash.
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
