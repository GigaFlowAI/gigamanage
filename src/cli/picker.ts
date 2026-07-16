/**
 * Session picker.
 *
 * fzf is used when installed — it gives fuzzy matching and a live preview pane
 * for free. When it is absent we fall back to a numbered prompt rather than
 * failing: gigamanage must work on a machine with nothing but Node.
 *
 * Rows WRAP rather than being chopped at the right edge, in both modes. In fzf
 * that needs multi-line items: records are NUL-delimited (`--read0`) so a single
 * session can span several display lines and still be selected as one thing.
 * fzf gained multi-line display in 0.46, so older versions fall back to
 * single-line rows rather than rendering one session as several bogus entries.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { shellQuote } from "../core/text.js";
import type { SessionView } from "../core/types.js";
import { formatRow, formatRowLines, terminalWidth, type InProgress } from "./format.js";

/** Fraction of the terminal the list occupies; the rest is the preview pane. */
const LIST_FRACTION = 0.45;
/** fzf's own chrome: pointer, marker, border, padding. */
const FZF_CHROME = 6;
/** First fzf release with multi-line item display. */
const MULTILINE_FZF = [0, 46, 0];

export function hasFzf(): boolean {
  return spawnSync("which", ["fzf"], { stdio: "ignore" }).status === 0;
}

/** fzf's version as [major, minor, patch], or null if it cannot be determined. */
export function fzfVersion(): number[] | null {
  const probe = spawnSync("fzf", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when this fzf can display one item across several lines. */
export function supportsMultiline(version: number[] | null): boolean {
  if (!version) return false;
  for (let i = 0; i < MULTILINE_FZF.length; i++) {
    const part = version[i] ?? 0;
    const need = MULTILINE_FZF[i] ?? 0;
    if (part > need) return true;
    if (part < need) return false;
  }
  return true;
}

/** How wide the list column is inside fzf, once the preview pane is taken out. */
export function listWidth(width: number = terminalWidth()): number {
  return Math.max(32, Math.floor(width * LIST_FRACTION) - FZF_CHROME);
}

/**
 * The records fed to fzf, NUL-delimited.
 *
 * Each record is `<session-id>\t<display>`, where `<display>` may contain
 * newlines. fzf shows fields 2.. and hands field 1 to the preview command and
 * back to us on selection, so the id never appears on screen twice and the
 * mapping back to a session survives wrapping.
 */
export function buildFzfRecords(
  views: readonly SessionView[],
  multiline: boolean,
  width: number = listWidth(),
  now: Date = new Date(),
  inProgress: InProgress = new Set(),
): string {
  return views
    .map((view) => {
      const display = multiline
        ? formatRowLines(view, now, width, inProgress).join("\n")
        : formatRow(view, now, inProgress);
      return `${view.record.sessionId}\t${display}`;
    })
    .join("\0");
}

/** A freshly loaded list, and what the worker is writing as of that moment. */
export interface PickRefresh {
  views: readonly SessionView[];
  inProgress: InProgress;
}

export interface PickOptions {
  /** argv reproducing this filter set, for fzf's reload binding. */
  reloadArgs?: readonly string[];
  /**
   * Re-load for the no-fzf path, which has no subprocess to shell out to.
   *
   * Returns the markers as well as the rows: carrying the `inProgress` set from
   * open would re-render it stale, showing `○` for a row the worker has since
   * picked up.
   */
  reload?: () => Promise<PickRefresh>;
  /** Rows the worker is writing right now, rendered `◐`. */
  inProgress?: InProgress;
}

/** Returns the chosen session, or null if the user cancelled. */
export async function pickSession(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  if (views.length === 0) return null;
  return hasFzf() ? pickWithFzf(views, options) : pickWithPrompt(views, options);
}

/**
 * How to re-invoke *this* build, as a shell command string.
 *
 * fzf runs the preview and reload commands through a shell, and they must hit
 * this build — not whatever `gm` happens to be on PATH. During development
 * there may be no `gm` on PATH at all, and both would silently render nothing.
 *
 * Returns null when argv[1] is unavailable, leaving callers to decide on a
 * fallback.
 */
function selfCommand(): string | null {
  const self = process.argv[1];
  if (!self) return null;
  return `${shellQuote(process.execPath)} ${shellQuote(self)}`;
}

/** The command fzf runs to fill its preview pane. */
function previewCommand(): string {
  const self = selfCommand();
  return self ? `${self} show {1} --no-color` : "gm show {1} --no-color";
}

/**
 * The shell command behind ctrl-r, or null when we cannot address this build.
 *
 * Without one the key is simply not bound and the header does not advertise it —
 * a key that does nothing is worse than a key that isn't there.
 */
function reloadCommand(reloadArgs: readonly string[] | undefined): string | null {
  const self = selfCommand();
  if (!self || !reloadArgs || reloadArgs.length === 0) return null;
  return `${self} ${reloadArgs.map(shellQuote).join(" ")}`;
}

/**
 * Everything we hand fzf on the command line.
 *
 * Split out from the spawn so it is testable: pressing a key needs a terminal,
 * but the args that decide what the key *does* are just data. `reloadCmd` is
 * the already-built shell command, or null when ctrl-r cannot be offered.
 */
export function fzfArgs(multiline: boolean, preview: string, reloadCmd: string | null): string[] {
  const args = [
    "--ansi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--height=90%",
    "--layout=reverse",
    "--border",
    "--prompt=session > ",
    "--preview",
    preview,
    "--preview-window=right,55%,wrap",
    // A key that does nothing is worse than a key that isn't there, so the
    // header only advertises ctrl-r when it is actually bound.
    "--header",
    reloadCmd ? "enter: resume   ctrl-r: refresh   ctrl-c: cancel" : "enter: resume   ctrl-c: cancel",
  ];

  // ctrl-r replaces the list with a fresh one, and kicks off summaries for
  // whatever needs them. `reload` feeds on the command's stdout, so the binding
  // is just "print the records again" — see commands/picker-rows.ts.
  if (reloadCmd) args.push(`--bind=ctrl-r:reload(${reloadCmd})`);

  if (multiline) {
    // Items are NUL-delimited, so a record may contain newlines; --print0 keeps
    // the selection unambiguous on the way back out.
    args.push("--read0", "--print0", "--highlight-line");
  }

  return args;
}

async function pickWithFzf(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  const byId = new Map(views.map((v) => [v.record.sessionId, v]));
  const multiline = supportsMultiline(fzfVersion());
  const records = buildFzfRecords(views, multiline, listWidth(), new Date(), options.inProgress);
  const args = fzfArgs(multiline, previewCommand(), reloadCommand(options.reloadArgs));

  const selected = await new Promise<string | null>((resolve) => {
    const child = spawn("fzf", args, { stdio: ["pipe", "pipe", "inherit"] });

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const picked = stdout.replace(/\0+$/, "").trim();
      resolve(picked === "" ? null : picked);
    });

    child.stdin.write(records);
    child.stdin.end();
  });

  if (!selected) return null;
  const id = selected.split("\t")[0]!.trim();
  return byId.get(id) ?? null;
}

/**
 * The no-fzf fallback: a numbered list at a readline prompt.
 *
 * ctrl-r is not interceptable here, so refresh is spelled `r` — the way a
 * numbered prompt can express it.
 */
async function pickWithPrompt(
  views: readonly SessionView[],
  options: PickOptions = {},
): Promise<SessionView | null> {
  // Wrap here too: the numbered fallback is a list you have to read, so chopping
  // the description defeats the point just as badly as it does in fzf.
  const width = Math.max(40, terminalWidth() - 5);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { reload } = options;
  let current = views;
  let inProgress = options.inProgress;

  try {
    for (;;) {
      const shown = current.slice(0, 30);
      for (const [i, view] of shown.entries()) {
        const [first = "", ...rest] = formatRowLines(view, new Date(), width, inProgress);
        process.stdout.write(`${String(i + 1).padStart(3)}. ${first}\n`);
        for (const line of rest) process.stdout.write(`     ${line}\n`);
      }
      process.stdout.write("\n(install fzf for fuzzy search and previews: brew install fzf)\n");

      const hint = reload ? "number, r to refresh, or blank to cancel" : "number, or blank to cancel";
      const answer = (await rl.question(`\nresume which? [${hint}] `)).trim();

      if (reload && answer.toLowerCase() === "r") {
        ({ views: current, inProgress } = await reload());
        process.stdout.write("\n");
        continue;
      }

      const choice = Number.parseInt(answer, 10);
      if (!Number.isFinite(choice) || choice < 1 || choice > shown.length) return null;
      return shown[choice - 1] ?? null;
    }
  } finally {
    rl.close();
  }
}
