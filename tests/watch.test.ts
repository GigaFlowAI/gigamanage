import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import {
  clearWatchPid,
  isWatchAlive,
  readWatchPid,
  startWatch,
  stopWatch,
  watchPidPath,
  writeWatchPid,
} from "../src/services/watch.js";

afterEach(async () => {
  await rm(watchPidPath(), { force: true });
});

describe("watch lifecycle", () => {
  it("round-trips the pid file", async () => {
    await writeWatchPid(4242, new Date("2026-08-11T00:00:00.000Z"));
    const record = await readWatchPid();
    expect(record?.pid).toBe(4242);
    expect(record?.startedAt).toBe("2026-08-11T00:00:00.000Z");
  });

  it("treats a missing pid file as not running", async () => {
    await clearWatchPid();
    expect(await readWatchPid()).toBeNull();
    expect(isWatchAlive(null)).toBe(false);
  });

  it("sees the current process as alive and a dead pid as not", () => {
    expect(isWatchAlive({ pid: process.pid, startedAt: "x" })).toBe(true);
    // A pid that cannot exist.
    expect(isWatchAlive({ pid: 2_147_483_646, startedAt: "x" })).toBe(false);
  });

  it("starts by spawning a worker and recording its pid", async () => {
    await clearWatchPid();
    const result = await startWatch(new Date(), () => 999999);
    expect(result).toBe("started");
    expect((await readWatchPid())?.pid).toBe(999999);
  });

  it("is a no-op when a live watcher already holds the pid file", async () => {
    // A live pid: this very process.
    await writeWatchPid(process.pid);
    let spawned = false;
    const result = await startWatch(new Date(), () => {
      spawned = true;
      return 111;
    });
    expect(result).toBe("already-running");
    expect(spawned).toBe(false);
    expect((await readWatchPid())?.pid).toBe(process.pid);
  });

  it("reclaims a stale pid and starts fresh", async () => {
    await writeWatchPid(2_147_483_646); // dead
    const result = await startWatch(new Date(), () => 222);
    expect(result).toBe("started");
    expect((await readWatchPid())?.pid).toBe(222);
  });

  it("stop clears the pid file", async () => {
    await writeWatchPid(2_147_483_646);
    await stopWatch();
    expect(await readWatchPid()).toBeNull();
  });
});
