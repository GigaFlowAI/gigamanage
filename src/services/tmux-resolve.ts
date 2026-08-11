/**
 * Map a live tmux pane to the session it is running. Hybrid: an exact `gm run`
 * link wins; otherwise the newest transcript in the pane's cwd, preferring the
 * harness the foreground command points to. No match is a normal case (a plain
 * shell), rendered as a placeholder — never an error.
 */

import { allAdapters } from "../adapters/registry.js";
import type { HarnessId, PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import { linkForPane } from "./pane-links.js";

/** The harness a `pane_current_command` distinctively names, or null. */
export function harnessForCommand(command: string): HarnessId | null {
  const cmd = command.trim().toLowerCase();
  for (const adapter of allAdapters()) {
    if (adapter.processNames.some((name) => name.toLowerCase() === cmd)) return adapter.id;
  }
  return null;
}

export function resolvePaneToRecord(
  pane: TmuxPane,
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
): SessionRecord | null {
  const link = linkForPane(links, pane.paneId);
  if (link) {
    const exact = records.find(
      (r) => r.harness === link.harness && r.sessionId === link.sessionId,
    );
    if (exact) return exact;
    // Link points at a session the index hasn't caught up to yet — fall through
    // to the heuristic rather than showing nothing.
  }

  const inCwd = records.filter((r) => r.cwd !== null && r.cwd === pane.cwd);
  if (inCwd.length === 0) return null;

  const harness = harnessForCommand(pane.command);
  const preferred = harness ? inCwd.filter((r) => r.harness === harness) : [];
  const pool = preferred.length > 0 ? preferred : inCwd;

  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export interface ResolvedPane {
  pane: TmuxPane;
  record: SessionRecord | null;
}

export function resolvePanes(
  panes: readonly TmuxPane[],
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
): ResolvedPane[] {
  return panes.map((pane) => ({ pane, record: resolvePaneToRecord(pane, records, links) }));
}
