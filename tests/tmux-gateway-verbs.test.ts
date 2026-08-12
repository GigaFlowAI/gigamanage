import { describe, expect, it } from "vitest";

import { PANE_FORMAT, parsePaneLine } from "../src/services/tmux.js";

describe("extended pane format", () => {
  it("carries window id and active flag", () => {
    expect(PANE_FORMAT).toContain("#{window_id}");
    expect(PANE_FORMAT).toContain("#{?pane_active,1,0}");
  });
  it("parses window id and active into TmuxPane", () => {
    // fields: paneId, left, top, width, height, cwd, command, pid, windowId, active
    const line = "%2\t0\t0\t80\t24\t/home/x\tnode\t4242\t@7\t1";
    const pane = parsePaneLine(line);
    expect(pane).not.toBeNull();
    expect(pane!.windowId).toBe("@7");
    expect(pane!.active).toBe(true);
  });
});
