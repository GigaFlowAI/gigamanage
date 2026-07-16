/**
 * The ask layer.
 *
 * The provider is always a fake — non-negotiable #2. What is worth testing here
 * is the prompt: it is the entire interface to the model, and a regression in it
 * is invisible until the answers quietly get worse.
 */

import { describe, expect, it } from "vitest";

import type { AskProvider, SessionRecord, SessionSummary, SessionView } from "../src/core/types.js";
import {
  ASK_SESSION_LIMIT,
  buildAskContext,
  buildAskPrompt,
  shortId,
} from "../src/services/ask.js";
import { summarizedCount, thinContextNotice } from "../src/cli/commands/ask.js";
import { fzfArgs } from "../src/cli/picker.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    filePath: "/tmp/a.jsonl",
    cwd: "/repo",
    project: "webshop",
    gitBranch: "main",
    startedAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T11:00:00.000Z",
    messageCount: 10,
    userPromptCount: 3,
    title: "webhook retries are flaky",
    lastUserPrompt: "fix the retry",
    recentUserPrompts: ["fix the retry"],
    filesTouched: ["src/retry.ts"],
    prLinks: [],
    lastAssistantText: "Done.",
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    sourceHash: "abc",
    generatedAt: "2026-07-16T11:00:00.000Z",
    provider: "fake",
    headline: "Retry logic half-applied; signature test still red",
    landed: "Added backoff to the webhook sender.",
    open: "The signature test is failing.",
    nextStep: "Fix tests/signature.test.ts",
    ...overrides,
  };
}

function view(r: Partial<SessionRecord> = {}, s: Partial<SessionSummary> | null = {}): SessionView {
  return { record: record(r), summary: s === null ? null : summary(s) };
}

/** The only kind of provider a test may have. */
class FakeAskProvider implements AskProvider {
  readonly name = "fake";
  prompts: string[] = [];
  constructor(private readonly reply: string = "an answer") {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async ask(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.reply;
  }
}

describe("buildAskContext", () => {
  it("sorts most-recent first", () => {
    const context = buildAskContext([
      view({ sessionId: "old11111-0000-0000-0000-000000000000", updatedAt: "2026-07-01T00:00:00.000Z" }),
      view({ sessionId: "new11111-0000-0000-0000-000000000000", updatedAt: "2026-07-16T00:00:00.000Z" }),
    ]);
    expect(context.sessions[0]!.record.sessionId).toMatch(/^new/);
  });

  it("caps the window", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      view({ sessionId: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000` }),
    );
    expect(buildAskContext(many).sessions).toHaveLength(ASK_SESSION_LIMIT);
  });

  it("resolves a focus id given as a short prefix", () => {
    // The picker passes fzf's field, and gm ids are shown truncated.
    const context = buildAskContext([view()], "aaaa1111");
    expect(context.focusId).toBe("aaaa1111-0000-0000-0000-000000000000");
  });

  it("drops a focus id that is not in the window", () => {
    // Pointing the prompt at a session whose details aren't in it would invite
    // the model to invent them.
    expect(buildAskContext([view()], "zzzz9999").focusId).toBeNull();
  });
});

describe("buildAskPrompt", () => {
  const prompt = (views: SessionView[], focus: string | null = null, question = "what next?") =>
    buildAskPrompt(buildAskContext(views, focus), [], question, NOW);

  it("includes the summary fields", () => {
    const text = prompt([view()]);
    expect(text).toContain("Retry logic half-applied");
    expect(text).toContain("The signature test is failing.");
    expect(text).toContain("Fix tests/signature.test.ts");
  });

  it("tells the model the summary describes the END of the session", () => {
    // The property the whole tool exists to preserve. A model told nothing would
    // weigh the stale title equally.
    expect(prompt([view()])).toContain("LANDED");
  });

  it("warns that the title is stale", () => {
    expect(prompt([view()])).toMatch(/title.*stale/is);
  });

  it("offers gm grep as the way past the summaries", () => {
    expect(prompt([view()])).toContain("gm grep");
  });

  it("marks a session that ended mid-task", () => {
    expect(prompt([view({ endedMidTask: true })])).toContain("ENDED MID-TASK");
  });

  it("marks the focused session", () => {
    expect(prompt([view()], "aaaa1111")).toContain("the session the user is looking at");
  });

  it("says so when a session has no summary yet", () => {
    // A gap the model knows about is a caveat it can pass on. One it doesn't
    // know about is a confident answer built on nothing.
    const text = prompt([view({}, null)]);
    expect(text).toContain("NOT YET WRITTEN");
  });

  it("falls back to hard facts for an un-summarized session", () => {
    expect(prompt([view({}, null)])).toContain("fix the retry");
  });

  it("caps the file list rather than letting one session eat the prompt", () => {
    const files = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
    const text = prompt([view({ filesTouched: files })]);
    expect(text).toContain("+32 more");
    expect(text).not.toContain("src/file20.ts");
  });

  it("replays the conversation so far", () => {
    // The providers we call are one-shot; without this, every follow-up would
    // be asked cold.
    const text = buildAskPrompt(
      buildAskContext([view()]),
      [{ question: "which is broken?", answer: "the webshop one" }],
      "why?",
      NOW,
    );
    expect(text).toContain("which is broken?");
    expect(text).toContain("the webshop one");
  });

  it("handles having no sessions at all", () => {
    expect(prompt([])).toContain("none");
  });
});

describe("the fake provider path", () => {
  it("gets the prompt we built", async () => {
    const provider = new FakeAskProvider();
    await provider.ask(buildAskPrompt(buildAskContext([view()]), [], "what next?", NOW));
    expect(provider.prompts[0]).toContain("what next?");
  });
});

describe("thinContextNotice", () => {
  it("says nothing when most sessions are summarized", () => {
    expect(thinContextNotice(buildAskContext([view(), view()]))).toBeNull();
  });

  it("warns when nothing is summarized", () => {
    // Otherwise a thin answer reads as the feature being useless, rather than
    // as the summaries not being written yet.
    const notice = thinContextNotice(buildAskContext([view({}, null), view({}, null)]));
    expect(notice).toContain("summarize");
  });

  it("warns when there are no sessions", () => {
    expect(thinContextNotice(buildAskContext([]))).toContain("No sessions");
  });

  it("counts summaries honestly", () => {
    expect(summarizedCount(buildAskContext([view(), view({}, null)]))).toBe(1);
  });
});

describe("the picker's ask binding", () => {
  it("binds ctrl-o and advertises it", () => {
    const args = fzfArgs(true, "preview", "reload", "gm ask --focus {1}");
    expect(args).toContain("--bind=ctrl-o:execute(gm ask --focus {1})");
    expect(args.join(" ")).toContain("ctrl-o: ask");
  });

  it("passes the highlighted session id through fzf's field", () => {
    expect(fzfArgs(true, "p", null, "gm ask --focus {1}").join(" ")).toContain("--focus {1}");
  });

  it("does not advertise ask when it cannot be bound", () => {
    // A key that does nothing is worse than a key that isn't there.
    //
    // Assert on "ctrl-o: ask", not a bare "ask": the marker key on the header's
    // second line says "ended mid-task", and "task" contains "ask". A looser
    // assertion here passes for the wrong reason.
    const args = fzfArgs(true, "preview", "reload", null);
    expect(args.join(" ")).not.toContain("ctrl-o");
    expect(args.join(" ")).not.toContain("ctrl-o: ask");
  });

  it("keeps refresh and ask independent", () => {
    const args = fzfArgs(true, "preview", null, "gm ask --focus {1}");
    expect(args.join(" ")).toContain("ctrl-o: ask");
    expect(args.join(" ")).not.toContain("ctrl-r");
  });

  it("keeps the marker key alongside the key hints", () => {
    // Both live in --header, one per line. The ask binding must not displace the
    // legend that landed in #16.
    const header = fzfArgs(true, "preview", "reload", "gm ask --focus {1}")[
      fzfArgs(true, "preview", "reload", "gm ask --focus {1}").indexOf("--header") + 1
    ]!;
    const [hints, markers] = header.split("\n");
    expect(hints).toContain("ctrl-o: ask");
    expect(markers).toContain("ended mid-task");
  });

  it("never binds a plain letter — fzf's query line would eat it", () => {
    const header = fzfArgs(true, "p", "r", "gm ask --focus {1}").join(" ");
    expect(header).not.toMatch(/--bind=[A-Za-z]:/);
  });
});

describe("shortId", () => {
  it("is what a human types", () => {
    expect(shortId("aaaa1111-0000-0000-0000-000000000000")).toBe("aaaa1111");
  });
});
