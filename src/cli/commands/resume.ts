import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command } from "commander";

import { GigamanageError } from "../../core/errors.js";
import type { SessionRecord } from "../../core/types.js";
import { adapterById } from "../../adapters/registry.js";
import { loadRecords } from "../../services/views.js";
import { resolveSession } from "../../services/resolve.js";
import { dim } from "../format.js";

/**
 * Hand control to the harness that owns this session.
 *
 * We replace this process rather than wrapping it: the user wants to be *in*
 * Claude Code or Codex, not in a gigamanage shell that proxies keystrokes.
 */
export async function resumeSession(record: SessionRecord, dryRun = false): Promise<never | void> {
  const adapter = adapterById(record.harness);
  if (!adapter) {
    throw new GigamanageError(`No adapter is registered for harness "${record.harness}".`, {
      fix: "This session was indexed by a version of gigamanage that supported more harnesses. Run `gm index --rebuild`.",
    });
  }

  const { command, args, cwd } = adapter.resumeCommand(record);

  if (!existsSync(cwd)) {
    throw new GigamanageError(`The session's directory no longer exists: ${cwd}`, {
      fix: "The repo or worktree was moved or deleted. Recreate it, or resume manually from another directory.",
      exitCode: 3,
    });
  }

  if (dryRun) {
    // Quote it: this line is meant to be pasted into a shell, and a repo path
    // with a space in it would otherwise silently run in the wrong directory.
    process.stdout.write(`cd ${shellQuote(cwd)} && ${command} ${args.map(shellQuote).join(" ")}\n`);
    return;
  }

  process.stderr.write(`${dim(`→ ${command} ${args.join(" ")}  (in ${cwd})`)}\n`);

  const child = spawn(command, args, { cwd, stdio: "inherit" });
  child.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `error  "${command}" is not on your PATH, so this session cannot be resumed.\n` +
          `fix    Install ${adapter.displayName}, or run \`gm resume ${record.sessionId.slice(0, 8)} --print\` to see the command.\n`,
      );
      process.exit(6);
    }
    process.stderr.write(`error  ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 0));
}

/** Single-quote for POSIX shells, escaping any embedded single quote. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function registerResume(program: Command): void {
  program
    .command("resume <id>")
    .description("resume a session in its original harness and directory")
    .option("--print", "print the command instead of running it")
    .action(async (id: string, options: { print?: boolean }) => {
      // As with `show`: naming a session explicitly means you want it, even if
      // `gm ls` would hide it by default.
      const records = await loadRecords({ includeSidechains: true, includeAutomated: true });
      const record = resolveSession(records, id);
      await resumeSession(record, options.print === true);
    });
}
