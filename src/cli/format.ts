/**
 * Rendering.
 *
 * Colour is applied only when stdout is a TTY and NO_COLOR is unset, so piping
 * `gm ls` into another program — or into an agent — yields clean text.
 */

import { cell, relativeAge, truncate } from "../core/text.js";
import type { SessionRecord, SessionSummary, SessionView } from "../core/types.js";

const useColor = (): boolean =>
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (code: string) => (text: string) => (useColor() ? `\x1b[${code}m${text}\x1b[0m` : text);

export const dim = wrap("2");
export const bold = wrap("1");
export const cyan = wrap("36");
export const yellow = wrap("33");
export const red = wrap("31");
export const green = wrap("32");

/** Marks a session that stopped mid-task — usually the one you want to resume. */
const MID_TASK = "⚠";
/**
 * Marks a row whose summary has not been written yet.
 *
 * One column, so a row that gains a summary does not shift the layout. It used
 * to be a dim `~`, which was invisible next to the yellow `⚠` — and now that
 * these rows are actively being summarized in the background, "pending" is a
 * state worth seeing rather than a defect worth hiding.
 */
const NO_SUMMARY = "○";

/** "repo/branch", or just "repo" when the branch adds nothing. */
export function sessionLabel(record: SessionRecord): string {
  const project = record.project ?? "?";
  return record.gitBranch ? `${project}/${record.gitBranch}` : project;
}

/**
 * One row of `gm ls`.
 *
 * Falls back through summary headline → harness title → last human prompt, so a
 * row is never blank even before any summary exists.
 */
export function formatRow(view: SessionView, now: Date = new Date()): string {
  const { record, summary } = view;
  const age = cell(relativeAge(record.updatedAt, now), 4);
  const id = record.sessionId.slice(0, 8);
  const where = cell(sessionLabel(record), 28);
  const flag = record.endedMidTask ? yellow(MID_TASK) : " ";
  const mark = summary ? " " : cyan(NO_SUMMARY);
  const text = summary?.headline ?? record.title ?? record.lastUserPrompt ?? "(no content)";

  return `${dim(id)} ${dim(age)} ${flag}${mark} ${cyan(where)} ${truncate(text, 72)}`;
}

/**
 * The footer under `gm ls`. Explains the two markers, and only the ones present.
 *
 * A legend nobody needs is noise, so an empty string means "print nothing".
 */
export function formatLegend(views: readonly SessionView[]): string {
  const parts: string[] = [];

  if (views.some((v) => v.record.endedMidTask)) {
    parts.push(`${yellow(MID_TASK)} ${dim("ended mid-task")}`);
  }

  const missing = views.filter((v) => !v.summary).length;
  if (missing > 0) {
    parts.push(`${cyan(NO_SUMMARY)} ${dim(`no summary yet (${missing})`)}`);
  }

  return parts.join(dim("   "));
}

/** The detail card shown by `gm show` and in the picker's preview pane. */
export function formatCard(view: SessionView, now: Date = new Date()): string {
  const { record, summary } = view;
  const lines: string[] = [];

  lines.push(
    bold(sessionLabel(record)),
    dim(`${record.harness} · ${record.sessionId} · ${relativeAge(record.updatedAt, now)} ago`),
  );
  lines.push("");

  if (summary) {
    lines.push(bold("WHERE IT LANDED"), indent(summary.landed || summary.headline), "");
    if (summary.open) lines.push(bold("STILL OPEN"), indent(summary.open), "");
    if (summary.nextStep) lines.push(bold("NEXT STEP"), indent(green(summary.nextStep)), "");
  } else {
    lines.push(
      dim("No summary yet — one is written in the background for recent sessions."),
      dim(`Want it now: gm summarize ${record.sessionId.slice(0, 8)}`),
      "",
    );
    if (record.title) lines.push(bold("TITLE (recorded at session start)"), indent(record.title), "");
  }

  if (record.lastUserPrompt) {
    lines.push(bold("LAST THING YOU SAID"), indent(`"${truncate(record.lastUserPrompt, 240)}"`), "");
  }

  if (record.filesTouched.length > 0) {
    const shown = record.filesTouched.slice(0, 6);
    const extra = record.filesTouched.length - shown.length;
    lines.push(
      bold("FILES TOUCHED"),
      ...shown.map((f) => `  ${f}`),
      ...(extra > 0 ? [dim(`  … and ${extra} more`)] : []),
      "",
    );
  }

  if (record.prLinks.length > 0) {
    const shown = record.prLinks.slice(0, 8);
    const extra = record.prLinks.length - shown.length;
    lines.push(
      bold("PULL REQUESTS"),
      ...shown.map((pr) => `  #${pr.number}  ${pr.url}`),
      ...(extra > 0 ? [dim(`  … and ${extra} more`)] : []),
      "",
    );
  }

  const facts: string[] = [`${record.messageCount} messages`, `${record.userPromptCount} prompts`];
  if (record.endedMidTask) facts.push(yellow("ended mid-task"));
  if (record.lastToolFailure) facts.push(red("last command failed"));
  lines.push(dim(facts.join("  ·  ")));

  if (record.cwd) lines.push(dim(record.cwd));

  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Stable JSON envelope. Everything machine-readable goes through here. */
export function jsonEnvelope<T>(schemaVersion: number, data: T): string {
  return JSON.stringify({ schemaVersion, data }, null, 2);
}
