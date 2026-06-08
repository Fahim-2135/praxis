// The promotion engine — Praxis's "brain" (PRAXIS.md §6).
//
// A *pattern* is an (action, preceding_event) pairing: not "he pushes" but "he pushes
// after a task completes." A pattern must clear five sequential gates before it becomes
// a candidate the user can approve. The first four are kill-or-pass filters; the fifth
// only classifies reversibility — it never rejects.
//
// Everything here is PURE ARITHMETIC over the local log: no model call, no network, no
// cost (PRAXIS.md §6, §12). The build order names this a "detection subagent," but a
// non-deterministic judge would make the same log yield different rules on different
// runs — the opposite of the inspectability the whole system promises. So detection is
// deliberately deterministic. This module does no I/O either; it takes parsed records
// and returns a verdict, which keeps it trivially testable. The cold-path runner
// (src/cold/run.mjs) does the reading and writing around it.

/**
 * Gate thresholds. STARTING GUESSES, to be calibrated against real logged behavior and
 * never tuned against imagined data (PRAXIS.md §6, §12). They live in one frozen table
 * so a calibration pass is a one-line change with an obvious blast radius.
 */
export const THRESHOLDS = Object.freeze({
  minOccurrences: 5, // Gate 1 — frequency: pattern seen at least this many times
  minSessions: 3, // Gate 2 — cross-session spread: across at least this many sessions
  minConsistency: 0.8, // Gate 3 — of all times the context occurred, action followed >= this
  recencyDays: 5, // Gate 4 — at least one occurrence within this many days
  staleDays: 14, // Self-pruning — an active rule unused this long is flagged for retirement
});

/**
 * Reversibility tier by action (Gate 5, PRAXIS.md §7). The tier does NOT reject a
 * pattern; it records how an approved rule is ALLOWED to behave later:
 *   - `safe`          reversible (tests, format, read, status) — may act with a soft confirm.
 *   - `consequential` recoverable (commit, push, add)         — acts only with explicit confirm.
 *   - `destructive`   irreversible (force-push, delete, send)  — never auto-acts; suggest only.
 *
 * Unknown actions default to `consequential`: restrictive enough never to act silently,
 * without permanently sidelining a pattern the way `destructive` would.
 * @type {Readonly<Record<string, "safe" | "consequential" | "destructive">>}
 */
const TIER_BY_ACTION = Object.freeze({
  // safe / reversible
  test_run: "safe",
  lint_run: "safe",
  format_run: "safe",
  build_run: "safe",
  file_read: "safe",
  file_search: "safe",
  list_dir: "safe",
  git_status: "safe",
  git_diff: "safe",
  git_log: "safe",
  web_fetch: "safe",
  web_search: "safe",
  todo_update: "safe",
  // consequential / recoverable
  git_commit: "consequential",
  git_push: "consequential",
  git_pull: "consequential",
  git_add: "consequential",
  git_checkout: "consequential",
  file_edit: "consequential",
  subagent_run: "consequential",
  // Destructive actions (force-push, rm, external send) are not yet emitted by the
  // normalizer — they collapse into git_push / unmatched today. The tier is wired here
  // for when rule discovery starts labelling them distinctly.
});

/**
 * Classify an action into a reversibility tier (Gate 5).
 * @param {string} action
 * @returns {"safe" | "consequential" | "destructive"}
 */
export function classifyReversibility(action) {
  return TIER_BY_ACTION[action] ?? "consequential";
}

/** Combine the two pattern fields into one map key. Action labels never contain `|`. */
export function patternId(action, preceding) {
  return `${action}|${preceding}`;
}

/**
 * Self-pruning: re-validate already-active rules against the recency horizon (PRAXIS.md §8).
 *
 * This is the inverse of Gate 4, applied to approved rules rather than candidates: a rule
 * whose behavior has not occurred within `staleDays` is flagged for retirement, so a reviewer
 * can prune it. A system that only ever adds rules accumulates dead weight and decays. A
 * deliberately LONGER horizon than Gate 4's `recencyDays` is used — promotion needs proof the
 * habit is current (5 days); retirement should tolerate a normal lull and fire only on genuine
 * abandonment (14 days), so an approved rule is not yanked the first quiet week.
 *
 * Pure arithmetic over the log, like the gates: no I/O, no model. A rule never seen in the log
 * (absent timestamp) is treated as stale — it has no evidence of recent use to keep it alive.
 *
 * @param {object[]} records                                   The full log.
 * @param {Array<{ action: string, preceding_event: string, tier?: string }>} activeRules
 * @param {{ now?: string | number | Date, staleDays?: number }} [options]
 * @returns {Array<{ action: string, preceding_event: string,
 *   tier: "safe" | "consequential" | "destructive",
 *   lastSeen: string | null, daysSinceLastSeen: number | null }>}
 */
export function findStaleRules(records, activeRules = [], options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const staleDays = options.staleDays ?? THRESHOLDS.staleDays;

  // Most-recent timestamp per pattern, in one pass over the log.
  const lastSeenById = new Map();
  for (const r of records) {
    if (!r.timestamp) continue;
    const id = patternId(r.action, r.preceding_event ?? "session_start");
    const prev = lastSeenById.get(id);
    if (!prev || r.timestamp > prev) lastSeenById.set(id, r.timestamp);
  }

  const stale = [];
  for (const rule of activeRules) {
    const lastSeen = lastSeenById.get(patternId(rule.action, rule.preceding_event)) ?? null;
    if (withinDays(lastSeen, now, staleDays)) continue; // still in use — keep
    const daysSinceLastSeen = lastSeen
      ? Math.floor((now.getTime() - Date.parse(lastSeen)) / 86_400_000)
      : null;
    stale.push({
      action: rule.action,
      preceding_event: rule.preceding_event,
      tier: rule.tier ?? classifyReversibility(rule.action),
      lastSeen,
      daysSinceLastSeen,
    });
  }
  return stale;
}

/** Round to two decimals for stable, human-readable evidence. */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Whether `timestamp` is within `days` of `now`. A future timestamp (clock skew) counts
 * as recent; an absent or unparseable timestamp does not.
 * @param {string | undefined} timestamp
 * @param {Date} now
 * @param {number} days
 * @returns {boolean}
 */
function withinDays(timestamp, now, days) {
  if (!timestamp) return false;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= days * 86_400_000;
}

/**
 * Evaluate one pattern group against the four kill-or-pass gates, in order. Returns the
 * evidence summary and the first gate it failed (`null` if it passed all four).
 * @param {{ action: string, preceding_event: string, hits: object[] }} group
 * @param {Map<string, number>} contextTotals  occurrences of each preceding_event value
 * @param {Date} now
 * @param {typeof THRESHOLDS} thresholds
 */
function evaluate(group, contextTotals, now, thresholds) {
  const { hits } = group;
  const count = hits.length;
  const sessions = new Set(hits.map((h) => h.session_id ?? "unknown")).size;

  // Gate 3 denominator: how many events followed this preceding_event at ALL (any
  // action). Counting the denominator — not just the hits — is what kills coincidence:
  // "pushed 5 times" means nothing if 50 things followed task_completed (PRAXIS.md §6).
  const contextTotal = contextTotals.get(group.preceding_event) ?? 0;
  const consistency = contextTotal === 0 ? 0 : count / contextTotal;

  const lastSeen = hits.reduce(
    (latest, h) => (h.timestamp && h.timestamp > latest ? h.timestamp : latest),
    "",
  );
  const recent = hits.some((h) => withinDays(h.timestamp, now, thresholds.recencyDays));

  const summary = {
    count,
    sessions,
    consistency: round2(consistency),
    lastSeen: lastSeen || null,
  };

  let failedGate = null;
  if (count < thresholds.minOccurrences) failedGate = "frequency";
  else if (sessions < thresholds.minSessions) failedGate = "cross_session";
  else if (consistency < thresholds.minConsistency) failedGate = "consistency";
  else if (!recent) failedGate = "recency";

  return { failedGate, summary };
}

/**
 * @typedef {object} Candidate
 * @property {string} action
 * @property {string} preceding_event
 * @property {"safe" | "consequential" | "destructive"} tier
 * @property {"candidate"} status
 * @property {{ count: number, sessions: number, consistency: number, lastSeen: string | null }} evidence
 */

/**
 * @typedef {object} Dropped
 * @property {string} action
 * @property {string} preceding_event
 * @property {string} failedGate              The first gate the pattern failed.
 * @property {Candidate["evidence"]} evidence
 */

/**
 * Run the promotion engine over a log.
 *
 * Note the gates operate over the FULL set of records passed in, not an incremental
 * tail: a pattern's significance (cross-session spread, the consistency denominator) is
 * a property of the whole stream. Idempotency across the two cold triggers is the
 * cursor's job in the runner, not this function's.
 *
 * @param {object[]} records
 * @param {{ now?: string | number | Date, thresholds?: Partial<typeof THRESHOLDS> }} [options]
 * @returns {{
 *   analyzed: { events: number, sessions: number },
 *   thresholds: typeof THRESHOLDS,
 *   candidates: Candidate[],
 *   dropped: Dropped[],
 * }}
 */
export function detect(records, options = {}) {
  const thresholds = { ...THRESHOLDS, ...(options.thresholds ?? {}) };
  const now = options.now ? new Date(options.now) : new Date();

  const contextTotals = new Map(); // preceding_event -> total occurrences (Gate 3 denominator)
  const groups = new Map(); // patternId -> { action, preceding_event, hits }

  for (const record of records) {
    const preceding = record.preceding_event ?? "session_start";
    contextTotals.set(preceding, (contextTotals.get(preceding) ?? 0) + 1);

    const id = patternId(record.action, preceding);
    let group = groups.get(id);
    if (!group) {
      group = { action: record.action, preceding_event: preceding, hits: [] };
      groups.set(id, group);
    }
    group.hits.push(record);
  }

  const candidates = [];
  const dropped = [];

  for (const group of groups.values()) {
    const { failedGate, summary } = evaluate(group, contextTotals, now, thresholds);

    // An `unmatched` action is unactionable: you cannot make a rule out of an
    // unrecognized command, and all unmatched commands collapse under one label. It is
    // a signal to add a normalization rule (PRAXIS.md §5), not a candidate to promote.
    // Surfaced in `dropped` so its volume still informs that discovery.
    if (group.action === "unmatched") {
      dropped.push({
        action: group.action,
        preceding_event: group.preceding_event,
        failedGate: "unactionable",
        evidence: summary,
      });
      continue;
    }

    if (failedGate) {
      dropped.push({
        action: group.action,
        preceding_event: group.preceding_event,
        failedGate,
        evidence: summary,
      });
    } else {
      candidates.push({
        action: group.action,
        preceding_event: group.preceding_event,
        tier: classifyReversibility(group.action), // Gate 5 — classify, never reject
        status: "candidate",
        evidence: summary,
      });
    }
  }

  // Strongest evidence first; ties broken by name for stable, diffable output.
  const byStrength = (a, b) =>
    b.evidence.count - a.evidence.count || a.action.localeCompare(b.action);
  candidates.sort(byStrength);
  dropped.sort(byStrength);

  return {
    analyzed: {
      events: records.length,
      sessions: new Set(records.map((r) => r.session_id ?? "unknown")).size,
    },
    thresholds,
    candidates,
    dropped,
  };
}
