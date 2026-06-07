// Pure aggregation over log records. No I/O — it takes parsed records and returns
// a summary, so it is trivially testable and reusable. The inspector CLI
// (`scripts/inspect-log.mjs`) does the file reading and printing around it.

/**
 * @typedef {object} LogRecord
 * @property {string} action
 * @property {string} [preceding_event]
 * @property {string} [session_id]
 * @property {string} [raw]
 */

/**
 * @typedef {object} Summary
 * @property {number} total                      Total events.
 * @property {number} sessions                   Distinct session count.
 * @property {Array<[string, number]>} byAction  `[action, count]`, most frequent first.
 * @property {Array<[string, number]>} bySession `[session_id, count]`, most active first.
 * @property {Array<[string, number]>} unmatched `[raw, count]` for unmatched events, most frequent first.
 */

/** Increment a counter in a Map. */
function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Map entries as an array sorted by count descending, then key ascending. */
function ranked(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * Aggregate raw log records into a summary.
 * @param {LogRecord[]} records
 * @returns {Summary}
 */
export function summarize(records) {
  const byAction = new Map();
  const bySession = new Map();
  const unmatched = new Map();

  for (const record of records) {
    bump(byAction, record.action);
    bump(bySession, record.session_id ?? "unknown");
    if (record.action === "unmatched" && record.raw) bump(unmatched, record.raw);
  }

  return {
    total: records.length,
    sessions: bySession.size,
    byAction: ranked(byAction),
    bySession: ranked(bySession),
    unmatched: ranked(unmatched),
  };
}
