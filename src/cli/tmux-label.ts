/**
 * The pane-border-label HUD: each pane's session headline, written into its tmux
 * pane title and shown on the pane border. Toggling is one `gm` pass — resolve
 * every pane (via the live process resolver), set every title, flip
 * `pane-border-status` — so there is no per-pane command in the format and no
 * async blanking.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SessionView } from "../core/types.js";
import { prunePaneLinks } from "../services/pane-links.js";
import { listPanes } from "../services/tmux.js";
import { resolvePanesLive } from "../services/tmux-resolve.js";
import { attachSummaries, loadRecords } from "../services/views.js";

const run = promisify(execFile);

/**
 * Active pane emphasised, label centred. Two deliberate choices:
 *
 * - It reads a custom per-pane option (`@gm_label`), NOT `#{pane_title}`: a
 *   running agent sets its pane title via OSC escape sequences (a progress
 *   spinner), which would clobber a title we wrote. A `@`-prefixed user option is
 *   ours alone — no program can overwrite it.
 * - It forces the label's foreground colour. Otherwise the text inherits
 *   `pane-border-style`, which themes (Oh My Tmux) dim to near-background for
 *   inactive panes — so every label but the active one would be invisible.
 */
const PANE_BORDER_FORMAT = "#[align=centre]#[fg=colour252]#{?pane_active,#[reverse],} #{@gm_label} #[default]";

/**
 * The label for a pane: `project — headline`, or `○ project` when the session
 * isn't summarised yet, or empty for a pane with no resolvable agent. Not
 * truncated — tmux clips it to the pane's width at render, so a wide pane shows
 * the whole headline.
 */
export function paneLabel(view: SessionView | null): string {
  if (!view) return "";
  const project = view.record.project ?? view.record.harness;
  if (!view.summary) return `○ ${project}`;
  return `${project} — ${view.summary.headline}`;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args);
  return stdout;
}

/** The window's current `pane-border-status`, or "off" when unset. */
async function borderStatus(windowId: string): Promise<string> {
  try {
    const value = (await tmux(["show-options", "-wqv", "-t", windowId, "pane-border-status"])).trim();
    return value === "" ? "off" : value;
  } catch {
    return "off";
  }
}

/**
 * Toggle the label HUD for a window. On when off: resolve every pane, set its
 * title, and turn the border status on. Off when on: just hide the border status
 * (titles are harmless while hidden).
 */
export async function toggleLabels(windowId: string): Promise<void> {
  if ((await borderStatus(windowId)) !== "off") {
    await tmux(["set-option", "-w", "-t", windowId, "pane-border-status", "off"]);
    return;
  }

  const panes = await listPanes(windowId);
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  const records = await loadRecords();
  const resolved = await resolvePanesLive(panes, records, links);

  const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(present);
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));

  for (const { pane, record } of resolved) {
    const view: SessionView | null = record
      ? bySession.get(record.sessionId) ?? { record, summary: null }
      : null;
    await tmux(["set-option", "-p", "-t", pane.paneId, "@gm_label", paneLabel(view)]);
  }

  await tmux(["set-option", "-w", "-t", windowId, "pane-border-format", PANE_BORDER_FORMAT]);
  await tmux(["set-option", "-w", "-t", windowId, "pane-border-status", "top"]);
}
