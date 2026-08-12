import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { runDaemonLoop } from "../src/cli/commands/daemon.js";

describe("runDaemonLoop", () => {
  it("ticks until aborted", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true }]);
    const model = new WorkspaceModel();
    const ac = new AbortController();
    let ticks = 0;
    const done = runDaemonLoop(
      { gateway: gw, model, now: () => 100_000, makeSensor: undefined },
      { tickMs: 1, signal: ac.signal, onTick: () => { if (++ticks >= 3) ac.abort(); } },
    );
    await done;
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(model.snapshot().panes).toHaveLength(1);
  });
});
