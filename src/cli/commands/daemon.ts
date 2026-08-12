/**
 * `gm daemon` — the gmux workspace daemon.
 *
 * `run` starts the interval loop (tmux registry diff → sensors → classify →
 * write to the model) plus the `ModelServer` socket, foreground, supervised by
 * a PID lockfile so a second `gm daemon run` refuses to double-start. `status`
 * and `stop` read that same lock to report on / signal the running process.
 *
 * The lock is a small mirror of `services/auto-summarize.ts`'s lock: same
 * shape (`{ pid, startedAt }`), same staleness rule (owner dead, or too old).
 * It lives under `gmuxDir()` rather than `cacheDir()` directly because it is
 * gmux-specific ephemeral state, not shared with the rest of gigamanage.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Command } from "commander";

import { DEFAULT_GMUX_CONFIG } from "../../core/gmux-types.js";
import { gmuxDir } from "../../core/paths.js";
import { Daemon, type DaemonDeps } from "../../services/daemon.js";
import { readSnapshotFile } from "../../services/daemon-client.js";
import { ModelServer } from "../../services/daemon-socket.js";
import { RealTmuxGateway } from "../../services/tmux-gateway.js";
import { WorkspaceModel } from "../../services/workspace.js";
import { dim, green, red, yellow } from "../format.js";

export interface LoopOpts {
  tickMs: number;
  signal: AbortSignal;
  onTick?: () => void;
}

/**
 * The testable core: tick the daemon on an interval until `signal` aborts.
 *
 * A tick failure never kills the loop — `tickOnce` already swallows per-sensor
 * errors, but this catch is belt-and-suspenders against anything else (e.g. a
 * gateway that throws) so the daemon degrades to "nothing observed this tick"
 * rather than exiting.
 */
export async function runDaemonLoop(deps: DaemonDeps, opts: LoopOpts): Promise<void> {
  const daemon = new Daemon(deps);
  while (!opts.signal.aborted) {
    await daemon.tickOnce().catch(() => {
      /* keep the loop alive */
    });
    opts.onTick?.();
    if (opts.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.tickMs);
      opts.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}

// --- Lock -------------------------------------------------------------

/** A lock older than this belongs to a process that died without cleaning up. */
export const DAEMON_LOCK_STALE_MS = 10 * 60_000;

export interface DaemonLock {
  pid: number;
  startedAt: string;
}

export function daemonLockPath(): string {
  return join(gmuxDir(), "daemon.lock");
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its owner is gone, or when it is simply too old. */
export function isDaemonLockStale(
  lock: DaemonLock,
  now: Date = new Date(),
  staleMs: number = DAEMON_LOCK_STALE_MS,
): boolean {
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started)) return true;
  if (now.getTime() - started > staleMs) return true;
  return !processAlive(lock.pid);
}

/** Corrupt or missing lock reads as "not running" — never throws. */
export async function readDaemonLock(): Promise<DaemonLock | null> {
  try {
    const parsed = JSON.parse(await readFile(daemonLockPath(), "utf8")) as DaemonLock;
    if (typeof parsed?.startedAt !== "string") return null;
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid)) return null;
    return { pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

async function writeDaemonLock(lock: DaemonLock): Promise<void> {
  await mkdir(gmuxDir(), { recursive: true });
  await writeFile(daemonLockPath(), JSON.stringify(lock), "utf8");
}

export async function releaseDaemonLock(): Promise<void> {
  await rm(daemonLockPath(), { force: true });
}

/**
 * Take the lock for this process, refusing if a live one already exists.
 *
 * Returns false — never throws — when another daemon is already running, so
 * callers can print a clear message and exit rather than crash.
 */
export async function acquireDaemonLock(now: Date = new Date()): Promise<boolean> {
  const existing = await readDaemonLock();
  if (existing && !isDaemonLockStale(existing, now)) return false;
  await writeDaemonLock({ pid: process.pid, startedAt: now.toISOString() });
  return true;
}

// --- Command ------------------------------------------------------------

export function registerDaemon(program: Command): void {
  const cmd = program.command("daemon").description("run and manage the gmux workspace daemon");

  cmd
    .command("run", { isDefault: true })
    .description("run the daemon loop in the foreground")
    .action(async () => {
      if (!(await acquireDaemonLock())) {
        const existing = await readDaemonLock();
        process.stderr.write(
          `${red("error")} a daemon is already running (pid ${existing?.pid ?? "?"})\n`,
        );
        process.exitCode = 1;
        return;
      }

      const model = new WorkspaceModel();
      const server = new ModelServer(model);
      await server.start();

      const ac = new AbortController();
      const stop = (): void => ac.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      try {
        process.stdout.write(`${green("gmux daemon started")} (pid ${process.pid})\n`);
        await runDaemonLoop(
          { gateway: new RealTmuxGateway(), model, now: () => Date.now() },
          { tickMs: DEFAULT_GMUX_CONFIG.tickMs, signal: ac.signal },
        );
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await server.stop();
        await releaseDaemonLock();
      }
    });

  cmd
    .command("status")
    .description("show whether the daemon is running")
    .action(async () => {
      const lock = await readDaemonLock();
      if (!lock) {
        process.stdout.write(`${dim("stopped")} — no daemon lock\n`);
      } else if (isDaemonLockStale(lock)) {
        process.stdout.write(`${yellow("stale")} — lock left by pid ${lock.pid} (${lock.startedAt})\n`);
      } else {
        process.stdout.write(`${green("running")} (pid ${lock.pid}, started ${lock.startedAt})\n`);
      }

      const snap = await readSnapshotFile();
      if (snap) {
        process.stdout.write(
          `${dim(`snapshot: ${snap.snapshot.panes.length} pane(s), ${Math.round(snap.ageMs / 1000)}s old`)}\n`,
        );
      } else {
        process.stdout.write(`${dim("snapshot: none yet")}\n`);
      }
    });

  cmd
    .command("stop")
    .description("stop the running daemon")
    .action(async () => {
      const lock = await readDaemonLock();
      if (!lock || isDaemonLockStale(lock)) {
        process.stdout.write(`${dim("nothing was running")}\n`);
        return;
      }
      try {
        process.kill(lock.pid, "SIGTERM");
        process.stdout.write(`${green("stopped")} (sent SIGTERM to pid ${lock.pid})\n`);
      } catch {
        process.stdout.write(`${dim("nothing was running")}\n`);
      }
    });
}
