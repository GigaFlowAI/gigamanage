/**
 * Error taxonomy.
 *
 * Harness-engineering rule: an error message carries the fix inline. A user —
 * or an agent — should never have to guess the next command. `fix` is printed
 * directly beneath the message and included in `--json` output.
 */

export class GigamanageError extends Error {
  /** The exact command or action that resolves this error. */
  readonly fix: string | undefined;
  /** Process exit code. */
  readonly exitCode: number;

  constructor(message: string, options: { fix?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "GigamanageError";
    this.fix = options.fix;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** No session matched the given id or prefix. */
export class SessionNotFoundError extends GigamanageError {
  constructor(id: string) {
    super(`No session matches "${id}".`, {
      fix: "Run `gm ls` to see recent sessions, or `gm index --rebuild` if the cache is stale.",
      exitCode: 4,
    });
    this.name = "SessionNotFoundError";
  }
}

/** A prefix matched more than one session. */
export class AmbiguousSessionError extends GigamanageError {
  constructor(id: string, matches: string[]) {
    const shown = matches.slice(0, 5).join(", ");
    super(`"${id}" matches ${matches.length} sessions: ${shown}${matches.length > 5 ? ", …" : ""}`, {
      fix: "Pass more characters of the session id to disambiguate.",
      exitCode: 5,
    });
    this.name = "AmbiguousSessionError";
  }
}

/** A required external binary is missing. */
export class MissingDependencyError extends GigamanageError {
  constructor(binary: string, fix: string) {
    super(`Required command "${binary}" was not found on PATH.`, { fix, exitCode: 6 });
    this.name = "MissingDependencyError";
  }
}

/** A summary provider returned something unusable. */
export class SummaryProviderError extends GigamanageError {
  constructor(provider: string, detail: string) {
    super(`Summary provider "${provider}" failed: ${detail}`, {
      fix: "Check the provider CLI works standalone, or set GIGAMANAGE_SUMMARY_CMD to a different one.",
      exitCode: 7,
    });
    this.name = "SummaryProviderError";
  }
}
