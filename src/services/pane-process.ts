/**
 * Read which session a tmux pane is running from the pane's own process tree.
 *
 * The agent process carries the session id in its command line — `codex resume
 * <id>`, `claude --resume <id>` — and both ids are exactly gigamanage's session
 * id. That is a far stronger signal than the pane's working directory, which is
 * the *shell's* cwd (usually `~`), not the agent's. Where the argv has no id (a
 * fresh session), the agent process's real cwd stands in.
 *
 * The parsing here is pure and tested; `panePid`/`descendants`/`processCwd` are
 * thin shells over `tmux`/`pgrep`/`ps`/`lsof`, and every one of them degrades to
 * a null rather than throwing — a resolve must never fail because a process
 * vanished mid-walk.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { HarnessId } from "../core/types.js";

const run = promisify(execFile);

export interface AgentProcess {
  pid: number;
  command: string;
}

export interface AgentSession {
  harness: HarnessId;
  sessionId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A harness binary invoked as a token — excludes MCP children and unrelated node procs. */
const HARNESS_TOKEN = /(?:^|\/|\s)(?:claude|codex)(?:\s|$)/;

/**
 * The session id on an agent's command line, or null.
 *
 * Codex writes `codex resume <uuid>`; Claude Code writes `claude --resume <uuid>`
 * (or `-r`). The id is the standard 8-4-4-4-12 hex form; anything else is not a
 * session id we can trust, so it reads as null and the caller falls back to cwd.
 */
export function parseAgentSession(command: string): AgentSession | null {
  if (/(?:^|\/|\s)codex(?:\s|$)/.test(command)) {
    const match = command.match(new RegExp(`resume\\s+(${UUID})`, "i"));
    if (match) return { harness: "codex", sessionId: match[1]!.toLowerCase() };
  }
  if (/(?:^|\/|\s)claude(?:\s|$)/.test(command)) {
    const match = command.match(new RegExp(`(?:--resume|-r)\\s+(${UUID})`, "i"));
    if (match) return { harness: "claude-code", sessionId: match[1]!.toLowerCase() };
  }
  return null;
}

/**
 * The harness process among a pane's descendants, or null.
 *
 * Prefer a process whose argv already yields a session id — that is definitive.
 * Otherwise the first process that looks like a harness invocation, for its cwd.
 * An MCP-server child (`node ./mcp/server.mjs`) names no harness, so it is never
 * chosen over the agent that spawned it.
 */
export function pickAgentProcess(procs: readonly AgentProcess[]): AgentProcess | null {
  return (
    procs.find((p) => parseAgentSession(p.command) !== null) ??
    procs.find((p) => HARNESS_TOKEN.test(p.command)) ??
    null
  );
}

/** The pane's shell pid, per tmux. Null if the pane is gone. */
export async function panePid(paneId: string): Promise<number | null> {
  try {
    const { stdout } = await run("tmux", ["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
    const pid = Number(stdout.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function childrenOf(pid: number): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", ["-P", String(pid)]);
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // pgrep exits non-zero when there are no children.
  }
}

/** Every descendant process of `pid` (breadth-first, bounded), with its command. */
export async function descendants(pid: number, maxDepth = 6): Promise<AgentProcess[]> {
  const pids: number[] = [];
  let frontier = [pid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const p of frontier) next.push(...(await childrenOf(p)));
    pids.push(...next);
    frontier = next;
  }
  if (pids.length === 0) return [];
  try {
    const { stdout } = await run("ps", ["-p", pids.join(","), "-o", "pid=,command="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        const pidNum = Number(line.slice(0, space));
        return { pid: pidNum, command: line.slice(space + 1).trim() };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/** A process's real working directory: /proc on Linux, lsof on macOS. Null if unknown. */
export async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const { readlink } = await import("node:fs/promises");
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

export interface PaneProcessHint {
  /** Session id read straight off the agent's argv — exact when present. */
  argvSession: AgentSession | null;
  /** The agent process's real cwd, for a fresh session with no id on the line. */
  agentCwd: string | null;
}

const EMPTY_HINT: PaneProcessHint = { argvSession: null, agentCwd: null };

/**
 * What the pane's running agent tells us about its session. Never throws — every
 * failure (no pane, no agent, no permission) degrades to an empty hint, and the
 * resolver falls back to its cwd heuristics.
 */
export async function paneProcessHint(paneId: string): Promise<PaneProcessHint> {
  try {
    const pid = await panePid(paneId);
    if (pid === null) return EMPTY_HINT;
    const agent = pickAgentProcess(await descendants(pid));
    if (!agent) return EMPTY_HINT;
    return {
      argvSession: parseAgentSession(agent.command),
      agentCwd: await processCwd(agent.pid),
    };
  } catch {
    return EMPTY_HINT;
  }
}
