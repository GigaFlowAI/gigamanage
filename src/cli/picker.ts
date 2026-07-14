/**
 * Session picker.
 *
 * fzf is used when installed — it gives fuzzy matching and a live preview pane
 * for free. When it is absent we fall back to a numbered prompt rather than
 * failing: gigamanage must work on a machine with nothing but Node.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import type { SessionView } from "../core/types.js";
import { formatRow } from "./format.js";

export function hasFzf(): boolean {
  const probe = spawnSync("which", ["fzf"], { stdio: "ignore" });
  return probe.status === 0;
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
  // Field 1 is the id; fzf hands it to the preview command and back to us.
  const lines = views.map((v) => `${v.record.sessionId}\t${formatRow(v)}`).join("\n");

  const selected = await new Promise<string | null>((resolve) => {
    const child = spawn(
      "fzf",
      [
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
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(stdout.trim() === "" ? null : stdout.trim()));

    child.stdin.write(lines);
    child.stdin.end();
  });

  if (!selected) return null;
  const id = selected.split("\t")[0]!;
  return byId.get(id) ?? null;
}

async function pickWithPrompt(views: readonly SessionView[]): Promise<SessionView | null> {
  const shown = views.slice(0, 30);
  for (const [i, view] of shown.entries()) {
    process.stdout.write(`${String(i + 1).padStart(3)}. ${formatRow(view)}\n`);
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
