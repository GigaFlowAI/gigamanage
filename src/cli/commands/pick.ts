import type { Command } from "commander";

import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { loadViews } from "../../services/views.js";
import { listWidth, pickSession, type PickRefresh } from "../picker.js";
import { dim } from "../format.js";
import { askAboutSessions, askIsAvailable } from "./ask.js";
import { resumeSession } from "./resume.js";
import { autoSummarizeRequested, toFilters, type LsOptions } from "./ls.js";

/** The hidden command fzf's ctrl-r binding runs. Not a thing a person runs. */
export const PICKER_ROWS_COMMAND = "__picker-rows";

export interface PickerRowsOptions extends LsOptions {
  /** The parent's measured list width. The reload child's own stdout is a pipe. */
  width?: string;
}

/**
 * The filter flags this picker was opened with, as argv.
 *
 * One copy, because every command the picker spawns must describe the *same*
 * window. A filter that drifts in one of several copies is the silent
 * wrong-window bug the `pickerAskArgs` comment below exists to warn about —
 * nothing errors, the answers are just about other sessions.
 *
 * Values are NOT quoted here — the caller joins and quotes, because argv and a
 * shell command string want different escaping.
 */
export function filterArgs(options: LsOptions): string[] {
  const args: string[] = [];

  if (options.harness) args.push("--harness", options.harness);
  if (options.project) args.push("-p", options.project);
  if (options.branch) args.push("-b", options.branch);
  if (options.since) args.push("-s", options.since);
  if (options.limit) args.push("-n", options.limit);
  if (options.includeSidechains === true) args.push("--include-sidechains");
  if (options.includeAutomated === true) args.push("--include-automated");

  return args;
}

/**
 * The argv behind ctrl-o, reproducing this picker's filter set for `gm ask`.
 *
 * Pure, and separate from `pickerReloadArgs` only because the two target
 * different commands — they carry the same filters for the same reason.
 *
 * THE FILTERS ARE THE POINT. `gm ask` builds its own window; left to its
 * defaults it takes the 20 most recent sessions across every project, which for
 * `gm pick -p webshop` (or any pick past the 20th row) does not contain the
 * session you are highlighting. `--focus` then finds nothing, resolves to null,
 * and the chat answers about sessions you were not looking at — with no sign
 * anything went wrong.
 *
 * `-n` is forwarded too: the window ask reasons over should be the list you are
 * looking at, not a shorter one it chose for itself.
 *
 * `--focus {1}` is NOT added here. fzf substitutes that token, so it is appended
 * unquoted by the picker; a shell-quoted `{1}` would arrive as a literal.
 */
export function pickerAskArgs(options: LsOptions): string[] {
  return ["ask", ...filterArgs(options)];
}

/**
 * The argv that reproduces this picker's filter set, for fzf's reload binding.
 *
 * Pure, so the thing a refresh actually runs is testable without spawning fzf.
 *
 * `--width` is passed explicitly: the reload child's stdout is a pipe, so it
 * cannot measure the terminal and would fall back to a default width, reflowing
 * every row on refresh. Only the parent, inside fzf, knows the real width.
 */
export function pickerReloadArgs(
  options: LsOptions,
  width: number,
  autoSummarize = true,
): string[] {
  const args = [PICKER_ROWS_COMMAND, "--width", String(width), ...filterArgs(options)];

  // The opt-out MUST cross the process boundary. ctrl-r forces a pass — it
  // bypasses the cooldown — so a dropped flag here would spend tokens the user
  // explicitly declined, with the one thing that might have throttled it
  // removed. Commander reads a root option after the subcommand name fine.
  if (!autoSummarize) args.push("--no-auto-summarize");

  return args;
}

/**
 * Load the list and start summaries for whatever needs them.
 *
 * Both the initial paint and a refresh go through here, so `r` in the numbered
 * fallback does what ctrl-r does in fzf rather than only re-rendering stale
 * rows. `force` is set for a refresh: a keypress is an explicit request.
 */
async function refresh(
  options: LsOptions,
  enabled: boolean,
  force: boolean,
  notify?: (message: string) => void,
): Promise<PickRefresh> {
  const views = await loadViews(toFilters(options, 50));
  const started = await maybeAutoSummarize({
    records: views.map((v) => v.record),
    enabled,
    force,
    ...(notify ? { notify } : {}),
  });

  return { views, inProgress: new Set([...(await inProgressIds()), ...started.targetIds]) };
}

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
    .action(async (options: LsOptions, command: Command) => {
      const enabled = autoSummarizeRequested(command);

      // Kick the pass off over the sessions we are about to offer, exactly as
      // `ls` does — the postAction hook cannot serve the picker, because our
      // action ends in `resumeSession`, which waits on your harness. That hook
      // fires when you quit Claude Code, not when the list is drawn.
      //
      // The notice goes to stderr, which fzf does not capture, so it prints
      // before the picker paints rather than on top of it.
      const opened = await refresh(options, enabled, false, (message) =>
        process.stderr.write(`${dim(message)}\n`),
      );

      if (opened.views.length === 0) {
        process.stdout.write(
          `${dim("No sessions found. If you expected some, run `gm doctor`.")}\n`,
        );
        return;
      }

      // Ask is offered only when it would actually answer. Advertising ctrl-o to
      // someone who chose "no model calls" — or who never installed what they
      // chose — binds a key that opens a chat which dies instantly, and fzf
      // repaints the list over the explanation before it can be read. That is
      // the "key that does nothing" this file already refuses to offer.
      const canAsk = await askIsAvailable();

      const chosen = await pickSession(opened.views, {
        inProgress: opened.inProgress,
        reloadArgs: pickerReloadArgs(options, listWidth(), enabled),
        ...(canAsk ? { askArgs: pickerAskArgs(options) } : {}),
        // `a` in the numbered fallback. fzf's ctrl-o does NOT come through here:
        // it runs its own `execute` binding against this build, so the chat gets
        // a clean terminal instead of one fzf is painting.
        ...(canAsk ? { ask: () => askAboutSessions(options) } : {}),
        // `r` in the numbered fallback: forced, like the ctrl-r it stands in for.
        reload: () => refresh(options, enabled, true),
        // ctrl-r can surface a session that did not exist when we opened. Look
        // it up the way `gm resume <id>` does — naming a session explicitly
        // means you want it, even if the list filters would now hide it.
        resolve: async (id) => {
          const fresh = await loadViews({ includeSidechains: true, includeAutomated: true });
          return fresh.find((v) => v.record.sessionId === id) ?? null;
        },
      });
      if (!chosen) {
        process.stdout.write(`${dim("Nothing selected.")}\n`);
        return;
      }
      await resumeSession(chosen.record);
    });
}
