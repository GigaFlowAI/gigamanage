/**
 * Summaries: the layer that answers "where did this land, and what's next?".
 *
 * The provider is a plain CLI invoked with the distilled prompt on stdin. That
 * keeps gigamanage harness-agnostic — it ships pointing at `claude -p`, but
 * GIGAMANAGE_SUMMARY_CMD can point it at `codex exec` or anything else that
 * reads a prompt and writes text.
 *
 * Summaries are cached by content hash and regenerated only when the session
 * itself changes, so each one is written once and re-read forever.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SummaryProviderError } from "../core/errors.js";
import { summaryPath } from "../core/paths.js";
import type {
  SessionRecord,
  SessionSummary,
  SummaryFields,
  SummaryInput,
  SummaryProvider,
} from "../core/types.js";
import { buildPrompt, distill } from "./distill.js";
import { mapLimit } from "./concurrency.js";

/**
 * How many summaries are written at once.
 *
 * Each is an independent `claude -p`; they do not contend. Eight keeps a
 * twenty-session backfill down to a few wall-clock minutes instead of twenty.
 */
const SUMMARY_CONCURRENCY = Number(process.env["GIGAMANAGE_SUMMARY_CONCURRENCY"]) || 8;
const PROVIDER_TIMEOUT_MS = 120_000;

/** Default provider: whatever GIGAMANAGE_SUMMARY_CMD names, else `claude -p`. */
export function defaultProviderCommand(): string[] {
  const override = process.env.GIGAMANAGE_SUMMARY_CMD;
  if (override && override.trim() !== "") return override.trim().split(/\s+/);
  return ["claude", "-p"];
}

export class CliSummaryProvider implements SummaryProvider {
  readonly name: string;
  private readonly argv: string[];

  constructor(argv: string[] = defaultProviderCommand()) {
    this.argv = argv;
    this.name = argv.join(" ");
  }

  async isAvailable(): Promise<boolean> {
    const binary = this.argv[0];
    if (!binary) return false;
    return new Promise((resolve) => {
      const probe = spawn("which", [binary], { stdio: "ignore" });
      probe.on("close", (code) => resolve(code === 0));
      probe.on("error", () => resolve(false));
    });
  }

  async generate(input: SummaryInput): Promise<SummaryFields> {
    const prompt = buildPrompt(input);
    const output = await this.run(prompt);
    return parseSummaryFields(output, this.name);
  }

  private run(prompt: string): Promise<string> {
    const [binary, ...args] = this.argv;
    return new Promise((resolve, reject) => {
      const child = spawn(binary!, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new SummaryProviderError(this.name, `timed out after ${PROVIDER_TIMEOUT_MS}ms`));
      }, PROVIDER_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new SummaryProviderError(this.name, error.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new SummaryProviderError(this.name, stderr.trim() || `exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * Pull the JSON object out of a model's reply.
 *
 * Models fence their JSON, or preface it, more often than they should — so we
 * take the outermost brace pair rather than trusting the whole reply to parse.
 */
export function parseSummaryFields(raw: string, provider: string): SummaryFields {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new SummaryProviderError(provider, "reply contained no JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new SummaryProviderError(provider, `reply was not valid JSON: ${(error as Error).message}`);
  }

  const object = parsed as Record<string, unknown>;
  const field = (key: string): string => {
    const value = object[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const headline = field("headline");
  if (headline === "") throw new SummaryProviderError(provider, "reply had no `headline`");

  return {
    headline,
    landed: field("landed"),
    open: field("open"),
    nextStep: field("nextStep"),
  };
}

export async function readSummary(record: SessionRecord): Promise<SessionSummary | null> {
  try {
    const raw = await readFile(summaryPath(record.harness, record.sessionId), "utf8");
    return JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
}

/** A cached summary is stale once the session it describes has moved on. */
export function isStale(summary: SessionSummary | null, record: SessionRecord): boolean {
  if (!summary) return true;
  return summary.sourceHash !== distill(record).hash;
}

export async function writeSummary(summary: SessionSummary): Promise<void> {
  const path = summaryPath(summary.harness, summary.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2), "utf8");
}

/** Generate a summary for one session and cache it. */
export async function summarizeSession(
  record: SessionRecord,
  provider: SummaryProvider,
  now: () => Date = () => new Date(),
): Promise<SessionSummary> {
  const input = distill(record);
  const fields = await provider.generate(input);
  const summary: SessionSummary = {
    harness: record.harness,
    sessionId: record.sessionId,
    sourceHash: input.hash,
    generatedAt: now().toISOString(),
    provider: provider.name,
    ...fields,
  };
  await writeSummary(summary);
  return summary;
}

export interface SummarizeBatchResult {
  generated: number;
  skipped: number;
  failed: { sessionId: string; reason: string }[];
}

/**
 * Summarize many sessions, skipping those whose cached summary is still fresh.
 * Failures are collected rather than thrown: one bad session must not abort a
 * batch of fifty.
 */
export async function summarizeBatch(
  records: readonly SessionRecord[],
  provider: SummaryProvider,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<SummarizeBatchResult> {
  const result: SummarizeBatchResult = { generated: 0, skipped: 0, failed: [] };
  let done = 0;

  await mapLimit(records, SUMMARY_CONCURRENCY, async (record) => {
    try {
      if (!options.force) {
        const existing = await readSummary(record);
        if (!isStale(existing, record)) {
          result.skipped += 1;
          return;
        }
      }
      await summarizeSession(record, provider);
      result.generated += 1;
    } catch (error) {
      result.failed.push({ sessionId: record.sessionId, reason: (error as Error).message });
    } finally {
      done += 1;
      options.onProgress?.(done, records.length);
    }
  });

  return result;
}
