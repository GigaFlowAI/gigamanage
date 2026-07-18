/**
 * Running a provider CLI.
 *
 * The provider here is a `node -e` script, and that is not a violation of
 * non-negotiable #2: no model, no network, no money, deterministic. It is also
 * the only honest way to cover what actually breaks in this module — chunk
 * boundaries and a kill racing a live child — because both live entirely in the
 * seam between a real pipe and our decoder.
 */

import { describe, expect, it } from "vitest";

import { runProviderCommand } from "../src/services/provider-process.js";

/** A fake provider binary. The script is the whole fake; there is no other seam. */
function providerArgv(script: string): string[] {
  return [process.execPath, "-e", script];
}

/** Two stdout writes with a gap, so the pipe delivers two `data` events. */
function twoWritesArgv(first: string, second: string): string[] {
  return providerArgv(
    `process.stdout.write(Buffer.from(${JSON.stringify(first)}, "base64"));` +
      `setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify(second)}, "base64")), 50);`,
  );
}

const TIMEOUT_MS = 10_000;

describe("runProviderCommand", () => {
  it("resolves the whole buffered output with onChunk set", async () => {
    const chunks: string[] = [];
    const resolved = await runProviderCommand(
      providerArgv(`process.stdout.write("one "); setTimeout(() => process.stdout.write("two"), 30);`),
      "",
      { timeoutMs: TIMEOUT_MS, onChunk: (text) => chunks.push(text) },
    );

    // The summarize path reads the return value and nothing else. Whatever the
    // tee saw, the resolved string is still the entire output, in order.
    expect(resolved).toBe("one two");
    expect(resolved).toBe(chunks.join(""));
  });

  it("resolves the same output with no onChunk at all", async () => {
    const resolved = await runProviderCommand(providerArgv(`process.stdout.write("summary")`), "", {
      timeoutMs: TIMEOUT_MS,
    });

    expect(resolved).toBe("summary");
  });

  it("does not mangle a multi-byte character split across two chunks", async () => {
    // "landed — here" as bytes, cut at 8: the em dash's 3 bytes straddle the
    // boundary. `stdout += String(chunk)` decodes each side alone and yields ��.
    const bytes = Buffer.from("landed — here", "utf8");
    const argv = twoWritesArgv(
      bytes.subarray(0, 8).toString("base64"),
      bytes.subarray(8).toString("base64"),
    );

    const chunks: string[] = [];
    const resolved = await runProviderCommand(argv, "", {
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => chunks.push(text),
    });

    expect(resolved).toBe("landed — here");
    expect(resolved).not.toContain("�");
    // The tee must not hand out the half character either — a caller writing
    // chunks to disk would persist the mangling the return value avoided.
    expect(chunks.join("")).toBe(resolved);
    expect(chunks.some((text) => text.includes("�"))).toBe(false);
  });

  it("passes stdin through to the provider", async () => {
    const resolved = await runProviderCommand(
      providerArgv(
        `let seen = ""; process.stdin.on("data", (c) => (seen += c));` +
          `process.stdin.on("end", () => process.stdout.write(seen.toUpperCase()));`,
      ),
      "the prompt",
      { timeoutMs: TIMEOUT_MS },
    );

    expect(resolved).toBe("THE PROMPT");
  });

  it("rejects and kills the provider when the signal aborts", async () => {
    const controller = new AbortController();
    // Prints its pid, then hangs forever. A provider that outlives the abort is
    // the whole reason `signal` exists: it keeps running, and keeps billing.
    const argv = providerArgv(`process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);`);

    let pid = "";
    const run = runProviderCommand(argv, "", {
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => {
        pid += text;
        controller.abort();
      },
      signal: controller.signal,
    });

    await expect(run).rejects.toThrow("aborted");
    expect(pid).not.toBe("");
    await expect.poll(() => isAlive(Number(pid)), { timeout: 2000 }).toBe(false);
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    await expect(
      runProviderCommand(providerArgv(`process.stdout.write("ran")`), "", {
        timeoutMs: TIMEOUT_MS,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("aborted");
  });

  it("does not call onChunk after the promise settles", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const argv = providerArgv(
      `process.stdout.write("first");` +
        `setTimeout(() => process.stdout.write("second"), 50);` +
        `setInterval(() => {}, 1000);`,
    );

    const run = runProviderCommand(argv, "", {
      timeoutMs: TIMEOUT_MS,
      onChunk: (text) => {
        chunks.push(text);
        controller.abort();
      },
      signal: controller.signal,
    });

    await expect(run).rejects.toThrow("aborted");
    await new Promise((r) => setTimeout(r, 150));
    expect(chunks).toEqual(["first"]);
  });

  it("swallows a throwing onChunk", async () => {
    const resolved = await runProviderCommand(providerArgv(`process.stdout.write("output")`), "", {
      timeoutMs: TIMEOUT_MS,
      onChunk: () => {
        throw new Error("the caller's bug");
      },
    });

    expect(resolved).toBe("output");
  });

  it("still times out, kills, and reports stderr", async () => {
    await expect(
      runProviderCommand(providerArgv(`setInterval(() => {}, 1000)`), "", { timeoutMs: 100 }),
    ).rejects.toThrow("timed out after 100ms");

    await expect(
      runProviderCommand(providerArgv(`process.stderr.write("no such model"); process.exit(2);`), "", {
        timeoutMs: TIMEOUT_MS,
      }),
    ).rejects.toThrow("no such model");
  });
});

/** `kill(pid, 0)` signals nothing and throws ESRCH once the process is reaped. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
