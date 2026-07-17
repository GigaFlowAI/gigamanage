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

/**
 * Keep an evenly-spaced sample of an unbounded stream, in bounded memory.
 *
 * `RingBuffer` above answers "how did this end?". This answers "what shape was
 * it?" — and crucially it never drops the FIRST item, which is the developer's
 * original ask. A summarizer that never sees that writes the same thing the
 * stale harness title already says.
 *
 * Every `stride`-th item is a candidate; when the buffer fills we drop every
 * other one and double the stride. Stride is therefore always a power of two,
 * and the retained set lands between `capacity / 2` and `capacity` — evenly
 * spaced, not exactly `capacity` long. A few waypoints is all the prompt needs.
 */
export class DecimatingSampler<T> {
  private items: T[] = [];
  private stride = 1;
  private seen = 0;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    const index = this.seen;
    this.seen += 1;
    if (index % this.stride !== 0) return;

    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items = this.items.filter((_, i) => i % 2 === 0);
      this.stride *= 2;
    }
  }

  toArray(): T[] {
    return [...this.items];
  }
}
