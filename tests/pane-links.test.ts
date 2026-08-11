import { describe, expect, it, beforeEach } from "vitest";
import { rm } from "node:fs/promises";

import { paneLinksPath } from "../src/core/paths.js";
import {
  linkForPane,
  prunePaneLinks,
  readPaneLinks,
  writePaneLink,
} from "../src/services/pane-links.js";

describe("pane-links store", () => {
  beforeEach(async () => {
    await rm(paneLinksPath(), { force: true });
  });

  it("round-trips a written link", async () => {
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "abc" });
    expect(await readPaneLinks()).toEqual([
      { paneId: "%1", harness: "claude-code", sessionId: "abc" },
    ]);
  });

  it("replaces a pane's link rather than duplicating it", async () => {
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "old" });
    await writePaneLink({ paneId: "%1", harness: "claude-code", sessionId: "new" });
    const links = await readPaneLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.sessionId).toBe("new");
  });

  it("prunes links whose pane is no longer live", async () => {
    await writePaneLink({ paneId: "%1", harness: "codex", sessionId: "a" });
    await writePaneLink({ paneId: "%2", harness: "codex", sessionId: "b" });
    const kept = await prunePaneLinks(["%2"]);
    expect(kept.map((l) => l.paneId)).toEqual(["%2"]);
    expect((await readPaneLinks()).map((l) => l.paneId)).toEqual(["%2"]);
  });

  it("treats a missing or corrupt file as no links", async () => {
    expect(await readPaneLinks()).toEqual([]);
    expect(linkForPane([], "%9")).toBeNull();
  });
});
