# gmux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build gmux — an always-on workspace daemon that senses every tmux pane (instant heuristic state + memory, plus change-gated LLM semantics), holds one authoritative workspace model, drives always-on border labels and a pull-up cockpit, and runs a memory guardian that protects agents under host memory pressure.

**Architecture:** One long-lived daemon owns a single in-memory `WorkspaceModel`. A **fast path** (state classifier + resource monitor, no LLM, every tick) writes to the model immediately; a **slow path** (change-gated debounced LLM summarizer) writes labels/cards a beat later. A **tmux gateway** is the sole tmux talker and the master test seam. Thin surfaces (borders, cockpit) subscribe to the model over a unix socket, falling back to a snapshot file. The governing invariant: the fast path (state, memory, guardian) survives any LLM or tmux failure.

**Tech Stack:** TypeScript (ESM, `NodeNext`, explicit `.js` import extensions), Node ≥ 20, Commander for the CLI, Vitest for tests, `node:net` unix socket for IPC, `node:child_process` for `ps`/tmux. No new runtime dependencies.

## Global Constraints

- **Layered architecture (CI-enforced by `scripts/check-layers.mjs`):** imports only flow `core ← adapters ← services ← cli`. A module imports its own layer or any layer to the LEFT, never right. `node:` builtins and third-party deps are exempt. Every new file must obey this; `npm run check:layers` runs inside `npm test`.
- **ESM everywhere:** `"type": "module"`. All relative imports use explicit `.js` extensions (e.g. `import { cacheDir } from "../core/paths.js"`), even from `.ts` source.
- **TypeScript strictness:** `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`. Indexing an array/record yields `T | undefined` — handle it.
- **No real side effects in tests:** `tests/setup.ts` redirects `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` to temp dirs. Tests never spawn real processes, call a real model, or talk to a real tmux. Inject fakes.
- **Recursion guard:** any `gmux` subprocess sets `GMUX_CHILD=1` via `childEnv()` (`services/config.ts`); background workers check `isChildProcess(env)` to avoid feedback loops. Summaries created by gmux must not themselves trigger gmux work (`isAutomated`/`isSidechain` are already excluded by `autoSummarizeCandidates`).
- **No new npm dependencies** without explicit approval — the sole runtime dep is `commander`.
- **Test command:** `npm test` (runs `npm run check:layers && vitest run`). Single file: `npx vitest run tests/<file>.test.ts`. Typecheck: `npm run check:types`.
- **Product naming:** product name is **gmux**; the binary and command prefix stay `gmux`. New user-facing commands live under `gmux` (e.g. `gmux daemon`, `gmux cockpit`). Internal/self-spawned commands are `__`-prefixed and hidden.
- **Tests live in the top-level `tests/` dir** (not co-located), named `<name>.test.ts`. Reuse fixtures from `tests/fixtures/build.ts` where relevant.

## File Structure

New and modified files, grouped by layer. Each file has one responsibility.

**core/ (pure, no I/O):**
- `src/core/gmux-types.ts` *(new)* — shared gmux vocabulary: `PaneState`, `Observation`, `PaneSemantics`, `PaneResources`, `PaneIdentity`, `PaneEntry`, `HostPressure`, `GuardianLogEntry`, `WorkspaceSnapshot`, `GuardianPolicy`, `GmuxConfig`.
- `src/core/pane-state.ts` *(new)* — pure state classifier: `classifyState(obs) → PaneState`. No I/O, deterministic.
- `src/core/paths.ts` *(modify)* — add `gmuxSocketPath()`, `gmuxSnapshotPath()`, `paneLogDir()`, `paneLogPath(paneId)`.

**services/ (business logic + I/O):**
- `src/services/tmux.ts` *(modify)* — extend `PANE_FORMAT` (add `#{window_id}`, `#{?pane_active,1,0}`); add `capturePane`, `startPipePane`, `stopPipePane`, `sendKeys`.
- `src/services/tmux-gateway.ts` *(new)* — `TmuxGateway` interface + `RealTmuxGateway` (delegates to `tmux.ts`). Sole tmux talker; the master test seam.
- `src/services/pane-registry.ts` *(new)* — diff live panes → durable `PaneIdentity` records; resolve harness/session; track appear/disappear.
- `src/services/sensors.ts` *(new)* — `Sensor` interface; `AgentSensor` (tail transcript JSONL) and `TerminalSensor` (`pipe-pane` log + `capture-pane` tail) → uniform `Observation`.
- `src/services/resources.ts` *(new)* — `perPaneRss` subtree walk (`ps` on macOS, `/proc` on Linux) + `hostPressure` (OS APIs) + `unattributed`.
- `src/services/workspace.ts` *(new)* — the `WorkspaceModel`: single source of truth; `applyState`/`applySemantics`/`applyResources`/`applyGuardian`/`markGone`; versioned; emits change events.
- `src/services/semantic.ts` *(new)* — change-gated, debounced LLM label/card bridge, using `distill`/`summarize` + `mapLimit`.
- `src/services/guardian.ts` *(new)* — guardian state machine + policy (off/notify/auto, threshold, cooldown, hysteresis).
- `src/services/daemon.ts` *(new)* — tick loop tying registry → sensors → classifier → model; socket server + snapshot writer; lifecycle.
- `src/services/daemon-client.ts` *(new)* — read the model over the socket, fall back to snapshot; used by surfaces & CLI.
- `src/services/config.ts` *(modify)* — extend `GmConfig` with a `gmux` block (guardian policy, thresholds, cadence).

**cli/ (Commander wiring + rendering):**
- `src/cli/gmux-render.ts` *(new)* — pure cockpit-grid renderer (state, memory, one-liner, last activity; guardian log at top).
- `src/cli/commands/daemon.ts` *(new)* — `gmux daemon` (start/stop/status), detached-spawn supervised.
- `src/cli/commands/cockpit.ts` *(new)* — `gmux cockpit <window>` (ctrl+g grid): reads snapshot, subscribes, renders, exits.
- `src/cli/border-client.ts` *(new)* — daemon-driven border repaint (reads snapshot, paints `@gm_label` per pane).
- `src/cli/tmux-label.ts` *(modify)* — allow border paint from a supplied snapshot instead of re-sensing.
- `src/cli/commands/setup.ts` *(modify)* — guardian-policy disclosure at install.
- `src/cli/commands/tmux.ts` *(modify)* — bind ctrl+g to `gmux cockpit`; daemon autostart hook.
- `src/cli/main.ts` *(modify)* — register `registerDaemon`, `registerCockpit`.

**tests/ (new):** one `<name>.test.ts` per module above with logic. Fakes: `FakeTmuxGateway` (scripted `list-panes`/`capture-pane`, recorded `send-keys`), `FakeClock`, `FakeSummaryProvider` (already exists), synthetic `ps` trees.

---

## PHASE 0 — Skeleton

Proves the always-on loop: daemon, gateway, model, socket+snapshot, borders driven by daemon using **state only** (heuristics, zero LLM).

---

### Task 1: gmux shared types

**Files:**
- Create: `src/core/gmux-types.ts`
- Test: `tests/gmux-types.test.ts`

**Interfaces:**
- Produces: all types below. Every later task imports from `../core/gmux-types.js`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-types.test.ts
import { describe, expect, it } from "vitest";
import { PANE_STATES, isPaneState } from "../src/core/gmux-types.js";

describe("gmux-types", () => {
  it("enumerates the five pane states", () => {
    expect([...PANE_STATES]).toEqual(["working", "idle", "waiting", "error", "done"]);
  });
  it("isPaneState is a type guard over the enum", () => {
    expect(isPaneState("waiting")).toBe(true);
    expect(isPaneState("bogus")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-types.test.ts`
Expected: FAIL — cannot find module `../src/core/gmux-types.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/gmux-types.ts
import type { HarnessId } from "./types.js";

/** The five triage-critical pane states, ordered least→most attention-worthy for display. */
export const PANE_STATES = ["working", "idle", "waiting", "error", "done"] as const;
export type PaneState = (typeof PANE_STATES)[number];

export function isPaneState(value: string): value is PaneState {
  return (PANE_STATES as readonly string[]).includes(value);
}

/** A uniform reading from a sensor, regardless of source. */
export interface Observation {
  paneId: string;
  kind: "agent" | "terminal";
  /** ms epoch when this observation was taken. */
  ts: number;
  /** Latest slice of lines (new transcript lines, or pipe-pane/capture tail). */
  tailLines: string[];
  /** ms epoch of the last content change seen for this pane (0 if never). */
  lastActivityTs: number;
  /** True when the agent transcript's final turn awaits human input (agent panes only). */
  awaitingInput?: boolean;
  /** True when the latest slice shows a tool/command failure. */
  sawError?: boolean;
  /** True when the agent transcript indicates the task ended/finished. */
  ended?: boolean;
}

/** The human-readable "what it's doing" layer. */
export interface PaneSemantics {
  label: string;
  card: string | null;
  /** SimHash of the source text the label was written from. */
  fingerprint: string;
  updatedAt: number;
  stale: boolean;
}

/** Per-pane memory attribution. */
export interface PaneResources {
  /** Subtree RSS sum in bytes. Reliable for ranking, not exact totals. */
  perPaneRss: number;
  ts: number;
}

/** Durable identity of a pane in the workspace. */
export interface PaneIdentity {
  paneId: string;
  windowId: string | null;
  active: boolean;
  harness: HarnessId | null;
  sessionId: string | null;
  cwd: string;
  command: string;
  pid: number;
}

/** One pane's complete state in the model. */
export interface PaneEntry {
  identity: PaneIdentity;
  state: PaneState;
  semantics: PaneSemantics | null;
  resources: PaneResources | null;
  /** ms epoch of last observed activity. */
  lastActivityTs: number;
  /** ms epoch of last update to this entry. */
  ts: number;
  /** Marked true when the pane vanished; evicted next tick. */
  gone: boolean;
}

/** Host-level memory pressure — the guardian's trigger. Not the sum of panes. */
export interface HostPressure {
  /** Used fraction 0..1 (excludes reclaimable cache where the OS distinguishes). */
  usedRatio: number;
  /** Bytes not attributed to any tracked pane subtree. */
  unattributed: number;
  ts: number;
}

/** One guardian action, logged to the model. */
export interface GuardianLogEntry {
  ts: number;
  /** Host used fraction at fire time. */
  pressure: number;
  culpritPaneId: string | null;
  /** Human label of the top consumer, or "source outside tracked panes". */
  culpritLabel: string;
  action: "broadcast" | "notify" | "log-only";
  message: string;
}

/** Guardian autonomy policy. */
export type GuardianPolicy = "off" | "notify" | "auto";

/** The gmux config block, persisted under GmConfig. */
export interface GmuxConfig {
  guardianPolicy: GuardianPolicy;
  /** Host used fraction that trips the guardian, 0..1. */
  memoryThreshold: number;
  /** Minimum seconds between guardian fires. */
  cooldownSeconds: number;
  /** Daemon tick interval in ms. */
  tickMs: number;
}

/** The serializable model handed to surfaces over the socket / snapshot file. */
export interface WorkspaceSnapshot {
  version: number;
  updatedAt: number;
  panes: PaneEntry[];
  hostPressure: HostPressure | null;
  guardianLog: GuardianLogEntry[];
}

/** Defaults for a fresh install. */
export const DEFAULT_GMUX_CONFIG: GmuxConfig = {
  guardianPolicy: "auto",
  memoryThreshold: 0.9,
  cooldownSeconds: 300,
  tickMs: 1500,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gmux-types.ts tests/gmux-types.test.ts
git commit -m "feat(gmux): shared workspace types and pane-state enum"
```

---

### Task 2: gmux cache paths

**Files:**
- Modify: `src/core/paths.ts`
- Test: `tests/gmux-paths.test.ts`

**Interfaces:**
- Consumes: `cacheDir()` from `core/paths.ts`.
- Produces: `gmuxSocketPath(): string`, `gmuxSnapshotPath(): string`, `paneLogDir(): string`, `paneLogPath(paneId): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-paths.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { gmuxSocketPath, gmuxSnapshotPath, paneLogPath } from "../src/core/paths.js";

describe("gmux paths", () => {
  beforeEach(() => { process.env.XDG_CACHE_HOME = "/tmp/xdgcache"; });
  it("socket, snapshot and pane logs live under the gmux cache", () => {
    expect(gmuxSocketPath()).toBe("/tmp/xdgcache/gmux/gmux/daemon.sock");
    expect(gmuxSnapshotPath()).toBe("/tmp/xdgcache/gmux/gmux/snapshot.json");
    expect(paneLogPath("%3")).toBe("/tmp/xdgcache/gmux/gmux/panes/pane-3.log");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-paths.test.ts`
Expected: FAIL — `gmuxSocketPath` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/paths.ts`:

```ts
/** Root of gmux's ephemeral daemon state (cache: dies with the tmux server). */
export function gmuxDir(): string {
  return join(cacheDir(), "gmux");
}

/** Unix socket surfaces connect to for live model subscription. */
export function gmuxSocketPath(): string {
  return join(gmuxDir(), "daemon.sock");
}

/** Snapshot file written every tick; the fallback when the daemon is down. */
export function gmuxSnapshotPath(): string {
  return join(gmuxDir(), "snapshot.json");
}

/** Directory of per-pane pipe-pane logs (non-agent tail). */
export function paneLogDir(): string {
  return join(gmuxDir(), "panes");
}

/** One pane's pipe-pane log. `%3` → `pane-3.log` (tmux ids carry a `%`). */
export function paneLogPath(paneId: string): string {
  return join(paneLogDir(), `pane-${paneId.replace(/^%/, "")}.log`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts tests/gmux-paths.test.ts
git commit -m "feat(gmux): cache paths for socket, snapshot and pane logs"
```

---

### Task 3: Extend tmux.ts with the gateway verbs

Adds the tmux subcommands gmux needs that do not exist today: window/active in the pane format, `capture-pane`, `pipe-pane` start/stop, `send-keys`. Parsers stay pure; runners stay thin `execFile`.

**Files:**
- Modify: `src/services/tmux.ts`, `src/core/types.ts` (add `windowId`, `active` to `TmuxPane`)
- Test: `tests/tmux-gateway-verbs.test.ts`

**Interfaces:**
- Consumes: existing `PANE_FORMAT`, `parsePaneLine`, `execFile` wrappers in `tmux.ts`.
- Produces: `TmuxPane` gains `windowId: string | null`, `active: boolean`; new fns `capturePane(paneId, lines?): Promise<string>`, `startPipePane(paneId, logPath): Promise<void>`, `stopPipePane(paneId): Promise<void>`, `sendKeys(paneId, keys): Promise<void>`.

- [ ] **Step 1: Write the failing test** (pure parser only — the runners are covered via the fake gateway in Task 4)

```ts
// tests/tmux-gateway-verbs.test.ts
import { describe, expect, it } from "vitest";
import { PANE_FORMAT, parsePaneLine } from "../src/services/tmux.js";

describe("extended pane format", () => {
  it("carries window id and active flag", () => {
    expect(PANE_FORMAT).toContain("#{window_id}");
    expect(PANE_FORMAT).toContain("#{?pane_active,1,0}");
  });
  it("parses window id and active into TmuxPane", () => {
    // fields: paneId, left, top, width, height, cwd, command, pid, windowId, active
    const line = "%2\t0\t0\t80\t24\t/home/x\tnode\t4242\t@7\t1";
    const pane = parsePaneLine(line);
    expect(pane).not.toBeNull();
    expect(pane!.windowId).toBe("@7");
    expect(pane!.active).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tmux-gateway-verbs.test.ts`
Expected: FAIL — `windowId` missing / format lacks `#{window_id}`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/types.ts`, extend `TmuxPane` (add two fields after `pid`):

```ts
  /** The pane's shell pid — the root for resolving which agent runs in it. */
  pid: number;
  /** tmux window id (`@N`), or null on tmux builds that omit it. */
  windowId: string | null;
  /** True when this is the active pane in its window. */
  active: boolean;
```

In `src/services/tmux.ts`, append the two fields to `PANE_FORMAT` and parse them, then add runners:

```ts
export const PANE_FORMAT =
  "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t" +
  "#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}\t#{window_id}\t#{?pane_active,1,0}";

// in parsePaneLine, after parsing pid, read the two new tab fields:
//   const windowId = fields[8] && fields[8].length > 0 ? fields[8] : null;
//   const active = fields[9] === "1";
//   return { paneId, left, top, width, height, cwd, command, pid, windowId, active };

/** Grab the visible buffer of a pane (last `lines` rows, default whole screen). */
export async function capturePane(paneId: string, lines?: number): Promise<string> {
  const args = ["capture-pane", "-p", "-t", paneId];
  if (lines !== undefined) args.push("-S", `-${lines}`);
  return runTmux(args); // runTmux = existing execFile helper returning stdout
}

/** Start streaming a pane's output to a log file (append). */
export async function startPipePane(paneId: string, logPath: string): Promise<void> {
  await runTmux(["pipe-pane", "-o", "-t", paneId, `cat >> ${shellQuote(logPath)}`]);
}

/** Stop streaming a pane (toggle pipe-pane off). */
export async function stopPipePane(paneId: string): Promise<void> {
  await runTmux(["pipe-pane", "-t", paneId]);
}

/** Type literal keys into a pane. `-l` = literal, no key-name interpretation. */
export async function sendKeys(paneId: string, keys: string): Promise<void> {
  await runTmux(["send-keys", "-t", paneId, "-l", keys]);
}
```

> Note: use the existing `execFile`-based helper (named `runTmux` here — match the real helper name in `tmux.ts`). `shellQuote` must single-quote the log path; if no quoting helper exists, add a tiny local one. `pipe-pane` runs its command through the user's shell, so the path MUST be quoted.

- [ ] **Step 4: Run test + typecheck** (fix every `TmuxPane` literal the compiler now flags — parsers/tests that build panes must add `windowId`/`active`)

Run: `npx vitest run tests/tmux-gateway-verbs.test.ts && npm run check:types`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/services/tmux.ts src/core/types.ts tests/tmux-gateway-verbs.test.ts
git commit -m "feat(gmux): tmux capture/pipe/send verbs + window/active in pane format"
```

---

### Task 4: TmuxGateway interface + fake (the master test seam)

Wrap the tmux verbs behind an interface so the whole daemon runs headless against a scripted fake.

**Files:**
- Create: `src/services/tmux-gateway.ts`, `tests/fixtures/fake-gateway.ts`
- Test: `tests/tmux-gateway.test.ts`

**Interfaces:**
- Consumes: `listAllPanes`, `capturePane`, `startPipePane`, `stopPipePane`, `sendKeys` from `tmux.ts`; `TmuxPane` from `core/types.ts`.
- Produces:
  - `interface TmuxGateway { listPanes(): Promise<TmuxPane[]>; capture(paneId, lines?): Promise<string>; startPipe(paneId, logPath): Promise<void>; stopPipe(paneId): Promise<void>; send(paneId, keys): Promise<void>; }`
  - `class RealTmuxGateway implements TmuxGateway`
  - `class FakeTmuxGateway implements TmuxGateway` (test fixture): `setPanes(panes)`, `setCapture(paneId, text)`, `readonly sent: Array<{paneId, keys}>`, `readonly piped: Set<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tmux-gateway.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";

describe("FakeTmuxGateway", () => {
  it("serves scripted panes and records send-keys", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "node", pid: 10, windowId: "@1", active: true }]);
    expect((await gw.listPanes()).map((p) => p.paneId)).toEqual(["%1"]);
    await gw.send("%1", "hello");
    expect(gw.sent).toEqual([{ paneId: "%1", keys: "hello" }]);
  });
  it("tracks piped panes", async () => {
    const gw = new FakeTmuxGateway();
    await gw.startPipe("%1", "/tmp/p.log");
    expect(gw.piped.has("%1")).toBe(true);
    await gw.stopPipe("%1");
    expect(gw.piped.has("%1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tmux-gateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/tmux-gateway.ts
import type { TmuxPane } from "../core/types.js";
import { capturePane, listAllPanes, sendKeys, startPipePane, stopPipePane } from "./tmux.js";

export interface TmuxGateway {
  listPanes(): Promise<TmuxPane[]>;
  capture(paneId: string, lines?: number): Promise<string>;
  startPipe(paneId: string, logPath: string): Promise<void>;
  stopPipe(paneId: string): Promise<void>;
  send(paneId: string, keys: string): Promise<void>;
}

export class RealTmuxGateway implements TmuxGateway {
  listPanes(): Promise<TmuxPane[]> { return listAllPanes(); }
  capture(paneId: string, lines?: number): Promise<string> { return capturePane(paneId, lines); }
  startPipe(paneId: string, logPath: string): Promise<void> { return startPipePane(paneId, logPath); }
  stopPipe(paneId: string): Promise<void> { return stopPipePane(paneId); }
  send(paneId: string, keys: string): Promise<void> { return sendKeys(paneId, keys); }
}
```

```ts
// tests/fixtures/fake-gateway.ts
import type { TmuxPane } from "../../src/core/types.js";
import type { TmuxGateway } from "../../src/services/tmux-gateway.js";

export class FakeTmuxGateway implements TmuxGateway {
  private panes: TmuxPane[] = [];
  private captures = new Map<string, string>();
  readonly sent: Array<{ paneId: string; keys: string }> = [];
  readonly piped = new Set<string>();

  setPanes(panes: TmuxPane[]): void { this.panes = panes; }
  setCapture(paneId: string, text: string): void { this.captures.set(paneId, text); }

  async listPanes(): Promise<TmuxPane[]> { return [...this.panes]; }
  async capture(paneId: string): Promise<string> { return this.captures.get(paneId) ?? ""; }
  async startPipe(paneId: string): Promise<void> { this.piped.add(paneId); }
  async stopPipe(paneId: string): Promise<void> { this.piped.delete(paneId); }
  async send(paneId: string, keys: string): Promise<void> { this.sent.push({ paneId, keys }); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tmux-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tmux-gateway.ts tests/fixtures/fake-gateway.ts tests/tmux-gateway.test.ts
git commit -m "feat(gmux): TmuxGateway interface, real impl, and scriptable fake"
```

---

### Task 5: Pure state classifier

Deterministic heuristics: latest `Observation` → `PaneState`. No LLM, no I/O. Lives in `core` because it is pure and both services and cli can reuse it.

**Files:**
- Create: `src/core/pane-state.ts`
- Test: `tests/pane-state.test.ts`

**Interfaces:**
- Consumes: `Observation`, `PaneState` from `core/gmux-types.js`.
- Produces: `classifyState(obs: Observation, now: number): PaneState`.

**Classification rules (priority order):**
1. `obs.sawError` → `error`
2. `obs.ended` → `done`
3. `obs.awaitingInput` → `waiting`
4. activity within the last 10s (`now - obs.lastActivityTs < 10_000`) → `working`
5. otherwise → `idle`

- [ ] **Step 1: Write the failing test**

```ts
// tests/pane-state.test.ts
import { describe, expect, it } from "vitest";
import { classifyState } from "../src/core/pane-state.js";
import type { Observation } from "../src/core/gmux-types.js";

const base: Observation = { paneId: "%1", kind: "agent", ts: 1000, tailLines: [], lastActivityTs: 1000 };

describe("classifyState", () => {
  it("error beats everything", () => {
    expect(classifyState({ ...base, sawError: true, awaitingInput: true }, 1000)).toBe("error");
  });
  it("ended → done", () => {
    expect(classifyState({ ...base, ended: true }, 1000)).toBe("done");
  });
  it("awaiting input → waiting", () => {
    expect(classifyState({ ...base, awaitingInput: true }, 1000)).toBe("waiting");
  });
  it("recent activity → working", () => {
    expect(classifyState({ ...base, lastActivityTs: 100_000 }, 105_000)).toBe("working");
  });
  it("quiet for a while → idle", () => {
    expect(classifyState({ ...base, lastActivityTs: 100_000 }, 200_000)).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pane-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/pane-state.ts
import type { Observation, PaneState } from "./gmux-types.js";

/** ms of quiet after which a pane is no longer "working". */
export const WORKING_WINDOW_MS = 10_000;

/** Pure heuristic: latest observation → triage state. Deterministic; no I/O. */
export function classifyState(obs: Observation, now: number): PaneState {
  if (obs.sawError) return "error";
  if (obs.ended) return "done";
  if (obs.awaitingInput) return "waiting";
  if (now - obs.lastActivityTs < WORKING_WINDOW_MS) return "working";
  return "idle";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pane-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pane-state.ts tests/pane-state.test.ts
git commit -m "feat(gmux): pure pane-state classifier"
```

---

### Task 6: Pane registry

Diffs the live pane set into durable `PaneIdentity` records, resolving harness/session for agent panes, and reports appear/disappear.

**Files:**
- Create: `src/services/pane-registry.ts`
- Test: `tests/pane-registry.test.ts`

**Interfaces:**
- Consumes: `TmuxGateway` (Task 4); `resolvePanesLive` from `tmux-resolve.js`; `readPaneLinks`/`prunePaneLinks` from `pane-links.js`; `cachedRecords` from `index-store.js`; `PaneIdentity` from `gmux-types.js`; `TmuxPane`, `SessionRecord`, `PaneLink` from `core/types.js`.
- Produces:
  - `interface RegistryDiff { present: PaneIdentity[]; appeared: string[]; vanished: string[]; }`
  - `class PaneRegistry { constructor(gateway: TmuxGateway, resolve?: ResolveFn); diff(): Promise<RegistryDiff>; }`
  - `type ResolveFn = (panes: TmuxPane[], records: SessionRecord[], links: PaneLink[]) => Promise<Array<{ pane: TmuxPane; record: SessionRecord | null }>>` (defaults to `resolvePanesLive`; injectable for tests).

- [ ] **Step 1: Write the failing test**

```ts
// tests/pane-registry.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { PaneRegistry } from "../src/services/pane-registry.js";
import type { TmuxPane } from "../src/core/types.js";

const pane = (id: string, cmd = "node"): TmuxPane => ({
  paneId: id, left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: cmd, pid: 10, windowId: "@1", active: false,
});
// resolve stub: nothing is an agent
const noResolve = async (panes: TmuxPane[]) => panes.map((p) => ({ pane: p, record: null }));

describe("PaneRegistry.diff", () => {
  it("reports appeared panes on first diff", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1"), pane("%2")]);
    const reg = new PaneRegistry(gw, noResolve);
    const d = await reg.diff();
    expect(d.appeared.sort()).toEqual(["%1", "%2"]);
    expect(d.vanished).toEqual([]);
    expect(d.present).toHaveLength(2);
  });
  it("reports vanished panes on the next diff", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1"), pane("%2")]);
    const reg = new PaneRegistry(gw, noResolve);
    await reg.diff();
    gw.setPanes([pane("%1")]);
    const d = await reg.diff();
    expect(d.appeared).toEqual([]);
    expect(d.vanished).toEqual(["%2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pane-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/pane-registry.ts
import type { PaneLink, SessionRecord, TmuxPane } from "../core/types.js";
import type { PaneIdentity } from "../core/gmux-types.js";
import { cachedRecords } from "./index-store.js";
import { prunePaneLinks, readPaneLinks } from "./pane-links.js";
import { resolvePanesLive } from "./tmux-resolve.js";

export interface RegistryDiff {
  present: PaneIdentity[];
  appeared: string[];
  vanished: string[];
}

export type ResolveFn = (
  panes: TmuxPane[],
  records: SessionRecord[],
  links: PaneLink[],
) => Promise<Array<{ pane: TmuxPane; record: SessionRecord | null }>>;

export class PaneRegistry {
  private known = new Set<string>();
  constructor(
    private readonly gateway: { listPanes(): Promise<TmuxPane[]> },
    private readonly resolve: ResolveFn = resolvePanesLive,
  ) {}

  async diff(): Promise<RegistryDiff> {
    const panes = await this.gateway.listPanes();
    const liveIds = panes.map((p) => p.paneId);
    const links = await prunePaneLinks(liveIds).catch(() => readPaneLinks());
    const records = await cachedRecords().catch(() => [] as SessionRecord[]);
    const resolved = await this.resolve(panes, records, links);

    const present: PaneIdentity[] = resolved.map(({ pane, record }) => ({
      paneId: pane.paneId,
      windowId: pane.windowId,
      active: pane.active,
      harness: record?.harness ?? null,
      sessionId: record?.sessionId ?? null,
      cwd: pane.cwd,
      command: pane.command,
      pid: pane.pid,
    }));

    const liveSet = new Set(liveIds);
    const appeared = liveIds.filter((id) => !this.known.has(id));
    const vanished = [...this.known].filter((id) => !liveSet.has(id));
    this.known = liveSet;
    return { present, appeared, vanished };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pane-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/pane-registry.ts tests/pane-registry.test.ts
git commit -m "feat(gmux): pane registry with appear/disappear diffing"
```

---

### Task 7: Sensors — agent + terminal → uniform Observation

**Files:**
- Create: `src/services/sensors.ts`
- Test: `tests/sensors.test.ts`

**Interfaces:**
- Consumes: `TmuxGateway` (`capture`); `readJsonl`, `RingBuffer` from `adapters/jsonl.js`; `paneLogPath` from `core/paths.js`; `Observation`, `PaneIdentity` from `gmux-types.js`.
- Produces:
  - `interface Sensor { observe(now: number): Promise<Observation>; teardown(): Promise<void>; }`
  - `class TerminalSensor implements Sensor` — ctor `(identity: PaneIdentity, gateway: TmuxGateway)`; reads `capture` tail, tracks last-changed via content hash.
  - `class AgentSensor implements Sensor` — ctor `(identity: PaneIdentity, filePath: string)`; tails transcript, sets `awaitingInput`/`sawError`/`ended`/`lastActivityTs`.
  - `function makeSensor(identity: PaneIdentity, gateway: TmuxGateway): Sensor` — agent if `identity.harness && identity.sessionId` resolvable to a file, else terminal.

Terminal-sensor activity detection: hash the captured tail; when the hash changes from the previous observe, bump `lastActivityTs` to `now`. First observe sets `lastActivityTs = now`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/sensors.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { TerminalSensor } from "../src/services/sensors.js";
import type { PaneIdentity } from "../src/core/gmux-types.js";

const ident: PaneIdentity = {
  paneId: "%1", windowId: "@1", active: false, harness: null, sessionId: null,
  cwd: "/x", command: "zsh", pid: 10,
};

describe("TerminalSensor", () => {
  it("captures the pane tail into an observation", async () => {
    const gw = new FakeTmuxGateway();
    gw.setCapture("%1", "line a\nline b\n");
    const s = new TerminalSensor(ident, gw);
    const obs = await s.observe(5000);
    expect(obs.kind).toBe("terminal");
    expect(obs.tailLines).toEqual(["line a", "line b"]);
    expect(obs.lastActivityTs).toBe(5000);
  });
  it("only bumps lastActivityTs when the content changes", async () => {
    const gw = new FakeTmuxGateway();
    gw.setCapture("%1", "same");
    const s = new TerminalSensor(ident, gw);
    await s.observe(1000);
    const stable = await s.observe(2000);
    expect(stable.lastActivityTs).toBe(1000); // unchanged content
    gw.setCapture("%1", "new content");
    const moved = await s.observe(3000);
    expect(moved.lastActivityTs).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sensors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/sensors.ts
import { createHash } from "node:crypto";
import type { Observation, PaneIdentity } from "../core/gmux-types.js";
import type { TmuxGateway } from "./tmux-gateway.js";
import { paneLogPath } from "../core/paths.js";

export interface Sensor {
  readonly kind: "agent" | "terminal";
  observe(now: number): Promise<Observation>;
  teardown(): Promise<void>;
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex");

export class TerminalSensor implements Sensor {
  readonly kind = "terminal" as const;
  private lastHash = "";
  private lastActivityTs = 0;
  private piping = false;

  constructor(private readonly identity: PaneIdentity, private readonly gateway: TmuxGateway) {}

  async observe(now: number): Promise<Observation> {
    if (!this.piping) {
      await this.gateway.startPipe(this.identity.paneId, paneLogPath(this.identity.paneId)).catch(() => {});
      this.piping = true;
    }
    const text = await this.gateway.capture(this.identity.paneId, 200);
    const h = hash(text);
    if (h !== this.lastHash) { this.lastActivityTs = now; this.lastHash = h; }
    const tailLines = text.split("\n").filter((l) => l.length > 0);
    return { paneId: this.identity.paneId, kind: "terminal", ts: now, tailLines, lastActivityTs: this.lastActivityTs };
  }

  async teardown(): Promise<void> {
    if (this.piping) await this.gateway.stopPipe(this.identity.paneId).catch(() => {});
  }
}
```

Add `AgentSensor` (reads the transcript file with `readJsonl`, keeps a `RingBuffer` of the last ~40 events; sets `lastActivityTs` from the newest event timestamp; derives `awaitingInput` = last event is an assistant turn with no following user turn, `sawError` = a tool-result error in the tail, `ended` = a session-end/`endedMidTask=false` completion marker in the tail):

```ts
import { readJsonl, RingBuffer } from "../adapters/jsonl.js";

export class AgentSensor implements Sensor {
  readonly kind = "agent" as const;
  constructor(private readonly identity: PaneIdentity, private readonly filePath: string) {}

  async observe(now: number): Promise<Observation> {
    const tail = new RingBuffer<Record<string, unknown>>(40);
    for await (const row of readJsonl(this.filePath)) tail.push(row);
    const rows = tail.toArray();
    const last = rows[rows.length - 1];
    const tailLines = rows.map((r) => JSON.stringify(r));
    const lastActivityTs = tsOf(last) ?? now;
    return {
      paneId: this.identity.paneId, kind: "agent", ts: now, tailLines, lastActivityTs,
      awaitingInput: isAssistantWaiting(rows),
      sawError: hasToolError(rows),
      ended: isEnded(rows),
    };
  }
  async teardown(): Promise<void> {}
}
```

> Implement `tsOf`/`isAssistantWaiting`/`hasToolError`/`isEnded` as small local helpers over the JSONL row shape (roles/tool-result fields the existing `adapters/claude-code.ts` already reads). Keep them defensive: unknown shapes return `false`/`undefined`. `makeSensor` picks `AgentSensor` when the identity resolves to a transcript file (look it up via the adapter's `parseSession` ref / cached record `filePath`), else `TerminalSensor`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sensors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/sensors.ts tests/sensors.test.ts
git commit -m "feat(gmux): agent + terminal sensors emitting uniform observations"
```

---

### Task 8: Workspace model

Single source of truth. Holds `PaneEntry` per pane + host pressure + guardian log; each mutation bumps `version` and emits `"change"`.

**Files:**
- Create: `src/services/workspace.ts`
- Test: `tests/workspace.test.ts`

**Interfaces:**
- Consumes: `PaneEntry`, `PaneIdentity`, `PaneState`, `PaneSemantics`, `PaneResources`, `HostPressure`, `GuardianLogEntry`, `WorkspaceSnapshot` from `gmux-types.js`.
- Produces:
  - `class WorkspaceModel extends EventEmitter`
  - `upsertIdentity(id: PaneIdentity): void`
  - `applyState(paneId, state: PaneState, lastActivityTs: number, now: number): void`
  - `applySemantics(paneId, semantics: PaneSemantics): void`
  - `applyResources(paneId, resources: PaneResources): void`
  - `setHostPressure(p: HostPressure): void`
  - `logGuardian(entry: GuardianLogEntry): void` (keeps last 50)
  - `markGone(paneId): void` / `evictGone(): void`
  - `get version(): number` / `snapshot(): WorkspaceSnapshot`
  - emits `"change"` on any mutation that alters observable state.

- [ ] **Step 1: Write the failing test**

```ts
// tests/workspace.test.ts
import { describe, expect, it, vi } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import type { PaneIdentity } from "../src/core/gmux-types.js";

const ident: PaneIdentity = {
  paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 10,
};

describe("WorkspaceModel", () => {
  it("bumps version and emits on state change", () => {
    const m = new WorkspaceModel();
    const onChange = vi.fn();
    m.on("change", onChange);
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    expect(m.version).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalled();
    expect(m.snapshot().panes[0]!.state).toBe("working");
  });
  it("does not emit when state is unchanged", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.applyState("%1", "working", 1000, 1000);
    const v = m.version;
    const onChange = vi.fn();
    m.on("change", onChange);
    m.applyState("%1", "working", 1000, 2000); // same state, same activity
    expect(m.version).toBe(v);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("evicts gone panes", () => {
    const m = new WorkspaceModel();
    m.upsertIdentity(ident);
    m.markGone("%1");
    m.evictGone();
    expect(m.snapshot().panes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/workspace.ts
import { EventEmitter } from "node:events";
import type {
  GuardianLogEntry, HostPressure, PaneEntry, PaneIdentity, PaneResources, PaneSemantics, PaneState, WorkspaceSnapshot,
} from "../core/gmux-types.js";

export class WorkspaceModel extends EventEmitter {
  private entries = new Map<string, PaneEntry>();
  private hostPressure: HostPressure | null = null;
  private guardianLog: GuardianLogEntry[] = [];
  private _version = 0;

  get version(): number { return this._version; }

  private bump(): void { this._version += 1; this.emit("change"); }

  upsertIdentity(id: PaneIdentity): void {
    const cur = this.entries.get(id.paneId);
    if (cur) {
      // Identity can drift (active flag, resolved harness); refresh it.
      cur.identity = id; cur.gone = false; this.bump(); return;
    }
    this.entries.set(id.paneId, {
      identity: id, state: "idle", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
    });
    this.bump();
  }

  applyState(paneId: string, state: PaneState, lastActivityTs: number, now: number): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    if (e.state === state && e.lastActivityTs === lastActivityTs) return; // no observable change
    e.state = state; e.lastActivityTs = lastActivityTs; e.ts = now; this.bump();
  }

  applySemantics(paneId: string, semantics: PaneSemantics): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    e.semantics = semantics; this.bump();
  }

  applyResources(paneId: string, resources: PaneResources): void {
    const e = this.entries.get(paneId);
    if (!e) return;
    e.resources = resources; this.bump();
  }

  setHostPressure(p: HostPressure): void { this.hostPressure = p; this.bump(); }

  logGuardian(entry: GuardianLogEntry): void {
    this.guardianLog.push(entry);
    if (this.guardianLog.length > 50) this.guardianLog = this.guardianLog.slice(-50);
    this.bump();
  }

  markGone(paneId: string): void {
    const e = this.entries.get(paneId);
    if (e && !e.gone) { e.gone = true; this.bump(); }
  }

  evictGone(): void {
    let changed = false;
    for (const [id, e] of this.entries) if (e.gone) { this.entries.delete(id); changed = true; }
    if (changed) this.bump();
  }

  snapshot(): WorkspaceSnapshot {
    return {
      version: this._version,
      updatedAt: Math.max(0, ...[...this.entries.values()].map((e) => e.ts)),
      panes: [...this.entries.values()].filter((e) => !e.gone),
      hostPressure: this.hostPressure,
      guardianLog: [...this.guardianLog],
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/workspace.ts tests/workspace.test.ts
git commit -m "feat(gmux): workspace model as versioned single source of truth"
```

---

### Task 9: Daemon socket server + snapshot writer

The daemon owns a unix socket (surfaces subscribe) and writes a snapshot file each change (fallback when down). Newline-delimited JSON over the socket: on connect, send the current snapshot; on every model change, send the new snapshot.

**Files:**
- Create: `src/services/daemon-socket.ts`
- Test: `tests/daemon-socket.test.ts`

**Interfaces:**
- Consumes: `WorkspaceModel` (Task 8); `gmuxSocketPath`, `gmuxSnapshotPath` from `core/paths.js`; `node:net`, `node:fs`.
- Produces:
  - `class ModelServer { constructor(model: WorkspaceModel, socketPath?: string, snapshotPath?: string); start(): Promise<void>; stop(): Promise<void>; }`
  - On start: unlink any stale socket, `net.createServer`, subscribe to model `"change"` → broadcast `JSON.stringify(snapshot) + "\n"` to all clients + atomically write snapshot file (temp+rename).

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon-socket.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspaceModel } from "../src/services/workspace.js";
import { ModelServer } from "../src/services/daemon-socket.js";

let server: ModelServer | undefined;
afterEach(async () => { await server?.stop(); });

describe("ModelServer", () => {
  it("streams a snapshot on change and writes the snapshot file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const sock = join(dir, "d.sock");
    const snap = join(dir, "snap.json");
    const model = new WorkspaceModel();
    server = new ModelServer(model, sock, snap);
    await server.start();

    const got = new Promise<string>((resolve) => {
      const c = connect(sock, () => {
        model.upsertIdentity({ paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 1 });
      });
      let buf = "";
      c.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) resolve(buf); c.end(); });
    });
    const line = await got;
    expect(JSON.parse(line.trim()).panes[0].paneId).toBe("%1");
    // snapshot file also written
    expect(JSON.parse(readFileSync(snap, "utf8")).panes[0].paneId).toBe("%1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon-socket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/daemon-socket.ts
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceModel } from "./workspace.js";
import { gmuxSnapshotPath, gmuxSocketPath } from "../core/paths.js";

export class ModelServer {
  private server: Server | undefined;
  private clients = new Set<Socket>();
  private readonly onChange = () => { void this.broadcast(); };

  constructor(
    private readonly model: WorkspaceModel,
    private readonly socketPath: string = gmuxSocketPath(),
    private readonly snapshotPath: string = gmuxSnapshotPath(),
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });
    this.server = createServer((sock) => {
      this.clients.add(sock);
      sock.on("close", () => this.clients.delete(sock));
      sock.on("error", () => this.clients.delete(sock));
      sock.write(this.line()); // initial snapshot
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
    this.model.on("change", this.onChange);
    await this.writeSnapshot();
  }

  private line(): string { return JSON.stringify(this.model.snapshot()) + "\n"; }

  private async broadcast(): Promise<void> {
    const line = this.line();
    for (const c of this.clients) c.write(line);
    await this.writeSnapshot();
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.tmp`;
    await writeFile(tmp, this.line(), "utf8");
    await rename(tmp, this.snapshotPath);
  }

  async stop(): Promise<void> {
    this.model.off("change", this.onChange);
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.socketPath, { force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon-socket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon-socket.ts tests/daemon-socket.test.ts
git commit -m "feat(gmux): unix-socket model server with snapshot fallback file"
```

---

### Task 10: Daemon client

Reads the model: connect to the socket and stream snapshots; fall back to the snapshot file (marked stale) when the socket is unavailable.

**Files:**
- Create: `src/services/daemon-client.ts`
- Test: `tests/daemon-client.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshot` from `gmux-types.js`; `gmuxSocketPath`, `gmuxSnapshotPath` from `core/paths.js`; `node:net`, `node:fs`.
- Produces:
  - `async function readSnapshotFile(path?): Promise<{ snapshot: WorkspaceSnapshot; ageMs: number } | null>` (uses file mtime for age).
  - `function subscribe(onSnapshot: (s: WorkspaceSnapshot) => void, opts?: { socketPath?: string }): () => void` — connects, parses NDJSON, calls back per snapshot; returns an unsubscribe fn. On connect failure, callers use `readSnapshotFile`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon-client.test.ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readSnapshotFile } from "../src/services/daemon-client.js";

describe("readSnapshotFile", () => {
  it("returns null when the file is missing", async () => {
    expect(await readSnapshotFile(join(tmpdir(), "nope-gmux.json"))).toBeNull();
  });
  it("parses a snapshot and reports its age", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const p = join(dir, "snap.json");
    writeFileSync(p, JSON.stringify({ version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] }));
    const res = await readSnapshotFile(p);
    expect(res).not.toBeNull();
    expect(res!.snapshot.version).toBe(1);
    expect(res!.ageMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/daemon-client.ts
import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import type { WorkspaceSnapshot } from "../core/gmux-types.js";
import { gmuxSnapshotPath, gmuxSocketPath } from "../core/paths.js";

export async function readSnapshotFile(
  path: string = gmuxSnapshotPath(),
): Promise<{ snapshot: WorkspaceSnapshot; ageMs: number } | null> {
  try {
    const [raw, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
    return { snapshot, ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

export function subscribe(
  onSnapshot: (s: WorkspaceSnapshot) => void,
  opts: { socketPath?: string; onError?: (e: Error) => void } = {},
): () => void {
  const sock = connect(opts.socketPath ?? gmuxSocketPath());
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) { try { onSnapshot(JSON.parse(line) as WorkspaceSnapshot); } catch { /* skip */ } }
    }
  });
  sock.on("error", (e) => opts.onError?.(e));
  return () => sock.destroy();
}
```

> `Date.now()` is used here; it is fine in shipped code — the ban applies only to Workflow scripts, not to gmux runtime.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon-client.ts tests/daemon-client.test.ts
git commit -m "feat(gmux): daemon client — socket subscription + snapshot fallback"
```

---

### Task 11: Daemon tick loop

Ties it together: each tick runs registry diff → attach/detach sensors → observe → classify → write state to model → evict gone. No LLM yet (Phase 0). Sensors and clock are injectable for a headless test.

**Files:**
- Create: `src/services/daemon.ts`
- Test: `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `PaneRegistry` (Task 6), `makeSensor`/`Sensor` (Task 7), `WorkspaceModel` (Task 8), `classifyState` (Task 5), `TmuxGateway` (Task 4).
- Produces:
  - `interface DaemonDeps { gateway: TmuxGateway; model: WorkspaceModel; now: () => number; makeSensor?: (id: PaneIdentity, gw: TmuxGateway) => Sensor; }`
  - `class Daemon { constructor(deps: DaemonDeps); tickOnce(): Promise<void>; }`
  - `tickOnce`: diff; for appeared panes create a sensor; for present panes observe + `classifyState` + `applyState`; for vanished panes teardown sensor + `markGone`; then `evictGone`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import type { PaneIdentity, Observation } from "../src/core/gmux-types.js";
import type { Sensor } from "../src/services/sensors.js";
import type { TmuxPane } from "../src/core/types.js";

const pane = (id: string): TmuxPane => ({ paneId: id, left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true });

// sensor stub: always "just active"
class StubSensor implements Sensor {
  readonly kind = "terminal" as const;
  constructor(private id: PaneIdentity, private now: () => number) {}
  async observe(now: number): Promise<Observation> { return { paneId: this.id.paneId, kind: "terminal", ts: now, tailLines: [], lastActivityTs: now }; }
  async teardown(): Promise<void> {}
}

describe("Daemon.tickOnce", () => {
  it("classifies a freshly-active pane as working and stores it", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1")]);
    const model = new WorkspaceModel();
    let clock = 100_000;
    const d = new Daemon({ gateway: gw, model, now: () => clock, makeSensor: (id) => new StubSensor(id, () => clock) });
    await d.tickOnce();
    expect(model.snapshot().panes[0]!.state).toBe("working");
  });
  it("evicts a pane that vanishes", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([pane("%1")]);
    const model = new WorkspaceModel();
    let clock = 100_000;
    const d = new Daemon({ gateway: gw, model, now: () => clock, makeSensor: (id) => new StubSensor(id, () => clock) });
    await d.tickOnce();
    gw.setPanes([]);
    await d.tickOnce();
    expect(model.snapshot().panes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/daemon.ts
import type { PaneIdentity } from "../core/gmux-types.js";
import { classifyState } from "../core/pane-state.js";
import type { TmuxGateway } from "./tmux-gateway.js";
import { PaneRegistry } from "./pane-registry.js";
import { makeSensor as defaultMakeSensor, type Sensor } from "./sensors.js";
import type { WorkspaceModel } from "./workspace.js";

export interface DaemonDeps {
  gateway: TmuxGateway;
  model: WorkspaceModel;
  now: () => number;
  makeSensor?: (id: PaneIdentity, gw: TmuxGateway) => Sensor;
}

export class Daemon {
  private registry: PaneRegistry;
  private sensors = new Map<string, Sensor>();
  private make: (id: PaneIdentity, gw: TmuxGateway) => Sensor;

  constructor(private readonly deps: DaemonDeps) {
    this.registry = new PaneRegistry(deps.gateway);
    this.make = deps.makeSensor ?? defaultMakeSensor;
  }

  async tickOnce(): Promise<void> {
    const now = this.deps.now();
    const { present, vanished } = await this.registry.diff();
    const byId = new Map(present.map((p) => [p.paneId, p]));

    for (const id of vanished) {
      await this.sensors.get(id)?.teardown().catch(() => {});
      this.sensors.delete(id);
      this.deps.model.markGone(id);
    }

    for (const id of present) {
      this.deps.model.upsertIdentity(id);
      let sensor = this.sensors.get(id.paneId);
      if (!sensor) { sensor = this.make(id, this.deps.gateway); this.sensors.set(id.paneId, sensor); }
      try {
        const obs = await sensor.observe(now);
        this.deps.model.applyState(id.paneId, classifyState(obs, now), obs.lastActivityTs, now);
      } catch {
        // A single sensor failure must never abort the tick.
      }
    }

    this.deps.model.evictGone();
    void byId; // reserved for future per-pane routing
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.ts tests/daemon.test.ts
git commit -m "feat(gmux): daemon tick loop — diff, sense, classify, store, evict"
```

---

### Task 12: `gmux daemon` command (run / status / stop)

Wires the daemon to a real tmux gateway, socket server, and an interval loop; supervises via a PID lockfile (same shape as `auto-summarize`'s lock). `gmux daemon` runs the loop in the foreground of a detached process; `gmux daemon status`/`stop` manage it.

**Files:**
- Create: `src/cli/commands/daemon.ts`
- Modify: `src/cli/main.ts` (call `registerDaemon(program)`)
- Test: `tests/cli-daemon.test.ts` (tests the pure pieces: lock lifecycle + a bounded loop that stops on signal)

**Interfaces:**
- Consumes: `Daemon` (Task 11), `ModelServer` (Task 9), `RealTmuxGateway` (Task 4), `WorkspaceModel` (Task 8), `DEFAULT_GMUX_CONFIG`; a lock helper mirroring `auto-summarize.ts` (`acquireLock`/`releaseLock`/`readLock`) but at `gmuxDir()/daemon.lock`.
- Produces: `registerDaemon(program)`; internal `runDaemonLoop(deps, { tickMs, stop: AbortSignal })` for testability.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli-daemon.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { runDaemonLoop } from "../src/cli/commands/daemon.js";

describe("runDaemonLoop", () => {
  it("ticks until aborted", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true }]);
    const model = new WorkspaceModel();
    const ac = new AbortController();
    let ticks = 0;
    const done = runDaemonLoop(
      { gateway: gw, model, now: () => 100_000, makeSensor: undefined },
      { tickMs: 1, signal: ac.signal, onTick: () => { if (++ticks >= 3) ac.abort(); } },
    );
    await done;
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(model.snapshot().panes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-daemon.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/commands/daemon.ts
import type { Command } from "commander";
import { Daemon, type DaemonDeps } from "../../services/daemon.js";
import { ModelServer } from "../../services/daemon-socket.js";
import { RealTmuxGateway } from "../../services/tmux-gateway.js";
import { WorkspaceModel } from "../../services/workspace.js";
import { DEFAULT_GMUX_CONFIG } from "../../core/gmux-types.js";

export interface LoopOpts { tickMs: number; signal: AbortSignal; onTick?: () => void; }

export async function runDaemonLoop(deps: DaemonDeps, opts: LoopOpts): Promise<void> {
  const daemon = new Daemon(deps);
  while (!opts.signal.aborted) {
    await daemon.tickOnce().catch(() => { /* keep the loop alive */ });
    opts.onTick?.();
    if (opts.signal.aborted) break;
    await new Promise<void>((r) => {
      const t = setTimeout(r, opts.tickMs);
      opts.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
  }
}

export function registerDaemon(program: Command): void {
  const cmd = program.command("daemon").description("Run the gmux workspace daemon");
  cmd.command("run", { isDefault: true }).description("Run the daemon loop (foreground)").action(async () => {
    const model = new WorkspaceModel();
    const server = new ModelServer(model);
    await server.start();
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try {
      await runDaemonLoop({ gateway: new RealTmuxGateway(), model, now: () => Date.now() }, { tickMs: DEFAULT_GMUX_CONFIG.tickMs, signal: ac.signal });
    } finally { await server.stop(); }
  });
  cmd.command("status").description("Show whether the daemon is running").action(async () => {
    // read lock (mirror auto-summarize readLock); print running/stale/stopped + snapshot age
  });
  cmd.command("stop").description("Stop the running daemon").action(async () => {
    // read lock pid, process.kill(pid, "SIGTERM")
  });
}
```

Register in `src/cli/main.ts` alongside the other `registerXxx(program)` calls.

> Flesh out `status`/`stop` using the lock pattern from `services/auto-summarize.ts` (`acquireLock`/`readLock`/liveness via `process.kill(pid, 0)`). The `run` action should `acquireLock` at start and `releaseLock` in the `finally`, refusing to start a second daemon if a live lock exists.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/cli-daemon.test.ts && npm run check:types`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/daemon.ts src/cli/main.ts tests/cli-daemon.test.ts
git commit -m "feat(gmux): gmux daemon command with socket server and supervised loop"
```

---

### Task 13: Daemon-driven border labels (state only)

Borders repaint from the daemon snapshot: a thin client subscribes and writes each pane's `@gm_label` from the model (state glyph + resolved project/command), zero sensing. Phase 0 shows state only; semantics fill in during Phase 1.

**Files:**
- Create: `src/cli/border-client.ts`
- Modify: `src/cli/tmux-label.ts` (add `labelFromSnapshot(snapshot, gateway)` that paints `@gm_label` per pane without re-sensing)
- Test: `tests/border-client.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshot`, `PaneEntry` from `gmux-types.js`; `TmuxGateway` (for a `setLabel(paneId, text)` — add a `setOption` verb to the gateway) OR reuse `set-option` directly.
- Produces:
  - In `tmux-label.ts`: `stateGlyph(state: PaneState): string` (`working→●`, `waiting→◔`, `error→✗`, `done→✓`, `idle→○`) and `snapshotLabel(entry: PaneEntry): string` (`"<glyph> <project|command> — <semantics.label|state>"`).
  - `border-client.ts`: `paintFromSnapshot(snapshot, setLabel): Promise<void>`.

Add a `setOption(paneId, name, value)` method to `TmuxGateway` + fake (records `{paneId,name,value}` in `labels`) so this is headless-testable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/border-client.test.ts
import { describe, expect, it } from "vitest";
import { snapshotLabel, stateGlyph } from "../src/cli/tmux-label.js";
import type { PaneEntry } from "../src/core/gmux-types.js";

const entry = (over: Partial<PaneEntry>): PaneEntry => ({
  identity: { paneId: "%1", windowId: "@1", active: true, harness: null, sessionId: null, cwd: "/x/webshop", command: "node", pid: 1 },
  state: "working", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false, ...over,
});

describe("border labels from snapshot", () => {
  it("maps states to glyphs", () => {
    expect(stateGlyph("working")).toBe("●");
    expect(stateGlyph("waiting")).toBe("◔");
    expect(stateGlyph("error")).toBe("✗");
  });
  it("uses the project name and falls back to state when unsummarized", () => {
    expect(snapshotLabel(entry({}))).toBe("● webshop — working");
  });
  it("prefers the semantic label once it arrives", () => {
    const e = entry({ semantics: { label: "running tests", card: null, fingerprint: "x", updatedAt: 0, stale: false } });
    expect(snapshotLabel(e)).toBe("● webshop — running tests");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/border-client.test.ts`
Expected: FAIL — `snapshotLabel` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/cli/tmux-label.ts`:

```ts
import { basename } from "node:path";
import type { PaneEntry, PaneState } from "../core/gmux-types.js";

export function stateGlyph(state: PaneState): string {
  switch (state) {
    case "working": return "●";
    case "waiting": return "◔";
    case "error": return "✗";
    case "done": return "✓";
    case "idle": return "○";
  }
}

export function snapshotLabel(entry: PaneEntry): string {
  const name = entry.identity.cwd ? basename(entry.identity.cwd) : entry.identity.command;
  const text = entry.semantics?.label ?? entry.state;
  return `${stateGlyph(entry.state)} ${name} — ${text}`;
}
```

Create `src/cli/border-client.ts`:

```ts
import type { WorkspaceSnapshot } from "../core/gmux-types.js";
import { snapshotLabel } from "./tmux-label.js";

export async function paintFromSnapshot(
  snapshot: WorkspaceSnapshot,
  setLabel: (paneId: string, text: string) => Promise<void>,
): Promise<void> {
  await Promise.all(snapshot.panes.map((e) => setLabel(e.identity.paneId, snapshotLabel(e))));
}
```

Add `setOption` to `TmuxGateway`/`RealTmuxGateway`/`FakeTmuxGateway` (real: `tmux set-option -p -t <pane> <name> <value>`; fake records to `labels: Array<{paneId,name,value}>`). Wire the border client into `gmux daemon run` (subscribe to the model in-process and paint on change), and add `border-client` usage there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/border-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tmux-label.ts src/cli/border-client.ts src/services/tmux-gateway.ts tests/fixtures/fake-gateway.ts tests/border-client.test.ts
git commit -m "feat(gmux): daemon-driven border labels (state only)"
```

---

### Task 14: Phase 0 integration test — always-on loop, headless

Proves the skeleton end-to-end: a fake gateway feeds panes, a real `Daemon` + `ModelServer` run, a `daemon-client` subscriber receives snapshots, and the border client would paint expected labels — with **zero LLM**.

**Files:**
- Test: `tests/gmux-phase0-integration.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 4–13.
- Produces: no new source; a wiring test.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-phase0-integration.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { ModelServer } from "../src/services/daemon-socket.js";
import { subscribe } from "../src/services/daemon-client.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";
import type { Sensor } from "../src/services/sensors.js";

let server: ModelServer | undefined;
afterEach(async () => { await server?.stop(); });

class ActiveSensor implements Sensor {
  readonly kind = "terminal" as const;
  constructor(private id: { paneId: string }) {}
  async observe(now: number) { return { paneId: this.id.paneId, kind: "terminal" as const, ts: now, tailLines: [], lastActivityTs: now }; }
  async teardown() {}
}

describe("gmux phase 0 — always-on loop", () => {
  it("a pane's state reaches a socket subscriber without any LLM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const sock = join(dir, "d.sock");
    const snap = join(dir, "snap.json");
    const gw = new FakeTmuxGateway();
    gw.setPanes([{ paneId: "%9", left: 0, top: 0, width: 80, height: 24, cwd: "/x/webshop", command: "node", pid: 5, windowId: "@1", active: true }]);
    const model = new WorkspaceModel();
    server = new ModelServer(model, sock, snap);
    await server.start();
    const daemon = new Daemon({ gateway: gw, model, now: () => 100_000, makeSensor: (id) => new ActiveSensor(id) });

    const seen: WorkspaceSnapshot[] = [];
    const got = new Promise<void>((resolve) => {
      const stop = subscribe((s) => { seen.push(s); if (s.panes.some((p) => p.state === "working")) { stop(); resolve(); } }, { socketPath: sock });
    });
    await daemon.tickOnce();
    await got;
    expect(seen.at(-1)!.panes[0]!.identity.paneId).toBe("%9");
    expect(seen.at(-1)!.panes[0]!.state).toBe("working");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-phase0-integration.test.ts`
Expected: FAIL until wiring is correct (should actually pass if Tasks 4–13 are done — treat any failure as a wiring bug and fix it, per systematic-debugging).

- [ ] **Step 3: (no new implementation)** — if it fails, debug the wiring, not the test.

- [ ] **Step 4: Run the full suite + typecheck + layers**

Run: `npm test && npm run check:types`
Expected: PASS across the board.

- [ ] **Step 5: Commit**

```bash
git add tests/gmux-phase0-integration.test.ts
git commit -m "test(gmux): phase 0 headless always-on loop integration"
```

---

## PHASE 1 — Attention-tax core

The wedge: semantic summarizer (reuse), full state taxonomy already in place, cockpit grid.

---

### Task 15: Meaningful-change gate + debounce for semantics

Decides *when* a pane earns a fresh LLM label: SimHash distance over the observation tail (reuse `fingerprint`), plus a per-pane debounce window. Pure + a small stateful gate.

**Files:**
- Create: `src/services/semantic-gate.ts`
- Test: `tests/semantic-gate.test.ts`

**Interfaces:**
- Consumes: `simhash64`, `hammingDistance` from `core/fingerprint.js`; `Observation` from `gmux-types.js`.
- Produces:
  - `class SemanticGate { constructor(opts?: { distance?: number; debounceMs?: number }); shouldSummarize(paneId, obs: Observation, now: number): boolean; noteQueued(paneId, obs, now): void; }`
  - Fires when: never summarized before, OR Hamming distance of the new tail's SimHash vs the last-queued exceeds `distance` (default 8) AND at least `debounceMs` (default 4000) since the last queue for that pane.

- [ ] **Step 1: Write the failing test**

```ts
// tests/semantic-gate.test.ts
import { describe, expect, it } from "vitest";
import { SemanticGate } from "../src/services/semantic-gate.js";
import type { Observation } from "../src/core/gmux-types.js";

const obs = (lines: string[], ts: number): Observation => ({ paneId: "%1", kind: "terminal", ts, tailLines: lines, lastActivityTs: ts });

describe("SemanticGate", () => {
  it("fires on first observation", () => {
    const g = new SemanticGate();
    expect(g.shouldSummarize("%1", obs(["hello"], 0), 0)).toBe(true);
  });
  it("does not re-fire within the debounce window for tiny changes", () => {
    const g = new SemanticGate({ debounceMs: 4000 });
    const first = obs(["compiling module a"], 0);
    expect(g.shouldSummarize("%1", first, 0)).toBe(true);
    g.noteQueued("%1", first, 0);
    expect(g.shouldSummarize("%1", obs(["compiling module a."], 1000), 1000)).toBe(false);
  });
  it("fires again after a large change past the debounce window", () => {
    const g = new SemanticGate({ debounceMs: 4000, distance: 8 });
    const first = obs(["compiling"], 0);
    g.shouldSummarize("%1", first, 0); g.noteQueued("%1", first, 0);
    const big = obs(["running the full end to end test suite now against staging"], 5000);
    expect(g.shouldSummarize("%1", big, 5000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/semantic-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/semantic-gate.ts
import { hammingDistance, simhash64 } from "../core/fingerprint.js";
import type { Observation } from "../core/gmux-types.js";

interface Last { fingerprint: string; ts: number; }

export class SemanticGate {
  private last = new Map<string, Last>();
  private readonly distance: number;
  private readonly debounceMs: number;

  constructor(opts: { distance?: number; debounceMs?: number } = {}) {
    this.distance = opts.distance ?? 8;
    this.debounceMs = opts.debounceMs ?? 4000;
  }

  private fp(obs: Observation): string { return simhash64(obs.tailLines.join("\n")); }

  shouldSummarize(paneId: string, obs: Observation, now: number): boolean {
    const prev = this.last.get(paneId);
    if (!prev) return true;
    if (now - prev.ts < this.debounceMs) return false;
    return hammingDistance(this.fp(obs), prev.fingerprint) > this.distance;
  }

  noteQueued(paneId: string, obs: Observation, now: number): void {
    this.last.set(paneId, { fingerprint: this.fp(obs), ts: now });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/semantic-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/semantic-gate.ts tests/semantic-gate.test.ts
git commit -m "feat(gmux): change-gate + debounce for semantic summaries"
```

---

### Task 16: Semantic worker — label/card from an observation

A bounded worker that turns a gated pane's observation into a `PaneSemantics` via the summary provider, then writes it to the model. LLM is mocked in tests; a hanging provider must not block anything (decoupling invariant).

**Files:**
- Create: `src/services/semantic.ts`
- Test: `tests/semantic.test.ts`

**Interfaces:**
- Consumes: `SummaryProvider` (`core/types.js`); `mapLimit` (`concurrency.js`); `WorkspaceModel` (Task 8); `SemanticGate` (Task 15); `PaneSemantics`, `Observation`, `PaneEntry` from `gmux-types.js`; `simhash64` from `fingerprint.js`.
- Produces:
  - `interface LabelProvider { label(input: { paneId: string; project: string | null; tailLines: string[] }): Promise<{ label: string; card: string }>; }`
  - `class CliLabelProvider implements LabelProvider` — wraps a `SummaryProvider`, building a compact prompt asking for a `{ "label": "...", "card": "..." }` JSON (label ≤ 8 words).
  - `class SemanticWorker { constructor(model: WorkspaceModel, provider: LabelProvider, gate: SemanticGate, concurrency?: number); enqueue(entry: PaneEntry, obs: Observation, now: number): void; drain(): Promise<void>; }` — coalesces per-pane pending requests; on completion writes `applySemantics`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/semantic.test.ts
import { describe, expect, it, vi } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import type { PaneEntry, Observation } from "../src/core/gmux-types.js";

const entry: PaneEntry = {
  identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code", sessionId: "s", cwd: "/x/webshop", command: "node", pid: 1 },
  state: "working", semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
};
const obs: Observation = { paneId: "%1", kind: "agent", ts: 0, tailLines: ["writing the checkout tests"], lastActivityTs: 0 };

describe("SemanticWorker", () => {
  it("writes a label into the model", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(entry.identity);
    const provider: LabelProvider = { label: async () => ({ label: "writing checkout tests", card: "full card" }) };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }));
    w.enqueue(entry, obs, 0);
    await w.drain();
    expect(model.snapshot().panes[0]!.semantics!.label).toBe("writing checkout tests");
  });

  it("a hanging provider never blocks drain of other panes (decoupling invariant)", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(entry.identity);
    model.upsertIdentity({ ...entry.identity, paneId: "%2" });
    let resolveHang: (() => void) | undefined;
    const provider: LabelProvider = {
      label: vi.fn(async ({ paneId }) => {
        if (paneId === "%1") { await new Promise<void>((r) => (resolveHang = r)); }
        return { label: "done", card: "c" };
      }),
    };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }), 2);
    w.enqueue(entry, obs, 0);
    w.enqueue({ ...entry, identity: { ...entry.identity, paneId: "%2" } }, { ...obs, paneId: "%2" }, 0);
    // %2 completes even while %1 hangs
    await vi.waitFor(() => expect(model.snapshot().panes.find((p) => p.identity.paneId === "%2")!.semantics?.label).toBe("done"));
    resolveHang?.();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/semantic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/semantic.ts
import type { SummaryProvider } from "../core/types.js";
import type { Observation, PaneEntry, PaneSemantics } from "../core/gmux-types.js";
import { simhash64 } from "../core/fingerprint.js";
import type { WorkspaceModel } from "./workspace.js";
import type { SemanticGate } from "./semantic-gate.js";

export interface LabelProvider {
  label(input: { paneId: string; project: string | null; tailLines: string[] }): Promise<{ label: string; card: string }>;
}

export class CliLabelProvider implements LabelProvider {
  constructor(private readonly provider: SummaryProvider) {}
  async label(input: { paneId: string; project: string | null; tailLines: string[] }): Promise<{ label: string; card: string }> {
    // Reuse the summary provider's generate() with a compact SummaryInput-like prompt,
    // or a dedicated one-liner prompt. Parse a { label, card } JSON object.
    // Kept thin here; the prompt text lives in buildLabelPrompt().
    const fields = await this.provider.generate(toSummaryInput(input));
    return { label: fields.headline, card: fields.summary || fields.overview };
  }
}

export class SemanticWorker {
  private running = 0;
  private pending = new Map<string, { entry: PaneEntry; obs: Observation; now: number }>();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly model: WorkspaceModel,
    private readonly provider: LabelProvider,
    private readonly gate: SemanticGate,
    private readonly concurrency = 4,
  ) {}

  enqueue(entry: PaneEntry, obs: Observation, now: number): void {
    if (!this.gate.shouldSummarize(entry.identity.paneId, obs, now)) return;
    this.gate.noteQueued(entry.identity.paneId, obs, now);
    this.pending.set(entry.identity.paneId, { entry, obs, now }); // coalesce: newest wins
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.size > 0) {
      const [paneId, job] = this.pending.entries().next().value as [string, { entry: PaneEntry; obs: Observation; now: number }];
      this.pending.delete(paneId);
      this.running += 1;
      void this.run(paneId, job).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.running === 0 && this.pending.size === 0) { this.waiters.forEach((w) => w()); this.waiters = []; }
      });
    }
  }

  private async run(paneId: string, job: { entry: PaneEntry; obs: Observation; now: number }): Promise<void> {
    try {
      const project = job.entry.identity.cwd ? job.entry.identity.cwd.split("/").pop() ?? null : null;
      const { label, card } = await this.provider.label({ paneId, project, tailLines: job.obs.tailLines });
      const semantics: PaneSemantics = { label, card, fingerprint: simhash64(job.obs.tailLines.join("\n")), updatedAt: job.now, stale: false };
      this.model.applySemantics(paneId, semantics);
    } catch {
      // Mark stale rather than crash; retry happens on the next meaningful change.
    }
  }

  drain(): Promise<void> {
    if (this.running === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((r) => this.waiters.push(r));
  }
}
```

> `toSummaryInput` / `buildLabelPrompt`: adapt `distill.buildPrompt` to ask for a short `{label, card}`. For the MVP you may reuse `summarizeSession`'s existing `headline`/`summary` fields directly (as above) rather than a new prompt — that keeps the reuse promise. The decoupling test only needs the worker to not serialize on a hung call, which the concurrency pool guarantees.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/semantic.test.ts`
Expected: PASS (both tests, including the decoupling invariant).

- [ ] **Step 5: Commit**

```bash
git add src/services/semantic.ts tests/semantic.test.ts
git commit -m "feat(gmux): semantic worker — gated, coalesced label/card, LLM-decoupled"
```

---

### Task 17: Wire semantics into the daemon (off-tick)

The fast path stays untouched; after classifying, the daemon enqueues gated panes to the `SemanticWorker`. A stubbed-to-hang provider must leave the fast path fully live.

**Files:**
- Modify: `src/services/daemon.ts` (accept an optional `semantic?: SemanticWorker`; enqueue after `applyState`)
- Test: `tests/daemon-semantic.test.ts`

**Interfaces:**
- Consumes: `SemanticWorker` (Task 16).
- Produces: `DaemonDeps` gains `semantic?: SemanticWorker`; `Daemon.tickOnce` enqueues each present pane's `(entry, obs, now)` when a worker is present. Never awaits the worker.

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon-semantic.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import type { Sensor } from "../src/services/sensors.js";

const pane = { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x", command: "zsh", pid: 10, windowId: "@1", active: true };
class S implements Sensor { readonly kind = "terminal" as const; constructor(private id: { paneId: string }) {}
  async observe(now: number) { return { paneId: this.id.paneId, kind: "terminal" as const, ts: now, tailLines: ["busy"], lastActivityTs: now }; }
  async teardown() {} }

describe("daemon feeds the semantic worker without blocking", () => {
  it("keeps state fresh even when the label provider hangs", async () => {
    const gw = new FakeTmuxGateway(); gw.setPanes([pane]);
    const model = new WorkspaceModel();
    const provider: LabelProvider = { label: () => new Promise(() => {}) }; // never resolves
    const worker = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }));
    const d = new Daemon({ gateway: gw, model, now: () => 100_000, makeSensor: (id) => new S(id), semantic: worker });
    await d.tickOnce();
    // Fast path recorded state despite the hung LLM.
    expect(model.snapshot().panes[0]!.state).toBe("working");
    expect(model.snapshot().panes[0]!.semantics).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon-semantic.test.ts`
Expected: FAIL — `semantic` is not a recognized dep.

- [ ] **Step 3: Write minimal implementation**

In `src/services/daemon.ts`, add `semantic?: SemanticWorker` to `DaemonDeps` and, inside the present-pane loop after `applyState`, capture the entry and enqueue:

```ts
        const obs = await sensor.observe(now);
        this.deps.model.applyState(id.paneId, classifyState(obs, now), obs.lastActivityTs, now);
        if (this.deps.semantic) {
          const entry = this.deps.model.snapshot().panes.find((p) => p.identity.paneId === id.paneId);
          if (entry) this.deps.semantic.enqueue(entry, obs, now); // fire-and-forget, never awaited
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon-semantic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.ts tests/daemon-semantic.test.ts
git commit -m "feat(gmux): daemon enqueues semantics off-tick, never blocking fast path"
```

---

### Task 18: Cockpit grid renderer (pure)

Pure function: `WorkspaceSnapshot` → an array of text lines for the full-screen grid (guardian log at top; per pane: state glyph, project, one-liner, memory, last-activity). No I/O; reuses the overlay's degradation instincts.

**Files:**
- Create: `src/cli/gmux-render.ts`
- Test: `tests/gmux-render.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshot`, `PaneEntry` from `gmux-types.js`; `stateGlyph` from `tmux-label.js`.
- Produces:
  - `function renderCockpit(snapshot: WorkspaceSnapshot, now: number, width?: number): string[]`
  - `function formatBytes(n: number): string` (e.g. `4.2 GB`), `function relativeTime(ts: number, now: number): string` (e.g. `12s ago`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-render.test.ts
import { describe, expect, it } from "vitest";
import { renderCockpit, formatBytes, relativeTime } from "../src/cli/gmux-render.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";

const snap: WorkspaceSnapshot = {
  version: 3, updatedAt: 100_000,
  panes: [{
    identity: { paneId: "%1", windowId: "@1", active: true, harness: "claude-code", sessionId: "s", cwd: "/x/webshop", command: "node", pid: 1 },
    state: "working", semantics: { label: "running e2e tests", card: null, fingerprint: "x", updatedAt: 0, stale: false },
    resources: { perPaneRss: 4_509_715_660, ts: 0 }, lastActivityTs: 95_000, ts: 95_000, gone: false,
  }],
  hostPressure: null, guardianLog: [],
};

describe("renderCockpit", () => {
  it("formats bytes and relative time", () => {
    expect(formatBytes(4_509_715_660)).toBe("4.2 GB");
    expect(relativeTime(95_000, 100_000)).toBe("5s ago");
  });
  it("renders a pane row with glyph, project, label, memory, activity", () => {
    const lines = renderCockpit(snap, 100_000, 120).join("\n");
    expect(lines).toContain("● webshop");
    expect(lines).toContain("running e2e tests");
    expect(lines).toContain("4.2 GB");
    expect(lines).toContain("5s ago");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/gmux-render.ts
import { basename } from "node:path";
import type { PaneEntry, WorkspaceSnapshot } from "../core/gmux-types.js";
import { stateGlyph } from "./tmux-label.js";

export function formatBytes(n: number): string {
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / 1e6;
  return `${mb.toFixed(0)} MB`;
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function paneRow(e: PaneEntry, now: number): string {
  const name = e.identity.cwd ? basename(e.identity.cwd) : e.identity.command;
  const label = e.semantics?.label ?? e.state;
  const mem = e.resources ? formatBytes(e.resources.perPaneRss) : "—";
  const activity = e.lastActivityTs ? relativeTime(e.lastActivityTs, now) : "—";
  return `${stateGlyph(e.state)} ${name}  ${label}  [${mem}]  ${activity}`;
}

export function renderCockpit(snapshot: WorkspaceSnapshot, now: number, _width = 120): string[] {
  const lines: string[] = [];
  for (const g of snapshot.guardianLog.slice(-3)) lines.push(`⚠ ${g.message}`);
  if (snapshot.guardianLog.length > 0) lines.push("");
  lines.push(`gmux — ${snapshot.panes.length} panes`);
  for (const e of snapshot.panes) lines.push(paneRow(e, now));
  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/gmux-render.ts tests/gmux-render.test.ts
git commit -m "feat(gmux): pure cockpit grid renderer"
```

---

### Task 19: `gmux cockpit` command + ctrl+g binding

Launches the overlay client: read the snapshot (or subscribe to the socket), render the grid, subscribe while open, exit on close key. Bound to ctrl+g via `display-popup`.

**Files:**
- Create: `src/cli/commands/cockpit.ts`
- Modify: `src/cli/main.ts` (`registerCockpit`), `src/cli/commands/tmux.ts` (rebind `C-g` to `gmux cockpit`)
- Test: `tests/cli-cockpit.test.ts` (pure frame-building; render loop is thin)

**Interfaces:**
- Consumes: `renderCockpit` (Task 18); `readSnapshotFile`/`subscribe` (Task 10); `isCloseKey` (reuse from `commands/overlay.ts`).
- Produces: `registerCockpit(program)`; `buildFrame(snapshot, now): string` (clears screen + joins `renderCockpit`). The ctrl+g binding string in `tmux.ts` changes from `gmux overlay ...` to `gmux cockpit`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli-cockpit.test.ts
import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/cli/commands/cockpit.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";

const snap: WorkspaceSnapshot = { version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] };

describe("cockpit buildFrame", () => {
  it("clears the screen and shows the pane count", () => {
    const frame = buildFrame(snap, 0);
    expect(frame).toContain("\x1b[2J"); // clear
    expect(frame).toContain("gmux — 0 panes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-cockpit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/commands/cockpit.ts
import type { Command } from "commander";
import type { WorkspaceSnapshot } from "../../core/gmux-types.js";
import { renderCockpit } from "../gmux-render.js";
import { readSnapshotFile, subscribe } from "../../services/daemon-client.js";

export function buildFrame(snapshot: WorkspaceSnapshot, now: number): string {
  return "\x1b[2J\x1b[H" + renderCockpit(snapshot, now).join("\r\n");
}

export function registerCockpit(program: Command): void {
  program.command("cockpit").description("Pull up the gmux workspace cockpit").action(async () => {
    const initial = await readSnapshotFile();
    const paint = (s: WorkspaceSnapshot) => process.stdout.write(buildFrame(s, Date.now()));
    if (initial) paint(initial.snapshot);
    const stop = subscribe(paint, { onError: () => { /* fall back to snapshot; show stale marker */ } });
    // raw-mode stdin loop: any close key (Esc/ctrl-c/ctrl-g) → stop() + exit. Reuse isCloseKey from overlay.
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const s = d.toString();
      if (s === "\x1b" || s === "\x03" || s === "\x07") { stop(); process.stdin.setRawMode?.(false); process.exit(0); }
    });
  });
}
```

Rebind in `src/cli/commands/tmux.ts` `bindingsBlock()`: change the `C-g` popup command from `gmux overlay "$(...)"` to `gmux cockpit`. Register `registerCockpit(program)` in `main.ts`.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/cli-cockpit.test.ts && npm run check:types`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/cockpit.ts src/cli/main.ts src/cli/commands/tmux.ts tests/cli-cockpit.test.ts
git commit -m "feat(gmux): gmux cockpit grid + ctrl+g binding"
```

---

## PHASE 2 — Memory guardian

Resource monitor, guardian policy + broadcast + `gmux setup` disclosure, cockpit memory column + culprit naming.

---

### Task 20: Process-tree parser (pure)

Pure parse of a `ps` snapshot into a pid→children map and a subtree-RSS summer. The seam that makes the resource monitor testable with synthetic trees.

**Files:**
- Create: `src/core/proc-tree.ts`
- Test: `tests/proc-tree.test.ts`

**Interfaces:**
- Produces:
  - `interface ProcRow { pid: number; ppid: number; rss: number; comm: string; }`
  - `function parsePsOutput(raw: string): ProcRow[]` (parses `ps -axo pid,ppid,rss,comm` — rss in KB → bytes).
  - `function subtreeRss(rootPid: number, rows: ProcRow[]): number` (sum RSS of `rootPid` + all descendants).
  - `function totalRss(rows: ProcRow[]): number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/proc-tree.test.ts
import { describe, expect, it } from "vitest";
import { parsePsOutput, subtreeRss, totalRss } from "../src/core/proc-tree.js";

const raw = [
  "  PID  PPID    RSS COMM",
  "  100     1   1000 zsh",
  "  200   100   2000 node",
  "  300   200   4000 esbuild",
  "  400     1   8000 Slack",
].join("\n");

describe("proc-tree", () => {
  it("parses rss from KB to bytes", () => {
    const rows = parsePsOutput(raw);
    expect(rows.find((r) => r.pid === 200)!.rss).toBe(2000 * 1024);
  });
  it("sums a subtree including grandchildren", () => {
    const rows = parsePsOutput(raw);
    // 100 + 200 + 300 = (1000+2000+4000) KB
    expect(subtreeRss(100, rows)).toBe((1000 + 2000 + 4000) * 1024);
  });
  it("excludes unrelated processes from a subtree", () => {
    const rows = parsePsOutput(raw);
    expect(subtreeRss(200, rows)).toBe((2000 + 4000) * 1024); // not Slack
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proc-tree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/proc-tree.ts
export interface ProcRow { pid: number; ppid: number; rss: number; comm: string; }

/** Parse `ps -axo pid,ppid,rss,comm`. RSS is KB on macOS/Linux → convert to bytes. */
export function parsePsOutput(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue; // skips the header and blanks
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, comm: m[4]!.trim() });
  }
  return rows;
}

export function subtreeRss(rootPid: number, rows: ProcRow[]): number {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const r of rows) {
    rss.set(r.pid, r.rss);
    (children.get(r.ppid) ?? children.set(r.ppid, []).get(r.ppid)!).push(r.pid);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return total;
}

export function totalRss(rows: ProcRow[]): number {
  return rows.reduce((sum, r) => sum + r.rss, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proc-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/proc-tree.ts tests/proc-tree.test.ts
git commit -m "feat(gmux): pure process-tree parser and subtree-RSS summer"
```

---

### Task 21: Resource monitor — perPaneRss, hostPressure, unattributed

Runs `ps` once, computes each pane's subtree RSS, reads host memory pressure from the OS, and reports what escaped attribution. `ps`, host reader, and platform are injectable so tests never spawn.

**Files:**
- Create: `src/services/resources.ts`
- Test: `tests/resources.test.ts`

**Interfaces:**
- Consumes: `parsePsOutput`, `subtreeRss`, `totalRss` (Task 20); `HostPressure`, `PaneResources` from `gmux-types.js`.
- Produces:
  - `interface ResourceDeps { psSnapshot: () => Promise<string>; hostMemory: () => Promise<{ usedRatio: number; usedBytes: number }>; }`
  - `class ResourceMonitor { constructor(deps?: Partial<ResourceDeps>); sample(panePids: Map<string, number>): Promise<{ perPane: Map<string, PaneResources>; host: HostPressure }>; }`
  - `unattributed = max(0, hostUsedBytes − Σ perPaneRss)` (clamped ≥ 0).
  - Real deps: macOS `ps -axo pid,ppid,rss,comm` + `vm_stat`/`sysctl hw.memsize`; Linux `/proc` + `/proc/meminfo`. Implement `defaultResourceDeps()` behind a platform switch.

- [ ] **Step 1: Write the failing test**

```ts
// tests/resources.test.ts
import { describe, expect, it } from "vitest";
import { ResourceMonitor } from "../src/services/resources.js";

const psOut = [
  "  PID  PPID    RSS COMM",
  "  100     1   1000 zsh",   // pane %1 shell
  "  200   100   3000 node",  // child of %1
  "  500     1   9000 Chrome",
].join("\n");

describe("ResourceMonitor", () => {
  it("attributes subtree RSS per pane and computes unattributed", async () => {
    const mon = new ResourceMonitor({
      psSnapshot: async () => psOut,
      hostMemory: async () => ({ usedRatio: 0.5, usedBytes: 20_000 * 1024 }),
    });
    const { perPane, host } = await mon.sample(new Map([["%1", 100]]));
    expect(perPane.get("%1")!.perPaneRss).toBe((1000 + 3000) * 1024);
    expect(host.usedRatio).toBe(0.5);
    // 20000 - (1000+3000) = 16000 KB unattributed
    expect(host.unattributed).toBe(16_000 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/resources.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostPressure, PaneResources } from "../core/gmux-types.js";
import { parsePsOutput, subtreeRss } from "../core/proc-tree.js";

const run = promisify(execFile);

export interface ResourceDeps {
  psSnapshot: () => Promise<string>;
  hostMemory: () => Promise<{ usedRatio: number; usedBytes: number }>;
}

export function defaultResourceDeps(): ResourceDeps {
  return {
    psSnapshot: async () => (await run("ps", ["-axo", "pid,ppid,rss,comm"])).stdout,
    hostMemory: async () => (process.platform === "darwin" ? readMacMemory() : readLinuxMemory()),
  };
}

export class ResourceMonitor {
  private deps: ResourceDeps;
  constructor(deps: Partial<ResourceDeps> = {}) { this.deps = { ...defaultResourceDeps(), ...deps }; }

  async sample(panePids: Map<string, number>): Promise<{ perPane: Map<string, PaneResources>; host: HostPressure }> {
    const now = Date.now();
    const rows = parsePsOutput(await this.deps.psSnapshot());
    const perPane = new Map<string, PaneResources>();
    let attributed = 0;
    for (const [paneId, pid] of panePids) {
      const rss = subtreeRss(pid, rows);
      attributed += rss;
      perPane.set(paneId, { perPaneRss: rss, ts: now });
    }
    const mem = await this.deps.hostMemory();
    const host: HostPressure = { usedRatio: mem.usedRatio, unattributed: Math.max(0, mem.usedBytes - attributed), ts: now };
    return { perPane, host };
  }
}

// readMacMemory / readLinuxMemory: parse vm_stat + sysctl hw.memsize (mac) and /proc/meminfo (linux).
```

> Implement `readMacMemory` (parse `vm_stat` page counts × page size for used, `sysctl -n hw.memsize` for total) and `readLinuxMemory` (`MemTotal`/`MemAvailable` from `/proc/meminfo`). Keep them small and defensive; they are covered by the injected fakes in tests, and by a `@platform` manual smoke.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/resources.ts tests/resources.test.ts
git commit -m "feat(gmux): resource monitor — per-pane RSS, host pressure, unattributed"
```

---

### Task 22: Guardian state machine (pure policy)

The one component that acts. Pure decision function over pressure + policy + clock: fire `broadcast`/`notify`/`log-only`/nothing, honoring threshold, cooldown, hysteresis, and no-target. Fake clock; no I/O.

**Files:**
- Create: `src/services/guardian.ts`
- Test: `tests/guardian.test.ts`

**Interfaces:**
- Consumes: `GuardianPolicy`, `HostPressure`, `PaneEntry`, `GuardianLogEntry` from `gmux-types.js`.
- Produces:
  - `interface GuardianDecision { action: "broadcast" | "notify" | "log-only" | "none"; culpritPaneId: string | null; culpritLabel: string; message: string; }`
  - `class Guardian { constructor(opts: { policy: GuardianPolicy; threshold: number; cooldownSeconds: number }); decide(host: HostPressure, panes: PaneEntry[], now: number): GuardianDecision; }`
  - State transitions: Normal→Pressured when `usedRatio ≥ threshold`; Pressured→Broadcast when `policy==="auto"` AND ≥1 agent pane; fire → Cooldown; while in Cooldown no re-fire until pressure drops below threshold and re-crosses OR `cooldownSeconds` elapsed. `policy==="notify"` → `notify` action (no send). `policy==="off"` → `log-only`. No agent panes → `log-only`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/guardian.test.ts
import { describe, expect, it } from "vitest";
import { Guardian } from "../src/services/guardian.js";
import type { HostPressure, PaneEntry } from "../src/core/gmux-types.js";

const host = (used: number): HostPressure => ({ usedRatio: used, unattributed: 0, ts: 0 });
const agent = (paneId: string, rss: number): PaneEntry => ({
  identity: { paneId, windowId: "@1", active: false, harness: "claude-code", sessionId: "s", cwd: "/x/webshop-build", command: "node", pid: 1 },
  state: "working", semantics: null, resources: { perPaneRss: rss, ts: 0 }, lastActivityTs: 0, ts: 0, gone: false,
});
const shell = (paneId: string): PaneEntry => ({ ...agent(paneId, 0), identity: { ...agent(paneId, 0).identity, harness: null, sessionId: null } });

describe("Guardian", () => {
  it("broadcasts over threshold with an agent target, naming the culprit", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = g.decide(host(0.92), [agent("%1", 4_200_000_000)], 0);
    expect(d.action).toBe("broadcast");
    expect(d.culpritPaneId).toBe("%1");
    expect(d.message).toContain("webshop-build");
  });
  it("stays quiet during cooldown", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    g.decide(host(0.95), [agent("%1", 1)], 0);
    const again = g.decide(host(0.95), [agent("%1", 1)], 60_000); // 60s < 300s
    expect(again.action).toBe("none");
  });
  it("re-fires after pressure drops and re-crosses", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    g.decide(host(0.95), [agent("%1", 1)], 0);
    g.decide(host(0.5), [agent("%1", 1)], 10_000);   // dropped below
    const refire = g.decide(host(0.95), [agent("%1", 1)], 20_000);
    expect(refire.action).toBe("broadcast");
  });
  it("logs only when there are no agent panes", () => {
    const g = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = g.decide(host(0.95), [shell("%1")], 0);
    expect(d.action).toBe("log-only");
  });
  it("notify policy never broadcasts", () => {
    const g = new Guardian({ policy: "notify", threshold: 0.9, cooldownSeconds: 300 });
    expect(g.decide(host(0.95), [agent("%1", 1)], 0).action).toBe("notify");
  });
  it("off policy only logs", () => {
    const g = new Guardian({ policy: "off", threshold: 0.9, cooldownSeconds: 300 });
    expect(g.decide(host(0.95), [agent("%1", 1)], 0).action).toBe("log-only");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/guardian.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/guardian.ts
import { basename } from "node:path";
import type { GuardianPolicy, HostPressure, PaneEntry } from "../core/gmux-types.js";

export interface GuardianDecision {
  action: "broadcast" | "notify" | "log-only" | "none";
  culpritPaneId: string | null;
  culpritLabel: string;
  message: string;
}

export class Guardian {
  private firedAt: number | null = null;
  private belowSinceFire = false;

  constructor(private readonly opts: { policy: GuardianPolicy; threshold: number; cooldownSeconds: number }) {}

  decide(host: HostPressure, panes: PaneEntry[], now: number): GuardianDecision {
    const over = host.usedRatio >= this.opts.threshold;
    if (!over) { if (this.firedAt !== null) this.belowSinceFire = true; return this.none(); }

    // In cooldown? Quiet unless pressure dropped and re-crossed, or the window elapsed.
    if (this.firedAt !== null) {
      const elapsed = (now - this.firedAt) / 1000;
      const mayRefire = this.belowSinceFire || elapsed >= this.opts.cooldownSeconds;
      if (!mayRefire) return this.none();
    }

    const { culprit, label } = topConsumer(panes, host);
    const agents = panes.filter((p) => p.identity.harness && p.identity.sessionId);
    const pct = Math.round(host.usedRatio * 100);
    const message = `host memory ${pct}% — top consumer: ${label}; checkpoint your work and pause non-essential tasks.`;

    if (this.opts.policy === "off") return { action: "log-only", culpritPaneId: culprit, culpritLabel: label, message };
    if (this.opts.policy === "notify") return this.fire("notify", culprit, label, message, now);
    if (agents.length === 0) return { action: "log-only", culpritPaneId: culprit, culpritLabel: label, message };
    return this.fire("broadcast", culprit, label, message, now);
  }

  private fire(action: "broadcast" | "notify", culprit: string | null, label: string, message: string, now: number): GuardianDecision {
    this.firedAt = now; this.belowSinceFire = false;
    return { action, culpritPaneId: culprit, culpritLabel: label, message };
  }
  private none(): GuardianDecision { return { action: "none", culpritPaneId: null, culpritLabel: "", message: "" }; }
}

function topConsumer(panes: PaneEntry[], host: HostPressure): { culprit: string | null; label: string } {
  let best: PaneEntry | null = null;
  for (const p of panes) if (p.resources && (!best || p.resources.perPaneRss > best.resources!.perPaneRss)) best = p;
  const bestRss = best?.resources?.perPaneRss ?? 0;
  if (!best || host.unattributed > bestRss) {
    return { culprit: null, label: "a source outside tracked panes" };
  }
  const name = best.identity.cwd ? basename(best.identity.cwd) : best.identity.command;
  const gb = (bestRss / 1e9).toFixed(1);
  return { culprit: best.identity.paneId, label: `window \`${name}\` (${gb} GB)` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/guardian.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/guardian.ts tests/guardian.test.ts
git commit -m "feat(gmux): guardian policy state machine (threshold/cooldown/hysteresis)"
```

---

### Task 23: Wire resource monitor + guardian into the daemon tick

Each tick after classification: sample resources → `applyResources` + `setHostPressure`; run the guardian → on `broadcast`, `gateway.send` the message to every agent pane; log every non-`none` decision to the model.

**Files:**
- Modify: `src/services/daemon.ts` (add `resources?: ResourceMonitor`, `guardian?: Guardian`)
- Test: `tests/daemon-guardian.test.ts`

**Interfaces:**
- Consumes: `ResourceMonitor` (Task 21), `Guardian` (Task 22).
- Produces: `DaemonDeps` gains `resources?`, `guardian?`. After the pane loop: build `panePids` from present identities, `sample`, apply to model; then `guardian.decide`; on `broadcast` send to each agent pane and `logGuardian`; on `notify`/`log-only` just `logGuardian`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon-guardian.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import { ResourceMonitor } from "../src/services/resources.js";
import { Guardian } from "../src/services/guardian.js";
import type { Sensor } from "../src/services/sensors.js";

// An agent pane: resolve stub makes it look resolved by giving the registry a link is hard here,
// so drive identity via a makeSensor + a resolve that marks harness. Simpler: use gateway pane whose
// registry resolve returns a record. For this test, inject makeSensor and rely on resources+guardian.
const pane = { paneId: "%1", left: 0, top: 0, width: 80, height: 24, cwd: "/x/webshop-build", command: "node", pid: 100, windowId: "@1", active: true };
class Busy implements Sensor { readonly kind = "terminal" as const; constructor(private id: {paneId:string}) {}
  async observe(now: number){return {paneId:this.id.paneId,kind:"terminal" as const,ts:now,tailLines:[],lastActivityTs:now};} async teardown(){} }

describe("daemon guardian integration", () => {
  it("broadcasts to an agent pane over threshold and logs it", async () => {
    const gw = new FakeTmuxGateway(); gw.setPanes([pane]);
    const model = new WorkspaceModel();
    // Force the pane to be an agent by resolving it via a custom registry resolve is out of scope here;
    // instead assert the log entry + that a send happened when guardian sees an agent.
    const resources = new ResourceMonitor({
      psSnapshot: async () => "  PID  PPID    RSS COMM\n  100     1  9000000 node\n",
      hostMemory: async () => ({ usedRatio: 0.95, usedBytes: 32e9 }),
    });
    const guardian = new Guardian({ policy: "auto", threshold: 0.9, cooldownSeconds: 300 });
    const d = new Daemon({
      gateway: gw, model, now: () => 100_000, makeSensor: (id) => new Busy(id),
      resources, guardian,
      // resolveOverride marks every pane as an agent for this test:
      resolveAgents: (panes) => panes.map((p) => p.paneId),
    });
    await d.tickOnce();
    const snap = model.snapshot();
    expect(snap.hostPressure!.usedRatio).toBe(0.95);
    expect(snap.guardianLog.length).toBe(1);
    expect(gw.sent.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon-guardian.test.ts`
Expected: FAIL — deps not recognized.

- [ ] **Step 3: Write minimal implementation**

Extend `DaemonDeps` with `resources?`, `guardian?`, and an optional `resolveAgents?: (present: PaneIdentity[]) => string[]` (defaults to panes with `harness && sessionId`). After the present-pane loop in `tickOnce`:

```ts
    if (this.deps.resources) {
      const panePids = new Map(present.map((p) => [p.paneId, p.pid]));
      const { perPane, host } = await this.deps.resources.sample(panePids);
      for (const [paneId, res] of perPane) this.deps.model.applyResources(paneId, res);
      this.deps.model.setHostPressure(host);

      if (this.deps.guardian) {
        const panes = this.deps.model.snapshot().panes;
        const decision = this.deps.guardian.decide(host, panes, now);
        if (decision.action !== "none") {
          if (decision.action === "broadcast") {
            const agentIds = (this.deps.resolveAgents?.(present)
              ?? present.filter((p) => p.harness && p.sessionId).map((p) => p.paneId));
            for (const id of agentIds) await this.deps.gateway.send(id, decision.message + "\n").catch(() => {});
          }
          this.deps.model.logGuardian({
            ts: now, pressure: host.usedRatio, culpritPaneId: decision.culpritPaneId,
            culpritLabel: decision.culpritLabel, action: decision.action === "notify" ? "notify" : decision.action === "broadcast" ? "broadcast" : "log-only",
            message: decision.message,
          });
        }
      }
    }
```

> The guardian `send` appends `"\n"` so the agent receives a submitted line. Real agent-pane targeting uses the registry's resolved `harness && sessionId`; `resolveAgents` exists only so the test can mark panes as agents without a full link fixture.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon-guardian.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.ts tests/daemon-guardian.test.ts
git commit -m "feat(gmux): daemon runs resource monitor + guardian, broadcasts + logs"
```

---

### Task 24: Guardian config + `gmux setup` disclosure

Persist the guardian policy in `GmConfig` and disclose it prominently at `gmux setup` (default `auto`, offer `notify`/`off`). Consent is explicit.

**Files:**
- Modify: `src/services/config.ts` (add `gmux?: GmuxConfig` to `GmConfig`; parse/default; getter `resolveGmuxConfig(config)`), `src/core/types.ts` (add `gmux?: GmuxConfig` to `GmConfig`), `src/cli/commands/setup.ts` (add the disclosure prompt)
- Test: `tests/gmux-config.test.ts`

**Interfaces:**
- Consumes: `GmuxConfig`, `DEFAULT_GMUX_CONFIG` from `gmux-types.js`.
- Produces: `resolveGmuxConfig(config: GmConfig | null): GmuxConfig` (fills defaults); `parseConfig` tolerates a missing/partial `gmux` block; setup wizard writes the chosen `guardianPolicy`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-config.test.ts
import { describe, expect, it } from "vitest";
import { resolveGmuxConfig } from "../src/services/config.js";
import { DEFAULT_GMUX_CONFIG } from "../src/core/gmux-types.js";

describe("resolveGmuxConfig", () => {
  it("defaults to auto-broadcast when unset", () => {
    expect(resolveGmuxConfig(null)).toEqual(DEFAULT_GMUX_CONFIG);
  });
  it("honors a stored policy and fills the rest", () => {
    const cfg = { version: 1, provider: null, autoSummarize: false, gmux: { guardianPolicy: "off" as const, memoryThreshold: 0.8, cooldownSeconds: 120, tickMs: 2000 } };
    expect(resolveGmuxConfig(cfg).guardianPolicy).toBe("off");
    expect(resolveGmuxConfig(cfg).memoryThreshold).toBe(0.8);
  });
  it("fills defaults for a partial gmux block", () => {
    const cfg = { version: 1, provider: null, autoSummarize: false, gmux: { guardianPolicy: "notify" as const } as any };
    const r = resolveGmuxConfig(cfg);
    expect(r.guardianPolicy).toBe("notify");
    expect(r.cooldownSeconds).toBe(DEFAULT_GMUX_CONFIG.cooldownSeconds);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-config.test.ts`
Expected: FAIL — `resolveGmuxConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/core/types.ts`, add to `GmConfig`:

```ts
  /** gmux daemon + guardian settings. Absent on configs written before gmux. */
  gmux?: import("./gmux-types.js").GmuxConfig;
```

In `src/services/config.ts`:

```ts
import { DEFAULT_GMUX_CONFIG, type GmuxConfig, type GuardianPolicy } from "../core/gmux-types.js";

export function resolveGmuxConfig(config: GmConfig | null): GmuxConfig {
  const g = config?.gmux;
  if (!g) return { ...DEFAULT_GMUX_CONFIG };
  const policy: GuardianPolicy = g.guardianPolicy === "off" || g.guardianPolicy === "notify" || g.guardianPolicy === "auto" ? g.guardianPolicy : DEFAULT_GMUX_CONFIG.guardianPolicy;
  return {
    guardianPolicy: policy,
    memoryThreshold: typeof g.memoryThreshold === "number" ? g.memoryThreshold : DEFAULT_GMUX_CONFIG.memoryThreshold,
    cooldownSeconds: typeof g.cooldownSeconds === "number" ? g.cooldownSeconds : DEFAULT_GMUX_CONFIG.cooldownSeconds,
    tickMs: typeof g.tickMs === "number" ? g.tickMs : DEFAULT_GMUX_CONFIG.tickMs,
  };
}
```

In `src/cli/commands/setup.ts`, add a prompt (after provider selection) that prints the disclosure and reads a choice, writing `config.gmux.guardianPolicy`:

```
The gmux memory guardian can type a "checkpoint and pause" message INTO your
agent panes when host memory runs critically low. This is the one action gmux
takes on your behalf.
  [1] auto     — broadcast automatically (default)
  [2] notify   — tell me, do not type anything
  [3] off      — never act
```

Default `1` on empty input. Persist into the config object the wizard already writes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-config.test.ts && npm run check:types`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/services/config.ts src/cli/commands/setup.ts tests/gmux-config.test.ts
git commit -m "feat(gmux): guardian policy config + explicit gmux setup disclosure"
```

---

### Task 25: Cockpit memory column + culprit naming (already fed by the model)

The renderer already shows per-pane memory (Task 18) and the guardian log at top. This task adds the ranked memory column ordering (hog first within the pane list) and honest `unattributed` display, plus a test over a snapshot carrying resources + guardian log.

**Files:**
- Modify: `src/cli/gmux-render.ts` (sort panes by `perPaneRss` desc when any resources present; append an `unattributed` line when it dominates)
- Test: `tests/gmux-render-memory.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshot` with `resources` + `hostPressure.unattributed`.
- Produces: `renderCockpit` gains ranked ordering; new helper `unattributedLine(host): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-render-memory.test.ts
import { describe, expect, it } from "vitest";
import { renderCockpit } from "../src/cli/gmux-render.js";
import type { WorkspaceSnapshot, PaneEntry } from "../src/core/gmux-types.js";

const pane = (id: string, rss: number, name: string): PaneEntry => ({
  identity: { paneId: id, windowId: "@1", active: false, harness: null, sessionId: null, cwd: `/x/${name}`, command: "node", pid: 1 },
  state: "working", semantics: null, resources: { perPaneRss: rss, ts: 0 }, lastActivityTs: 0, ts: 0, gone: false,
});
const snap: WorkspaceSnapshot = {
  version: 1, updatedAt: 0,
  panes: [pane("%1", 1e9, "small"), pane("%2", 5e9, "hog")],
  hostPressure: { usedRatio: 0.7, unattributed: 12e9, ts: 0 },
  guardianLog: [{ ts: 0, pressure: 0.92, culpritPaneId: null, culpritLabel: "a source outside tracked panes", action: "log-only", message: "host memory 92% — top consumer: a source outside tracked panes" }],
};

describe("cockpit memory view", () => {
  it("ranks the hog first and shows the guardian log", () => {
    const lines = renderCockpit(snap, 0);
    const hogIdx = lines.findIndex((l) => l.includes("hog"));
    const smallIdx = lines.findIndex((l) => l.includes("small"));
    expect(hogIdx).toBeLessThan(smallIdx);
    expect(lines.join("\n")).toContain("host memory 92%");
  });
  it("surfaces dominant unattributed memory honestly", () => {
    expect(renderCockpit(snap, 0).join("\n")).toContain("unattributed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-render-memory.test.ts`
Expected: FAIL — panes not ranked / no unattributed line.

- [ ] **Step 3: Write minimal implementation**

In `renderCockpit`, sort a copy of `snapshot.panes` by `resources?.perPaneRss ?? 0` descending when any pane has resources; after the pane rows, append `unattributedLine`:

```ts
export function unattributedLine(host: WorkspaceSnapshot["hostPressure"]): string | null {
  if (!host || host.unattributed <= 0) return null;
  return `  unattributed: ${formatBytes(host.unattributed)} (source outside tracked panes)`;
}
```

Wire both into `renderCockpit` (rank + append the line when non-null).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-render-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/gmux-render.ts tests/gmux-render-memory.test.ts
git commit -m "feat(gmux): cockpit ranks memory hogs and shows unattributed honestly"
```

---

## PHASE 3 — Hardening

Log rotation, LLM-queue prioritization, staleness UX, config polish.

---

### Task 26: Per-pane log rotation

Cap `pipe-pane` logs (keep last N MB); prune on pane close. Agent history comes from the transcript, so caps only bound the non-agent tail.

**Files:**
- Create: `src/services/log-rotation.ts`
- Modify: `src/services/sensors.ts` (`TerminalSensor.teardown` deletes its log; call `rotateIfLarge` after capture)
- Test: `tests/log-rotation.test.ts`

**Interfaces:**
- Produces:
  - `async function rotateIfLarge(logPath: string, maxBytes: number): Promise<boolean>` — if file > `maxBytes`, truncate to the last `maxBytes` (keep the tail). Returns whether it rotated.
  - `async function pruneLog(logPath: string): Promise<void>` — unlink, ignore ENOENT.
  - Constant `MAX_PANE_LOG_BYTES = 5 * 1024 * 1024`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/log-rotation.test.ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { rotateIfLarge, pruneLog } from "../src/services/log-rotation.js";

describe("log rotation", () => {
  it("keeps only the tail when over the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "X".repeat(100) + "TAIL");
    const rotated = await rotateIfLarge(p, 4);
    expect(rotated).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("TAIL");
  });
  it("does nothing under the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "small");
    expect(await rotateIfLarge(p, 1024)).toBe(false);
  });
  it("prune removes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmux-"));
    const p = join(dir, "pane.log");
    writeFileSync(p, "x");
    await pruneLog(p);
    expect(existsSync(p)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/log-rotation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/log-rotation.ts
import { rm, stat, open } from "node:fs/promises";

export const MAX_PANE_LOG_BYTES = 5 * 1024 * 1024;

export async function rotateIfLarge(logPath: string, maxBytes: number): Promise<boolean> {
  let size: number;
  try { size = (await stat(logPath)).size; } catch { return false; }
  if (size <= maxBytes) return false;
  const fh = await open(logPath, "r+");
  try {
    const keep = Buffer.alloc(maxBytes);
    await fh.read(keep, 0, maxBytes, size - maxBytes);
    await fh.truncate(0);
    await fh.write(keep, 0, maxBytes, 0);
  } finally { await fh.close(); }
  return true;
}

export async function pruneLog(logPath: string): Promise<void> {
  await rm(logPath, { force: true });
}
```

Wire into `TerminalSensor`: after `capture`/pipe, `await rotateIfLarge(paneLogPath(id), MAX_PANE_LOG_BYTES)`; in `teardown`, `await pruneLog(paneLogPath(id))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/log-rotation.test.ts && npm run check:types`
Expected: PASS and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/services/log-rotation.ts src/services/sensors.ts tests/log-rotation.test.ts
git commit -m "feat(gmux): per-pane log rotation and pruning"
```

---

### Task 27: LLM-queue prioritization (active/visible first)

The semantic worker prioritizes active/visible panes over background ones, so a burst can't starve the pane you're looking at. Priority: active pane > working state > others.

**Files:**
- Modify: `src/services/semantic.ts` (pending becomes a priority pick, not FIFO)
- Test: `tests/semantic-priority.test.ts`

**Interfaces:**
- Consumes: `PaneEntry.identity.active`, `PaneEntry.state`.
- Produces: `SemanticWorker` picks the highest-priority pending job next; `priorityOf(entry): number` (active=3, working=2, else=1). Concurrency 1 in the test makes ordering observable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/semantic-priority.test.ts
import { describe, expect, it } from "vitest";
import { WorkspaceModel } from "../src/services/workspace.js";
import { SemanticGate } from "../src/services/semantic-gate.js";
import { SemanticWorker, type LabelProvider } from "../src/services/semantic.js";
import type { PaneEntry, Observation } from "../src/core/gmux-types.js";

const mk = (id: string, active: boolean, state: PaneEntry["state"]): PaneEntry => ({
  identity: { paneId: id, windowId: "@1", active, harness: null, sessionId: null, cwd: "/x", command: "zsh", pid: 1 },
  state, semantics: null, resources: null, lastActivityTs: 0, ts: 0, gone: false,
});
const obs = (id: string): Observation => ({ paneId: id, kind: "terminal", ts: 0, tailLines: [id], lastActivityTs: 0 });

describe("semantic worker prioritization", () => {
  it("labels the active pane before a background one", async () => {
    const model = new WorkspaceModel();
    model.upsertIdentity(mk("%bg", false, "idle").identity);
    model.upsertIdentity(mk("%active", true, "working").identity);
    const order: string[] = [];
    const provider: LabelProvider = { label: async ({ paneId }) => { order.push(paneId); return { label: "x", card: "c" }; } };
    const w = new SemanticWorker(model, provider, new SemanticGate({ debounceMs: 0 }), 1);
    w.enqueue(mk("%bg", false, "idle"), obs("%bg"), 0);
    w.enqueue(mk("%active", true, "working"), obs("%active"), 0);
    await w.drain();
    expect(order[0]).toBe("%active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/semantic-priority.test.ts`
Expected: FAIL — current worker is FIFO.

- [ ] **Step 3: Write minimal implementation**

In `src/services/semantic.ts`, replace the FIFO `pending.entries().next()` pick with a priority pick:

```ts
function priorityOf(entry: PaneEntry): number {
  if (entry.identity.active) return 3;
  if (entry.state === "working") return 2;
  return 1;
}

// in pump(), select the highest-priority pending job:
private nextJob(): [string, { entry: PaneEntry; obs: Observation; now: number }] | null {
  let best: [string, { entry: PaneEntry; obs: Observation; now: number }] | null = null;
  for (const kv of this.pending) if (!best || priorityOf(kv[1].entry) > priorityOf(best[1].entry)) best = kv;
  return best;
}
```

Use `nextJob()` in `pump()` and `this.pending.delete(paneId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/semantic-priority.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/semantic.ts tests/semantic-priority.test.ts
git commit -m "feat(gmux): prioritize active/visible panes in the semantic queue"
```

---

### Task 28: Staleness UX

Surfaces mark the model stale when the socket is down and they are reading the snapshot file: cockpit header shows "daemon not connected — stale Ns ago"; borders show a stale marker. Pure formatting + a small gate.

**Files:**
- Modify: `src/cli/gmux-render.ts` (accept an optional `stale?: { ageMs: number } | null`; render a banner)
- Modify: `src/cli/commands/cockpit.ts` (pass staleness from `readSnapshotFile` when the socket errors)
- Test: `tests/gmux-render-stale.test.ts`

**Interfaces:**
- Consumes: `readSnapshotFile` age.
- Produces: `renderCockpit(snapshot, now, opts?: { width?: number; stale?: { ageMs: number } | null })`; when `stale` present, first line is `⚠ daemon not connected — snapshot Ns ago`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-render-stale.test.ts
import { describe, expect, it } from "vitest";
import { renderCockpit } from "../src/cli/gmux-render.js";
import type { WorkspaceSnapshot } from "../src/core/gmux-types.js";

const snap: WorkspaceSnapshot = { version: 1, updatedAt: 0, panes: [], hostPressure: null, guardianLog: [] };

describe("staleness banner", () => {
  it("shows a not-connected banner when stale", () => {
    const lines = renderCockpit(snap, 0, { stale: { ageMs: 8000 } });
    expect(lines[0]).toContain("daemon not connected");
    expect(lines[0]).toContain("8s ago");
  });
  it("no banner when live", () => {
    expect(renderCockpit(snap, 0).join("\n")).not.toContain("daemon not connected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-render-stale.test.ts`
Expected: FAIL — `renderCockpit` signature/opts not supported.

- [ ] **Step 3: Write minimal implementation**

Change `renderCockpit` to accept `opts?: { width?: number; stale?: { ageMs: number } | null }`. Keep the old positional `width` working by overloading or by reading `opts?.width`. When `opts?.stale` is set, unshift a banner line: `⚠ daemon not connected — snapshot ${relativeTime(now - opts.stale.ageMs, now)}`. Update the two existing call sites (Tasks 18/25 tests pass a plain snapshot; keep default behavior when `opts` omitted).

> Because Task 18's tests call `renderCockpit(snap, 100_000, 120)` positionally, keep backward-compat: `renderCockpit(snapshot, now, widthOrOpts?)` — if the third arg is a number, treat it as width; if an object, read `width`/`stale`. Add a tiny normalizer at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmux-render-stale.test.ts && npx vitest run tests/gmux-render.test.ts`
Expected: PASS (new + original render tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/gmux-render.ts src/cli/commands/cockpit.ts tests/gmux-render-stale.test.ts
git commit -m "feat(gmux): staleness UX — daemon-not-connected banner from snapshot age"
```

---

### Task 29: Error-path resilience tests (invariants locked)

Codifies the governing invariant and the tricky edge cases as explicit tests: hung LLM keeps the fast path live (already partly covered — add the socket-broadcast angle), tmux gateway throwing mid-tick doesn't crash the loop, pane vanishing mid-tick is normal.

**Files:**
- Test: `tests/gmux-invariants.test.ts`

**Interfaces:**
- Consumes: `Daemon`, `WorkspaceModel`, `FakeTmuxGateway`.
- Produces: no new source. If a test reveals a gap, fix the relevant module (systematic-debugging).

- [ ] **Step 1: Write the failing/what-if tests**

```ts
// tests/gmux-invariants.test.ts
import { describe, expect, it } from "vitest";
import { FakeTmuxGateway } from "./fixtures/fake-gateway.js";
import { WorkspaceModel } from "../src/services/workspace.js";
import { Daemon } from "../src/services/daemon.js";
import type { Sensor } from "../src/services/sensors.js";

class Busy implements Sensor { readonly kind = "terminal" as const; constructor(private id: {paneId:string}){}
  async observe(now:number){return{paneId:this.id.paneId,kind:"terminal" as const,ts:now,tailLines:[],lastActivityTs:now};} async teardown(){} }

describe("gmux invariants", () => {
  it("a gateway that throws on listPanes does not crash the tick", async () => {
    const gw = new FakeTmuxGateway();
    (gw as any).listPanes = async () => { throw new Error("tmux down"); };
    const model = new WorkspaceModel();
    const d = new Daemon({ gateway: gw, model, now: () => 0, makeSensor: (id) => new Busy(id) });
    await expect(d.tickOnce()).resolves.toBeUndefined(); // swallowed, loop survives
  });

  it("a sensor that throws leaves other panes classified", async () => {
    const gw = new FakeTmuxGateway();
    gw.setPanes([
      { paneId: "%good", left:0,top:0,width:80,height:24,cwd:"/x",command:"zsh",pid:1,windowId:"@1",active:true },
      { paneId: "%bad", left:0,top:0,width:80,height:24,cwd:"/x",command:"zsh",pid:2,windowId:"@1",active:false },
    ]);
    const model = new WorkspaceModel();
    const d = new Daemon({ gateway: gw, model, now: () => 100_000, makeSensor: (id) =>
      id.paneId === "%bad"
        ? ({ kind: "terminal", observe: async () => { throw new Error("boom"); }, teardown: async () => {} } as Sensor)
        : new Busy(id),
    });
    await d.tickOnce();
    const panes = model.snapshot().panes;
    expect(panes.find((p) => p.identity.paneId === "%good")!.state).toBe("working");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/gmux-invariants.test.ts`
Expected: The first test may FAIL if `tickOnce` does not already swallow a `listPanes` throw — fix `Daemon.tickOnce` to wrap the `registry.diff()` call in a try/catch that returns early on error (the loop's own catch also guards, but the invariant deserves a direct guarantee). Second test should PASS given Task 11's per-sensor try/catch.

- [ ] **Step 3: Implement any fix** — wrap the diff in `Daemon.tickOnce`:

```ts
    let diff;
    try { diff = await this.registry.diff(); } catch { return; } // tmux hiccup: idle this tick
    const { present, vanished } = diff;
```

- [ ] **Step 4: Run tests + full suite**

Run: `npx vitest run tests/gmux-invariants.test.ts && npm test`
Expected: PASS across the board.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.ts tests/gmux-invariants.test.ts
git commit -m "test(gmux): lock the fast-path-survives invariants; guard tmux hiccups"
```

---

### Task 30: Docs + `gmux daemon` autostart wiring

> **SCOPE EXPANSION (user request, 2026-08-11):** Beyond `docs/gmux.md`, this task must **refresh `README.md` so gmux is the headline happy path** ("giga multiplexing"): start the daemon → always-on border labels → `ctrl+g` cockpit → memory guardian; glance, don't check each pane. Include **rendered examples as text "screenshots"** produced from the REAL pure renderers (`renderCockpit` from `cli/gmux-render.ts` and `snapshotLabel`/`PANE_BORDER_FORMAT` from `cli/tmux-label.ts`) in fenced code blocks, plus clearly-marked slots (`<!-- screenshot: ... -->`) where real PNGs can be dropped later. **Fold in the old list-view rather than deprecating it:** present the picker / `gmux ls` / `ctrl+shift+g` as the complementary **"browse & resume any session across time"** lane, distinct from the cockpit's **"what's happening right now across live panes"** lane (now vs history — same data model, different question). Keep `ctrl+shift+g` → picker and `gmux` (default) → picker working. The README should make a first-time reader reach for `gmux daemon` + `ctrl+g` first, and discover the picker as the history/resume tool.


Document gmux (README section or `docs/gmux.md`), and make `gmux tmux install` optionally start the daemon (so borders/cockpit have a model). Keep autostart opt-in and idempotent (lock prevents doubles).

**Files:**
- Create: `docs/gmux.md`
- Modify: `src/cli/commands/tmux.ts` (after install, offer/emit a line that runs `gmux daemon` detached), `README.md` (link to gmux docs)
- Test: `tests/gmux-docs.test.ts` (asserts the tmux bindings block references `gmux cockpit` and that a daemon-start helper exists)

**Interfaces:**
- Consumes: existing `bindingsBlock()` in `tmux.ts`.
- Produces: `bindingsBlock()` now binds `C-g` → `gmux cockpit`; a documented `gmux daemon` start step. `docs/gmux.md` covers the two-layer model, the guardian's one action + consent, and memory-attribution caveats (RSS double-count, unattributed, hostPressure ≠ sum).

- [ ] **Step 1: Write the failing test**

```ts
// tests/gmux-docs.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("gmux docs + bindings", () => {
  it("ships a gmux doc covering the guardian consent and memory caveats", () => {
    expect(existsSync("docs/gmux.md")).toBe(true);
    const doc = readFileSync("docs/gmux.md", "utf8");
    expect(doc).toMatch(/guardian/i);
    expect(doc).toMatch(/unattributed/i);
    expect(doc).toMatch(/consent|disclose/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmux-docs.test.ts`
Expected: FAIL — `docs/gmux.md` does not exist.

- [ ] **Step 3: Write minimal implementation**

Write `docs/gmux.md` covering: the core job (lower the attention tax), the two-layer signal (instant vs semantic), the daemon/model/surfaces architecture, the guardian's single action with explicit consent at `gmux setup`, and the three memory caveats verbatim from the spec (RSS double-counts shared pages → ranking not totals; detached/containerized children show as `unattributed`; `hostPressure` ≠ sum of panes). Update `bindingsBlock()` in `tmux.ts` so `C-g` runs `gmux cockpit`, and add a documented `gmux daemon` start line. Link from `README.md`.

- [ ] **Step 4: Run test + full suite + typecheck + build**

Run: `npx vitest run tests/gmux-docs.test.ts && npm test && npm run check:types && npm run build`
Expected: PASS, clean typecheck, successful build.

- [ ] **Step 5: Commit**

```bash
git add docs/gmux.md README.md src/cli/commands/tmux.ts tests/gmux-docs.test.ts
git commit -m "docs(gmux): user guide + ctrl+g cockpit binding + daemon autostart note"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Two-layer sensing (instant + semantic): Tasks 5, 11 (instant) + 15, 16, 17 (semantic). ✓
- Governing invariant (fast path survives LLM/tmux): Tasks 16 (hung provider), 17 (off-tick enqueue), 29 (gateway throw, sensor throw). ✓
- Workspace daemon + single model: Tasks 8, 11, 12. ✓
- tmux gateway (sole talker, master seam): Tasks 3, 4. ✓
- Pane registry (stable identity, reuse pane-links/tmux-resolve/fingerprint): Task 6. ✓
- Sensors (agent + terminal, uniform observation): Task 7. ✓
- State classifier: Task 5. ✓
- Resource monitor (perPaneRss/hostPressure/unattributed): Tasks 20, 21. ✓
- Semantic summarizer (change-gated, debounced, reuse summarize/distill): Tasks 15, 16. ✓
- Workspace model (per-pane + workspace fields, change events): Task 8. ✓
- Guardian (policy, threshold, cooldown, hysteresis, no-target, culprit, logged): Tasks 22, 23, 24. ✓
- Daemon (cadence, lifecycle, socket + snapshot): Tasks 9, 11, 12. ✓
- Render surfaces (borders + cockpit, sense nothing): Tasks 13, 18, 19, 25. ✓
- Config (`gmux setup` disclosure): Task 24. ✓
- Memory attribution (subtree walk, two signals, caveats): Tasks 20, 21, 25, 30 (caveats documented). ✓
- Error handling & edge cases: Tasks 26 (log growth), 27 (cost/prioritization), 28 (staleness/socket down), 29 (crash/vanish/throw invariants). ✓
- MVP phasing (0–3): mapped to the four plan phases. ✓
- Testing strategy (fake gateway, pure classifiers/monitor/guardian, LLM mocked-to-hang, sensors over fixtures, model diff/version): Tasks 4, 5, 20, 21, 22, 16, 7, 8. ✓

**Deferred (correctly not built):** Approach C (own the runtime, auto-layout, cgroup isolation), escalation ladder, CPU signal, public daemon API — all left out per spec.

**Type consistency:** `TmuxGateway` verbs (`listPanes`/`capture`/`startPipe`/`stopPipe`/`send`/`setOption`) are consistent across Tasks 4, 13, 23. `WorkspaceModel` method names (`upsertIdentity`/`applyState`/`applySemantics`/`applyResources`/`setHostPressure`/`logGuardian`/`markGone`/`evictGone`/`snapshot`) are used identically in Tasks 8, 11, 17, 23. `PaneEntry`/`PaneIdentity`/`Observation`/`PaneSemantics`/`PaneResources`/`HostPressure`/`GuardianLogEntry`/`WorkspaceSnapshot` are defined once (Task 1) and imported everywhere. `classifyState(obs, now)` signature is stable (Tasks 5, 11). `SemanticWorker.enqueue(entry, obs, now)` / `drain()` stable (Tasks 16, 17, 27). `Guardian.decide(host, panes, now)` stable (Tasks 22, 23).

**Known integration follow-ups (not placeholders — real wiring called out in-task):** real agent-pane detection for the guardian uses the registry's resolved `harness && sessionId` (Task 23 test uses `resolveAgents` only to avoid a link fixture); `readMacMemory`/`readLinuxMemory` and `AgentSensor`'s transcript-signal helpers are platform/format code covered by injected fakes + a manual smoke; the label prompt reuses `summarizeSession` fields for MVP (Task 16). Each is described concretely where it lands.
