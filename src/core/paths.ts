/** Where gigamanage keeps its own state. It never writes anywhere else. */

import { homedir } from "node:os";
import { join } from "node:path";

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
