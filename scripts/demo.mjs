#!/usr/bin/env node
// Self-contained demo of the Stage 1 hot path. It drives the REAL PostToolUse hook
// over a synthetic sequence of events in a throwaway temp directory, then prints the
// resulting log and a summary. Nothing here touches your project's `.praxis/` — it is
// a honest, runnable illustration of the pipeline, not a mock.
//
//   npm run demo

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { summarize } from "../src/report.mjs";

const HOOK = fileURLToPath(new URL("../src/hooks/post-tool-use.mjs", import.meta.url));

// A plausible day of work across three sessions: file edits, test runs, a chained
// git flow, prefixed commands, and one unrecognized tool the engine should surface.
const EVENTS = [
  ["morning", "Read"],
  ["morning", "Grep"],
  ["morning", "Bash", "npm test"],
  ["morning", "Bash", "git add -A && git commit -m 'fix bug' && git push"],
  ["afternoon", "Bash", "CI=1 npm test"],
  ["afternoon", "Bash", "git status"],
  ["afternoon", "Bash", "docker compose up -d"],
  ["afternoon", "Bash", "sudo git push"],
  ["evening", "Edit"],
  ["evening", "Bash", "npm run build"],
  ["evening", "Bash", "git push origin main"],
];

function fireHook(root, [session, tool, command]) {
  const payload = { session_id: session, tool_name: tool };
  if (command !== undefined) payload.tool_input = { command };
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
}

const root = mkdtempSync(join(tmpdir(), "praxis-demo-"));
try {
  console.log("Praxis Stage 1 demo — driving the real hook over a synthetic workday.\n");
  for (const event of EVENTS) fireHook(root, event);

  const records = readFileSync(join(root, ".praxis", "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  console.log("Logged events (action  <-  preceding_event   [session]):");
  for (const r of records) {
    const label = r.action === "unmatched" ? `unmatched: ${r.raw}` : r.action;
    console.log(
      `  ${label.padEnd(28)} <- ${String(r.preceding_event).padEnd(16)} [${r.session_id}]`,
    );
  }

  const summary = summarize(records);
  console.log(`\nSummary — ${summary.total} events across ${summary.sessions} sessions:`);
  for (const [action, count] of summary.byAction) {
    console.log(`  ${String(count).padStart(3)}  ${action}`);
  }
  if (summary.unmatched.length) {
    console.log("\nUnmatched (the data-driven backlog of rules to add next):");
    for (const [raw, count] of summary.unmatched)
      console.log(`  ${String(count).padStart(3)}  ${raw}`);
  }
  console.log("\nNote: synthetic data in a temp dir — your real .praxis/ is untouched.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
