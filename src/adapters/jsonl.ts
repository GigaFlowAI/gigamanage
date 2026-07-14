/**
 * Streaming JSONL reader shared by adapters.
 *
 * Sessions run to hundreds of megabytes in aggregate, so we stream line by line
 * and never hold a whole file as one string. Malformed lines are skipped rather
 * than thrown: a truncated final line is normal for a session that is still open.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* readJsonl(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // Truncated or corrupt line; a live session's tail often is.
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }
}

/** Keep only the last `n` items pushed. Used for message tails. */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  toArray(): T[] {
    return [...this.items];
  }

  get last(): T | undefined {
    return this.items[this.items.length - 1];
  }
}
