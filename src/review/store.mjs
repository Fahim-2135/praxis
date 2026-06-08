// Pure state core for the human path (`praxis review`, PRAXIS.md §9).
//
// This module holds NO I/O. It renders and parses the two files the review loop owns —
// `active-rules.md` (approved rules) and `rejected.json` (declined patterns) — and
// computes the state transition for a single approve/reject/skip decision. The I/O shell
// (src/review/run.mjs) reads/writes; the CLI (bin/praxis.mjs) drives the prompts. Keeping
// the transforms pure mirrors the detect.mjs / cold/run.mjs split and makes them trivially
// testable.

import { patternId } from "../detect.mjs";

/**
 * Matches one rule's provenance marker inside `active-rules.md`. The parser reads ONLY
 * these markers, never the prose, so a human can freely edit the surrounding text without
 * breaking machine round-tripping. `[\s\S]` (not `.`) so the JSON may span lines; the
 * group is non-greedy to stop at the first `-->`.
 */
const RULE_MARKER = /<!--\s*praxis:rule\s*(\{[\s\S]*?\})\s*-->/g;

/**
 * @typedef {object} Rule
 * @property {string} action
 * @property {string} preceding_event
 * @property {"safe" | "consequential" | "destructive"} tier
 * @property {string} approvedAt              ISO 8601 timestamp of approval.
 * @property {{ count: number, sessions: number, consistency: number, lastSeen: string | null }} evidence
 */

/**
 * One human-facing sentence describing how an approved rule of this tier is allowed to
 * behave (PRAXIS.md §7). The prose is what the model reads at session start (Stage 4); the
 * tier wording is what keeps the autonomy promise visible to a human reader too.
 * @param {Rule["tier"]} tier
 * @returns {string}
 */
function tierGuidance(tier) {
  switch (tier) {
    case "safe":
      return "It is reversible, so you may offer to do it with a soft confirmation.";
    case "destructive":
      return "It is irreversible, so you may suggest it but must never run it automatically.";
    case "consequential":
    default:
      return "It is recoverable but not trivial, so offer it and act only on explicit confirmation.";
  }
}

/**
 * Render one rule as a markdown block: a human/model-facing heading and sentence, then the
 * machine-readable provenance marker the parser round-trips on.
 * @param {Rule} rule
 * @returns {string}
 */
function renderRule(rule) {
  const e = rule.evidence ?? {};
  const evidence =
    `seen ${e.count}× across ${e.sessions} sessions, ` +
    `${Math.round((e.consistency ?? 0) * 100)}% consistent, last ${e.lastSeen ?? "—"}`;
  const marker = JSON.stringify({
    action: rule.action,
    preceding_event: rule.preceding_event,
    tier: rule.tier,
    approvedAt: rule.approvedAt,
    evidence: rule.evidence,
  });
  return [
    `## \`${rule.action}\` after \`${rule.preceding_event}\`  ·  ${rule.tier}`,
    "",
    `When \`${rule.preceding_event}\` just happened, you have repeatedly done ` +
      `\`${rule.action}\` next (${evidence}). ${tierGuidance(rule.tier)}`,
    "",
    `<!-- praxis:rule ${marker} -->`,
  ].join("\n");
}

/**
 * Render the full `active-rules.md` file from a list of approved rules. This is the single
 * file injected into context (PRAXIS.md §3); the prose is for the human and the model, the
 * markers are for the parser.
 * @param {Rule[]} rules
 * @returns {string}
 */
export function renderActiveRules(rules) {
  const header = [
    "# Praxis — Active Rules",
    "",
    "<!-- Generated and managed by `praxis review`. Each rule below was inferred from",
    "     your own logged behavior and approved by you. Claude Code injects this file",
    "     into context at session start, so editing it changes what the assistant does.",
    "     Re-run `praxis review` to add or retire rules. -->",
    "",
  ].join("\n");

  if (rules.length === 0) {
    return header + "\n_No active rules yet._\n";
  }

  const count = `_${rules.length} active rule${rules.length === 1 ? "" : "s"}._`;
  return [header, count, "", ...rules.map(renderRule)].join("\n") + "\n";
}

/**
 * Parse approved rules back out of `active-rules.md` by reading the provenance markers.
 * Tolerates a missing/empty string and skips any marker whose JSON is malformed, so a
 * hand-edited file never throws.
 * @param {string | null | undefined} markdown
 * @returns {Rule[]}
 */
export function parseActiveRules(markdown) {
  if (!markdown) return [];
  const rules = [];
  for (const match of markdown.matchAll(RULE_MARKER)) {
    try {
      rules.push(JSON.parse(match[1]));
    } catch {
      // A corrupt marker must not blind us to the rest of the file.
    }
  }
  return rules;
}

/**
 * @typedef {object} Rejection
 * @property {string} action
 * @property {string} preceding_event
 * @property {string} rejectedAt
 */

/**
 * Serialize the rejection memory. Array form matches what the cold-path runner already
 * reads (src/cold/run.mjs), so a rejected pattern is never re-proposed (PRAXIS.md §9).
 * @param {Rejection[]} rejected
 * @returns {string}
 */
export function renderRejected(rejected) {
  return JSON.stringify(rejected, null, 2) + "\n";
}

/**
 * The set of pattern ids already decided — active OR rejected. The review loop and the
 * detector both use this to avoid re-presenting a pattern the user has already ruled on.
 * @param {{ active?: Rule[], rejected?: Rejection[] }} state
 * @returns {Set<string>}
 */
export function decidedIds({ active = [], rejected = [] }) {
  const ids = new Set();
  for (const r of active) ids.add(patternId(r.action, r.preceding_event));
  for (const r of rejected) ids.add(patternId(r.action, r.preceding_event));
  return ids;
}

/**
 * Remove a rule from the active set by pattern id — the "retire" action of self-pruning
 * (PRAXIS.md §8, §9). Returns a NEW array (no mutation); a rule not present is a harmless
 * no-op. Retirement is human-gated in `praxis review` exactly like approval is: the same
 * human path that admits a rule is the one that removes it.
 * @param {Rule[]} active
 * @param {{ action: string, preceding_event: string }} rule
 * @returns {Rule[]}
 */
export function retireRule(active, rule) {
  const id = patternId(rule.action, rule.preceding_event);
  return active.filter((r) => patternId(r.action, r.preceding_event) !== id);
}

/**
 * Apply one decision to the review state, returning a NEW state (no mutation). `approve`
 * moves the candidate into active rules; `reject` records it in rejection memory; `skip`
 * leaves it pending. A pattern already present in the target list is not duplicated.
 *
 * @param {{ candidates: object[], active: Rule[], rejected: Rejection[] }} state
 * @param {object} candidate                       The candidate being decided.
 * @param {"approve" | "reject" | "skip"} decision
 * @param {string} now                             ISO timestamp to stamp the decision with.
 * @returns {{ candidates: object[], active: Rule[], rejected: Rejection[] }}
 */
export function applyDecision(state, candidate, decision, now) {
  const id = patternId(candidate.action, candidate.preceding_event);
  const has = (list) => list.some((r) => patternId(r.action, r.preceding_event) === id);

  if (decision === "skip") return state;

  // Once decided, the candidate leaves the pending pool either way.
  const candidates = state.candidates.filter((c) => patternId(c.action, c.preceding_event) !== id);

  if (decision === "approve") {
    if (has(state.active)) return { ...state, candidates };
    const rule = {
      action: candidate.action,
      preceding_event: candidate.preceding_event,
      tier: candidate.tier,
      approvedAt: now,
      evidence: candidate.evidence,
    };
    return { ...state, candidates, active: [...state.active, rule] };
  }

  if (decision === "reject") {
    if (has(state.rejected)) return { ...state, candidates };
    const rejection = {
      action: candidate.action,
      preceding_event: candidate.preceding_event,
      rejectedAt: now,
    };
    return { ...state, candidates, rejected: [...state.rejected, rejection] };
  }

  return state;
}
