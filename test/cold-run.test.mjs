import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDetection } from "../src/cold/run.mjs";
import { paths } from "../src/state/paths.mjs";

const NOW = "2026-06-08T12:00:00Z";

/** A fresh project root with a `.praxis/` dir and the given log records seeded. */
function seedProject(recordList) {
  const root = mkdtempSync(join(tmpdir(), "praxis-cold-"));
  const p = paths(root);
  mkdirSync(p.base, { recursive: true });
  writeFileSync(p.log, recordList.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, p };
}

/** Five records of one cross-session pattern that clears every gate at NOW. */
function passingPattern() {
  return ["a", "b", "c", "a", "b"].map((session_id) => ({
    action: "git_push",
    preceding_event: "test_run",
    session_id,
    timestamp: NOW,
  }));
}

test("first pass writes candidates.json and advances the cursor", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    const result = runDetection(root, { now: NOW });
    assert.equal(result.ran, true);
    assert.ok(existsSync(p.candidates));

    const candidates = JSON.parse(readFileSync(p.candidates, "utf8"));
    assert.equal(candidates.candidates.length, 1);
    assert.equal(candidates.candidates[0].action, "git_push");

    assert.equal(readFileSync(p.lastProcessed, "utf8").trim(), "5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second pass with no new events is an idempotent no-op", () => {
  const { root } = seedProject(passingPattern());
  try {
    runDetection(root, { now: NOW });
    const second = runDetection(root, { now: NOW });
    assert.equal(second.ran, false);
    assert.equal(second.reason, "no new events");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appending new events makes the next pass run again", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    runDetection(root, { now: NOW });
    // Append one more event, simulating a later session.
    const extra = JSON.stringify({
      action: "git_push",
      preceding_event: "test_run",
      session_id: "d",
      timestamp: NOW,
    });
    writeFileSync(p.log, readFileSync(p.log, "utf8") + extra + "\n");

    const third = runDetection(root, { now: NOW });
    assert.equal(third.ran, true);
    assert.equal(readFileSync(p.lastProcessed, "utf8").trim(), "6");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejected patterns are never re-proposed", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    writeFileSync(
      p.rejected,
      JSON.stringify([{ action: "git_push", preceding_event: "test_run" }]),
    );
    const result = runDetection(root, { now: NOW });
    assert.equal(result.ran, true);
    assert.equal(result.candidates.length, 0); // the only pattern was rejected
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("already-approved patterns are not re-proposed as candidates", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    // An active-rules.md already containing this pattern (as Stage 3 would write it).
    writeFileSync(
      p.activeRules,
      '# Active\n<!-- praxis:rule {"action":"git_push","preceding_event":"test_run","tier":"consequential"} -->\n',
    );
    const result = runDetection(root, { now: NOW });
    assert.equal(result.ran, true);
    assert.equal(result.candidates.length, 0); // the only pattern is already active
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("force + dryRun analyzes but writes nothing", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    const result = runDetection(root, { now: NOW, force: true, dryRun: true });
    assert.equal(result.ran, true);
    assert.equal(result.candidates.length, 1);
    assert.ok(!existsSync(p.candidates));
    assert.ok(!existsSync(p.lastProcessed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the cold pass flags a stale active rule for retirement", () => {
  const { root, p } = seedProject(passingPattern());
  try {
    // An active rule whose behavior (git_pull after session_start) never appears in the log.
    writeFileSync(
      p.activeRules,
      '# Active\n<!-- praxis:rule {"action":"git_pull","preceding_event":"session_start","tier":"consequential"} -->\n',
    );
    const result = runDetection(root, { now: NOW });
    assert.equal(result.ran, true);
    assert.equal(result.retirements.length, 1);
    assert.equal(result.retirements[0].action, "git_pull");
    assert.equal(result.retirements[0].lastSeen, null); // never seen since approval

    // Persisted alongside candidates so `praxis review` can surface it.
    const file = JSON.parse(readFileSync(p.candidates, "utf8"));
    assert.equal(file.retirements.length, 1);
    assert.equal(file.retirements[0].action, "git_pull");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
