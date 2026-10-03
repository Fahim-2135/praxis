import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProfile,
  signatureMoves,
  describeAction,
  prettyModel,
  prettyConnector,
} from "../src/profile/profile.mjs";
import { buildHistory } from "../src/history/history.mjs";

/** Build a history from per-session action lists, one call a minute starting at `hourUtc`. */
function history(sessions, { hourUtc = 12, day = 1, extra = {} } = {}) {
  const events = [];
  sessions.forEach((actions, s) => {
    actions.forEach((action, i) => {
      const t = new Date(Date.UTC(2026, 8, day + s, hourUtc, i));
      events.push({
        kind: "tool",
        sessionId: `s${s}`,
        timestamp: t.toISOString(),
        project: s % 2 ? "api" : "web",
        action,
        ...extra,
      });
    });
  });
  return buildHistory(events);
}

const NOW = "2026-09-10T00:00:00Z";

test("totals, active days, streak and rhythm", () => {
  const p = buildProfile(
    history([["file_read", "file_read"], ["file_edit"], ["git_push"]], { day: 5 }),
    { now: NOW },
  );
  assert.equal(p.totals.sessions, 3);
  assert.equal(p.totals.toolCalls, 4);
  assert.equal(p.totals.activeDays, 3);
  assert.equal(p.totals.longestStreak, 3);
  assert.equal(p.rhythm.busiestHour, "12 PM");
  assert.equal(p.rhythm.busiestWeekday, "Saturdays"); // 2026-09-05
});

test("the UTC offset moves hours and days into local time", () => {
  const p = buildProfile(history([["file_read"]], { hourUtc: 20 }), {
    now: NOW,
    utcOffsetMinutes: 360,
  });
  assert.equal(p.rhythm.busiestHour, "2 AM");
  assert.equal(p.archetype.name, "The Night Owl");
  assert.match(p.archetype.tagline, /^100% of your work/);
});

test("archetype goes to the signal furthest past its bar, quoting the person's own number", () => {
  const delegator = buildProfile(
    history([
      ["subagent_run", "file_read", "subagent_run", "file_edit"],
      ["file_read", "subagent_run"],
    ]),
    { now: NOW },
  );
  assert.equal(delegator.archetype.name, "The Delegator");
  assert.match(delegator.archetype.tagline, /3 subagents/);

  const reader = buildProfile(
    history([
      ["file_read", "file_search", "list_dir", "file_read", "file_read", "file_read", "file_edit"],
    ]),
    { now: NOW },
  );
  assert.equal(reader.archetype.name, "The Careful Reader");
});

test("an empty history gets a newcomer profile instead of failing", () => {
  const p = buildProfile({ records: [], prompts: [] }, { now: NOW });
  assert.equal(p.archetype.name, "The Newcomer");
  assert.equal(p.totals.toolCalls, 0);
  assert.equal(p.rhythm.busiestHour, null);
  assert.deepEqual(p.moves, []);
});

test("interruptions are counted against typed prompts", () => {
  const h = history([["file_read"]]);
  h.prompts = [
    { session_id: "s0", timestamp: "2026-09-01T11:00:00Z", interrupted: false },
    { session_id: "s0", timestamp: "2026-09-01T11:01:00Z", interrupted: false },
    { session_id: "s0", timestamp: "2026-09-01T11:02:00Z", interrupted: true },
  ];
  const p = buildProfile(h, { now: NOW });
  assert.equal(p.totals.prompts, 2);
  assert.equal(p.totals.interrupts, 1);
  assert.ok(p.facts.includes("You stopped Claude mid-answer 1 times."));
});

test("signature moves need support, spread and lift, and skip self-repeats", () => {
  const sessions = [];
  for (let s = 0; s < 4; s++) {
    sessions.push(["file_read", "file_read", "git_status", "git_log", "file_edit", "file_edit"]);
  }
  const { records } = history(sessions);
  const moves = signatureMoves(records, { minCount: 4, minSessions: 3, minLift: 2 });
  const pairs = moves.map((m) => `${m.after}>${m.action}`);
  assert.ok(pairs.includes("git_status>git_log"));
  assert.ok(!pairs.includes("file_read>file_read"));
  assert.equal(moves[0].sentence.includes("→"), true);

  assert.deepEqual(signatureMoves(records, { minCount: 5 }), [], "below the support bar");
  assert.deepEqual(signatureMoves([]), []);
});

test("rule-ready excludes self-repeats; almost excludes far-off consistency misses", () => {
  const sessions = [];
  for (let s = 0; s < 4; s++) sessions.push(["mcp_call", "mcp_call", "mcp_call", "mcp_call"]);
  const p = buildProfile(history(sessions, { day: 6 }), { now: NOW });
  assert.deepEqual(p.ruleReady, [], "mcp_call after mcp_call is not a useful rule");
  for (const a of p.almost) {
    assert.ok(a.failedGate !== "consistency" || a.evidence.consistency >= 0.5);
  }
});

test("top projects and top actions are ranked shares", () => {
  const p = buildProfile(history([["file_read", "file_read"], ["file_edit"]]), { now: NOW });
  assert.deepEqual(
    p.projects.map((x) => x.name),
    ["web", "api"],
  );
  assert.equal(p.topActions[0].phrase, "reading files");
  assert.equal(Math.round(p.topActions[0].share * 3), 2);
});

test("facts use base names and pretty names only", () => {
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      kind: "tool",
      sessionId: "s",
      timestamp: `2026-09-01T10:0${i}:00.000Z`,
      project: "p",
      action: i < 3 ? "mcp_call" : "file_read",
      raw: i < 3 ? "claude_ai_Gmail" : undefined,
      file: i < 3 ? undefined : "main.js",
      model: "claude-opus-5-5",
    });
  }
  const p = buildProfile(buildHistory(events), { now: NOW });
  assert.ok(p.facts.includes("Favourite connected app: Gmail (3 calls)."));
  assert.ok(p.facts.includes("Opus 5.5 did 100% of the work."));
});

test("name helpers", () => {
  assert.equal(describeAction("git_push"), "pushing");
  assert.equal(describeAction("some_new_action"), "some new action");
  assert.equal(prettyModel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(prettyModel("claude-sonnet-4-20250514"), "Sonnet 4");
  assert.equal(prettyModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(prettyModel("gpt-x"), "gpt-x");
  assert.equal(prettyConnector("claude-in-chrome"), "chrome");
  assert.equal(prettyConnector("plugin_figma"), "plugin figma");
});

test("almost habits never name the session start as a trigger", () => {
  const p = buildProfile(history([["file_read"], ["file_read"], ["file_read"]]), { now: NOW });
  assert.ok(p.almost.every((a) => a.preceding_event !== "session_start"));
});
