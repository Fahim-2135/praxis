import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/report.mjs";

test("aggregates counts by action and session, most frequent first", () => {
  const records = [
    { action: "git_push", session_id: "a" },
    { action: "git_push", session_id: "b" },
    { action: "test_run", session_id: "a" },
    { action: "unmatched", session_id: "a", raw: "docker compose up" },
    { action: "unmatched", session_id: "b", raw: "docker compose up" },
  ];
  const summary = summarize(records);

  assert.equal(summary.total, 5);
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.byAction[0], ["git_push", 2]);
  assert.deepEqual(summary.unmatched[0], ["docker compose up", 2]);
});

test("ties break alphabetically by key for stable output", () => {
  const summary = summarize([
    { action: "git_status", session_id: "a" },
    { action: "git_commit", session_id: "a" },
  ]);
  assert.deepEqual(summary.byAction, [
    ["git_commit", 1],
    ["git_status", 1],
  ]);
});

test("handles empty input without throwing", () => {
  const summary = summarize([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.sessions, 0);
  assert.deepEqual(summary.byAction, []);
  assert.deepEqual(summary.unmatched, []);
});

test("counts missing session_id as 'unknown' and ignores unmatched without raw", () => {
  const summary = summarize([
    { action: "file_read" },
    { action: "unmatched" }, // no raw -> not counted in unmatched
  ]);
  assert.equal(summary.sessions, 1);
  assert.deepEqual(summary.bySession[0], ["unknown", 2]);
  assert.deepEqual(summary.unmatched, []);
});
