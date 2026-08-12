import type { Command } from "commander";

import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import { readSnapshotFile, subscribe } from "../../services/daemon-client.js";
import { renderCockpit } from "../gmux-render.js";
import { isCloseKey } from "./overlay.js";

/** Clear screen + home, then the cockpit grid — CRLF-joined for raw-mode stdout. */
export function buildFrame(snapshot: WorkspaceSnapshot, now: number): string {
  return "\x1b[2J\x1b[H" + renderCockpit(snapshot, now).join("\r\n");
}

/**
 * The whole-workspace cockpit: paint the last known snapshot immediately (if
 * one is on disk), then stay live off the daemon socket until a close key is
 * pressed. If the socket errors — daemon not running, or it dies mid-session —
 * we stay defensive and simply keep showing the last snapshot rather than
 * crash; a staleness banner is a later task, not this one.
 */
export function registerCockpit(program: Command): void {
  program
    .command("cockpit")
    .description("pull up the gmux workspace cockpit (used by the tmux ctrl-g binding)")
    .action(async () => {
      const initial = await readSnapshotFile();
      const paint = (s: WorkspaceSnapshot): void => {
        process.stdout.write(buildFrame(s, Date.now()));
      };
      if (initial) paint(initial.snapshot);

      const stop = subscribe(paint, { onError: () => { /* keep showing the last snapshot */ } });

      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();

      await new Promise<void>((done) => {
        stdin.on("data", (buf: Buffer) => {
          if (isCloseKey(buf.toString())) done();
        });
      });

      stop();
      if (stdin.isTTY) stdin.setRawMode?.(false);
      process.exit(0);
    });
}
