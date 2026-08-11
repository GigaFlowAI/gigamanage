/**
 * Draw every pane's summary card in place. Pure: given resolved cells and the
 * clock, produce one string of ANSI cursor moves that paints a full-screen
 * overlay. The command layer supplies the cells and the terminal; nothing here
 * reads tmux, stdin, or the clock on its own.
 *
 * A compact sibling of `formatCard`: same summary fields and section names,
 * sized to a rectangle with a degradation ladder — full card, then title +
 * what-landed, then just the title, then a muted placeholder for a pane with no
 * agent. Monochrome: the structure is carried by layout, so it survives a pane
 * that cannot render colour.
 */

import { relativeAge, truncate, wrapText } from "../core/text.js";
import type { SessionView, TmuxPane } from "../core/types.js";
import { indent, sessionLabel } from "./format.js";

export interface OverlayCell {
  pane: TmuxPane;
  /** null when the pane runs no resolvable agent. */
  view: SessionView | null;
  /** True while a background refresh for this session is in flight. */
  refreshing: boolean;
}

const CLEAR = "\x1b[2J\x1b[H";

/**
 * When the summary last landed, and whether one is regenerating now — shown
 * together, so a card that says `refreshing…` still tells you how old the summary
 * you're reading is.
 */
function freshnessLine(cell: OverlayCell, now: Date): string {
  const summary = cell.view?.summary;
  const age = summary ? `updated ${relativeAge(summary.generatedAt, now)} ago` : "no summary yet";
  return cell.refreshing ? `refreshing… · ${age}` : age;
}

function section(label: string, body: string, width: number): string[] {
  if (!body) return [];
  const wrapped = wrapText(body, Math.max(1, width - 2)).map((l) => indent(l));
  return [label, ...wrapped, ""];
}

function placeholder(cell: OverlayCell, width: number, height: number): string[] {
  const lines = ["· no agent here ·"];
  if (height > 1) lines.push(truncate(cell.pane.command, width));
  return lines.slice(0, Math.max(1, height));
}

export function cellLines(cell: OverlayCell, width: number, height: number, now: Date): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  if (!cell.view) return placeholder(cell, w, h);

  const { record, summary } = cell.view;
  const title = truncate(sessionLabel(record), w);
  if (h <= 1) return [title];

  const fresh = freshnessLine(cell, now);
  const landed = summary?.landed || summary?.headline || record.lastUserPrompt || "";

  if (h <= 4) {
    const lines = [title];
    if (h >= 3) lines.push(...wrapText(landed, w).slice(0, h - 2));
    lines.push(fresh);
    return lines.slice(0, h);
  }

  const body: string[] = [title];
  if (record.endedMidTask) body.push("⚠ ended mid-task");
  body.push(fresh, "");

  if (summary) {
    // Widening zoom: the headline (scannable clause) leads, then the overview,
    // then the paragraph-or-two summary, then the status fields. `section` drops
    // any that are empty, so a pre-0.10.0 summary with no `summary` just skips it.
    body.push(...section("HEADLINE", summary.headline, w));
    body.push(...section("OVERVIEW", summary.overview, w));
    body.push(...section("SUMMARY", summary.summary ?? "", w));
    body.push(...section("RECENT WORK", summary.landed, w));
    body.push(...section("STILL OPEN", summary.open, w));
    body.push(...section("NEXT STEP", summary.nextStep, w));
  } else {
    body.push("no summary yet — gm summarize " + record.sessionId.slice(0, 8));
  }

  return body.slice(0, h);
}

/**
 * Strip C0 control bytes and DEL — including ESC (0x1b) — from untrusted card
 * text. Summary fields, prompts and pane commands all originate outside this
 * process; a stray control byte among them could otherwise move the cursor out
 * of the pane's rectangle (absolute positioning) or emit an OSC sequence to the
 * terminal. Replaced with a space rather than dropped, so columns still line up.
 */
function sanitize(line: string): string {
  return line.replace(/[\x00-\x1f\x7f]/g, " ");
}

/** Clip one line to `width` display columns (no wrapping — the card already wrapped). */
function clip(line: string, width: number): string {
  const clean = sanitize(line);
  return clean.length > width ? clean.slice(0, width) : clean;
}

/**
 * A box outline around a pane's rectangle, so adjacent cards read as separate
 * panes rather than one blur of text. Drawn with box-drawing glyphs at absolute
 * coordinates; the card content is inset one cell inside it. `left`/`top` are
 * 0-based (tmux geometry); terminal coordinates are 1-based.
 */
function borderBox(left: number, top: number, width: number, height: number): string[] {
  const out: string[] = [];
  const inner = "─".repeat(Math.max(0, width - 2));
  const colLeft = left + 1;
  const colRight = left + width;
  const rowTop = top + 1;
  const rowBottom = top + height;
  out.push(`\x1b[${rowTop};${colLeft}H┌${inner}┐`);
  for (let row = rowTop + 1; row <= rowBottom - 1; row++) {
    out.push(`\x1b[${row};${colLeft}H│`);
    out.push(`\x1b[${row};${colRight}H│`);
  }
  out.push(`\x1b[${rowBottom};${colLeft}H└${inner}┘`);
  return out;
}

export function renderOverlay(cells: readonly OverlayCell[], now: Date = new Date()): string {
  const out: string[] = [CLEAR];
  for (const cell of cells) {
    const { left, top, width, height } = cell.pane;

    // Big enough for a frame with at least a 1×1 interior: draw the border and
    // inset the card by one cell on every side.
    if (width >= 3 && height >= 3) {
      out.push(...borderBox(left, top, width, height));
      const lines = cellLines(cell, width - 2, height - 2, now);
      lines.forEach((line, i) => {
        out.push(`\x1b[${top + 2 + i};${left + 2}H${clip(line, width - 2)}`);
      });
      continue;
    }

    // Too small to frame — just paint the content at the pane origin.
    const lines = cellLines(cell, width, height, now);
    lines.forEach((line, i) => {
      out.push(`\x1b[${top + i + 1};${left + 1}H${clip(line, width)}`);
    });
  }
  return out.join("");
}
