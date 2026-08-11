import type { Command } from "commander";

import type { SessionView } from "../../core/types.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { listPanes } from "../../services/tmux.js";
import { resolvePanes, type ResolvedPane } from "../../services/tmux-resolve.js";
import { attachSummaries, loadRecords } from "../../services/views.js";
import { renderOverlay, type OverlayCell } from "../overlay.js";

/** How often the overlay repaints while it waits, to fold in landed refreshes. */
const REPAINT_MS = 1000;

/**
 * Pair each resolved pane with its summary view and the in-flight refresh set.
 * Pure, so the pairing is tested without a terminal.
 */
export function buildCells(
  resolved: readonly ResolvedPane[],
  views: readonly SessionView[],
  refreshingIds: ReadonlySet<string>,
): OverlayCell[] {
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  return resolved.map(({ pane, record }) => ({
    pane,
    view: record ? bySession.get(record.sessionId) ?? { record, summary: null } : null,
    refreshing: record ? refreshingIds.has(record.sessionId) : false,
  }));
}

async function frame(windowId: string): Promise<string> {
  const panes = await listPanes(windowId);
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  const records = await loadRecords();
  const resolved = resolvePanes(panes, records, links);
  const resolvedRecords = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(resolvedRecords);
  const refreshing = await inProgressIds();
  return renderOverlay(buildCells(resolved, views, refreshing));
}

async function runOverlay(windowId: string): Promise<void> {
  // Paint from the cache first — a peek must feel instant. We reach this command
  // only because `display-popup` launched it, which already proves tmux >= 3.2,
  // so no runtime version check gates the first frame (`gm doctor` still reports
  // availability up front).
  process.stdout.write(await frame(windowId));

  // Then, off the critical path, bring stale cards current in the background;
  // they repaint as summaries land. Force skips the cooldown — a keypress is an
  // explicit request — and the lock still prevents a stampede. Never awaited, so
  // the first paint never waits on a provider check or a filesystem pass.
  void loadRecords()
    .then((records) => maybeAutoSummarize({ records, force: true }))
    .catch(() => {});

  const timer = setInterval(() => {
    void frame(windowId).then((f) => process.stdout.write(f)).catch(() => {});
  }, REPAINT_MS);

  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => resolve());
  });

  clearInterval(timer);
  process.stdout.write("\x1b[2J\x1b[H"); // Leave a clean screen as the popup closes.
  process.exit(0);
}

export function registerOverlay(program: Command): void {
  program
    .command("overlay <window>")
    .description("draw every pane's summary in place (used by the tmux ctrl-g binding)")
    .action(async (windowId: string) => {
      await runOverlay(windowId);
    });
}
