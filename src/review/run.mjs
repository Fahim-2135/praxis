// I/O shell for the human path. Reads the three review files, drives a per-candidate
// decision callback, applies each decision with the pure core (src/review/store.mjs), and
// writes the results back. It holds NO prompt logic of its own: the decision source is
// injected, so the interactive readline prompt (bin/praxis.mjs) and the scripted decisions
// in tests run the exact same loop.

import { readFileSync, writeFileSync } from "node:fs";
import { paths } from "../state/paths.mjs";
import { parseActiveRules, renderActiveRules, renderRejected, applyDecision } from "./store.mjs";

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
      JSON.stringify({ ...state.candidatesFile, candidates: state.candidates }, null, 2) + "\n",
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
 * Run one review session.
 *
 * @param {string} root
 * @param {{
 *   decide: (candidate: object, index: number, total: number) =>
 *     Promise<"approve" | "reject" | "skip" | "quit"> | "approve" | "reject" | "skip" | "quit",
 *   out?: (line: string) => void,   // line sink (defaults to console.log)
 *   now?: string,                   // ISO timestamp to stamp decisions (defaults to now)
 * }} options
 * @returns {Promise<{ approved: number, rejected: number, skipped: number, remaining: number }>}
 */
export async function runReview(root, { decide, out = console.log, now } = {}) {
  const stamp = now ?? new Date().toISOString();
  let state = loadState(root);

  if (state.candidates.length === 0) {
    out("No pending candidates. Nothing to review.");
    if (state.active.length) {
      out(`\n${state.active.length} active rule(s) in active-rules.md.`);
    }
    return { approved: 0, rejected: 0, skipped: 0, remaining: 0 };
  }

  // Snapshot the queue up front: applyDecision rewrites state.candidates as we go, so we
  // iterate over the original list rather than the shrinking one.
  const queue = [...state.candidates];
  const tally = { approved: 0, rejected: 0, skipped: 0 };

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    const decision = await decide(candidate, i, queue.length);

    if (decision === "quit") break;
    state = applyDecision(state, candidate, decision, stamp);
    if (decision === "approve") tally.approved++;
    else if (decision === "reject") tally.rejected++;
    else tally.skipped++;
  }

  // Write only what changed. Approvals/rejections also shrink the pending pool, so either one
  // means candidates.json must be rewritten; a skip-only (or immediate-quit) session changes
  // nothing on disk and writes no files.
  if (tally.approved > 0 || tally.rejected > 0) {
    persist(root, state, {
      active: tally.approved > 0,
      rejected: tally.rejected > 0,
      candidates: true,
    });
  }
  return { ...tally, remaining: state.candidates.length };
}
