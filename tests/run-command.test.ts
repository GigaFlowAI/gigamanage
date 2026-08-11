import { describe, expect, it } from "vitest";

import type { SessionRef } from "../src/core/types.js";
import { pickChangedSession, resolveHarnessArg } from "../src/cli/commands/run.js";

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

describe("pickChangedSession", () => {
  it("returns a session id absent before launch", () => {
    const before = [ref("old", 100)];
    const after = [ref("old", 100), ref("fresh", 200)];
    expect(pickChangedSession(before, after)?.sessionId).toBe("fresh");
  });
  it("returns a resumed session whose mtime advanced, with no new id", () => {
    const before = [ref("resumed", 100)];
    const after = [ref("resumed", 300)];
    expect(pickChangedSession(before, after)?.sessionId).toBe("resumed");
  });
  it("returns null when an existing id's mtime is unchanged and no id is new", () => {
    const before = [ref("a", 100)];
    const after = [ref("a", 100)];
    expect(pickChangedSession(before, after)).toBeNull();
  });
  it("returns null when there is nothing to pick", () => {
    expect(pickChangedSession([], [])).toBeNull();
  });
  it("prefers the greater-mtime session when both a new id and a bumped id are present", () => {
    const before = [ref("resumed", 100)];
    const after = [ref("resumed", 300), ref("fresh", 200)];
    expect(pickChangedSession(before, after)?.sessionId).toBe("resumed");
  });
});
