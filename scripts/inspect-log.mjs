#!/usr/bin/env node
// Read-only inspector for `.praxis/log.jsonl`. A companion for verifying the
// Stage 1 gate ("is the log clean and are the intents correct?"): it summarizes
// what has been logged so far and surfaces the unmatched pile that tells you which
// normalization rules to add next. It never writes anything.

import { resolveProjectDir, paths } from "../src/state/paths.mjs";
import { readLog } from "../src/state/log.mjs";
import { summarize } from "../src/report.mjs";

/** Render `[key, count]` rows with right-aligned counts. */
function printRows(rows, limit = Infinity) {
  for (const [key, count] of rows.slice(0, limit)) {
    console.log(`  ${String(count).padStart(6)}  ${key}`);
  }
}

const p = paths(resolveProjectDir());
const { records, malformed, missing } = readLog(p.log);

if (missing || records.length === 0) {
  console.log(`No events logged yet (${p.log}).`);
  console.log("Use Claude Code normally with the hook active, then run this again.");
  process.exit(0);
}

const summary = summarize(records);

console.log(`Praxis log — ${summary.total} events across ${summary.sessions} session(s)`);
if (malformed) console.log(`(${malformed} malformed line(s) skipped)`);

console.log("\nActions (most frequent first):");
printRows(summary.byAction);

if (summary.unmatched.length) {
  console.log("\nUnmatched — candidates for new normalization rules:");
  printRows(summary.unmatched, 20);
}
