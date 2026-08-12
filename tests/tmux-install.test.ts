import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  BLOCK_START,
  bindingsBlock,
  removeBlock,
  upsertBlock,
} from "../src/cli/commands/tmux.js";

describe("tmux.conf block management", () => {
  it("appends the block when absent, preserving existing config", () => {
    const out = upsertBlock("set -g mouse on\n", bindingsBlock());
    expect(out).toContain("set -g mouse on");
    expect(out).toContain(BLOCK_START);
    expect(out).toContain("gm cockpit");
    expect(out).toContain(BLOCK_END);
  });

  it("replaces an existing block in place rather than duplicating it", () => {
    const first = upsertBlock("", bindingsBlock());
    const second = upsertBlock(first, "# >>> gigamanage >>>\nbind -n C-g none\n# <<< gigamanage <<<");
    expect(second.match(/>>> gigamanage >>>/g)).toHaveLength(1);
    expect(second).toContain("bind -n C-g none");
    expect(second).not.toContain("gm overlay");
  });

  it("removes exactly the block and nothing else", () => {
    const withBlock = upsertBlock("set -g mouse on\n", bindingsBlock());
    const cleaned = removeBlock(withBlock);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gigamanage");
  });

  it("bindings reference the cockpit and the picker bridge", () => {
    const block = bindingsBlock();
    expect(block).toContain("display-popup");
    // The cockpit is whole-workspace, so unlike the overlay it replaced it
    // needs no window id resolved in-shell.
    expect(block).toContain("bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gm cockpit'");
    expect(block).toContain("gm pick --resume-in-window");
    // The pane-label toggle, also resolving the window id in-shell.
    expect(block).toContain("bind -n M-g");
    expect(block).toContain('gm tmux label "$(tmux display -p "#{window_id}")"');
    expect(block).not.toMatch(/gm tmux label\s+#\{/);
  });
});
