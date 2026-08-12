import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import type { WorkspaceSnapshot } from "../core/gmux-types.js";
import { gmuxSnapshotPath, gmuxSocketPath } from "../core/paths.js";

export async function readSnapshotFile(
  path: string = gmuxSnapshotPath(),
): Promise<{ snapshot: WorkspaceSnapshot; ageMs: number } | null> {
  try {
    const [raw, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
    return { snapshot, ageMs: Math.max(0, Date.now() - st.mtimeMs) };
  } catch {
    return null;
  }
}

export function subscribe(
  onSnapshot: (s: WorkspaceSnapshot) => void,
  opts: { socketPath?: string; onError?: (e: Error) => void } = {},
): () => void {
  const sock = connect(opts.socketPath ?? gmuxSocketPath());
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) { try { onSnapshot(JSON.parse(line) as WorkspaceSnapshot); } catch { /* skip */ } }
    }
  });
  sock.on("error", (e) => opts.onError?.(e));
  return () => sock.destroy();
}
