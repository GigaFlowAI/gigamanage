/**
 * Auto-summarize: keep the top of `gm ls` written, without ever making you wait.
 *
 * A summary costs a model call (~8s). Ten of them, inline, would turn a 60ms
 * `gm ls` into a minute of staring at a cursor — so the foreground command never
 * runs one. Instead it decides *what* would need summarizing, hands that job to
 * a DETACHED child process, prints a one-line notice to stderr and exits. The
 * summaries land in the cache and appear on the next run.
 *
 * Three things this module exists to prevent:
 *
 * 1. **Blocking.** The child is spawned `detached` with `stdio: "ignore"` and
 *    unref'd, so it outlives its parent and the parent's event loop drains
 *    immediately. Nothing is awaited.
 *
 * 2. **A stampede.** Five `gm ls` in a row must not start five summarizers doing
 *    identical work. A lock file in the cache dir is created with O_EXCL before
 *    spawning; a lock whose owner is dead — or older than LOCK_STALE_MS — is
 *    taken over. A short cooldown stops us re-deciding on every invocation.
 *
 * 3. **A feedback loop.** The provider is `claude -p`, which itself writes a new
 *    Claude Code session to disk. If those were eligible targets, gigamanage
 *    would summarize its own summarizer forever. `automated` and `sidechain`
 *    sessions are therefore excluded from the target set — see
 *    `autoSummarizeCandidates`, which is where that guarantee lives.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cacheDir } from "../core/paths.js";
import type { SessionRecord, SummaryProvider } from "../core/types.js";
import {
  CliSummaryProvider,
  isStale,
  readSummary,
  summarizeBatch,
  type SummarizeBatchResult,
} from "./summarize.js";
import { loadRecords } from "./views.js";

/** How many recent sessions the background pass keeps summarized. */
export const AUTO_SUMMARIZE_LIMIT = 10;

/** A lock older than this belongs to a process that died without cleaning up. */
export const LOCK_STALE_MS = 10 * 60_000;

/** Don't re-decide on every invocation; `gm ls` in a loop should cost nothing. */
export const COOLDOWN_MS = 60_000;

/** The hidden CLI command the detached worker runs. It never auto-summarizes itself. */
export const AUTO_SUMMARIZE_COMMAND = "__auto-summarize";

export function lockPath(): string {
  return join(cacheDir(), "auto-summarize.lock");
}

export function statePath(): string {
  return join(cacheDir(), "auto-summarize.state.json");
}

/**
 * Off via `GIGAMANAGE_AUTO_SUMMARIZE=0`.
 *
 * Background model calls spend tokens. A user who has not opted into that must
 * be able to say no once, in their shell profile, and be done with it.
 */
export function autoSummarizeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["GIGAMANAGE_AUTO_SUMMARIZE"];
  if (raw == null || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export interface AutoSummarizeLock {
  /** Pid of the worker. 0 when the lock is taken but the child is not spawned yet. */
  pid: number;
  startedAt: string;
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return true; // Acquired-but-not-yet-spawned: trust the timestamp.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its owner is gone, or when it is simply too old. */
export function isLockStale(
  lock: AutoSummarizeLock,
  now: Date = new Date(),
  staleMs: number = LOCK_STALE_MS,
): boolean {
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started)) return true;
  if (now.getTime() - started > staleMs) return true;
  return !processAlive(lock.pid);
}

export async function readLock(): Promise<AutoSummarizeLock | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), "utf8")) as AutoSummarizeLock;
    if (typeof parsed?.startedAt !== "string") return null;
    return { pid: Number(parsed.pid) || 0, startedAt: parsed.startedAt };
  } catch {
    return null; // No lock, or an unreadable one: treat as not held.
  }
}

async function writeLock(lock: AutoSummarizeLock): Promise<void> {
  await writeFile(lockPath(), JSON.stringify(lock), "utf8");
}

async function createLockExclusive(lock: AutoSummarizeLock): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath(), "wx");
  } catch {
    return false; // EEXIST: someone else got there first.
  }
  try {
    await handle.writeFile(JSON.stringify(lock), "utf8");
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Take the lock, or report that someone else holds it.
 *
 * The create is O_EXCL, so two `gm` processes racing cannot both win. A stale
 * lock is removed and re-created rather than overwritten, so the takeover is
 * itself a race whose loser backs off instead of double-spawning.
 */
export async function acquireLock(now: Date = new Date()): Promise<boolean> {
  await mkdir(cacheDir(), { recursive: true });
  const lock: AutoSummarizeLock = { pid: 0, startedAt: now.toISOString() };

  if (await createLockExclusive(lock)) return true;

  const existing = await readLock();
  if (existing && !isLockStale(existing, now)) return false;

  await rm(lockPath(), { force: true });
  return createLockExclusive(lock);
}

export async function releaseLock(): Promise<void> {
  await rm(lockPath(), { force: true });
}

/** Record that we just decided; suppresses the next COOLDOWN_MS worth of checks. */
export async function noteCheck(now: Date = new Date()): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastCheckAt: now.toISOString() }), "utf8");
}

export async function inCooldown(now: Date = new Date(), cooldownMs = COOLDOWN_MS): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as { lastCheckAt?: string };
    const last = Date.parse(parsed.lastCheckAt ?? "");
    if (Number.isNaN(last)) return false;
    return now.getTime() - last < cooldownMs;
  } catch {
    return false;
  }
}

/**
 * The sessions the background pass is allowed to touch.
 *
 * THE FEEDBACK-LOOP GUARD. `claude -p` — our own summary provider — writes a
 * Claude Code session for every summary it produces, flagged `isAutomated`.
 * Summarizing those would generate more of them, forever, at real token cost.
 * Sidechains are excluded for the same reason plus a better one: nobody resumes
 * a subagent transcript.
 *
 * Pure. This is the function the anti-loop test pins.
 */
export function autoSummarizeCandidates(
  records: readonly SessionRecord[],
  limit: number = AUTO_SUMMARIZE_LIMIT,
): SessionRecord[] {
  return [...records]
    .filter((record) => !record.isAutomated && !record.isSidechain)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/**
 * Of the recent, eligible sessions, the ones whose summary is missing or stale.
 *
 * Reads the summary cache but calls no model, so tests exercise it for real.
 */
export async function selectAutoSummarizeTargets(
  records: readonly SessionRecord[],
  limit: number = AUTO_SUMMARIZE_LIMIT,
): Promise<SessionRecord[]> {
  const candidates = autoSummarizeCandidates(records, limit);
  const needed = await Promise.all(
    candidates.map(async (record) => isStale(await readSummary(record), record)),
  );
  return candidates.filter((_, index) => needed[index] === true);
}

export type AutoSummarizeStatus =
  | "spawned"
  | "disabled"
  | "no-provider"
  | "locked"
  | "cooling-down"
  | "nothing-to-do"
  | "spawn-failed";

export interface AutoSummarizeOutcome {
  status: AutoSummarizeStatus;
  /** How many sessions the worker was asked to write. */
  targets: number;
}

export interface MaybeAutoSummarizeOptions {
  /** False when `--no-auto-summarize` was passed. */
  enabled?: boolean;
  now?: Date;
  /** Injected in tests. Never a real model. */
  provider?: SummaryProvider;
  /** Injected in tests, so no test ever spawns anything. Returns the child pid. */
  spawnWorker?: () => number | undefined;
  /** Where the notice goes. STDERR — stdout must stay clean for `--json` and pipes. */
  notify?: (message: string) => void;
}

/**
 * Decide whether to kick off a background summarize pass, and if so, do it.
 *
 * Never throws and never blocks on a model: every failure path is a silent skip.
 * A read command must not die because `claude` is missing or a cache file is odd.
 */
export async function maybeAutoSummarize(
  options: MaybeAutoSummarizeOptions = {},
): Promise<AutoSummarizeOutcome> {
  try {
    return await decide(options);
  } catch {
    return { status: "spawn-failed", targets: 0 };
  }
}

async function decide(options: MaybeAutoSummarizeOptions): Promise<AutoSummarizeOutcome> {
  const now = options.now ?? new Date();
  const none = (status: AutoSummarizeStatus): AutoSummarizeOutcome => ({ status, targets: 0 });

  if (options.enabled === false || !autoSummarizeEnabled()) return none("disabled");

  // Cheapest checks first: two small file reads keep a repeated `gm ls` free.
  if (await inCooldown(now)) return none("cooling-down");
  const held = await readLock();
  if (held && !isLockStale(held, now)) return none("locked");

  // A missing model is not an error — it just means no summaries today.
  const provider = options.provider ?? new CliSummaryProvider();
  if (!(await provider.isAvailable())) return none("no-provider");

  const records = await loadRecords({ limit: AUTO_SUMMARIZE_LIMIT });
  const targets = await selectAutoSummarizeTargets(records);
  if (targets.length === 0) {
    await noteCheck(now);
    return none("nothing-to-do");
  }

  if (!(await acquireLock(now))) return none("locked");
  await noteCheck(now);

  let pid: number | undefined;
  try {
    pid = (options.spawnWorker ?? spawnWorker)();
  } catch {
    pid = undefined;
  }
  if (pid === undefined) {
    await releaseLock();
    return none("spawn-failed");
  }
  await writeLock({ pid, startedAt: now.toISOString() });

  const plural = targets.length === 1 ? "" : "s";
  options.notify?.(
    `summarizing ${targets.length} recent session${plural} in the background — they'll appear on your next run`,
  );
  return { status: "spawned", targets: targets.length };
}

/**
 * Re-run this same CLI, detached, on the hidden worker command.
 *
 * `detached` + `stdio: "ignore"` + `unref()` is the combination that lets the
 * parent exit at once: detached gives the child its own process group so it
 * survives the shell reaping the foreground job, ignoring stdio stops it holding
 * the terminal (or a pipe) open, and unref drops it from the parent's event loop.
 *
 * `execArgv` is forwarded so this works under `tsx` (`npm run dev`) as well as
 * from the built `dist/cli/main.js`.
 */
function spawnWorker(): number | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;

  const child = spawn(process.execPath, [...process.execArgv, entry, AUTO_SUMMARIZE_COMMAND], {
    detached: true,
    stdio: "ignore",
    // Belt and braces: the worker must never auto-summarize, or it would spawn a
    // grandchild for every summary it writes.
    env: { ...process.env, GIGAMANAGE_AUTO_SUMMARIZE: "0" },
  });
  child.unref();
  return child.pid;
}

/**
 * The worker body. Runs in the detached child, holding the lock its parent took.
 *
 * Re-selects its own targets rather than trusting a list handed down an argv: by
 * the time it starts, the parent's view of the store is already stale.
 */
export async function runAutoSummarize(provider: SummaryProvider): Promise<SummarizeBatchResult> {
  try {
    const records = await loadRecords({ limit: AUTO_SUMMARIZE_LIMIT });
    const targets = await selectAutoSummarizeTargets(records);
    if (targets.length === 0) return { generated: 0, skipped: 0, failed: [] };
    return await summarizeBatch(targets, provider);
  } finally {
    await releaseLock();
  }
}
