/**
 * Global test setup.
 *
 * Non-negotiable #3 says no test reads the real home directory. Config made
 * that easy to break: `readConfig()` is called deep inside `maybeAutoSummarize`
 * and `defaultSummaryProvider`, so a test that never mentions config can still
 * end up reading `~/.config/gigamanage/config.json` — and then pass or fail
 * depending on whether the person running it happens to have run `gm setup`.
 *
 * A per-test `beforeEach` would fix the tests that remember. This fixes the
 * ones that don't: every run gets a throwaway XDG_CONFIG_HOME before any test
 * file is imported, so the real config is unreachable by construction. Tests
 * that care about config still point it at their own temp dir on top.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gigamanage-config-"));
  process.env.XDG_CONFIG_HOME = root;
});

afterAll(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await rm(root, { recursive: true, force: true });
});
