import type { Command } from "commander";

import type { AskProvider, AskTurn, SessionView } from "../../core/types.js";
import { buildAskContext, buildAskPrompt, defaultAskProvider } from "../../services/ask.js";
import { inProgressIds, maybeAutoSummarize } from "../../services/auto-summarize.js";
import { prunePaneLinks } from "../../services/pane-links.js";
import { listPanes } from "../../services/tmux.js";
import { resolvePanesLive, type ResolvedPane } from "../../services/tmux-resolve.js";
import { attachSummaries, loadCachedRecords, loadRecords } from "../../services/views.js";
import { renderOverlay, type OverlayCell } from "../overlay.js";
import { ASK_BOX_HEIGHT, askBoxLines, askContentLines, askCursorColumn } from "../overlay-ask.js";

/** How often the overlay repaints while it waits, to fold in landed refreshes. */
const REPAINT_MS = 1000;

/**
 * Pair each resolved pane with its summary view and the in-flight refresh set.
 * Pure, so the pairing is tested without a terminal.
 */
export function buildCells(
  resolved: readonly ResolvedPane[],
  views: readonly SessionView[],
  refreshingIds: ReadonlySet<string>,
): OverlayCell[] {
  const bySession = new Map(views.map((v) => [v.record.sessionId, v]));
  return resolved.map(({ pane, record }) => ({
    pane,
    view: record ? bySession.get(record.sessionId) ?? { record, summary: null } : null,
    refreshing: record ? refreshingIds.has(record.sessionId) : false,
  }));
}

const rows = (): number => process.stdout.rows || 24;
const cols = (): number => process.stdout.columns || 80;

/** The card frame for the resolved panes — re-reads only the (small) summaries. */
async function cardsFrame(resolved: readonly ResolvedPane[]): Promise<string> {
  const present = resolved
    .map((r) => r.record)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const views = await attachSummaries(present);
  const refreshing = await inProgressIds();
  return renderOverlay(buildCells(resolved, views, refreshing));
}

/** The ask box drawn across the bottom rows, with the cursor left in the field. */
function boxFrame(input: string): string {
  const top = rows() - ASK_BOX_HEIGHT + 1; // 1-based first box row
  let out = "";
  askBoxLines(input, cols()).forEach((line, i) => {
    out += `\x1b[${top + i};1H${line}`;
  });
  out += `\x1b[${top + 1};${askCursorColumn(input, cols())}H`; // cursor into the input line
  return out;
}

/** The state of the in-overlay chat. */
interface AskState {
  input: string;
  question: string | null;
  answer: string | null;
  thinking: boolean;
}

async function runOverlay(windowId: string): Promise<void> {
  // A peek must feel instant. We reach this command only because `display-popup`
  // launched it, which already proves tmux >= 3.2. Resolve ONCE from the cache;
  // repaints re-read only summaries, so an open overlay is not re-scanning
  // thousands of files every second.
  const panes = await listPanes(windowId);
  const links = await prunePaneLinks(panes.map((p) => p.paneId));
  let resolved = await resolvePanesLive(panes, await loadCachedRecords(), links);

  const state: AskState = { input: "", question: null, answer: null, thinking: false };
  const turns: AskTurn[] = [];
  let provider: AskProvider | null = null;
  void defaultAskProvider()
    .then((p) => (provider = p))
    .catch(() => {});

  // Redraw the whole popup: cards (or the conversation) above, the ask box below.
  const drawAll = async (): Promise<void> => {
    const contentRows = rows() - ASK_BOX_HEIGHT;
    let out = "\x1b[2J\x1b[H";
    if (state.question || state.thinking || state.answer) {
      askContentLines(state.question, state.answer, state.thinking, contentRows, cols()).forEach(
        (line, i) => (out += `\x1b[${i + 1};1H${line}`),
      );
    } else {
      out += await cardsFrame(resolved);
    }
    process.stdout.write(out + boxFrame(state.input));
  };

  await drawAll();

  // Off the critical path: upgrade to the full index, re-resolve, and kick stale
  // cards to refresh in the background — targeting exactly the panes on screen.
  void (async () => {
    const records = await loadRecords();
    resolved = await resolvePanesLive(panes, records, links);
    if (!state.question && !state.thinking && !state.answer) await drawAll();
    const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
    await maybeAutoSummarize({ records: present, force: true });
  })().catch(() => {});

  // Repaint the cards while browsing (not while a conversation owns the screen).
  const timer = setInterval(() => {
    if (!state.question && !state.thinking && !state.answer) void drawAll().catch(() => {});
  }, REPAINT_MS);

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  await new Promise<void>((done) => {
    stdin.on("data", (buf: Buffer) => {
      void (async () => {
        if (state.thinking) return; // ignore input while a question is in flight
        const s = buf.toString();

        if (s === "\x1b" || s === "\x03" || s === "\x04") return done(); // Esc / ctrl-c / ctrl-d
        if (s.startsWith("\x1b")) return; // an arrow or other escape sequence — ignore

        if (s === "\r" || s === "\n") {
          const question = state.input.trim();
          if (!question) return;
          state.question = question;
          state.input = "";
          if (!provider) {
            state.answer = "No model configured. Run `gm setup` to choose one.";
            await drawAll();
            return;
          }
          state.thinking = true;
          state.answer = null;
          await drawAll();
          try {
            const present = resolved.map((r) => r.record).filter((r): r is NonNullable<typeof r> => r !== null);
            const context = buildAskContext(await attachSummaries(present), null, Math.max(present.length, 1));
            const answer = await provider.ask(buildAskPrompt(context, turns, question));
            turns.push({ question, answer });
            state.answer = answer;
          } catch (error) {
            state.answer = `ask failed: ${(error as Error).message}`;
          }
          state.thinking = false;
          await drawAll();
          return;
        }

        if (s === "\x7f" || s === "\b") {
          state.input = state.input.slice(0, -1);
          process.stdout.write(boxFrame(state.input));
          return;
        }

        const printable = [...s].filter((c) => c >= " " && c <= "~").join("");
        if (printable) {
          state.input += printable;
          process.stdout.write(boxFrame(state.input));
        }
      })().catch(() => {});
    });
  });

  clearInterval(timer);
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

export function registerOverlay(program: Command): void {
  program
    .command("overlay <window>")
    .description("draw every pane's summary in place (used by the tmux ctrl-g binding)")
    .action(async (windowId: string) => {
      await runOverlay(windowId);
    });
}
