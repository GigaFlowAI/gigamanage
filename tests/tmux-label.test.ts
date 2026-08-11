import { describe, expect, it } from "vitest";

import { paneLabel } from "../src/cli/tmux-label.js";
import type { SessionView } from "../src/core/types.js";

function view(project: string | null, headline: string | null): SessionView {
  return {
    record: {
      harness: "codex",
      sessionId: "s",
      filePath: "/f",
      cwd: "/repo",
      project,
      gitBranch: null,
      startedAt: null,
      updatedAt: "2026-08-11T00:00:00.000Z",
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
    },
    summary: headline
      ? {
          harness: "codex",
          sessionId: "s",
          sourceHash: "h",
          generatedAt: "2026-08-11T00:00:00.000Z",
          provider: "codex",
          headline,
          overview: "o",
          landed: "l",
          open: "",
          nextStep: "",
        }
      : null,
  };
}

describe("paneLabel", () => {
  it("shows `project — headline` for a summarised session", () => {
    expect(paneLabel(view("gigarepo", "Decoupling SIR credentials"))).toBe(
      "gigarepo — Decoupling SIR credentials",
    );
  });

  it("marks a resolved-but-unsummarised session with ○", () => {
    expect(paneLabel(view("gigarepo", null))).toBe("○ gigarepo");
  });

  it("is empty for an unresolved pane", () => {
    expect(paneLabel(null)).toBe("");
  });

  it("does not truncate — tmux clips to the pane width at render", () => {
    const long = "x".repeat(100);
    expect(paneLabel(view("proj", long))).toBe(`proj — ${long}`);
  });
});
