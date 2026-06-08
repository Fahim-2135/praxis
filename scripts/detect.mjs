#!/usr/bin/env node
// Calibration CLI for the promotion engine (`npm run detect`).
//
// Stage 2's job is not just to run the gates but to TUNE them against real logged
// behavior (PRAXIS.md §6, §10). This command runs detection over the current log and
// prints both the survivors (candidates) and the near-misses (dropped patterns, with
// the exact gate each died at) — so you can see *why* a pattern was rejected and decide
// whether a threshold is right or merely a guess that reality just disproved.
//
// Read-only by default (writes nothing); pass `--write` to persist candidates.json and
// advance the cursor, exactly as the cold-path hook does.

import { resolveProjectDir, paths } from "../src/state/paths.mjs";
import { readLog } from "../src/state/log.mjs";
import { runDetection } from "../src/cold/run.mjs";

const write = process.argv.includes("--write");
const root = resolveProjectDir();
const p = paths(root);

const { records, missing } = readLog(p.log);
if (missing || records.length === 0) {
  console.log(`No events logged yet (${p.log}).`);
  console.log("Use Claude Code normally with the hook active, then run this again.");
  process.exit(0);
}

// `force` so calibration always analyzes regardless of the cursor; `dryRun` unless --write.
const result = runDetection(root, { force: true, dryRun: !write });

const { events, sessions } = result.analyzed;
console.log(`Praxis detection — ${events} events across ${sessions} session(s)`);
console.log(
  `Thresholds: occurrences>=${result.thresholds.minOccurrences}, ` +
    `sessions>=${result.thresholds.minSessions}, ` +
    `consistency>=${result.thresholds.minConsistency}, ` +
    `recency<=${result.thresholds.recencyDays}d, ` +
    `stale>${result.thresholds.staleDays}d`,
);

/** Format one pattern's evidence as a compact, aligned suffix. */
function evidence(e) {
  return `(n=${e.count}, sessions=${e.sessions}, consistency=${e.consistency}, last=${e.lastSeen ?? "—"})`;
}

console.log(`\nCandidates — cleared all gates (${result.candidates.length}):`);
if (result.candidates.length === 0) {
  console.log("  none");
} else {
  for (const c of result.candidates) {
    console.log(`  [${c.tier}] ${c.action} after ${c.preceding_event}  ${evidence(c.evidence)}`);
  }
}

console.log(`\nDropped — failed a gate (${result.dropped.length}, strongest first):`);
for (const d of result.dropped) {
  console.log(
    `  ${d.action} after ${d.preceding_event}  ✗ ${d.failedGate}  ${evidence(d.evidence)}`,
  );
}

// Self-pruning (PRAXIS.md §8): active rules whose behavior has gone stale and that the next
// `praxis review` would offer to retire. Empty unless some rules have already been approved.
const retirements = result.retirements ?? [];
console.log(`\nStale active rules — flagged for retirement (${retirements.length}):`);
if (retirements.length === 0) {
  console.log("  none");
} else {
  for (const r of retirements) {
    const last = r.lastSeen ? `last=${r.lastSeen} (${r.daysSinceLastSeen}d ago)` : "never seen";
    console.log(`  [${r.tier}] ${r.action} after ${r.preceding_event}  ${last}`);
  }
}

if (write) {
  console.log(`\nWrote ${p.candidates} and advanced the cursor to ${result.cursor}.`);
} else {
  console.log("\n(dry run — nothing written; pass --write to persist candidates.json)");
}
