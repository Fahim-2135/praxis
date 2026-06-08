import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus } from "../src/status/status.mjs";

const NOW = "2026-06-09T12:00:00Z";

/** Build `n` records of one (action, preceding) pattern across the given sessions, at `ts`. */
function recs({ action, preceding = "session_start", sessions, ts = NOW }) {
  return sessions.map((session_id) => ({
    action,
    preceding_event: preceding,
    session_id,
    timestamp: ts,
  }));
}

test("empty log yields a zeroed model with empty sections", () => {
  const s = buildStatus([], {}, { now: NOW });
  assert.equal(s.observed.events, 0);
  assert.equal(s.observed.sessions, 0);
  assert.equal(s.observed.spanDays, 0);
  assert.deepEqual(s.topHabits, []);
  assert.deepEqual(s.almostRules, []);
});

test("observed window: counts, sessions, and day span", () => {
  const records = [
    ...recs({ action: "file_edit", sessions: ["a"], ts: "2026-06-01T09:00:00Z" }),
    ...recs({ action: "git_push", sessions: ["b"], ts: "2026-06-05T09:00:00Z" }),
  ];
  const s = buildStatus(records, {}, { now: NOW });
  assert.equal(s.observed.events, 2);
  assert.equal(s.observed.sessions, 2);
  assert.equal(s.observed.firstSeen, "2026-06-01T09:00:00Z");
  assert.equal(s.observed.lastSeen, "2026-06-05T09:00:00Z");
  assert.equal(s.observed.spanDays, 5); // 1st -> 5th inclusive
});

test("top habits exclude unmatched and rank by frequency", () => {
  const records = [
    ...recs({ action: "file_edit", sessions: ["a", "a", "a"] }),
    ...recs({ action: "git_push", sessions: ["a", "b"] }),
    {
      action: "unmatched",
      preceding_event: "x",
      session_id: "a",
      timestamp: NOW,
      raw: "docker up",
    },
  ];
  const s = buildStatus(records, {}, { now: NOW });
  assert.deepEqual(
    s.topHabits.map((h) => h.action),
    ["file_edit", "git_push"],
  );
  assert.equal(s.observed.unmatched, 1); // distinct unmatched commands still counted in observed
});

test("almost rules surface a cross-session near-miss with a concrete gap", () => {
  // git_push after test_run: 5 occurrences (clears frequency) but only 2 sessions -> fails Gate 2.
  const records = recs({
    action: "git_push",
    preceding: "test_run",
    sessions: ["a", "a", "b", "a", "b"],
  });
  const s = buildStatus(records, {}, { now: NOW });
  assert.equal(s.almostRules.length, 1);
  assert.equal(s.almostRules[0].action, "git_push");
  assert.equal(s.almostRules[0].failedGate, "cross_session");
  assert.match(s.almostRules[0].gap, /1 more session to qualify/);
});

test("almost rules include a near-frequency miss but not a lone one-off", () => {
  const records = [
    // 3 occurrences across 3 sessions: fails frequency (needs 5) but is close (>= 5-2).
    ...recs({ action: "git_push", preceding: "test_run", sessions: ["a", "b", "c"] }),
    // a single occurrence: a one-off, not "almost" anything.
    ...recs({ action: "git_commit", preceding: "file_edit", sessions: ["a"] }),
  ];
  const s = buildStatus(records, {}, { now: NOW });
  const actions = s.almostRules.map((a) => a.action);
  assert.ok(actions.includes("git_push"));
  assert.ok(!actions.includes("git_commit"));
  const push = s.almostRules.find((a) => a.action === "git_push");
  assert.match(push.gap, /2 more occurrences to qualify/);
});

test("closer near-misses rank ahead of further ones", () => {
  const records = [
    // fails at consistency (cleared 2 gates) — closer
    ...recs({ action: "git_push", preceding: "test_run", sessions: ["a", "b", "c", "a", "b"] }),
    ...recs({ action: "git_commit", preceding: "test_run", sessions: ["a", "b", "c", "a", "b"] }),
    // a frequency near-miss (cleared 0 gates) — further
    ...recs({ action: "git_pull", preceding: "file_edit", sessions: ["a", "b", "c"] }),
  ];
  const s = buildStatus(records, {}, { now: NOW });
  // The consistency-stage misses (push/commit after test_run) should precede the frequency one.
  assert.notEqual(s.almostRules[0].failedGate, "frequency");
});

test("review state passes through onto the model", () => {
  const state = {
    active: [{ action: "git_push", preceding_event: "test_run", tier: "consequential" }],
    candidates: [{ action: "test_run", preceding_event: "file_edit", tier: "safe", evidence: {} }],
    retirements: [{ action: "git_pull", preceding_event: "session_start", tier: "consequential" }],
  };
  const s = buildStatus([], state, { now: NOW });
  assert.equal(s.activeRules.length, 1);
  assert.equal(s.candidates.length, 1);
  assert.equal(s.retirements.length, 1);
});
