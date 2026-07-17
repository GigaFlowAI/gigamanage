/**
 * Distillation: turn a session record into the small bundle of evidence a model
 * needs to say where the work landed.
 *
 * This is the heart of the tool. Two properties matter:
 *
 * 1. **The arc, not one endpoint.** We send where the work started, a few
 *    waypoints through it, and how it ended. Head-only is the bug we exist to
 *    fix — that just restates the stale `aiTitle`. But tail-only overcorrects:
 *    a status with no subject ("timestamp check still red") is unreadable next
 *    to twenty others. Never head-only; never the head speaking alone.
 *
 * 2. **Small.** The distilled input is a couple of KB regardless of whether the
 *    session was 20 messages or 2,000, so summarizing is cheap and bounded.
 */

import { hash } from "../core/text.js";
import type { SessionRecord, SummaryInput } from "../core/types.js";

/**
 * Bump when `buildPrompt` changes what it asks for.
 *
 * The summary cache is keyed on the hash below, which covers session content
 * only — so without this, editing the prompt would change nothing for anything
 * already summarized: those sessions keep their old summaries until their
 * transcripts happen to change, which for a finished session is never.
 *
 * Bumping marks every cached summary stale at once, and they regenerate through
 * the normal background pass. No cache wipe, no migration.
 *
 * 2: headlines tightened to a short scannable clause (was "max 80 chars",
 *    which overflowed the 72-char row and read as truncated).
 * 3: summaries describe the arc, not just the tail — the prompt gained the
 *    original ask, and the output gained `overview`. The headline changed
 *    meaning: it now says what the work IS, not what state it is in.
 */
export const PROMPT_VERSION = 3;

export function distill(record: SessionRecord): SummaryInput {
  const input: Omit<SummaryInput, "hash"> = {
    promptVersion: PROMPT_VERSION,
    harness: record.harness,
    sessionId: record.sessionId,
    project: record.project,
    gitBranch: record.gitBranch,
    title: record.title,
    recentUserPrompts: record.recentUserPrompts,
    arcPrompts: record.arcPrompts,
    lastAssistantText: record.lastAssistantText,
    // Cap the file list: a refactor touching 200 files should not dominate the prompt.
    filesTouched: record.filesTouched.slice(0, 25),
    lastToolFailure: record.lastToolFailure,
    endedMidTask: record.endedMidTask,
  };

  return { ...input, hash: hash(JSON.stringify(input)) };
}

/** The instruction given to whichever model provider is configured. */
export function buildPrompt(input: SummaryInput): string {
  const lines: string[] = [];

  lines.push(
    "You are summarizing a coding-agent session so a developer can decide, at a glance, whether to pick it back up.",
    "",
    "You are shown the ARC of the session: where it started, waypoints through the middle, and how it ended. Describe where the work ACTUALLY LANDED — and what it is fundamentally about, which may not be what it set out to do.",
    "",
    "## Session",
    `harness: ${input.harness}`,
  );
  if (input.project) lines.push(`project: ${input.project}`);
  if (input.gitBranch) lines.push(`branch: ${input.gitBranch}`);
  if (input.title) lines.push(`title recorded at session START (may be stale): ${input.title}`);
  lines.push(`ended mid-task: ${input.endedMidTask ? "yes" : "no"}`);

  if (input.filesTouched.length > 0) {
    lines.push("", "## Files the agent changed", ...input.filesTouched.map((f) => `- ${f}`));
  }

  // Only what the tail does not already carry. On a short session the sampler
  // and the tail window hold the same turns, and printing both would make the
  // model read the duplication as emphasis.
  const tail = new Set(input.recentUserPrompts);
  const [anchor, ...waypoints] = input.arcPrompts;
  const freshWaypoints = waypoints.filter((p) => !tail.has(p));

  if (anchor !== undefined && !tail.has(anchor)) {
    lines.push("", "## The original ask (how this session opened)", anchor);
  }

  if (freshWaypoints.length > 0) {
    lines.push(
      "",
      "## How the work moved (sampled across the session, oldest first)",
      ...freshWaypoints.map((p) => `- ${p}`),
    );
  }

  if (input.recentUserPrompts.length > 0) {
    lines.push(
      "",
      "## The developer's most recent instructions (oldest first — the LAST one matters most)",
      ...input.recentUserPrompts.map((p) => `- ${p}`),
    );
  }

  if (input.lastAssistantText) {
    lines.push("", "## The agent's final message", input.lastAssistantText);
  }

  if (input.lastToolFailure) {
    lines.push("", "## The last failing command", input.lastToolFailure);
  }

  lines.push(
    "",
    "## Output",
    "Reply with ONLY a JSON object, no code fence, no commentary:",
    "{",
    '  "headline": "what this work IS, one clause, under 60 chars, no trailing period",',
    '  "overview": "2-3 sentences: what this session is fundamentally about, including how the goal shifted if it did",',
    '  "landed": "1-2 sentences: the MOST RECENT work done",',
    '  "open": "1-2 sentences: what is unresolved, blocked, or broken. \'Nothing outstanding.\' if genuinely finished",',
    '  "nextStep": "one concrete next action a developer would take"',
    "}",
    "",
    "The headline is the overview compressed to fit a narrow list column, read at a glance next to twenty others.",
    "Same fact, two lengths — they must never disagree.",
    "Write a clause, not a sentence:",
    '  good: "Migrating webhook retries to the new queue backend"',
    '  bad:  "The retry logic has been partially applied, but the signature verification test is still failing."',
    "",
    "`landed` is the LATEST work, not a recap of the whole session — that is what `overview` is for.",
    "",
    "Be specific and factual. Name the files, tests, and errors involved. Never speculate beyond the evidence above.",
  );

  return lines.join("\n");
}
