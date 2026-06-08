// Pure "what Praxis has learned about you" model (the `praxis status` view).
//
// This is the synthesis layer: it folds the raw log, the live rules, the pending candidates,
// the stale flags, and the engine's near-misses into one human-facing workflow profile. Like
// every core module it holds NO I/O — the CLI (bin/praxis.mjs) reads the files and renders the
// model this returns — so the profile is computed deterministically and unit-tested without a
// terminal. It reuses the existing pure cores (`summarize`, `detect`) rather than re-deriving
// anything, so status can never disagree with the engine it reports on.

import { summarize } from "../report.mjs";
import { detect } from "../detect.mjs";

const MS_PER_DAY = 86_400_000;

// How many gates a dropped pattern cleared before failing, by the gate it failed at (the gates
// run in this order in src/detect.mjs). Higher = closer to becoming a rule.
const GATES_CLEARED = { frequency: 0, cross_session: 1, consistency: 2, recency: 3 };

/**
 * A pattern is "almost a rule" — worth surfacing as one Praxis is watching — if it is actionable
 * (not `unmatched`) and either nearly frequent enough, or already frequent and failing a later
 * gate. A lone one-off is not interesting; a habit one session away from qualifying is.
 * @param {{ action: string, failedGate: string, evidence: { count: number } }} dropped
 * @param {typeof import("../detect.mjs").THRESHOLDS} t
 */
function isAlmost(dropped, t) {
  if (dropped.action === "unmatched") return false;
  if (dropped.failedGate === "frequency") {
    return dropped.evidence.count >= 2 && dropped.evidence.count >= t.minOccurrences - 2;
  }
  return dropped.failedGate in GATES_CLEARED;
}

/**
 * Human sentence for exactly what a near-miss still needs to become a candidate.
 * @param {{ failedGate: string, evidence: object }} d
 * @param {typeof import("../detect.mjs").THRESHOLDS} t
 * @returns {string}
 */
function describeGap(d, t) {
  const e = d.evidence;
  switch (d.failedGate) {
    case "frequency": {
      const need = t.minOccurrences - e.count;
      return `seen ${e.count}× — ${need} more occurrence${need === 1 ? "" : "s"} to qualify`;
    }
    case "cross_session": {
      const need = t.minSessions - e.sessions;
      return `seen ${e.count}× but in only ${e.sessions} session${e.sessions === 1 ? "" : "s"} — ${need} more session${need === 1 ? "" : "s"} to qualify`;
    }
    case "consistency":
      return `follows ${Math.round(e.consistency * 100)}% of the time — needs ${Math.round(t.minConsistency * 100)}%`;
    case "recency":
      return `frequent enough, but last seen ${e.lastSeen ?? "—"} — needs activity within ${t.recencyDays}d`;
    default:
      return "";
  }
}

/**
 * @typedef {object} StatusModel
 * @property {{ events: number, sessions: number, firstSeen: string|null, lastSeen: string|null,
 *   spanDays: number, unmatched: number }} observed
 * @property {Array<{ action: string, count: number }>} topHabits
 * @property {object[]} activeRules
 * @property {object[]} candidates
 * @property {object[]} retirements
 * @property {Array<{ action: string, preceding_event: string, failedGate: string,
 *   evidence: object, gap: string }>} almostRules
 */

/**
 * Build the status model from the log and the review state.
 * @param {object[]} records                                              The full log.
 * @param {{ candidates?: object[], active?: object[], retirements?: object[] }} [state]
 * @param {{ now?: string | number | Date }} [options]
 * @returns {StatusModel}
 */
export function buildStatus(records, state = {}, options = {}) {
  const { candidates = [], active = [], retirements = [] } = state;
  const summary = summarize(records);

  const stamps = records
    .map((r) => r.timestamp)
    .filter(Boolean)
    .sort();
  const firstSeen = stamps[0] ?? null;
  const lastSeen = stamps[stamps.length - 1] ?? null;
  const spanDays =
    firstSeen && lastSeen
      ? Math.max(1, Math.round((Date.parse(lastSeen) - Date.parse(firstSeen)) / MS_PER_DAY) + 1)
      : 0;

  const topHabits = summary.byAction
    .filter(([action]) => action !== "unmatched")
    .slice(0, 5)
    .map(([action, count]) => ({ action, count }));

  const { dropped, thresholds } = detect(records, { now: options.now });
  const almostRules = dropped
    .filter((d) => isAlmost(d, thresholds))
    .sort(
      (a, b) =>
        GATES_CLEARED[b.failedGate] - GATES_CLEARED[a.failedGate] ||
        b.evidence.count - a.evidence.count,
    )
    .slice(0, 5)
    .map((d) => ({
      action: d.action,
      preceding_event: d.preceding_event,
      failedGate: d.failedGate,
      evidence: d.evidence,
      gap: describeGap(d, thresholds),
    }));

  return {
    observed: {
      events: summary.total,
      sessions: summary.sessions,
      firstSeen,
      lastSeen,
      spanDays,
      unmatched: summary.unmatched.length,
    },
    topHabits,
    activeRules: active,
    candidates,
    retirements,
    almostRules,
  };
}
