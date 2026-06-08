import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderActiveRules,
  parseActiveRules,
  applyDecision,
  retireRule,
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
    assert.deepEqual(summary, {
      approved: 1,
      rejected: 1,
      skipped: 1,
      retired: 0,
      kept: 0,
      remaining: 1,
    });

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

test("a skip-only session writes no files (no empty active-rules.md or rejected.json)", async () => {
  const { root, p } = seedProject([candidate(), candidate({ action: "git_commit" })]);
  try {
    const summary = await runReview(root, {
      decide: scripted(["skip", "skip"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.skipped, 2);
    assert.ok(!existsSync(p.activeRules)); // nothing approved -> no rules file
    assert.ok(!existsSync(p.rejected)); // nothing rejected -> no rejection file
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an approve-only session does not create an empty rejected.json", async () => {
  const { root, p } = seedProject([candidate()]);
  try {
    await runReview(root, { decide: scripted(["approve"]), out: () => {}, now: NOW });
    assert.ok(existsSync(p.activeRules)); // the approval
    assert.ok(!existsSync(p.rejected)); // but no rejection happened
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
    assert.deepEqual(summary, {
      approved: 0,
      rejected: 0,
      skipped: 0,
      retired: 0,
      kept: 0,
      remaining: 0,
    });
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

// --- self-pruning: retireRule (pure) -------------------------------------------------

test("retireRule removes a rule by pattern id and leaves others", () => {
  const active = [
    { action: "git_push", preceding_event: "test_run", tier: "consequential" },
    { action: "test_run", preceding_event: "file_edit", tier: "safe" },
  ];
  const next = retireRule(active, { action: "git_push", preceding_event: "test_run" });
  assert.deepEqual(
    next.map((r) => r.action),
    ["test_run"],
  );
  assert.equal(active.length, 2); // original not mutated
});

test("retireRule is a no-op for a rule that is not active", () => {
  const active = [{ action: "git_push", preceding_event: "test_run", tier: "consequential" }];
  const next = retireRule(active, { action: "nope", preceding_event: "nope" });
  assert.deepEqual(next, active);
});

// --- self-pruning: the retirement phase of runReview ---------------------------------

function activeRule(over = {}) {
  return {
    action: "git_pull",
    preceding_event: "session_start",
    tier: "consequential",
    approvedAt: NOW,
    evidence: {},
    ...over,
  };
}

function staleFlag(over = {}) {
  return {
    action: "git_pull",
    preceding_event: "session_start",
    tier: "consequential",
    lastSeen: null,
    daysSinceLastSeen: null,
    ...over,
  };
}

/** A project seeded with active rules, a candidates.json (candidates + retirements). */
function seedRetirement({ active = [], retirements = [], candidates = [] }) {
  const root = mkdtempSync(join(tmpdir(), "praxis-retire-"));
  const p = paths(root);
  mkdirSync(p.base, { recursive: true });
  writeFileSync(
    p.candidates,
    JSON.stringify({ generatedAt: NOW, candidates, retirements }, null, 2),
  );
  if (active.length) writeFileSync(p.activeRules, renderActiveRules(active));
  return { root, p };
}

test("retire removes the stale rule from active-rules.md", async () => {
  const { root, p } = seedRetirement({ active: [activeRule()], retirements: [staleFlag()] });
  try {
    const summary = await runReview(root, {
      decide: scripted([]),
      decideRetirement: scripted(["retire"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.retired, 1);
    assert.deepEqual(parseActiveRules(readFileSync(p.activeRules, "utf8")), []);
    const file = JSON.parse(readFileSync(p.candidates, "utf8"));
    assert.deepEqual(file.retirements, []); // left the pending list
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keep is a non-decision (like skip): rule stays active and nothing is written", async () => {
  const { root, p } = seedRetirement({ active: [activeRule()], retirements: [staleFlag()] });
  try {
    const candidatesBefore = readFileSync(p.candidates, "utf8");
    const activeBefore = readFileSync(p.activeRules, "utf8");
    const summary = await runReview(root, {
      decide: scripted([]),
      decideRetirement: scripted(["keep"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.kept, 1);
    assert.equal(summary.retired, 0);
    // The rule is untouched and still flagged — keep writes no files, mirroring skip.
    assert.equal(readFileSync(p.activeRules, "utf8"), activeBefore);
    assert.equal(readFileSync(p.candidates, "utf8"), candidatesBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one session reviews candidates then stale rules", async () => {
  const { root, p } = seedRetirement({
    active: [activeRule()],
    retirements: [staleFlag()],
    candidates: [candidate({ action: "git_push", preceding_event: "test_run" })],
  });
  try {
    const summary = await runReview(root, {
      decide: scripted(["approve"]),
      decideRetirement: scripted(["retire"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.approved, 1);
    assert.equal(summary.retired, 1);
    // git_pull retired, git_push approved -> active-rules.md holds only git_push.
    const active = parseActiveRules(readFileSync(p.activeRules, "utf8"));
    assert.deepEqual(
      active.map((r) => r.action),
      ["git_push"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quitting during candidates skips the retirement phase", async () => {
  const { root, p } = seedRetirement({
    active: [activeRule()],
    retirements: [staleFlag()],
    candidates: [candidate()],
  });
  try {
    const summary = await runReview(root, {
      decide: scripted(["quit"]),
      decideRetirement: scripted(["retire"]),
      out: () => {},
      now: NOW,
    });
    assert.equal(summary.retired, 0); // phase never reached
    const active = parseActiveRules(readFileSync(p.activeRules, "utf8"));
    assert.deepEqual(
      active.map((r) => r.action),
      ["git_pull"],
    ); // untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retirement-only session (no candidates) still prunes", async () => {
  const { root, p } = seedRetirement({ active: [activeRule()], retirements: [staleFlag()] });
  try {
    const summary = await runReview(root, {
      decide: scripted([]),
      decideRetirement: scripted(["retire"]),
      out: () => {},
      now: NOW,
    });
    assert.deepEqual(summary, {
      approved: 0,
      rejected: 0,
      skipped: 0,
      retired: 1,
      kept: 0,
      remaining: 0,
    });
    assert.deepEqual(parseActiveRules(readFileSync(p.activeRules, "utf8")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
