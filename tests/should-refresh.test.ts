import { describe, expect, it } from "vitest";

import type { SessionRecord, SessionSummary } from "../src/core/types.js";
import { distill } from "../src/services/distill.js";
import {
  REFRESH_DISTANCE,
  contentFingerprint,
  shouldRefresh,
  signalHash,
} from "../src/services/summarize.js";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "codex",
    sessionId: "s",
    filePath: "/f",
    cwd: "/repo",
    project: "repo",
    gitBranch: null,
    startedAt: null,
    updatedAt: "2026-08-11T00:00:00.000Z",
    messageCount: 1,
    userPromptCount: 1,
    title: null,
    lastUserPrompt: null,
    recentUserPrompts: ["set up the retry backoff", "why is the signature check failing"],
    arcPrompts: ["build the webhook retry system", "make the signature verification pass"],
    filesTouched: ["src/retry.ts", "src/webhook.ts"],
    prLinks: [],
    lastAssistantText: "Retry backoff added; the timestamp test is still red.",
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...over,
  };
}

/** A summary that exactly matches `record()`'s current distilled content. */
function freshSummary(rec: SessionRecord): SessionSummary {
  const input = distill(rec);
  return {
    harness: rec.harness,
    sessionId: rec.sessionId,
    sourceHash: input.hash,
    fingerprint: contentFingerprint(input),
    signalHash: signalHash(input),
    generatedAt: "2026-08-11T00:00:00.000Z",
    provider: "codex",
    headline: "h",
    overview: "o",
    landed: "l",
    open: "",
    nextStep: "",
  };
}

describe("shouldRefresh", () => {
  it("refreshes when there is no summary", () => {
    expect(shouldRefresh(null, record())).toBe(true);
  });

  it("does not refresh an up-to-date summary", () => {
    const rec = record();
    expect(shouldRefresh(freshSummary(rec), rec)).toBe(false);
  });

  it("always refreshes on a new tool failure (a significant signal), even at distance 0", () => {
    const rec = record();
    const summary = freshSummary(rec);
    const failed = record({ lastToolFailure: "npm test exited 1" });
    expect(shouldRefresh(summary, failed)).toBe(true);
  });

  it("always refreshes when the session flips to ended-mid-task", () => {
    const rec = record();
    const summary = freshSummary(rec);
    expect(shouldRefresh(summary, record({ endedMidTask: true }))).toBe(true);
  });

  it("always refreshes when the files-touched set changes", () => {
    const rec = record();
    const summary = freshSummary(rec);
    expect(shouldRefresh(summary, record({ filesTouched: ["src/retry.ts", "src/new.ts"] }))).toBe(true);
  });

  it("ignores a small narrative edit (below the divergence threshold)", () => {
    const rec = record();
    const summary = freshSummary(rec);
    const tweaked = record({
      lastAssistantText: "Retry backoff added; the timestamp test is still red now.",
    });
    expect(shouldRefresh(summary, tweaked)).toBe(false);
  });

  it("refreshes on a large narrative divergence", () => {
    const rec = record();
    const summary = freshSummary(rec);
    const diverged = record({
      arcPrompts: ["design the event-driven architecture", "add a dead-letter queue per tenant"],
      recentUserPrompts: ["wire the dispatcher", "handle poisoned messages"],
      lastAssistantText: "Dispatcher and dead-letter path are in; tenants each get their own queue.",
    });
    expect(shouldRefresh(summary, diverged)).toBe(true);
  });

  it("falls back to the exact hash for a pre-fingerprint summary", () => {
    const rec = record();
    const legacy = freshSummary(rec);
    delete legacy.fingerprint;
    delete legacy.signalHash;
    // Same content → not stale by the exact hash.
    expect(shouldRefresh(legacy, rec)).toBe(false);
    // Any content change → stale by the exact hash.
    expect(shouldRefresh(legacy, record({ lastAssistantText: "different" }))).toBe(true);
  });

  it("has a positive default threshold", () => {
    expect(REFRESH_DISTANCE).toBeGreaterThan(0);
  });
});
