import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorkViewPrompt,
  extractFragment,
  isStale,
  readWorkView,
  workViewSourceHash,
  writeWorkView,
  type WorkView,
} from "../src/services/work-view.js";
import { distill } from "../src/services/distill.js";
import type { SessionRecord } from "../src/core/types.js";

const record: SessionRecord = {
  harness: "claude-code", sessionId: "s1", filePath: "/x.jsonl", cwd: "/w/shop",
  project: "shop", gitBranch: "main", startedAt: null, updatedAt: "2026-08-18T00:00:00Z",
  messageCount: 4, userPromptCount: 2, title: "start", lastUserPrompt: "ship it",
  recentUserPrompts: ["ship it"], arcPrompts: ["add auth", "ship it"], filesTouched: ["a.ts"],
  prLinks: [], lastAssistantText: "opened PR #7", lastToolFailure: null,
  endedMidTask: false, isSidechain: false, isAutomated: false,
};

describe("extractFragment", () => {
  it("strips a ```html fence", () => {
    expect(extractFragment("```html\n<svg><rect/></svg>\n```")).toBe("<svg><rect/></svg>");
  });
  it("accepts a bare fragment", () => {
    expect(extractFragment("  <div>hi</div>  ")).toBe("<div>hi</div>");
  });
  it("rejects text with no HTML tag", () => {
    expect(() => extractFragment("sorry, I cannot")).toThrow();
  });
});

describe("buildWorkViewPrompt", () => {
  it("asks for a self-contained HTML fragment and includes session evidence", () => {
    const p = buildWorkViewPrompt(distill(record));
    expect(p.toLowerCase()).toContain("html");
    expect(p).toContain("opened PR #7"); // final message flows in
    expect(p.toLowerCase()).toContain("no <script"); // forbids scripts / external refs
  });
});

describe("cache staleness", () => {
  it("is stale with no view, fresh when the source hash matches", () => {
    expect(isStale(null, record)).toBe(true);
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<i/>",
    };
    expect(isStale(view, record)).toBe(false);
    expect(isStale({ ...view, sourceHash: "different" }, record)).toBe(true);
  });
});

describe("read/write round-trip", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "gmux-wv-")); process.env.XDG_CACHE_HOME = dir; });
  afterEach(() => { delete process.env.XDG_CACHE_HOME; });
  it("writes then reads the same view", async () => {
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<b>x</b>",
    };
    await writeWorkView(view);
    expect(await readWorkView(record)).toEqual(view);
  });
  it("returns null when the cache file is absent", async () => {
    expect(await readWorkView({ ...record, sessionId: "missing" })).toBeNull();
  });
});
