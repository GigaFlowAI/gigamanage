# Cockpit visual mode — per-session work report (`v`)

**Status:** design / awaiting review
**Date:** 2026-08-18

## Problem

The cockpit (`ctrl-g`) is the *overview* rung of gmux's attention funnel:
headline (border label) → overview (cockpit grid) → summary (overlay cards) →
**full report**. There is no bottom rung — no surface where a user who has
deliberately drilled all the way in can see, at a glance and *visually*, the
shape of the work each agent session has done.

We want that bottom rung. Pressing `v` in the cockpit generates a **visual
summary of the work done for every visible pane's session**, assembles them into
one self-contained HTML report file, and shows the user a `file://` link to open
in their own browser. The HTML page is the wide-angle lens: the surface with the
most room, so it carries the richest rendering and justifies the most LLM spend —
spent only because the user asked for it by pressing `v`.

## Non-goals

- **No mermaid.** Since the report is HTML, the model emits the visualization
  *as HTML directly* (a compact inline-SVG / styled-HTML fragment per session)
  rather than routing through mermaid syntax + a renderer. No `mermaid`
  dependency, no CDN. (Decided during brainstorming.)
- **No programmatic browser launch.** gmux does not open or render the report
  itself — it writes the file and prints a link. The browser renders it when the
  user opens the link. (No `open`/`xdg-open`, no platform branching; opening a
  browser from inside a tmux popup is unreliable anyway.)
- No always-on / background generation. Report cards are generated on demand,
  when `v` is pressed, and cached.
- No new provider configuration. Reuse the existing summary/ask provider the
  user already set up in `gmux setup`.
- No change to the headline / overview / summary rungs.

## User-facing behavior

1. In the cockpit, the footer gains a hint: `v: work report`.
2. Pressing `v`:
   - Repaints the cockpit with a transient banner: `⧗ building work report…`
     (the cockpit stays live underneath; `v` does not block close keys).
   - Resolves the visible panes to their session records, generates/loads an
     HTML fragment per session (bounded concurrency, cached by fingerprint),
     assembles one HTML report file, and writes it to a temp path.
   - Restores the cockpit view with a persistent banner showing the link:
     `✓ work report: file:///…/gmux-work-report.html` (or an error line — see
     Degradation).
3. The user copies the link into their browser. Closing the browser doesn't
   affect the cockpit. Re-pressing `v` regenerates only sessions whose transcript
   changed, rewrites the same file, and refreshes the link line.

`v` is additive: it is not a close key and does not enter a modal sub-state. The
cockpit's existing close keys (Esc / ctrl-c / ctrl-d / ctrl-g) are unchanged.

## Architecture

Two new units plus a thin edit to the cockpit command. Each new unit has one job
and is testable without a terminal or a browser.

### 1. `src/services/work-view.ts` — generation + caching

Mirrors `summarize.ts`. Turns a `SessionRecord` into a self-contained HTML
fragment visualizing the work done, caching by content hash so unchanged sessions
are never regenerated.

```ts
export interface WorkView {
  harness: HarnessId;
  sessionId: string;
  sourceHash: string;      // distill(record).hash — staleness key, as summaries use
  generatedAt: string;
  provider: string;
  html: string;            // validated, self-contained HTML fragment (see Validation)
}

// Cache read/write, keyed like summaries.
export async function readWorkView(record: SessionRecord): Promise<WorkView | null>;
export async function writeWorkView(v: WorkView): Promise<void>;
export function isStale(v: WorkView | null, record: SessionRecord): boolean; // sourceHash !== distill(record).hash

// Generate one, using the existing CLI provider (claude -p / GMUX_SUMMARY_CMD).
export async function generateWorkView(
  record: SessionRecord,
  provider: SummaryProvider,
): Promise<WorkView>;

// Batch with skip-if-fresh + collected failures, exactly like summarizeBatch.
export async function buildWorkViews(
  records: readonly SessionRecord[],
  provider: SummaryProvider,
  options?: { force?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<{ views: Map<string, WorkView>; failed: { sessionId: string; reason: string }[] }>;
```

- **Prompt** (`buildWorkViewPrompt(input: SummaryInput): string`): reuses
  `distill(record)` as its input — the same distilled arc the summarizer already
  extracts (arcPrompts, recentUserPrompts, lastAssistantText, filesTouched,
  lastToolFailure, endedMidTask). The instruction: emit *only* a small,
  self-contained HTML fragment that visualizes the arc of work — what was
  explored, built, tested, landed, and what's still open — as a compact visual
  (inline SVG flow or a styled timeline). No external references (no `<script
  src>`, no remote CSS/img), no `<html>`/`<head>`/`<body>` wrapper — just the
  fragment. Carries its own `PROMPT_VERSION` so a prompt edit invalidates cached
  views.
- **Cache staleness** uses the exact-hash `sourceHash` (like `isStale` in
  summarize), *not* the SimHash divergence gate. Rationale: generation only runs
  on an explicit `v` press, not in a hot watch loop, so "regenerate on any real
  change" is what we want and the divergence gate (built to suppress background
  churn) buys nothing here.
- **Cache path:** new `workViewPath(harness, sessionId)` in `paths.ts` →
  `cacheDir()/work-views/<harness>-<sessionId>.html`. Same shape/rationale as
  `summaryPath`; lives under `XDG_CACHE_HOME` so the test suite redirects it.
- **Concurrency:** `mapLimit` at `GMUX_WORKVIEW_CONCURRENCY` (default 8), same as
  summaries.

#### Validation

The model returns free text; `extractFragment(raw): string`:
- Strip ```` ```html ```` / ```` ``` ```` fences if present.
- Require non-empty content that contains at least one HTML tag; otherwise treat
  as a generation failure for that session (collected, not thrown).
- **No sanitizing of the fragment itself** — it is never injected into the shell
  page's DOM. It is embedded via a sandboxed `<iframe srcdoc>` (below), which is
  the trust boundary. A malformed or hostile fragment can only affect its own
  sandboxed card.

### 2. `src/cli/work-report.ts` — HTML assembly (pure)

```ts
export interface WorkReportCard {
  label: string;           // pane/project label, e.g. "webshop"
  headline: string | null; // session summary headline if available, for context
  html: string | null;     // model fragment; null → render the note instead
  note: string | null;     // e.g. "no model configured", "generation failed: …"
}

export function renderWorkReportHtml(cards: readonly WorkReportCard[], now: number): string;
```

- One self-contained HTML string: a responsive grid of cards. Each card is a
  titled panel (label + optional headline, both **HTML-escaped**, our trusted
  chrome) whose body is the model fragment embedded as
  `<iframe sandbox srcdoc="…">` — or, if `html` is null, the escaped `note`.
- **Sandboxing is the security boundary.** The `<iframe>` carries a restrictive
  `sandbox` attribute (no `allow-scripts`/`allow-same-origin` unless a fragment
  genuinely needs SVG animation — default to the most restrictive that still
  renders inline SVG/HTML). The fragment is HTML-attribute-escaped into `srcdoc`.
  One session's markup cannot touch the shell page or a sibling card.
- No external dependency of any kind — the report is self-contained by
  construction (no mermaid.js, no CDN).
- Pure and deterministic given `now` — snapshot-testable like `renderCockpit`.

### 3. `src/core/paths.ts` — cache + report paths (edit)

- `workViewDir()` / `workViewPath(harness, sessionId)` under `cacheDir()`.
- `workReportPath()` → a stable temp path for the assembled report, e.g.
  `join(tmpdir(), "gmux-work-report.html")`, so re-pressing `v` overwrites one
  file and the link stays the same.

### 4. `src/cli/commands/cockpit.ts` — wiring (edit)

The current command paints snapshots and exits on a close key. Changes:
- Track the latest snapshot in a `let latest` updated by both the subscribe
  callback and the stale re-read, so the `v` handler has the current pane set.
- Add a `status: string | null` banner line rendered into the frame, so
  "building…/link/failed" shows without leaving the cockpit. The link banner is
  persistent (until the next `v`); the "building…" banner is transient.
- Switch stdin to a full `data` handler (like the overlay's): close keys exit;
  `v` triggers `buildReport(latest)`; everything else is ignored.
- `buildReport`:
  1. Set transient banner → repaint.
  2. Resolve the snapshot's panes with sessions to `SessionRecord`s. The snapshot
     panes carry `identity.sessionId` + `identity.harness` but not full records;
     reuse the overlay's resolution path (`loadCachedRecords` +
     `resolvePanesLive`, or `loadRecords`) to get records for the live panes.
  3. `defaultSummaryProvider()`; if null → every card gets the "no model
     configured — run `gmux setup`" note (still writes a valid report).
  4. `buildWorkViews(records, provider)`; map results + failures → cards.
  5. `renderWorkReportHtml` → write to `workReportPath()`.
  6. Persistent banner → `✓ work report: file://<path>` / `⚠ <reason>`.

## Data flow

```
v pressed
  → latest snapshot (panes: identity.sessionId, harness)
  → resolve → SessionRecord[]  (overlay's resolution path)
  → for each: readWorkView → fresh? use : generateWorkView(provider)   [mapLimit]
        └ generateWorkView: distill(record) → buildWorkViewPrompt → provider → extractFragment → cache
  → WorkReportCard[]  (html fragment | note per pane)
  → renderWorkReportHtml → write workReportPath() → banner shows file:// link
```

## Degradation

- **No provider configured:** report still written; every card shows the setup
  note. Consistent with how `ask` handles a missing provider.
- **One session fails** (provider error, empty/non-HTML output): that card shows
  `generation failed: <reason>`; all others render. Failures are collected, not
  thrown (the `summarizeBatch` pattern).
- **No sessions / empty workspace:** banner `no sessions to diagram`; no file
  written.
- **Write fails** (temp dir unwritable): banner shows the error reason.
- **Provider timeout:** inherited from `runProviderCommand` (120s); surfaces as a
  per-session failure note.

## Testing

- `tests/work-report.test.ts` — pure HTML assembly: N cards render N panels; a
  fragment is embedded in a `sandbox`ed `<iframe srcdoc>`; a null-html card
  renders its escaped note; labels/headlines are HTML-escaped in the chrome;
  empty input renders the empty-state.
- `tests/work-view.test.ts` — `extractFragment` strips fences and rejects
  non-HTML text; `isStale` true when `sourceHash` drifts, false when equal;
  `buildWorkViews` skips fresh, regenerates stale, collects failures without
  aborting the batch (mirror `summarizeBatch` tests, stub provider).
- Cockpit command wiring stays thin; covered by the existing `cli-cockpit.test.ts`
  smoke plus the pure units above. No new terminal-driving test.

## Files

| File | Change |
|---|---|
| `src/services/work-view.ts` | **new** — generation, cache, batch, prompt, `extractFragment` |
| `src/cli/work-report.ts` | **new** — pure `renderWorkReportHtml` + sandboxed-iframe assembly + card types |
| `src/core/paths.ts` | **edit** — `workViewDir`/`workViewPath`, `workReportPath` |
| `src/cli/commands/cockpit.ts` | **edit** — latest-snapshot tracking, banner, `v` handler, `buildReport` |
| `src/cli/gmux-render.ts` | **edit** — footer hint `v: work report`; render the `status` banner line |
| `tests/work-report.test.ts`, `tests/work-view.test.ts` | **new** |

## Resolved decisions

- **Mermaid:** dropped. Model emits HTML fragments directly; no dependency.
- **Delivery:** no programmatic browser open. Write the file, show a `file://`
  link the user opens themselves.
- **Fragment safety:** sandboxed `<iframe srcdoc>` per card is the trust
  boundary; the shell chrome is our own escaped HTML.
- **Scope:** every visible pane gets a card on each `v` press; caching by
  `sourceHash` keeps re-presses cheap.
