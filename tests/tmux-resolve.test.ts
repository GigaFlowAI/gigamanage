import { describe, expect, it } from "vitest";

import type { PaneLink, SessionRecord, TmuxPane } from "../src/core/types.js";
import { harnessForCommand, resolvePaneToRecord } from "../src/services/tmux-resolve.js";

function record(over: Partial<SessionRecord>): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "s",
    filePath: "/f",
    cwd: "/repo",
    project: "repo",
    gitBranch: null,
    startedAt: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    messageCount: 1,
    userPromptCount: 1,
    title: null,
    lastUserPrompt: null,
    recentUserPrompts: [],
    arcPrompts: [],
    filesTouched: [],
    prLinks: [],
    lastAssistantText: null,
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...over,
  };
}

function pane(over: Partial<TmuxPane>): TmuxPane {
  return { paneId: "%1", left: 0, top: 0, width: 40, height: 20, cwd: "/repo", command: "claude", ...over };
}

describe("harnessForCommand", () => {
  it("maps a distinctive command to its harness", () => {
    expect(harnessForCommand("claude")).toBe("claude-code");
    expect(harnessForCommand("codex")).toBe("codex");
  });
  it("returns null for a non-distinctive command", () => {
    expect(harnessForCommand("node")).toBeNull();
    expect(harnessForCommand("zsh")).toBeNull();
  });
});

describe("resolvePaneToRecord", () => {
  const links: PaneLink[] = [{ paneId: "%1", harness: "codex", sessionId: "exact" }];

  it("prefers an explicit link over the heuristic", () => {
    const records = [record({ sessionId: "exact", harness: "codex", cwd: "/other" }), record({ sessionId: "newer", cwd: "/repo" })];
    expect(resolvePaneToRecord(pane({}), records, links)!.sessionId).toBe("exact");
  });

  it("falls back to the newest session in the pane's cwd", () => {
    const records = [
      record({ sessionId: "old", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "new", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
      record({ sessionId: "elsewhere", cwd: "/other", updatedAt: "2026-08-10T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2" }), records, [])!.sessionId).toBe("new");
  });

  it("prefers the harness the command points to when the cwd is shared", () => {
    const records = [
      record({ sessionId: "cc", harness: "claude-code", cwd: "/repo", updatedAt: "2026-08-01T00:00:00.000Z" }),
      record({ sessionId: "cx", harness: "codex", cwd: "/repo", updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    expect(resolvePaneToRecord(pane({ paneId: "%2", command: "claude" }), records, [])!.sessionId).toBe("cc");
  });

  it("returns null when nothing matches the cwd", () => {
    const records = [record({ cwd: "/other" })];
    expect(resolvePaneToRecord(pane({ paneId: "%2", cwd: "/nope" }), records, [])).toBeNull();
  });
});
