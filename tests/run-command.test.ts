import { describe, expect, it } from "vitest";

import type { SessionRef } from "../src/core/types.js";
import { pickNewSession, resolveHarnessArg } from "../src/cli/commands/run.js";

function ref(sessionId: string, mtimeMs: number): SessionRef {
  return { harness: "claude-code", sessionId, filePath: `/${sessionId}`, mtimeMs, size: 1 };
}

describe("resolveHarnessArg", () => {
  it("matches a harness by its id", () => {
    expect(resolveHarnessArg("claude-code")?.id).toBe("claude-code");
  });
  it("matches a harness by a process name alias", () => {
    expect(resolveHarnessArg("claude")?.id).toBe("claude-code");
    expect(resolveHarnessArg("codex")?.id).toBe("codex");
  });
  it("returns null for an unknown harness", () => {
    expect(resolveHarnessArg("emacs")).toBeNull();
  });
});

describe("pickNewSession", () => {
  it("prefers a session id absent before launch", () => {
    const before = [ref("old", 100)];
    const after = [ref("old", 100), ref("fresh", 200)];
    expect(pickNewSession(before, after)?.sessionId).toBe("fresh");
  });
  it("falls back to the newest by mtime when no id is new", () => {
    const before = [ref("a", 100), ref("b", 100)];
    const after = [ref("a", 100), ref("b", 300)];
    expect(pickNewSession(before, after)?.sessionId).toBe("b");
  });
  it("returns null when there is nothing to pick", () => {
    expect(pickNewSession([], [])).toBeNull();
  });
});
