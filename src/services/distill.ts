/**
 * Distillation: turn a session record into the small bundle of evidence a model
 * needs to say where the work landed.
 *
 * This is the heart of the tool. Two properties matter:
 *
 * 1. **Tail, not head.** We send the END of the session — the last human turns,
 *    the final assistant message, the files touched, the last failure. A model
 *    fed the beginning of a session writes the same thing the stale `aiTitle`
 *    already says, which is exactly the failure we are fixing.
 *
 * 2. **Small.** The distilled input is a couple of KB regardless of whether the
 *    session was 20 messages or 2,000, so summarizing is cheap and bounded.
 */

import { hash } from "../core/text.js";
import type { SessionRecord, SummaryInput } from "../core/types.js";

export function distill(record: SessionRecord): SummaryInput {
  const input: Omit<SummaryInput, "hash"> = {
    harness: record.harness,
    sessionId: record.sessionId,
    project: record.project,
    gitBranch: record.gitBranch,
    title: record.title,
    recentUserPrompts: record.recentUserPrompts,
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
    "You are shown the END of the session, not the beginning. Describe where the work ACTUALLY LANDED — not what it set out to do.",
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
    '  "headline": "one line, max 80 chars: the state this work is in NOW",',
    '  "landed": "1-2 sentences: what actually got done",',
    '  "open": "1-2 sentences: what is unresolved, blocked, or broken. \'Nothing outstanding.\' if genuinely finished",',
    '  "nextStep": "one concrete next action a developer would take"',
    "}",
    "",
    "Be specific and factual. Name the files, tests, and errors involved. Never speculate beyond the evidence above.",
  );

  return lines.join("\n");
}
