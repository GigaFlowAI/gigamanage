import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  BLOCK_START,
  LEGACY_BLOCK_END,
  LEGACY_BLOCK_START,
  bindingsBlock,
  inspectTmuxBindings,
  installTmuxBindings,
  maybeInstallTmuxBindings,
  removeBlock,
  resolveTmuxConfPath,
  stripManagedBlocks,
  uninstallTmuxBindings,
  upsertBlock,
  type TmuxPathStat,
} from "../src/cli/commands/tmux.js";

function stat(opts: { files?: string[]; symlinks?: string[] }): TmuxPathStat {
  const files = new Set(opts.files ?? []);
  const symlinks = new Set(opts.symlinks ?? []);
  return {
    exists: (p) => files.has(p) || symlinks.has(p),
    isSymlink: (p) => symlinks.has(p),
  };
}

function homeOf(home: string) {
  return {
    conf: join(home, ".tmux.conf"),
    local: join(home, ".tmux.conf.local"),
  };
}

const GIGAMANAGE_BLOCK = [
  LEGACY_BLOCK_START,
  "bind -n C-g display-popup -E 'gm overlay'",
  LEGACY_BLOCK_END,
].join("\n");

describe("tmux.conf block management", () => {
  it("appends the block when absent, preserving existing config", () => {
    const out = upsertBlock("set -g mouse on\n", bindingsBlock());
    expect(out).toContain("set -g mouse on");
    expect(out).toContain(BLOCK_START);
    expect(out).toContain("gmux cockpit");
    expect(out).toContain(BLOCK_END);
  });

  it("replaces an existing block in place rather than duplicating it", () => {
    const first = upsertBlock("", bindingsBlock());
    const second = upsertBlock(first, "# >>> gmux >>>\nbind -n C-g none\n# <<< gmux <<<");
    expect(second.match(/>>> gmux >>>/g)).toHaveLength(1);
    expect(second).toContain("bind -n C-g none");
    expect(second).not.toContain("gmux overlay");
  });

  it("removes exactly the block and nothing else", () => {
    const withBlock = upsertBlock("set -g mouse on\n", bindingsBlock());
    const cleaned = removeBlock(withBlock);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gmux");
  });

  it("bindings reference the cockpit and the picker bridge", () => {
    const block = bindingsBlock();
    expect(block).toContain("display-popup");
    // The cockpit is whole-workspace, so unlike the overlay it replaced it
    // needs no window id resolved in-shell.
    expect(block).toContain("bind -n C-g display-popup -w 100% -h 100% -x 0 -y 0 -B -E 'gmux cockpit'");
    expect(block).toContain("gmux pick --resume-in-window");
    // The pane-label toggle, also resolving the window id in-shell.
    expect(block).toContain("bind -n M-g");
    expect(block).toContain('gmux tmux label "$(tmux display -p "#{window_id}")"');
    expect(block).not.toMatch(/gmux tmux label\s+#\{/);
  });
});

describe("resolveTmuxConfPath", () => {
  const home = "/tmp/gmux-home";
  const { conf, local } = homeOf(home);

  it("prefers ~/.tmux.conf.local when that file exists (Oh My Tmux)", () => {
    expect(resolveTmuxConfPath(home, stat({ files: [conf, local] }))).toBe(local);
  });

  it("writes ~/.tmux.conf.local when ~/.tmux.conf is a symlink, even if local does not exist yet", () => {
    // Writing through the symlink would clobber Oh My Tmux's git-managed file.
    expect(resolveTmuxConfPath(home, stat({ symlinks: [conf] }))).toBe(local);
  });

  it("uses ~/.tmux.conf when it is a regular file and there is no .local", () => {
    expect(resolveTmuxConfPath(home, stat({ files: [conf] }))).toBe(conf);
  });

  it("uses ~/.tmux.conf when neither file exists (a fresh machine)", () => {
    expect(resolveTmuxConfPath(home, stat({}))).toBe(conf);
  });
});

describe("stripManagedBlocks", () => {
  it("removes both the gmux block and a leftover gigamanage block", () => {
    const existing = `set -g mouse on\n${GIGAMANAGE_BLOCK}\n${bindingsBlock()}\n`;
    const cleaned = stripManagedBlocks(existing);
    expect(cleaned).toContain("set -g mouse on");
    expect(cleaned).not.toContain("gmux");
    expect(cleaned).not.toContain("gigamanage");
    expect(cleaned).not.toContain("gm overlay");
  });
});

describe("installTmuxBindings / uninstallTmuxBindings", () => {

  it("writes the gmux block to .tmux.conf.local when that file already exists, and strips a leftover gigamanage block", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    await writeFile(conf, "set -g default-terminal tmux\n", "utf8");
    await writeFile(local, `set -g mouse on\n${GIGAMANAGE_BLOCK}\n`, "utf8");

    const result = await installTmuxBindings(home);

    expect(result.path).toBe(local);
    expect(result.removedLegacy).toBe(true);
    const localText = await readFile(local, "utf8");
    expect(localText).toContain("set -g mouse on");
    expect(localText).toContain(BLOCK_START);
    expect(localText).toContain("gmux cockpit");
    expect(localText).not.toContain("gigamanage");
    expect(localText).not.toContain("gm overlay");
    // The main conf is left alone when it had no managed block.
    expect(await readFile(conf, "utf8")).toBe("set -g default-terminal tmux\n");
  });

  it("does not write through a symlink: creates .tmux.conf.local and leaves the symlink target untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    const real = join(home, "oh-my-tmux.conf");
    await writeFile(real, "# oh-my-tmux managed\n", "utf8");
    await symlink(real, conf);

    const result = await installTmuxBindings(home);

    expect(result.path).toBe(local);
    expect(await readFile(local, "utf8")).toContain(BLOCK_START);
    expect(await readFile(real, "utf8")).toBe("# oh-my-tmux managed\n");
  });

  it("moves a previous install out of a symlink target and into .tmux.conf.local", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    const real = join(home, "oh-my-tmux.conf");
    await writeFile(real, `# oh-my-tmux managed\n${bindingsBlock()}\n`, "utf8");
    await symlink(real, conf);

    await installTmuxBindings(home);

    expect(await readFile(local, "utf8")).toContain(BLOCK_START);
    expect(await readFile(real, "utf8")).toContain("# oh-my-tmux managed");
    expect(await readFile(real, "utf8")).not.toContain(BLOCK_START);
  });

  it("uninstall removes the gmux block from both candidate files", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const { conf, local } = homeOf(home);
    await writeFile(conf, upsertBlock("set -g mouse on\n", bindingsBlock()), "utf8");
    await writeFile(local, upsertBlock("", bindingsBlock()), "utf8");

    await uninstallTmuxBindings(home);

    expect(await readFile(conf, "utf8")).toContain("set -g mouse on");
    expect(await readFile(conf, "utf8")).not.toContain("gmux");
    expect(await readFile(local, "utf8")).not.toContain("gmux");
  });
});

describe("inspectTmuxBindings", () => {
  it("reports installed when the target file holds the gmux block", () => {
    const home = "/tmp/gmux-home";
    const { conf, local } = homeOf(home);
    const report = inspectTmuxBindings(home, {
      ...stat({ files: [conf, local] }),
      read: (p) => (p === local ? bindingsBlock() : "set -g mouse on\n"),
    });
    expect(report.targetPath).toBe(local);
    expect(report.installed).toBe(true);
    expect(report.leftoverLegacy).toBe(false);
  });

  it("reports a leftover gigamanage block even when gmux is also installed", () => {
    const home = "/tmp/gmux-home";
    const { conf, local } = homeOf(home);
    const report = inspectTmuxBindings(home, {
      ...stat({ files: [conf, local] }),
      read: (p) => (p === local ? `${GIGAMANAGE_BLOCK}\n${bindingsBlock()}` : ""),
    });
    expect(report.installed).toBe(true);
    expect(report.leftoverLegacy).toBe(true);
  });
});

describe("maybeInstallTmuxBindings", () => {
  it("does not ask or install when tmux is not available", async () => {
    const asked: string[] = [];
    const result = await maybeInstallTmuxBindings({
      available: false,
      ask: async (q) => {
        asked.push(q);
        return true;
      },
      home: "/tmp/unused",
    });
    expect(asked).toEqual([]);
    expect(result).toEqual({ didInstall: false });
  });

  it("skips install when the user declines", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const result = await maybeInstallTmuxBindings({
      available: true,
      ask: async () => false,
      home,
    });
    expect(result).toEqual({ didInstall: false });
    await expect(readFile(join(home, ".tmux.conf"), "utf8")).rejects.toThrow();
  });

  it("installs when the user accepts", async () => {
    const home = await mkdtemp(join(tmpdir(), "gmux-tmux-"));
    const result = await maybeInstallTmuxBindings({
      available: true,
      ask: async () => true,
      home,
    });
    expect(result.didInstall).toBe(true);
    expect(result.path).toBe(join(home, ".tmux.conf"));
    expect(await readFile(result.path!, "utf8")).toContain(BLOCK_START);
  });
});
