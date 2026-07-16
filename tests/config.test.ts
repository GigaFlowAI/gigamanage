/**
 * Config, providers, and the first-run gate.
 *
 * Every test here is either pure or writes to a temp XDG_CONFIG_HOME. Nothing
 * calls a model and nothing reads the real home — non-negotiables #2 and #3.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { configPath } from "../src/core/paths.js";
import { CONFIG_VERSION, type GmConfig } from "../src/core/types.js";
import {
  CHILD_ENV,
  FALLBACK_COMMAND,
  autoSummarizeAllowed,
  childEnv,
  configExists,
  isChildProcess,
  parseCommand,
  parseConfig,
  readConfig,
  resolveAskCommand,
  resolveSummaryCommand,
  shouldRunSetupWizard,
  writeConfig,
} from "../src/services/config.js";
import { PROVIDERS, askArgvFor, providerById, toChoice } from "../src/services/providers.js";
import { tempHome } from "./fixtures/build.js";

let configHome: string;

beforeEach(async () => {
  configHome = await tempHome();
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.GIGAMANAGE_SUMMARY_CMD;
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_SUMMARY_CMD;
  await rm(configHome, { recursive: true, force: true });
});

const claude = providerById("claude-code")!;
const codex = providerById("codex")!;

function config(overrides: Partial<GmConfig> = {}): GmConfig {
  return {
    version: CONFIG_VERSION,
    provider: { id: "claude-code", command: ["claude", "-p"] },
    autoSummarize: true,
    ...overrides,
  };
}

describe("provider catalog", () => {
  it("gives ask a grep grant that summarize does not have", () => {
    // The whole reason askArgv exists. If these ever match, `gm ask` has quietly
    // lost the ability to look past the summaries.
    expect(claude.askArgv.join(" ")).toContain("gm grep");
    expect(claude.summaryArgv.join(" ")).not.toContain("gm grep");
  });

  it("scopes the ask grant to gm grep rather than all of Bash", () => {
    // A blanket Bash grant would hand a session summarizer the whole machine.
    const grant = claude.askArgv[claude.askArgv.indexOf("--allowedTools") + 1];
    expect(grant).toBe("Bash(gm grep:*)");
  });

  it("uses the catalog's ask argv for a known provider", () => {
    expect(askArgvFor(toChoice(codex))).toEqual(codex.askArgv);
  });

  it("runs a custom command exactly as written", () => {
    // We don't know a custom CLI's flags, so we must not invent any. It answers
    // from the summaries alone — degraded, not broken.
    const custom = { id: "custom", command: ["gemini", "-p"] };
    expect(askArgvFor(custom)).toEqual(["gemini", "-p"]);
  });

  it("has a unique id per provider", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseConfig", () => {
  it("reads a well-formed config", () => {
    expect(parseConfig(JSON.stringify(config()))).toEqual(config());
  });

  it("treats malformed JSON as absent", () => {
    expect(parseConfig("{not json")).toBeNull();
  });

  it("treats a config from a future version as absent", () => {
    // Guessing at a shape we don't know is how you misread a user's choice.
    expect(parseConfig(JSON.stringify(config({ version: CONFIG_VERSION + 1 })))).toBeNull();
  });

  it("keeps provider: null — it is a choice, not a missing value", () => {
    const parsed = parseConfig(JSON.stringify(config({ provider: null })));
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBeNull();
  });

  it("rejects a provider with an empty command", () => {
    const raw = JSON.stringify({ version: 1, provider: { id: "x", command: [] }, autoSummarize: true });
    expect(parseConfig(raw)!.provider).toBeNull();
  });

  it("drops non-string parts of a command rather than spawning them", () => {
    const raw = JSON.stringify({
      version: 1,
      provider: { id: "x", command: ["claude", 7, "-p"] },
      autoSummarize: true,
    });
    expect(parseConfig(raw)!.provider!.command).toEqual(["claude", "-p"]);
  });
});

describe("readConfig / writeConfig", () => {
  it("round-trips", async () => {
    await writeConfig(config({ autoSummarize: false }));
    expect(await readConfig()).toEqual(config({ autoSummarize: false }));
  });

  it("returns null when there is no config", async () => {
    expect(await readConfig()).toBeNull();
  });

  it("survives a corrupt config instead of throwing", async () => {
    // A truncated JSON file must not be able to kill `gm ls`.
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), "{ half-writ", "utf8");
    expect(await readConfig()).toBeNull();
  });

  it("distinguishes a corrupt config from an absent one", async () => {
    // configExists keys the first-run wizard. A corrupt file must not relaunch
    // the wizard on every single run.
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), "{ half-writ", "utf8");
    expect(await configExists()).toBe(true);
    expect(await readConfig()).toBeNull();
  });
});

describe("resolveSummaryCommand", () => {
  it("puts the env var above everything", () => {
    // Every script, test and CI job that set this predates config and must keep
    // working without being told a new file exists.
    const env = { GIGAMANAGE_SUMMARY_CMD: "gemini -p" };
    expect(resolveSummaryCommand(config(), env, claude)).toEqual(["gemini", "-p"]);
  });

  it("lets the env var override even a configured 'no model calls'", () => {
    const env = { GIGAMANAGE_SUMMARY_CMD: "gemini -p" };
    expect(resolveSummaryCommand(config({ provider: null }), env, null)).toEqual(["gemini", "-p"]);
  });

  it("uses the configured provider when no env var is set", () => {
    expect(resolveSummaryCommand(config({ provider: toChoice(codex) }), {}, claude)).toEqual(
      codex.summaryArgv,
    );
  });

  it("returns null when the user configured no model calls", () => {
    expect(resolveSummaryCommand(config({ provider: null }), {}, claude)).toBeNull();
  });

  it("autodetects when there is no config at all", () => {
    // The pre-config behavior, preserved exactly.
    expect(resolveSummaryCommand(null, {}, codex)).toEqual(codex.summaryArgv);
  });

  it("falls back to claude -p when nothing is detected and nothing configured", () => {
    expect(resolveSummaryCommand(null, {}, null)).toEqual([...FALLBACK_COMMAND]);
  });

  it("does not treat an absent config as a 'no'", () => {
    // Absent means "not asked yet", which autodetects. Only an existing config
    // can say no. Confusing the two would silently disable summaries for every
    // user who upgrades.
    expect(resolveSummaryCommand(null, {}, claude)).not.toBeNull();
  });

  it("ignores an empty env var rather than spawning nothing", () => {
    expect(resolveSummaryCommand(null, { GIGAMANAGE_SUMMARY_CMD: "   " }, claude)).toEqual(
      claude.summaryArgv,
    );
  });
});

describe("resolveAskCommand", () => {
  it("uses the ask argv, not the summary argv, for a known provider", () => {
    expect(resolveAskCommand(config(), {}, null)).toEqual(claude.askArgv);
  });

  it("returns null when the user configured no model calls", () => {
    expect(resolveAskCommand(config({ provider: null }), {}, claude)).toBeNull();
  });

  it("autodetects the ask argv when there is no config", () => {
    expect(resolveAskCommand(null, {}, codex)).toEqual(codex.askArgv);
  });
});

describe("autoSummarizeAllowed", () => {
  it("honors a config that says no", () => {
    expect(autoSummarizeAllowed(config({ autoSummarize: false }))).toBe(false);
  });

  it("defaults to yes with no config — the pre-config behavior", () => {
    expect(autoSummarizeAllowed(null)).toBe(true);
  });
});

describe("the child guard", () => {
  it("marks a spawned provider's environment", () => {
    expect(childEnv({ PATH: "/usr/bin" })[CHILD_ENV]).toBe("1");
  });

  it("preserves the rest of the environment", () => {
    expect(childEnv({ PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });

  it("recognises a child", () => {
    expect(isChildProcess({ [CHILD_ENV]: "1" })).toBe(true);
  });

  it("does not treat a plain process as a child", () => {
    expect(isChildProcess({})).toBe(false);
  });

  it("treats an explicit 0 as not a child", () => {
    expect(isChildProcess({ [CHILD_ENV]: "0" })).toBe(false);
  });
});

describe("shouldRunSetupWizard", () => {
  const gate = (over: Partial<Parameters<typeof shouldRunSetupWizard>[0]> = {}) =>
    shouldRunSetupWizard({
      hasConfig: false,
      isTty: true,
      isJson: false,
      commandName: "pick",
      ...over,
    });

  it("runs on a first interactive run", () => {
    expect(gate()).toBe(true);
  });

  it("never runs once config exists", () => {
    expect(gate({ hasConfig: true })).toBe(false);
  });

  it("never runs without a TTY", () => {
    // `gm ls | head` must not block on a prompt nobody can see.
    expect(gate({ isTty: false })).toBe(false);
  });

  it("never runs under --json", () => {
    // Non-negotiable #4: an agent calls this. A prompt would be a hang.
    expect(gate({ isJson: true })).toBe(false);
  });

  it("never runs for the background worker", () => {
    expect(gate({ commandName: "__auto-summarize" })).toBe(false);
  });

  it("never runs for the picker's reload command", () => {
    // fzf owns the terminal while this runs; a prompt would corrupt the display.
    expect(gate({ commandName: "__picker-rows" })).toBe(false);
  });

  it("never runs for setup itself", () => {
    expect(gate({ commandName: "setup" })).toBe(false);
  });
});

describe("parseCommand", () => {
  it("splits on whitespace", () => {
    expect(parseCommand("  claude   -p  ")).toEqual(["claude", "-p"]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseCommand("   ")).toEqual([]);
  });
});
