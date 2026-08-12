import { describe, expect, it, vi } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import type { PaneIdentity } from "../src/core/gmux-types.js";

const ident: PaneIdentity = {
  paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 10,
};

describe("WorkspaceModel", () => {
  it("bumps version and emits on state change", () => {
    const m = new WorkspaceModel();
    const onChange = vi.fn();
    m.on("change", onChange);
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    expect(m.version).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.state).toBe("working");
  });
  it("does not emit when state is unchanged", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    m.applyState("%1", "working", 1000, 2000); // same state, same activity
    expect(m.version).toBe(v);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("evicts gone panes", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.markGone("%1");
    m.evictGone();
    expect(m.snapshot().panes).toHaveLength(0);
  });
});
