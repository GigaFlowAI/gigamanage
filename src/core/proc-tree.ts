export interface ProcRow { pid: number; ppid: number; rss: number; comm: string; }

/** Parse `ps -axo pid,ppid,rss,comm`. RSS is KB on macOS/Linux → convert to bytes. */
export function parsePsOutput(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue; // skips the header and blanks
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, comm: m[4]!.trim() });
  }
  return rows;
}

export function subtreeRss(rootPid: number, rows: ProcRow[]): number {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const r of rows) {
    rss.set(r.pid, r.rss);
    (children.get(r.ppid) ?? children.set(r.ppid, []).get(r.ppid)!).push(r.pid);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return total;
}

export function totalRss(rows: ProcRow[]): number {
  return rows.reduce((sum, r) => sum + r.rss, 0);
}
