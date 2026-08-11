import { describe, expect, it } from "vitest";

import { parseAgentSession, pickAgentProcess, type AgentProcess } from "../src/services/pane-process.js";

const CODEX = "node /Users/me/.local/bin/codex resume 019fee8d-51a2-7f60-9cff-e7f9db4b100e";
const CLAUDE = "node /Users/me/.local/bin/claude --resume 3ec20d5a-2322-41f3-9a1d-956822e72a3d";

describe("parseAgentSession", () => {
  it("reads a codex session id from `codex resume <uuid>`", () => {
    expect(parseAgentSession(CODEX)).toEqual({
      harness: "codex",
      sessionId: "019fee8d-51a2-7f60-9cff-e7f9db4b100e",
    });
  });

  it("reads a claude session id from `claude --resume <uuid>`", () => {
    expect(parseAgentSession(CLAUDE)).toEqual({
      harness: "claude-code",
      sessionId: "3ec20d5a-2322-41f3-9a1d-956822e72a3d",
    });
  });

  it("reads claude's short `-r <uuid>` form", () => {
    expect(parseAgentSession("claude -r 3ec20d5a-2322-41f3-9a1d-956822e72a3d")?.harness).toBe(
      "claude-code",
    );
  });

  it("returns null for a bare harness with no session id", () => {
    expect(parseAgentSession("node /Users/me/.local/bin/codex")).toBeNull();
    expect(parseAgentSession("claude")).toBeNull();
  });

  it("returns null for an MCP child or unrelated node process", () => {
    expect(parseAgentSession("node ./mcp/server.mjs")).toBeNull();
    expect(parseAgentSession("npm exec @playwright/mcp@latest")).toBeNull();
  });

  it("returns null for a malformed id", () => {
    expect(parseAgentSession("codex resume not-a-uuid")).toBeNull();
  });
});

describe("pickAgentProcess", () => {
  it("prefers the process whose argv yields a session id", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: CODEX },
      { pid: 3, command: "node .bin/playwright-mcp" },
    ];
    expect(pickAgentProcess(procs)?.pid).toBe(2);
  });

  it("falls back to a bare harness invocation (for its cwd) when no id is present", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: "node /Users/me/.local/bin/codex" },
    ];
    expect(pickAgentProcess(procs)?.pid).toBe(2);
  });

  it("returns null when the tree holds no harness process", () => {
    const procs: AgentProcess[] = [
      { pid: 1, command: "node ./mcp/server.mjs" },
      { pid: 2, command: "-zsh" },
    ];
    expect(pickAgentProcess(procs)).toBeNull();
  });
});
