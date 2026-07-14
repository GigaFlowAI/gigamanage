/** Pair session records with their cached summaries. */

import type { ListFilters, SessionRecord, SessionView } from "../core/types.js";
import { filterRecords, refreshIndex } from "./index-store.js";
import { readSummary } from "./summarize.js";

export async function loadRecords(filters: ListFilters = {}): Promise<SessionRecord[]> {
  const { records } = await refreshIndex();
  return filterRecords(records, filters);
}

export async function attachSummaries(records: readonly SessionRecord[]): Promise<SessionView[]> {
  return Promise.all(
    records.map(async (record) => ({ record, summary: await readSummary(record) })),
  );
}

export async function loadViews(filters: ListFilters = {}): Promise<SessionView[]> {
  return attachSummaries(await loadRecords(filters));
}
