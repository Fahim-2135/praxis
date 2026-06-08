// I/O shell for the human path. Reads the three review files, drives a per-candidate
// decision callback, applies each decision with the pure core (src/review/store.mjs), and
// writes the results back. It holds NO prompt logic of its own: the decision source is
// injected, so the interactive readline prompt (bin/praxis.mjs) and the scripted decisions
// in tests run the exact same loop.

import { readFileSync, writeFileSync } from "node:fs";
import { paths } from "../state/paths.mjs";
import { patternId } from "../detect.mjs";
import {
  parseActiveRules,
  renderActiveRules,
  renderRejected,
  applyDecision,
  retireRule,
} from "./store.mjs";

/**
 * Read and parse a JSON file; return `fallback` if it is missing or malformed. Strips a
 * leading UTF-8 BOM (U+FEFF), which some editors and PowerShell prepend and which would
 * otherwise make `JSON.parse` throw on an otherwise-valid file.
 */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

/** Read `active-rules.md` (the markers), tolerating a missing file. */
function readActive(path) {
  try {
    return parseActiveRules(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/** Normalize `rejected.json` (array or `{ rejected: [...] }`) into a plain array. */
function readRejected(path) {
  const data = readJson(path, []);
  return Array.isArray(data) ? data : (data?.rejected ?? []);
}

/**
 * Load the full review state from disk.
 * @param {string} root
 * @returns {{
 *   candidatesFile: object,        // the whole candidates.json (provenance preserved)
 *   candidates: object[],          // the pending candidate array
 *   retirements: object[],         // active rules the cold pass flagged stale (PRAXIS.md §8)
 *   active: import("./store.mjs").Rule[],
 *   rejected: import("./store.mjs").Rejection[],
 * }}
 */
export function loadState(root) {
  const p = paths(root);
  const candidatesFile = readJson(p.candidates, { candidates: [] });
  return {
    candidatesFile,
    candidates: Array.isArray(candidatesFile.candidates) ? candidatesFile.candidates : [],
    retirements: Array.isArray(candidatesFile.retirements) ? candidatesFile.retirements : [],
    active: readActive(p.activeRules),
    rejected: readRejected(p.rejected),
  };
}

/**
 * Write the review state back to disk. Each file is written only if `which` selects it, so a
 * session that touches only one kind of decision never creates the other files: an approval
 * never spawns an empty `rejected.json`, a rejection never spawns an empty `active-rules.md`,
 * and a skip-only session writes nothing at all. `active-rules.md` and `rejected.json` are
 * rewritten wholesale; `candidates.json` keeps its provenance fields but its `candidates`
 * array is replaced with whatever remains undecided.
 * @param {string} root
 * @param {{ candidatesFile: object, candidates: object[], active, rejected }} state
 * @param {{ active?: boolean, rejected?: boolean, candidates?: boolean }} [which]
 *   Which files to write. Defaults to all three.
 */
export function persist(root, state, which = {}) {
  const { active = true, rejected = true, candidates = true } = which;
  const p = paths(root);
  if (active) writeFileSync(p.activeRules, renderActiveRules(state.active));
  if (rejected) writeFileSync(p.rejected, renderRejected(state.rejected));
  if (candidates) {
    writeFileSync(
      p.candidates,
      JSON.stringify(
        { ...state.candidatesFile, candidates: state.candidates, retirements: state.retirements },
        null,
        2,
      ) + "\n",
    );
  }
}

/**
 * Human-readable evidence line for one candidate.
 * @param {object} c
 * @returns {string}
 */
export function formatCandidate(c) {
  const e = c.evidence ?? {};
  return (
    `[${c.tier}] ${c.action} after ${c.preceding_event}\n` +
    `        seen ${e.count}× across ${e.sessions} sessions, ` +
    `${Math.round((e.consistency ?? 0) * 100)}% consistent, last ${e.lastSeen ?? "—"}`
  );
}

/**
 * Human-readable line for one stale active rule flagged for retirement (PRAXIS.md §8).
 * @param {{ action: string, preceding_event: string, tier: string,
 *   lastSeen: string | null, daysSinceLastSeen: number | null }} r
 * @returns {string}
 */
export function formatRetirement(r) {
  const seen =
    r.lastSeen == null
      ? "never seen since it was approved"
      : `last seen ${r.lastSeen}` +
        (r.daysSinceLastSeen != null ? ` (${r.daysSinceLastSeen}d ago)` : "");
  return `[${r.tier}] ${r.action} after ${r.preceding_event}\n        stale — ${seen}`;
}

/**
 * Run one review session: first the pending candidates (approve/reject/skip), then any active
 * rules the cold pass flagged stale (retire/keep). Both decision sources are injected, so the
 * interactive prompts (bin/praxis.mjs) and scripted tests share this exact loop.
 *
 * @param {string} root
 * @param {{
 *   decide: (candidate: object, index: number, total: number) =>
 *     Promise<"approve" | "reject" | "skip" | "quit"> | "approve" | "reject" | "skip" | "quit",
 *   decideRetirement?: (rule: object, index: number, total: number) =>
 *     Promise<"retire" | "keep" | "quit"> | "retire" | "keep" | "quit",
 *   out?: (line: string) => void,   // line sink (defaults to console.log)
 *   now?: string,                   // ISO timestamp to stamp decisions (defaults to now)
 * }} options
 * @returns {Promise<{ approved: number, rejected: number, skipped: number,
 *   retired: number, kept: number, remaining: number }>}
 */
export async function runReview(root, { decide, decideRetirement, out = console.log, now } = {}) {
  const stamp = now ?? new Date().toISOString();
  let state = loadState(root);

  const hasCandidates = state.candidates.length > 0;
  const hasRetirements = state.retirements.length > 0 && typeof decideRetirement === "function";

  if (!hasCandidates && !hasRetirements) {
    out("No pending candidates. Nothing to review.");
    if (state.active.length) {
      out(`\n${state.active.length} active rule(s) in active-rules.md.`);
    }
    return { approved: 0, rejected: 0, skipped: 0, retired: 0, kept: 0, remaining: 0 };
  }

  const tally = { approved: 0, rejected: 0, skipped: 0, retired: 0, kept: 0 };
  let quit = false;

  // Phase 1 — pending candidates. Snapshot the queue up front: applyDecision rewrites
  // state.candidates as we go, so we iterate the original list, not the shrinking one.
  const queue = [...state.candidates];
  for (let i = 0; i < queue.length && !quit; i++) {
    const decision = await decide(queue[i], i, queue.length);
    if (decision === "quit") quit = true;
    else {
      state = applyDecision(state, queue[i], decision, stamp);
      if (decision === "approve") tally.approved++;
      else if (decision === "reject") tally.rejected++;
      else tally.skipped++;
    }
  }

  // Phase 2 — stale active rules flagged for retirement (PRAXIS.md §8). This mirrors the
  // candidate phase exactly: `retire` is the decisive action (drop the rule from active-rules.md
  // and from the pending flag list, like approve/reject drop a candidate), and `keep` is the
  // non-decision (leave the rule flagged, like skip leaves a candidate pending — the next cold
  // pass re-flags it if it is still stale).
  if (hasRetirements && !quit) {
    const stale = [...state.retirements];
    for (let i = 0; i < stale.length; i++) {
      const decision = await decideRetirement(stale[i], i, stale.length);
      if (decision === "quit") break;
      if (decision === "retire") {
        const id = patternId(stale[i].action, stale[i].preceding_event);
        state = {
          ...state,
          retirements: state.retirements.filter(
            (r) => patternId(r.action, r.preceding_event) !== id,
          ),
          active: retireRule(state.active, stale[i]),
        };
        tally.retired++;
      } else {
        tally.kept++; // keep: a non-decision, like skip — nothing changes on disk
      }
    }
  }

  // Write only what a decisive action changed. Approvals add active rules; retirements remove
  // them — either touches active-rules.md. Approve/reject/retire each shrink a pending list, so
  // candidates.json (which carries both the candidate and retirement arrays) is rewritten. A
  // skip/keep-only or immediate-quit session is a pure no-decision and writes no files.
  const candidatesDecided = tally.approved + tally.rejected > 0;
  const anyRetired = tally.retired > 0;
  if (candidatesDecided || anyRetired) {
    persist(root, state, {
      active: tally.approved > 0 || anyRetired,
      rejected: tally.rejected > 0,
      candidates: true,
    });
  }
  return { ...tally, remaining: state.candidates.length };
}
