#!/usr/bin/env node
/**
 * gigamanage — browse, search and resume agent coding sessions.
 *
 * Every read command supports `--json`. That is deliberate: gigamanage is a tool
 * for agents as much as for people, and an agent can only use what it can parse.
 */

import { Command } from "commander";

import { GigamanageError } from "../core/errors.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerGrep } from "./commands/grep.js";
import { registerIndex } from "./commands/index-cmd.js";
import { registerLs } from "./commands/ls.js";
import { registerPick } from "./commands/pick.js";
import { registerResume } from "./commands/resume.js";
import { registerShow } from "./commands/show.js";
import { registerSummarize } from "./commands/summarize.js";
import { red, dim } from "./format.js";

const program = new Command();

program
  .name("gm")
  .description("Browse, search and resume your AI coding agent sessions.")
  .version("0.1.0")
  .option("--no-color", "disable coloured output")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts()["color"] === false) process.env.NO_COLOR = "1";
  });

registerLs(program);
registerShow(program);
registerGrep(program);
registerResume(program);
registerSummarize(program);
registerIndex(program);
registerDoctor(program);
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
