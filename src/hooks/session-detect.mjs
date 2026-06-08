#!/usr/bin/env node
// Cold path trigger — the SessionStart / SessionEnd hook.
//
// Fires at session boundaries (NOT on every tool call — that is the hot path). Runs the
// detection pass that turns logged behavior into candidate rules. Like the hot path it
// is defensive: any failure is swallowed to `errors.log` and it exits 0, so detection
// can never block a session from starting or ending.
//
// SOURCE FILTERING (PRAXIS.md §2, §12): SessionStart fires on `startup`, `resume`,
// `clear` AND `compact`. Only startup/resume are real session boundaries; clear and
// compact happen mid-work, and running detection then would interrupt active work. So
// we run only on startup/resume. SessionEnd carries no `source` and is always a valid
// (best-effort) trigger.

import { resolveProjectDir } from "../state/paths.mjs";
import { runDetection } from "../cold/run.mjs";
import { readStdin, clean, noteError } from "./io.mjs";

/**
 * Whether this event is a real cold-path trigger. SessionStart events carry a `source`
 * we must filter; SessionEnd has none and always runs.
 * @param {{ source?: string }} event
 * @returns {boolean}
 */
function shouldRun(event) {
  const source = event?.source;
  if (source === undefined || source === null) return true; // SessionEnd (best effort)
  return source === "startup" || source === "resume";
}

const raw = clean(await readStdin());
if (raw) {
  try {
    const event = JSON.parse(raw);
    if (shouldRun(event)) runDetection(resolveProjectDir(event));
  } catch (err) {
    noteError(err);
  }
}
process.exit(0);
