#!/usr/bin/env node
/**
 * gigamanage — browse, search and resume agent coding sessions.
 *
 * Every read command supports `--json`. That is deliberate: gigamanage is a tool
 * for agents as much as for people, and an agent can only use what it can parse.
 */

import { createRequire } from "node:module";

import { Command } from "commander";

import { GigamanageError } from "../core/errors.js";
import { AUTO_SUMMARIZE_COMMAND, maybeAutoSummarize } from "../services/auto-summarize.js";
import { registerAutoSummarizeWorker } from "./commands/auto.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerGrep } from "./commands/grep.js";
import { registerIndex } from "./commands/index-cmd.js";
import { registerLs } from "./commands/ls.js";
import { PICKER_ROWS_COMMAND, registerPick } from "./commands/pick.js";
import { registerPickerRows } from "./commands/picker-rows.js";
import { registerResume } from "./commands/resume.js";
import { registerShow } from "./commands/show.js";
import { registerSummarize } from "./commands/summarize.js";
import { red, dim } from "./format.js";

/**
 * Read the version from package.json rather than hardcoding it.
 *
 * A hardcoded string silently drifts on every release — v0.1.1 shipped
 * reporting `0.1.0`. Resolves to the package root from both `dist/cli/` (built)
 * and `src/cli/` (via tsx).
 */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const program = new Command();

program
  .name("gm")
  .description("Browse, search and resume your AI coding agent sessions.")
  .version(version)
  .option("--no-color", "disable coloured output")
  .option("--no-auto-summarize", "do not summarize recent sessions in the background")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts()["color"] === false) process.env.NO_COLOR = "1";
  })
  /**
   * Keep the ten most recent sessions summarized — in the background, always.
   *
   * This runs in `postAction`, after the command has already written its output,
   * so `gm ls` still returns in ~60ms. The work itself is handed to a detached
   * child that outlives us (see services/auto-summarize.ts); we only decide, and
   * we tell the user on STDERR so `gm ls --json` stays machine-readable.
   *
   * The worker command is exempt, or it would spawn a copy of itself forever.
   */
  .hook("postAction", async (thisCommand, actionCommand) => {
    // `ls`, `pick` and `__picker-rows` run the pass themselves, BEFORE
    // rendering, so they can mark the rows they just kicked off with ◐.
    // Running it again here would be a wasted decision — and for `pick` a badly
    // timed one: its action ends in `resumeSession`, which waits on your
    // harness, so this hook would not fire until you quit Claude Code.
    const runsItsOwn = new Set([AUTO_SUMMARIZE_COMMAND, PICKER_ROWS_COMMAND, "ls", "pick"]);
    if (runsItsOwn.has(actionCommand.name())) return;

    await maybeAutoSummarize({
      enabled: thisCommand.opts()["autoSummarize"] !== false,
      notify: (message) => process.stderr.write(`${dim(message)}\n`),
    });
  });

registerLs(program);
registerShow(program);
registerGrep(program);
registerResume(program);
registerSummarize(program);
registerIndex(program);
registerDoctor(program);
registerAutoSummarizeWorker(program);
registerPickerRows(program);
registerPick(program); // Also the default action when `gm` is run bare.

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof GigamanageError) {
      process.stderr.write(`${red("error")} ${error.message}\n`);
      if (error.fix) process.stderr.write(`${dim("fix")}   ${error.fix}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`${red("error")} ${(error as Error).message}\n`);
    process.exit(1);
  }
}

void main();
