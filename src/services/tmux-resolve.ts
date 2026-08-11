/**
 * Map a live tmux pane to the session it is running. Hybrid: an exact `gm run`
 * link wins; otherwise the newest transcript in the pane's cwd, preferring the
 * harness the foreground command points to. No match is a normal case (a plain
 * shell), rendered as a placeholder — never an error.
 */

import { allAdapters } from "../adapters/registry.js";
import type { HarnessId, PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import { linkForPane } from "./pane-links.js";
import { paneProcessHint, processSnapshot, type PaneProcessHint } from "./pane-process.js";

/** The harness a `pane_current_command` distinctively names, or null. */
export function harnessForCommand(command: string): HarnessId | null {
  const cmd = command.trim().toLowerCase();
  for (const adapter of allAdapters()) {
    if (adapter.processNames.some((name) => name.toLowerCase() === cmd)) return adapter.id;
  }
  return null;
}

/**
 * Newest session in a directory, skipping any session already claimed. When the
 * harness is `hard` (read from the agent's own command line), only that harness's
 * sessions match — so a fresh claude pane never resolves to a codex session.
 * When it's soft (guessed from `pane_current_command`), it's a mere preference.
 */
function newestInCwd(
  records: readonly SessionRecord[],
  cwd: string,
  harness: HarnessId | null,
  hard: boolean,
  exclude: ReadonlySet<string>,
): SessionRecord | null {
  let inCwd = records.filter((r) => r.cwd !== null && r.cwd === cwd && !exclude.has(r.sessionId));
  if (harness) {
    const ofHarness = inCwd.filter((r) => r.harness === harness);
    if (hard || ofHarness.length > 0) inCwd = ofHarness;
  }
  if (inCwd.length === 0) return null;
  return [...inCwd].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** The exact resolution — an explicit link or a session id read off the agent's argv. */
function resolveExact(
  pane: TmuxPane,
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
  hint?: PaneProcessHint,
): SessionRecord | null {
  const link = linkForPane(links, pane.paneId);
  if (link) {
    const exact = records.find((r) => r.harness === link.harness && r.sessionId === link.sessionId);
    if (exact) return exact;
  }
  if (hint?.argvSession) {
    const { harness, sessionId } = hint.argvSession;
    const exact = records.find((r) => r.harness === harness && r.sessionId === sessionId);
    if (exact) return exact;
  }
  return null;
}

/** The heuristic resolution — newest in the agent's cwd, then the pane's cwd, skipping claimed sessions. */
function resolveHeuristic(
  pane: TmuxPane,
  records: readonly SessionRecord[],
  exclude: ReadonlySet<string>,
  hint?: PaneProcessHint,
): SessionRecord | null {
  // The agent's real harness (from its argv) is authoritative — hard-filter to it.
  // Without it, fall back to a soft guess from `pane_current_command`.
  const harness = hint?.agentHarness ?? harnessForCommand(pane.command);
  const hard = hint?.agentHarness != null;

  if (hint?.agentCwd) {
    const byAgent = newestInCwd(records, hint.agentCwd, harness, hard, exclude);
    if (byAgent) return byAgent;
  }
  return newestInCwd(records, pane.cwd, harness, hard, exclude);
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
  return resolveExact(pane, records, links, hint) ?? resolveHeuristic(pane, records, NO_EXCLUDE, hint);
}

const NO_EXCLUDE: ReadonlySet<string> = new Set();

/**
 * Resolve a set of panes together, so no two panes claim the same session.
 *
 * Exact matches (link or argv) go first and claim their session; a heuristic
 * pane then never picks a session another pane already owns. Without this, a
 * fresh agent with no id on its command line falls back to "newest in this cwd"
 * — which is whatever *another* pane is actively working on, so its summary gets
 * copied onto this one. Pure over the panes, records, links, and per-pane hints.
 */
export function resolvePanesWithHints(
  panes: readonly TmuxPane[],
  records: readonly SessionRecord[],
  links: readonly PaneLink[],
  hints: readonly (PaneProcessHint | undefined)[],
): ResolvedPane[] {
  const claimed = new Set<string>();
  const exacts = panes.map((pane, i) => {
    const record = resolveExact(pane, records, links, hints[i]);
    if (record) claimed.add(record.sessionId);
    return record;
  });

  return panes.map((pane, i) => {
    let record = exacts[i];
    if (!record) {
      record = resolveHeuristic(pane, records, claimed, hints[i]);
      if (record) claimed.add(record.sessionId);
    }
    return { pane, record };
  });
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
  // One process snapshot for every pane, walked in memory — not a pgrep per node.
  const snapshot = await processSnapshot();
  const hints = await Promise.all(panes.map((pane) => paneProcessHint(pane.pid, snapshot)));
  return resolvePanesWithHints(panes, records, links, hints);
}
