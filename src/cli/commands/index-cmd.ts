import type { Command } from "commander";

import { SCHEMA_VERSION } from "../../core/types.js";
import { indexPath } from "../../core/paths.js";
import { refreshIndex } from "../../services/index-store.js";
import { dim, green, jsonEnvelope } from "../format.js";

export function registerIndex(program: Command): void {
  program
    .command("index")
    .description("refresh the session index (normally automatic)")
    .option("--rebuild", "re-parse every session, ignoring the cache")
    .option("--json", "emit JSON for scripts and agents")
    .action(async (options: { rebuild?: boolean; json?: boolean }) => {
      const started = Date.now();
      const result = await refreshIndex({ force: options.rebuild === true });
      const elapsedMs = Date.now() - started;

      const stats = {
        sessions: result.records.length,
        parsed: result.parsed,
        servedFromCache: result.cached,
        elapsedMs,
        indexPath: indexPath(),
      };

      if (options.json) {
        process.stdout.write(`${jsonEnvelope(SCHEMA_VERSION, stats)}\n`);
        return;
      }

      process.stdout.write(
        `${green(`✓ ${stats.sessions} sessions indexed`)} ${dim(
          `(${stats.parsed} parsed, ${stats.servedFromCache} cached, ${elapsedMs}ms)`,
        )}\n${dim(stats.indexPath)}\n`,
      );
    });
}
