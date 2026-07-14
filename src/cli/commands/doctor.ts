import { spawnSync } from "node:child_process";
import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { cacheDir } from "../../core/paths.js";
import { allAdapters } from "../../adapters/registry.js";
import { CliSummaryProvider } from "../../services/summarize.js";
import { discover } from "../../services/index-store.js";
import { dim, green, jsonEnvelope, red, yellow } from "../format.js";

interface Check {
  name: string;
  ok: boolean;
  /** Not fatal — the tool still works, just less well. */
  optional?: boolean;
  detail: string;
  fix?: string;
}

function onPath(binary: string): boolean {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

/**
 * Report what is present, what is missing, and — for anything missing — the
 * exact command that fixes it. No diagnostic should ever leave you guessing.
 */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check what gigamanage can see, and what's missing")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { json?: boolean }) => {
      const checks: Check[] = [];

      for (const adapter of allAdapters()) {
        const available = await adapter.isAvailable();
        const sessions = available ? (await adapter.listSessions()).length : 0;
        checks.push({
          name: `harness: ${adapter.displayName}`,
          ok: available,
          optional: true,
          detail: available ? `${sessions} sessions found` : "no session directory on this machine",
          ...(available ? {} : { fix: `Nothing to do unless you use ${adapter.displayName}.` }),
        });
      }

      const rg = onPath("rg");
      checks.push({
        name: "ripgrep (search)",
        ok: rg,
        detail: rg ? "on PATH" : "missing — `gm grep` will not work",
        ...(rg ? {} : { fix: "brew install ripgrep" }),
      });

      const fzf = onPath("fzf");
      checks.push({
        name: "fzf (fuzzy picker)",
        ok: fzf,
        optional: true,
        detail: fzf ? "on PATH" : "missing — the picker falls back to a numbered list",
        ...(fzf ? {} : { fix: "brew install fzf" }),
      });

      const provider = new CliSummaryProvider();
      const providerOk = await provider.isAvailable();
      checks.push({
        name: `summary provider (${provider.name})`,
        ok: providerOk,
        optional: true,
        detail: providerOk ? "on PATH" : "missing — `gm summarize` will not work",
        ...(providerOk
          ? {}
          : { fix: "Install Claude Code, or set GIGAMANAGE_SUMMARY_CMD='codex exec'." }),
      });

      const total = (await discover()).length;
      checks.push({
        name: "sessions visible",
        ok: total > 0,
        detail: `${total} total`,
        ...(total > 0 ? {} : { fix: "Run an agent session first, or check GIGAMANAGE_HOME." }),
      });

      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, { checks, cacheDir: cacheDir() })}\n`);
        return;
      }

      for (const check of checks) {
        const mark = check.ok ? green("✓") : check.optional ? yellow("○") : red("✗");
        process.stdout.write(`${mark} ${check.name}  ${dim(check.detail)}\n`);
        if (!check.ok && check.fix) process.stdout.write(`  ${dim(`fix: ${check.fix}`)}\n`);
      }
      process.stdout.write(`\n${dim(`cache: ${cacheDir()}`)}\n`);

      if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1;
    });
}
