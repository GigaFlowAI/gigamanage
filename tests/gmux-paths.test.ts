import { describe, expect, it, beforeEach } from "vitest";
import { gmuxSocketPath, gmuxSnapshotPath, paneLogPath } from "../src/core/paths.js";

describe("gmux paths", () => {
  beforeEach(() => { process.env.XDG_CACHE_HOME = "/tmp/xdgcache"; });
  it("socket, snapshot and pane logs live under the gmux cache", () => {
    expect(gmuxSocketPath()).toBe("/tmp/xdgcache/gmux/gmux/daemon.sock");
    expect(gmuxSnapshotPath()).toBe("/tmp/xdgcache/gmux/gmux/snapshot.json");
    expect(paneLogPath("%3")).toBe("/tmp/xdgcache/gmux/gmux/panes/pane-3.log");
  });
});
