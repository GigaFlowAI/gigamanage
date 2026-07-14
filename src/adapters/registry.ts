/**
 * The adapter registry.
 *
 * Adding a harness means adding one file and one line here. If you are that
 * contributor, read docs/adding-a-harness.md — it is short.
 */

import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import type { HarnessAdapter } from "./types.js";

export function allAdapters(): HarnessAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter()];
}

/** Adapters whose harness actually stores sessions on this machine. */
export async function availableAdapters(): Promise<HarnessAdapter[]> {
  const adapters = allAdapters();
  const available = await Promise.all(adapters.map((a) => a.isAvailable()));
  return adapters.filter((_, i) => available[i] === true);
}

export function adapterById(id: string): HarnessAdapter | undefined {
  return allAdapters().find((a) => a.id === id);
}
