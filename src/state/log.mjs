// Reading side of the event log. The hot path (src/hooks/post-tool-use.mjs) only ever
// APPENDS; every reader — the cold detection pass, the inspector CLI — parses through
// here, so JSONL loading and malformed-line handling are defined in exactly one place.

import { readFileSync } from "node:fs";

/**
 * @typedef {object} LogLoad
 * @property {object[]} records   Parsed records, in file order.
 * @property {number} malformed   Count of non-empty lines that failed to parse.
 * @property {boolean} missing    True if the log file does not exist yet.
 */

/**
 * Load and parse `log.jsonl`, tolerating a missing file and skipping (and counting)
 * any unparseable lines rather than throwing on them. A single corrupt line must
 * never blind the reader to the rest of the stream.
 * @param {string} logPath
 * @returns {LogLoad}
 */
export function readLog(logPath) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return { records: [], malformed: 0, missing: true };
  }

  const records = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed, missing: false };
}
