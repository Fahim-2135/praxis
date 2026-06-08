// Cold-path detection runner: the I/O shell around the pure engine (src/detect.mjs).
//
// Reads the log + cursor and, only if new events have arrived since the last pass, runs
// the five gates over the FULL log, writes `candidates.json`, and advances the cursor.
//
// Why analyze the whole log, not just the new tail: Gate 2 (cross-session spread) and
// Gate 3 (the consistency denominator) are counts over ALL history — a pattern's
// significance is a property of the whole stream, not of the events added since last
// time. So the cursor's job is NOT to slice the input but to make a pass IDEMPOTENT: if
// nothing new arrived, do nothing. That is what lets the two cold triggers — SessionEnd
// (best effort) and the next SessionStart (survives hard closes) — both fire safely.
// Whichever runs first does the work; the second sees no new events and no-ops
// (PRAXIS.md §1, §3).

import { writeFileSync, readFileSync } from "node:fs";
import { paths } from "../state/paths.mjs";
import { readLog } from "../state/log.mjs";
import { detect, patternId } from "../detect.mjs";

/**
 * Read the cursor (count of records already analyzed). Missing or malformed => 0.
 * @param {ReturnType<typeof paths>} p
 * @returns {number}
 */
function readCursor(p) {
  try {
    const n = Number.parseInt(readFileSync(p.lastProcessed, "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Load the rejection memory as a set of pattern ids. Forward-compatible: Stage 3 writes
 * `rejected.json`; until then the file is absent and nothing is filtered. Reading it now
 * keeps detection correct the moment rejections exist — a rejected pattern must never be
 * re-proposed (PRAXIS.md §9).
 * @param {ReturnType<typeof paths>} p
 * @returns {Set<string>}
 */
function readRejected(p) {
  try {
    const data = JSON.parse(readFileSync(p.rejected, "utf8"));
    const list = Array.isArray(data) ? data : (data?.rejected ?? []);
    return new Set(list.map((r) => patternId(r.action, r.preceding_event)));
  } catch {
    return new Set();
  }
}

/**
 * Run one cold-path detection pass.
 * @param {string} root  Project root.
 * @param {{ now?: string | number | Date, force?: boolean, dryRun?: boolean }} [options]
 *   - `force`  analyze even if no new events (calibration tooling).
 *   - `dryRun` compute but write nothing (calibration tooling).
 * @returns {{ ran: boolean, reason?: string, analyzed: { events: number, sessions?: number },
 *   thresholds?: object, candidates?: object[], dropped?: object[], cursor: number }}
 */
export function runDetection(root, options = {}) {
  const p = paths(root);
  const { records } = readLog(p.log);
  const cursor = readCursor(p);

  if (records.length <= cursor && !options.force) {
    return { ran: false, reason: "no new events", analyzed: { events: records.length }, cursor };
  }

  const result = detect(records, { now: options.now });
  const rejected = readRejected(p);
  const candidates = result.candidates.filter(
    (c) => !rejected.has(patternId(c.action, c.preceding_event)),
  );

  if (!options.dryRun) {
    const output = {
      generatedAt: (options.now ? new Date(options.now) : new Date()).toISOString(),
      thresholds: result.thresholds,
      analyzed: result.analyzed,
      candidates,
    };
    writeFileSync(p.candidates, JSON.stringify(output, null, 2) + "\n");
    writeFileSync(p.lastProcessed, `${records.length}\n`);
  }

  return {
    ran: true,
    analyzed: result.analyzed,
    thresholds: result.thresholds,
    candidates,
    dropped: result.dropped,
    cursor: records.length,
  };
}
