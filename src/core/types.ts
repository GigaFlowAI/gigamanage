/**
 * The shared vocabulary of gigamanage. Every layer speaks these types.
 *
 * `core` imports nothing internal — see docs/architecture.md for the layer rule.
 */

/** Stable identifier for a harness, e.g. "claude-code" or "codex". */
export type HarnessId = string;

/** Schema version for every `--json` payload. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

/** A session file located on disk, before it has been parsed. */
export interface SessionRef {
  harness: HarnessId;
  sessionId: string;
  filePath: string;
  /** Modification time in ms. Half of the index cache key. */
  mtimeMs: number;
  /** Size in bytes. The other half of the cache key. */
  size: number;
}

/** A pull request a session produced. */
export interface PrLink {
  number: number;
  url: string;
  repository?: string;
}

/**
 * Hard facts about one session, extracted by an adapter.
 *
 * Everything here is free: no model call, no network. `title` comes from the
 * harness and describes where the session STARTED — prefer a SessionSummary
 * when deciding what a session ended up being about.
 */
export interface SessionRecord {
  harness: HarnessId;
  sessionId: string;
  filePath: string;
  /** Working directory the session ran in. Needed to resume in the right place. */
  cwd: string | null;
  /** Basename of `cwd`, for display. */
  project: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string;
  messageCount: number;
  userPromptCount: number;
  /** Harness-provided title. Reflects the START of the session; often stale. */
  title: string | null;
  /** The last thing the human actually said. The single most useful hard fact. */
  lastUserPrompt: string | null;
  /** Recent human turns, oldest first. Feeds the summarizer. */
  recentUserPrompts: string[];
  /** Files the agent edited or wrote. */
  filesTouched: string[];
  prLinks: PrLink[];
  /** Tail of the final assistant message. Feeds the summarizer. */
  lastAssistantText: string | null;
  /** Most recent failing tool call, if any. Strong signal of unfinished work. */
  lastToolFailure: string | null;
  /** True when the session was interrupted or ended on a failure. */
  endedMidTask: boolean;
  /** Subagent transcript rather than a top-level conversation. */
  isSidechain: boolean;
  /**
   * A non-interactive run (`claude -p`, `codex exec`) rather than a conversation
   * someone sat through. Hidden by default: these are automation, not work you
   * would context-switch back into — and gigamanage's own summarizer creates
   * them, so listing them would make the tool pollute its own output.
   */
  isAutomated: boolean;
}

/**
 * A written summary of where a session LANDED.
 *
 * Generated from the tail of the transcript, never the head — that is the
 * property that makes it describe the latest work instead of the opening prompt.
 */
export interface SessionSummary {
  harness: HarnessId;
  sessionId: string;
  /** Hash of the distilled input. Changes when the session changes. */
  sourceHash: string;
  generatedAt: string;
  /** Provider that wrote it, e.g. "claude -p". */
  provider: string;
  /** One line: the state the work is in now. */
  headline: string;
  /** What actually got done. */
  landed: string;
  /** What is unresolved or blocked. */
  open: string;
  /** The concrete next action. */
  nextStep: string;
}

/** A session paired with its summary, if one has been generated. */
export interface SessionView {
  record: SessionRecord;
  summary: SessionSummary | null;
}

/** The distilled tail of a session, as handed to a summary provider. */
export interface SummaryInput {
  /**
   * Bumped when the prompt changes shape. Part of the hash, and therefore of
   * the cache key: a prompt edit must invalidate summaries written by the old
   * prompt, or the change never reaches anything already on disk.
   */
  promptVersion: number;
  harness: HarnessId;
  sessionId: string;
  project: string | null;
  gitBranch: string | null;
  title: string | null;
  recentUserPrompts: string[];
  lastAssistantText: string | null;
  filesTouched: string[];
  lastToolFailure: string | null;
  endedMidTask: boolean;
  /** Stable hash of the above. The summary cache key. */
  hash: string;
}

/** The four fields a summary provider must return. */
export interface SummaryFields {
  headline: string;
  landed: string;
  open: string;
  nextStep: string;
}

/**
 * A model CLI gigamanage may call.
 *
 * `command` is argv for a one-shot call: prompt on stdin, text on stdout. That
 * is the whole contract, and it is why gigamanage depends on no vendor SDK.
 */
export interface ProviderChoice {
  /** Catalog id ("claude-code", "codex"), or "custom" for a hand-written command. */
  id: string;
  command: string[];
}

/** Config schema version. Bump when `GmConfig` changes shape incompatibly. */
export const CONFIG_VERSION = 1;

/**
 * The choices a human made, persisted.
 *
 * Config is NOT cache. Wiping `~/.cache/gigamanage` must cost you summaries,
 * never your provider choice — which is why this lives under the config dir and
 * is keyed by nothing.
 */
export interface GmConfig {
  version: number;
  /**
   * null means "make no model calls". A supported answer, not a missing value —
   * `gm setup` offers it, and it is how you decline the token spend outright.
   */
  provider: ProviderChoice | null;
  /** Keep the recent window summarized in the background. */
  autoSummarize: boolean;
}

/** One exchange in an `gm ask` conversation. */
export interface AskTurn {
  question: string;
  answer: string;
}

/** Everything `gm ask` knows about your sessions, before a question is asked. */
export interface AskContext {
  /** The sessions the picker/list had loaded. Summaries where they exist. */
  sessions: SessionView[];
  /** The session the user was looking at when they hit ctrl-o, if any. */
  focusId: string | null;
}

/**
 * Pluggable chat provider. Mocked in tests; never called for real by them.
 *
 * Deliberately the same shape of contract as `SummaryProvider`: a prompt goes
 * in, text comes out. The difference is that the CLI behind it is invoked with
 * permission to run `gm grep`, so the tool loop belongs to the harness rather
 * than to us.
 */
export interface AskProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  ask(prompt: string): Promise<string>;
}

/** Pluggable summarizer. Mocked in tests; never called for real by them. */
export interface SummaryProvider {
  /** Human-readable name, recorded on the summary. */
  readonly name: string;
  /** True when the underlying CLI is actually installed. */
  isAvailable(): Promise<boolean>;
  generate(input: SummaryInput): Promise<SummaryFields>;
}

/** One hit from a full-text search, resolved back to its session. */
export interface SearchHit {
  session: SessionRecord;
  matchCount: number;
  /** Representative matching lines, already trimmed for display. */
  snippets: string[];
}

/** Filters shared by `ls` and the picker. */
export interface ListFilters {
  harness?: string;
  project?: string;
  branch?: string;
  /** ISO timestamp; sessions older than this are dropped. */
  since?: string;
  limit?: number;
  includeSidechains?: boolean;
  includeAutomated?: boolean;
}
