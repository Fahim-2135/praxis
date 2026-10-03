import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, appendLive, encodeHistory, decodeHistory } from "../src/history/history.mjs";

const tool = (sessionId, timestamp, action, extra = {}) => ({
  kind: "tool",
  sessionId,
  timestamp,
  project: "demo",
  action,
  ...extra,
});

test("orders each session by time and chains preceding_event within it", () => {
  const { records } = buildHistory([
    tool("b", "2026-09-02T10:00:01.000Z", "git_push"),
    tool("a", "2026-09-01T10:00:02.000Z", "test_run"),
    tool("a", "2026-09-01T10:00:01.000Z", "file_edit"),
    tool("b", "2026-09-02T10:00:00.000Z", "test_run"),
  ]);
  assert.deepEqual(
    records.map((r) => [r.session_id, r.action, r.preceding_event]),
    [
      ["a", "file_edit", "session_start"],
      ["a", "test_run", "file_edit"],
      ["b", "test_run", "session_start"],
      ["b", "git_push", "test_run"],
    ],
  );
});

test("keeps calls from one message in their original order", () => {
  const at = "2026-09-01T10:00:00.000Z";
  const { records } = buildHistory([tool("a", at, "file_read"), tool("a", at, "file_edit")]);
  assert.deepEqual(
    records.map((r) => r.action),
    ["file_read", "file_edit"],
  );
});

test("separates prompts from tool calls", () => {
  const { prompts, records } = buildHistory([
    { kind: "prompt", sessionId: "a", timestamp: "2026-09-01T09:00:00.000Z", interrupted: true },
    tool("a", "2026-09-01T10:00:00.000Z", "file_read"),
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(prompts, [
    { session_id: "a", timestamp: "2026-09-01T09:00:00.000Z", interrupted: true },
  ]);
});

test("appendLive continues each session's chain", () => {
  const { records } = buildHistory([tool("a", "2026-09-01T10:00:00.000Z", "test_run")]);
  const out = appendLive(records, [
    { action: "git_push", session_id: "a", timestamp: "2026-09-01T10:01:00.000Z", project: "demo" },
    {
      action: "file_read",
      session_id: "new",
      timestamp: "2026-09-01T10:02:00.000Z",
      project: "demo",
    },
  ]);
  assert.equal(out[1].preceding_event, "test_run");
  assert.equal(out[2].preceding_event, "session_start");
  assert.equal(records.length, 1, "input is not mutated");
});

test("encode and decode round-trip at one-second precision", () => {
  const history = buildHistory([
    tool("a", "2026-09-01T10:00:00.000Z", "file_read", {
      file: "app.json",
      model: "claude-opus-5",
    }),
    tool("a", "2026-09-01T10:00:05.000Z", "unmatched", { raw: "docker" }),
    tool("b", "2026-09-02T11:00:00.000Z", "git_push"),
    { kind: "prompt", sessionId: "b", timestamp: "2026-09-02T10:59:00.000Z", interrupted: false },
  ]);
  const decoded = decodeHistory(JSON.parse(JSON.stringify(encodeHistory(history))));
  assert.deepEqual(decoded, history);
});

test("the encoding stays compact: one short array per call", () => {
  const events = [];
  for (let i = 0; i < 1000; i++) {
    events.push(
      tool(`s${i % 10}`, new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(), "file_read"),
    );
  }
  const bytes = JSON.stringify(encodeHistory(buildHistory(events))).length;
  assert.ok(bytes / 1000 < 30, `${bytes / 1000} bytes per call`);
});

test("decode rejects an unknown format version", () => {
  assert.throws(() => decodeHistory({ v: 99 }), /unsupported history format/);
});
