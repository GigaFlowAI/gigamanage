import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";

describe("FakeTmuxGateway", () => {
  it("serves scripted panes and records send-keys", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "node", pid: 10, windowId: "@1", active: true }]);
    expect((await gw.listPanes()).map((p) => p.paneId)).toEqual(["%1"]);
    await gw.send("%1", "hello");
    expect(gw.sent).toEqual([{ paneId: "%1", keys: "hello" }]);
  });
  it("tracks piped panes", async () => {
    const gw = new FakeTmuxGateway();
    await gw.startPipe("%1", "/tmp/p.log");
    expect(gw.piped.has("%1")).toBe(true);
    await gw.stopPipe("%1");
    expect(gw.piped.has("%1")).toBe(false);
  });
});
