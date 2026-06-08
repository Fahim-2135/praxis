import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderInjection } from "../src/feedback/context.mjs";
import { renderActiveRules } from "../src/review/store.mjs";

const NOW = "2026-06-08T12:00:00Z";
const HOOK = fileURLToPath(new URL("../src/hooks/session-feedback.mjs", import.meta.url));

function rule(over = {}) {
  return {
    action: "git_push",
    preceding_event: "test_run",
    tier: "consequential",
    approvedAt: NOW,
    evidence: { count: 6, sessions: 3, consistency: 0.86, lastSeen: NOW },
    ...over,
  };
}

// --- pure renderer -------------------------------------------------------------------

test("renderInjection returns empty string for no rules (hook injects nothing)", () => {
  assert.equal(renderInjection([]), "");
  assert.equal(renderInjection(undefined), "");
});

test("renderInjection states the trigger, the action, and a managing pointer", () => {
  const text = renderInjection([rule()]);
  assert.match(text, /# Praxis — your approved workflow rules/);
  assert.match(text, /When `test_run` just happened/);
  assert.match(text, /`git_push`/);
  assert.match(text, /praxis review/);
});

test("renderInjection phrases autonomy per tier", () => {
  assert.match(renderInjection([rule({ tier: "safe" })]), /soft confirmation/);
  assert.match(renderInjection([rule({ tier: "consequential" })]), /explicit confirmation/);
  assert.match(
    renderInjection([rule({ tier: "destructive" })]),
    /never run it automatically — it is irreversible/,
  );
});

test("renderInjection numbers multiple rules", () => {
  const text = renderInjection([
    rule(),
    rule({ action: "test_run", preceding_event: "file_edit" }),
  ]);
  assert.match(text, /1\. /);
  assert.match(text, /2\. /);
});

test("renderInjection phrases each rule by its own tier when tiers are mixed", () => {
  const text = renderInjection([
    rule({ tier: "safe", action: "test_run", preceding_event: "file_edit" }),
    rule({ tier: "destructive", action: "git_force_push", preceding_event: "test_run" }),
  ]);
  // Each rule keeps its own autonomy phrasing in one block.
  assert.match(text, /`test_run` next — it is reversible/);
  assert.match(text, /suggest `git_force_push` but must never run it automatically/);
});

// --- spawned hook (as Claude Code runs it) -------------------------------------------

function runHook(payload, { root } = {}) {
  const projectDir = root ?? mkdtempSync(join(tmpdir(), "praxis-"));
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  return { projectDir, status: result.status, stdout: result.stdout ?? "" };
}

/** Seed `.praxis/active-rules.md` with the given rules. */
function seedRules(root, rules) {
  mkdirSync(join(root, ".praxis"), { recursive: true });
  writeFileSync(join(root, ".praxis", "active-rules.md"), renderActiveRules(rules));
}

test("hook injects the active rules to stdout and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    seedRules(root, [rule()]);
    const r = runHook(JSON.stringify({ source: "startup", cwd: root }), { root });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /your approved workflow rules/);
    assert.match(r.stdout, /`git_push`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook injects on compact too (rules survive context compaction)", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    seedRules(root, [rule()]);
    const r = runHook(JSON.stringify({ source: "compact", cwd: root }), { root });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /your approved workflow rules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook with no active-rules.md injects nothing and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    const r = runHook(JSON.stringify({ source: "startup", cwd: root }), { root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook on empty stdin is a silent no-op (exit 0, no output)", () => {
  const r = runHook("");
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(r.projectDir, { recursive: true, force: true });
  }
});

test("hook tolerates a leading UTF-8 BOM on the payload (as PowerShell prepends)", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    seedRules(root, [rule()]);
    const bom = String.fromCharCode(0xfeff);
    const r = runHook(bom + JSON.stringify({ source: "startup", cwd: root }), { root });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /your approved workflow rules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook swallows a malformed payload: no output, error noted, still exit 0", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    seedRules(root, [rule()]);
    const r = runHook("not json at all", { root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, ""); // never injects on a parse failure
    assert.ok(existsSync(join(root, ".praxis", "errors.log"))); // noted, not surfaced
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
