import { describe, expect, it } from "vitest";
import { ResourceMonitor } from "../src/services/resources.js";

const psOut = [
  "  PID  PPID    RSS COMM",
  "  100     1   1000 zsh", // pane %1 shell
  "  200   100   3000 node", // child of %1
  "  500     1   9000 Chrome",
].join("\n");

describe("ResourceMonitor", () => {
  it("attributes subtree RSS per pane and computes unattributed", async () => {
    const mon = new ResourceMonitor({
      psSnapshot: async () => psOut,
      hostMemory: async () => ({ usedRatio: 0.5, usedBytes: 20_000 * 1024 }),
    });
    const { perPane, host } = await mon.sample(new Map([["%1", 100]]));
    expect(perPane.get("%1")!.perPaneRss).toBe((1000 + 3000) * 1024);
    expect(host.usedRatio).toBe(0.5);
    // 20000 - (1000+3000) = 16000 KB unattributed
    expect(host.unattributed).toBe(16_000 * 1024);
  });
});
