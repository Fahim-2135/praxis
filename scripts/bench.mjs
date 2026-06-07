#!/usr/bin/env node
// Measure the hot path's real per-invocation overhead — the latency Claude Code
// adds to every tool call. This is the objective half of the Stage 1 gate (b)
// ("still feels snappy"): each run spawns the actual hook process end to end, so
// the number includes Node startup, which dominates the cost.
//
//   npm run bench [iterations]

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HOOK = fileURLToPath(new URL("../src/hooks/post-tool-use.mjs", import.meta.url));
const iterations = Math.max(10, Number(process.argv[2]) || 100);
const PAYLOAD = JSON.stringify({
  session_id: "bench",
  tool_name: "Bash",
  tool_input: { command: "git push origin main" },
});

const root = mkdtempSync(join(tmpdir(), "praxis-bench-"));
const samples = [];
try {
  // Warm up disk/OS caches so the reported distribution reflects steady state.
  for (let i = 0; i < 5; i++) {
    spawnSync(process.execPath, [HOOK], {
      input: PAYLOAD,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  }
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    spawnSync(process.execPath, [HOOK], {
      input: PAYLOAD,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    samples.push(performance.now() - start);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

samples.sort((a, b) => a - b);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;

console.log(`Hot-path overhead over ${iterations} invocations (ms):`);
console.log(`  min   ${at(0).toFixed(1)}`);
console.log(`  p50   ${at(0.5).toFixed(1)}`);
console.log(`  p95   ${at(0.95).toFixed(1)}`);
console.log(`  p99   ${at(0.99).toFixed(1)}`);
console.log(`  max   ${samples[samples.length - 1].toFixed(1)}`);
console.log(`  mean  ${mean.toFixed(1)}`);
console.log("\nThis is added per tool call. Node process startup dominates it; the");
console.log("append + marker file ops are negligible by comparison.");
