/** Resolve a user-typed id — usually a short prefix — to exactly one session. */

import { AmbiguousSessionError, SessionNotFoundError } from "../core/errors.js";
import type { SessionRecord } from "../core/types.js";

export function resolveSession(records: readonly SessionRecord[], id: string): SessionRecord {
  const needle = id.trim().toLowerCase();
  if (needle === "") throw new SessionNotFoundError(id);

  const exact = records.find((r) => r.sessionId.toLowerCase() === needle);
  if (exact) return exact;

  const matches = records.filter((r) => r.sessionId.toLowerCase().startsWith(needle));
  if (matches.length === 0) throw new SessionNotFoundError(id);
  if (matches.length > 1) {
    throw new AmbiguousSessionError(
      id,
      matches.map((m) => m.sessionId),
    );
  }
  return matches[0]!;
}
