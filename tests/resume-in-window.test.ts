import { describe, expect, it } from "vitest";

import { newWindowArgv } from "../src/cli/commands/resume.js";

describe("newWindowArgv", () => {
  it("builds a tmux new-window invocation in the session's cwd", () => {
    expect(
      newWindowArgv({ command: "claude", args: ["--resume", "abc"], cwd: "/my repo/app" }),
    ).toEqual(["new-window", "-c", "/my repo/app", "--", "claude", "--resume", "abc"]);
  });
});
