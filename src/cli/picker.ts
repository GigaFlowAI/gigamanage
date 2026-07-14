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

import type { SessionView } from "../core/types.js";
import { formatRow, formatRowLines, terminalWidth } from "./format.js";

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
): string {
  return views
    .map((view) => {
      const display = multiline
        ? formatRowLines(view, now, width).join("\n")
        : formatRow(view, now);
      return `${view.record.sessionId}\t${display}`;
    })
    .join("\0");
}

/** Returns the chosen session, or null if the user cancelled. */
export async function pickSession(views: readonly SessionView[]): Promise<SessionView | null> {
  if (views.length === 0) return null;
  return hasFzf() ? pickWithFzf(views) : pickWithPrompt(views);
}

/**
 * The command fzf runs to fill its preview pane.
 *
 * It must re-invoke *this* build, not whatever `gm` happens to be on PATH —
 * during development there may be no `gm` on PATH at all, and the preview pane
 * would silently render nothing.
 */
function previewCommand(): string {
  const self = process.argv[1];
  if (!self) return "gm show {1} --no-color";
  return `"${process.execPath}" "${self}" show {1} --no-color`;
}

async function pickWithFzf(views: readonly SessionView[]): Promise<SessionView | null> {
  const byId = new Map(views.map((v) => [v.record.sessionId, v]));
  const multiline = supportsMultiline(fzfVersion());
  const records = buildFzfRecords(views, multiline);

  const args = [
    "--ansi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--height=90%",
    "--layout=reverse",
    "--border",
    "--prompt=session > ",
    "--header=enter: resume   ctrl-c: cancel",
    "--preview",
    previewCommand(),
    "--preview-window=right,55%,wrap",
  ];
  if (multiline) {
    // Items are NUL-delimited, so a record may contain newlines; --print0 keeps
    // the selection unambiguous on the way back out.
    args.push("--read0", "--print0", "--highlight-line");
  }

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

async function pickWithPrompt(views: readonly SessionView[]): Promise<SessionView | null> {
  const shown = views.slice(0, 30);
  // Wrap here too: the numbered fallback is a list you have to read, so chopping
  // the description defeats the point just as badly as it does in fzf.
  const width = Math.max(40, terminalWidth() - 5);

  for (const [i, view] of shown.entries()) {
    const [first = "", ...rest] = formatRowLines(view, new Date(), width);
    process.stdout.write(`${String(i + 1).padStart(3)}. ${first}\n`);
    for (const line of rest) process.stdout.write(`     ${line}\n`);
  }
  process.stdout.write("\n(install fzf for fuzzy search and previews: brew install fzf)\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("\nresume which? [number, or blank to cancel] ");
    const choice = Number.parseInt(answer.trim(), 10);
    if (!Number.isFinite(choice) || choice < 1 || choice > shown.length) return null;
    return shown[choice - 1] ?? null;
  } finally {
    rl.close();
  }
}
