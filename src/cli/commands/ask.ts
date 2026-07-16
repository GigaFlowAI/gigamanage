/**
 * `gm ask` — ask questions about your sessions.
 *
 * Two shapes, one implementation:
 *
 *   gm ask                  a REPL. What ctrl-o in the picker opens.
 *   gm ask "<question>"     one-shot, for a shell or an agent.
 *   gm ask "<q>" --json     the same, parseable.
 *
 * The one-shot is not a convenience — non-negotiable #4 says every read command
 * supports `--json`, and an agent can only use what it can parse.
 */

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";

import { GigamanageError, NoProviderError } from "../../core/errors.js";
import { SCHEMA_VERSION, type AskContext, type AskProvider, type AskTurn } from "../../core/types.js";
import {
  ASK_SESSION_LIMIT,
  buildAskContext,
  buildAskPrompt,
  defaultAskProvider,
} from "../../services/ask.js";
import { loadViews } from "../../services/views.js";
import { bold, cyan, dim, jsonEnvelope, yellow } from "../format.js";
import { toFilters, type LsOptions } from "./ls.js";

export interface AskOptions extends LsOptions {
  /** Session the picker was highlighting when ctrl-o was pressed. */
  focus?: string;
  json?: boolean;
}

/** How many sessions had a summary — the honest measure of how much gm knows. */
export function summarizedCount(context: AskContext): number {
  return context.sessions.filter((v) => v.summary !== null).length;
}

/**
 * Warn when the answer is going to be thin.
 *
 * Asking "what should I focus on?" against twenty un-summarized sessions gets
 * you a shrug, and a user who doesn't know why will read that as the feature
 * being useless rather than as the summaries not being written yet.
 */
export function thinContextNotice(context: AskContext): string | null {
  const total = context.sessions.length;
  if (total === 0) return "No sessions indexed. `gm doctor` will say why.";

  const summarized = summarizedCount(context);
  if (summarized === 0) {
    return "None of these sessions is summarized yet — answers will be thin. `gm summarize` writes them.";
  }
  if (summarized < total / 2) {
    return `Only ${summarized} of ${total} sessions are summarized — answers may be thin.`;
  }
  return null;
}

async function loadContext(options: AskOptions): Promise<AskContext> {
  const views = await loadViews(toFilters(options, ASK_SESSION_LIMIT));
  return buildAskContext(views, options.focus ?? null, Number(options.limit) || ASK_SESSION_LIMIT);
}

async function resolveProvider(): Promise<AskProvider> {
  const provider = await defaultAskProvider();
  if (!provider) throw new NoProviderError("`gm ask`");
  return provider;
}

/**
 * The REPL.
 *
 * Turns accumulate in memory and are replayed into each prompt, because the
 * providers we call are one-shot — see services/ask.ts. Blank line or ctrl-d
 * exits, which is what returns you to the picker when fzf spawned us.
 */
async function repl(context: AskContext, provider: AskProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const turns: AskTurn[] = [];

  const notice = thinContextNotice(context);
  process.stdout.write(
    `\n${bold("gm ask")} ${dim(
      `— ${context.sessions.length} recent session${context.sessions.length === 1 ? "" : "s"} loaded, ${summarizedCount(context)} summarized · ${provider.name}`,
    )}\n`,
  );
  if (notice) process.stdout.write(`${yellow(notice)}\n`);
  process.stdout.write(`${dim("Ask anything. Blank line or ctrl-d to go back.")}\n`);

  try {
    for (;;) {
      const question = (await rl.question(`\n${cyan("?")} `)).trim();
      if (question === "") return;

      process.stdout.write(`${dim("  thinking…")}`);
      let answer: string;
      try {
        answer = await provider.ask(buildAskPrompt(context, turns, question));
      } catch (error) {
        // A failed turn must not end the conversation: the next question may be
        // cheaper, or the provider may just have been slow once.
        process.stdout.write(`\r\x1b[K${yellow((error as Error).message)}\n`);
        continue;
      }
      process.stdout.write("\r\x1b[K");
      process.stdout.write(`${answer}\n`);
      turns.push({ question, answer });
    }
  } catch {
    return; // ctrl-d rejects the question promise. That's an exit, not an error.
  } finally {
    rl.close();
  }
}

/**
 * Open the chat layer from inside the picker's numbered fallback.
 *
 * Never throws. The picker is mid-flow and the user is going straight back to
 * the list — a missing provider is a line of advice, not a crash that loses the
 * list they were reading.
 */
export async function askAboutSessions(options: AskOptions): Promise<void> {
  try {
    const provider = await defaultAskProvider();
    if (!provider) {
      process.stdout.write(
        `\n${yellow("gm is configured to make no model calls.")} ${dim("Run `gm setup` to choose a provider.")}\n`,
      );
      return;
    }
    await repl(await loadContext(options), provider);
  } catch (error) {
    process.stdout.write(`\n${yellow((error as Error).message)}\n`);
  }
}

export function registerAsk(program: Command): void {
  program
    .command("ask [question]")
    .description("ask about your recent sessions — what landed, what to pick up next")
    .option("--focus <id>", "the session you're looking at (the picker passes this)")
    .option("--harness <id>", "only this harness")
    .option("-p, --project <name>", "only sessions whose project matches")
    .option("-b, --branch <name>", "only sessions whose git branch matches")
    .option("-s, --since <when>", "only sessions newer than this (3d, 12h, 2w)")
    .option("-n, --limit <count>", "how many recent sessions to consider", String(ASK_SESSION_LIMIT))
    .option("--json", "emit JSON for scripts and agents")
    .action(async (question: string | undefined, options: AskOptions) => {
      const context = await loadContext(options);
      const provider = await resolveProvider();

      if (!question) {
        if (options.json) {
          // A REPL cannot emit an envelope. Failing loudly beats handing an
          // agent an interactive process that looks like a hang.
          throw new GigamanageError("`gm ask --json` needs a question.", {
            fix: 'Pass one: gm ask "what should I pick up?" --json',
            exitCode: 2,
          });
        }
        await repl(context, provider);
        return;
      }

      const answer = await provider.ask(buildAskPrompt(context, [], question));

      if (options.json) {
        process.stdout.write(
          `${jsonEnvelope(SCHEMA_VERSION, {
            answer,
            provider: provider.name,
            sessionCount: context.sessions.length,
            summarizedCount: summarizedCount(context),
          })}\n`,
        );
        return;
      }

      const notice = thinContextNotice(context);
      if (notice) process.stderr.write(`${yellow(notice)}\n`);
      process.stdout.write(`${answer}\n`);
    });
}
