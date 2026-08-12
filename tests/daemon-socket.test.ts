// tests/daemon-socket.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspaceModel } from "../src/services/workspace.js";
import { ModelServer } from "../src/services/daemon-socket.js";

let server: ModelServer | undefined;
afterEach(async () => { await server?.stop(); });

describe("ModelServer", () => {
  it("streams a snapshot on change and writes the snapshot file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const sock = join(dir, "d.sock");
    const snap = join(dir, "snap.json");
    const model = new WorkspaceModel();
    server = new ModelServer(model, sock, snap);
    await server.start();

    const got = new Promise<string>((resolve) => {
      const c = connect(sock, () => {
        model.upsertIdentity({ paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 1 });
      });
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
        // Two NDJSON lines can arrive: the initial on-connect snapshot (empty
        // panes) and the on-change broadcast (with the pane), possibly
        // coalesced into the same "data" event. Resolve with the first
        // complete line that actually carries pane data.
        for (const l of buf.split("\n")) {
          if (l.length === 0) continue;
          const parsed: { panes: unknown[] } = JSON.parse(l);
          if (parsed.panes.length > 0) { resolve(l); c.end(); return; }
        }
      });
    });
    const line = await got;
    expect(JSON.parse(line.trim()).panes[0].identity.paneId).toBe("%1");
    // snapshot file also written
    expect(JSON.parse(readFileSync(snap, "utf8")).panes[0].identity.paneId).toBe("%1");
  });
});
