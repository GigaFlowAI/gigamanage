import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/cli/commands/cockpit.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";

const snap: WorkspaceSnapshot = { version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] };

describe("cockpit buildFrame", () => {
  it("clears the screen and shows the pane count", () => {
    const frame = buildFrame(snap, 0);
    expect(frame).toContain("\x1b[2J"); // clear
    expect(frame).toContain("gmux — 0 panes");
  });
});
