import { describe, expect, it } from "vitest";

import { ASK_BOX_HEIGHT, askBoxLines, askCursorColumn } from "../src/cli/overlay-ask.js";

describe("askBoxLines", () => {
  it("is a three-line box, each clipped to the width", () => {
    const lines = askBoxLines("hi", 40);
    expect(lines).toHaveLength(ASK_BOX_HEIGHT);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(40);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[2]!.startsWith("╰")).toBe(true);
  });

  it("shows the input after a prompt", () => {
    expect(askBoxLines("what's urgent?", 40)[1]).toContain("> what's urgent?");
  });

  it("scrolls a long input so its tail stays visible", () => {
    const long = "x".repeat(200);
    const mid = askBoxLines(long, 30)[1]!;
    expect([...mid].length).toBeLessThanOrEqual(30);
    expect(mid).toContain("x"); // the tail is shown, not overflowed
  });
});

describe("askCursorColumn", () => {
  it("sits just after the prompt and input", () => {
    // "│ " (2) + "> " (2) + input length + 1 for 1-based column
    expect(askCursorColumn("", 40)).toBe(3 + 2);
    expect(askCursorColumn("abc", 40)).toBe(3 + 5);
  });
});
