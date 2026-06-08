#!/usr/bin/env node
// PRAXIS hot path — the PostToolUse hook.
//
// Contract (PRAXIS.md §1, §9, §12): read one event from stdin, append exactly one
// normalized record to `log.jsonl`, advance the per-session marker, exit 0.
//   - No model call, no network.
//   - No locking: a single line-sized append uses O_APPEND, which is atomic across
//     concurrent sessions for writes this small, so no lock is needed.
//   - No read-modify-write of the growing log. The only state read is a tiny,
//     fixed-size per-session marker file.
// Any failure is swallowed to `errors.log` and the process still exits 0 — the
// logger must never disturb Claude Code's hot path.

import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveProjectDir, paths } from "../state/paths.mjs";
import { normalize } from "../normalize.mjs";
import { readStdin, clean, noteError } from "./io.mjs";

/**
 * Append one normalized event record and advance the session marker.
 * @param {object} event  Parsed PostToolUse payload.
 */
function record(event) {
  const p = paths(resolveProjectDir(event));
  mkdirSync(p.sessions, { recursive: true }); // also ensures `.praxis/`

  // `preceding_event`: the previous action in THIS session. Absent marker => this
  // is the session's first observed event.
  const markerPath = p.marker(event.session_id);
  let preceding = "session_start";
  try {
    const prev = readFileSync(markerPath, "utf8").trim();
    if (prev) preceding = prev;
  } catch {
    /* no marker yet — first event of the session */
  }

  const norm = normalize(event);
  const line = {
    action: norm.action,
    preceding_event: preceding,
    timestamp: new Date().toISOString(),
    session_id: String(event.session_id ?? "unknown"),
  };
  if (norm.raw !== undefined) line.raw = norm.raw; // only on `unmatched`

  appendFileSync(p.log, JSON.stringify(line) + "\n");
  writeFileSync(markerPath, norm.action); // next event reads this as `preceding_event`
}

const raw = clean(await readStdin());
if (raw) {
  try {
    record(JSON.parse(raw));
  } catch (err) {
    noteError(err);
  }
}
process.exit(0);
