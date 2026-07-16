/**
 * Where gigamanage keeps its own state. It never writes anywhere else.
 *
 * Two directories, and the split matters:
 *
 * - `cacheDir()` — derived data. Keyed by content hash, thrown away safely.
 * - `configDir()` — what a human chose. `rm -rf` the cache and you should lose
 *   summaries, not your provider. Anything a person typed belongs here.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Root of gigamanage's config. Honors XDG_CONFIG_HOME. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "gigamanage");
}

/** The one config file: provider choice and background-summary opt-in. */
export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Root of gigamanage's cache. Honors XDG_CACHE_HOME. */
export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".cache");
  return join(base, "gigamanage");
}

/** The parsed-session index. */
export function indexPath(): string {
  return join(cacheDir(), "index.json");
}

/** Directory of generated summaries, one JSON file per session. */
export function summaryDir(): string {
  return join(cacheDir(), "summaries");
}

export function summaryPath(harness: string, sessionId: string): string {
  return join(summaryDir(), `${harness}-${sessionId}.json`);
}

/**
 * Home directory, overridable via GIGAMANAGE_HOME so tests can point the
 * adapters at fixture trees instead of the real one.
 */
export function harnessHome(): string {
  const override = process.env.GIGAMANAGE_HOME;
  return override && override.trim() !== "" ? override : homedir();
}
