import { describe, expect, it } from "vitest";

import type { SessionView, TmuxPane } from "../src/core/types.js";
import { cellLines, renderOverlay, type OverlayCell } from "../src/cli/overlay.js";

const NOW = new Date("2026-08-10T00:05:00.000Z");

interface ViewOverrides {
  updatedAt?: string;
  headline?: string;
  overview?: string;
  landed?: string;
  open?: string;
  nextStep?: string;
}

function view(over: ViewOverrides = {}): SessionView {
  return {
    record: {
      harness: "claude-code",
      sessionId: "abcdef12",
      filePath: "/f",
      cwd: "/repo",
      project: "webshop",
      gitBranch: null,
      startedAt: null,
      updatedAt: over.updatedAt ?? "2026-08-10T00:00:00.000Z",
      messageCount: 1,
      userPromptCount: 1,
      title: null,
      lastUserPrompt: "do the thing",
      recentUserPrompts: [],
      arcPrompts: [],
      filesTouched: [],
      prLinks: [],
      lastAssistantText: null,
      lastToolFailure: null,
      endedMidTask: false,
      isSidechain: false,
      isAutomated: false,
    },
    summary: {
      harness: "claude-code",
      sessionId: "abcdef12",
      sourceHash: "h",
      generatedAt: "2026-08-10T00:00:00.000Z",
      provider: "claude -p",
      headline: "retry fix landed",
      overview: "Making webhook retries reliable.",
      landed: "retry backoff added",
      open: "timestamp check still red",
      nextStep: "write the timestamp test",
      ...over,
    },
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", ...over };
}

describe("cellLines degradation ladder", () => {
  it("renders a placeholder when there is no agent", () => {
    const lines = cellLines({ pane: pane({}), view: null, refreshing: false }, 40, 20, NOW);
    expect(lines.join("\n")).toContain("no agent here");
  });

  it("title only when the cell is one row", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 1, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("webshop");
  });

  it("title + landed at small heights", () => {
    const lines = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 3, NOW);
    const text = lines.join("\n");
    expect(text).toContain("webshop");
    expect(text).toContain("retry backoff added");
  });

  it("full card includes every section at full height", () => {
    const text = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 20, NOW).join("\n");
    expect(text).toContain("OVERALL");
    expect(text).toContain("RECENT WORK");
    expect(text).toContain("STILL OPEN");
    expect(text).toContain("NEXT STEP");
  });

  it("shows the mid-task flag", () => {
    const v = view();
    v.record.endedMidTask = true;
    const text = cellLines({ pane: pane({}), view: v, refreshing: false }, 40, 20, NOW).join("\n");
    expect(text).toContain("⚠");
  });

  it("shows a freshness age, or 'refreshing…' while a refresh is in flight", () => {
    const stale = cellLines({ pane: pane({}), view: view(), refreshing: false }, 40, 20, NOW).join("\n");
    expect(stale).toContain("5m ago");
    const busy = cellLines({ pane: pane({}), view: view(), refreshing: true }, 40, 20, NOW).join("\n");
    expect(busy).toContain("refreshing");
  });
});

describe("renderOverlay positioning", () => {
  it("clears the screen and positions each card at its pane origin", () => {
    const cells: OverlayCell[] = [
      { pane: pane({ paneId: "%1", left: 0, top: 0, width: 20, height: 10 }), view: view(), refreshing: false },
      { pane: pane({ paneId: "%2", left: 21, top: 0, width: 20, height: 10 }), view: null, refreshing: false },
    ];
    const out = renderOverlay(cells, NOW);
    expect(out.startsWith("\x1b[2J\x1b[H")).toBe(true);
    // First card's first line sits at row 1, col 1.
    expect(out).toContain("\x1b[1;1H");
    // Second card starts at col 22 (left 21 + 1).
    expect(out).toContain("\x1b[1;22H");
  });
});
