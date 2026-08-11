import { spawn } from "node:child_process";

import type { Command } from "commander";

import type { SessionView } from "../../core/types.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { listPanes } from "../../services/tmux.js";
import { resolvePanesLive, type ResolvedPane } from "../../services/tmux-resolve.js";
import { attachSummaries, loadCachedRecords, loadRecords } from "../../services/views.js";
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

const FOOTER = " a  ask across these agents      ·      any other key  close ";

/** A reverse-video hint on the popup's bottom row, so `a` is discoverable. */
function footer(): string {
  const rows = process.stdout.rows;
  if (!rows) return "";
  return `\x1b[${rows};1H\x1b[7m${FOOTER}\x1b[0m`;
}

/** Paint the resolved panes: re-read only the (small) summary files and repaint. */
async function paint(resolved: readonly ResolvedPane[]): Promise<void> {
  const present = resolved
    .map((r) => r.record)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(present);
  const refreshing = await inProgressIds();
  process.stdout.write(renderOverlay(buildCells(resolved, views, refreshing)) + footer());
}

async function runOverlay(windowId: string): Promise<void> {
  // A peek must feel instant. We reach this command only because `display-popup`
  // launched it, which already proves tmux >= 3.2 — no runtime version check
  // gates the first frame (`gm doctor` still reports availability up front).
  //
  // Resolve ONCE from the cache: the pane→session mapping and the record set are
  // the expensive parts (a 4k-file index scan, per-pane process reads), and they
  // do not change over a short peek. Repaints re-read only summaries, so an open
  // overlay is not re-scanning thousands of files every second.
  const panes = await listPanes(windowId);
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  let resolved = await resolvePanesLive(panes, await loadCachedRecords(), links);
  await paint(resolved);

  // Off the critical path: upgrade to the full index (catching sessions created
  // since the last refresh), re-resolve, repaint, and kick stale cards to
  // refresh in the background — targeting exactly the panes on screen.
  void (async () => {
    const records = await loadRecords();
    resolved = await resolvePanesLive(panes, records, links);
    await paint(resolved);
    const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
    await maybeAutoSummarize({ records: present, force: true });
  })().catch(() => {});

  const timer = setInterval(() => {
    void paint(resolved).catch(() => {});
  }, REPAINT_MS);

  const key = await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (data: Buffer) => resolve(data.toString()));
  });

  clearInterval(timer);
  process.stdout.write("\x1b[2J\x1b[H"); // Clear the cards.

  // `a` hands the popup to `gm ask`, scoped to this window's agent sessions, so
  // you can ask high-level orienting questions ("what's happening?") across them.
  // Any other key just closes.
  if (key === "a") {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    await launchAsk(windowId);
  }
  process.exit(0);
}

/** Run `gm ask --window <id>` in the popup, inheriting its terminal, and wait. */
function launchAsk(windowId: string): Promise<void> {
  return new Promise((resolve) => {
    const entry = process.argv[1];
    if (!entry) return resolve();
    const child = spawn(process.execPath, [...process.execArgv, entry, "ask", "--window", windowId], {
      stdio: "inherit",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export function registerOverlay(program: Command): void {
  program
    .command("overlay <window>")
    .description("draw every pane's summary in place (used by the tmux ctrl-g binding)")
    .action(async (windowId: string) => {
      await runOverlay(windowId);
    });
}
