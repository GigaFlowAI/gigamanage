import { describe, expect, it } from "vitest";
import { renderCockpit } from "../src/cli/gmux-render.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";

const snap: WorkspaceSnapshot = { version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] };

describe("staleness banner", () => {
  it("shows a not-connected banner when stale", () => {
    const lines = renderCockpit(snap, 0, { stale: { ageMs: 8000 } });
    expect(lines[0]).toContain("daemon not connected");
    expect(lines[0]).toContain("8s ago");
  });
  it("no banner when live", () => {
    expect(renderCockpit(snap, 0).join("\n")).not.toContain("daemon not connected");
  });
});
