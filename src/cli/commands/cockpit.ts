import { basename } from "node:path";
import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { workReportPath } from "../../core/paths.js";
import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import type { SessionRecord } from "../../core/types.js";
import { readSnapshotFile, subscribe } from "../../services/daemon-client.js";
import { attachSummaries, loadCachedRecords } from "../../services/views.js";
import { buildWorkViews, defaultWorkViewProvider } from "../../services/work-view.js";
import { renderCockpit, type RenderCockpitOptions } from "../gmux-render.js";
import { renderWorkReportHtml, type WorkReportCard } from "../work-report.js";
import { isCloseKey } from "./overlay.js";

/** Clear screen + home, then the cockpit grid — CRLF-joined for raw-mode stdout. */
export function buildFrame(snapshot: WorkspaceSnapshot, now: number, opts?: RenderCockpitOptions): string {
  return "\x1b[2J\x1b[H" + renderCockpit(snapshot, now, opts).join("\r\n");
}

/**
 * The panes that have a resolvable session, paired with their record. Pure so
 * the pairing is tested without a daemon: matches on `identity.sessionId`, skips
 * session-less and unmatched panes, and dedupes a session claimed by two panes.
 */
export function sessionsForSnapshot(
  snapshot: WorkspaceSnapshot,
  records: readonly SessionRecord[],
): { label: string; record: SessionRecord }[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const seen = new Set<string>();
  const out: { label: string; record: SessionRecord }[] = [];
  for (const p of snapshot.panes) {
    const sid = p.identity.sessionId;
    if (!sid || seen.has(sid)) continue;
    const record = byId.get(sid);
    if (!record) continue;
    seen.add(sid);
    out.push({ label: p.identity.cwd ? basename(p.identity.cwd) : p.identity.command, record });
  }
  return out;
}

/**
 * The whole-workspace cockpit: paint the last known snapshot immediately, then
 * stay live off the daemon socket until a close key is pressed. `v` builds a
 * per-session HTML work report and shows a file:// link in the status banner.
 */
export function registerCockpit(program: Command): void {
  program
    .command("cockpit")
    .description("pull up the gmux workspace cockpit (used by the tmux ctrl-g binding)")
    .action(async () => {
      let latest: WorkspaceSnapshot | null = null;
      let stale: { ageMs: number } | null = null;
      let status: string | null = null;
      let building = false;
      let inFlight: Promise<void> | null = null;

      const render = (): void => {
        if (latest) process.stdout.write(buildFrame(latest, Date.now(), { stale, status }));
      };

      const initial = await readSnapshotFile();
      if (initial) { latest = initial.snapshot; render(); }

      const onSnapshot = (s: WorkspaceSnapshot): void => { latest = s; stale = null; render(); };
      const paintStale = (): void => {
        readSnapshotFile()
          .then((current) => { if (current) { latest = current.snapshot; stale = { ageMs: current.ageMs }; render(); } })
          .catch(() => { /* keep showing the last snapshot */ });
      };
      const stop = subscribe(onSnapshot, { onError: paintStale });

      const buildReport = async (): Promise<void> => {
        if (building || !latest) return;
        building = true;
        status = "⧗ building work report…";
        render();
        try {
          const sessions = sessionsForSnapshot(latest, await loadCachedRecords());
          if (sessions.length === 0) { status = "no sessions to report"; return; }
          const records = sessions.map((s) => s.record);
          const provider = await defaultWorkViewProvider();
          const built = provider ? await buildWorkViews(records, provider) : null;
          const headlines = new Map(
            (await attachSummaries(records)).map((v) => [v.record.sessionId, v.summary?.headline ?? null]),
          );
          const cards: WorkReportCard[] = sessions.map(({ label, record }) => {
            const headline = headlines.get(record.sessionId) ?? null;
            if (!built) return { label, headline, html: null, note: "no model configured — run `gmux setup`" };
            const view = built.views.get(record.sessionId);
            if (view) return { label, headline, html: view.html, note: null };
            const reason = built.failed.find((f) => f.sessionId === record.sessionId)?.reason ?? "unknown";
            return { label, headline, html: null, note: `generation failed: ${reason}` };
          });
          const path = workReportPath();
          await writeFile(path, renderWorkReportHtml(cards, Date.now()), "utf8");
          status = `✓ work report: file://${path}`;
        } catch (error) {
          status = `⚠ ${(error as Error).message}`;
        } finally {
          building = false;
          render();
        }
      };

      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();

      await new Promise<void>((done) => {
        stdin.on("data", (buf: Buffer) => {
          const s = buf.toString();
          if (isCloseKey(s)) return done();
          if (s === "v" || s === "V") inFlight = buildReport().finally(() => { inFlight = null; });
        });
      });

      await inFlight;
      stop();
      if (stdin.isTTY) stdin.setRawMode?.(false);
      process.exit(0);
    });
}
