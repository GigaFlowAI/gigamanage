import { rm, stat, open } from "node:fs/promises";

export const MAX_PANE_LOG_BYTES = 5 * 1024 * 1024;

export async function rotateIfLarge(
  logPath: string,
  maxBytes: number
): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  const fh = await open(logPath, "r+");
  try {
    const keep = Buffer.alloc(maxBytes);
    await fh.read(keep, 0, maxBytes, size - maxBytes);
    await fh.truncate(0);
    await fh.write(keep, 0, maxBytes, 0);
  } finally {
    await fh.close();
  }
  return true;
}

export async function pruneLog(logPath: string): Promise<void> {
  await rm(logPath, { force: true });
}
