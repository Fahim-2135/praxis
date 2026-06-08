import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, classifyReversibility, findStaleRules, THRESHOLDS } from "../src/detect.mjs";

const NOW = "2026-06-08T12:00:00Z";

/** Build `n` records for one (action, preceding) pattern across the given sessions. */
function records({ action, preceding, sessions, timestamp = NOW }) {
  return sessions.map((session_id) => ({
    action,
    preceding_event: preceding,
    session_id,
    timestamp,
  }));
}

test("a pattern that clears all gates becomes a candidate with a tier", () => {
  // git_push after test_run: 5 hits across 3 sessions, 100% consistent, today.
  const log = [
    ...records({ action: "git_push", preceding: "test_run", sessions: ["a", "b", "c", "a", "b"] }),
    // give test_run some other occurrences so the denominator is real but consistency stays high
  ];
  const { candidates, dropped } = detect(log, { now: NOW });
  assert.equal(dropped.length, 0);
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    {
      action: candidates[0].action,
      preceding_event: candidates[0].preceding_event,
      tier: candidates[0].tier,
      status: candidates[0].status,
    },
    { action: "git_push", preceding_event: "test_run", tier: "consequential", status: "candidate" },
  );
  assert.equal(candidates[0].evidence.count, 5);
  assert.equal(candidates[0].evidence.sessions, 3);
  assert.equal(candidates[0].evidence.consistency, 1);
});

test("Gate 1 (frequency): fewer than minOccurrences is dropped", () => {
  const log = records({
    action: "git_push",
    preceding: "test_run",
    sessions: ["a", "b", "c", "d"],
  });
  const { candidates, dropped } = detect(log, { now: NOW });
  assert.equal(candidates.length, 0);
  assert.equal(dropped[0].failedGate, "frequency");
});

test("Gate 2 (cross-session): enough hits but too few sessions is dropped", () => {
  // 6 hits, all in one session — the within-one-session repetition Gate 2 exists to kill.
  const log = records({
    action: "file_edit",
    preceding: "file_edit",
    sessions: ["a", "a", "a", "a", "a", "a"],
  });
  const { candidates, dropped } = detect(log, { now: NOW });
  assert.equal(candidates.length, 0);
  assert.equal(dropped[0].failedGate, "cross_session");
  assert.equal(dropped[0].evidence.count, 6);
  assert.equal(dropped[0].evidence.sessions, 1);
});

test("Gate 3 (consistency): action follows the context less than 80% of the time", () => {
  // test_run occurs 10 times; git_push follows only 5 of them (50%). The other 5 are
  // git_commit after test_run — same context, different action.
  const log = [
    ...records({ action: "git_push", preceding: "test_run", sessions: ["a", "b", "c", "a", "b"] }),
    ...records({
      action: "git_commit",
      preceding: "test_run",
      sessions: ["a", "b", "c", "a", "b"],
    }),
  ];
  const { candidates, dropped } = detect(log, { now: NOW });
  // git_push: count 5, sessions 3, but consistency 5/10 = 0.5 -> fails Gate 3.
  const push = dropped.find((d) => d.action === "git_push");
  assert.ok(push);
  assert.equal(push.failedGate, "consistency");
  assert.equal(push.evidence.consistency, 0.5);
  assert.equal(candidates.length, 0);
});

test("Gate 4 (recency): no occurrence within the window is dropped", () => {
  const old = "2026-05-01T12:00:00Z"; // 38 days before NOW, outside the 5-day window
  const log = records({
    action: "git_push",
    preceding: "test_run",
    sessions: ["a", "b", "c", "a", "b"],
    timestamp: old,
  });
  const { candidates, dropped } = detect(log, { now: NOW });
  assert.equal(candidates.length, 0);
  assert.equal(dropped[0].failedGate, "recency");
});

test("recency passes if ANY single occurrence is within the window", () => {
  const old = "2026-05-01T12:00:00Z";
  const log = [
    ...records({
      action: "git_push",
      preceding: "test_run",
      sessions: ["a", "b", "c", "a"],
      timestamp: old,
    }),
    ...records({ action: "git_push", preceding: "test_run", sessions: ["b"], timestamp: NOW }),
  ];
  const { candidates } = detect(log, { now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].evidence.lastSeen, NOW);
});

test("gates are evaluated in order: frequency reported before cross_session", () => {
  // 3 hits in 1 session fails BOTH frequency and cross_session; frequency comes first.
  const log = records({ action: "git_push", preceding: "test_run", sessions: ["a", "a", "a"] });
  const { dropped } = detect(log, { now: NOW });
  assert.equal(dropped[0].failedGate, "frequency");
});

test("classifyReversibility maps known actions and defaults unknown to consequential", () => {
  assert.equal(classifyReversibility("test_run"), "safe");
  assert.equal(classifyReversibility("git_push"), "consequential");
  assert.equal(classifyReversibility("file_read"), "safe");
  assert.equal(classifyReversibility("totally_unknown"), "consequential");
});

test("thresholds are overridable for calibration without mutating the defaults", () => {
  const log = records({ action: "git_push", preceding: "test_run", sessions: ["a", "b"] });
  // With a relaxed threshold (2 occurrences, 2 sessions) this 2-hit pattern passes.
  const { candidates } = detect(log, {
    now: NOW,
    thresholds: { minOccurrences: 2, minSessions: 2 },
  });
  assert.equal(candidates.length, 1);
  assert.equal(THRESHOLDS.minOccurrences, 5); // defaults untouched
});

test("empty log yields no candidates and no crash", () => {
  const { candidates, dropped, analyzed } = detect([], { now: NOW });
  assert.deepEqual(candidates, []);
  assert.deepEqual(dropped, []);
  assert.equal(analyzed.events, 0);
});

test("an unmatched action is never promoted, even if it clears every gate", () => {
  // This pattern would pass frequency, cross-session, consistency, and recency — but
  // `unmatched` is unactionable (a normalization-rule signal, not a rule to promote).
  const log = records({
    action: "unmatched",
    preceding: "session_start",
    sessions: ["a", "b", "c", "a", "b"],
  });
  const { candidates, dropped } = detect(log, { now: NOW });
  assert.equal(candidates.length, 0);
  assert.equal(dropped[0].action, "unmatched");
  assert.equal(dropped[0].failedGate, "unactionable");
});

// --- self-pruning: findStaleRules ----------------------------------------------------

test("findStaleRules flags an active rule unused beyond the horizon", () => {
  const log = records({
    action: "git_push",
    preceding: "test_run",
    sessions: ["a"],
    timestamp: "2026-05-19T12:00:00Z", // 20 days before NOW
  });
  const stale = findStaleRules(log, [{ action: "git_push", preceding_event: "test_run" }], {
    now: NOW,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].lastSeen, "2026-05-19T12:00:00Z");
  assert.equal(stale[0].daysSinceLastSeen, 20);
  assert.equal(stale[0].tier, "consequential"); // classified when absent on the rule
});

test("findStaleRules keeps a rule still used within the horizon", () => {
  const log = records({
    action: "git_push",
    preceding: "test_run",
    sessions: ["a"],
    timestamp: "2026-06-05T12:00:00Z", // 3 days before NOW
  });
  const stale = findStaleRules(log, [{ action: "git_push", preceding_event: "test_run" }], {
    now: NOW,
  });
  assert.deepEqual(stale, []);
});

test("findStaleRules flags a rule whose behavior never appears in the log", () => {
  const stale = findStaleRules([], [{ action: "git_push", preceding_event: "test_run" }], {
    now: NOW,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].lastSeen, null);
  assert.equal(stale[0].daysSinceLastSeen, null);
});

test("findStaleRules honors a custom staleDays horizon", () => {
  const log = records({
    action: "test_run",
    preceding: "file_edit",
    sessions: ["a"],
    timestamp: "2026-06-05T12:00:00Z", // 3 days before NOW
  });
  const rule = [{ action: "test_run", preceding_event: "file_edit" }];
  assert.deepEqual(findStaleRules(log, rule, { now: NOW, staleDays: 14 }), []); // fresh at 14
  assert.equal(findStaleRules(log, rule, { now: NOW, staleDays: 2 }).length, 1); // stale at 2
});
