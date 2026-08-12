import { describe, expect, it } from "vitest";
import { parsePsOutput, subtreeRss } from "../src/core/proc-tree.js";

const raw = [
  "  PID  PPID    RSS COMM",
  "  100     1   1000 zsh",
  "  200   100   2000 node",
  "  300   200   4000 esbuild",
  "  400     1   8000 Slack",
].join("\n");

describe("proc-tree", () => {
  it("parses rss from KB to bytes", () => {
    const rows = parsePsOutput(raw);
    expect(rows.find((r) => r.pid === 200)!.rss).toBe(2000 * 1024);
  });
  it("sums a subtree including grandchildren", () => {
    const rows = parsePsOutput(raw);
    // 100 + 200 + 300 = (1000+2000+4000) KB
    expect(subtreeRss(100, rows)).toBe((1000 + 2000 + 4000) * 1024);
  });
  it("excludes unrelated processes from a subtree", () => {
    const rows = parsePsOutput(raw);
    expect(subtreeRss(200, rows)).toBe((2000 + 4000) * 1024); // not Slack
  });
});
