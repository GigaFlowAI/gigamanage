# Cockpit Work Report (`v`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing `v` in the gmux cockpit generates a per-session HTML "work report" for every visible pane and shows a `file://` link the user opens in their browser.

**Architecture:** A new services module (`work-view.ts`) turns each `SessionRecord` into a self-contained HTML fragment via the existing CLI provider, cached by content hash like summaries. A pure cli module (`work-report.ts`) assembles those fragments into one HTML page, each fragment isolated in a sandboxed `<iframe srcdoc>`. The cockpit command gains a `v` handler that resolves visible panes to records, builds the report, writes it to a temp file, and shows the link in a status banner. No browser is launched; no mermaid.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, vitest. Reuses `distill`, `runProviderCommand`, `resolveSummaryCommand`, `mapLimit`, `onPath`.

**Spec:** `docs/superpowers/specs/2026-08-18-cockpit-work-diagrams-design.md`

## Global Constraints

- **Layering** (`npm run check:layers`): `core ← adapters ← services ← cli`. A module may import only its own layer or layers to the left. `work-view.ts` is **services** (imports core/services only); `work-report.ts` is **cli**; `cockpit.ts`/`gmux-render.ts` are **cli**.
- **ESM specifiers:** all relative imports end in `.js` (e.g. `"../core/types.js"`), even for `.ts` sources.
- **No new runtime dependency.** The report is self-contained by construction — no mermaid, no CDN, no external `<script src>`/CSS/img.
- **Provider reuse:** generation uses the command from `resolveSummaryCommand(await readConfig())` (i.e. `claude -p` / `GMUX_SUMMARY_CMD`). A null command means "no model configured" and must degrade gracefully, never throw.
- **Failures are collected, not thrown:** one bad session must never abort the batch or break the page (the `summarizeBatch` pattern).
- **Test command:** `npx vitest run <file>` for a single file; `npm run check` before finishing (layers + types + full suite).

---

### Task 1: Cache and report paths

**Files:**
- Modify: `src/core/paths.ts`
- Test: `tests/gmux-paths.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `workViewDir(): string` → `cacheDir()/work-views`
  - `workViewPath(harness: string, sessionId: string): string` → `workViewDir()/<harness>-<sessionId>.json`
  - `workReportPath(): string` → `join(tmpdir(), "gmux-work-report.html")`

- [ ] **Step 1: Write the failing test**

Append to `tests/gmux-paths.test.ts`:

```ts
import { tmpdir } from "node:os";
import { workViewPath, workReportPath } from "../src/core/paths.js";

describe("work report paths", () => {
  it("work-view cache path is under the cache dir, keyed by harness+session, as JSON", () => {
    const p = workViewPath("claude-code", "abc123");
    expect(p).toContain("work-views");
    expect(p.endsWith("claude-code-abc123.json")).toBe(true);
  });
  it("report path is a single stable html file in the temp dir", () => {
    expect(workReportPath()).toBe(`${tmpdir()}/gmux-work-report.html`);
  });
});
```

(If `tests/gmux-paths.test.ts` has no `describe`/`import` for vitest yet, add `import { describe, expect, it } from "vitest";` at the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-paths.test.ts`
Expected: FAIL — `workViewPath`/`workReportPath` are not exported.

- [ ] **Step 3: Implement**

In `src/core/paths.ts`, add `tmpdir` to the existing `node:os` import:

```ts
import { homedir, tmpdir } from "node:os";
```

Add, next to `summaryDir`/`summaryPath`:

```ts
/** Directory of generated work-view fragments, one JSON file per session. */
export function workViewDir(): string {
  return join(cacheDir(), "work-views");
}

/** Cached work-view (metadata + HTML fragment) for one session. */
export function workViewPath(harness: string, sessionId: string): string {
  return join(workViewDir(), `${harness}-${sessionId}.json`);
}

/**
 * The assembled work report. One stable file in the temp dir so re-pressing `v`
 * overwrites it and the `file://` link the cockpit shows stays the same.
 */
export function workReportPath(): string {
  return join(tmpdir(), "gmux-work-report.html");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts tests/gmux-paths.test.ts
git commit -m "feat(paths): add work-view cache and work-report paths"
```

---

### Task 2: Work-view core — prompt, fragment extraction, cache

**Files:**
- Create: `src/services/work-view.ts`
- Test: `tests/work-view.test.ts`

**Interfaces:**
- Consumes: `distill` (`src/services/distill.ts`), `hash` (`src/core/text.js`), `workViewPath` (Task 1), `SessionRecord`/`HarnessId` (`src/core/types.js`).
- Produces:
  - `interface WorkView { harness: HarnessId; sessionId: string; sourceHash: string; generatedAt: string; provider: string; html: string; }`
  - `WORKVIEW_PROMPT_VERSION: number`
  - `workViewSourceHash(record: SessionRecord): string`
  - `buildWorkViewPrompt(input: SummaryInput): string`
  - `extractFragment(raw: string): string` (throws `Error` on non-HTML)
  - `isStale(view: WorkView | null, record: SessionRecord): boolean`
  - `readWorkView(record: SessionRecord): Promise<WorkView | null>`
  - `writeWorkView(view: WorkView): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/work-view.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorkViewPrompt,
  extractFragment,
  isStale,
  readWorkView,
  workViewSourceHash,
  writeWorkView,
  type WorkView,
} from "../src/services/work-view.js";
import { distill } from "../src/services/distill.js";
import type { SessionRecord } from "../src/core/types.js";

const record: SessionRecord = {
  harness: "claude-code", sessionId: "s1", filePath: "/x.jsonl", cwd: "/w/shop",
  project: "shop", gitBranch: "main", startedAt: null, updatedAt: "2026-08-18T00:00:00Z",
  messageCount: 4, userPromptCount: 2, title: "start", lastUserPrompt: "ship it",
  recentUserPrompts: ["ship it"], arcPrompts: ["add auth", "ship it"], filesTouched: ["a.ts"],
  prLinks: [], lastAssistantText: "opened PR #7", lastToolFailure: null,
  endedMidTask: false, isSidechain: false, isAutomated: false,
};

describe("extractFragment", () => {
  it("strips a ```html fence", () => {
    expect(extractFragment("```html\n<svg><rect/></svg>\n```")).toBe("<svg><rect/></svg>");
  });
  it("accepts a bare fragment", () => {
    expect(extractFragment("  <div>hi</div>  ")).toBe("<div>hi</div>");
  });
  it("rejects text with no HTML tag", () => {
    expect(() => extractFragment("sorry, I cannot")).toThrow();
  });
});

describe("buildWorkViewPrompt", () => {
  it("asks for a self-contained HTML fragment and includes session evidence", () => {
    const p = buildWorkViewPrompt(distill(record));
    expect(p.toLowerCase()).toContain("html");
    expect(p).toContain("opened PR #7"); // final message flows in
    expect(p.toLowerCase()).toContain("no <script"); // forbids scripts / external refs
  });
});

describe("cache staleness", () => {
  it("is stale with no view, fresh when the source hash matches", () => {
    expect(isStale(null, record)).toBe(true);
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<i/>",
    };
    expect(isStale(view, record)).toBe(false);
    expect(isStale({ ...view, sourceHash: "different" }, record)).toBe(true);
  });
});

describe("read/write round-trip", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "gmux-wv-")); process.env.XDG_CACHE_HOME = dir; });
  afterEach(() => { delete process.env.XDG_CACHE_HOME; });
  it("writes then reads the same view", async () => {
    const view: WorkView = {
      harness: record.harness, sessionId: record.sessionId,
      sourceHash: workViewSourceHash(record), generatedAt: "t", provider: "p", html: "<b>x</b>",
    };
    await writeWorkView(view);
    expect(await readWorkView(record)).toEqual(view);
  });
  it("returns null when the cache file is absent", async () => {
    expect(await readWorkView({ ...record, sessionId: "missing" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/work-view.test.ts`
Expected: FAIL — cannot find module `../src/services/work-view.js`.

- [ ] **Step 3: Implement**

Create `src/services/work-view.ts` (this step covers only the core; the provider/batch land in Task 3):

```ts
/**
 * Work views: the report layer that answers "what did this session actually
 * DO?" as a small, self-contained HTML fragment a browser can render.
 *
 * Generation runs only on an explicit `v` press in the cockpit, never in the
 * background — so the cache uses an exact source hash (regenerate on any real
 * change), not the summary layer's divergence gate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { hash } from "../core/text.js";
import { workViewPath } from "../core/paths.js";
import type { HarnessId, SessionRecord, SummaryInput } from "../core/types.js";
import { distill } from "./distill.js";

/** Bump when `buildWorkViewPrompt` changes shape, to invalidate cached fragments. */
export const WORKVIEW_PROMPT_VERSION = 1;

export interface WorkView {
  harness: HarnessId;
  sessionId: string;
  /** distill hash folded with the prompt version — the cache key. */
  sourceHash: string;
  generatedAt: string;
  provider: string;
  /** Validated, self-contained HTML fragment. */
  html: string;
}

/** Cache key: session content (via distill) plus this layer's prompt version. */
export function workViewSourceHash(record: SessionRecord): string {
  return hash(JSON.stringify({ session: distill(record).hash, prompt: WORKVIEW_PROMPT_VERSION }));
}

export function isStale(view: WorkView | null, record: SessionRecord): boolean {
  return !view || view.sourceHash !== workViewSourceHash(record);
}

export async function readWorkView(record: SessionRecord): Promise<WorkView | null> {
  try {
    return JSON.parse(await readFile(workViewPath(record.harness, record.sessionId), "utf8")) as WorkView;
  } catch {
    return null;
  }
}

export async function writeWorkView(view: WorkView): Promise<void> {
  const path = workViewPath(view.harness, view.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(view), "utf8");
}

/**
 * Pull a usable HTML fragment out of a model reply. Strips a single ```html /
 * ``` fence if present, and requires the body to contain at least one HTML tag —
 * otherwise it is a refusal or prose, and this session fails (collected upstream).
 */
export function extractFragment(raw: string): string {
  let s = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(s);
  if (fenced) s = fenced[1]!.trim();
  if (!/<[a-zA-Z][\s\S]*>/.test(s)) throw new Error("model reply contained no HTML");
  return s;
}

/** The instruction handed to the provider for one session's work view. */
export function buildWorkViewPrompt(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push(
    "You are visualizing a coding-agent session so a developer can re-orient on it at a glance.",
    "You are shown the ARC of the session: where it started, waypoints through the middle, and how it ended.",
    "",
    "## Session",
    `harness: ${input.harness}`,
  );
  if (input.project) lines.push(`project: ${input.project}`);
  if (input.gitBranch) lines.push(`branch: ${input.gitBranch}`);
  if (input.title) lines.push(`title at start (may be stale): ${input.title}`);
  lines.push(`ended mid-task: ${input.endedMidTask ? "yes" : "no"}`);
  if (input.filesTouched.length > 0) {
    lines.push("", "## Files the agent changed", ...input.filesTouched.map((f) => `- ${f}`));
  }
  const tail = new Set(input.recentUserPrompts);
  const [anchor, ...waypoints] = input.arcPrompts;
  if (anchor !== undefined && !tail.has(anchor)) lines.push("", "## The original ask", anchor);
  const fresh = waypoints.filter((p) => !tail.has(p));
  if (fresh.length > 0) lines.push("", "## How the work moved (oldest first)", ...fresh.map((p) => `- ${p}`));
  if (input.recentUserPrompts.length > 0) {
    lines.push("", "## Most recent instructions (oldest first)", ...input.recentUserPrompts.map((p) => `- ${p}`));
  }
  if (input.lastAssistantText) lines.push("", "## The agent's final message", input.lastAssistantText);
  if (input.lastToolFailure) lines.push("", "## The last failing command", input.lastToolFailure);
  lines.push(
    "",
    "## Output",
    "Reply with ONLY a self-contained HTML fragment that visualizes the ARC of this work —",
    "what was explored, built, tested, what landed, and what is still open — as a compact",
    "diagram: prefer inline <svg> for a flow/timeline, or styled inline HTML. Keep it small",
    "(aim for a handful of nodes). Constraints, strictly:",
    "- NO <script>, NO external references (no <script src>, no remote CSS, fonts, or <img>).",
    "- NO <html>, <head>, or <body> wrapper — emit the fragment only.",
    "- All styling inline or in a single <style> inside the fragment.",
    "Return the fragment and nothing else — no prose, no code fence.",
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/work-view.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/work-view.ts tests/work-view.test.ts
git commit -m "feat(work-view): prompt, fragment extraction, and cache core"
```

---

### Task 3: Work-view generation — provider and batch

**Files:**
- Modify: `src/services/work-view.ts`
- Test: `tests/work-view.test.ts` (append)

**Interfaces:**
- Consumes: `runProviderCommand` (`src/services/provider-process.js`), `resolveSummaryCommand`/`readConfig` (`src/services/config.js`), `onPath` (`src/services/providers.js`), `mapLimit` (`src/services/concurrency.js`), `SummaryProviderError` (`src/core/errors.js`), plus Task 2's own exports.
- Produces:
  - `interface WorkViewProvider { readonly name: string; isAvailable(): Promise<boolean>; render(prompt: string): Promise<string>; }`
  - `class CliWorkViewProvider implements WorkViewProvider`
  - `defaultWorkViewProvider(): Promise<CliWorkViewProvider | null>`
  - `generateWorkView(record: SessionRecord, provider: WorkViewProvider, now?: () => Date): Promise<WorkView>`
  - `interface BuildWorkViewsResult { views: Map<string, WorkView>; failed: { sessionId: string; reason: string }[]; }`
  - `buildWorkViews(records, provider, options?): Promise<BuildWorkViewsResult>` where `options?: { force?: boolean; onProgress?: (done: number, total: number) => void }`

- [ ] **Step 1: Write the failing test**

Append to `tests/work-view.test.ts`:

```ts
import { buildWorkViews, generateWorkView, type WorkViewProvider } from "../src/services/work-view.js";

class StubProvider implements WorkViewProvider {
  readonly name = "stub";
  constructor(private readonly reply: (sessionId: string) => string) {}
  async isAvailable() { return true; }
  async render(prompt: string) {
    const id = /session\s+so|s1|s2/.exec(prompt); // not used; reply keyed below
    return this.reply(prompt);
  }
}

describe("generateWorkView", () => {
  it("produces a cached-shaped view from the provider reply", async () => {
    const provider = new StubProvider(() => "<svg><rect/></svg>");
    const view = await generateWorkView(record, provider, () => new Date("2026-08-18T12:00:00Z"));
    expect(view.html).toBe("<svg><rect/></svg>");
    expect(view.provider).toBe("stub");
    expect(view.sourceHash).toBe(workViewSourceHash(record));
    expect(view.generatedAt).toBe("2026-08-18T12:00:00.000Z");
  });
});

describe("buildWorkViews", () => {
  beforeEach(async () => { const d = await mkdtemp(join(tmpdir(), "gmux-wvb-")); process.env.XDG_CACHE_HOME = d; });
  afterEach(() => { delete process.env.XDG_CACHE_HOME; });

  const r2: SessionRecord = { ...record, sessionId: "s2" };

  it("generates a view per record and caches it", async () => {
    let calls = 0;
    const provider = new StubProvider(() => { calls++; return "<div>ok</div>"; });
    const first = await buildWorkViews([record, r2], provider);
    expect(first.views.size).toBe(2);
    expect(first.failed).toEqual([]);
    expect(calls).toBe(2);
    // second run is served entirely from cache — provider not called again
    const second = await buildWorkViews([record, r2], provider);
    expect(second.views.size).toBe(2);
    expect(calls).toBe(2);
  });

  it("collects a failing session without aborting the batch", async () => {
    const provider = new StubProvider((p) => (p.includes("s2") ? "no html here" : "<div>ok</div>"));
    // r2's distilled prompt won't contain "s2"; force a real failure via non-HTML for BOTH is wrong —
    // instead make the provider throw for r2 by sessionId is not visible in prompt, so reply non-HTML for all
    const bad = new StubProvider(() => "sorry");
    const res = await buildWorkViews([record, r2], bad);
    expect(res.views.size).toBe(0);
    expect(res.failed.map((f) => f.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(res.failed[0]!.reason).toContain("no HTML");
  });
});
```

> Note for the implementer: the stub can't see the sessionId in the distilled prompt, so the "mixed" case is tested as "all fail" (non-HTML reply) — the point is that failures are *collected*, and the batch still returns. Keep the two assertions as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/work-view.test.ts`
Expected: FAIL — `buildWorkViews`/`generateWorkView`/`WorkViewProvider` not exported.

- [ ] **Step 3: Implement**

Append to `src/services/work-view.ts`. Add imports at the top of the file:

```ts
import { SummaryProviderError } from "../core/errors.js";
import { FALLBACK_COMMAND, readConfig, resolveSummaryCommand } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { runProviderCommand } from "./provider-process.js";
import { onPath } from "./providers.js";
```

Then append:

```ts
const PROVIDER_TIMEOUT_MS = 120_000;
const WORKVIEW_CONCURRENCY = Number(process.env["GMUX_WORKVIEW_CONCURRENCY"]) || 8;

/** A prompt goes in, an HTML fragment (unvalidated) comes out. */
export interface WorkViewProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  render(prompt: string): Promise<string>;
}

/** The default: the same CLI the summarizer uses (`claude -p` / GMUX_SUMMARY_CMD). */
export class CliWorkViewProvider implements WorkViewProvider {
  readonly name: string;
  private readonly argv: string[];
  constructor(argv: string[] = [...FALLBACK_COMMAND]) {
    this.argv = argv;
    this.name = argv.join(" ");
  }
  async isAvailable(): Promise<boolean> {
    const binary = this.argv[0];
    return binary ? onPath(binary) : false;
  }
  async render(prompt: string): Promise<string> {
    try {
      return await runProviderCommand(this.argv, prompt, { timeoutMs: PROVIDER_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof SummaryProviderError) throw error;
      throw new SummaryProviderError(this.name, (error as Error).message);
    }
  }
}

/** The provider for the current config, or null when the user configured no model. */
export async function defaultWorkViewProvider(): Promise<CliWorkViewProvider | null> {
  const command = resolveSummaryCommand(await readConfig());
  return command ? new CliWorkViewProvider(command) : null;
}

export async function generateWorkView(
  record: SessionRecord,
  provider: WorkViewProvider,
  now: () => Date = () => new Date(),
): Promise<WorkView> {
  const raw = await provider.render(buildWorkViewPrompt(distill(record)));
  return {
    harness: record.harness,
    sessionId: record.sessionId,
    sourceHash: workViewSourceHash(record),
    generatedAt: now().toISOString(),
    provider: provider.name,
    html: extractFragment(raw),
  };
}

export interface BuildWorkViewsResult {
  views: Map<string, WorkView>;
  failed: { sessionId: string; reason: string }[];
}

/**
 * Build a view per record, serving fresh ones from cache. One session's failure
 * (provider error, non-HTML reply) is collected, never thrown: a single bad
 * session must not blank the whole report.
 */
export async function buildWorkViews(
  records: readonly SessionRecord[],
  provider: WorkViewProvider,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BuildWorkViewsResult> {
  const views = new Map<string, WorkView>();
  const failed: { sessionId: string; reason: string }[] = [];
  let done = 0;
  await mapLimit(records, WORKVIEW_CONCURRENCY, async (record) => {
    try {
      let view = options.force ? null : await readWorkView(record);
      if (isStale(view, record)) {
        view = await generateWorkView(record, provider);
        await writeWorkView(view);
      }
      views.set(record.sessionId, view!);
    } catch (error) {
      failed.push({ sessionId: record.sessionId, reason: (error as Error).message });
    } finally {
      done += 1;
      options.onProgress?.(done, records.length);
    }
  });
  return { views, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/work-view.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/work-view.ts tests/work-view.test.ts
git commit -m "feat(work-view): CLI provider and cached batch generation"
```

---

### Task 4: Work report — pure HTML assembly

**Files:**
- Create: `src/cli/work-report.ts`
- Test: `tests/work-report.test.ts`

**Interfaces:**
- Consumes: nothing (pure). It does NOT import `WorkView`; the cockpit maps views to cards.
- Produces:
  - `interface WorkReportCard { label: string; headline: string | null; html: string | null; note: string | null; }`
  - `renderWorkReportHtml(cards: readonly WorkReportCard[], now: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/work-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderWorkReportHtml, type WorkReportCard } from "../src/cli/work-report.js";

const at = Date.parse("2026-08-18T12:00:00Z");

describe("renderWorkReportHtml", () => {
  it("is a self-contained page with no external references", () => {
    const html = renderWorkReportHtml([], at);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/src=|https?:\/\//); // no external scripts/links/images
    expect(html.toLowerCase()).toContain("no sessions");
  });

  it("embeds each fragment in a sandboxed iframe srcdoc", () => {
    const cards: WorkReportCard[] = [{ label: "shop", headline: "adding auth", html: "<svg></svg>", note: null }];
    const html = renderWorkReportHtml(cards, at);
    expect(html).toContain("shop");
    expect(html).toContain("adding auth");
    expect(html).toMatch(/<iframe[^>]*sandbox/);
    expect(html).toContain("srcdoc=");
    expect(html).toContain("&lt;svg&gt;"); // fragment is attribute-escaped into srcdoc, not live in the DOM
  });

  it("renders the note when a card has no html, and escapes chrome text", () => {
    const cards: WorkReportCard[] = [
      { label: "a & b <x>", headline: null, html: null, note: "generation failed: boom" },
    ];
    const html = renderWorkReportHtml(cards, at);
    expect(html).toContain("generation failed: boom");
    expect(html).toContain("a &amp; b &lt;x&gt;"); // label escaped in our own chrome
    expect(html).not.toMatch(/<iframe/); // note card has no iframe
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/work-report.test.ts`
Expected: FAIL — cannot find module `../src/cli/work-report.js`.

- [ ] **Step 3: Implement**

Create `src/cli/work-report.ts`:

```ts
/**
 * The work report: the wide-angle bottom of gmux's attention funnel. A pure
 * assembly of per-session cards into one self-contained HTML page — no external
 * references of any kind. Each model-generated fragment is UNTRUSTED and is
 * embedded via a sandboxed <iframe srcdoc>, which is the trust boundary: bad
 * markup can only affect its own card, never the shell or a sibling.
 */

export interface WorkReportCard {
  /** Pane/project label — trusted chrome, escaped. */
  label: string;
  /** Session summary headline, if one exists — trusted chrome, escaped. */
  headline: string | null;
  /** The model fragment. null → render `note` instead. */
  html: string | null;
  /** Shown when there is no fragment (no provider, or generation failed). */
  note: string | null;
}

/**
 * Escape text into our own HTML — element content OR a double-quoted attribute,
 * including a `srcdoc`. Escaping `<`/`>` here is correct, not corrupting: the
 * browser attribute-unescapes `srcdoc` (`&lt;`→`<`) BEFORE parsing its value as
 * a document, so `&lt;svg&gt;` and a literal `<svg>` render identically — and
 * full escaping keeps the attribute well-formed. The sandbox contains the
 * fragment's behavior; this escaping keeps our page well-formed around it.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  header { padding: 12px 20px; border-bottom: 1px solid GrayText; font-weight: 600; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; padding: 20px; }
  section.card { border: 1px solid GrayText; border-radius: 8px; overflow: hidden; }
  section.card > h2 { margin: 0; padding: 10px 14px; font-size: 14px; border-bottom: 1px solid GrayText; }
  section.card > .headline { margin: 0; padding: 6px 14px; opacity: 0.75; font-size: 13px; }
  iframe { width: 100%; min-height: 240px; border: 0; background: white; }
  p.note { margin: 0; padding: 16px; opacity: 0.7; }
`;

function card(c: WorkReportCard): string {
  const head =
    `<h2>${esc(c.label)}</h2>` +
    (c.headline ? `<p class="headline">${esc(c.headline)}</p>` : "");
  const body = c.html
    ? `<iframe sandbox srcdoc="${esc(c.html)}"></iframe>`
    : `<p class="note">${esc(c.note ?? "no work view")}</p>`;
  return `<section class="card">${head}${body}</section>`;
}

export function renderWorkReportHtml(cards: readonly WorkReportCard[], now: number): string {
  const when = new Date(now).toISOString();
  const title = `gmux work report · ${cards.length} session${cards.length === 1 ? "" : "s"} · ${when}`;
  const main = cards.length === 0
    ? `<main><p class="note">No sessions to report.</p></main>`
    : `<main>${cards.map(card).join("")}</main>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>gmux work report</title><style>${STYLE}</style></head>` +
    `<body><header>${esc(title)}</header>${main}</body></html>`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/work-report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/work-report.ts tests/work-report.test.ts
git commit -m "feat(work-report): pure sandboxed-iframe HTML assembly"
```

---

### Task 5: Cockpit wiring — footer hint, status banner, `v` handler

**Files:**
- Modify: `src/cli/gmux-render.ts` (add `status` option + footer hint)
- Modify: `src/cli/commands/cockpit.ts` (latest-snapshot tracking, `sessionsForSnapshot`, `v` handler)
- Test: `tests/gmux-render.test.ts` (append), `tests/cli-cockpit.test.ts` (append)

**Interfaces:**
- Consumes: `buildWorkViews`/`defaultWorkViewProvider` (Task 3), `renderWorkReportHtml`/`WorkReportCard` (Task 4), `workReportPath` (Task 1), `loadCachedRecords`/`attachSummaries` (`src/services/views.js`).
- Produces:
  - `RenderCockpitOptions` gains `status?: string | null`.
  - `sessionsForSnapshot(snapshot: WorkspaceSnapshot, records: readonly SessionRecord[]): { label: string; record: SessionRecord }[]` (exported from `cockpit.ts`, pure).

- [ ] **Step 1: Write the failing tests**

Append to `tests/gmux-render.test.ts`:

```ts
describe("cockpit chrome", () => {
  it("always shows the work-report key hint", () => {
    expect(renderCockpit(snap, 100_000, 120).join("\n")).toContain("v: work report");
  });
  it("shows a status banner when one is set", () => {
    const lines = renderCockpit(snap, 100_000, { status: "✓ work report: file:///tmp/x.html" }).join("\n");
    expect(lines).toContain("file:///tmp/x.html");
  });
});
```

Append to `tests/cli-cockpit.test.ts`:

```ts
import { sessionsForSnapshot } from "../src/cli/commands/cockpit.js";
import type { SessionRecord } from "../src/core/types.js";

function pane(sessionId: string | null, cwd: string) {
  return {
    identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code" as const, sessionId, cwd, command: "node", pid: 1 },
    state: "working" as const, semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
  };
}
const rec = (sessionId: string): SessionRecord => ({
  harness: "claude-code", sessionId, filePath: "/x", cwd: "/w", project: "w", gitBranch: null,
  startedAt: null, updatedAt: "t", messageCount: 1, userPromptCount: 1, title: null, lastUserPrompt: null,
  recentUserPrompts: [], arcPrompts: [], filesTouched: [], prLinks: [], lastAssistantText: null,
  lastToolFailure: null, endedMidTask: false, isSidechain: false, isAutomated: false,
});

describe("sessionsForSnapshot", () => {
  it("pairs panes that have a matching record, skips session-less and unmatched panes, dedupes", () => {
    const snapshot = { version: 1, updatedAt: 0, panes: [pane("s1", "/w/shop"), pane(null, "/w/none"), pane("s1", "/w/dup"), pane("s9", "/w/x")], hostPressure: null, guardianLog: [] };
    const out = sessionsForSnapshot(snapshot, [rec("s1")]);
    expect(out.map((s) => s.label)).toEqual(["shop"]); // s1 once (basename of first pane), no null, no unmatched s9
    expect(out[0]!.record.sessionId).toBe("s1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gmux-render.test.ts tests/cli-cockpit.test.ts`
Expected: FAIL — `status` not rendered / no `v: work report` line; `sessionsForSnapshot` not exported.

- [ ] **Step 3a: Implement the render changes**

In `src/cli/gmux-render.ts`, extend the options and normalizer:

```ts
export interface RenderCockpitOptions {
  width?: number;
  stale?: { ageMs: number } | null;
  status?: string | null;
}
```

```ts
function normalizeCockpitOptions(widthOrOpts: number | RenderCockpitOptions | undefined): { width: number; stale: { ageMs: number } | null; status: string | null } {
  if (typeof widthOrOpts === "number") return { width: widthOrOpts, stale: null, status: null };
  return { width: widthOrOpts?.width ?? 120, stale: widthOrOpts?.stale ?? null, status: widthOrOpts?.status ?? null };
}
```

In `renderCockpit`, destructure `status` and render it just under any stale banner, then add the footer hint at the very end:

```ts
  const { stale, status } = normalizeCockpitOptions(widthOrOpts);
  const lines: string[] = [];
  if (stale) lines.push(`⚠ daemon not connected — snapshot ${relativeTime(now - stale.ageMs, now)}`);
  if (status) lines.push(status);
```

…and immediately before `return lines;`:

```ts
  lines.push("", "v: work report");
  return lines;
```

- [ ] **Step 3b: Implement the cockpit changes**

Rewrite `src/cli/commands/cockpit.ts` to track the latest snapshot, expose `sessionsForSnapshot`, and add the `v` handler. Full file:

```ts
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { workReportPath } from "../../core/paths.js";
import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import type { SessionRecord } from "../../core/types.js";
import { readSnapshotFile, subscribe } from "../../services/daemon-client.js";
import { attachSummaries, loadCachedRecords } from "../../services/views.js";
import { buildWorkViews, defaultWorkViewProvider } from "../../services/work-view.js";
import { renderCockpit, type RenderCockpitOptions } from "../gmux-render.js";
import { renderWorkReportHtml, type WorkReportCard } from "../work-report.js";
import { isCloseKey } from "./overlay.js";

/** Clear screen + home, then the cockpit grid — CRLF-joined for raw-mode stdout. */
export function buildFrame(snapshot: WorkspaceSnapshot, now: number, opts?: RenderCockpitOptions): string {
  return "\x1b[2J\x1b[H" + renderCockpit(snapshot, now, opts).join("\r\n");
}

/**
 * The panes that have a resolvable session, paired with their record. Pure so
 * the pairing is tested without a daemon: matches on `identity.sessionId`, skips
 * session-less and unmatched panes, and dedupes a session claimed by two panes.
 */
export function sessionsForSnapshot(
  snapshot: WorkspaceSnapshot,
  records: readonly SessionRecord[],
): { label: string; record: SessionRecord }[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const seen = new Set<string>();
  const out: { label: string; record: SessionRecord }[] = [];
  for (const p of snapshot.panes) {
    const sid = p.identity.sessionId;
    if (!sid || seen.has(sid)) continue;
    const record = byId.get(sid);
    if (!record) continue;
    seen.add(sid);
    out.push({ label: p.identity.cwd ? basename(p.identity.cwd) : p.identity.command, record });
  }
  return out;
}

/**
 * The whole-workspace cockpit: paint the last known snapshot immediately, then
 * stay live off the daemon socket until a close key is pressed. `v` builds a
 * per-session HTML work report and shows a file:// link in the status banner.
 */
export function registerCockpit(program: Command): void {
  program
    .command("cockpit")
    .description("pull up the gmux workspace cockpit (used by the tmux ctrl-g binding)")
    .action(async () => {
      let latest: WorkspaceSnapshot | null = null;
      let stale: { ageMs: number } | null = null;
      let status: string | null = null;
      let building = false;

      const render = (): void => {
        if (latest) process.stdout.write(buildFrame(latest, Date.now(), { stale, status }));
      };

      const initial = await readSnapshotFile();
      if (initial) { latest = initial.snapshot; render(); }

      const onSnapshot = (s: WorkspaceSnapshot): void => { latest = s; stale = null; render(); };
      const paintStale = (): void => {
        readSnapshotFile()
          .then((current) => { if (current) { latest = current.snapshot; stale = { ageMs: current.ageMs }; render(); } })
          .catch(() => { /* keep showing the last snapshot */ });
      };
      const stop = subscribe(onSnapshot, { onError: paintStale });

      const buildReport = async (): Promise<void> => {
        if (building || !latest) return;
        building = true;
        status = "⧗ building work report…";
        render();
        try {
          const sessions = sessionsForSnapshot(latest, await loadCachedRecords());
          if (sessions.length === 0) { status = "no sessions to report"; return; }
          const records = sessions.map((s) => s.record);
          const provider = await defaultWorkViewProvider();
          const built = provider ? await buildWorkViews(records, provider) : null;
          const headlines = new Map(
            (await attachSummaries(records)).map((v) => [v.record.sessionId, v.summary?.headline ?? null]),
          );
          const cards: WorkReportCard[] = sessions.map(({ label, record }) => {
            const headline = headlines.get(record.sessionId) ?? null;
            if (!built) return { label, headline, html: null, note: "no model configured — run `gmux setup`" };
            const view = built.views.get(record.sessionId);
            if (view) return { label, headline, html: view.html, note: null };
            const reason = built.failed.find((f) => f.sessionId === record.sessionId)?.reason ?? "unknown";
            return { label, headline, html: null, note: `generation failed: ${reason}` };
          });
          const path = workReportPath();
          await writeFile(path, renderWorkReportHtml(cards, Date.now()), "utf8");
          status = `✓ work report: file://${path}`;
        } catch (error) {
          status = `⚠ ${(error as Error).message}`;
        } finally {
          building = false;
          render();
        }
      };

      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();

      await new Promise<void>((done) => {
        stdin.on("data", (buf: Buffer) => {
          const s = buf.toString();
          if (isCloseKey(s)) return done();
          if (s === "v" || s === "V") void buildReport();
        });
      });

      stop();
      if (stdin.isTTY) stdin.setRawMode?.(false);
      process.exit(0);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gmux-render.test.ts tests/cli-cockpit.test.ts`
Expected: PASS

- [ ] **Step 5: Full check + commit**

Run: `npm run check`
Expected: layers ok, types ok, full suite green.

```bash
git add src/cli/gmux-render.ts src/cli/commands/cockpit.ts tests/gmux-render.test.ts tests/cli-cockpit.test.ts
git commit -m "feat(cockpit): v opens a per-session HTML work report"
```

---

## Self-Review

**Spec coverage:**
- `v` triggers generation + report + link → Task 5. ✓
- Per-session HTML fragment via existing provider, no mermaid → Tasks 2–3. ✓
- Cache by fingerprint (`sourceHash`), regenerate only changed sessions → Tasks 2–3 (`workViewSourceHash`, `isStale`, `buildWorkViews` skip-fresh). ✓
- Every visible pane gets a card → Task 5 (`sessionsForSnapshot` + `buildWorkViews`). ✓
- Sandboxed `<iframe srcdoc>` per card, shell chrome escaped → Task 4. ✓
- No auto-open; `file://` link in a status banner → Task 5. ✓
- Degradation: no provider → note; per-session failure → note; empty workspace → banner, no file → Task 5. ✓
- Footer hint `v: work report` → Task 5 (render). ✓
- Cache path under `cacheDir()`, report path in tmp → Task 1. ✓

**Placeholder scan:** No TBD/TODO/"handle errors"; every code and test step is concrete.

**Type consistency:** `WorkView`, `WorkViewProvider`, `BuildWorkViewsResult`, `WorkReportCard` names and fields are identical across the tasks that define and consume them. `buildWorkViews` returns `{ views: Map<string, WorkView>; failed }`, consumed exactly that way in Task 5. `sessionsForSnapshot` returns `{ label; record }[]`, consumed exactly that way.

**Deviation from spec (intentional):** the cache file is `.json` (it holds metadata + html), not `.html` as the spec's prose loosely stated — the assembled *report* is the `.html`. Noted here so a reviewer isn't surprised.
