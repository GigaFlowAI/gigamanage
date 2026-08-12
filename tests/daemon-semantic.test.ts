import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import type { Sensor } from "../src/services/sensors.js";

const pane = { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true };
class S implements Sensor { readonly kind = "terminal" as const; constructor(private id: { paneId: string }) {}
  async observe(now: number) { return { paneId: this.id.paneId, kind: "terminal" as const, ts: now, tailLines: ["busy"], lastActivityTs: now }; }
  async teardown() {} }

describe("daemon feeds the semantic worker without blocking", () => {
  it("keeps state fresh even when the label provider hangs", async () => {
    const gw = new FakeTmuxGateway(); gw.setPanes([pane]);
    const model = new WorkspaceModel();
    const provider: LabelProvider = { label: () => new Promise(() => {}) }; // never resolves
    const worker = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }));
    const d = new Daemon({ gateway: gw, model, now: () => 100_000, makeSensor: (id) => new S(id), semantic: worker });
    await d.tickOnce();
    // Fast path recorded state despite the hung LLM.
    expect(model.snapshot().panes[0]!.state).toBe("working");
    expect(model.snapshot().panes[0]!.semantics).toBeNull();
  });
});
