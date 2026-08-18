import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";

describe("FakeTmuxGateway organize verbs", () => {
  it("mints a window id and records newWindow", async () => {
    const gw = new FakeTmuxGateway();
    const windowId = await gw.newWindow("myproject");
    expect(windowId).toBe("@100");
    expect(gw.created).toEqual([{ windowId: "@100", name: "myproject" }]);
  });

  it("mints distinct ids across repeated newWindow/breakPane calls", async () => {
    const gw = new FakeTmuxGateway();
    const first = await gw.newWindow("a");
    const second = await gw.breakPane("%5", "b");
    expect(first).toBe("@100");
    expect(second).toBe("@101");
  });

  it("records renameWindow", async () => {
    const gw = new FakeTmuxGateway();
    await gw.renameWindow("@1", "shells");
    expect(gw.renamed).toEqual([{ windowId: "@1", name: "shells" }]);
  });

  it("records joinPane (move-pane)", async () => {
    const gw = new FakeTmuxGateway();
    await gw.joinPane("%3", "@2");
    expect(gw.joins).toEqual([{ srcPane: "%3", dst: "@2" }]);
  });

  it("records breakPane with and without a name", async () => {
    const gw = new FakeTmuxGateway();
    const windowId = await gw.breakPane("%7");
    expect(windowId).toBe("@100");
    expect(gw.breaks).toEqual([{ pane: "%7", windowId: "@100", name: undefined }]);

    const namedId = await gw.breakPane("%8", "solo");
    expect(namedId).toBe("@101");
    expect(gw.breaks[1]).toEqual({ pane: "%8", windowId: "@101", name: "solo" });
  });

  it("records swapPane", async () => {
    const gw = new FakeTmuxGateway();
    await gw.swapPane("%1", "%2");
    expect(gw.swaps).toEqual([{ a: "%1", b: "%2" }]);
  });

  it("records selectLayout", async () => {
    const gw = new FakeTmuxGateway();
    await gw.selectLayout("@1", "tiled");
    expect(gw.layouts).toEqual([{ windowId: "@1", layout: "tiled" }]);
  });

  it("keeps listPanes visible for validation via setPanes", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "node", pid: 10, windowId: "@1", active: true },
    ]);
    expect((await gw.listPanes()).map((p) => p.paneId)).toEqual(["%1"]);
  });
});
