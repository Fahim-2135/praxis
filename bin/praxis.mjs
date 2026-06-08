#!/usr/bin/env node
// The `praxis` command — the human path (PRAXIS.md §9).
//
// `praxis review`         interactively approve/reject the pending candidates.
// `praxis review --list`  print pending candidates and active rules, decide nothing.
//
// This file is only the terminal front end: argument dispatch and the readline prompt. All
// state logic lives in src/review/* so the same loop runs under test with scripted answers.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolveProjectDir, paths } from "../src/state/paths.mjs";
import { readLog } from "../src/state/log.mjs";
import { buildStatus } from "../src/status/status.mjs";
import { loadState, runReview, formatCandidate, formatRetirement } from "../src/review/run.mjs";

const USAGE = `praxis — inspect and approve inferred workflow rules

Usage:
  praxis status            Show what Praxis has learned about your workflow.
  praxis review            Review pending candidates one at a time.
  praxis review --list     Show pending candidates and active rules (read-only).
  praxis help              Show this message.`;

/** Render the day/range descriptor for the observed window. */
function observedLine(o) {
  if (o.events === 0) return "Nothing observed yet.";
  const span = o.spanDays <= 1 ? "today" : `over ${o.spanDays} days`;
  const last = o.lastSeen ? `, last ${o.lastSeen.slice(0, 10)}` : "";
  return `Observed ${o.events} events across ${o.sessions} session(s) ${span}${last}.`;
}

/**
 * Print the workflow profile: what Praxis has learned, what it acts on, what it wants to act on,
 * and what it is still watching. Read-only — the single command that makes the system visible.
 */
function status(root) {
  const p = paths(root);
  const { records } = readLog(p.log);
  const { candidates, active, retirements } = loadState(root);
  const s = buildStatus(records, { candidates, active, retirements });

  console.log("Praxis — what I've learned about your workflow\n");

  if (s.observed.events === 0) {
    console.log("Nothing observed yet. Use Claude Code with the hook active, then check back.");
    return;
  }
  console.log(observedLine(s.observed));

  console.log("\nYour top habits:");
  for (const h of s.topHabits) console.log(`  ${String(h.count).padStart(5)}  ${h.action}`);

  console.log(`\nActive rules — I act on these for you (${s.activeRules.length}):`);
  if (s.activeRules.length === 0) console.log("  none yet");
  else
    for (const r of s.activeRules)
      console.log(`  [${r.tier}] ${r.action} after ${r.preceding_event}`);

  console.log(`\nProposed — awaiting your review (${s.candidates.length}):`);
  if (s.candidates.length === 0) console.log("  none — run `praxis review` when there are");
  else {
    for (const c of s.candidates) console.log("  " + formatCandidate(c));
    console.log("  → run `praxis review` to approve or reject");
  }

  console.log(`\nAlmost rules — habits I'm watching (${s.almostRules.length}):`);
  if (s.almostRules.length === 0) console.log("  none close yet");
  else
    for (const a of s.almostRules)
      console.log(`  ${a.action} after ${a.preceding_event}\n      ${a.gap}`);

  if (s.retirements.length) {
    console.log(`\nStale — up for retirement (${s.retirements.length}):  run \`praxis review\``);
    for (const r of s.retirements)
      console.log(`  [${r.tier}] ${r.action} after ${r.preceding_event}`);
  }
}

/** Print pending candidates, active rules, and stale rules without changing anything. */
function list(root) {
  const { candidates, active, retirements } = loadState(root);

  console.log(`Pending candidates (${candidates.length}):`);
  if (candidates.length === 0) console.log("  none");
  else for (const c of candidates) console.log("  " + formatCandidate(c));

  console.log(`\nActive rules (${active.length}):`);
  if (active.length === 0) console.log("  none");
  else for (const r of active) console.log(`  [${r.tier}] ${r.action} after ${r.preceding_event}`);

  console.log(`\nStale rules flagged for retirement (${retirements.length}):`);
  if (retirements.length === 0) console.log("  none");
  else for (const r of retirements) console.log("  " + formatRetirement(r));
}

/**
 * One line reader shared by both prompts. Lines are pulled from readline's async iterator
 * rather than sequential `rl.question` calls: the iterator queues input, so lines that arrive
 * batched (piped or pasted) between prompts are not dropped, and end-of-input resolves cleanly
 * instead of hanging. A single iterator is shared across the candidate and retirement prompts
 * so the second phase reads the same queue the first left off at (two iterators over one
 * readline would compete for input). Returns `null` at EOF.
 * @param {import("node:readline/promises").Interface} rl
 * @returns {() => Promise<string | null>}
 */
function makeLineReader(rl) {
  const lines = rl[Symbol.asyncIterator]();
  return async () => {
    const { value, done } = await lines.next();
    return done ? null : value;
  };
}

/**
 * Candidate prompt: print the candidate, then read one of a/r/s/q. Re-prompts on unrecognized
 * input so a stray keystroke never decides a rule; EOF is a graceful `quit`.
 * @param {() => Promise<string | null>} readLine
 */
function makeAsker(readLine) {
  return async (candidate, index, total) => {
    console.log(`\n(${index + 1}/${total}) ${formatCandidate(candidate)}`);
    for (;;) {
      stdout.write("  approve / reject / skip / quit [a/r/s/q]? ");
      const line = await readLine();
      if (line === null) return "quit"; // input ended — stop gracefully
      const answer = line.trim().toLowerCase();
      if (answer === "a" || answer === "approve") return "approve";
      if (answer === "r" || answer === "reject") return "reject";
      if (answer === "s" || answer === "skip" || answer === "") return "skip";
      if (answer === "q" || answer === "quit") return "quit";
      console.log("  Please answer a, r, s, or q.");
    }
  };
}

/**
 * Retirement prompt for a stale active rule: retire (remove it) / keep / quit. The empty
 * answer defaults to `keep` — a stray Enter must never delete a rule.
 * @param {() => Promise<string | null>} readLine
 */
function makeRetirementAsker(readLine) {
  return async (rule, index, total) => {
    console.log(`\nStale rule (${index + 1}/${total}) ${formatRetirement(rule)}`);
    for (;;) {
      stdout.write("  retire / keep / quit [r/k/q]? ");
      const line = await readLine();
      if (line === null) return "quit";
      const answer = line.trim().toLowerCase();
      if (answer === "r" || answer === "retire") return "retire";
      if (answer === "k" || answer === "keep" || answer === "") return "keep";
      if (answer === "q" || answer === "quit") return "quit";
      console.log("  Please answer r, k, or q.");
    }
  };
}

async function review(root) {
  const rl = createInterface({ input: stdin, output: stdout });
  const readLine = makeLineReader(rl);
  try {
    const summary = await runReview(root, {
      decide: makeAsker(readLine),
      decideRetirement: makeRetirementAsker(readLine),
    });
    console.log(
      `\nDone — ${summary.approved} approved, ${summary.rejected} rejected, ` +
        `${summary.skipped} skipped, ${summary.retired} retired, ${summary.remaining} still pending.`,
    );
    if (summary.approved > 0 || summary.retired > 0) {
      console.log(`Active rules updated in ${paths(root).activeRules}.`);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = resolveProjectDir();

  switch (command) {
    case "status":
      status(root);
      break;
    case "review":
      if (rest.includes("--list")) list(root);
      else await review(root);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("praxis: " + (err?.message ?? err));
  process.exitCode = 1;
});
