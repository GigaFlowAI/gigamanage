/**
 * The ask box that sits at the bottom of the ctrl-g overlay. Pure string
 * layout — the command positions it on the popup and drives the keystrokes.
 */

/** Rows the ask box occupies at the bottom of the overlay. */
export const ASK_BOX_HEIGHT = 3;

const LABEL = "ask · Enter send · ^V report · ^R refresh · ^G/Esc close";

/**
 * The three lines of the ask box (top border, the input line, bottom border),
 * each clipped to `width`. A long input scrolls so its tail stays visible.
 *
 * When `status` is given (e.g. the work-report link after `^V`), it takes the
 * label's place on the top border — a full-width status bar that leaves the
 * cards and the input line untouched. The caller clears it back to null when the
 * user resumes typing, restoring the key legend.
 */
export function askBoxLines(input: string, width: number, status?: string | null): string[] {
  const w = Math.max(12, Math.floor(width));
  const inner = w - 2; // between the │ │ borders
  const heading = status && status.length > 0 ? status : LABEL;
  const dashes = Math.max(0, inner - heading.length - 3);
  const top = `╭─ ${heading} ${"─".repeat(dashes)}╮`.slice(0, w);

  const field = inner - 2; // inside "│ … │"
  const prompt = `> ${input}`;
  const shown = prompt.length > field ? prompt.slice(prompt.length - field) : prompt;
  const mid = `│ ${shown.padEnd(field, " ")} │`.slice(0, w);

  const bottom = `╰${"─".repeat(inner)}╯`.slice(0, w);
  return [top, mid, bottom];
}

/** The cursor's column (1-based) inside the input line, clamped to the field. */
export function askCursorColumn(input: string, width: number): number {
  const inner = Math.max(12, Math.floor(width)) - 2;
  const field = inner - 2;
  const prompt = `> ${input}`;
  const offset = Math.min(prompt.length, field);
  return 3 + offset; // "│ " is 2 cols, field starts at col 3
}
