/**
 * Map a live tmux pane to the session it is running. Hybrid: an exact `gm run`
 * link wins; otherwise the newest transcript in the pane's cwd, preferring the
 * harness the foreground command points to. No match is a normal case (a plain
 * shell), rendered as a placeholder — never an error.
 */

import { allAdapters } from "../adapters/registry.js";
import type { HarnessId, PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import { linkForPane } from "./pane-links.js";
import { paneProcessHint, type PaneProcessHint } from "./pane-process.js";

/** The harness a `pane_current_command` distinctively names, or null. */
export function harnessForCommand(command: string): HarnessId | null {
  const cmd = command.trim().toLowerCase();
  for (const adapter of allAdapters()) {
    if (adapter.processNames.some((name) => name.toLowerCase() === cmd)) return adapter.id;
  }
  return null;
}

/** Newest session in a directory, preferring the harness a command distinctively names. */
function newestInCwd(
  records: readonly SessionRecord[],
  cwd: string,
  command: string,
): SessionRecord | null {
  const inCwd = records.filter((r) => r.cwd !== null && r.cwd === cwd);
  if (inCwd.length === 0) return null;
  const harness = harnessForCommand(command);
  const preferred = harness ? inCwd.filter((r) => r.harness === harness) : [];
  const pool = preferred.length > 0 ? preferred : inCwd;
  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/**
 * Resolve a pane to its session, best signal first:
 *
 * 1. an explicit `gm run` / `gm link` link,
 * 2. the session id read off the agent process's argv (exact),
 * 3. the newest session in the agent process's real cwd,
 * 4. the newest session in the pane's own cwd (the shell's — weakest),
 * 5. nothing.
 *
 * `hint` carries the process-derived signals (2–3); with it absent, resolution
 * is the pre-process cwd heuristic, unchanged.
 */
export function resolvePaneToRecord(
  pane: TmuxPane,
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
  hint?: PaneProcessHint,
): SessionRecord | null {
  const link = linkForPane(links, pane.paneId);
  if (link) {
    const exact = records.find((r) => r.harness === link.harness && r.sessionId === link.sessionId);
    if (exact) return exact;
    // Link points at a session the index hasn't caught up to yet — fall through.
  }

  if (hint?.argvSession) {
    const { harness, sessionId } = hint.argvSession;
    const exact = records.find((r) => r.harness === harness && r.sessionId === sessionId);
    if (exact) return exact;
  }

  if (hint?.agentCwd) {
    const byAgent = newestInCwd(records, hint.agentCwd, pane.command);
    if (byAgent) return byAgent;
  }

  return newestInCwd(records, pane.cwd, pane.command);
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

/**
 * Resolve panes using their live process trees — the exact path. Gathers each
 * pane's process hint (argv session id + agent cwd) in parallel, then resolves.
 */
export async function resolvePanesLive(
  panes: readonly TmuxPane[],
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
): Promise<ResolvedPane[]> {
  const hints = await Promise.all(panes.map((pane) => paneProcessHint(pane.paneId)));
  return panes.map((pane, i) => ({
    pane,
    record: resolvePaneToRecord(pane, records, links, hints[i]),
  }));
}
