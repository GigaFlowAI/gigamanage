import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import type { SessionRecord, SummaryFields, SummaryInput, SummaryProvider } from "../src/core/types.js";
import { AmbiguousSessionError, SessionNotFoundError } from "../src/core/errors.js";
import { parseSince, relativeAge, truncate } from "../src/core/text.js";
import { buildPrompt, distill } from "../src/services/distill.js";
import { filterRecords, refreshIndex } from "../src/services/index-store.js";
import { resolveSession } from "../src/services/resolve.js";
import { batchPaths, searchSessions, snippetFrom } from "../src/services/search.js";
import { loadRecords } from "../src/services/views.js";
import { isStale, parseSummaryFields, readSummary, summarizeBatch } from "../src/services/summarize.js";
import { claudeLines, codexLines, tempHome, writeClaudeSession, writeCodexSession } from "./fixtures/build.js";

const CLAUDE_ID = "581cb3f8-7a1c-4dd0-a887-5f55f9184619";
const CODEX_ID = "019e9a77-740f-7903-942c-caab943b6101";

let home: string;
let cache: string;

beforeEach(async () => {
  home = await tempHome();
  cache = await tempHome();
  process.env.GIGAMANAGE_HOME = home;
  process.env.XDG_CACHE_HOME = cache;
});

afterEach(async () => {
  delete process.env.GIGAMANAGE_HOME;
  delete process.env.XDG_CACHE_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harness: "claude-code",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    filePath: "/tmp/a.jsonl",
    cwd: "/repo",
    project: "repo",
    gitBranch: "main",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    messageCount: 4,
    userPromptCount: 2,
    title: "started here",
    lastUserPrompt: "and ended over there",
    recentUserPrompts: ["started here", "and ended over there"],
    filesTouched: ["src/a.ts"],
    prLinks: [],
    lastAssistantText: "the last thing the agent said",
    lastToolFailure: null,
    endedMidTask: false,
    isSidechain: false,
    isAutomated: false,
    ...overrides,
  };
}

describe("text helpers", () => {
  it("renders compact relative ages", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(relativeAge("2026-07-10T10:00:00.000Z", now)).toBe("2h");
    expect(relativeAge("2026-07-07T12:00:00.000Z", now)).toBe("3d");
    expect(relativeAge("garbage", now)).toBe("?");
  });

  it("parses durations and dates for --since", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(parseSince("3d", now)).toBe("2026-07-07T12:00:00.000Z");
    expect(parseSince("2h", now)).toBe("2026-07-10T10:00:00.000Z");
    expect(parseSince("2026-07-01", now)).toBe("2026-07-01T00:00:00.000Z");
    expect(parseSince("soonish", now)).toBeNull();
  });

  it("truncates on a single line", () => {
    expect(truncate("a\n  b   c", 20)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("resolveSession", () => {
  const records = [
    record({ sessionId: "aaaa1111-1111-1111-1111-111111111111" }),
    record({ sessionId: "aaaa2222-2222-2222-2222-222222222222" }),
    record({ sessionId: "bbbb3333-3333-3333-3333-333333333333" }),
  ];

  it("resolves a unique prefix", () => {
    expect(resolveSession(records, "bbbb").sessionId).toBe("bbbb3333-3333-3333-3333-333333333333");
  });

  it("resolves a full id exactly", () => {
    expect(resolveSession(records, "aaaa1111-1111-1111-1111-111111111111").sessionId).toBe(
      "aaaa1111-1111-1111-1111-111111111111",
    );
  });

  it("refuses an ambiguous prefix rather than guessing", () => {
    expect(() => resolveSession(records, "aaaa")).toThrow(AmbiguousSessionError);
  });

  // `gm show`/`gm resume` look up with includeAutomated+includeSidechains, so an
  // id copied out of `gm ls --include-automated` actually opens.
  it("can resolve a session that `gm ls` hides by default", () => {
    const hidden = [
      record({ sessionId: "cccc4444-4444-4444-4444-444444444444", isAutomated: true }),
      record({ sessionId: "dddd5555-5555-5555-5555-555555555555", isSidechain: true }),
    ];
    const visible = filterRecords(hidden, { includeSidechains: true, includeAutomated: true });

    expect(resolveSession(visible, "cccc").isAutomated).toBe(true);
    expect(resolveSession(visible, "dddd").isSidechain).toBe(true);
  });

  it("reports an unknown id with a fix", () => {
    try {
      resolveSession(records, "zzzz");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect((error as SessionNotFoundError).fix).toContain("gm ls");
    }
  });
});

describe("filterRecords", () => {
  const records = [
    record({ sessionId: "1", project: "acme", gitBranch: "main", updatedAt: "2026-07-10T00:00:00.000Z" }),
    record({ sessionId: "2", project: "beta", gitBranch: "fix-auth", updatedAt: "2026-07-09T00:00:00.000Z" }),
    record({ sessionId: "3", project: "acme", gitBranch: "main", updatedAt: "2026-07-08T00:00:00.000Z", isSidechain: true }),
  ];

  it("hides sidechains unless asked", () => {
    expect(filterRecords(records, {}).map((r) => r.sessionId)).toEqual(["1", "2"]);
    expect(filterRecords(records, { includeSidechains: true }).map((r) => r.sessionId)).toEqual(["1", "2", "3"]);
  });

  it("hides automated runs, so the summarizer's own `claude -p` calls never show up", () => {
    const withAutomation = [
      ...records,
      record({ sessionId: "4", isAutomated: true, updatedAt: "2026-07-11T00:00:00.000Z" }),
    ];

    expect(filterRecords(withAutomation, {}).map((r) => r.sessionId)).toEqual(["1", "2"]);
    expect(filterRecords(withAutomation, { includeAutomated: true }).map((r) => r.sessionId)).toEqual([
      "4",
      "1",
      "2",
    ]);
  });

  it("filters by project, branch and recency, newest first", () => {
    expect(filterRecords(records, { project: "acme" }).map((r) => r.sessionId)).toEqual(["1"]);
    expect(filterRecords(records, { branch: "fix" }).map((r) => r.sessionId)).toEqual(["2"]);
    expect(filterRecords(records, { since: "2026-07-09T12:00:00.000Z" }).map((r) => r.sessionId)).toEqual(["1"]);
    expect(filterRecords(records, { limit: 1 }).map((r) => r.sessionId)).toEqual(["1"]);
  });
});

describe("the index", () => {
  it("indexes every harness on the machine", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });
    await writeCodexSession(home, { date: "2026-07-11", sessionId: CODEX_ID, lines: codexLines(CODEX_ID) });

    const result = await refreshIndex();

    expect(result.records).toHaveLength(2);
    expect(result.parsed).toBe(2);
    expect(new Set(result.records.map((r) => r.harness))).toEqual(new Set(["claude-code", "codex"]));
  });

  it("serves unchanged sessions from cache instead of re-parsing", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });

    expect((await refreshIndex()).parsed).toBe(1);

    const second = await refreshIndex();
    expect(second.parsed).toBe(0);
    expect(second.cached).toBe(1);
  });

  it("re-parses a session once its file changes", async () => {
    const path = await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: CLAUDE_ID,
      lines: claudeLines(CLAUDE_ID),
    });
    await refreshIndex();

    // Same size, newer mtime: the cache key must still notice.
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);

    expect((await refreshIndex()).parsed).toBe(1);
  });

  it("survives a corrupt cache file", async () => {
    await writeClaudeSession(home, { slug: "-Users-dev-acme", sessionId: CLAUDE_ID, lines: claudeLines(CLAUDE_ID) });
    await refreshIndex();

    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(cache, "gigamanage"), { recursive: true });
    await writeFile(join(cache, "gigamanage", "index.json"), "{ not json", "utf8");

    const result = await refreshIndex();
    expect(result.records).toHaveLength(1);
  });
});

describe("distillation", () => {
  it("sends the model the tail of the session, not the opening title", () => {
    const prompt = buildPrompt(distill(record()));

    expect(prompt).toContain("and ended over there");
    expect(prompt).toContain("the last thing the agent said");
    // The stale title is included, but explicitly labelled as untrustworthy.
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("where the work ACTUALLY LANDED");
  });

  it("hashes the distilled input so the cache key tracks the session's content", () => {
    const a = distill(record());
    const b = distill(record());
    const c = distill(record({ lastAssistantText: "something new happened" }));

    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("caps the file list so a huge refactor cannot dominate the prompt", () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
    expect(distill(record({ filesTouched: many })).filesTouched).toHaveLength(25);
  });
});

describe("summary parsing", () => {
  it("extracts JSON even when the model fences or prefaces it", () => {
    const fenced = '```json\n{"headline":"h","landed":"l","open":"o","nextStep":"n"}\n```';
    expect(parseSummaryFields(fenced, "test").headline).toBe("h");

    const prefaced = 'Sure! Here you go:\n{"headline":"h2","landed":"","open":"","nextStep":""}';
    expect(parseSummaryFields(prefaced, "test").headline).toBe("h2");
  });

  it("rejects a reply with no JSON, or no headline", () => {
    expect(() => parseSummaryFields("I could not do that", "test")).toThrow(/no JSON object/);
    expect(() => parseSummaryFields('{"landed":"l"}', "test")).toThrow(/no `headline`/);
  });
});

/** A stand-in for the model. No test in this suite ever calls a real one. */
class FakeProvider implements SummaryProvider {
  readonly name = "fake";
  calls = 0;
  constructor(private readonly fields: SummaryFields = { headline: "h", landed: "l", open: "o", nextStep: "n" }) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async generate(_input: SummaryInput): Promise<SummaryFields> {
    this.calls += 1;
    return this.fields;
  }
}

describe("summaries", () => {
  it("writes a summary and reads it back", async () => {
    const provider = new FakeProvider();
    const target = record();

    const result = await summarizeBatch([target], provider);
    expect(result.generated).toBe(1);

    const summary = await readSummary(target);
    expect(summary?.headline).toBe("h");
    expect(summary?.provider).toBe("fake");
  });

  it("skips a session whose cached summary is still current", async () => {
    const provider = new FakeProvider();
    const target = record();

    await summarizeBatch([target], provider);
    const second = await summarizeBatch([target], provider);

    expect(second.generated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("regenerates once the session has moved on", async () => {
    const provider = new FakeProvider();
    const before = record();
    await summarizeBatch([before], provider);

    const after = record({ lastAssistantText: "new work happened since" });
    const summary = await readSummary(after);

    expect(isStale(summary, after)).toBe(true);

    const result = await summarizeBatch([after], provider);
    expect(result.generated).toBe(1);
  });

  it("collects failures instead of aborting the batch", async () => {
    const flaky: SummaryProvider = {
      name: "flaky",
      isAvailable: async () => true,
      generate: vi
        .fn<(input: SummaryInput) => Promise<SummaryFields>>()
        .mockRejectedValueOnce(new Error("model exploded"))
        .mockResolvedValue({ headline: "ok", landed: "", open: "", nextStep: "" }),
    };

    const result = await summarizeBatch([record({ sessionId: "a" }), record({ sessionId: "b" })], flaky);

    expect(result.failed).toHaveLength(1);
    expect(result.generated).toBe(1);
  });
});

describe("searching for awkward queries", () => {
  // A bare positional pattern starting with "-" is parsed by ripgrep as an option.
  it("finds a query that begins with a dash instead of erroring", async () => {
    const path = await writeClaudeSession(home, {
      slug: "-Users-dev-acme",
      sessionId: CLAUDE_ID,
      lines: [
        {
          type: "user",
          sessionId: CLAUDE_ID,
          cwd: "/Users/dev/acme",
          timestamp: "2026-07-10T10:00:00.000Z",
          message: { role: "user", content: "pass --fixed-strings to it" },
        },
      ],
    });
    const records = await loadRecords({});
    const target = records.find((r) => r.filePath === path)!;

    const hits = await searchSessions({ records: [target], query: "--fixed-strings" });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchCount).toBeGreaterThan(0);
  });
});

describe("search argv batching", () => {
  // Passing every session path to ripgrep at once blows ARG_MAX once a user has
  // a few thousand sessions — exactly the user this tool is built for.
  it("splits paths into batches that fit inside argv", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `/Users/dev/.claude/projects/p/${"x".repeat(60)}-${i}.jsonl`);
    const batches = batchPaths(paths, 1000);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = batch.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(1000);
    }
    // Every path must still be searched — batching may not drop any.
    expect(batches.flat()).toEqual(paths);
  });

  it("never drops a path that is itself larger than the cap", () => {
    const huge = "/".padEnd(5000, "x");
    expect(batchPaths([huge], 100).flat()).toEqual([huge]);
  });

  it("returns nothing for no paths", () => {
    expect(batchPaths([], 1000)).toEqual([]);
  });
});

describe("search snippets", () => {
  it("shows a window around the match, not the whole JSONL line", () => {
    const line = `{"type":"user","message":{"content":"${"x".repeat(200)} needle ${"y".repeat(200)}"}}`;
    const snippet = snippetFrom(line, "needle");

    expect(snippet).toContain("needle");
    expect(snippet!.length).toBeLessThanOrEqual(90);
  });
});

describe("the CLI version", () => {
  // v0.1.1 shipped reporting "0.1.0" because the version was hardcoded in
  // main.ts. The CLI must report what package.json actually says.
  it("matches package.json rather than a hardcoded string", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const source = await readFile(new URL("../src/cli/main.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\.version\(["']\d+\.\d+\.\d+["']\)/);
    expect(source).toContain(".version(version)");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
