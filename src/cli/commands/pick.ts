import type { Command } from "commander";

import { loadViews } from "../../services/views.js";
import { pickSession } from "../picker.js";
import { dim } from "../format.js";
import { resumeSession } from "./resume.js";
import { toFilters, type LsOptions } from "./ls.js";

/**
 * The bare `gm` command: pick a recent session, then resume it.
 * This is the whole point of the tool — everything else is in service of it.
 *
 * Registered as commander's *default* command rather than as options on the root
 * program. Hanging `-n`/`-p` off the root would shadow the identically-named
 * flags on `gm ls`, so `gm ls -n 8` would silently ignore the 8.
 */
export function registerPick(program: Command): void {
  program
    .command("pick", { isDefault: true })
    .description("pick a recent session and resume it (this is what bare `gm` does)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w)")
    .option("-n, --limit <count>", "how many sessions to offer", "50")
    .option("--include-sidechains", "include subagent transcripts")
    .option("--include-automated", "include non-interactive runs (claude -p, codex exec)")
    .action(async (options: LsOptions) => {
      const views = await loadViews(toFilters(options, 50));

      if (views.length === 0) {
        process.stdout.write(
          `${dim("No sessions found. If you expected some, run `gm doctor`.")}\n`,
        );
        return;
      }

      const chosen = await pickSession(views);
      if (!chosen) {
        process.stdout.write(`${dim("Nothing selected.")}\n`);
        return;
      }
      await resumeSession(chosen.record);
    });
}
