import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderActiveRules,
  parseActiveRules,
  applyDecision,
  decidedIds,
} from "../src/review/store.mjs";
import { runReview, loadState } from "../src/review/run.mjs";
import { paths } from "../src/state/paths.mjs";

const NOW = "2026-06-08T12:00:00Z";

function candidate(over = {}) {
  return {
    action: "git_push",
    preceding_event: "test_run",
    tier: "consequential",
    status: "candidate",
    evidence: { count: 6, sessions: 3, consistency: 0.86, lastSeen: NOW },
    ...over,
  };
}

// --- pure core: render / parse round-trip --------------------------------------------

test("renderActiveRules / parseActiveRules round-trips a rule losslessly", () => {
  const rule = {
    action: "git_push",
    preceding_event: "test_run",
    tier: "consequential",
    approvedAt: NOW,
    evidence: { count: 6, sessions: 3, consistency: 0.86, lastSeen: NOW },
  };
  const parsed = parseActiveRules(renderActiveRules([rule]));
  assert.deepEqual(parsed, [rule]);
});

test("renderActiveRules is human-readable: tier and an instruction appear in prose", () => {
  const md = renderActiveRules([
    {
      action: "test_run",
      preceding_event: "file_edit",
      tier: "safe",
      approvedAt: NOW,
      evidence: {},
    },
  ]);
  assert.match(md, /## `test_run` after `file_edit`/);
  assert.match(md, /soft confirmation/); // the safe-tier guidance sentence
  assert.match(md, /1 active rule\./);
});

test("empty active rules render a clear placeholder and parse to nothing", () => {
  const md = renderActiveRules([]);
  assert.match(md, /No active rules yet/);
  assert.deepEqual(parseActiveRules(md), []);
});

test("parseActiveRules ignores prose and survives a corrupt marker", () => {
  const md = [
    "# hand-edited",
    "some prose a human wrote",
    "<!-- praxis:rule {not valid json} -->",
    '<!-- praxis:rule {"action":"a","preceding_event":"b","tier":"safe"} -->',
  ].join("\n");
  const parsed = parseActiveRules(md);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].action, "a");
});

test("parseActiveRules tolerates empty / nullish input", () => {
  assert.deepEqual(parseActiveRules(""), []);
  assert.deepEqual(parseActiveRules(undefined), []);
});

// --- pure core: applyDecision --------------------------------------------------------

test("approve moves a candidate into active rules and out of the pending pool", () => {
  const state = { candidates: [candidate()], active: [], rejected: [] };
  const next = applyDecision(state, candidate(), "approve", NOW);
  assert.equal(next.candidates.length, 0);
  assert.equal(next.active.length, 1);
  assert.equal(next.active[0].approvedAt, NOW);
  assert.equal(state.candidates.length, 1); // original not mutated
});

test("reject records the pattern in rejection memory with a timestamp", () => {
  const state = { candidates: [candidate()], active: [], rejected: [] };
  const next = applyDecision(state, candidate(), "reject", NOW);
  assert.equal(next.candidates.length, 0);
  assert.deepEqual(next.rejected, [
    { action: "git_push", preceding_event: "test_run", rejectedAt: NOW },
  ]);
});

test("skip leaves the state untouched", () => {
  const state = { candidates: [candidate()], active: [], rejected: [] };
  const next = applyDecision(state, candidate(), "skip", NOW);
  assert.equal(next, state);
});

test("approve does not duplicate a pattern already active", () => {
  const rule = {
    action: "git_push",
    preceding_event: "test_run",
    tier: "consequential",
    approvedAt: "x",
    evidence: {},
  };
  const state = { candidates: [candidate()], active: [rule], rejected: [] };
  const next = applyDecision(state, candidate(), "approve", NOW);
  assert.equal(next.active.length, 1); // not duplicated
  assert.equal(next.candidates.length, 0); // still leaves the pool
});

test("decidedIds unions active and rejected pattern ids", () => {
  const ids = decidedIds({
    active: [{ action: "a", preceding_event: "b" }],
    rejected: [{ action: "c", preceding_event: "d" }],
  });
  assert.ok(ids.has("a|b"));
  assert.ok(ids.has("c|d"));
});

// --- the full loop over a temp project ----------------------------------------------

/** A project root seeded with a candidates.json holding the given candidate array. */
function seedProject(candidates) {
  const root = mkdtempSync(join(tmpdir(), "praxis-review-"));
  const p = paths(root);
  mkdirSync(p.base, { recursive: true });
  writeFileSync(
    p.candidates,
    JSON.stringify({ generatedAt: NOW, thresholds: {}, analyzed: {}, candidates }, null, 2),
  );
  return { root, p };
}

/** A decision function that replays a fixed list of answers in order. */
function scripted(answers) {
  let i = 0;
  return () => answers[i++];
}

test("runReview persists approvals, rejections, and rewrites the pending pool", async () => {
  const cands = [
    candidate({ action: "git_push", preceding_event: "test_run" }),
    candidate({ action: "test_run", preceding_event: "file_edit", tier: "safe" }),
    candidate({ action: "git_commit", preceding_event: "file_edit" }),
  ];
  const { root, p } = seedProject(cands);
  try {
    const summary = await runReview(root, {
      decide: scripted(["approve", "reject", "skip"]),
      out: () => {},
      now: NOW,
    });
    assert.deepEqual(summary, { approved: 1, rejected: 1, skipped: 1, remaining: 1 });

    // active-rules.md holds exactly the approved pattern.
    const active = parseActiveRules(readFileSync(p.activeRules, "utf8"));
    assert.deepEqual(
      active.map((r) => [r.action, r.preceding_event]),
      [["git_push", "test_run"]],
    );

    // rejected.json holds exactly the rejected pattern.
    const rejected = JSON.parse(readFileSync(p.rejected, "utf8"));
    assert.deepEqual(
      rejected.map((r) => [r.action, r.preceding_event]),
      [["test_run", "file_edit"]],
    );

    // candidates.json keeps only the skipped one, provenance preserved.
    const remaining = JSON.parse(readFileSync(p.candidates, "utf8"));
    assert.equal(remaining.generatedAt, NOW);
    assert.deepEqual(
      remaining.candidates.map((c) => c.action),
      ["git_commit"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReview stops at quit and persists only decisions made before it", async () => {
  const cands = [
    candidate({ action: "git_push", preceding_event: "test_run" }),
    candidate({ action: "git_commit", preceding_event: "file_edit" }),
  ];
  const { root, p } = seedProject(cands);
  try {
    const summary = await runReview(root, {
      decide: scripted(["approve", "quit"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.approved, 1);
    assert.equal(summary.remaining, 1); // the second candidate never decided
    const remaining = JSON.parse(readFileSync(p.candidates, "utf8"));
    assert.deepEqual(
      remaining.candidates.map((c) => c.action),
      ["git_commit"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReview no-ops cleanly when there are no candidates", async () => {
  const { root, p } = seedProject([]);
  try {
    const lines = [];
    const summary = await runReview(root, {
      decide: scripted([]),
      out: (l) => lines.push(l),
      now: NOW,
    });
    assert.deepEqual(summary, { approved: 0, rejected: 0, skipped: 0, remaining: 0 });
    assert.match(lines.join("\n"), /Nothing to review/);
    assert.ok(!existsSync(p.activeRules)); // nothing written when nothing decided
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected pattern is reloaded as rejection memory on the next session", async () => {
  const { root } = seedProject([candidate()]);
  try {
    await runReview(root, { decide: scripted(["reject"]), out: () => {}, now: NOW });
    const reloaded = loadState(root);
    assert.equal(reloaded.rejected.length, 1);
    assert.ok(decidedIds(reloaded).has("git_push|test_run"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
