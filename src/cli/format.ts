/**
 * Rendering.
 *
 * Colour is applied only when stdout is a TTY and NO_COLOR is unset, so piping
 * `gm ls` into another program — or into an agent — yields clean text.
 */

import { cell, relativeAge, truncate, wrapText } from "../core/text.js";
import type { SessionRecord, SessionSummary, SessionView } from "../core/types.js";

const useColor = (): boolean =>
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (code: string) => (text: string) => (useColor() ? `[${code}m${text}[0m` : text);

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
 * state worth seeing.
 */
const NO_SUMMARY = "○";

/** "repo/branch", or just "repo" when the branch adds nothing. */
export function sessionLabel(record: SessionRecord): string {
  const project = record.project ?? "?";
  return record.gitBranch ? `${project}/${record.gitBranch}` : project;
}

const WHERE_WIDTH = 28;
/** Never squeeze the description below this, however narrow the terminal. */
const MIN_TEXT_WIDTH = 24;

/** The description shown for a session: summary first, and never blank. */
function rowText(view: SessionView): string {
  const { record, summary } = view;
  return summary?.headline ?? record.title ?? record.lastUserPrompt ?? "(no content)";
}

/** The fixed-width columns before the description, coloured and plain. */
function rowPrefix(view: SessionView, now: Date): { colored: string; width: number } {
  const { record, summary } = view;
  const id = record.sessionId.slice(0, 8);
  const age = cell(relativeAge(record.updatedAt, now), 4);
  const where = cell(sessionLabel(record), WHERE_WIDTH);
  const flag = record.endedMidTask ? yellow(MID_TASK) : " ";
  const mark = summary ? " " : cyan(NO_SUMMARY);

  return {
    colored: `${dim(id)} ${dim(age)} ${flag}${mark} ${cyan(where)} `,
    // Measured from the plain text: colour codes take no screen columns.
    width: id.length + 1 + age.length + 1 + 2 + 1 + where.length + 1,
  };
}

/**
 * One row, on exactly one line.
 *
 * Used by the picker, where a session must occupy a single line — fzf maps lines
 * back to session ids, so a wrapped row would break selection.
 */
export function formatRow(view: SessionView, now: Date = new Date()): string {
  return `${rowPrefix(view, now).colored}${truncate(rowText(view), 72)}`;
}

/**
 * One row of `gm ls`, wrapped to the terminal so the whole description is
 * readable rather than chopped off at the right edge. Continuation lines are
 * indented to sit under the description column.
 *
 * Pass `width: Infinity` when the output is not a terminal: piped output should
 * be one line per session, so `gm ls | grep` behaves.
 */
export function formatRowLines(
  view: SessionView,
  now: Date = new Date(),
  width: number = terminalWidth(),
): string[] {
  const prefix = rowPrefix(view, now);
  const text = rowText(view);

  if (!Number.isFinite(width)) {
    return [`${prefix.colored}${text}`]; // Piped: one line, nothing lost.
  }

  const available = width - prefix.width;

  // On a terminal too narrow to hold the columns AND a readable description,
  // giving the description a sliver of a column would just overflow anyway.
  // Drop it onto its own indented lines instead.
  if (available < MIN_TEXT_WIDTH) {
    const indent = "  ";
    return [
      prefix.colored.trimEnd(),
      ...wrapText(text, Math.max(MIN_TEXT_WIDTH, width - indent.length)).map(
        (line) => `${indent}${line}`,
      ),
    ];
  }

  const [first = "", ...rest] = wrapText(text, available);
  const indent = " ".repeat(prefix.width);

  return [`${prefix.colored}${first}`, ...rest.map((line) => `${indent}${dim(line)}`)];
}

/**
 * The key under the list. Only mentions markers that actually appear, so a fully
 * summarized list carries no footer at all.
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

  return parts.join("   ");
}

/** Terminal width, or a sane default when we cannot tell. */
export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
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
      dim("No summary yet."),
      dim(`Run: gm summarize ${record.sessionId.slice(0, 8)}`),
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
